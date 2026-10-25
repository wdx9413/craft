import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { createReadStream, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../common/craft-common-store-local/src/paths.ts";
import { legacyRepositoryStoragePreflight } from "../core/legacy-repository-storage-preflight.ts";
import { migrateLegacyRepositoryStorage } from "../core/legacy-repository-storage-migration.ts";

function fixture(): { root: string; project: string; paths: ReturnType<typeof craftPaths>; entry: ReturnType<typeof legacyRepositoryStoragePreflight>["entries"][number] } {
  const root = mkdtempSync(join(tmpdir(), "craft-legacy-repo-migration-"));
  const project = join(root, "project");
  mkdirSync(project);
  const git = spawnSync("git", ["init", "-q", project], { encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  mkdirSync(join(project, ".craft_data", "codebase", "index"), { recursive: true });
  mkdirSync(join(project, ".craft_data", "knowledge"), { recursive: true });
  mkdirSync(join(project, ".craft_data", "custom", "nested"), { recursive: true });
  writeFileSync(join(project, ".craft_data", "codebase", "index", "symbols.json"), "symbols");
  writeFileSync(join(project, ".craft_data", "knowledge", "claim.md"), "claim");
  writeFileSync(join(project, ".craft_data", "custom", "nested", "legacy.json"), "legacy");
  writeFileSync(join(project, ".craft_data", "root.txt"), "root");
  const paths = craftPaths(join(realpathSync(root), "global"));
  const scan = legacyRepositoryStoragePreflight([project], paths);
  assert.equal(scan.entries.length, 1);
  assert.equal(scan.entries[0]!.status, "ready");
  return { root, project, paths, entry: scan.entries[0]! };
}

test("legacy repository migration copies verified files by capability and resumes idempotently", async () => {
  const f = fixture();
  try {
    const result = await migrateLegacyRepositoryStorage(f.paths, f.entry);
    assert.equal(result.status, "migrated");
    assert.equal(result.file_count, 4);
    const project = f.entry.project_directory!;
    const codebase = join(project, "codebase", "legacy-import", result.migration_id, "payload", "index", "symbols.json");
    const knowledge = join(project, "knowledge", "legacy-import", result.migration_id, "payload", "claim.md");
    const context = join(project, "context", "legacy-import", result.migration_id, "payload", "unclassified", "custom", "nested", "legacy.json");
    const rootFile = join(project, "context", "legacy-import", result.migration_id, "payload", "root-files", "root.txt");
    assert.equal(readFileSync(codebase, "utf8"), "symbols");
    assert.equal(readFileSync(knowledge, "utf8"), "claim");
    assert.equal(readFileSync(context, "utf8"), "legacy");
    assert.equal(readFileSync(rootFile, "utf8"), "root");
    assert.equal(lstatSync(codebase).mode & 0o777, 0o600);
    const projectManifest = join(project, "context", "legacy-import", result.migration_id, "manifest.json");
    unlinkSync(projectManifest);
    const resumed = await migrateLegacyRepositoryStorage(f.paths, f.entry);
    assert.equal(resumed.status, "already_migrated");
    assert.equal(readFileSync(projectManifest, "utf8"), readFileSync(result.manifest_path, "utf8"));
    writeFileSync(join(project, "context", "legacy-import", result.migration_id, "payload", "unexpected.txt"), "extra");
    await assert.rejects(migrateLegacyRepositoryStorage(f.paths, f.entry), /migration_target_tree_conflict/u);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("legacy repository migration refuses unbound, changed, linked, and conflicting sources", async () => {
  const f = fixture();
  try {
    await assert.rejects(migrateLegacyRepositoryStorage(f.paths, { ...f.entry, status: "unbound" }), /legacy_source_not_ready/u);
    await assert.rejects(migrateLegacyRepositoryStorage(f.paths, { ...f.entry, project_directory: join(f.root, "wrong") }), /legacy_source_identity_mismatch/u);
    writeFileSync(join(f.project, ".craft_data", "new.txt"), "new");
    await assert.rejects(migrateLegacyRepositoryStorage(f.paths, f.entry), /legacy_source_changed_since_preflight/u);
  } finally { rmSync(f.root, { recursive: true, force: true }); }

  const linked = fixture();
  try {
    const source = join(linked.project, ".craft_data"), moved = join(linked.project, "old-data");
    rmSync(source, { recursive: true });
    mkdirSync(moved);
    symlinkSync(moved, source);
    await assert.rejects(migrateLegacyRepositoryStorage(linked.paths, linked.entry), /legacy_source_unsafe/u);
  } finally { rmSync(linked.root, { recursive: true, force: true }); }
});

test("legacy repository migration rejects source symlinks, target conflicts, and altered receipts", async () => {
  const f = fixture();
  try {
    const linkTarget = join(f.root, "outside.txt"); writeFileSync(linkTarget, "outside");
    symlinkSync(linkTarget, join(f.project, ".craft_data", "linked.txt"));
    await assert.rejects(migrateLegacyRepositoryStorage(f.paths, f.entry), /migration_tree_unsafe/u);
  } finally { rmSync(f.root, { recursive: true, force: true }); }

  const collision = fixture();
  try {
    const first = await migrateLegacyRepositoryStorage(collision.paths, collision.entry);
    const target = join(collision.entry.project_directory!, "knowledge", "legacy-import", first.migration_id, "payload", "claim.md");
    writeFileSync(target, "different");
    await assert.rejects(migrateLegacyRepositoryStorage(collision.paths, collision.entry), /migration_target_conflict/u);
  } finally { rmSync(collision.root, { recursive: true, force: true }); }

  const manifestConflict = fixture();
  try {
    const first = await migrateLegacyRepositoryStorage(manifestConflict.paths, manifestConflict.entry);
    writeFileSync(first.manifest_path, "{}\n");
    await assert.rejects(migrateLegacyRepositoryStorage(manifestConflict.paths, manifestConflict.entry), /migration_manifest_conflict/u);
  } finally { rmSync(manifestConflict.root, { recursive: true, force: true }); }
});

test("legacy repository migration fails closed on unsafe source paths and missing files", async () => {
  const unsafeName = fixture();
  try {
    const directory = join(unsafeName.project, ".craft_data", "custom");
    writeFileSync(join(directory, "..\\escape"), "unsafe path");
    const entry = legacyRepositoryStoragePreflight([unsafeName.project], unsafeName.paths).entries[0]!;
    await assert.rejects(migrateLegacyRepositoryStorage(unsafeName.paths, entry), /migration_relative_path_invalid/u);
  } finally { rmSync(unsafeName.root, { recursive: true, force: true }); }

  const disappeared = fixture();
  try {
    const source = realpathSync(join(disappeared.project, ".craft_data", "knowledge", "claim.md"));
    const original = createReadStream;
    Object.defineProperty(fs, "createReadStream", { configurable: true, value: (path: string, ...args: unknown[]) => {
      const stream = original(path, ...(args as Parameters<typeof createReadStream> extends [unknown, ...infer R] ? R : never));
      if (path === source) stream.once("end", () => unlinkSync(source));
      return stream;
    } });
    syncBuiltinESMExports();
    try { await assert.rejects(migrateLegacyRepositoryStorage(disappeared.paths, disappeared.entry), /migration_source_missing/u); }
    finally { Object.defineProperty(fs, "createReadStream", { configurable: true, value: original }); syncBuiltinESMExports(); }
  } finally { rmSync(disappeared.root, { recursive: true, force: true }); }

  const replaced = fixture();
  try {
    const source = realpathSync(join(replaced.project, ".craft_data", "knowledge", "claim.md")), outside = join(replaced.root, "outside.txt");
    writeFileSync(outside, "outside");
    const original = createReadStream;
    Object.defineProperty(fs, "createReadStream", { configurable: true, value: (path: string, ...args: unknown[]) => {
      const stream = original(path, ...(args as Parameters<typeof createReadStream> extends [unknown, ...infer R] ? R : never));
      if (path === source) stream.once("end", () => { unlinkSync(source); symlinkSync(outside, source); });
      return stream;
    } });
    syncBuiltinESMExports();
    try { await assert.rejects(migrateLegacyRepositoryStorage(replaced.paths, replaced.entry), /migration_tree_unsafe/u); }
    finally { Object.defineProperty(fs, "createReadStream", { configurable: true, value: original }); syncBuiltinESMExports(); }
  } finally { rmSync(replaced.root, { recursive: true, force: true }); }
});

test("legacy repository migration handles concurrent exact target and receipt publication", async () => {
  const f = fixture();
  const original = fs.linkSync;
  const originalCopy = fs.copyFileSync;
  Object.defineProperty(fs, "linkSync", { configurable: true, value: (source: string, target: string) => {
    if (target.endsWith("/claim.md") || target.endsWith("/manifest.json") || target.endsWith(".json")) originalCopy(source, target);
    return original(source, target);
  } });
  syncBuiltinESMExports();
  try {
    const result = await migrateLegacyRepositoryStorage(f.paths, f.entry);
    assert.equal(result.status, "migrated");
  } finally {
    Object.defineProperty(fs, "linkSync", { configurable: true, value: original });
    syncBuiltinESMExports();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("legacy repository migration rejects special files inside an imported target", async () => {
  const f = fixture();
  try {
    const result = await migrateLegacyRepositoryStorage(f.paths, f.entry);
    const fifo = join(f.entry.project_directory!, "context", "legacy-import", result.migration_id, "payload", "unexpected-fifo");
    assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
    await assert.rejects(migrateLegacyRepositoryStorage(f.paths, f.entry), /migration_target_tree_conflict/u);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("legacy repository migration fails closed on injected write, verify, and publication races", async () => {
  const mkdirFailure = fixture();
  const originalMkdir = fs.mkdirSync;
  Object.defineProperty(fs, "mkdirSync", { configurable: true, value: (path: string, ...args: unknown[]) => {
    if (path.endsWith("/legacy-repository-storage")) throw Object.assign(new Error("disk failure"), { code: "EIO" });
    return originalMkdir(path, ...(args as Parameters<typeof fs.mkdirSync> extends [unknown, ...infer R] ? R : never));
  } });
  syncBuiltinESMExports();
  try { await assert.rejects(migrateLegacyRepositoryStorage(mkdirFailure.paths, mkdirFailure.entry), /disk failure/u); }
  finally { Object.defineProperty(fs, "mkdirSync", { configurable: true, value: originalMkdir }); syncBuiltinESMExports(); rmSync(mkdirFailure.root, { recursive: true, force: true }); }

  const linkedPayload = fixture();
  try {
    const result = await migrateLegacyRepositoryStorage(linkedPayload.paths, linkedPayload.entry);
    const payload = join(linkedPayload.entry.project_directory!, "knowledge", "legacy-import", result.migration_id, "payload");
    const outside = join(linkedPayload.root, "outside"); mkdirSync(outside);
    rmSync(payload, { recursive: true }); symlinkSync(outside, payload);
    await assert.rejects(migrateLegacyRepositoryStorage(linkedPayload.paths, linkedPayload.entry), /migration_directory_unsafe/u);
  } finally { rmSync(linkedPayload.root, { recursive: true, force: true }); }

  const fifoSource = fixture();
  try {
    assert.equal(spawnSync("mkfifo", [join(fifoSource.project, ".craft_data", "custom", "special.pipe")]).status, 0);
    await assert.rejects(migrateLegacyRepositoryStorage(fifoSource.paths, { ...fifoSource.entry, status: "ready" }), /migration_tree_unsafe/u);
  } finally { rmSync(fifoSource.root, { recursive: true, force: true }); }

  const missingTarget = fixture();
  const originalLink = fs.linkSync;
  Object.defineProperty(fs, "linkSync", { configurable: true, value: (source: string, target: string) => {
    if (target.endsWith("/claim.md")) throw Object.assign(new Error("racing target"), { code: "EEXIST" });
    return originalLink(source, target);
  } });
  syncBuiltinESMExports();
  try { await assert.rejects(migrateLegacyRepositoryStorage(missingTarget.paths, missingTarget.entry), /migration_target_conflict/u); }
  finally { Object.defineProperty(fs, "linkSync", { configurable: true, value: originalLink }); syncBuiltinESMExports(); rmSync(missingTarget.root, { recursive: true, force: true }); }

  const changedDuringCopy = fixture();
  const originalCopy = fs.copyFileSync;
  Object.defineProperty(fs, "copyFileSync", { configurable: true, value: (source: string, target: string, ...args: unknown[]) => {
    if (source.endsWith("/knowledge/claim.md")) writeFileSync(source, "changed while copying");
    return originalCopy(source, target, ...(args as Parameters<typeof fs.copyFileSync> extends [unknown, unknown, ...infer R] ? R : never));
  } });
  syncBuiltinESMExports();
  try { await assert.rejects(migrateLegacyRepositoryStorage(changedDuringCopy.paths, changedDuringCopy.entry), /migration_source_changed_during_copy/u); }
  finally { Object.defineProperty(fs, "copyFileSync", { configurable: true, value: originalCopy }); syncBuiltinESMExports(); rmSync(changedDuringCopy.root, { recursive: true, force: true }); }

  const copyFailure = fixture();
  Object.defineProperty(fs, "copyFileSync", { configurable: true, value: () => { throw new Error("copy_failed"); } });
  syncBuiltinESMExports();
  try { await assert.rejects(migrateLegacyRepositoryStorage(copyFailure.paths, copyFailure.entry), /copy_failed/u); }
  finally { Object.defineProperty(fs, "copyFileSync", { configurable: true, value: originalCopy }); syncBuiltinESMExports(); rmSync(copyFailure.root, { recursive: true, force: true }); }

  const linkFailure = fixture();
  Object.defineProperty(fs, "linkSync", { configurable: true, value: (source: string, target: string) => {
    if (target.endsWith("/claim.md")) throw Object.assign(new Error("link error"), { code: "EIO" });
    return originalLink(source, target);
  } });
  syncBuiltinESMExports();
  try { await assert.rejects(migrateLegacyRepositoryStorage(linkFailure.paths, linkFailure.entry), /migration_target_conflict/u); }
  finally { Object.defineProperty(fs, "linkSync", { configurable: true, value: originalLink }); syncBuiltinESMExports(); rmSync(linkFailure.root, { recursive: true, force: true }); }

  const deletedTarget = fixture();
  Object.defineProperty(fs, "linkSync", { configurable: true, value: (source: string, target: string) => {
    const result = originalLink(source, target);
    if (target.endsWith("/claim.md")) unlinkSync(target);
    return result;
  } });
  syncBuiltinESMExports();
  try { await assert.rejects(migrateLegacyRepositoryStorage(deletedTarget.paths, deletedTarget.entry), /migration_target_verification_failed/u); }
  finally { Object.defineProperty(fs, "linkSync", { configurable: true, value: originalLink }); syncBuiltinESMExports(); rmSync(deletedTarget.root, { recursive: true, force: true }); }

  const changedReceipt = fixture();
  Object.defineProperty(fs, "linkSync", { configurable: true, value: (source: string, target: string) => {
    if (target.endsWith("/manifest.json")) writeFileSync(target, "{}\n");
    return originalLink(source, target);
  } });
  syncBuiltinESMExports();
  try { await assert.rejects(migrateLegacyRepositoryStorage(changedReceipt.paths, changedReceipt.entry), /migration_manifest_conflict/u); }
  finally { Object.defineProperty(fs, "linkSync", { configurable: true, value: originalLink }); syncBuiltinESMExports(); rmSync(changedReceipt.root, { recursive: true, force: true }); }

  const failedWalk = fixture();
  const originalReadDir = fs.readdirSync;
  Object.defineProperty(fs, "readdirSync", { configurable: true, value: (path: string, ...args: unknown[]) => {
    if (path.includes("/legacy-import/") && path.endsWith("/payload")) throw new Error("payload read denied");
    return originalReadDir(path, ...(args as Parameters<typeof fs.readdirSync> extends [unknown, ...infer R] ? R : never));
  } });
  syncBuiltinESMExports();
  try { await assert.rejects(migrateLegacyRepositoryStorage(failedWalk.paths, failedWalk.entry), /migration_target_tree_conflict/u); }
  finally { Object.defineProperty(fs, "readdirSync", { configurable: true, value: originalReadDir }); syncBuiltinESMExports(); rmSync(failedWalk.root, { recursive: true, force: true }); }

  const symlinkWalk = fixture();
  try {
    const result = await migrateLegacyRepositoryStorage(symlinkWalk.paths, symlinkWalk.entry);
    const payload = join(symlinkWalk.entry.project_directory!, "knowledge", "legacy-import", result.migration_id, "payload");
    const outside = join(symlinkWalk.root, "outside"); writeFileSync(outside, "outside");
    symlinkSync(outside, join(payload, "unexpected-link"));
    await assert.rejects(migrateLegacyRepositoryStorage(symlinkWalk.paths, symlinkWalk.entry), /migration_target_tree_conflict/u);
  } finally { rmSync(symlinkWalk.root, { recursive: true, force: true }); }
});

test("legacy repository migration fails closed when nested target traversal is interrupted", async () => {
  const failedNestedWalk = fixture();
  const originalReadDir = fs.readdirSync;
  Object.defineProperty(fs, "readdirSync", { configurable: true, value: (path: string, ...args: unknown[]) => {
    if (path.endsWith("/payload/unclassified/custom")) throw new Error("nested directory unavailable");
    return originalReadDir(path, ...(args as Parameters<typeof fs.readdirSync> extends [unknown, ...infer R] ? R : never));
  } });
  syncBuiltinESMExports();
  try { await assert.rejects(migrateLegacyRepositoryStorage(failedNestedWalk.paths, failedNestedWalk.entry), /migration_target_tree_conflict/u); }
  finally { Object.defineProperty(fs, "readdirSync", { configurable: true, value: originalReadDir }); syncBuiltinESMExports(); rmSync(failedNestedWalk.root, { recursive: true, force: true }); }

  const failedStatWalk = fixture();
  const originalLstat = fs.lstatSync;
  let targetReads = 0;
  Object.defineProperty(fs, "lstatSync", { configurable: true, value: (path: string, ...args: unknown[]) => {
    if (path.includes("/payload/") && path.endsWith("/claim.md") && ++targetReads === 2) throw new Error("target changed during readback");
    return originalLstat(path, ...(args as Parameters<typeof fs.lstatSync> extends [unknown, ...infer R] ? R : never));
  } });
  syncBuiltinESMExports();
  try { await assert.rejects(migrateLegacyRepositoryStorage(failedStatWalk.paths, failedStatWalk.entry), /migration_target_tree_conflict/u); }
  finally { Object.defineProperty(fs, "lstatSync", { configurable: true, value: originalLstat }); syncBuiltinESMExports(); rmSync(failedStatWalk.root, { recursive: true, force: true }); }
});
