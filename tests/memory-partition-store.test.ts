import assert from "node:assert/strict";
import * as fs from "node:fs";
import fsDefault from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, type PathLike } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { MarkdownContentStore } from "../common/craft-common-store-local/src/content-store.ts";
import { assertRegularSessionMemoryDirectories, CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths, ensureProjectStorageDirectory, projectStorageDirectory, sessionStorageDirectory, type CraftPaths } from "../core/infrastructure/paths.ts";
import { MemoryLedgerKernel } from "../capability/craft-memory/memory-ledger.ts";

function projectCapabilityPath(paths: CraftPaths, root: string, capability: "memory" | "experience", ...parts: string[]): string {
  return join(projectStorageDirectory(paths, root), capability, ...parts);
}

async function legacyMigrationFixture() {
  const root = mkdtempSync(join(tmpdir(), "craft-partition-fault-"));
  const paths = craftPaths(join(root, "data")), project = join(root, "project");
  mkdirSync(project);
  let store = await new CraftStore(paths).open();
  store.create("scope_alias", "migration-project", { scope: { kind: "project", id: "project:migration" },
    alias_kind: "path", alias: project, status: "active" });
  store.create("memory_ledger", "migration-row", { scope: { kind: "project", id: "project:migration" }, status: "active", content: "legacy body" });
  store.close();
  const current = projectCapabilityPath(paths, project, "memory", "memory.db");
  const legacy = join(project, ".craft_data", "memory", "memory.db");
  mkdirSync(dirname(legacy), { recursive: true });
  renameSync(current, legacy);
  const central = new DatabaseSync(paths.databaseFile);
  try {
    const row = central.prepare("SELECT payload_json FROM records WHERE kind=? AND id=? AND version=1").get("memory_ledger", "migration-row") as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as JsonObject;
    (payload._memory_partition as JsonObject).file = legacy;
    central.prepare("UPDATE records SET payload_json=? WHERE kind=? AND id=? AND version=1").run(JSON.stringify(payload), "memory_ledger", "migration-row");
  } finally { central.close(); }
  store = await new CraftStore(paths).open();
  return { root, paths, project, store, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("CraftStore keeps Memory records in the database for their scope and can reopen them", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-partition-"));
  const dataRoot = join(root, "global-data");
  const projectRoot = join(root, "project");
  const sessionId = `partition-${process.pid}-${Date.now()}`;
  const paths = craftPaths(dataRoot);
  const sessionDir = sessionStorageDirectory(paths, "craft-mcp", sessionId);
  let store = await new CraftStore(paths).open();
  try {
    mkdirSync(projectRoot);
    store.create("scope_alias", "project-partition", { scope: { kind: "project", id: "project-1" },
      alias_kind: "path", alias: projectRoot, status: "active" });
    const records = [
      { id: "global-memory", scope: { kind: "global", id: "global" } },
      { id: "project-memory", scope: { kind: "project", id: "project-1" } },
      { id: "session-memory", scope: { kind: "session", id: sessionId } },
    ];
    for (const record of records) store.create("memory_ledger", record.id, { ...record, status: "active", content: `private body for ${record.id}` });
    const internals = store as any;
    assert.equal(internals.memoryDatabaseForRead({ kind: "global", id: "global" }).file,
      internals.partitionDatabaseFile("memory", { kind: "global", id: "global" }, false));

    const mainRows = store.database.prepare("SELECT payload_json FROM records WHERE kind='memory_ledger'").all() as Array<{ payload_json: string }>;
    assert.equal(mainRows.length, 3, "primary Craft database keeps only a routing and query projection");
    assert.equal(mainRows.some(row => row.payload_json.includes("private body")), false, "primary database must not retain Memory bodies");
    assert.equal(existsSync(paths.memoryDatabaseFile), true);
    assert.equal(existsSync(projectCapabilityPath(paths, projectRoot, "memory", "memory.db")), true);
    assert.equal(existsSync(join(sessionDir, "memory", "memory.db")), true);
    for (const record of records) assert.equal(store.get("memory_ledger", record.id).content, `private body for ${record.id}`);

    store.close();
    store = await new CraftStore(paths).open();
    for (const record of records) assert.equal(store.get("memory_ledger", record.id).content, `private body for ${record.id}`);
    assert.deepEqual(store.listScoped("memory_ledger", [records[1]!.scope], 10).map(item => item.id), ["project-memory"]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("Memory partition creation rejects a symlink in the session storage path", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-session-linked-path-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const sessionId = `linked-${randomUUID()}`;
    const sessionRoot = store.bindSessionStorageHost(sessionId, "codex");
    const external = join(root, "external"); mkdirSync(external);
    mkdirSync(sessionRoot, { recursive: true });
    symlinkSync(external, join(sessionRoot, "memory"));
    assert.throws(() => store.create("memory_ledger", "linked-session-memory", {
      scope: { kind: "session", id: sessionId }, status: "active", content: "must not follow a symlink",
    }), /Session Memory path must use regular directories/u);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("read-only partition resolution uses the current path and validates a scoped legacy session path", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-read-paths-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const sessionId = `read-path-${randomUUID()}`;
  const legacyDirectory = join("/tmp", ".craft_data", "memory", sessionId);
  try {
    store.create("memory_ledger", "read-path-global", { scope: { kind: "global", id: "global" }, status: "active", content: "global" });
    const internals = store as any;
    const globalScope = { kind: "global", id: "global" };
    assert.equal(internals.memoryDatabaseForRead(globalScope).file, internals.partitionDatabaseFile("memory", globalScope, false));
    mkdirSync(legacyDirectory, { recursive: true });
    const legacyFile = join(legacyDirectory, "memory.db"), legacy = new DatabaseSync(legacyFile);
    try { legacy.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)"); }
    finally { legacy.close(); }
    assert.equal(internals.memoryDatabaseForRead({ kind: "session", id: sessionId }, "memory", legacyFile).file, legacyFile);
    assert.throws(() => internals.memoryDatabaseForRead({ kind: "session", id: sessionId }, "memory", join(root, "outside.db")), /leaves its registered legacy scope/u);
    assert.throws(() => internals.memoryDatabaseForRead({ kind: "project", id: "unregistered" }, "memory", join(root, "legacy.db")), /Project Memory storage root is not registered/u);
    const external = join(root, "external-session"); mkdirSync(external);
    rmSync(legacyDirectory, { recursive: true, force: true }); symlinkSync(external, legacyDirectory);
    assert.throws(() => internals.memoryDatabaseForRead({ kind: "session", id: sessionId }, "memory", legacyFile), /regular directories/u);
  } finally {
    store.close(); rmSync(root, { recursive: true, force: true });
    rmSync(legacyDirectory, { recursive: true, force: true });
  }
});

test("legacy project partition remains readable while new writes use shared project storage", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-legacy-partition-read-"));
  const paths = craftPaths(join(root, "data")), project = join(root, "project");
  mkdirSync(project);
  let store = await new CraftStore(paths).open();
  try {
    store.create("scope_alias", "project", { scope: { kind: "project", id: "project:legacy" }, alias_kind: "path", alias: project, status: "active" });
    store.create("memory_ledger", "old-memory", { scope: { kind: "project", id: "project:legacy" }, status: "active", content: "old body" });
    store.create("knowledge_source", "old-md-source", { scope: "project:legacy", status: "active", trust: "verified" });
    new MemoryLedgerKernel(store).remember({ memory_id: "old-md", source_id: "old-md-source", kind: "preference",
      scope_kind: "project", scope_id: "project:legacy", content: "old Markdown body" });
    store.close();
    const current = join(projectStorageDirectory(paths, project), "memory", "memory.db");
    const legacy = join(project, ".craft_data", "memory", "memory.db");
    const checkpoint = new DatabaseSync(current);
    try { checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { checkpoint.close(); }
    mkdirSync(dirname(legacy), { recursive: true }); renameSync(current, legacy);
    renameSync(join(dirname(current), "md"), join(dirname(legacy), "md"));
    const oldPartition = new DatabaseSync(legacy);
    try {
      const row = oldPartition.prepare("SELECT payload_json FROM records WHERE kind='memory_ledger' AND id='old-md'").get() as { payload_json: string };
      const payload = JSON.parse(row.payload_json) as JsonObject;
      const ref = payload.content_ref as JsonObject;
      ref.path = join(dirname(legacy), "md", String(ref.path).split("/").at(-1)!);
      oldPartition.prepare("UPDATE records SET payload_json=? WHERE kind='memory_ledger' AND id='old-md'").run(JSON.stringify(payload));
    } finally { oldPartition.close(); }
    const main = new DatabaseSync(paths.databaseFile);
    try {
      for (const id of ["old-memory", "old-md"]) {
        const row = main.prepare("SELECT payload_json FROM records WHERE kind=? AND id=?").get("memory_ledger", id) as { payload_json: string };
        const payload = JSON.parse(row.payload_json) as JsonObject;
        (payload._memory_partition as JsonObject).file = legacy;
        main.prepare("UPDATE records SET payload_json=? WHERE kind=? AND id=?").run(JSON.stringify(payload), "memory_ledger", id);
      }
    } finally { main.close(); }
    store = await new CraftStore(paths).open();
    assert.equal(store.get("memory_ledger", "old-memory").content, "old body");
    assert.deepEqual(await store.migrateLegacyPartitionVersions([]), { migrated: 0, already_current: 0, backup_directory: null });
    await assert.rejects(store.migrateLegacyPartitionVersions(Array.from({ length: 501 }, () => ({ kind: "memory_ledger", id: "old-memory", version: 1 }))),
      /page is too large/u);
    await assert.rejects(store.migrateLegacyPartitionVersions([{ kind: "", id: "old-memory", version: 1 }]), /identity is invalid/u);
    const oldMarkdown = store.get("memory_ledger", "old-md");
    assert.equal((oldMarkdown.content_ref as JsonObject).path, join(dirname(legacy), "md", String((oldMarkdown.content_ref as JsonObject).path).split("/").at(-1)!));
    assert.equal(store.contentStore.isCanonicalRef(oldMarkdown.content_ref as never), false,
      JSON.stringify(oldMarkdown.content_ref));
    assert.equal(store.contentStore.readCompatSync(oldMarkdown.content_ref as never,
      String((oldMarkdown.content_ref as JsonObject).scope)).body, "old Markdown body");
    assert.deepEqual(store.listScoped("memory_ledger", [{ kind: "project", id: "project:legacy" }], 10).map(row => row.id), ["old-md", "old-memory"]);
    const prior = store.get("memory_ledger", "old-memory");
    assert.throws(() => store.replacePayloadBatch([{ kind: "memory_ledger", id: "old-memory", version: 1,
      payload: { ...prior, content: "changed" } }]), /requires verified storage migration/u);
    assert.throws(() => store.remove("memory_ledger", "old-memory"), /requires verified storage migration/u);
    assert.equal(store.get("memory_ledger", "old-memory").content, "old body");
    await assert.rejects(store.migrateLegacyPartitionVersions([
      { kind: "memory_ledger", id: "old-memory", version: 1 },
      { kind: "memory_ledger", id: "old-memory", version: 1 },
    ]), /repeats an identity/u);
    await assert.rejects(store.migrateLegacyPartitionVersions([{ kind: "memory_ledger", id: "missing", version: 1 }]),
      /pointer is missing/u);
    store.create("memory_ledger", "new-memory", { scope: { kind: "project", id: "project:legacy" }, status: "active", content: "new body" });
    assert.equal(existsSync(current), true);
    assert.equal(existsSync(legacy), true);
    assert.equal(store.get("memory_ledger", "new-memory").content, "new body");
    const migration = await store.migrateLegacyPartitionVersions([
      { kind: "memory_ledger", id: "old-memory", version: 1 },
      { kind: "memory_ledger", id: "old-md", version: 1 },
    ]);
    assert.equal(migration.migrated, 2);
    assert.equal(existsSync(join(String(migration.backup_directory), "manifest.json")), true);
    assert.equal((JSON.parse(readFileSync(join(String(migration.backup_directory), "manifest.json"), "utf8")) as JsonObject)
      .central_records instanceof Array, true);
    assert.equal((store.get("memory_ledger", "old-md").content_ref as JsonObject).path?.toString().startsWith(paths.root), true);
    assert.equal(store.contentStore.readSync(store.get("memory_ledger", "old-md").content_ref as never).body, "old Markdown body");
    assert.deepEqual(await store.migrateLegacyPartitionVersions([{ kind: "memory_ledger", id: "old-md", version: 1 }]),
      { migrated: 0, already_current: 1, backup_directory: null });
    assert.equal(store.remove("memory_ledger", "old-memory"), 1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("legacy project partition reads recheck root identity after resolving the current path", async t => {
  const f = await legacyMigrationFixture();
  try {
    const internals = f.store as unknown as { projectRoots(id: string): string[]; memoryDatabaseForRead(scope: { kind: string; id: string }, domain: string, file: string): unknown };
    const originalRoots = internals.projectRoots.bind(f.store);
    let lookups = 0;
    const revocation = t.mock.method(internals, "projectRoots", (id: string) => {
      lookups++;
      return lookups === 1 ? originalRoots(id) : [];
    });
    assert.throws(() => internals.memoryDatabaseForRead({ kind: "project", id: "project:migration" }, "memory",
      join(f.project, ".craft_data", "memory", "memory.db")), /Legacy project partition root is unavailable or ambiguous/u);
    assert.equal(lookups, 2, "the project identity is rechecked before resolving a legacy pointer");
    revocation.mock.restore();
  } finally { f.close(); }
});

test("legacy partition migration rejects a pointer without scope metadata and a missing source row", async () => {
  const f = await legacyMigrationFixture();
  try {
    const now = new Date().toISOString();
    f.store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("memory_ledger", "pointerless", 1, JSON.stringify({ scope: { kind: "global", id: "global" } }), now, now);
    await assert.rejects(f.store.migrateLegacyPartitionVersions([{ kind: "memory_ledger", id: "pointerless", version: 1 }]), /pointer is missing/u);
    const legacyFile = join(f.project, ".craft_data", "memory", "memory.db");
    const legacy = new DatabaseSync(legacyFile);
    try { legacy.prepare("DELETE FROM records WHERE kind='memory_ledger' AND id='migration-row' AND version=1").run(); }
    finally { legacy.close(); }
    await assert.rejects(f.store.migrateLegacyPartitionVersions([{ kind: "memory_ledger", id: "migration-row", version: 1 }]), /row is missing/u);
  } finally { f.close(); }
});

test("legacy memory migration fails closed when project content has no registered root", async t => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-migration-unbound-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const now = new Date().toISOString();
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("memory_ledger", "orphaned-project-memory", 1,
        JSON.stringify({ scope: { kind: "project", id: "unregistered" }, status: "active", source_id: "source", content_ref: { path: "legacy.md" } }), now, now);
    const internals = store as unknown as { backupLegacyPartitionRecords(domain: string, rows: unknown[]): void };
    const backup = t.mock.method(internals, "backupLegacyPartitionRecords", () => {});
    const read = t.mock.method(store.contentStore, "readCompatSync", () => ({ body: "legacy body", manifest: { scope: "project:unregistered" } } as never));
    assert.throws(() => (store as unknown as { migrateLegacyMemoryRecords(): void }).migrateLegacyMemoryRecords(), /storage root is unavailable or ambiguous/u);
    backup.mock.restore();
    read.mock.restore();
    assert.equal(store.get("memory_ledger", "orphaned-project-memory").status, "active");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("legacy partition migration refuses a symlinked backups directory", async () => {
  const f = await legacyMigrationFixture();
  const movedBackups = `${f.paths.backupsDir}-original`, outside = join(f.root, "outside-backups");
  try {
    mkdirSync(outside);
    renameSync(f.paths.backupsDir, movedBackups);
    symlinkSync(outside, f.paths.backupsDir);
    await assert.rejects(f.store.migrateLegacyPartitionVersions([{ kind: "memory_ledger", id: "migration-row", version: 1 }]), /backup path must use regular directories/u);
    assert.deepEqual(readdirSync(outside), []);
  } finally { f.close(); }
});

test("legacy partition migration propagates unexpected backup-directory creation errors", async t => {
  const f = await legacyMigrationFixture();
  const migrationRoot = join(f.paths.backupsDir, "storage-migration");
  const originalMkdir = fs.mkdirSync;
  try {
    const denied = t.mock.method(fsDefault, "mkdirSync", (path: PathLike, options?: fs.MakeDirectoryOptions) => {
      if (String(path) === migrationRoot) throw Object.assign(new Error("backup directory is not writable"), { code: "EACCES" });
      return originalMkdir(path, options);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(f.store.migrateLegacyPartitionVersions([{ kind: "memory_ledger", id: "migration-row", version: 1 }]),
        error => (error as NodeJS.ErrnoException).code === "EACCES");
    } finally { denied.mock.restore(); syncBuiltinESMExports(); }
  } finally { f.close(); }
});

test("legacy partition migration rejects a conflicting pre-existing target row", async () => {
  const f = await legacyMigrationFixture();
  try {
    const target = (f.store as unknown as { memoryDatabase(scope: { kind: string; id: string }): { database: DatabaseSync } })
      .memoryDatabase({ kind: "project", id: "project:migration" }).database;
    const now = new Date().toISOString();
    target.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("memory_ledger", "migration-row", 1, JSON.stringify({ conflicting: true }), now, now);
    await assert.rejects(f.store.migrateLegacyPartitionVersions([{ kind: "memory_ledger", id: "migration-row", version: 1 }]), /target conflicts/u);
  } finally { f.close(); }
});

test("legacy partition migration rejects a symlinked backup root before writing", async () => {
  const f = await legacyMigrationFixture();
  try {
    const backupRoot = join(f.paths.backupsDir, "storage-migration"), outside = join(f.root, "outside-backups");
    mkdirSync(outside); symlinkSync(outside, backupRoot);
    await assert.rejects(f.store.migrateLegacyPartitionVersions([{ kind: "memory_ledger", id: "migration-row", version: 1 }]), /backup path must use regular directories/u);
    assert.equal(readdirSync(outside).length, 0);
  } finally { f.close(); }
});

test("legacy partition migration stops when its source row changes after backup", async () => {
  const f = await legacyMigrationFixture();
  try {
    const internals = f.store as any;
    const original = internals.memoryDatabaseForRead.bind(f.store);
    const legacyDatabase = new DatabaseSync(join(f.project, ".craft_data", "memory", "memory.db"));
    let reads = 0;
    internals.memoryDatabaseForRead = (...args: unknown[]) => {
      const result = original(...args);
      reads++;
      if (reads === 3) legacyDatabase.prepare("UPDATE records SET payload_json=? WHERE kind=? AND id=? AND version=1")
        .run(JSON.stringify({ changed: true }), "memory_ledger", "migration-row");
      return result;
    };
    try {
      await assert.rejects(f.store.migrateLegacyPartitionVersions([{ kind: "memory_ledger", id: "migration-row", version: 1 }]), /source changed concurrently/u);
    } finally { legacyDatabase.close(); }
  } finally { f.close(); }
});

test("legacy partition migration rejects a backup that fails SQLite integrity checking", async () => {
  const f = await legacyMigrationFixture();
  const prototype = DatabaseSync.prototype as any;
  const originalPrepare = prototype.prepare;
  try {
    prototype.prepare = function (sql: string, ...args: unknown[]) {
      if (sql === "PRAGMA quick_check") return { get: () => ({ quick_check: "corrupt" }) };
      return originalPrepare.call(this, sql, ...args);
    };
    await assert.rejects(f.store.migrateLegacyPartitionVersions([{ kind: "memory_ledger", id: "migration-row", version: 1 }]), /backup failed integrity check/u);
  } finally { prototype.prepare = originalPrepare; f.close(); }
});

test("legacy partition migration reconciles a concurrent identical pointer publication", async () => {
  const f = await legacyMigrationFixture();
  try {
    const internals = f.store as any;
    const original = internals.transactionOn.bind(f.store);
    let published = false;
    internals.transactionOn = (database: DatabaseSync, operation: () => unknown) => {
      const result = original(database, operation);
      if (!published && database !== f.store.database) {
        const target = projectCapabilityPath(f.paths, f.project, "memory", "memory.db");
        const central = f.store.database.prepare("SELECT payload_json FROM records WHERE kind=? AND id=? AND version=1")
          .get("memory_ledger", "migration-row") as { payload_json: string };
        const header = JSON.parse(central.payload_json) as JsonObject;
        (header._memory_partition as JsonObject).file = target;
        f.store.database.prepare("UPDATE records SET payload_json=? WHERE kind=? AND id=? AND version=1")
          .run(JSON.stringify(header), "memory_ledger", "migration-row");
        published = true;
      }
      return result;
    };
    const result = await f.store.migrateLegacyPartitionVersions([{ kind: "memory_ledger", id: "migration-row", version: 1 }]);
    assert.deepEqual({ migrated: result.migrated, already_current: result.already_current }, { migrated: 0, already_current: 1 });
  } finally { f.close(); }
});

test("legacy partition migration rejects a conflicting concurrent pointer publication", async () => {
  const f = await legacyMigrationFixture();
  try {
    const internals = f.store as any;
    const original = internals.transactionOn.bind(f.store);
    let published = false;
    internals.transactionOn = (database: DatabaseSync, operation: () => unknown) => {
      const result = original(database, operation);
      if (!published && database !== f.store.database) {
        const central = f.store.database.prepare("SELECT payload_json FROM records WHERE kind=? AND id=? AND version=1")
          .get("memory_ledger", "migration-row") as { payload_json: string };
        const header = JSON.parse(central.payload_json) as JsonObject;
        (header._memory_partition as JsonObject).file = join(f.root, "another-project", "memory.db");
        f.store.database.prepare("UPDATE records SET payload_json=? WHERE kind=? AND id=? AND version=1")
          .run(JSON.stringify(header), "memory_ledger", "migration-row");
        published = true;
      }
      return result;
    };
    await assert.rejects(f.store.migrateLegacyPartitionVersions([{ kind: "memory_ledger", id: "migration-row", version: 1 }]), /pointer changed concurrently/u);
  } finally { f.close(); }
});

test("Memory Markdown bodies follow the same project or session boundary as their record", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-content-partition-"));
  const projectRoot = join(root, "project"); mkdirSync(projectRoot);
  const store = await new CraftStore(craftPaths(join(root, "global-data"))).open();
  try {
    store.create("scope_alias", "project-content", { scope: { kind: "project", id: "project-content" }, alias_kind: "path", alias: projectRoot, status: "active" });
    store.create("knowledge_source", "memory-source", { scope: "project:project-content", status: "active", trust: "verified" });
    const ledger = new MemoryLedgerKernel(store);
    const project = ledger.remember({ memory_id: "project-content-memory", source_id: "memory-source", kind: "preference",
      scope_kind: "project", scope_id: "project-content", content: "project-only body" }).memory as JsonObject;
    const session = ledger.remember({ memory_id: "session-content-memory", source_id: "memory-source", kind: "preference",
      scope_kind: "session", scope_id: "session-content", content: "session-only body" }).memory as JsonObject;
    const projectContentPath = (project.content_ref as { path: string }).path;
    const sessionContentPath = (session.content_ref as { path: string }).path;
    assert.equal(projectContentPath.startsWith(projectCapabilityPath(store.paths, projectRoot, "memory", "md") + "/"), true);
    assert.equal(sessionContentPath.startsWith(join(sessionStorageDirectory(store.paths, "craft-mcp", "session-content"), "memory", "md") + "/"), true);
    assert.match(readFileSync(projectContentPath, "utf8"), /project-only body/);
    assert.match(readFileSync(sessionContentPath, "utf8"), /session-only body/);
    assert.equal(existsSync(join(store.paths.memoryContentDir, "project-content-memory.v1.md")), false);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("opening a legacy store backs it up and moves scoped Memory versions out of the primary database", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-legacy-migration-"));
  const dataRoot = join(root, "global-data"), projectRoot = join(root, "project"); mkdirSync(projectRoot);
  const paths = craftPaths(dataRoot);
  let store = await new CraftStore(paths).open();
  try {
    store.create("scope_alias", "project-legacy", { scope: { kind: "project", id: "legacy-project" }, alias_kind: "path", alias: projectRoot, status: "active" });
    const insert = store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES('memory_candidate','legacy-candidate',?,?,?,?)");
    const base = { scope: { kind: "project", id: "legacy-project" }, status: "candidate", content: "legacy private candidate" };
    insert.run(1, JSON.stringify(base), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    insert.run(2, JSON.stringify({ ...base, status: "approved" }), "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    store.create("knowledge_source", "legacy-source", { scope: "project:legacy-project", status: "active", trust: "verified" });
    const legacyRef = new MarkdownContentStore(paths).writeSync({ kind: "memory", record_id: "legacy-ledger", version: 1, scope: "project:legacy-project", status: "active",
      sensitivity: "internal", source_id: "legacy-source", body: "legacy ledger body" });
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES('memory_ledger','legacy-ledger',1,?,?,?)")
      .run(JSON.stringify({ scope: { kind: "project", id: "legacy-project" }, source_id: "legacy-source", source_version: 1, status: "active", kind: "preference", content_digest: "digest", content_ref: legacyRef }),
        "2026-01-03T00:00:00.000Z", "2026-01-03T00:00:00.000Z");
    const globalLegacyRef = store.contentStore.writeSync({ kind: "memory", record_id: "legacy-global-ledger", version: 1, scope: "global:global", status: "active",
      sensitivity: "internal", source_id: "legacy-source", body: "legacy global body" });
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES('memory_ledger','legacy-global-ledger',1,?,?,?)")
      .run(JSON.stringify({ scope: { kind: "global", id: "global" }, source_id: "legacy-source", kind: "episodic", status: "active", sensitivity: "internal", content_ref: globalLegacyRef }),
        "2026-01-04T00:00:00.000Z", "2026-01-04T00:00:00.000Z");
    const projectLegacyOriginal = new MarkdownContentStore(paths).writeSync({ kind: "memory", record_id: "legacy-project-ledger", version: 1, scope: "project:legacy-project",
      status: "active", sensitivity: "internal", source_id: "legacy-source", body: "legacy project body" });
    const projectLegacyPath = store.contentStore.legacyPathFor("memory", "legacy-project-ledger", 1);
    mkdirSync(dirname(projectLegacyPath), { recursive: true });
    writeFileSync(projectLegacyPath, readFileSync(projectLegacyOriginal.path, "utf8")); unlinkSync(projectLegacyOriginal.path);
    const projectLegacyRef = { ...projectLegacyOriginal, path: projectLegacyPath };
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES('memory_ledger','legacy-project-ledger',1,?,?,?)")
      .run(JSON.stringify({ scope: { kind: "project", id: "legacy-project" }, source_id: "legacy-source", kind: "episodic", content_ref: projectLegacyRef }),
        "2026-01-05T00:00:00.000Z", "2026-01-05T00:00:00.000Z");
    store.close();
    const reopening = new CraftStore(paths);
    const readCompat = reopening.contentStore.readCompatSync.bind(reopening.contentStore);
    let legacyReads = 0;
    reopening.contentStore.readCompatSync = ((ref, expectedScope) => {
      const result = readCompat(ref, expectedScope);
      if (ref.path === legacyRef.path && ++legacyReads === 2) unlinkSync(legacyRef.path);
      return result;
    }) as typeof reopening.contentStore.readCompatSync;
    store = await reopening.open();
    assert.equal(store.get("memory_candidate", "legacy-candidate").content, "legacy private candidate");
    assert.equal(store.get("memory_candidate", "legacy-candidate", 1).status, "candidate");
    const migratedLedger = store.get("memory_ledger", "legacy-ledger");
    assert.equal(store.contentStore.readCompatSync(migratedLedger.content_ref as never).body, "legacy ledger body");
    assert.notEqual((migratedLedger.content_ref as { path: string }).path, legacyRef.path);
    assert.equal(existsSync(legacyRef.path), false);
    const migratedGlobal = store.get("memory_ledger", "legacy-global-ledger");
    assert.equal(store.contentStore.readCompatSync(migratedGlobal.content_ref as never).body, "legacy global body");
    assert.equal(migratedGlobal.status, "active"); assert.equal(migratedGlobal.sensitivity, "internal");
    assert.equal((migratedGlobal.content_ref as JsonObject).path, globalLegacyRef.path);
    assert.equal(existsSync(globalLegacyRef.path), true, "in-place global Memory migration must keep its live content file");
    const migratedProject = store.get("memory_ledger", "legacy-project-ledger");
    assert.equal(store.contentStore.readCompatSync(migratedProject.content_ref as never).body, "legacy project body");
    assert.equal(migratedProject.status, "active"); assert.equal(migratedProject.sensitivity, "internal");
    assert.equal(existsSync(projectLegacyRef.path), true, "project-owned legacy content is outside the global Memory content directory");
    const header = store.database.prepare("SELECT payload_json FROM records WHERE kind='memory_candidate' AND id='legacy-candidate' AND version=2").get() as { payload_json: string };
    assert.equal(header.payload_json.includes("legacy private candidate"), false);
    assert.equal(readdirSync(paths.backupsDir).length, 0, "a capability migration must not copy the shared multi-domain database");
    const globalMemoryBackups = readdirSync(join(paths.memoryDir, "backups"));
    const projectMemoryBackupDir = projectCapabilityPath(paths, projectRoot, "memory", "backups");
    const projectMemoryBackups = readdirSync(projectMemoryBackupDir);
    assert.equal(globalMemoryBackups.length, 1);
    assert.equal(projectMemoryBackups.length, 1);
    const globalMemoryBackup = JSON.parse(readFileSync(join(paths.memoryDir, "backups", globalMemoryBackups[0]!), "utf8")) as JsonObject;
    const projectMemoryBackup = JSON.parse(readFileSync(join(projectMemoryBackupDir, projectMemoryBackups[0]!), "utf8")) as JsonObject;
    assert.equal(globalMemoryBackup.domain, "memory");
    assert.deepEqual(globalMemoryBackup.scope, { kind: "global", id: "global" });
    assert.equal((globalMemoryBackup.records as JsonObject[]).some(row => row.id === "legacy-global-ledger"), true);
    assert.deepEqual(projectMemoryBackup.scope, { kind: "project", id: "legacy-project" });
    assert.equal((projectMemoryBackup.records as JsonObject[]).some(row => row.kind === "memory_candidate" && row.id === "legacy-candidate" && String(row.payload_json).includes("legacy private candidate")), true);
    assert.equal((globalMemoryBackup.records as JsonObject[]).some(row => row.id === "legacy-candidate"), false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("legacy Memory migration surfaces unexpected retired-file cleanup errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-migration-cleanup-error-"));
  const paths = craftPaths(join(root, "data"));
  const initial = await new CraftStore(paths).open();
  let reopening: CraftStore | null = null;
  try {
    let ref = initial.contentStore.writeSync({ kind: "memory", record_id: "cleanup-error", version: 1, scope: "global:global",
      status: "active", sensitivity: "internal", source_id: "source", body: "cleanup source" });
    const legacyPath = join(paths.memoryContentDir, "legacy-old-name.v1.md");
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, readFileSync(ref.path, "utf8")); unlinkSync(ref.path);
    ref = { ...ref, path: legacyPath };
    initial.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES('memory_ledger','cleanup-error',1,?,?,?)")
      .run(JSON.stringify({ scope: { kind: "global", id: "global" }, status: "active", sensitivity: "internal", source_id: "source", content_ref: ref }),
        "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    initial.close();

    reopening = new CraftStore(paths);
    const readCompat = reopening.contentStore.readCompatSync.bind(reopening.contentStore);
    let legacyReads = 0;
    reopening.contentStore.readCompatSync = ((candidate, expectedScope) => {
      const result = readCompat(candidate, expectedScope);
      if (candidate.path === legacyPath && ++legacyReads === 2) { unlinkSync(legacyPath); mkdirSync(legacyPath); }
      return result;
    }) as typeof reopening.contentStore.readCompatSync;
    await assert.rejects(reopening.open(), /EISDIR|operation not permitted|is a directory/iu);
  } finally { reopening?.close(); initial.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a failed outer transaction removes staged Memory rows and never publishes their directory entry", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-partition-rollback-"));
  const projectRoot = join(root, "project"); mkdirSync(projectRoot);
  const paths = craftPaths(join(root, "global-data"));
  const store = await new CraftStore(paths).open();
  try {
    store.create("scope_alias", "project-rollback", { scope: { kind: "project", id: "rollback-project" }, alias_kind: "path", alias: projectRoot, status: "active" });
    assert.throws(() => store.transaction(() => {
      store.create("memory_candidate", "rolled-back", { scope: { kind: "project", id: "rollback-project" }, content: "must stay invisible", status: "candidate" });
      throw new Error("abort transaction");
    }), /abort transaction/);
    assert.equal(store.find("memory_candidate", "rolled-back"), null);
    const database = new DatabaseSync(projectCapabilityPath(paths, projectRoot, "memory", "memory.db"));
    try { assert.equal(database.prepare("SELECT COUNT(*) count FROM records WHERE kind='memory_candidate' AND id='rolled-back'").get()?.count, 0); }
    finally { database.close(); }
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Memory record scope cannot change after publication and missing project identity fails closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-partition-scope-"));
  const projectRoot = join(root, "project"); mkdirSync(projectRoot);
  const store = await new CraftStore(craftPaths(join(root, "global-data"))).open();
  try {
    store.create("scope_alias", "project-stable", { scope: { kind: "project", id: "stable-project" }, alias_kind: "path", alias: projectRoot, status: "active" });
    store.create("memory_candidate", "stable", { scope: { kind: "project", id: "stable-project" }, content: "stable scope", status: "candidate" });
    assert.throws(() => store.save("memory_candidate", "stable", { scope: { kind: "global", id: "global" }, content: "moved", status: "candidate" }), /cannot change storage scope/);
    assert.throws(() => store.create("memory_ledger", "unbound", { scope: { kind: "project", id: "missing" }, content: "no root" }), /storage root is not registered/);
    assert.throws(() => store.create("memory_candidate", "malformed", { scope: { kind: "unknown", id: "invalid" }, content: "must fail closed" }), /scope is malformed/);
    assert.equal(store.find("memory_candidate", "malformed"), null);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("project Memory storage rejects symlinked data directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-partition-symlink-"));
  const projectRoot = join(root, "project"), external = join(root, "external");
  mkdirSync(projectRoot); mkdirSync(external);
  const store = await new CraftStore(craftPaths(join(root, "global-data"))).open();
  try {
    mkdirSync(join(store.paths.root, "projects"));
    symlinkSync(external, projectStorageDirectory(store.paths, projectRoot));
    store.create("scope_alias", "project-symlink", { scope: { kind: "project", id: "symlink-project" }, alias_kind: "path", alias: projectRoot, status: "active" });
    assert.throws(() => store.create("memory_candidate", "outside", { scope: { kind: "project", id: "symlink-project" }, content: "must not escape" }), /regular directories/);
    assert.equal(readdirSync(external).length, 0);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("session and task Memory paths reject linked or malformed SQLite storage", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-special-paths-"));
  const paths = craftPaths(join(root, "data"));
  const external = join(root, "external"); mkdirSync(external);
  const sessionId = `partition-link-${randomUUID()}`;
  const sessionDirectory = sessionStorageDirectory(paths, "craft-mcp", sessionId);
  mkdirSync(dirname(sessionDirectory), { recursive: true });
  symlinkSync(external, sessionDirectory);
  const taskId = `task-link-${randomUUID()}`;
  const taskDirectory = join(paths.runtimeDir, "memory-tasks", taskId);
  mkdirSync(taskDirectory, { recursive: true });
  const externalDb = join(external, "database.db"); writeFileSync(externalDb, "not sqlite");
  symlinkSync(externalDb, join(taskDirectory, "memory.db"));
  const malformedTaskId = `task-corrupt-${randomUUID()}`;
  const malformedDirectory = join(paths.runtimeDir, "memory-tasks", malformedTaskId);
  mkdirSync(malformedDirectory, { recursive: true });
  writeFileSync(join(malformedDirectory, "memory.db"), "not sqlite");
  const store = await new CraftStore(paths).open();
  try {
    assert.throws(() => store.create("memory_ledger", "linked-session", { scope: { kind: "session", id: sessionId }, content: "reject" }), /regular directories/);
    assert.throws(() => store.create("memory_ledger", "linked-task", { scope: { kind: "task", id: taskId }, content: "reject" }), /regular file/);
    assert.throws(() => store.create("memory_ledger", "corrupt-task", { scope: { kind: "task", id: malformedTaskId }, content: "reject" }));
    assert.equal(readFileSync(externalDb, "utf8"), "not sqlite");
  } finally {
    store.close(); unlinkSync(sessionDirectory); rmSync(root, { recursive: true, force: true });
  }
});

test("session Memory validates missing and non-directory data roots without creating them", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-session-root-check-"));
  const dataRoot = join(root, "not-created");
  try {
    assertRegularSessionMemoryDirectories(dataRoot);
    assert.equal(existsSync(dataRoot), false);
    mkdirSync(dataRoot);
    writeFileSync(join(dataRoot, "memory"), "not a directory");
    assert.throws(() => assertRegularSessionMemoryDirectories(dataRoot), /regular directories/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("partitioned Memory supports compatibility scopes, payload replacement, deletion, and connection close", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-partition-lifecycle-"));
  const projectRoot = join(root, "project"); mkdirSync(projectRoot);
  const store = await new CraftStore(craftPaths(join(root, "global-data"))).open();
  try {
    store.create("scope_alias", "project-lifecycle", { scope: { kind: "project", id: "lifecycle" }, alias_kind: "path", alias: projectRoot, status: "active" });
    store.create("memory_candidate", "duplicate-before-write", { scope: { kind: "global", id: "global" }, content: "before" });
    assert.throws(() => store.create("memory_candidate", "duplicate-before-write", { scope: { kind: "global", id: "global" }, content: "again" }), /already exists/);
    assert.throws(() => store.contentStore.writeSync({ kind: "memory", record_id: "unbound", version: 1, scope: "project:unbound",
      status: "active", sensitivity: "internal", source_id: "source", body: "reject" }), /no registered project root/);
    const projectBody = store.contentStore.writeSync({ kind: "memory", record_id: "project-body", version: 1, scope: "project:lifecycle",
      project_root: projectRoot, status: "active", sensitivity: "internal", source_id: "source", body: "root-pinned body" });
    assert.equal(projectBody.path.startsWith(projectCapabilityPath(store.paths, projectRoot, "memory", "md") + "/"), true);
    const globalBody = store.contentStore.writeSync({ kind: "memory", record_id: "global-body", version: 1, scope: "global",
      status: "active", sensitivity: "internal", source_id: "source", body: "global body" });
    assert.equal(globalBody.path.startsWith(store.paths.memoryContentDir), true);
    store.create("memory_ledger", "scope-source", { scope: "global", content: "source", status: "active" });
    const inferredConfirmation = store.create("memory_confirmation", "inferred-confirmation", { memory_id: "scope-source", status: "active" });
    assert.deepEqual(inferredConfirmation.scope, { kind: "global", id: "global" });
    const globalConfirmation = store.create("memory_confirmation", "fallback-confirmation", { status: "active" });
    assert.deepEqual(globalConfirmation.scope, { kind: "global", id: "global" });
    const inferredObservation = store.create("memory_observation", "inferred-observation", { project_id: "lifecycle", status: "active" });
    assert.deepEqual(inferredObservation.scope, { kind: "project", id: "lifecycle" });
    const globalObservation = store.create("memory_observation", "global-observation", { status: "active" });
    assert.deepEqual(globalObservation.scope, { kind: "global", id: "global" });
    const fieldScope = store.create("memory_candidate", "field-scope", { scope_kind: "task", scope_id: "compat", status: "candidate" });
    assert.deepEqual(fieldScope.scope, { kind: "task", id: "compat" });
    const stringScope = store.create("memory_candidate", "string-scope", { scope: "task:compat", status: "candidate" });
    assert.deepEqual(stringScope.scope, { kind: "task", id: "compat" });
    const legacyScope = store.create("memory_candidate", "legacy-task-scope", { scope: "task", task_id: "task-real", status: "candidate" });
    assert.deepEqual(legacyScope.scope, { kind: "task", id: "task-real" });
    const unboundLegacyScope = store.create("memory_candidate", "unbound-task-scope", { scope: "task", status: "candidate" });
    assert.deepEqual(unboundLegacyScope.scope, { kind: "task", id: "legacy" });
    const organizationScope = store.create("memory_policy", "organization-scope", { scope: { kind: "organization", id: "org" }, status: "active" });
    assert.deepEqual(organizationScope.scope, { kind: "organization", id: "org" });
    const createdAtZero = store.updateIfVersion("memory_candidate", "created-at-zero", 0, { scope: { kind: "global", id: "global" }, content: "new" });
    assert.equal(createdAtZero.version, 1);

    const created = store.create("memory_candidate", "mutable", { scope: { kind: "global", id: "global" }, status: "candidate", content: "before" });
    const updated = store.updateIfVersion("memory_candidate", "mutable", 1, { ...created, content: "updated" });
    assert.throws(() => store.updateIfVersion("memory_candidate", "mutable", 1, { ...created, content: "stale" }), /Concurrent update/);
    store.replacePayload("memory_candidate", "mutable", 2, { ...updated, content: "after-one" });
    store.replacePayloadBatch([{ kind: "memory_candidate", id: "mutable", version: 2, payload: { ...updated, content: "after-two" } }]);
    assert.equal(store.get("memory_candidate", "mutable").content, "after-two");
    const header = store.database.prepare("SELECT payload_json FROM records WHERE kind='memory_candidate' AND id='mutable' AND version=2").get() as { payload_json: string };
    assert.equal(header.payload_json.includes("after-two"), false, "batch replacement must not copy a Memory body into the primary database");
    assert.equal(store.remove("memory_candidate", "mutable"), 2);
    assert.equal(store.find("memory_candidate", "mutable"), null);
    store.closeMemoryScope({ kind: "global", id: "global" });
    store.closeMemoryScope({ kind: "global", id: "global" });
    assert.throws(() => store.create("memory_candidate", "bad-scope", { scope: "malformed", content: "reject" }), /scope is malformed/);
    assert.throws(() => store.create("memory_candidate", "array-scope", { scope: [], content: "reject" }), /scope is malformed/);
    assert.throws(() => store.create("memory_candidate", "bad-task", { scope: { kind: "task", id: "../escape" }, content: "reject" }), /safe directory name/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Experience records use global and project capability databases with versioned reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-experience-partition-"));
  const dataRoot = join(root, "data"), projectRoot = join(root, "project"); mkdirSync(projectRoot);
  const paths = craftPaths(dataRoot);
  const store = await new CraftStore(paths).open();
  try {
    store.create("scope_alias", "experience-project-root", { scope: { kind: "project", id: "experience-project" }, alias_kind: "path", alias: projectRoot, status: "active" });
    const global = store.create("experience_procedure", "global-procedure", { scope: "global:global", lifecycle: "candidate", title: "global" });
    const project = store.create("workflow_evolution_observation", "project-observation", {
      scenario_key: "project:build", source: { kind: "host:codex", id: "task-1", scope: "project:experience-project" },
      outcome: "passed", evidence_ids: ["evidence-1"], sanitized: true, content_stored: false,
    });
    const globalHeader = store.database.prepare("SELECT payload_json FROM records WHERE kind='experience_procedure' AND id='global-procedure' AND version=1").get() as { payload_json: string };
    assert.equal(globalHeader.payload_json.includes("candidate"), false);
    assert.equal(JSON.parse(globalHeader.payload_json)._experience_partition.file, paths.experienceDatabaseFile);
    const globalDb = new DatabaseSync(paths.experienceDatabaseFile, { readOnly: true });
    try { assert.equal((globalDb.prepare("SELECT payload_json FROM records WHERE kind='experience_procedure' AND id='global-procedure'").get() as { payload_json: string }).payload_json.includes("candidate"), true); }
    finally { globalDb.close(); }
    const projectDbPath = projectCapabilityPath(paths, projectRoot, "experience", "experience.db");
    const projectDb = new DatabaseSync(projectDbPath, { readOnly: true });
    try { assert.equal(Number((projectDb.prepare("SELECT COUNT(*) count FROM records WHERE kind='workflow_evolution_observation' AND id=?").get(String(project.id)) as { count: number }).count), 1); }
    finally { projectDb.close(); }
    const updated = store.updateIfVersion("experience_procedure", String(global.id), Number(global.version), { ...global, lifecycle: "routeable" });
    assert.equal(updated.version, 2);
    assert.equal(store.history("experience_procedure", String(global.id), 2, 5)[0]?.lifecycle, "candidate");
    assert.throws(() => store.updateIfVersion("experience_procedure", String(global.id), Number(global.version), { ...global, lifecycle: "stale" }), /Concurrent update detected/u);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("workflow Experience requests inherit one source scope and reject mixed projects", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-experience-request-scope-"));
  const projectRoot = join(root, "project"); mkdirSync(projectRoot);
  const paths = craftPaths(join(root, "data"));
  const store = await new CraftStore(paths).open();
  try {
    store.create("scope_alias", "experience-request-project", { scope: { kind: "project", id: "request-project" }, alias_kind: "path", alias: projectRoot, status: "active" });
    const request = store.create("workflow_evolution_request", "project-request", {
      observation_refs: [{ source: { scope: "project:request-project" }, evidence_ids: ["e1"] }], lifecycle: "awaiting_model",
    });
    assert.equal(request.id, "project-request");
    const header = store.database.prepare("SELECT payload_json FROM records WHERE kind='workflow_evolution_request' AND id='project-request'").get() as { payload_json: string };
    const pointer = JSON.parse(header.payload_json)._experience_partition as JsonObject;
    assert.deepEqual(pointer.scope, { kind: "project", id: "request-project" });
    assert.equal(pointer.file, projectCapabilityPath(paths, projectRoot, "experience", "experience.db"));
    store.create("workflow_evolution_proposal", "project-proposal", { request_id: "project-request", lifecycle: "candidate" });
    const proposalHeader = store.database.prepare("SELECT payload_json FROM records WHERE kind='workflow_evolution_proposal' AND id='project-proposal'").get() as { payload_json: string };
    assert.deepEqual(JSON.parse(proposalHeader.payload_json)._experience_partition, pointer);
    assert.throws(() => store.create("workflow_evolution_proposal", "unlinked-proposal", { lifecycle: "candidate" }), /storage parent is unavailable/u);
    assert.throws(() => store.create("workflow_evolution_proposal", "missing-parent-proposal", { request_id: "missing-request", lifecycle: "candidate" }), /storage parent is unavailable/u);
    assert.equal(store.find("workflow_evolution_proposal", "missing-parent-proposal", undefined, false), null);
    assert.throws(() => store.create("workflow_evolution_proposal", "wrong-parent-scope", { request_id: "project-request", scope: "global", lifecycle: "candidate" }), /scope differs from parent/u);
    const explicitGlobal = store.create("workflow_evolution_proposal", "explicit-global-proposal", { request_id: "missing-request", scope: "global", lifecycle: "candidate" });
    assert.equal(explicitGlobal.scope, "global");
    const globalHeader = store.database.prepare("SELECT payload_json FROM records WHERE kind='workflow_evolution_proposal' AND id='explicit-global-proposal'").get() as { payload_json: string };
    assert.deepEqual(JSON.parse(globalHeader.payload_json)._experience_partition.scope, { kind: "global", id: "global" });
    store.create("experience_shadow_experiment", "project-shadow-experiment", { scope: "project:request-project", lifecycle: "draft" });
    store.create("experience_shadow_evaluation", "project-shadow-evaluation", { experiment_id: "project-shadow-experiment", status: "passed" });
    assert.throws(() => store.create("experience_shadow_evaluation", "wrong-shadow-scope", { experiment_id: "project-shadow-experiment", scope: "global", status: "passed" }), /scope differs from parent/u);
    assert.throws(() => store.create("experience_shadow_evaluation", "unlinked-shadow-evaluation", { status: "passed" }), /storage parent is unavailable/u);
    assert.throws(() => store.create("experience_shadow_evaluation", "missing-shadow-evaluation", { experiment_id: "missing-experiment", status: "passed" }), /storage parent is unavailable/u);
    store.create("experience_shadow_evaluation", "global-shadow-evaluation", { scope: "global", status: "passed" });
    store.create("experience_observation", "project-id-observation", { project_id: "request-project", outcome: "passed" });
    const projectIdHeader = store.database.prepare("SELECT payload_json FROM records WHERE kind='experience_observation' AND id='project-id-observation'").get() as { payload_json: string };
    assert.equal((JSON.parse(projectIdHeader.payload_json)._experience_partition as JsonObject).file, pointer.file);
    store.create("workflow_evolution_request", "object-scope-request", {
      observation_refs: [{ source: { scope: { kind: "project", id: "request-project" } } }], lifecycle: "awaiting_model",
    });
    store.create("workflow_evolution_request", "global-scope-request", {
      observation_refs: [{ source: { scope: "global" } }], lifecycle: "awaiting_model",
    });
    store.create("workflow_evolution_request", "unscoped-source-request", {
      observation_refs: [{ source: {} }], lifecycle: "awaiting_model",
    });
    store.create("workflow_evolution_request", "missing-source-request", {
      observation_refs: [{}], lifecycle: "awaiting_model",
    });
    store.create("workflow_evolution_request", "null-observation-refs-request", {
      observation_refs: null, lifecycle: "awaiting_model",
    });
    assert.throws(() => store.create("workflow_evolution_request", "malformed-string-scope", {
      observation_refs: [{ source: { scope: ":" } }], lifecycle: "awaiting_model",
    }), /scope is malformed/u);
    assert.throws(() => store.create("workflow_evolution_request", "malformed-object-scope", {
      observation_refs: [{ source: { scope: { kind: "project", id: " " } } }], lifecycle: "awaiting_model",
    }), /scope is malformed/u);
    assert.throws(() => store.create("workflow_evolution_request", "malformed-array-scope", {
      observation_refs: [{ source: { scope: [] } }], lifecycle: "awaiting_model",
    }), /scope is malformed/u);
    assert.throws(() => store.create("workflow_evolution_request", "mixed-request", {
      observation_refs: [
        { source: { scope: "project:request-project" } },
        { source: { scope: "project:another-project" } },
      ], lifecycle: "awaiting_model",
    }), /different scopes/u);
    assert.equal(store.find("workflow_evolution_request", "mixed-request", undefined, false), null);
    store.create("experience_observation", "session-observation", { scope: "session:experience-test-session", outcome: "passed" });
    const sessionHeader = store.database.prepare("SELECT payload_json FROM records WHERE kind='experience_observation' AND id='session-observation'").get() as { payload_json: string };
    assert.match(String((JSON.parse(sessionHeader.payload_json)._experience_partition as JsonObject).file), /experience\/scopes\/session-/u);
    const memoryPointer = (store as unknown as { memoryPointer(kind: string, id: string): JsonObject | null }).memoryPointer.bind(store);
    assert.equal(memoryPointer("memory_candidate", "not-found"), null);
    store.create("memory_candidate", "pointer-memory", { scope: { kind: "global", id: "global" }, content: "test" });
    assert.equal((memoryPointer("memory_candidate", "pointer-memory") as JsonObject).file, store.paths.memoryDatabaseFile);
    assert.deepEqual(memoryPointer("experience_observation", "session-observation"), null);
    assert.throws(() => store.create("experience_observation", "unregistered-project", { scope: "project:unregistered-project" }), /root is not registered/u);
    const ambiguousOne = join(root, "ambiguous-one"), ambiguousTwo = join(root, "ambiguous-two"); mkdirSync(ambiguousOne); mkdirSync(ambiguousTwo);
    store.create("scope_alias", "ambiguous-experience-one", { scope: { kind: "project", id: "ambiguous-experience" }, alias_kind: "path", alias: ambiguousOne, status: "active" });
    store.create("scope_alias", "ambiguous-experience-two", { scope: { kind: "project", id: "ambiguous-experience" }, alias_kind: "path", alias: ambiguousTwo, status: "active" });
    assert.throws(() => store.create("experience_observation", "ambiguous-project", { scope: "project:ambiguous-experience" }), /root is ambiguous/u);
    const symlinkProject = join(root, "symlink-project"), externalExperience = join(root, "external-experience"); mkdirSync(symlinkProject); mkdirSync(externalExperience);
    symlinkSync(externalExperience, join(ensureProjectStorageDirectory(store.paths, symlinkProject), "experience"));
    store.create("scope_alias", "symlink-experience-root", { scope: { kind: "project", id: "symlink-experience" }, alias_kind: "path", alias: symlinkProject, status: "active" });
    assert.throws(() => store.create("experience_observation", "symlinked-experience", { scope: "project:symlink-experience" }), /regular directories/u);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Experience child write rechecks its parent under the publication lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-experience-parent-race-"));
  const projectRoot = join(root, "project"); mkdirSync(projectRoot);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    store.create("scope_alias", "parent-race-project", { scope: { kind: "project", id: "parent-race" }, alias_kind: "path", alias: projectRoot, status: "active" });
    store.create("workflow_evolution_request", "racing-parent", { scope: "project:parent-race", lifecycle: "awaiting_model" });
    const transaction = store.transaction.bind(store);
    let removed = false;
    store.transaction = ((operation) => {
      if (!removed) { removed = true; store.remove("workflow_evolution_request", "racing-parent"); }
      return transaction(operation);
    }) as typeof store.transaction;
    try {
      assert.throws(() => store.create("workflow_evolution_proposal", "racing-child", { request_id: "racing-parent", lifecycle: "candidate" }), /storage parent is unavailable/u);
    } finally { store.transaction = transaction; }
    assert.equal(store.find("workflow_evolution_proposal", "racing-child", undefined, false), null);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Experience reads report a stale partition pointer for direct and snapshot reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-experience-stale-pointer-"));
  const projectRoot = join(root, "project"); mkdirSync(projectRoot);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const scope = { kind: "project", id: "stale-experience" };
    store.create("scope_alias", "stale-experience-root", { scope, alias_kind: "path", alias: projectRoot, status: "active" });
    const file = projectCapabilityPath(store.paths, projectRoot, "experience", "experience.db"); ensureProjectStorageDirectory(store.paths, projectRoot); mkdirSync(dirname(file), { recursive: true });
    const partition = new DatabaseSync(file);
    partition.exec("CREATE TABLE records(kind TEXT,id TEXT,version INTEGER,payload_json TEXT,created_at TEXT,updated_at TEXT,PRIMARY KEY(kind,id,version))");
    partition.close();
    const now = new Date().toISOString();
    const pointer = (id: string) => ({ scope, _experience_partition: { file, scope } });
    for (const id of ["missing-direct", "missing-snapshot"]) store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("experience_observation", id, 1, JSON.stringify(pointer(id)), now, now);
    assert.throws(() => store.get("experience_observation", "missing-direct"), /Experience partition record is missing/u);
    assert.throws(() => store.listScoped("experience_observation", [scope], 10, () => true), /Experience partition record is missing/u);
    const missingRoot = join(root, "missing-root"); mkdirSync(missingRoot);
    const missingScope = { kind: "project", id: "missing-experience-root" };
    store.create("scope_alias", "missing-experience-root", { scope: missingScope, alias_kind: "path", alias: missingRoot, status: "active" });
    const missingFile = projectCapabilityPath(store.paths, missingRoot, "experience", "experience.db");
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("experience_observation", "missing-experience-db", 1, JSON.stringify({ scope: missingScope, _experience_partition: { scope: missingScope } }), now, now);
    assert.throws(() => store.get("experience_observation", "missing-experience-db"), /partition database is unavailable/u);
    assert.equal(existsSync(missingFile), false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a writer holding one project partition does not block writes to another project", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-experience-partition-isolation-"));
  const projectOne = join(root, "one"), projectTwo = join(root, "two"); mkdirSync(projectOne); mkdirSync(projectTwo);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const firstPath = projectCapabilityPath(store.paths, projectOne, "experience", "experience.db");
  let heldWriter: DatabaseSync | undefined;
  try {
    store.create("scope_alias", "experience-project-one", { scope: { kind: "project", id: "project-one" }, alias_kind: "path", alias: projectOne, status: "active" });
    store.create("scope_alias", "experience-project-two", { scope: { kind: "project", id: "project-two" }, alias_kind: "path", alias: projectTwo, status: "active" });
    // Initialize both partition files before holding the lock on project one.
    store.create("experience_observation", "one", { scope: "project:project-one", outcome: "passed" });
    store.create("experience_observation", "two", { scope: "project:project-two", outcome: "passed" });
    heldWriter = new DatabaseSync(firstPath);
    heldWriter.exec("BEGIN IMMEDIATE");
    const written = store.create("experience_observation", "two-more", { scope: "project:project-two", outcome: "passed" });
    assert.equal(written.outcome, "passed");
    const secondDb = new DatabaseSync(projectCapabilityPath(store.paths, projectTwo, "experience", "experience.db"), { readOnly: true });
    try { assert.equal(Number((secondDb.prepare("SELECT COUNT(*) count FROM records WHERE kind='experience_observation' AND id='two-more'").get() as { count: number }).count), 1); }
    finally { secondDb.close(); }
  } finally {
    try { heldWriter?.exec("ROLLBACK"); } catch { /* transaction was not started */ }
    heldWriter?.close(); store.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("legacy Experience records migrate idempotently from shared records into capability scopes", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-experience-legacy-migration-"));
  const dataRoot = join(root, "data"), projectRoot = join(root, "project"); mkdirSync(projectRoot);
  const paths = craftPaths(dataRoot);
  let store = await new CraftStore(paths).open();
  const now = new Date().toISOString();
  try {
    store.create("scope_alias", "experience-legacy-project-root", { scope: { kind: "project", id: "legacy-experience-project" }, alias_kind: "path", alias: projectRoot, status: "active" });
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("experience_observation", "legacy-global-observation", 1, JSON.stringify({ status: "recorded", evidence_ids: ["evidence"], source_session_id: "session-1" }), now, now);
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("workflow_evolution_observation", "legacy-project-observation", 1, JSON.stringify({ scenario_key: "build", source: { scope: "project:legacy-experience-project" }, outcome: "passed" }), now, now);
    for (const version of [1, 2]) {
      store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
        .run("workflow_evolution_request", "legacy-request", version, JSON.stringify({ observation_refs: [{ source: { scope: "project:legacy-experience-project" } }], revision: version }), now, now);
      store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
        .run("workflow_evolution_proposal", "legacy-proposal", version, JSON.stringify({ request_id: "legacy-request", revision: version }), now, now);
    }
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("workflow_evolution_proposal", "legacy-orphan-proposal", 1, JSON.stringify({ request_id: "missing-legacy-request", lifecycle: "candidate" }), now, now);
    store.close();
    store = await new CraftStore(paths).open();
    assert.equal(store.get("experience_observation", "legacy-global-observation").source_session_id, "session-1");
    assert.equal(store.get("workflow_evolution_proposal", "legacy-orphan-proposal").request_id, "missing-legacy-request");
    assert.equal((store.get("workflow_evolution_observation", "legacy-project-observation").source as JsonObject).scope, "project:legacy-experience-project");
    const primary = store.database.prepare("SELECT payload_json FROM records WHERE kind='experience_observation' AND id='legacy-global-observation'").get() as { payload_json: string };
    assert.equal(primary.payload_json.includes("session-1"), true);
    assert.equal(primary.payload_json.includes("recorded"), false);
    assert.equal(readdirSync(paths.backupsDir).length, 0, "Experience migration backup is scoped to the capability directory");
    const globalBackups = readdirSync(join(paths.experienceDir, "backups"));
    const projectBackupDir = projectCapabilityPath(paths, projectRoot, "experience", "backups");
    const projectBackups = readdirSync(projectBackupDir);
    assert.equal(globalBackups.length, 1);
    assert.equal(projectBackups.length, 1);
    const globalBackup = JSON.parse(readFileSync(join(paths.experienceDir, "backups", globalBackups[0]!), "utf8")) as JsonObject;
    const projectBackup = JSON.parse(readFileSync(join(projectBackupDir, projectBackups[0]!), "utf8")) as JsonObject;
    assert.deepEqual(globalBackup.scope, { kind: "global", id: "global" });
    assert.deepEqual(projectBackup.scope, { kind: "project", id: "legacy-experience-project" });
    assert.equal((globalBackup.records as JsonObject[]).some(row => row.id === "legacy-project-observation"), false);
    assert.equal((projectBackup.records as JsonObject[]).some(row => row.id === "legacy-project-observation"), true);
    assert.equal((projectBackup.records as JsonObject[]).filter(row => row.id === "legacy-proposal").length, 2);
    assert.equal((globalBackup.records as JsonObject[]).some(row => row.id === "legacy-proposal"), false);
    for (const version of [1, 2]) {
      const row = store.database.prepare("SELECT payload_json FROM records WHERE kind='workflow_evolution_proposal' AND id='legacy-proposal' AND version=?").get(version) as { payload_json: string };
      assert.equal(JSON.parse(row.payload_json)._experience_partition.scope.id, "legacy-experience-project");
      assert.equal(store.get("workflow_evolution_proposal", "legacy-proposal", version).revision, version);
    }
    store.close();
    store = await new CraftStore(paths).open();
    assert.equal(store.get("experience_observation", "legacy-global-observation").status, "recorded");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("legacy Experience migration rejects a conflicting partition version", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-experience-partition-collision-"));
  const paths = craftPaths(join(root, "data"));
  let store = await new CraftStore(paths).open();
  try {
    store.create("experience_observation", "legacy-experience-collision", { scope: "global:global", status: "partition", evidence_ids: ["e1"] });
    const now = new Date().toISOString();
    store.database.prepare("DELETE FROM records WHERE kind='experience_observation' AND id='legacy-experience-collision'").run();
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("experience_observation", "legacy-experience-collision", 1, JSON.stringify({ status: "legacy-conflict", evidence_ids: ["e2"] }), now, now);
    store.close();
    store = new CraftStore(paths);
    await assert.rejects(store.open(), /Experience migration collision/u);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("legacy migrations accept an identical partition publication that wins after the initial read", async () => {
  for (const domain of ["memory", "experience"] as const) {
    const root = mkdtempSync(join(tmpdir(), `craft-${domain}-migration-race-`));
    const paths = craftPaths(join(root, "data"));
    let store = await new CraftStore(paths).open();
    try {
      const kind = domain === "memory" ? "memory_candidate" : "experience_observation";
      const id = `raced-${domain}`;
      const payload = { scope: { kind: "global", id: "global" }, status: domain === "memory" ? "candidate" : "recorded" };
      const now = new Date().toISOString();
      store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,1,?,?,?)")
        .run(kind, id, JSON.stringify(payload), now, now);
      store.close();

      const reopening = new CraftStore(paths);
      const internals = reopening as unknown as {
        backupLegacyPartitionRecords: (target: "memory" | "experience", rows: Array<Record<string, unknown>>) => void;
        memoryScope: (recordKind: string, value: JsonObject) => { kind: string; id: string };
        memoryDatabase: (scope: { kind: string; id: string }, target: "memory" | "experience") => { database: DatabaseSync; file: string };
        memoryHeader: (value: JsonObject, scope: { kind: string; id: string }, file: string, target: "memory" | "experience") => JsonObject;
        updateMemoryContentIndex: (database: DatabaseSync, recordKind: string, recordId: string, version: number,
          value: JsonObject, updatedAt: string, target: "memory" | "experience") => void;
        transactionOn: <T>(database: DatabaseSync, operation: () => T) => T;
      };
      const publishBackup = internals.backupLegacyPartitionRecords.bind(reopening);
      internals.backupLegacyPartitionRecords = (target, rows) => {
        publishBackup(target, rows);
        for (const row of rows) {
          const recordKind = String(row.kind), recordId = String(row.id), version = Number(row.version);
          const original = JSON.parse(String(row.payload_json)) as JsonObject;
          const scope = internals.memoryScope(recordKind, { ...original, id: recordId });
          const partition = internals.memoryDatabase(scope, target);
          internals.transactionOn(partition.database, () => {
            partition.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
              .run(recordKind, recordId, version, JSON.stringify(original), String(row.created_at), String(row.updated_at));
            internals.updateMemoryContentIndex(partition.database, recordKind, recordId, version, original, String(row.updated_at), target);
          });
          const header = internals.memoryHeader(original, scope, partition.file, target);
          reopening.database.prepare("UPDATE records SET payload_json=? WHERE kind=? AND id=? AND version=?")
            .run(JSON.stringify(header), recordKind, recordId, version);
        }
      };
      store = await reopening.open();
      assert.equal(store.get(kind, id).status, payload.status);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test("legacy migrations fail closed when a concurrent main record edit defeats the publication CAS", async () => {
  for (const domain of ["memory", "experience"] as const) {
    const root = mkdtempSync(join(tmpdir(), `craft-${domain}-migration-cas-`));
    const paths = craftPaths(join(root, "data"));
    let store = await new CraftStore(paths).open();
    const kind = domain === "memory" ? "memory_candidate" : "experience_observation";
    const id = `cas-${domain}`;
    const payload = { scope: { kind: "global", id: "global" }, status: "legacy" };
    const now = new Date().toISOString();
    try {
      store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,1,?,?,?)")
        .run(kind, id, JSON.stringify(payload), now, now);
      store.database.exec(`CREATE TRIGGER ignore_${domain}_migration BEFORE UPDATE ON records WHEN OLD.kind='${kind}' AND OLD.id='${id}' BEGIN SELECT RAISE(IGNORE); END;`);
      store.close();
      store = new CraftStore(paths);
      await assert.rejects(store.open(), new RegExp(`${domain === "memory" ? "Memory" : "Experience"} migration changed concurrently`, "u"));
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test("capability migration snapshots are private, idempotent, and safe under concurrent publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-capability-migration-backup-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const backupRecords = (store as unknown as { backupLegacyPartitionRecords(domain: "memory" | "experience", rows: Array<Record<string, unknown>>, ops?: {
    write: typeof writeFileSync; rename: typeof renameSync; unlink: typeof unlinkSync;
  }): void }).backupLegacyPartitionRecords.bind(store);
  const rows = [{ kind: "experience_observation", id: "backup-row", version: 1, payload_json: "{\"content\":\"private\"}",
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }];
  const directory = join(store.paths.experienceDir, "backups");
  try {
    backupRecords("experience", rows);
    let files = readdirSync(directory);
    assert.equal(files.length, 1);
    const target = join(directory, files[0]!);
    assert.equal((statSync(target).mode & 0o777), 0o600);
    backupRecords("experience", rows);
    assert.equal(readdirSync(directory).length, 1);
    writeFileSync(target, "conflicting backup");
    assert.throws(() => backupRecords("experience", rows), /backup identity conflict/u);
    unlinkSync(target);
    mkdirSync(target);
    assert.throws(() => backupRecords("experience", rows), /regular file/u);
    rmSync(target, { recursive: true, force: true });
    const external = join(root, "external.json"); writeFileSync(external, "outside"); symlinkSync(external, target);
    assert.throws(() => backupRecords("experience", rows), /regular file/u);
    unlinkSync(target);

    const concurrentWriter = { write: writeFileSync, unlink: unlinkSync, rename: (temporary: PathLike, destination: PathLike) => {
      writeFileSync(destination, readFileSync(temporary, "utf8"), { flag: "wx", mode: 0o600 });
      throw new Error("simulated competing publisher");
    } };
    backupRecords("experience", rows, concurrentWriter);
    assert.equal(readdirSync(directory).length, 1);
    unlinkSync(target);
    const conflictingPublisher = { ...concurrentWriter, rename: (_temporary: PathLike, destination: PathLike) => {
      writeFileSync(destination, "different concurrent snapshot", { flag: "wx", mode: 0o600 });
      throw new Error("simulated conflicting publisher");
    } };
    assert.throws(() => backupRecords("experience", rows, conflictingPublisher), /conflicting publisher/u);
    unlinkSync(target);

    const failedWrite = { write: (() => { throw new Error("simulated disk failure"); }) as typeof writeFileSync,
      rename: renameSync, unlink: unlinkSync };
    assert.throws(() => backupRecords("experience", rows, failedWrite), /simulated disk failure/u);
    let temporaryDirectory = "";
    const failedWriteWithCleanupError = { write: ((path: string) => { temporaryDirectory = path; mkdirSync(path); throw new Error("simulated write failure"); }) as typeof writeFileSync,
      rename: renameSync, unlink: unlinkSync };
    try { assert.throws(() => backupRecords("experience", rows, failedWriteWithCleanupError), /EISDIR|EPERM|directory/u); }
    finally { if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true }); }

    const symlinkRaceRows = [{ ...rows[0]!, id: "symlink-race" }];
    const symlinkRaceExternal = join(root, "concurrent-external.json"); writeFileSync(symlinkRaceExternal, "outside");
    const symlinkPublisher = { write: writeFileSync, unlink: unlinkSync, rename: (_temporary: PathLike, destination: PathLike) => {
      symlinkSync(symlinkRaceExternal, destination); throw new Error("simulated symlink publisher");
    } };
    assert.throws(() => backupRecords("experience", symlinkRaceRows, symlinkPublisher), /regular file/u);
    const symlinkRaceFile = readdirSync(directory).find(name => name.includes(".tmp") === false && name.startsWith("legacy-partition-"));
    if (symlinkRaceFile) unlinkSync(join(directory, symlinkRaceFile));

    store.close();
    const externalMemory = join(root, "external-memory"); mkdirSync(externalMemory);
    const movedMemory = `${store.paths.memoryDir}.real`; renameSync(store.paths.memoryDir, movedMemory); symlinkSync(externalMemory, store.paths.memoryDir);
    assert.throws(() => backupRecords("memory", rows), /backup root must be a regular directory/u);
    unlinkSync(store.paths.memoryDir); renameSync(movedMemory, store.paths.memoryDir);
    const movedBackups = join(store.paths.experienceDir, "backups.real"); renameSync(directory, movedBackups); symlinkSync(root, directory);
    assert.throws(() => backupRecords("experience", rows), /backup path must be a regular directory/u);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("partitioned Memory optimistic updates reject stale writers across store connections", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-cas-"));
  const paths = craftPaths(join(root, "data"));
  const first = await new CraftStore(paths).open();
  const second = await new CraftStore(paths).open();
  try {
    const created = first.create("memory_candidate", "shared", { scope: { kind: "global", id: "global" }, status: "candidate", content: "initial" });
    const stale = second.get("memory_candidate", "shared");
    const winner = first.updateIfVersion("memory_candidate", "shared", Number(created.version), { ...created, content: "winner" });
    assert.equal(winner.version, 2);
    assert.throws(() => second.save("memory_candidate", "shared", { ...stale, content: "stale save" }), /Concurrent update detected/u);
    assert.throws(() => second.updateIfVersion("memory_candidate", "shared", Number(stale.version), { ...stale, content: "stale" }), /Concurrent update detected/u);
    assert.equal(first.get("memory_candidate", "shared").content, "winner");
    const partition = new DatabaseSync(paths.memoryDatabaseFile);
    try { assert.equal(Number((partition.prepare("SELECT COUNT(*) count FROM records WHERE kind=? AND id=?").get("memory_candidate", "shared") as { count: number }).count), 2); }
    finally { partition.close(); }
  } finally { second.close(); first.close(); rmSync(root, { recursive: true, force: true }); }
});

test("partition publication rechecks a racing writer and removes its uncommitted version", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-race-"));
  const paths = craftPaths(join(root, "data"));
  const first = await new CraftStore(paths).open();
  const second = await new CraftStore(paths).open();
  try {
    const created = first.create("memory_candidate", "racing", { scope: { kind: "global", id: "global" }, status: "candidate", content: "initial" });
    const publish = first.transaction.bind(first);
    let injected = false;
    first.transaction = ((operation) => {
      if (!injected) {
        injected = true;
        second.updateIfVersion("memory_candidate", "racing", Number(created.version), { ...created, content: "concurrent winner" });
      }
      return publish(operation);
    }) as typeof first.transaction;
    assert.throws(() => first.updateIfVersion("memory_candidate", "racing", Number(created.version), { ...created, content: "stale writer" }), /Concurrent update detected/u);
    assert.equal(first.get("memory_candidate", "racing").content, "concurrent winner");
    const partition = new DatabaseSync(paths.memoryDatabaseFile);
    try { assert.equal(Number((partition.prepare("SELECT COUNT(*) count FROM records WHERE kind=? AND id=?").get("memory_candidate", "racing") as { count: number }).count), 2); }
    finally { partition.close(); }
  } finally { second.close(); first.close(); rmSync(root, { recursive: true, force: true }); }
});

test("partitioned create rechecks the partition after acquiring its writer lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-create-race-"));
  const paths = craftPaths(join(root, "data"));
  const store = await new CraftStore(paths).open();
  try {
    const internals = store as unknown as { transactionOn<T>(database: DatabaseSync, operation: () => T): T };
    const transactionOn = internals.transactionOn.bind(store);
    let injected = false;
    internals.transactionOn = (database, operation) => {
      if (!injected) {
        injected = true;
        database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
          .run("memory_candidate", "racing-create", 1, JSON.stringify({ scope: { kind: "global", id: "global" } }), new Date().toISOString(), new Date().toISOString());
      }
      return transactionOn(database, operation);
    };
    assert.throws(() => store.create("memory_candidate", "racing-create", { scope: { kind: "global", id: "global" }, content: "candidate" }), /memory_candidate already exists/u);
    assert.equal(store.find("memory_candidate", "racing-create", undefined, false), null);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Memory publication rejects a concurrent create or scope change under the main writer lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-pointer-race-"));
  const paths = craftPaths(join(root, "data"));
  const store = await new CraftStore(paths).open();
  try {
    const injectPointer = (id: string, scope: JsonObject) => {
      const transaction = store.transaction.bind(store);
      let injected = false;
      store.transaction = ((operation) => {
        if (!injected) {
          injected = true;
          const now = new Date().toISOString();
          store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
            .run("memory_candidate", id, 1, JSON.stringify({ scope, _memory_partition: { file: paths.memoryDatabaseFile, scope } }), now, now);
        }
        return transaction(operation);
      }) as typeof store.transaction;
      return () => { store.transaction = transaction; };
    };
    const restoreCreate = injectPointer("racing-create-main", { kind: "global", id: "global" });
    try { assert.throws(() => store.create("memory_candidate", "racing-create-main", { scope: { kind: "global", id: "global" }, content: "candidate" }), /memory_candidate already exists/u); }
    finally { restoreCreate(); }

    store.create("memory_candidate", "racing-scope-main", { scope: { kind: "global", id: "global" }, content: "initial" });
    const transaction = store.transaction.bind(store);
    let injected = false;
    store.transaction = ((operation) => {
      if (!injected) {
        injected = true;
        const latest = store.find("memory_candidate", "racing-scope-main", undefined, false)!;
        const changedScope = { kind: "user", id: "other" };
        store.database.prepare("UPDATE records SET payload_json=? WHERE kind=? AND id=? AND version=?")
          .run(JSON.stringify({ ...latest, scope: changedScope }), "memory_candidate", "racing-scope-main", Number(latest.version));
      }
      return transaction(operation);
    }) as typeof store.transaction;
    try { assert.throws(() => store.save("memory_candidate", "racing-scope-main", { scope: { kind: "global", id: "global" }, content: "candidate" }), /cannot change storage scope/u); }
    finally { store.transaction = transaction; }
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("optimistic save cannot republish a row concurrently removed from its partition", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-save-remove-race-"));
  const paths = craftPaths(join(root, "data"));
  const first = await new CraftStore(paths).open();
  const second = await new CraftStore(paths).open();
  try {
    const created = first.create("memory_candidate", "save-remove-race", {
      scope: { kind: "global", id: "global" }, status: "candidate", content: "initial",
      content_ref: { kind: "memory", record_id: "save-remove-race", version: 1, path: "/unused" },
    });
    const originalTransaction = first.transaction.bind(first);
    let removedBetweenStageAndPublish = false;
    first.transaction = ((operation) => {
      if (!removedBetweenStageAndPublish) {
        removedBetweenStageAndPublish = true;
        assert.ok(second.remove("memory_candidate", "save-remove-race") >= 1);
      }
      return originalTransaction(operation);
    }) as typeof first.transaction;

    assert.throws(() => first.save("memory_candidate", "save-remove-race", {
      ...created, content: "stale concurrent save",
      content_ref: { kind: "memory", record_id: "save-remove-race", version: 2, path: "/unused" },
    }), /Concurrent update detected/u);
    first.transaction = originalTransaction;
    assert.equal(first.find("memory_candidate", "save-remove-race"), null);
    const partition = new DatabaseSync(paths.memoryDatabaseFile);
    try {
      assert.equal(Number((partition.prepare("SELECT COUNT(*) count FROM records WHERE kind=? AND id=?").get("memory_candidate", "save-remove-race") as { count: number }).count), 0);
      assert.equal(Number((partition.prepare("SELECT COUNT(*) count FROM content_index WHERE kind=? AND id=?").get("memory_candidate", "save-remove-race") as { count: number }).count), 0);
    } finally { partition.close(); }
  } finally { second.close(); first.close(); rmSync(root, { recursive: true, force: true }); }
});

test("ready Memory partitions can be opened and read while another connection owns the writer lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-read-lock-"));
  const paths = craftPaths(join(root, "data"));
  const initial = await new CraftStore(paths).open();
  initial.create("memory_candidate", "shared", { scope: { kind: "global", id: "global" }, status: "candidate", content: "readable" });
  initial.close();
  const writer = new DatabaseSync(paths.memoryDatabaseFile);
  let reader: CraftStore | undefined;
  try {
    writer.exec("BEGIN IMMEDIATE");
    reader = await new CraftStore(paths).open();
    assert.equal(reader.get("memory_candidate", "shared").content, "readable");
  } finally {
    reader?.close();
    try { writer.exec("ROLLBACK"); } catch { /* closed or already rolled back */ }
    writer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("reading a missing partition fails closed without creating or migrating it", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-read-missing-"));
  const paths = craftPaths(join(root, "data"));
  const store = await new CraftStore(paths).open();
  try {
    store.create("memory_candidate", "missing-read-partition", { scope: { kind: "global", id: "global" }, content: "payload" });
    store.closeMemoryScope({ kind: "global", id: "global" });
    rmSync(paths.memoryDatabaseFile, { force: true });
    assert.throws(() => store.get("memory_candidate", "missing-read-partition"), /partition database is unavailable/u);
    assert.equal(existsSync(paths.memoryDatabaseFile), false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("reading a missing project partition does not create project storage directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-read-missing-project-"));
  const projectRoot = join(root, "project"); mkdirSync(projectRoot);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const scope = { kind: "project", id: "missing-project-partition" };
  try {
    store.create("scope_alias", "missing-project-root", { scope, alias_kind: "path", alias: projectRoot, status: "active" });
    const now = new Date().toISOString();
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("memory_candidate", "missing-project-partition", 1, JSON.stringify({ scope, _memory_partition: { scope } }), now, now);
    assert.throws(() => store.get("memory_candidate", "missing-project-partition"), /partition database is unavailable/u);
    assert.equal(existsSync(join(projectRoot, ".craft_data")), false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("failed read-only partition setup closes the handle and allows a later read", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-read-setup-error-"));
  const paths = craftPaths(join(root, "data"));
  const writer = await new CraftStore(paths).open();
  writer.create("memory_candidate", "read-setup-error", { scope: { kind: "global", id: "global" }, content: "readable" });
  writer.close();
  const reader = await new CraftStore(paths).open();
  const prototype = DatabaseSync.prototype as unknown as { exec: (this: DatabaseSync, sql: string) => void };
  const originalExec = prototype.exec;
  try {
    prototype.exec = function (sql: string): void {
      if (sql.includes("query_only=ON")) throw new Error("forced read-only setup failure");
      originalExec.call(this, sql);
    };
    assert.throws(() => reader.get("memory_candidate", "read-setup-error"), /forced read-only setup failure/u);
    prototype.exec = originalExec;
    assert.equal(reader.get("memory_candidate", "read-setup-error").content, "readable");
  } finally { prototype.exec = originalExec; reader.close(); rmSync(root, { recursive: true, force: true }); }
});

test("read-only partition access rejects symlink and non-file paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-read-unsafe-path-"));
  const paths = craftPaths(join(root, "data"));
  const writer = await new CraftStore(paths).open();
  writer.create("memory_candidate", "unsafe-read-path", { scope: { kind: "global", id: "global" }, content: "payload" });
  writer.close();
  const moved = `${paths.memoryDatabaseFile}.moved`;
  renameSync(paths.memoryDatabaseFile, moved);
  symlinkSync(moved, paths.memoryDatabaseFile);
  const reader = await new CraftStore(paths).open();
  try {
    assert.throws(() => reader.get("memory_candidate", "unsafe-read-path"), /regular file/u);
    rmSync(paths.memoryDatabaseFile);
    mkdirSync(paths.memoryDatabaseFile);
    assert.throws(() => reader.get("memory_candidate", "unsafe-read-path"), /regular file/u);
  } finally { reader.close(); rmSync(root, { recursive: true, force: true }); }
});

test("domain index rebuild surfaces unexpected SQLite schema errors and closes its store", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-domain-index-schema-error-"));
  const paths = craftPaths(join(root, "data"));
  mkdirSync(dirname(paths.experienceDatabaseFile), { recursive: true });
  const malformed = new DatabaseSync(paths.experienceDatabaseFile);
  malformed.exec("CREATE TABLE content_index (unexpected TEXT)");
  malformed.close();
  const store = new CraftStore(paths);
  try {
    await assert.rejects(store.open(), /no such column: kind/u);
    assert.throws(() => store.count("experience_observation"), /not open/u);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("domain index rebuild and verification sort multiple content references", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-domain-index-sort-"));
  const paths = craftPaths(join(root, "data"));
  let store = await new CraftStore(paths).open();
  try {
    store.create("scope_alias", "codebase", { scope: { kind: "project", id: "codebase" }, alias_kind: "path", alias: root, status: "active" });
    for (const id of ["claim-a", "claim-b"]) store.create("knowledge_claim", id, {
      scope: "project:codebase", content_ref: { kind: "knowledge", record_id: id, version: 1, path: `/knowledge/${id}.md` },
    });
    store.close();
    store = await new CraftStore(paths).open();
    const indexed = store.database.prepare("SELECT id FROM records WHERE kind='knowledge_claim' ORDER BY id").all() as Array<{ id: string }>;
    assert.deepEqual(indexed.map(row => row.id), ["claim-a", "claim-b"]);
    store.close();
    store = await new CraftStore(paths).open();
    const contentIndex = new DatabaseSync(paths.knowledgeDatabaseFile);
    try {
      assert.equal(Number((contentIndex.prepare("SELECT COUNT(*) count FROM content_index").get() as { count: number }).count), 2);
    } finally { contentIndex.close(); }
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("project Memory roots reject ambiguous aliases and ignore malformed or non-directory aliases", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-project-roots-"));
  const projectOne = join(root, "one"), projectTwo = join(root, "two"), projectThree = join(root, "three"), file = join(root, "not-a-directory");
  mkdirSync(projectOne); mkdirSync(projectTwo); mkdirSync(projectThree); writeFileSync(file, "file");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    store.create("scope_alias", "root-one", { scope: { kind: "project", id: "ambiguous" }, alias_kind: "path", alias: projectOne, status: "active" });
    store.create("scope_alias", "root-two", { scope: { kind: "project", id: "ambiguous" }, alias_kind: "path", alias: projectTwo, status: "active" });
    assert.throws(() => store.create("memory_candidate", "ambiguous", { scope: { kind: "project", id: "ambiguous" }, content: "reject" }), /root is ambiguous/);

    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES('scope_alias','broken-json',1,?,?,?)")
      .run("{", new Date().toISOString(), new Date().toISOString());
    store.create("scope_alias", "root-file", { scope: { kind: "project", id: "file-alias" }, alias_kind: "path", alias: file, status: "active" });
    assert.throws(() => store.create("memory_candidate", "file-root", { scope: { kind: "project", id: "file-alias" }, content: "reject" }), /root is not registered/);
    store.create("scope_alias", "legacy-project-alias", { scope: { kind: "project", id: "old-project" }, alias_kind: "legacy", alias: "current-project", status: "active" });
    store.create("scope_alias", "legacy-project-path", { scope: { kind: "project", id: "old-project" }, alias_kind: "path", alias: projectThree, status: "active" });
    store.create("memory_candidate", "legacy-project-root", { scope: { kind: "project", id: "current-project" }, content: "resolves through a legacy alias" });
    assert.equal(existsSync(projectCapabilityPath(store.paths, projectThree, "memory", "memory.db")), true);
    assert.equal(store.contentStore.isCanonicalRef({ kind: "memory", record_id: "empty-project", version: 1,
      path: join(root, "empty", ".craft_data", "memory", "md", "empty-project.v1.md"), scope: "project:" }), false);
    assert.equal(store.contentStore.isCanonicalRef({ kind: "memory", record_id: "not-created", version: 1,
      path: join(projectThree, ".craft_data", "memory", "md", "not-created.v1.md"), scope: "project:current-project" }), false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("partition transactions roll back concurrent deletion and preserve orphan checks", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-partition-concurrent-delete-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const created = store.create("memory_candidate", "deleted-between-reads", { scope: { kind: "global", id: "global" }, content: "before" });
    const header = store.database.prepare("SELECT payload_json FROM records WHERE kind='memory_candidate' AND id='deleted-between-reads'").get() as { payload_json: string };
    const pointer = JSON.parse(header.payload_json) as JsonObject;
    const partition = new DatabaseSync(String((pointer._memory_partition as JsonObject).file));
    partition.prepare("DELETE FROM records WHERE kind='memory_candidate' AND id='deleted-between-reads'").run();
    partition.close();
    const originalFind = store.find.bind(store);
    store.find = ((kind: string, id: string, version?: number, hydrate?: boolean) => kind === "memory_candidate" && id === "deleted-between-reads"
      ? created : originalFind(kind, id, version, hydrate)) as typeof store.find;
    assert.throws(() => store.replacePayload("memory_candidate", "deleted-between-reads", 1, { ...created, content: "after" }), /Unknown record version/);
    store.find = originalFind;

    store.create("memory_candidate", "orphaned-partition", { scope: { kind: "global", id: "global" }, content: "orphan" });
    const orphanHeader = store.database.prepare("SELECT payload_json FROM records WHERE kind='memory_candidate' AND id='orphaned-partition'").get() as { payload_json: string };
    const orphanPointer = JSON.parse(orphanHeader.payload_json) as JsonObject;
    const database = new DatabaseSync(String((orphanPointer._memory_partition as JsonObject).file));
    database.close();
    store.database.prepare("DELETE FROM records WHERE kind='memory_candidate' AND id='orphaned-partition'").run();
    assert.throws(() => store.create("memory_candidate", "orphaned-partition", { scope: { kind: "global", id: "global" }, content: "duplicate" }), /already exists/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("partition reads fail closed when a pointer outlives its stored Memory version", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-partition-stale-pointer-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const partitionFor = (id: string) => {
    const header = store.database.prepare("SELECT payload_json FROM records WHERE kind='memory_candidate' AND id=?").get(id) as { payload_json: string };
    const payload = JSON.parse(header.payload_json) as JsonObject;
    return new DatabaseSync(String((payload._memory_partition as JsonObject).file));
  };
  try {
    store.create("memory_candidate", "missing-version", { scope: { kind: "global", id: "global" }, status: "candidate", content: "gone" });
    const direct = partitionFor("missing-version");
    direct.prepare("DELETE FROM records WHERE kind='memory_candidate' AND id='missing-version'").run();
    direct.close();
    assert.throws(() => store.find("memory_candidate", "missing-version"), /partition record is missing/);

    store.create("memory_candidate", "snapshot-version", { scope: { kind: "global", id: "global" }, status: "candidate", content: "gone after pin" });
    assert.throws(() => store.listScoped("memory_candidate", [{ kind: "global", id: "global" }], 10, () => {
      const partition = partitionFor("snapshot-version");
      partition.prepare("DELETE FROM records WHERE kind='memory_candidate' AND id='snapshot-version'").run();
      partition.close();
      return true;
    }), /partition record is missing/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("legacy Memory migration refuses a conflicting pre-existing partition version", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-partition-collision-"));
  const paths = craftPaths(join(root, "data"));
  let store = await new CraftStore(paths).open();
  try {
    store.create("memory_candidate", "collision", { scope: { kind: "global", id: "global" }, status: "candidate", content: "partition copy" });
    store.database.prepare("DELETE FROM records WHERE kind='memory_candidate' AND id='collision'").run();
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES('memory_candidate','collision',1,?,?,?)")
      .run(JSON.stringify({ scope: { kind: "global", id: "global" }, status: "candidate", content: "legacy conflict" }), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    store.close();
    store = new CraftStore(paths);
    await assert.rejects(store.open(), /Memory migration collision/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("failed Memory migration closes the partially opened primary and partition databases", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-partition-open-failure-"));
  const paths = craftPaths(join(root, "data"));
  const store = new CraftStore(paths);
  (store as unknown as { migrateLegacyMemoryRecords(): void }).migrateLegacyMemoryRecords = () => {
    store.create("memory_ledger", "partial-open", { scope: { kind: "global", id: "global" }, content: "private", status: "active" });
    throw new Error("fixture migration failure");
  };
  try {
    await assert.rejects(store.open(), /fixture migration failure/);
    assert.throws(() => store.database, /not open/);
    const recovered = await new CraftStore(paths).open();
    recovered.close();
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});


test("legacy project Experience Markdown migrates with history and metadata intact", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-experience-markdown-migration-"));
  const project = join(root, "project"); mkdirSync(project);
  const paths = craftPaths(join(root, "data"));
  let store = await new CraftStore(paths).open();
  try {
    store.create("scope_alias", "markdown-project", { scope: { kind: "project", id: "markdown-project" }, alias_kind: "path", alias: project, status: "active" });
    const legacy = new MarkdownContentStore(paths);
    const originals = [1, 2].map(version => legacy.writeSync({ kind: "experience", record_id: "legacy-procedure", version,
      scope: "project:markdown-project", status: "candidate", sensitivity: "internal", source_id: "verified-task",
      body: `# 项目构建流程 ${version}`, folder: "workflows", frontmatter: { evidence_refs: '["e1"]', lifecycle: "candidate" } }));
    const now = new Date().toISOString();
    for (const ref of originals) store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("experience_procedure", "legacy-procedure", ref.version + 2, JSON.stringify({ scope: "project:markdown-project", content_ref: ref, evidence_ids: ["e1"] }), now, now);
    store.close();
    const destinationDir = projectCapabilityPath(store.paths, project, "experience", "md", "workflows");
    mkdirSync(destinationDir, { recursive: true });
    const conflictingTarget = join(destinationDir, basename(originals[0]!.path));
    writeFileSync(conflictingTarget, "existing conflicting content");
    await assert.rejects(new CraftStore(paths).open(), /destination conflicts/);
    const unchanged = new DatabaseSync(paths.databaseFile, { readOnly: true });
    try {
      const row = unchanged.prepare("SELECT payload_json FROM records WHERE kind='experience_procedure' AND id='legacy-procedure' AND version=3").get() as { payload_json: string };
      assert.equal(JSON.parse(row.payload_json)._experience_partition, undefined);
      assert.equal(JSON.parse(row.payload_json).content_ref.path, originals[0]!.path);
    } finally { unchanged.close(); }
    unlinkSync(conflictingTarget);
    for (let reopen = 0; reopen < 2; reopen++) {
      store = await new CraftStore(paths).open();
      for (const original of originals) {
        const record = store.get("experience_procedure", "legacy-procedure", original.version + 2);
        const next = record.content_ref as typeof original;
        assert.equal(next.path.startsWith(projectCapabilityPath(store.paths, project, "experience", "md", "workflows")), true);
        assert.equal(next.version, original.version);
        assert.equal(next.digest, original.digest);
        assert.deepEqual(readFileSync(next.path), readFileSync(original.path));
        assert.deepEqual(record.evidence_ids, ["e1"]);
        assert.equal(store.contentStore.readSync(next).manifest.evidence_refs, '["e1"]');
      }
      store.close();
    }
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});


test("definition location updates preserve historical versions and reject stale or changed identities", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-definition-location-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const ref = { format: "json", procedure_id: "p", procedure_version: 1, kind: "workflow", scope: "global", digest: "sha256:fixture", path: "/old.json" };
    const record = store.create("experience_procedure", "p", { scope: "global", definition_ref: ref, definition_digest: ref.digest, lifecycle: "candidate" });
    const next = { ...ref, path: "/new.json" };
    for (const key of ["format", "procedure_id", "procedure_version", "kind", "digest"]) {
      assert.throws(() => store.relocateExperienceDefinition("p", 1, ref, { ...next, [key]: "changed" }), /cannot change identity/);
    }
    for (const path of [null, " "]) assert.throws(() => store.relocateExperienceDefinition("p", 1, ref, { ...next, path }), /requires a path/);
    assert.throws(() => store.relocateExperienceDefinition("missing", 1, ref, next), /record is missing/);
    assert.throws(() => store.relocateExperienceDefinition("p", 1, ref, { ...next, scope: "project:other" }), /cannot change scope/);
    assert.throws(() => store.relocateExperienceDefinition("p", 1, { ...ref, path: "/stale.json" }, next), /changed concurrently/);
    store.relocateExperienceDefinition("p", 1, ref, next);
    store.relocateExperienceDefinition("p", 1, ref, next);
    assert.deepEqual(store.get("experience_procedure", "p"), { ...record, definition_ref: next });
    const partition = new DatabaseSync(store.paths.experienceDatabaseFile);
    try { partition.prepare("DELETE FROM records WHERE kind='experience_procedure' AND id='p'").run(); }
    finally { partition.close(); }
    assert.throws(() => store.relocateExperienceDefinition("p", 1, next, ref), /record is missing/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("opening repairs missing schema metadata and incomplete current metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-schema-repair-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    store.database.exec("ALTER TABLE meta DROP COLUMN applied_at");
    store.close(); await store.open();
    assert.ok((store.database.prepare("PRAGMA table_info(meta)").all() as Array<{ name: string }>).some(column => column.name === "applied_at"));
    store.database.exec("DELETE FROM meta WHERE key='schema_version'");
    store.close(); await store.open();
    assert.ok(store.database.prepare("SELECT value FROM meta WHERE key='schema_version'").get());
    assert.throws(() => store.contentStore.writeSync({ kind: "experience", record_id: "missing-root", version: 1,
      scope: "project:unregistered", status: "candidate", sensitivity: "internal", source_id: "source", body: "verified content" }), /registered project root/);
    store.create("memory_confirmation", "explicit-string-scope", { scope: "global" });
    const confirmation = store.create("memory_confirmation", "invalid-parent-type", { memory_id: 42 });
    assert.deepEqual(confirmation.scope, { kind: "global", id: "global" });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
