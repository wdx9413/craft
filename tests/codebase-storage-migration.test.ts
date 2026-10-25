import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { craftPaths, projectStorageDirectory } from "../common/craft-common-store-local/src/paths.ts";
import { CraftStore } from "../common/craft-common-store-local/src/store.ts";
import { migrateCodebaseSnapshots } from "../core/codebase-storage-migration.ts";
import type { CodebaseMigrationEntry } from "../core/codebase-storage-preflight.ts";

async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "craft-snapshot-migration-"));
  const project = join(root, "project"), paths = craftPaths(join(root, "data"));
  mkdirSync(project);
  const store = await new CraftStore(paths).open({ skipLegacyPartitionMigration: true });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const source = join(project, ".craft_data", "codebase", "snapshots", "repo", "snapshot");
  mkdirSync(join(source, "src"), { recursive: true });
  mkdirSync(join(source, "empty"));
  const content = "export const value = 1;\n", file = join(source, "src", "a.ts");
  writeFileSync(file, content);
  const payload = { workspace_id: "repo", state_revision: 1, snapshot_root: source,
    entries: [{ path: "src/a.ts", digest: createHash("sha256").update(content).digest("hex"), size_bytes: Buffer.byteLength(content) }] };
  const put = (kind: string, id: string, value: unknown) => store.database.prepare(
    "INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,1,?,'now','now')",
  ).run(kind, id, JSON.stringify(value));
  put("workspace", "repo", { root_path: project, state_revision: 1 });
  put("workspace_checkpoint", "snapshot", payload);
  const entry: CodebaseMigrationEntry = { id: "snapshot", version: 1, status: "legacy_ready", workspace_id: "repo",
    source_root: source, target_root: join(projectStorageDirectory(paths, project), "codebase", "snapshots", "repo", "snapshot"), entry_count: 1 };
  const setPayload = (value: unknown) => store.database.prepare("UPDATE records SET payload_json=? WHERE kind='workspace_checkpoint' AND id='snapshot'")
    .run(JSON.stringify(value));
  return { root, project, paths, store, source, file, content, payload, entry, put, setPayload };
}

test("snapshot migration rejects unsafe identities, stale bindings and out-of-scope sources", async t => {
  const f = await fixture(t);
  assert.equal((await migrateCodebaseSnapshots(f.store, [])).backup_directory, null);
  await assert.rejects(migrateCodebaseSnapshots(f.store, Array.from({ length: 501 }, () => f.entry)), /page is too large/u);
  await assert.rejects(migrateCodebaseSnapshots(f.store, [{ ...f.entry, status: "missing_root" }]), /requires ready/u);
  for (const item of [{ ...f.entry, id: "../escape" }, { ...f.entry, version: 0 }, { ...f.entry, workspace_id: "../repo" }, { ...f.entry, id: "missing" }]) {
    const result = await migrateCodebaseSnapshots(f.store, [item]);
    assert.match(result.blocked[0]!.reason, /checkpoint_identity_invalid|workspace_id_invalid|checkpoint_missing/u);
  }
  writeFileSync(f.file, "changed");
  const initial = await migrateCodebaseSnapshots(f.store, [f.entry]);
  assert.equal(initial.blocked[0]!.reason, "source_size_changed");
  const options = { backup_directory: initial.backup_directory! };
  f.setPayload({ ...f.payload, snapshot_root: join(f.root, "foreign") });
  await assert.rejects(migrateCodebaseSnapshots(f.store, [f.entry], options), /differs from its backup/u);
  assert.equal((await migrateCodebaseSnapshots(f.store, [f.entry])).blocked[0]!.reason, "checkpoint_changed");
  f.setPayload({ ...f.payload, state_revision: 99 });
  assert.equal((await migrateCodebaseSnapshots(f.store, [f.entry])).blocked[0]!.reason, "project_root_changed_or_missing");
  f.setPayload(f.payload);
  assert.equal((await migrateCodebaseSnapshots(f.store, [{ ...f.entry, target_root: join(f.root, "wrong") }], options)).blocked[0]!.reason, "project_mapping_changed");
  const foreign = join(f.root, "foreign"); mkdirSync(foreign);
  f.setPayload({ ...f.payload, snapshot_root: foreign });
  assert.equal((await migrateCodebaseSnapshots(f.store, [{ ...f.entry, source_root: foreign }])).blocked[0]!.reason, "source_snapshot_out_of_scope");
  f.setPayload(f.payload);
  const moved = `${f.source}-moved`; renameSync(f.source, moved); symlinkSync(moved, f.source);
  assert.equal((await migrateCodebaseSnapshots(f.store, [f.entry], options)).blocked[0]!.reason, "source_snapshot_unsafe");
  unlinkSync(f.source); renameSync(moved, f.source);
  writeFileSync(f.file, f.content);
  const completed = await migrateCodebaseSnapshots(f.store, [f.entry], options);
  assert.equal(completed.migrated, 1);
  assert.equal(readFileSync(join(f.entry.target_root!, "src", "a.ts"), "utf8"), f.content);
});

test("snapshot migration refuses invalid trees and portable path escapes before publishing pointers", async t => {
  const f = await fixture(t);
  writeFileSync(f.file, "changed");
  const initial = await migrateCodebaseSnapshots(f.store, [f.entry]);
  const options = { backup_directory: initial.backup_directory! };
  writeFileSync(f.file, f.content);
  const link = join(f.source, "link"); symlinkSync(f.file, link);
  assert.equal((await migrateCodebaseSnapshots(f.store, [f.entry], options)).blocked[0]!.reason, "source_snapshot_unsafe");
  rmSync(link);
  if (process.platform !== "win32") {
    const fifo = join(f.source, "pipe"); execFileSync("mkfifo", [fifo]);
    assert.equal((await migrateCodebaseSnapshots(f.store, [f.entry], options)).blocked[0]!.reason, "source_snapshot_unsafe");
    rmSync(fifo);
  }
  for (const [path, reason] of [["..\\escape.ts", "Codebase snapshot entry path is unsafe"],
    ["ordinary\\file.ts", "Codebase snapshot entry is not a regular file"]]) {
    const raw = join(f.source, path!); writeFileSync(raw, f.content);
    if (path!.startsWith("ordinary")) writeFileSync(join(f.source, "ordinary"), f.content);
    const entries = [{ ...f.payload.entries[0]!, path: path! }, ...f.payload.entries];
    if (path!.startsWith("ordinary")) entries.push({ ...f.payload.entries[0]!, path: "ordinary" });
    f.setPayload({ ...f.payload, entries });
    assert.equal((await migrateCodebaseSnapshots(f.store, [f.entry])).blocked[0]!.reason, reason);
    rmSync(raw); rmSync(join(f.source, "ordinary"), { force: true });
  }
  f.setPayload(f.payload);
  mkdirSync(join(f.entry.target_root!, "src"), { recursive: true });
  writeFileSync(join(f.entry.target_root!, "src", "a.ts"), "wrong target");
  assert.equal((await migrateCodebaseSnapshots(f.store, [f.entry], options)).blocked[0]!.reason, "target_digest_conflict");
  const pointer = JSON.parse((f.store.database.prepare("SELECT payload_json FROM records WHERE kind='workspace_checkpoint' AND id='snapshot'").get() as { payload_json: string }).payload_json);
  assert.equal(pointer.snapshot_root, f.source);
});

test("snapshot migration verifies resumed scoped backups and detects backup integrity failures", async t => {
  const f = await fixture(t);
  writeFileSync(f.file, "changed");
  const initial = await migrateCodebaseSnapshots(f.store, [f.entry]);
  const directory = initial.backup_directory!, manifestPath = join(directory, "manifest.json"), raw = readFileSync(manifestPath, "utf8");
  const backupManifest = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(backupManifest.backup_scope, "checkpoint_rows");
  assert(fs.statSync(join(directory, "craft.db")).size < 100_000, "migration backup should contain only the exact checkpoint rows being changed");
  const backupDb = new DatabaseSync(join(directory, "craft.db"), { readOnly: true });
  try {
    assert.equal(Number((backupDb.prepare("SELECT COUNT(*) n FROM records").get() as { n: number }).n), 1);
    assert.equal((backupDb.prepare("SELECT payload_json FROM records WHERE kind='workspace_checkpoint' AND id='snapshot' AND version=1").get() as { payload_json: string }).payload_json, JSON.stringify(f.payload));
  } finally { backupDb.close(); }
  await assert.rejects(migrateCodebaseSnapshots(f.store, [f.entry], { backup_directory: f.root }), /outside its data root/u);
  writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(raw), checkpoint_ids: [] }));
  await assert.rejects(migrateCodebaseSnapshots(f.store, [f.entry], { backup_directory: directory }), /identity does not match/u);
  writeFileSync(manifestPath, raw);
  const saved = `${manifestPath}.saved`; renameSync(manifestPath, saved); symlinkSync(saved, manifestPath);
  await assert.rejects(migrateCodebaseSnapshots(f.store, [f.entry], { backup_directory: directory }), /backup is unsafe/u);
  rmSync(manifestPath); renameSync(saved, manifestPath);
  const corruptSchema = (database: DatabaseSync & { enableDefensive?: (enabled: boolean) => void }) => {
    database.enableDefensive?.(false);
    database.exec("CREATE TABLE invalid_check(value INTEGER); INSERT INTO invalid_check VALUES(NULL); PRAGMA writable_schema=ON; UPDATE sqlite_schema SET sql='CREATE TABLE invalid_check(value INTEGER NOT NULL)' WHERE name='invalid_check'; PRAGMA writable_schema=OFF;");
  };
  const damagedBackup = new DatabaseSync(join(directory, "craft.db"));
  try { corruptSchema(damagedBackup); } finally { damagedBackup.close(); }
  await assert.rejects(migrateCodebaseSnapshots(f.store, [f.entry], { backup_directory: directory }), /integrity check/u);
});

test("snapshot migration rejects a newly created backup that fails integrity validation", async t => {
  const f = await fixture(t), prepare = DatabaseSync.prototype.prepare;
  const mocked = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, query: string, ...values: unknown[]) {
    if (query === "PRAGMA quick_check") return { get: () => ({ quick_check: "corrupt" }) } as never;
    return Reflect.apply(prepare, this, [query, ...values]);
  });
  try { await assert.rejects(migrateCodebaseSnapshots(f.store, [f.entry]), /backup failed integrity check/u); }
  finally { mocked.mock.restore(); }
});

test("snapshot pointer writes retry transient database locks and stop on persistent or unrelated failures", async t => {
  const injectCasFailure = (remaining: number, message: string) => {
    const prepare = DatabaseSync.prototype.prepare; let calls = 0;
    const mocked = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, query: string, ...values: unknown[]) {
      const statement = Reflect.apply(prepare, this, [query, ...values]);
      if (!query.startsWith("UPDATE records SET payload_json=? WHERE kind='workspace_checkpoint'")) return statement;
      return { run: (...args: unknown[]) => {
        calls++;
        if (calls <= remaining) throw new Error(message);
        return Reflect.apply(statement.run, statement, args);
      } } as never;
    });
    return { get calls() { return calls; }, restore: () => mocked.mock.restore() };
  };
  const recovered = await fixture(t);
  const oneLock = injectCasFailure(1, "database is locked");
  try {
    const result = await migrateCodebaseSnapshots(recovered.store, [recovered.entry]);
    assert.equal(result.migrated, 1); assert.deepEqual(result.blocked, []); assert.equal(oneLock.calls, 2);
  } finally { oneLock.restore(); }

  const persistent = await fixture(t);
  const locks = injectCasFailure(10, "SQLITE_BUSY");
  try {
    const result = await migrateCodebaseSnapshots(persistent.store, [persistent.entry]);
    assert.equal(result.migrated, 0); assert.equal(result.blocked[0]!.reason, "SQLITE_BUSY"); assert.equal(locks.calls, 3);
  } finally { locks.restore(); }

  const unrelated = await fixture(t);
  const ioFailure = injectCasFailure(1, "disk I/O error");
  try {
    const result = await migrateCodebaseSnapshots(unrelated.store, [unrelated.entry]);
    assert.equal(result.migrated, 0); assert.equal(result.blocked[0]!.reason, "disk I/O error"); assert.equal(ioFailure.calls, 1);
  } finally { ioFailure.restore(); }
});

test("snapshot pointer CAS distinguishes a matching concurrent winner from a conflicting update", async t => {
  const f = await fixture(t);
  writeFileSync(f.file, "changed");
  const initial = await migrateCodebaseSnapshots(f.store, [f.entry]);
  writeFileSync(f.file, f.content);
  const options = { backup_directory: initial.backup_directory! };
  f.store.database.exec(`CREATE TRIGGER concurrent_winner BEFORE UPDATE ON records WHEN OLD.kind='workspace_checkpoint'
    BEGIN UPDATE records SET payload_json=NEW.payload_json WHERE kind=OLD.kind AND id=OLD.id AND version=OLD.version; SELECT RAISE(IGNORE); END;`);
  const winner = await migrateCodebaseSnapshots(f.store, [f.entry], options);
  assert.equal(winner.already_current, 1); assert.equal(winner.migrated, 0); assert.deepEqual(winner.blocked, []);
  f.store.database.exec("DROP TRIGGER concurrent_winner;");
  f.setPayload(f.payload);
  f.store.database.exec(`CREATE TRIGGER concurrent_conflict BEFORE UPDATE ON records WHEN OLD.kind='workspace_checkpoint'
    BEGIN UPDATE records SET payload_json=json_set(OLD.payload_json,'$.conflict',1) WHERE kind=OLD.kind AND id=OLD.id AND version=OLD.version; SELECT RAISE(IGNORE); END;`);
  const conflict = await migrateCodebaseSnapshots(f.store, [f.entry], options);
  assert.equal(conflict.blocked[0]!.reason, "checkpoint_changed_concurrently");
});

test("snapshot recovery ignores malformed and out-of-scope peers and verifies an exact same-project copy", async t => {
  const f = await fixture(t);
  const raw = (kind: string, id: string, version: number, payload: string) => f.store.database.prepare(
    "INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,'now','now')",
  ).run(kind, id, version, payload);
  raw("workspace", "repo", 2, "{");
  raw("workspace", "repo", 3, JSON.stringify({ root_path: join(f.root, "gone"), state_revision: 2 }));
  raw("workspace_checkpoint", "../invalid-peer", 1, JSON.stringify(f.payload));
  raw("workspace_checkpoint", "A-invalid-json", 1, "{");
  raw("workspace_checkpoint", "B-no-root", 1, JSON.stringify({ ...f.payload, snapshot_root: 42 }));
  raw("workspace_checkpoint", "C-outside", 1, JSON.stringify({ ...f.payload, snapshot_root: f.project }));
  raw("workspace_checkpoint", "D-missing-file", 1, JSON.stringify({ ...f.payload,
    snapshot_root: join(projectStorageDirectory(f.paths, f.project), "codebase", "snapshots", "repo", "D-missing-file") }));
  const peer = join(projectStorageDirectory(f.paths, f.project), "codebase", "snapshots", "repo", "E-good");
  mkdirSync(join(peer, "src"), { recursive: true }); writeFileSync(join(peer, "src", "a.ts"), f.content);
  raw("workspace_checkpoint", "E-good", 1, JSON.stringify({ ...f.payload, snapshot_root: peer, entries: [null, ...f.payload.entries] }));
  writeFileSync(f.file, "damaged");
  const result = await migrateCodebaseSnapshots(f.store, [f.entry], { recover_verified_peer: true });
  assert.equal(result.migrated, 1);
  assert.equal(result.recovered[0]!.from_checkpoint_id, "E-good");
});

test("snapshot migration fails closed for unsafe backup trees, invalid manifests and unavailable Git", async t => {
  const f = await fixture(t);
  const backupRoot = join(f.paths.backupsDir, "codebase-storage-migration");
  const mkdir = fs.mkdirSync;
  const denied = t.mock.method(fs, "mkdirSync", (...args: Parameters<typeof fs.mkdirSync>) => {
    if (String(args[0]) === backupRoot) throw Object.assign(new Error("backup directory denied"), { code: "EACCES" });
    return Reflect.apply(mkdir, fs, args);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(migrateCodebaseSnapshots(f.store, [f.entry]), /backup directory denied/u); }
  finally { denied.mock.restore(); syncBuiltinESMExports(); }
  const saved = `${f.paths.backupsDir}.saved`; renameSync(f.paths.backupsDir, saved); symlinkSync(saved, f.paths.backupsDir);
  await assert.rejects(migrateCodebaseSnapshots(f.store, [f.entry]), /backup path is unsafe/u);
  unlinkSync(f.paths.backupsDir); renameSync(saved, f.paths.backupsDir);
  mkdirSync(backupRoot); const movedRoot = `${backupRoot}-saved`; renameSync(backupRoot, movedRoot); symlinkSync(movedRoot, backupRoot);
  await assert.rejects(migrateCodebaseSnapshots(f.store, [f.entry]), /directory is unsafe/u);
  unlinkSync(backupRoot); renameSync(movedRoot, backupRoot);
  f.setPayload({ ...f.payload, entries: [{ ...f.payload.entries[0], size_bytes: -1 }] });
  assert.equal((await migrateCodebaseSnapshots(f.store, [f.entry])).blocked[0]!.reason, "entry_invalid");
  f.setPayload(f.payload); writeFileSync(f.file, "damaged");
  const initial = await migrateCodebaseSnapshots(f.store, [f.entry]);
  const manifestPath = join(initial.backup_directory!, "manifest.json"), manifest = readFileSync(manifestPath, "utf8");
  writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(manifest), checkpoint_ids: null }));
  await assert.rejects(migrateCodebaseSnapshots(f.store, [f.entry], { backup_directory: initial.backup_directory! }), /identity does not match/u);
  writeFileSync(manifestPath, manifest);
  const originalPath = process.env.PATH; process.env.PATH = "";
  try {
    const progress: number[] = [];
    const unavailable = await migrateCodebaseSnapshots(f.store, [f.entry], { backup_directory: initial.backup_directory!,
      recover_verified_peer: true, on_progress: (processed, total) => progress.push(processed, total) });
    assert.equal(unavailable.blocked[0]!.reason, "verified_source_unavailable");
    assert.deepEqual(progress, [1, 1]);
  } finally { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; }
});

test("snapshot publication handles a competing identical file and preserves the pointer after I/O failures", async t => {
  const f = await fixture(t);
  writeFileSync(f.file, "damaged");
  const initial = await migrateCodebaseSnapshots(f.store, [f.entry]); writeFileSync(f.file, f.content);
  const options = { backup_directory: initial.backup_directory! }, copy = fs.copyFileSync;
  const race = t.mock.method(fs, "linkSync", (from: fs.PathLike, to: fs.PathLike) => {
    copy(from, to); throw Object.assign(new Error("another writer published"), { code: "EEXIST" });
  }); syncBuiltinESMExports();
  try { assert.equal((await migrateCodebaseSnapshots(f.store, [f.entry], options)).migrated, 1); }
  finally { race.mock.restore(); syncBuiltinESMExports(); }
  f.setPayload(f.payload); rmSync(f.entry.target_root!, { recursive: true });
  const failure = t.mock.method(fs, "linkSync", () => { throw Object.assign(new Error("publication I/O failure"), { code: "EIO" }); });
  syncBuiltinESMExports();
  try { assert.equal((await migrateCodebaseSnapshots(f.store, [f.entry], options)).blocked[0]!.reason, "publication I/O failure"); }
  finally { failure.mock.restore(); syncBuiltinESMExports(); }
  const untyped = t.mock.method(fs, "copyFileSync", () => { throw "untyped storage failure"; }); syncBuiltinESMExports();
  try { assert.equal((await migrateCodebaseSnapshots(f.store, [f.entry], options)).blocked[0]!.reason, "migration_failed"); }
  finally { untyped.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(fs.readdirSync(join(f.entry.target_root!, "src")).length, 0);
});
