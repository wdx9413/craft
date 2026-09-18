import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const components = ["craft-context", "craft-quality", "craft-knowledge", "craft-memory", "craft-capability", "craft-skill-quality", "craft-workflow-evolution"];

async function smoke(name: string): Promise<void> {
  const pluginRoot = join(root, "plugins", name);
  const manifest = JSON.parse(await readFile(join(pluginRoot, ".mcp.json"), "utf8"));
  const server = manifest.mcpServers[name];
  const data = await mkdtemp(join(tmpdir(), `${name}-smoke-`));
  const child = spawn(server.command, server.args, { cwd: pluginRoot, env: { ...process.env, CRAFT_DATA_DIR: data }, stdio: ["pipe", "pipe", "pipe"] });
  try {
    let output = "";
    child.stdout.setEncoding("utf8");
    const responses = new Promise<Array<Record<string, any>>>((resolveResponses, reject) => {
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const lines = output.split(/\r?\n/u);
        if (lines.length >= 3) resolveResponses(lines.slice(0, 2).map((line) => JSON.parse(line)));
      });
      child.once("error", reject);
    });
    child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    const result = await Promise.race([responses, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${name} timed out`)), 5_000))]);
    const tools = result[1].result.tools as Array<{ name: string }>;
    assert.equal(result[0].result.serverInfo.version, "0.12.32");
    assert(tools.length > 0);
    assert(tools.some((tool) => tool.name === "craft_info"));
    assert(!tools.some((tool) => tool.name === "craft_verified_work_loop_prepare"));
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child, "exit"); }
    await rm(data, { recursive: true, force: true });
  }
}

for (const component of components) await smoke(component);
process.stdout.write("All component plugin MCP surfaces completed initialize/tools-list smoke tests.\n");
