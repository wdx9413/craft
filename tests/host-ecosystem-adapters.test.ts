import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(root, path), "utf8")) as Record<string, unknown>;
}

async function text(path: string): Promise<string> {
  return readFile(resolve(root, path), "utf8");
}

function onlyServer(document: Record<string, unknown>): Record<string, unknown> {
  const servers = document.mcpServers as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(servers), ["craft"]);
  return servers.craft;
}

test("TraeWork adapter defaults to Core and keeps an explicit Full upgrade with portable Skills", async () => {
  const routeFirst = onlyServer(await json("adapters/trae-work/mcp.json"));
  const compact = onlyServer(await json("adapters/trae-work/mcp-core.json"));
  const full = onlyServer(await json("adapters/trae-work/mcp-full.json"));
  assert.equal(routeFirst.command, "craft-mcp");
  assert.equal(compact.command, "craft-mcp");
  assert.equal(full.command, "craft-mcp-full");
  assert.deepEqual(routeFirst.args, []);
  assert.deepEqual(full.args, []);
  assert.deepEqual(full.env, { START_MCP_TIMEOUT_MS: "60000", RUN_MCP_TIMEOUT_MS: "60000" });
  assert.match(await text("adapters/trae-work/skills/craft/SKILL.md"), /craft_default_route/);
  assert.match(await text("adapters/trae-work/skills/craft-route/SKILL.md"), /craft_default_route/);
  assert.match(await text("adapters/trae-work/skills/craft-clarify/SKILL.md"), /at most three/i);
  assert.match(await text("adapters/trae-work/README.md"), /cloud tasks need a separately deployed HTTPS MCP adapter/i);
});

test("WorkBuddy connector keeps the explicit advanced MCP with a route-first Skill", async () => {
  const connector = await json("adapters/workbuddy-connector/connector-meta.json");
  const server = onlyServer(await json("adapters/workbuddy-connector/mcp.json"));
  assert.equal(connector.source, "craft-agent-harness");
  assert.equal(connector.type, "mcp");
  assert.equal(connector.version, "0.11.61");
  assert(Array.isArray(connector.examples_zh) && connector.examples_zh.length >= 2);
  assert(Array.isArray(connector.examples_en) && connector.examples_en.length >= 2);
  assert.equal(server.type, "stdio");
  assert.equal(server.command, "craft-mcp-full");
  assert.equal(server.timeout, 30000);
  assert.match(await text("adapters/workbuddy-connector/skills/craft/SKILL.md"), /craft_default_route/);
  assert.match(await text("adapters/workbuddy-connector/skills/craft-route/SKILL.md"), /craft_default_route/);
  assert.match(await text("adapters/workbuddy-connector/icon.svg"), /<svg/);
  assert.match(await text("adapters/workbuddy-connector/README.md"), /not a claim of marketplace availability/i);
});

test("every portable host defaults to the same route-first Core and retains an explicit Full path", async () => {
  const codex = await json(".codex-plugin/plugin.json");
  const claude = await json(".claude-plugin/plugin.json");
  const rootMcp = await json(".mcp.json");
  const expertMcp = await json("adapters/workbuddy-expert/.mcp.json");
  assert.equal(codex.mcpServers, "./.mcp.json");
  assert.deepEqual((rootMcp.mcpServers as Record<string, Record<string, unknown>>).craft.args, ["dist/plugin/craft-mcp.cjs"]);
  assert.deepEqual((claude.mcpServers as Record<string, Record<string, unknown>>).craft.args, ["${CLAUDE_PLUGIN_ROOT}/dist/plugin/craft-mcp.cjs"]);
  assert.equal(onlyServer(expertMcp).command, "craft-mcp");
  assert.match(await text("skills/craft-route/SKILL.md"), /craft_default_route/);
  assert.match(await text("adapters/README.md"), /craft-mcp-full.*user-approved/i);
  assert.match(await text("docs/technical/modules/host-ecosystem-adapters.md"), /Codex \/ Claude \/ TraeWork \/ WorkBuddy/);
});
