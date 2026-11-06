import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { CraftService } from "../core/service.ts";
import { WorkbenchWebApp } from "../core/workbench-server.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { isCraftCompatibleManifest, normalizePluginManifest, pluginSourceFormat, pluginSlug } from "../core/plugin-adapters.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-plugin-adapter-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  return { root, store, service: new CraftService(store) };
}

test("Claude and Codex plugin formats normalize into the same adapter description", () => {
  assert.equal(pluginSourceFormat(["claude", "codex"]), "claude");
  assert.equal(pluginSourceFormat(["craft"]), "craft");
  assert.equal(pluginSourceFormat([]), "generic");
  assert.equal(pluginSlug("Craft Context 2.0"), "craft-context-2-0");
  assert.equal(pluginSlug("***"), "plugin");

  const claude: JsonObject = { name: "Craft Context", version: "1.0.0",
    hosts: ["claude"], platforms: ["windows"],
    mcpServers: { "craft-context": { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/dist/plugin/craft-mcp.cjs", "--product", "context"], env: { MODE: "read" } } },
    skills: "./skills/", hooks: "./hooks/hooks.json" };
  assert.equal(isCraftCompatibleManifest(claude), true);
  const normalized = normalizePluginManifest(claude, ["claude"], "C:/plugins/craft-context");
  assert.equal(normalized.source_format, "claude");
  assert.equal(normalized.requires_plugin_root, false);
  assert.equal(normalized.adapters.length, 1);
  assert.deepEqual(
    { id: normalized.adapters[0].adapter_id, kind: normalized.adapters[0].kind, transport: normalized.adapters[0].transport, platforms: normalized.adapters[0].platforms },
    { id: "claude.craft-context.craft-context", kind: "mcp", transport: "stdio", platforms: ["win32"] });
  assert.equal((normalized.adapters[0].metadata.args as string[])[0], "C:/plugins/craft-context/dist/plugin/craft-mcp.cjs");
  assert.equal(normalized.notes.some((note) => note.includes("./skills/")), true);

  // A Codex plugin keeps its MCP servers in an external file, which a bare
  // manifest upload cannot expand.
  const codex: JsonObject = { name: "Craft Codebase", version: "1.0.0", skills: "./skills/", mcpServers: "./.mcp.json" };
  const external = normalizePluginManifest(codex, ["codex"]);
  assert.equal(external.adapters.length, 0);
  assert.equal(external.notes.some((note) => note.includes("./.mcp.json")), true);

  // The DSH single-entry shape still maps.
  const dsh = normalizePluginManifest({ name: "Echo Tool", kind: "command", entry: "node", args: ["tool.js"] }, ["dsh"]);
  assert.equal(dsh.adapters.length, 1);
  assert.equal(dsh.adapters[0].kind, "command");
  assert.equal(dsh.adapters[0].transport, "stdio");
});

test("inline commands and skills map, and unresolved plugin roots are reported", () => {
  const manifest: JsonObject = { name: "Review Pack", version: "2.0.0",
    commands: [
      { name: "review", entry: "node", args: ["review.js"], description: "Review a diff" },
      { name: "summarize", content: "# Summarize\n\nSummarize the change." },
    ],
    skills: [{ name: "changelog", description: "Write a changelog", content: "# Changelog\n\nWrite it." }, { name: "empty" }],
    platforms: ["darwin", "plan9"], effects: ["read", "not-an-effect"], permissions: ["fs:read"] };
  const normalized = normalizePluginManifest(manifest, ["claude"]);
  assert.deepEqual(normalized.adapters.map((adapter) => adapter.adapter_id), ["claude.review-pack.review"]);
  assert.deepEqual(normalized.skills.map((skill) => skill.skill_id), ["review-pack.summarize", "review-pack.changelog"]);
  assert.deepEqual(normalized.adapters[0].platforms, ["darwin"]);
  assert.deepEqual(normalized.adapters[0].effects, ["read"]);
  assert.equal(normalized.notes.some((note) => note.includes("empty")), true);

  const rooted = normalizePluginManifest({ name: "Rooted", mcpServers: { x: { command: "${CODEX_PLUGIN_ROOT}/run.js" } } }, ["codex"]);
  assert.equal(rooted.requires_plugin_root, true);
  assert.equal(rooted.adapters[0].entry, "${CODEX_PLUGIN_ROOT}/run.js");
  assert.equal(normalizePluginManifest({ name: "Rooted", mcpServers: { x: { command: "${CODEX_PLUGIN_ROOT}/run.js" } } }, ["codex"], "D:/plug").adapters[0].entry, "D:/plug/run.js");
});

test("installing a Claude-format plugin into Craft registers adapters and skills", async () => {
  const f = await fixture();
  const installed = f.service.workbenchPluginInstall({ target_hosts: ["craft"], plugin_root: "C:/plugins/context",
    manifest: { name: "Craft Context", version: "1.0.0", hosts: ["claude"],
      mcpServers: { context: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/dist/plugin/craft-mcp.cjs"] } },
      commands: [{ name: "recall", content: "# Recall\n\nRecall a memory." }] } }) as { plugin: JsonObject };
  assert.equal(installed.plugin.runtime_status, "mapped_adapter");
  assert.deepEqual(installed.plugin.mapped_adapter_ids, ["claude.craft-context.context"]);
  assert.deepEqual(installed.plugin.mapped_skill_ids, ["craft-context.recall"]);
  assert.equal(installed.plugin.requires_plugin_root, false);
  assert.equal((installed.plugin.hosts as string[]).includes("craft"), false);
  assert.deepEqual(installed.plugin.target_hosts, ["craft"]);

  const adapters = (f.service.adapterManifestList({}) as { adapters: JsonObject[] }).adapters;
  assert.equal(adapters.some((adapter) => adapter.adapter_id === "claude.craft-context.context"), true);
  assert.equal((f.service.workbenchResourceCatalogView({ kind: "skills" }) as { items: JsonObject[] }).items
    .some((skill) => skill.id === "craft-context.recall"), true);

  const withoutRoot = f.service.workbenchPluginInstall({ plugin_id: "rooted", target_hosts: ["craft"],
    manifest: { name: "Rooted", version: "1.0.0", hosts: ["codex"], mcpServers: { x: { command: "${CODEX_PLUGIN_ROOT}/run.js" } } } }) as { plugin: JsonObject };
  assert.equal(withoutRoot.plugin.requires_plugin_root, true);
  assert.match(String(withoutRoot.plugin.unsupported_reason), /plugin_root/u);

  // A host the manifest never declared is still rejected.
  assert.throws(() => f.service.workbenchPluginInstall({ target_hosts: ["claude"], manifest: { name: "Bad", version: "1", hosts: ["codex"], entry: "x" } }),
    /target_hosts must be declared/u);

  // The same path over HTTP keeps the workbench honest about the mapping.
  const app = new WorkbenchWebApp(f.service, "token", "http://127.0.0.1:1");
  const routed = app.handle({ method: "POST", path: "/api/workbench/plugins", token: "token", body: JSON.stringify({
    target_hosts: ["craft"], plugin_root: "/plugins/ctx",
    manifest: { name: "Routed", version: "1.0.0", hosts: ["codex"], mcpServers: { ctx: { command: "${CODEX_PLUGIN_ROOT}/mcp.js" } } } }) });
  assert.equal(routed.status, 201);
  assert.deepEqual(JSON.parse(routed.body).plugin.mapped_adapter_ids, ["codex.routed.ctx"]);
  const listed = JSON.parse(app.handle({ method: "GET", path: "/api/workbench/resources?kind=plugins", token: "token" }).body) as { items: JsonObject[] };
  assert.equal(listed.items.find((item) => item.name === "Routed")?.requires_plugin_root, false);
  f.store.close();
});

test("a plugin directory expands its external MCP file and skills", async () => {
  const f = await fixture();
  const pluginDir = join(f.root, "context-plugin");
  await mkdir(join(pluginDir, ".claude-plugin"), { recursive: true });
  await mkdir(join(pluginDir, "skills", "recall"), { recursive: true });
  await writeFile(join(pluginDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "Dir Plugin", version: "1.0.0", mcpServers: "./.mcp.json", skills: "./skills/" }), "utf8");
  await writeFile(join(pluginDir, ".mcp.json"),
    JSON.stringify({ mcpServers: { dir: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/mcp.js"] } } }), "utf8");
  await writeFile(join(pluginDir, "skills", "recall", "SKILL.md"), "# Recall\n\nRecall it.\n", "utf8");

  const result = f.service.workbenchPluginInstallFromDirectory({ path: pluginDir, target_hosts: ["craft"] }) as { plugin: JsonObject };
  assert.equal(result.plugin.runtime_status, "mapped_adapter");
  assert.deepEqual(result.plugin.mapped_adapter_ids, ["claude.dir-plugin.dir"]);
  assert.deepEqual(result.plugin.mapped_skill_ids, ["dir-plugin.recall"]);
  assert.equal(result.plugin.requires_plugin_root, false);
  const adapter = (f.service.adapterManifestList({}) as { adapters: JsonObject[] }).adapters
    .find((item) => item.adapter_id === "claude.dir-plugin.dir");
  const args = (adapter?.metadata as JsonObject)?.args as string[];
  assert.equal(String(args[0]).replaceAll("\\", "/").endsWith("/context-plugin/mcp.js"), true);

  assert.throws(() => f.service.workbenchPluginInstallFromDirectory({ path: join(pluginDir, ".mcp.json") }), /must be a directory/u);
  const empty = join(f.root, "empty-plugin");
  await mkdir(empty, { recursive: true });
  assert.throws(() => f.service.workbenchPluginInstallFromDirectory({ path: empty }), /plugin.json was not found/u);
  f.store.close();
});

test("a plugin directory never reads a file outside itself", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "outside.json"),
    JSON.stringify({ mcpServers: { escaped: { command: "node", args: ["escaped.js"] } } }), "utf8");
  const pluginDir = join(f.root, "escape-plugin");
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, "plugin.json"),
    JSON.stringify({ name: "Escape Pack", version: "1.0.0", mcpServers: "../outside.json", skills: "../outside-skills" }), "utf8");

  const result = f.service.workbenchPluginInstallFromDirectory({ path: pluginDir, target_hosts: ["craft"] }) as { plugin: JsonObject };
  assert.deepEqual(result.plugin.mapped_adapter_ids, []);
  assert.deepEqual(result.plugin.mapped_skill_ids, []);
  assert.equal(JSON.stringify(result.plugin.manifest).includes("escaped"), false);
  assert.match(String(result.plugin.unsupported_reason), /mcpServers 指向/u);

  // An absolute plugin_root is required; a relative one resolves to an absolute path.
  const rooted = f.service.workbenchPluginInstall({ plugin_id: "relative-root", target_hosts: ["craft"], plugin_root: "relative/root",
    manifest: { name: "Relative Root", version: "1.0.0", hosts: ["codex"], mcpServers: { x: { command: "${CODEX_PLUGIN_ROOT}/run.js" } } } }) as { plugin: JsonObject };
  const adapter = (f.service.adapterManifestList({}) as { adapters: JsonObject[] }).adapters.find((item) => item.adapter_id === "codex.relative-root.x");
  const command = String((adapter?.metadata as JsonObject).command);
  assert.equal(isAbsolute(resolve("relative/root")), true);
  assert.equal(command.replaceAll("\\", "/").startsWith(resolve("relative/root").replaceAll("\\", "/")), true);
  assert.equal(rooted.plugin.requires_plugin_root, false);

  // Every read from a plugin directory stays bounded.
  const huge = join(f.root, "huge-plugin");
  await mkdir(huge, { recursive: true });
  await writeFile(join(huge, "plugin.json"), JSON.stringify({ name: "Huge", version: "1.0.0", description: "x".repeat(70_000) }), "utf8");
  assert.throws(() => f.service.workbenchPluginInstallFromDirectory({ path: huge }), /exceeds 65536 bytes/u);

  const bigSkill = join(f.root, "big-skill-plugin");
  await mkdir(join(bigSkill, "skills", "one"), { recursive: true });
  await writeFile(join(bigSkill, "plugin.json"), JSON.stringify({ name: "Big Skill", version: "1.0.0", skills: "./skills/" }), "utf8");
  await writeFile(join(bigSkill, "skills", "one", "SKILL.md"), "x".repeat(48_001), "utf8");
  assert.throws(() => f.service.workbenchPluginInstallFromDirectory({ path: bigSkill }), /exceeds 48000 characters/u);
  f.store.close();
});
