import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("packaged Codex Context MCP opts into the Codex CLI Host for learning", async () => {
  const codexManifest = JSON.parse(await readFile(join(root, "plugins/craft-context/.codex-plugin/plugin.json"), "utf8")) as { mcpServers?: unknown };
  assert.equal(codexManifest.mcpServers, "./.mcp.json");
  for (const path of ["plugins/craft-context/mcp.json", "plugins/craft-context/.mcp.json"]) {
    const manifest = JSON.parse(await readFile(join(root, path), "utf8")) as { mcpServers?: Record<string, { env?: Record<string, string> }> };
    assert.equal(manifest.mcpServers?.["craft-context"]?.env?.CRAFT_LEARNING_MODEL_HOST, "codex-cli", `${path} must preserve the Host opt-in`);
  }
});
