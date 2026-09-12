import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

async function json(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(resolve(root, path), "utf8")) as Record<string, any>;
}

test("WorkBuddy Expert package has the required identity, Agent, avatar, Skill, and MCP dependency", async () => {
  const packageRoot = "adapters/workbuddy-expert";
  const plugin = await json(`${packageRoot}/.codebuddy-plugin/plugin.json`);
  const mcp = await json(`${packageRoot}/.mcp.json`);
  assert.equal(plugin.name, "craft-work-governance");
  assert.equal(plugin.version, "0.11.62");
  assert.equal(plugin.expertType, "agent");
  assert.equal(plugin.agentName, "craft-work-governance");
  assert.deepEqual(plugin.agents, ["./agents/craft-work-governance.md"]);
  assert.deepEqual(plugin.skills, ["./skills/craft-route"]);
  assert.equal(plugin.dependencies.mcpServers, "./.mcp.json");
  assert.equal(plugin.quickPrompts.length, 3);
  assert.deepEqual(plugin.defaultInitPrompt, plugin.quickPrompts[0]);
  assert.equal(plugin.tags.length, 3);
  assert.match(plugin.displayDescription.zh, /^.{40,50}$/u);
  assert.match(await readFile(resolve(root, `${packageRoot}/agents/craft-work-governance.md`), "utf8"), /craft_default_route/);
  assert.match(await readFile(resolve(root, `${packageRoot}/skills/craft-route/SKILL.md`), "utf8"), /craft_default_route/);
  await assert.rejects(readFile(resolve(root, `${packageRoot}/skills/craft/SKILL.md`)), { code: "ENOENT" });
  const avatar = await readFile(resolve(root, `${packageRoot}/avatars/craft-work-governance.png`));
  assert.deepEqual([...avatar.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(Object.keys(mcp.mcpServers), ["craft"]);
  assert.equal(mcp.mcpServers.craft.command, "craft-mcp");
  assert.equal(mcp.mcpServers.craft["x-workbuddy"].auth.type, "none");
});
