import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const codexManifest = JSON.parse(await readFile(join(projectRoot, ".codex-plugin", "plugin.json"), "utf8"));
assert(codexManifest.interface.defaultPrompt.length <= 3, "Codex accepts at most three default prompts");
const manifest = JSON.parse(await readFile(join(projectRoot, ".mcp.json"), "utf8"));
assert.deepEqual(Object.keys(manifest), ["mcpServers"], ".mcp.json must use the Codex companion-file shape");
assert.deepEqual(Object.keys(manifest.mcpServers), ["craft"]);
const server = manifest.mcpServers.craft;
assert.equal(server.command, "node");
assert.equal(server.cwd, ".");

const pluginRoot = await mkdtemp(join(tmpdir(), "craft-plugin-smoke-"));
let child: ReturnType<typeof spawn> | undefined;
try {
  const relativeBundle = String(server.args[0]);
  const copiedBundle = join(pluginRoot, relativeBundle);
  await mkdir(dirname(copiedBundle), { recursive: true });
  await copyFile(join(projectRoot, relativeBundle), copiedBundle);
  const request = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "craft_info", arguments: {} } },
  ].map((item) => JSON.stringify(item)).join("\n");
  child = spawn(server.command, server.args, {
    cwd: resolve(pluginRoot, server.cwd),
    env: { ...process.env, CRAFT_DATA_DIR: join(pluginRoot, "data") },
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  const { stdin, stdout, stderr } = child;
  assert(stdin && stdout && stderr, "MCP smoke test requires piped stdio");
  let output = "";
  let errors = "";
  stdout.setEncoding("utf8");
  stderr.setEncoding("utf8");
  stderr.on("data", (chunk) => { errors += chunk; });
  const responsesPromise = new Promise<unknown[]>((resolveResponses, reject) => {
    stdout.on("data", (chunk) => {
      output += chunk;
      const lines = output.trim().split(/\r?\n/);
      if (lines.length >= 3) resolveResponses(lines.slice(0, 3).map((line) => JSON.parse(line)));
    });
    child!.once("error", reject);
    child!.once("exit", (code) => {
      if (code && output.trim().split(/\r?\n/).length < 3) reject(new Error(errors || `MCP exited with ${code}`));
    });
  });
  stdin.end(`${request}\n`);
  const responses = await Promise.race([
    responsesPromise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(errors || "MCP smoke test timed out")), 5_000)),
  ]) as Array<any>;
  assert.equal(responses[0].result.serverInfo.version, "0.9.4");
  assert((responses[1].result.tools as Array<{ name: string }>).some((tool) => tool.name === "craft_skill_proposal_publish"));
  assert.equal(responses[2].result.structuredContent.version, "0.9.4");
  console.log("Bundled plugin MCP starts without node_modules.");
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await once(child, "exit");
  }
  await rm(pluginRoot, { recursive: true, force: true });
}
