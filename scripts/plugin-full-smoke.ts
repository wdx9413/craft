import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dataRoot = await mkdtemp(join(tmpdir(), "craft-plugin-full-smoke-"));
const child = spawn("node", [join(root, "dist/plugin/craft-mcp-full.cjs")], {
  cwd: root, env: { ...process.env, CRAFT_DATA_DIR: join(dataRoot, "data") }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
});
try {
  assert(child.stdin && child.stdout && child.stderr, "full MCP smoke test requires piped stdio");
  let output = ""; let errors = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { errors += chunk; });
  child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  await Promise.race([once(child.stdout, "data"), new Promise<never>((_, reject) => setTimeout(() => reject(new Error(errors || "Full MCP smoke test timed out")), 5_000))]);
  await new Promise((resolveOutput) => setTimeout(resolveOutput, 25));
  const responses = output.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(responses[0].result.serverInfo.version, "0.11.46");
  assert((responses[1].result.tools as Array<{ name: string }>).some((tool) => tool.name === "craft_skill_proposal_publish"));
  console.log("Bundled full MCP starts and retains legacy tools.");
} finally {
  if (child.exitCode === null) { child.kill(); await once(child, "exit"); }
  await rm(dataRoot, { recursive: true, force: true });
}
