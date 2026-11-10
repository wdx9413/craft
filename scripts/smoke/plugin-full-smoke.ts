import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_PREFERRED_PROTOCOL_VERSION } from "../../core/distribution-and-first-run.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const pluginRoot = join(root, "plugins", "craft");
const manifest = JSON.parse(await readFile(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
const dataRoot = await mkdtemp(join(tmpdir(), "craft-plugin-full-smoke-"));
const child = spawn("node", [join(pluginRoot, "dist/plugin/craft-mcp-full.cjs")], {
  cwd: pluginRoot, env: { ...process.env, CRAFT_DATA_DIR: join(dataRoot, "data") }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
});
try {
  assert(child.stdin && child.stdout && child.stderr, "full MCP smoke test requires piped stdio");
  let output = ""; let errors = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const responsesPromise = new Promise<Array<Record<string, any>>>((resolveResponses, reject) => {
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const lines = output.split(/\r?\n/u);
      if (lines.length >= 3) resolveResponses(lines.slice(0, 2).map((line) => JSON.parse(line)));
    });
    child.once("error", reject);
  });
  child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_PREFERRED_PROTOCOL_VERSION } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  const responses = await Promise.race([responsesPromise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(errors || "Full MCP smoke test timed out")), 5_000))]);
  assert.equal(responses[0].result.serverInfo.version, manifest.version);
  const tools = responses[1].result.tools as Array<{ name: string }>;
  assert(tools.some((tool) => tool.name === "craft_skill_proposal_publish"));
  assert(!tools.some((tool) => /^craft_workflow_(?:evolution|dag)_/u.test(tool.name)));
  console.log("Bundled full MCP starts and excludes retired Workflow Evolution/DAG tools.");
} finally {
  if (child.exitCode === null) { child.kill(); await once(child, "exit"); }
  await rm(dataRoot, { recursive: true, force: true });
}
