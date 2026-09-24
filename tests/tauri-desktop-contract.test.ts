import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("Tauri desktop keeps the Workbench sidecar and untrusted embedded pages in separate capability scopes", async () => {
  const config = JSON.parse(await readFile(path.join(root, "desktop/src-tauri/tauri.conf.json"), "utf8"));
  const capability = JSON.parse(await readFile(path.join(root, "desktop/src-tauri/capabilities/default.json"), "utf8"));
  const rust = await readFile(path.join(root, "desktop/src-tauri/src/lib.rs"), "utf8");
  const sidecar = await readFile(path.join(root, "desktop/scripts/prepare-sidecar.mjs"), "utf8");
  assert.equal(config.app.withGlobalTauri, true);
  assert.deepEqual(config.app.windows, []);
  assert.deepEqual(capability.windows, ["main"]);
  assert.match(rust, /WebviewWindowBuilder::new\(&app, "embedded"/);
  assert.match(rust, /matches!\(parsed\.scheme\(\), "http" \| "https"\)/);
  assert.match(rust, /global_shortcut/);
  assert.match(rust, /tauri_plugin_notification/);
  assert.match(rust, /command\.env\("CRAFT_DATA_DIR", data_root\)/);
  assert.match(rust, /app_local_data_dir\(\).*join\("craft-data"\)/s);
  assert.match(rust, /Craft 本地运行时启动失败：/);
  assert.match(rust, /cli\.to_string_lossy\(\)\.replace\('\\\\', "\/"\)/);
  assert.match(sidecar, /dist", "core"/);
  assert.match(sidecar, /dist", "workbench"/);
});
