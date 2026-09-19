import { copyFileSync, existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION } from "./store.ts";

/**
 * One ordered migration. `from` is the schema version before it runs, `to` is
 * the schema version after. `up` runs inside a transaction; if it throws, the
 * transaction is rolled back and the schema is unchanged. `down` reverses it
 * for explicit rollback. Both receive the raw `DatabaseSync` so tests can
 * exercise them against an in-memory DB.
 */
export interface Migration {
  from: number;
  to: number;
  description: string;
  up: (database: DatabaseSync) => void;
  down: (database: DatabaseSync) => void;
}

function ensureMetaTable(database: DatabaseSync): void {
  database.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)`);
}

function readSchemaVersion(database: DatabaseSync): number {
  ensureMetaTable(database);
  const row = database.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value?: string } | undefined;
  return Number(row?.value ?? 0);
}

function writeSchemaVersion(database: DatabaseSync, version: number): void {
  ensureMetaTable(database);
  database.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)").run(String(version));
}

/** Repair databases produced by older releases that recorded a newer schema
 * version before the journal column was actually added. This is intentionally
 * idempotent so startup can heal a partially applied migration without
 * rewriting user records. */
function repairKnownSchemaDrift(database: DatabaseSync, current: number): void {
  if (current >= 2 && !columnExists(database, "meta", "applied_at")) {
    database.exec("ALTER TABLE meta ADD COLUMN applied_at TEXT");
  }
}

/**
 * Return true if the named column exists on the named table. Used to make
 * column-adding migrations idempotent against partial intermediate schemas
 * (a database might be opened at a state between two migrations if a
 * previous upgrade was interrupted or seeded for tests).
 */
function columnExists(database: DatabaseSync, table: string, column: string): boolean {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

/**
 * Ordered migration registry. Every migration declared here is part of the
 * shipped product; ad-hoc ALTER TABLE statements must never appear elsewhere.
 *
 * v0 → v1  Initial schema (meta, records, events).
 * v1 → v2  `meta.applied_at` column for the migration journal.
 * v2 → v3  `events.event_kind` and `events.outcome` projection columns used
 *          by the metrics aggregator so it does not have to JSON.parse the
 *          payload to filter.
 * v3 → v4  `effect_log` table backing Effect Policy (W11); nullable columns
 *          so existing rows remain readable. `policy_evaluations` table for
 *          the policy evaluator's verdict trail.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    from: 0,
    to: 1,
    description: "Baseline schema: meta, records, events",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS records(
          kind TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,
          payload_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
          PRIMARY KEY(kind,id,version)
        );
        CREATE INDEX IF NOT EXISTS records_latest ON records(kind,id,version DESC);
        CREATE TABLE IF NOT EXISTS events(
          stream TEXT NOT NULL,sequence INTEGER NOT NULL,event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,created_at TEXT NOT NULL,
          PRIMARY KEY(stream,sequence)
        );
      `);
    },
    down: (database) => {
      database.exec(`DROP TABLE IF EXISTS events; DROP INDEX IF EXISTS records_latest; DROP TABLE IF EXISTS records;`);
    },
  },
  {
    from: 1,
    to: 2,
    description: "meta.applied_at column for the migration journal",
    up: (database) => {
      if (!columnExists(database, "meta", "applied_at")) {
        database.exec(`ALTER TABLE meta ADD COLUMN applied_at TEXT`);
      }
      database.prepare("UPDATE meta SET applied_at=? WHERE key='schema_version'").run(new Date().toISOString());
    },
    down: (database) => {
      // SQLite cannot DROP COLUMN before 3.35; emulate by recreating meta.
      database.exec(`
        CREATE TABLE meta_tmp(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        INSERT INTO meta_tmp(key,value) SELECT key,value FROM meta;
        DROP TABLE meta;
        ALTER TABLE meta_tmp RENAME TO meta;
      `);
    },
  },
  {
    from: 2,
    to: 3,
    description: "events.event_kind and events.outcome projection columns",
    up: (database) => {
      // The `events` table is the responsibility of v0→v1; if we are
      // recovering a database that landed at v1 with no events table (e.g.
      // a test fixture), create the base table before adding columns.
      database.exec(`CREATE TABLE IF NOT EXISTS events(
        stream TEXT NOT NULL,sequence INTEGER NOT NULL,event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,created_at TEXT NOT NULL,
        PRIMARY KEY(stream,sequence)
      )`);
      if (!columnExists(database, "events", "event_kind")) {
        database.exec(`ALTER TABLE events ADD COLUMN event_kind TEXT`);
      }
      if (!columnExists(database, "events", "outcome")) {
        database.exec(`ALTER TABLE events ADD COLUMN outcome TEXT`);
      }
    },
    down: (database) => {
      database.exec(`
        CREATE TABLE events_tmp(
          stream TEXT NOT NULL,sequence INTEGER NOT NULL,event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,created_at TEXT NOT NULL,
          PRIMARY KEY(stream,sequence)
        );
        INSERT INTO events_tmp SELECT stream,sequence,event_type,payload_json,created_at FROM events;
        DROP TABLE events;
        ALTER TABLE events_tmp RENAME TO events;
      `);
    },
  },
  {
    from: 3,
    to: 4,
    description: "effect_log + policy_evaluations tables for Effect Policy (W11)",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS effect_log(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          operation_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          effect_class TEXT NOT NULL,
          verdict TEXT NOT NULL,
          reason TEXT,
          redacted_payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS effect_log_op ON effect_log(operation_id);
        CREATE INDEX IF NOT EXISTS effect_log_key ON effect_log(idempotency_key);
        CREATE TABLE IF NOT EXISTS policy_evaluations(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          effect_class TEXT NOT NULL,
          verdict TEXT NOT NULL,
          reason TEXT,
          created_at TEXT NOT NULL
        );
      `);
    },
    down: (database) => {
      database.exec(`
        DROP INDEX IF EXISTS effect_log_key;
        DROP INDEX IF EXISTS effect_log_op;
        DROP TABLE IF EXISTS effect_log;
        DROP TABLE IF EXISTS policy_evaluations;
      `);
    },
  },
];

export function findMigration(from: number, to: number): Migration[] {
  const path: Migration[] = [];
  let current = from;
  // Walk forward (up) or backward (down) from `from` to `to`.
  while (current !== to) {
    const next = current < to
      ? MIGRATIONS.find((m) => m.from === current && m.to === current + 1)
      : MIGRATIONS.find((m) => m.from === current - 1 && m.to === current);
    if (!next) {
      throw new Error(`No migration path from v${current} to v${to}`);
    }
    path.push(current < to ? next : { ...next, up: next.down, down: next.up });
    current += current < to ? 1 : -1;
  }
  return path;
}

export interface ApplyOptions {
  /** When true, no SQL is applied and only the plan is returned. */
  dryRun?: boolean;
  /** When true, no exception is thrown if the target version equals the current one. */
  skipIfCurrent?: boolean;
}

export interface ApplyResult {
  from: number;
  to: number;
  applied: number;
  dryRun: boolean;
  migrations: Array<{ from: number; to: number; description: string }>;
}

export function applyMigrations(database: DatabaseSync, target = SCHEMA_VERSION, options: ApplyOptions = {}): ApplyResult {
  ensureMetaTable(database);
  const current = readSchemaVersion(database);
  if (!options.dryRun) repairKnownSchemaDrift(database, current);
  if (current > target) {
    throw new Error(`Craft database schema v${current} is newer than supported schema v${target}`);
  }
  if (current === target) {
    return { from: current, to: current, applied: 0, dryRun: !!options.dryRun, migrations: [] };
  }
  const plan = findMigration(current, target);
  const result: ApplyResult = {
    from: current, to: target, applied: plan.length,
    dryRun: !!options.dryRun,
    migrations: plan.map((m) => ({ from: m.from, to: m.to, description: m.description })),
  };
  if (options.dryRun) return result;
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const migration of plan) {
      migration.up(database);
      writeSchemaVersion(database, migration.to);
      // The migration journal column is introduced in v2; updating it on the
      // v0→v1 step would reference a column that does not exist yet.
      if (migration.to >= 2) {
        database.prepare("UPDATE meta SET applied_at=? WHERE key='schema_version'").run(new Date().toISOString());
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return result;
}

/**
 * Copy the source database file to `<backupsDir>/<basename>-<ts>.db`. The
 * caller passes the path explicitly because `node:sqlite`'s `DatabaseSync`
 * does not expose it. Returns the absolute backup path. This function never
 * deletes old backups; rotation is the operator's job.
 */
export function backupDatabase(source: string, backupsDir: string): string {
  if (!existsSync(source)) throw new Error(`Cannot backup: source missing at ${source}`);
  mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = join(backupsDir, `${basename(source, ".db")}-${stamp}.db`);
  copyFileSync(source, target);
  return target;
}

export function _internalsForTest(): { readSchemaVersion: typeof readSchemaVersion; writeSchemaVersion: typeof writeSchemaVersion } {
  return { readSchemaVersion, writeSchemaVersion };
}
