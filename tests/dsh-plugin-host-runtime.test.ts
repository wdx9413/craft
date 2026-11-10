import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { defaultSettings } from "../core/settings.ts";
import { DshPluginHostRuntime, DSH_CORDIS_ADAPTER_ID } from "../core/dsh-plugin-host-runtime.ts";

test("DSH plugin host creates an isolated profile and preserves installed plugins", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-dsh-host-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const desktop = join(root, "DSH Desktop");
    const resources = join(desktop, "resources");
    const entry = join(resources, "app.asar", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
    await mkdir(join(resources, "app.asar", "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true });
    await writeFile(join(desktop, "DSH Desktop.exe"), "fixture");
    await writeFile(join(resources, "harness-node-entry.mjs"), "fixture");
    await writeFile(entry, "fixture");
    const dshHome = join(root, "dsh-home");
    const settings = defaultSettings(craftPaths(join(root, "data")));
    settings.workbench.dshExecutable = join(desktop, "DSH Desktop.exe");
    settings.workbench.dshHome = dshHome;
    settings.workbench.dshEntryPath = entry;
    const runtime = new DshPluginHostRuntime(store, () => settings, (async () => ({ stdout: "", stderr: "" })) as never);
    const status = runtime.status();
    assert.equal(status.status, "available");
    const ensured = await runtime.ensureProfile();
    assert.equal(ensured.profile, "craft-plugin-host");
    const profilePath = join(dshHome, "profiles", "craft-plugin-host", "package.json");
    const first = JSON.parse(await readFile(profilePath, "utf8")) as Record<string, unknown>;
    assert.equal((first.dependencies as Record<string, string>)["craft-dsh-plugin-host"].startsWith("link:"), true);
    await writeFile(profilePath, JSON.stringify({ ...first, dependencies: { ...(first.dependencies as Record<string, string>), "dsh-example": "1.0.0" } }));
    await runtime.ensureProfile();
    const second = JSON.parse(await readFile(profilePath, "utf8")) as Record<string, unknown>;
    assert.equal((second.dependencies as Record<string, string>)["dsh-example"], "1.0.0");
    const adapter = store.get("adapter_manifest", DSH_CORDIS_ADAPTER_ID);
    assert.equal(adapter.kind, "mcp");
    assert.equal((adapter.metadata as Record<string, unknown>).runtime, "dsh-cordis");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
