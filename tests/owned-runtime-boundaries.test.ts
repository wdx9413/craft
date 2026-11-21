import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, lstatSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openCapabilityService, openMcpRuntime } from "../core/interfaces/mcp/runtime.ts";
import { mcpStorageLaunch } from "../core/interfaces/mcp/owned-storage.ts";
import { CraftService } from "../core/application/craft-service.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { ContextReadGuard } from "../core/context-access-guard.ts";

test("owned launch rejects foreign markers and either legacy shared database location", () => {
  const parent = mkdtempSync(join(tmpdir(), "craft-owned-launch-boundaries-"));
  try {
    const rootMarker = join(parent, "root-marker"); mkdirSync(rootMarker);
    writeFileSync(join(rootMarker, ".craft-storage-owner"), "v1:memory\n");
    assert.throws(() => mcpStorageLaunch(craftPaths(rootMarker), "full", undefined), /requires an owned data space/u);
    assert.throws(() => mcpStorageLaunch(craftPaths(rootMarker), "component-knowledge-daily", "knowledge"), /different product/u);
    const catalogMarker = join(parent, "catalog-marker"); mkdirSync(join(catalogMarker, "knowledge"), { recursive: true });
    writeFileSync(join(catalogMarker, "knowledge", ".craft-storage-owner"), "v1:memory\n");
    assert.throws(() => mcpStorageLaunch(craftPaths(catalogMarker), "component-knowledge-daily", "knowledge"), /different owner/u);
    const unclaimed = craftPaths(join(parent, "unclaimed"));
    assert.throws(() => mcpStorageLaunch(unclaimed, "full", "unknown"), /matching standalone/u);
    assert.throws(() => mcpStorageLaunch(unclaimed, "full", "knowledge"), /matching standalone/u);
    assert.throws(() => mcpStorageLaunch(unclaimed, "wrong", "runtime"), /matching standalone/u);
    assert.throws(() => mcpStorageLaunch(unclaimed, "component-knowledge-owned", undefined), /requires an owned data space/u);
    const rootOwned = join(parent, "root-owned"); mkdirSync(join(rootOwned, "knowledge"), { recursive: true });
    writeFileSync(join(rootOwned, ".craft-storage-owner"), "v1:knowledge\n"); writeFileSync(join(rootOwned, "knowledge", "publication.db"), "");
    assert.equal(mcpStorageLaunch(craftPaths(rootOwned), "component-knowledge-daily", "knowledge").initializeOwner, undefined);
    const nonempty = join(parent, "nonempty"); mkdirSync(nonempty); writeFileSync(join(nonempty, "foreign"), "kept");
    assert.throws(() => mcpStorageLaunch(craftPaths(nonempty), "component-knowledge-daily", "knowledge"), /new, empty/u);
    const regular = join(parent, "regular"); mkdirSync(regular);
    const linked = join(parent, "linked"); symlinkSync(regular, linked);
    assert.throws(() => mcpStorageLaunch(craftPaths(linked), "component-knowledge-daily", "knowledge"), /regular directory/u);
    const foreignDirectory = join(parent, "foreign-directory"); mkdirSync(foreignDirectory); symlinkSync(regular, join(foreignDirectory, "knowledge"));
    assert.throws(() => mcpStorageLaunch(craftPaths(foreignDirectory), "component-knowledge-daily", "knowledge"), /regular directory/u);
    const catalogDirectory = join(parent, "catalog-directory"); mkdirSync(join(catalogDirectory, "knowledge", "publication.db"), { recursive: true });
    assert.throws(() => mcpStorageLaunch(craftPaths(catalogDirectory), "component-knowledge-daily", "knowledge"), /regular directory/u);
    const noMarker = join(parent, "no-marker"); mkdirSync(join(noMarker, "knowledge"), { recursive: true }); writeFileSync(join(noMarker, "knowledge", "publication.db"), "");
    assert.throws(() => mcpStorageLaunch(craftPaths(noMarker), "component-knowledge-daily", "knowledge"), /no storage owner marker/u);
    const noCatalog = join(parent, "no-catalog"); mkdirSync(join(noCatalog, "knowledge"), { recursive: true }); writeFileSync(join(noCatalog, "knowledge", ".craft-storage-owner"), "v1:knowledge\n");
    assert.throws(() => mcpStorageLaunch(craftPaths(noCatalog), "component-knowledge-daily", "knowledge"), /catalog is missing/u);
    assert.equal(mcpStorageLaunch(craftPaths(join(parent, "runtime-syscall")), "syscall", "runtime").mode, "syscall");
    for (const location of ["databaseFile", "legacyDatabaseFile"] as const) {
      const root = join(parent, location), paths = craftPaths(root); mkdirSync(paths.databaseDir, { recursive: true });
      writeFileSync(paths[location], "legacy SQLite placeholder");
      assert.throws(() => mcpStorageLaunch(paths, "component-knowledge-daily", "knowledge"), /verified migration/u);
    }
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("full and syscall retain legacy shared data and use owned defaults only on a fresh root", async () => {
  const parent = mkdtempSync(join(tmpdir(), "craft-runtime-legacy-boundaries-"));
  try {
    for (const [mode, oldLocation] of [["full", false], ["syscall", true]] as const) {
      const root = join(parent, mode), paths = craftPaths(root);
      const store = await new CraftStore(paths).open(); store.create("fixture", "retained", { source: "legacy" }); store.close();
      if (oldLocation) {
        renameSync(paths.databaseFile, paths.legacyDatabaseFile);
        const original = new DatabaseSync(paths.legacyDatabaseFile, { readOnly: true });
        try { assert.equal(original.prepare("SELECT count(*) count FROM records WHERE kind='fixture' AND id='retained'").get()!.count, 1); }
        finally { original.close(); }
      }
      const runtime = await openMcpRuntime(mode, { CRAFT_DATA_DIR: root });
      try {
        assert.equal(runtime.server.service.capabilityOwned, false);
        assert.equal(runtime.server.service.store.get("fixture", "retained").source, "legacy", mode);
        if (oldLocation) assert.equal(lstatSync(paths.databaseFile, { throwIfNoEntry: false })?.isFile(), undefined);
        const guard = new ContextReadGuard(runtime.server.service.store); guard.contribution("external", {}); guard.assertCurrent(); assert.deepEqual(guard.refs(), []);
      } finally { runtime.close(); }
    }

  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("fresh full runtime composes all defaults while explicit empty Context stays independent", async () => {
  const parent = mkdtempSync(join(tmpdir(), "craft-runtime-default-boundaries-"));
  try {
    const root = join(parent, "fresh-full"), runtime = await openMcpRuntime("full", { CRAFT_DATA_DIR: root });
    try { assert.equal(runtime.server.service.storageOwner, "runtime"); assert.equal(runtime.server.service.ownerServices.size, 8); assert.equal(runtime.server.service.evaluationContracts.store, runtime.server.service.ownerServices.get("eval")!.store); }
    finally { runtime.close(); }
    const context = await openMcpRuntime("component-context-agent", { CRAFT_DATA_DIR: join(parent, "explicit-empty"), CRAFT_CONTEXT_MEMBERS: "" });
    try { assert.equal(context.server.service.ownerServices.size, 1); assert.throws(() => context.server.service.evolutionProgramMemoryExperienceSubmit({}), /experience owner is unavailable/u); }
    finally { context.close(); }
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("startup rejects invalid member lists and closes primary and peer stores on service assembly failure", async t => {
  const parent = mkdtempSync(join(tmpdir(), "craft-runtime-close-boundaries-"));
  try {
    for (const members of ["memory,memory", "unknown"]) await assert.rejects(openMcpRuntime("component-context-agent", { CRAFT_DATA_DIR: join(parent, members), CRAFT_CONTEXT_MEMBERS: members }), /unique owned capabilities/u);
    const root = join(parent, "assembly");
    for (const owner of ["knowledge", "eval"]) { const runtime = await openCapabilityService(owner, { CRAFT_DATA_DIR: root }); runtime.close(); }
    const closed: string[] = [], originalClose = CraftStore.prototype.close;
    t.mock.method(CraftStore.prototype, "close", function (this: CraftStore) { closed.push(this.paths.databaseFile); return originalClose.call(this); });
    t.mock.method(CraftService, "open", async () => { throw new Error("Synthetic service assembly failure"); });
    await assert.rejects(openCapabilityService("runtime", { CRAFT_DATA_DIR: root }), /assembly failure/u);
    assert.equal(new Set(closed).size, 3);
    t.mock.restoreAll();
    const runtime = await openCapabilityService("runtime", { CRAFT_DATA_DIR: root }); runtime.close();
    const constructorClosed: string[] = [];
    t.mock.method(CraftStore.prototype, "close", function (this: CraftStore) { constructorClosed.push(this.paths.databaseFile); return originalClose.call(this); });
    await assert.rejects(openMcpRuntime("unknown-surface", { CRAFT_DATA_DIR: join(parent, "unknown-surface") }), /Unknown Craft MCP surface/u);
    assert.equal(constructorClosed.length, 1);
  } finally { t.mock.restoreAll(); rmSync(parent, { recursive: true, force: true }); }
});
