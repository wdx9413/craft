import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exchange } from "../adapters/deepseek-harness/mcp-client.ts";
import { adapterTools } from "../adapters/deepseek-harness/adapter-tools.ts";

function fixtureServer(scenario: string) {
  const root = mkdtempSync(join(tmpdir(), "craft-dsh-wire-")); const file = join(root, "server.cjs");
  writeFileSync(file, `const scenario=${JSON.stringify(scenario)};const rl=require('node:readline').createInterface({input:process.stdin}); let initialized=false;
if(scenario==='exit')process.exit(1);
rl.on('line', line=>{const m=JSON.parse(line);if(m.method==='notifications/initialized'){initialized=true;return;}if(!m.id)return;
if(scenario==='timeout'||scenario==='tool-timeout'&&m.id===2)return;if(scenario==='invalid'){console.log('invalid');return;}if(scenario==='large'){console.log('x'.repeat(2000));return;}
if(scenario==='reject'){console.log(JSON.stringify({id:m.id,error:{message:'rejected'}}));return;}
const result=m.id===1?{protocolVersion:scenario==='protocol'?'unknown':'2025-11-25'}:scenario==='toolerror'?{isError:true}:m.method==='tools/list'?{tools:[{name:'craft_info',inputSchema:{type:'object'}}],initialized}:{content:[],structuredContent:{ok:true}};
if(scenario==='noresult'){console.log(JSON.stringify({id:m.id}));return;}
const out=JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n';process.stdout.write('\\n'+JSON.stringify({method:'notifications/log'})+'\\n'+out.slice(0,8));setTimeout(()=>process.stdout.write(out.slice(8)),2);});`);
  return { root, file, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("DSH negotiates before discovery/call and handles protocol, timeout, output and process failures", async () => {
  for (const scenario of ["ready", "exit", "timeout", "tool-timeout", "invalid", "large", "reject", "protocol", "toolerror", "noresult"]) {
    const f = fixtureServer(scenario);
    try {
      const launch = { command: process.execPath, args: [f.file], timeoutMs: 1500, maxBytes: 1000 };
      if (scenario === "ready") {
        const listed = await exchange(launch, "tools/list"); assert.equal(listed.initialized, true); assert.equal(listed.tools[0].name, "craft_info");
        assert.equal((await exchange(launch, "tools/call", { name: "craft_info", arguments: {} })).structuredContent.ok, true);
      } else await assert.rejects(exchange(launch, "tools/list"));
    } finally { f.cleanup(); }
  }
  await assert.rejects(exchange({ command: "/missing-craft-command", args: [] }, "tools/list"), /launch failed/);
});

test("each DSH product has separate discovery and strict JSON call arguments", async () => {
  assert.throws(() => adapterTools({ product: "unknown" }), /Unknown Craft product/);
  for (const product of ["context", "knowledge", "memory", "experience", "codebase", "full"]) {
    const f = fixtureServer("ready");
    try {
      const tools = adapterTools({ product, bundlePath: f.file, dataDir: f.root });
      assert.equal(tools[0]!.name, `craft_${product}_tools`); assert.equal(tools[1]!.name, `craft_${product}_call`);
      assert.equal((await tools[0]!.execute({ tool: "" })).tools[0].name, "craft_info");
      assert.equal((await tools[1]!.execute({ tool: "craft_info" })).structuredContent.ok, true);
      assert.equal((await tools[1]!.execute({ tool: "craft_info", arguments_json: '{}' })).structuredContent.ok, true);
      for (const value of ["null", "[]", '"text"', "invalid"]) assert.throws(() => tools[1]!.execute({ tool: "craft_info", arguments_json: value }));
      assert.throws(() => tools[1]!.execute({ tool: "" }), /empty/);
      assert.equal(tools[0]!.output.render({}, { ok: true })[0]!.type, "text");
    } finally { f.cleanup(); }
  }
  assert.equal(adapterTools()[0]!.name, "craft_context_tools");
  adapterTools({ npxCommand: "custom-npx", packageSpec: "craft-agent-harness@fixture" });
});


test("DSH local bundles discover their Skill without network or an npm package version", async () => {
  const f = fixtureServer("ready"); const before = process.env.npm_package_version;
  try {
    mkdirSync(join(f.root, "runtime")); mkdirSync(join(f.root, "skills/craft-context"), { recursive: true });
    const { copyFileSync } = await import("node:fs"); copyFileSync(f.file, join(f.root, "runtime/craft-mcp.cjs"));
    writeFileSync(join(f.root, "skills/craft-context/SKILL.md"), "Use repository context");
    const local = adapterTools({}, pathToFileURL(join(f.root, "dist/adapter-tools.js")).href);
    assert.equal((await local[0]!.execute({ tool: "" })).skill, "Use repository context");
    process.env.npm_package_version = "0.12.38"; adapterTools();
    delete process.env.npm_package_version; adapterTools();
  } finally { if (before === undefined) delete process.env.npm_package_version; else process.env.npm_package_version = before; f.cleanup(); }
});

test("Cordis entry registers the default aggregate and an independently selected component", async () => {
  const { registerHooks } = await import("node:module");
  const hook = registerHooks({ resolve(specifier, context, next) { return specifier === "@deepseek-ai/dsh-tools" ? { url: "data:text/javascript,export const defineTool = value => value", shortCircuit: true } : next(specifier, context); } });
  try {
    const { apply, name, inject } = await import("../adapters/deepseek-harness/index.ts");
    const names: string[] = []; const ctx = { tools: { register: (tool: any) => names.push(tool.name) } };
    apply(ctx); apply(ctx, { product: "memory" }); assert.equal(name, "craft-adapter"); assert.deepEqual(inject, ["tools"]);
    assert.deepEqual(names, ["craft_context_tools", "craft_context_call", "craft_memory_tools", "craft_memory_call"]);
  } finally { hook.deregister(); }
});
