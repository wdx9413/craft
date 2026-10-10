import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MCP_PREFERRED_PROTOCOL_VERSION } from "../../core/distribution-and-first-run.ts";

const root = resolve(import.meta.dirname, "..", "..");
import { RELEASE_PRODUCTS } from "../../core/release-catalog.ts";

const components = RELEASE_PRODUCTS.filter((product) => product.name !== "craft").map((product) => product.name);

async function smoke(name: string): Promise<void> {
  const pluginRoot = join(root, "plugins", name);
  const manifest = JSON.parse(await readFile(join(pluginRoot, ".mcp.json"), "utf8"));
  const server = manifest.mcpServers[name];
  const data = await mkdtemp(join(tmpdir(), `${name}-smoke-`));
  if (name === "craft-codebase") await writeFile(join(data, "main.ts"), "export const value = 1;\n");
  const child = spawn(server.command, server.args, { cwd: pluginRoot, env: { ...process.env, CRAFT_DATA_DIR: data }, stdio: ["pipe", "pipe", "pipe"] });
  try {
    let output = "";
    child.stdout.setEncoding("utf8");
    const expectedDailyTool = name === "craft-codebase" ? "craft_codebase_status" : ["craft-knowledge", "craft-memory", "craft-experience"].includes(name) ? "craft_component_readiness_get" : "craft_info";
    const callTool = name === "craft-codebase" ? "craft_codebase_workspace_open" : expectedDailyTool;
    const callArguments = name === "craft-codebase" ? { workspace_id: "fixture", root_path: data, include_paths: ["main.ts"] }
      : expectedDailyTool === "craft_component_readiness_get" ? { component: name.replace("craft-", "") } : {};
    const responses = new Promise<Array<Record<string, any>>>((resolveResponses, reject) => {
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const lines = output.split(/\r?\n/u);
        if (lines.length >= 4) resolveResponses(lines.slice(0, 3).map((line) => JSON.parse(line)));
      });
      child.once("error", reject);
    });
    child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_PREFERRED_PROTOCOL_VERSION } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: callTool, arguments: callArguments } })}\n`);
    const result = await Promise.race([responses, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${name} timed out`)), 5_000))]);
    const tools = result[1].result.tools as Array<{ name: string }>;
    assert.equal(result[0].result.serverInfo.version, "0.12.41");
    assert(tools.length > 0);
    assert(tools.some((tool) => tool.name === expectedDailyTool));
    assert(tools.some((tool) => tool.name === callTool));
    assert.equal(result[2].error, undefined, `${name}: ${JSON.stringify(result[2].error)}`);
    assert.equal(result[2].result?.isError, false, `${name}: ${JSON.stringify(result[2].result)}`);
    assert(!tools.some((tool) => tool.name === "craft_verified_work_loop_prepare"));
    if (name === "craft-experience") assert(!tools.some((tool) => /^craft_workflow_(?:evolution|dag)_/u.test(tool.name)));
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child, "exit"); }
    await rm(data, { recursive: true, force: true });
  }
}

for (const component of components) await smoke(component);
process.stdout.write("All component plugin MCP surfaces completed initialize/tools-list/tools-call smoke tests.\n");
