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
