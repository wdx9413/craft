import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, mkdirSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { externalMarketplaceProducts } from "../core/release-catalog.ts";
import { exchange } from "../adapters/deepseek-harness/mcp-client.ts";
const root = resolve(import.meta.dirname, "..");
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));

test("all five products negotiate and call through Codex, Claude and portable manifests with a shared data space", async () => {
  const data = mkdtempSync(join(tmpdir(), "craft-products-wire-"));
  try {
    for (const product of externalMarketplaceProducts()) {
      const directory = join(root, "plugins", product.name); const selected = product.name.slice(6);
      const native = json(join(directory, ".mcp.json")).mcpServers[product.name];
      const claude = json(join(directory, ".claude-plugin/plugin.json")).mcpServers[product.name];
      const portable = json(join(directory, "mcp.json")).mcpServers[product.name];
      for (const [host, config] of [["codex", native], ["claude", claude], ["portable", portable]] as const) {
        const args = config.args.map((arg: string, i: number) => i ? arg : arg.replace('${PLUGIN_ROOT}', directory).replace('${CLAUDE_PLUGIN_ROOT}', directory));
        if (host === "codex") args[0] = join(directory, args[0]);
        const launch = { command: config.command, args, env: { ...process.env, CRAFT_DATA_DIR: data } };
        const list = await exchange(launch, "tools/list");
        assert.equal(new Set(list.tools.map((t: { name: string }) => t.name)).size, list.tools.length);
        const info = ["context", "codebase"].includes(selected);
        const name = info ? "craft_info" : "craft_component_readiness_get";
        assert(list.tools.some((tool: { name: string }) => tool.name === name));
        assert.equal((await exchange(launch, "tools/call", { name, arguments: info ? {} : { component: selected } })).isError, false);
        if (selected === "context") {
          assert(list.tools.some((tool: { name: string }) => tool.name === "craft_context_open"));
          for (const member of ["knowledge", "memory", "experience", "codebase"]) assert(readFileSync(join(directory, "skills/craft-context/references", `craft-${member}`, "SKILL.md"), "utf8").length);
        }
      }
    }
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test("five packaged DSH plugins register separate tools and execute their bundled runtime offline", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "craft-dsh-package-"));
  const repository = join(temporary, "repo"); mkdirSync(repository); execFileSync("git", ["-C", repository, "init", "-q"]); writeFileSync(join(repository, "a.ts"), "export function alpha() {}\n");
  try {
    for (const product of externalMarketplaceProducts()) {
      const directory = join(temporary, product.name); cpSync(join(root, "plugins", product.name, "dsh"), directory, { recursive: true });
      const manifest = json(join(directory, "package.json")); assert.equal(manifest.name, `dsh-${product.name}`); assert(manifest.dsh.bundle.patch);
      const stub = join(directory, "node_modules/@deepseek-ai/dsh-tools"); mkdirSync(stub, { recursive: true });
      writeFileSync(join(stub, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-tools", type: "module", exports: "./index.js" }));
      writeFileSync(join(stub, "index.js"), "export const defineTool = value => value;\n");
      const adapter = await import(pathToFileURL(join(directory, manifest.main)).href);
      const registered: any[] = []; const selected = product.name.slice(6);
      adapter.apply({ tools: { register: (tool: unknown) => registered.push(tool) } }, { product: selected, dataDir: join(temporary, "data") });
      assert.deepEqual(registered.map(t => t.name), [`craft_${selected}_tools`, `craft_${selected}_call`]);
      const discovered = await registered[0].execute().catch((error: Error) => { throw new Error(`${selected} discovery: ${error.message}`); }); assert(discovered.skill.includes(`name: ${product.name}`)); assert(discovered.tools.length);
      const tool = selected === "context" ? "craft_context_open" : selected === "codebase" ? "craft_codebase_repository_ensure" : "craft_component_readiness_get";
      const args = selected === "context" ? { project_root: repository, query: "alpha" } : selected === "codebase" ? { project_root: repository } : { component: selected };
      const result = await registered[1].execute({ tool, arguments_json: JSON.stringify(args) }).catch((error: Error) => { throw new Error(`${selected} call: ${error.message}`); }); assert.equal(result.isError, false);
      if (selected === "context") assert.equal(result.structuredContent.codebase.status, "ready");
      if (selected === "codebase") assert.equal(result.structuredContent.reused, true);
    }
    const launch = { command: process.execPath, args: [join(root, "plugins/craft-context/dist/plugin/craft-mcp.cjs"), "--product", "context"], env: { ...process.env, CRAFT_DATA_DIR: join(temporary, "data") } };
    const outcomes = await Promise.all([1, 2].map(() => exchange(launch, "tools/call", { name: "craft_context_open", arguments: { project_root: repository, query: "alpha" } })));
    assert.equal(outcomes[0].structuredContent.codebase.index_id, outcomes[1].structuredContent.codebase.index_id);
    const cold = { ...launch, env: { ...launch.env, CRAFT_DATA_DIR: join(temporary, "fresh-data") } };
    const coldResults = await Promise.all([1, 2].map(() => exchange(cold, "tools/call", { name: "craft_context_open", arguments: { project_root: repository, query: "alpha" } })));
    assert.equal(coldResults[0].structuredContent.codebase.index_id, coldResults[1].structuredContent.codebase.index_id);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
