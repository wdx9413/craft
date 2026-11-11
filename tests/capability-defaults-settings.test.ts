import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { defaultSettings, normalizeSettings, saveSettingsSync, loadSettingsSync } from "../core/settings.ts";

function temporaryPaths(): ReturnType<typeof craftPaths> {
  const root = mkdtempSync(join(tmpdir(), "craft-capability-defaults-"));
  return craftPaths(root);
}

test("default settings enable auto-install of craft-context and craft-datasec", () => {
  const paths = temporaryPaths();
  try {
    const settings = defaultSettings(paths);
    assert.equal(settings.capabilities.autoInstall, true);
    assert.deepEqual(settings.capabilities.defaults, ["craft-context", "craft-datasec"]);
    assert.deepEqual(settings.capabilities.installed, []);
    assert.deepEqual(settings.capabilities.disabled, []);
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("normalizeSettings fills missing capabilities and rejects malformed values", () => {
  const paths = temporaryPaths();
  try {
    assert.deepEqual(normalizeSettings({}, paths).capabilities.defaults, ["craft-context", "craft-datasec"]);
    const disabled = normalizeSettings({ capabilities: { disabled: ["craft-datasec"] } }, paths).capabilities;
    assert.equal(disabled.autoInstall, true);
    assert.deepEqual(disabled.disabled, ["craft-datasec"]);
    assert.throws(() => normalizeSettings({ capabilities: { installed: "craft-context" } }, paths), /must be an array/);
    assert.throws(() => normalizeSettings({ capabilities: { defaults: [7] } }, paths), /non-empty strings/);
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("saveSettingsSync persists disable/uninstall records in settings.json", () => {
  const paths = temporaryPaths();
  try {
    const saved = saveSettingsSync({ capabilities: { installed: ["craft-context"], disabled: ["craft-datasec"] } }, paths);
    assert.deepEqual(saved.capabilities.installed, ["craft-context"]);
    assert.deepEqual(saved.capabilities.disabled, ["craft-datasec"]);
    const reloaded = loadSettingsSync(paths);
    assert.deepEqual(reloaded.capabilities.installed, ["craft-context"]);
    assert.deepEqual(reloaded.capabilities.disabled, ["craft-datasec"]);
    assert.equal(reloaded.capabilities.autoInstall, true);
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});
