import assert from "node:assert/strict";
import { mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { CraftStore, SCHEMA_VERSION } from "../src/infrastructure/store.ts";
import {
  applyMigrations, backupDatabase, findMigration, MIGRATIONS, _internalsForTest,
} from "../src/infrastructure/store-migrations.ts";

function memoryDatabase(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value?: string } | undefined;
  return Number(row?.value ?? 0);
}

test("fresh database applies the full migration chain in order", () => {
  const db = memoryDatabase();
  const result = applyMigrations(db, SCHEMA_VERSION);
  assert.equal(result.from, 0);
  assert.equal(result.to, SCHEMA_VERSION);
  assert.equal(result.applied, MIGRATIONS.length);
  assert.equal(schemaVersion(db), SCHEMA_VERSION);
  // v4 surfaces the new tables; v0 did not have them.
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => (r as { name: string }).name);
  assert.ok(tables.includes("effect_log"));
  assert.ok(tables.includes("policy_evaluations"));
});

test("repairs a legacy database that recorded v4 without meta.applied_at", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO meta(key,value) VALUES('schema_version','4');");
  const result = applyMigrations(db, SCHEMA_VERSION);
  assert.equal(result.applied, 0);
  assert.ok((db.prepare("PRAGMA table_info(meta)").all() as Array<{ name: string }>).some((column) => column.name === "applied_at"));
  db.close();
});

test("already-current database reports zero applied and does not throw", () => {
  const db = memoryDatabase();
  applyMigrations(db, SCHEMA_VERSION);
  const result = applyMigrations(db, SCHEMA_VERSION);
  assert.equal(result.applied, 0);
  assert.equal(result.from, SCHEMA_VERSION);
  assert.equal(result.to, SCHEMA_VERSION);
});

test("dry-run does not touch the database", () => {
  const db = memoryDatabase();
  const result = applyMigrations(db, SCHEMA_VERSION, { dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.applied, MIGRATIONS.length);
  assert.equal(schemaVersion(db), 0, "dry-run must not advance schema_version");
});

test("findMigration walks backward and swaps up/down", () => {
  // Begin at the latest schema, request a step back.
  const path = findMigration(SCHEMA_VERSION, SCHEMA_VERSION - 1);
  assert.equal(path.length, 1);
  assert.equal(path[0].from, SCHEMA_VERSION - 1);
  assert.equal(path[0].to, SCHEMA_VERSION);
  // Executing the swapped `up` (i.e. the original `down`) must drop the v3→v4
  // tables on a fresh v4 database.
  const db = memoryDatabase();
  applyMigrations(db, SCHEMA_VERSION);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => (r as { name: string }).name);
  assert.ok(tables.includes("effect_log"));
  path[0].up(db);
  const after = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => (r as { name: string }).name);
  assert.ok(!after.includes("effect_log"), "swap-down must drop effect_log");
  assert.ok(!after.includes("policy_evaluations"), "swap-down must drop policy_evaluations");
});

test("a failed migration rolls back the transaction and leaves schema unchanged", () => {
  const db = memoryDatabase();
  applyMigrations(db, 2);
  const versionBefore = schemaVersion(db);
  assert.throws(() => {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("ALTER TABLE records ADD COLUMN broken TEXT");
      throw new Error("simulated failure after partial DDL");
    } finally {
      db.exec("ROLLBACK");
    }
  }, /simulated failure/);
  assert.equal(schemaVersion(db), versionBefore, "ROLLBACK must leave schema_version intact");
  // The simulated column from the rolled-back tx must not persist.
  const cols = db.prepare("PRAGMA table_info(records)").all().map((r) => (r as { name: string }).name);
  assert.ok(!cols.includes("broken"));
});

test("backupDatabase writes a copy next to backupsDir with timestamp", async () => {
  const root = join(tmpdir(), `craft-migrate-${process.pid}-${Date.now()}-${Math.random()}`);
  await mkdir(root, { recursive: true });
  try {
    const source = join(root, "craft.db");
    const db = new DatabaseSync(source);
    db.exec("CREATE TABLE t(x INTEGER); INSERT INTO t VALUES(1);");
    db.close();
    const backupPath = backupDatabase(source, join(root, "backups"));
    assert.ok(backupPath.includes("backups"));
    assert.ok(backupPath.includes("craft-"));
    // Open the backup and verify the row survived.
    const copy = new DatabaseSync(backupPath);
    const value = (copy.prepare("SELECT x FROM t").get() as { x: number }).x;
    assert.equal(value, 1);
    copy.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CraftStore.open upgrades a v0 database file in place", async () => {
  const root = join(tmpdir(), `craft-store-open-${process.pid}-${Date.now()}-${Math.random()}`);
  await mkdir(root, { recursive: true });
  try {
    const paths = craftPaths(root);
    await mkdir(paths.databaseDir, { recursive: true });
    // Seed a v0 schema file with no meta table; applyMigrations must walk it up.
    const seed = new DatabaseSync(paths.databaseFile);
    seed.exec(`
      CREATE TABLE records(
        kind TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,
        payload_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
        PRIMARY KEY(kind,id,version)
      );
      INSERT INTO records(kind,id,version,payload_json,created_at,updated_at)
        VALUES('legacy','kept',1,'{"value":"must-survive"}','2020-01-01','2020-01-01');
    `);
    seed.close();
    const store = await new CraftStore(paths).open();
    try {
      assert.equal(schemaVersion(store.database), SCHEMA_VERSION);
      assert.equal(store.get("legacy", "kept").value, "must-survive");
      assert.ok((await readdir(paths.backupsDir)).some((name) => name.startsWith("craft-")));
      // v3→v4 introduces effect_log; the live store must have it.
      const tables = store.database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => (r as { name: string }).name);
      assert.ok(tables.includes("effect_log"));
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CraftStore.applyMigrationsNow reports applied count without dry-run", async () => {
  const root = join(tmpdir(), `craft-store-apply-${process.pid}-${Date.now()}-${Math.random()}`);
  await mkdir(root, { recursive: true });
  try {
    const store = await new CraftStore(craftPaths(root)).open();
    try {
      const result = store.applyMigrationsNow(SCHEMA_VERSION, { dryRun: false });
      assert.equal(result.to, SCHEMA_VERSION);
      assert.ok(result.applied >= 0);
      // Idempotent: re-apply reports zero.
      const second = store.applyMigrationsNow(SCHEMA_VERSION);
      assert.equal(second.applied, 0);
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CraftStore.backup writes a copy to backupsDir", async () => {
  const root = join(tmpdir(), `craft-store-backup-${process.pid}-${Date.now()}-${Math.random()}`);
  await mkdir(root, { recursive: true });
  try {
    const store = await new CraftStore(craftPaths(root)).open();
    try {
      const backupPath = store.backup();
      assert.ok(backupPath.includes("backups"));
      assert.ok(backupPath.includes("craft-"));
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("downgrade path is rejected when no migration step exists", () => {
  const db = memoryDatabase();
  applyMigrations(db, SCHEMA_VERSION);
  // `applyMigrations` only walks forward; rolling back to a lower version
  // must be rejected so the operator is forced through the explicit
  // `findMigration(..., down)` path or `scripts/migrate.ts --rollback`.
  assert.throws(() => applyMigrations(db, SCHEMA_VERSION - 1), /newer than supported schema/);
});

test("findMigration surfaces an error when no chain exists", () => {
  // v0 → v5 has no terminating step in the registry (latest is v4).
  assert.throws(() => findMigration(0, SCHEMA_VERSION + 1), /No migration path/);
});

test("down migrations restore schema on each intermediate version", () => {
  const db = memoryDatabase();
  applyMigrations(db, SCHEMA_VERSION);
  // v3→v4 down drops effect_log + policy_evaluations; events columns stay.
  MIGRATIONS[3].down(db);
  const afterV4 = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => (r as { name: string }).name);
  assert.ok(!afterV4.includes("effect_log"));
  assert.ok(!afterV4.includes("policy_evaluations"));
  // v2→v3 down drops the events projection columns.
  MIGRATIONS[2].down(db);
  const cols = db.prepare("PRAGMA table_info(events)").all().map((r) => (r as { name: string }).name);
  assert.ok(!cols.includes("event_kind"));
  assert.ok(!cols.includes("outcome"));
  assert.ok(cols.includes("event_type"));
  // v1→v2 down drops applied_at from meta.
  MIGRATIONS[1].down(db);
  const metaCols = db.prepare("PRAGMA table_info(meta)").all().map((r) => (r as { name: string }).name);
  assert.ok(!metaCols.includes("applied_at"));
});

test("applyMigrations rolls back the transaction when an up step throws", () => {
  const db = memoryDatabase();
  applyMigrations(db, 1);
  const versionBefore = schemaVersion(db);
  // Patch a v1→v2 migration whose `up` blows up; the transaction must
  // unwind and leave the database at v1.
  const original = MIGRATIONS[1].up;
  MIGRATIONS[1].up = () => { throw new Error("simulated upgrade failure"); };
  try {
    assert.throws(() => applyMigrations(db, 2), /simulated upgrade failure/);
  } finally {
    MIGRATIONS[1].up = original;
  }
  assert.equal(schemaVersion(db), versionBefore, "ROLLBACK must leave schema_version intact");
});

test("_internalsForTest exposes the read/write helpers used by external probes", () => {
  const db = memoryDatabase();
  const helpers = _internalsForTest();
  helpers.writeSchemaVersion(db, 7);
  assert.equal(helpers.readSchemaVersion(db), 7);
});

test("backupDatabase refuses to copy a missing source", () => {
  // The error path must surface a clear message rather than throwing a
  // bare ENOENT so operators can tell what went wrong.
  assert.throws(
    () => backupDatabase(join(tmpdir(), "definitely-missing-craft.db"), tmpdir()),
    /Cannot backup: source missing/,
  );
});

test("MIGRATIONS[0].down tears down baseline tables and indexes", () => {
  const db = memoryDatabase();
  applyMigrations(db, 1);
  const beforeTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => (r as { name: string }).name);
  assert.ok(beforeTables.includes("records"));
  MIGRATIONS[0].down(db);
  const afterTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => (r as { name: string }).name);
  assert.ok(!afterTables.includes("records"), "records must be dropped");
  assert.ok(!afterTables.includes("events"), "events must be dropped");
  // `records_latest` was an index; verify the downgrade removed it too.
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => (r as { name: string }).name);
  assert.ok(!indexes.includes("records_latest"));
});
