import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { assertStorageAvailable, ensureOwnedLayoutFence, hasSharedWriterFence, initializeOwnedCatalog, catalogOwner } from "../core/infrastructure/owned-catalog.ts";
import { openCapabilityService } from "../core/interfaces/mcp/runtime.ts";

test("startup rejects maintenance locks before creating or opening an active root", async () => {
  const parent = mkdtempSync(join(tmpdir(), "craft-maintenance-")), root = join(parent, "active"), lock = `${root}.craft-cutover.lock`;
  try {
    assertStorageAvailable(root);
    for (const value of ["invalid", "null", "1", "{}", '{"pid":1}', '{"token":"x"}', '{"pid":1.5,"token":"x"}', '{"pid":1,"token":2}', '{"pid":1,"token":""}', "x".repeat(1025)]) {
      writeFileSync(lock, value);
      assert.throws(() => assertStorageAvailable(root), /lock is invalid/u);
    }
    writeFileSync(lock, JSON.stringify({ pid: process.pid + 1, token: "maintenance" }));
    await assert.rejects(openCapabilityService("notes", { CRAFT_DATA_DIR: root }), /under maintenance/u);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "maintenance" }));
    assertStorageAvailable(root);
    unlinkSync(lock); mkdirSync(lock); assert.throws(() => assertStorageAvailable(root), /invalid/u); rmSync(lock, { recursive: true });
    writeFileSync(join(parent, "target"), "{}"); symlinkSync(join(parent, "target"), lock);
    assert.throws(() => assertStorageAvailable(root), /invalid/u);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("owner fence validates marker, every tombstone and import identity without overwriting foreign data", async () => {
  const parent = mkdtempSync(join(tmpdir(), "craft-fence-safety-"));
  const run = (label: string, prepare: (root: string) => void) => { const root = join(parent, label); mkdirSync(root); prepare(root); return root; };
  try {
    const empty = run("empty", () => {}); assert.equal(hasSharedWriterFence(empty), false);
    const invalid = run("invalid", root => writeFileSync(join(root, ".craft-storage-layout.json"), "{}"));
    assert.equal(hasSharedWriterFence(invalid), false); assert.throws(() => ensureOwnedLayoutFence(invalid), /invalid/u);
    const directory = run("directory", root => mkdirSync(join(root, ".craft-storage-layout.json")));
    assert.equal(hasSharedWriterFence(directory), false); assert.throws(() => ensureOwnedLayoutFence(directory), /invalid/u);
    const shared = run("shared", root => writeFileSync(join(root, "craft.db"), "old")); assert.throws(() => ensureOwnedLayoutFence(shared), /migrated/u);
    const fenced = run("fenced", root => ensureOwnedLayoutFence(root)); assert(hasSharedWriterFence(fenced)); ensureOwnedLayoutFence(fenced);
    const tombstone = join(fenced, "db", "craft.db", ".craft-write-fence"); unlinkSync(tombstone); mkdirSync(tombstone);
    assert.equal(hasSharedWriterFence(fenced), false); assert.throws(() => ensureOwnedLayoutFence(fenced), /invalid/u);
    rmSync(tombstone, { recursive: true }); writeFileSync(tombstone, "foreign");
    assert.equal(hasSharedWriterFence(fenced), false); assert.throws(() => ensureOwnedLayoutFence(fenced), /invalid/u);
    for (const [name, imported] of [["missing-import", undefined], ["wrong-import", "other"], ["correct-import", "digest"]] as const) {
      const root = run(name, root => {
        writeFileSync(join(root, ".craft-storage-layout.json"), JSON.stringify({ schema: "craft.owner-cutover.v1", archive_digest: "digest" }));
        if (imported) writeFileSync(join(root, ".craft-history-import"), imported);
      });
      if (imported === "digest") { ensureOwnedLayoutFence(root); assert(hasSharedWriterFence(root)); }
      else { assert.equal(hasSharedWriterFence(root), false); assert.throws(() => ensureOwnedLayoutFence(root), /invalid/u); }
    }
    initializeOwnedCatalog(empty, "notes"); assert.equal(catalogOwner(join(empty, "notes")), "notes"); initializeOwnedCatalog(empty, "notes");
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("startup can finish a fresh directory fence created before the first owner catalog", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-first-owner-recovery-"));
  try { ensureOwnedLayoutFence(root); const runtime = await openCapabilityService("notes", { CRAFT_DATA_DIR: root }); runtime.close(); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("atomic fence publication accepts only a matching race winner and propagates storage errors", async () => {
  const { default: fs } = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const parent = mkdtempSync(join(tmpdir(), "craft-fence-publication-"));
  const originalLink = fs.linkSync, originalWrite = fs.writeFileSync;
  const failure = (code: string) => Object.assign(new Error("Synthetic filesystem failure"), { code });
  try {
    const raced = join(parent, "race");
    fs.linkSync = ((source, target) => { originalLink(source, target); throw failure("EEXIST"); }) as typeof fs.linkSync;
    syncBuiltinESMExports(); ensureOwnedLayoutFence(raced); assert(hasSharedWriterFence(raced));
    fs.linkSync = (() => { throw failure("EIO"); }) as typeof fs.linkSync;
    syncBuiltinESMExports(); assert.throws(() => ensureOwnedLayoutFence(join(parent, "link-error")), /filesystem failure/u);
    fs.linkSync = originalLink;
    fs.writeFileSync = ((file, ...args) => {
      if (String(file).endsWith(".craft-write-fence")) { originalWrite(file, ...args); throw failure("EEXIST"); }
      return originalWrite(file, ...args);
    }) as typeof fs.writeFileSync;
    syncBuiltinESMExports(); const fenceRace = join(parent, "fence-race"); ensureOwnedLayoutFence(fenceRace); assert(hasSharedWriterFence(fenceRace));
    fs.writeFileSync = ((file, ...args) => { if (String(file).endsWith(".craft-write-fence")) throw failure("EIO"); return originalWrite(file, ...args); }) as typeof fs.writeFileSync;
    syncBuiltinESMExports(); assert.throws(() => ensureOwnedLayoutFence(join(parent, "write-error")), /filesystem failure/u);
  } finally { fs.linkSync = originalLink; fs.writeFileSync = originalWrite; syncBuiltinESMExports(); rmSync(parent, { recursive: true, force: true }); }
});
