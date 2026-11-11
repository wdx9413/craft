import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { defaultSettings, normalizeSettings, saveSettingsSync, loadSettingsSync } from "../core/settings.ts";
import { runtimeDependencyPolicy, DEFAULT_PLUGIN_ADAPTER_PRIORITY } from "../core/runtime-dependency-policy.ts";
import { pluginHostOrder, preferredPluginHost, pluginSourceFormat } from "../core/plugin-adapters.ts";

function temporaryPaths() {
  return craftPaths(mkdtempSync(join(tmpdir(), "craft-runtime-policy-")));
}

test("默认策略：不依赖外部 CLI 驱动、不注入 host-managed auth、只用配置模型", () => {
  const paths = temporaryPaths();
  try {
    const settings = defaultSettings(paths);
    assert.deepEqual(settings.runtimeDependencies, { externalCliDrivers: false, hostManagedAuthProvider: false, configuredModelOnly: true });
    const policy = runtimeDependencyPolicy(settings);
    assert.equal(policy.externalCliDrivers, false);
    assert.equal(policy.hostManagedAuthProvider, false);
    assert.equal(policy.configuredModelOnly, true);
    assert.deepEqual(policy.pluginAdapterPriority, ["codex", "claude", "dsh", "pi", "craft", "generic"]);
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("显式开关才重新启用外部 CLI 与 host-managed auth，且配置可持久化", () => {
  const paths = temporaryPaths();
  try {
    const saved = saveSettingsSync({ runtimeDependencies: { externalCliDrivers: true, hostManagedAuthProvider: true } }, paths);
    assert.equal(saved.runtimeDependencies.externalCliDrivers, true);
    const policy = runtimeDependencyPolicy(loadSettingsSync(paths));
    assert.equal(policy.externalCliDrivers, true);
    assert.equal(policy.hostManagedAuthProvider, true);
    assert.throws(() => normalizeSettings({ runtimeDependencies: { externalCliDrivers: "yes" } }, paths), /must be a boolean/u);
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("插件来源优先级固定 codex > claude > dsh > pi > craft > generic", () => {
  assert.deepEqual(DEFAULT_PLUGIN_ADAPTER_PRIORITY, ["codex", "claude", "dsh", "pi", "craft", "generic"]);
  const hosts = ["craft", "dsh", "claude", "codex", "unknown"];
  assert.deepEqual(pluginHostOrder(hosts), ["codex", "claude", "dsh", "craft"]);
  assert.equal(preferredPluginHost(hosts), "codex");
  assert.equal(preferredPluginHost(["dsh", "claude"]), "claude");
  assert.equal(preferredPluginHost(["pi", "craft"]), "pi");
  assert.equal(preferredPluginHost([]), null);
  assert.equal(pluginSourceFormat(["claude", "codex"]), "codex");
  assert.equal(pluginSourceFormat(["pi", "craft"]), "generic");
});
