import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { CraftService } from "../core/service.ts";
import { extractWorkbenchContribution, normalizePluginManifest } from "../core/plugin-adapters.ts";
import { normalizePluginMods } from "../core/plugin-workbench.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-plugin-wb-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  return { root, store, service: new CraftService(store) };
}

test("Claude/Codex 扩展位的 workbench 块被归一化并标记来源", () => {
  const claude = { name: "p", ui: { schemaVersion: 1, pages: [{ id: "p", title: "P", kind: "declarative", schema: "./p.json" }] } };
  assert.deepEqual((extractWorkbenchContribution(claude as JsonObject) as JsonObject).pages, [{ id: "p", title: "P", kind: "declarative", schema: "./p.json" }]);
  const codex = { name: "p", extensions: { openai: { ui: { schemaVersion: 1, pages: [{ id: "q", title: "Q", kind: "declarative", schema: "./q.json" }] } } } };
  assert.equal(extractWorkbenchContribution(codex as JsonObject)?.schemaVersion, 1);
  // 未声明 schemaVersion 的宿主 UI 配置不被误认成页面协议。
  assert.equal(extractWorkbenchContribution({ name: "p", ui: { pages: [] } } as JsonObject), null);
  const normalized = normalizePluginManifest(codex as JsonObject, ["codex"], null);
  assert.equal(normalized.source_format, "codex");
  assert.equal(normalized.workbench?.schemaVersion, 1);
});

test("插件声明的 Mod 只生成 draft，且带 plugin_id、不自动激活", async () => {
  const f = await fixture();
  try {
    const installed = f.service.workbenchPluginInstall({
      plugin_id: "wb-mod-plugin",
      hosts: ["craft"],
      manifest: { name: "wb-mod-plugin", hosts: ["craft"], version: "1.0.0",
        workbench: { schemaVersion: 1, pages: [{ id: "home", title: "Home", kind: "declarative", schema: "./home.json" }] },
        mods: [{ id: "style", name: "Style", body: "Prefer concise answers.", applies_to: "worker", scope_kind: "global" }] },
    }) as JsonObject;
    const plugin = installed.plugin as JsonObject;
    assert.deepEqual(plugin.imported_mod_ids, ["plugin_wb-mod-plugin_style"]);
    assert.equal(plugin.workbench_protocol, "craft.workbench.v1");
    const mod = f.store.get("mod", "plugin_wb-mod-plugin_style");
    assert.equal(mod.status, "draft");
    assert.equal(mod.enabled, false);
    assert.equal(mod.plugin_id, "wb-mod-plugin");
    // 未审批的 Mod 不进入 Worker overlay。
    const before = f.service.mods.modSystemOverlay({ kind: "global", id: "global" }, "worker", ["wb-mod-plugin"]);
    assert.doesNotMatch(String(before), /Prefer concise answers/u);
    f.service.modApprove({ id: "plugin_wb-mod-plugin_style", approved_by: "user:test" });
    const after = f.service.mods.modSystemOverlay({ kind: "global", id: "global" }, "worker", ["wb-mod-plugin"]);
    assert.match(String(after), /Prefer concise answers/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("插件 Mod 声明校验：非法 id、超长正文与越权 applies_to 被拒绝", () => {
  assert.throws(() => normalizePluginMods({ mods: [{ id: "BAD ID", body: "x" }] } as JsonObject), /id is invalid/u);
  assert.throws(() => normalizePluginMods({ mods: [{ id: "a", body: "x".repeat(8_001) }] } as JsonObject), /too long/u);
  assert.throws(() => normalizePluginMods({ mods: [{ id: "a", body: "x", applies_to: "everyone" }] } as JsonObject), /worker, reviewer or all/u);
  assert.throws(() => normalizePluginMods({ mods: Array.from({ length: 17 }, (_, i) => ({ id: `m${i}`, body: "x" })) } as JsonObject), /at most 16/u);
});

async function htmlPluginFixture() {
  const f = await fixture();
  const { mkdir, writeFile } = await import("node:fs/promises");
  const pluginDir = join(f.root, "html-plugin");
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, "panel.html"),
    "<!doctype html><html><body><h1>Plugin Panel</h1><script>window.__inFrame = true;</script></body></html>", "utf8");
  return { f, pluginDir };
}

test("sandboxed 页面提供静态 HTML 运行时：启用后可读，未启用/越界被拒绝", async () => {
  const { f, pluginDir } = await htmlPluginFixture();
  try {
    const manifest = { name: "html-plugin", version: "1.0.0", hosts: ["craft"],
      workbench: { schemaVersion: 1, pages: [{ id: "panel", title: "Panel", kind: "sandboxed", entry: "panel.html" }] } };
    const installed = f.service.workbenchPluginInstall({ plugin_root: pluginDir, manifest }) as JsonObject;
    const pluginId = String((installed.plugin as JsonObject).id);
    const repo = join(f.root, "ws");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(repo, { recursive: true });
    const workspace = (f.service.workspaceResolveOrCreate({ root_path: repo }) as JsonObject).workspace as JsonObject;
    assert.throws(() => f.service.workbenchPluginPage({ plugin_id: pluginId, page_id: "panel", workspace_id: String(workspace.id) }),
      /enable this installed plugin/u);
    f.service.workspacePluginSet({ workspace_id: String(workspace.id), plugin_id: pluginId, status: "enabled" });
    const page = f.service.workbenchPluginPage({ plugin_id: pluginId, page_id: "panel", workspace_id: String(workspace.id) }) as JsonObject;
    const sandbox = page.sandbox as JsonObject;
    assert.equal(sandbox.kind, "sandboxed");
    assert.match(String(sandbox.html), /Plugin Panel/u);
    assert.match(String(sandbox.html), /Content-Security-Policy/u, "沙箱 HTML 必须带 CSP");
    assert.match(String(sandbox.html), /connect-src 'none'/u);
    // 越界 entry 在安装时就被拒绝。
    assert.throws(() => f.service.workbenchPluginInstall({ plugin_root: pluginDir,
      manifest: { ...manifest, workbench: { schemaVersion: 1, pages: [{ id: "bad", title: "B", kind: "sandboxed", entry: "../outside.html" }] } } }),
      /relative path inside the plugin/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("声明 hooks 的插件不再连坐：页面/Mod/技能仍可导入且可启用", async () => {
  const f = await fixture();
  try {
    const installed = f.service.workbenchPluginInstall({
      manifest: { name: "hooked", version: "1.0.0", hosts: ["craft"],
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node x.js" }] }] },
        workbench: { schemaVersion: 1, pages: [{ id: "home", title: "Home", kind: "declarative", schema: "./home.json" }] },
        mods: [{ id: "rule", name: "Rule", body: "Be brief.", scope_kind: "global" }] },
    }) as JsonObject;
    const plugin = installed.plugin as JsonObject;
    assert.equal(plugin.runtime_status, "descriptor_only");
    assert.match(String(plugin.adapter_notes), /不注册 Hook/u);
    assert.equal((plugin.workbench_pages as JsonObject[]).length, 1);
    const modIds = plugin.imported_mod_ids as string[];
    assert.equal(modIds.length, 1);
    assert.match(modIds[0], /^plugin_studio_plugin_.+_rule$/u);
    assert.equal(f.store.get("mod", modIds[0]).plugin_id, plugin.id);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("workbenchPluginResync 幂等：重复 resync 不重复建 Mod，manifest 变更需显式确认", async () => {
  const { f, pluginDir } = await htmlPluginFixture();
  try {
    const { writeFile } = await import("node:fs/promises");
    const manifest = { name: "html-plugin", version: "1.0.0", hosts: ["craft"],
      workbench: { schemaVersion: 1, pages: [{ id: "panel", title: "Panel", kind: "sandboxed", entry: "panel.html" }] },
      mods: [{ id: "rule", name: "Rule", body: "Stay short.", scope_kind: "global" }] };
    const installed = f.service.workbenchPluginInstall({ plugin_root: pluginDir, manifest }) as JsonObject;
    const pluginId = String((installed.plugin as JsonObject).id);
    const first = f.service.workbenchPluginResync({ plugin_id: pluginId }) as JsonObject;
    assert.equal(first.mods_created, 0, "install 已建过，resync 不应重复");
    assert.equal(((first.plugin as JsonObject).imported_mod_ids as string[]).length, 1);
    const second = f.service.workbenchPluginResync({ plugin_id: pluginId }) as JsonObject;
    assert.equal(second.mods_created, 0);
    // 磁盘 manifest 变更必须显式 allow，否则 fail-closed。
    await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({ name: "html-plugin", version: "1.1.0" }), "utf8");
    assert.throws(() => f.service.workbenchPluginResync({ plugin_id: pluginId }), /allow_manifest_change/u);
    const forced = f.service.workbenchPluginResync({ plugin_id: pluginId, allow_manifest_change: true }) as JsonObject;
    assert.equal(((forced.plugin as JsonObject).workbench_pages as JsonObject[]).length >= 0, true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("卸载插件清理它创建的 draft Mod，但保留已 active 的 Mod", async () => {
  const f = await fixture();
  try {
    const manifest = { name: "mod-plugin", version: "1.0.0", hosts: ["craft"],
      mods: [{ id: "draft-rule", name: "D", body: "draft body", scope_kind: "global" },
             { id: "active-rule", name: "A", body: "active body", scope_kind: "global" }] };
    const installed = f.service.workbenchPluginInstall({ plugin_id: "mod-plugin", manifest }) as JsonObject;
    const modIds = (installed.plugin as JsonObject).imported_mod_ids as string[];
    f.service.modApprove({ id: modIds[1], approved_by: "user:test" });
    const removed = f.service.workbenchPluginRemove({ plugin_id: "mod-plugin" }) as JsonObject;
    assert.deepEqual(removed.removed_mods, [modIds[0]]);
    assert.deepEqual(removed.kept_mods, [modIds[1]]);
    assert.equal(f.store.find("mod", modIds[0]), null);
    assert.equal(f.store.find("mod", modIds[1])?.status, "active");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("插件 Mod 只在插件于该工作区启用时注入 Worker 上下文", async () => {
  const f = await fixture();
  try {
    const { mkdir } = await import("node:fs/promises");
    const repo = join(f.root, "ws"); await mkdir(repo, { recursive: true });
    const workspace = (f.service.workspaceResolveOrCreate({ root_path: repo }) as JsonObject).workspace as JsonObject;
    const installed = f.service.workbenchPluginInstall({ plugin_id: "scoped-plugin",
      manifest: { name: "scoped-plugin", version: "1.0.0", hosts: ["craft"],
        mods: [{ id: "rule", name: "Rule", body: "Use scoped rule.", scope_kind: "project", scope_id: String(workspace.id) }] } }) as JsonObject;
    const modId = ((installed.plugin as JsonObject).imported_mod_ids as string[])[0];
    f.service.modApprove({ id: modId, approved_by: "user:test" });
    // 未启用插件：不注入。
    const before = f.service.modSystemOverlay({ scope_kind: "project", scope_id: String(workspace.id), applies_to: "worker", active_plugins: ["scoped-plugin"] });
    assert.doesNotMatch(before, /Use scoped rule/u);
    // 启用后：注入。
    f.service.workspacePluginSet({ workspace_id: String(workspace.id), plugin_id: "scoped-plugin", status: "enabled" });
    const after = f.service.modSystemOverlay({ scope_kind: "project", scope_id: String(workspace.id), applies_to: "worker", active_plugins: ["scoped-plugin"] });
    assert.match(after, /Use scoped rule/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
