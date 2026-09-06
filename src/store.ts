import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { craftPaths, ensureLayout, type CraftPaths } from "./paths.ts";

export const SCHEMA_VERSION = 1;
export type JsonObject = Record<string, unknown>;

export class CraftStore {
  readonly paths: CraftPaths;
  #database: DatabaseSync | null = null;

  constructor(paths = craftPaths()) {
    this.paths = paths;
  }

  async open(): Promise<this> {
    if (this.#database) return this;
    await ensureLayout(this.paths);
    const database = new DatabaseSync(this.paths.databaseFile);
    database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=15000;");
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
    database.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)")
      .run(String(SCHEMA_VERSION));
    this.#database = database;
    return this;
  }

  get database(): DatabaseSync {
    if (!this.#database) throw new Error("CraftStore is not open.");
    return this.#database;
  }

  transaction<T>(operation: (database: DatabaseSync) => T): T {
    const database = this.database;
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation(database);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  legacyDatabaseDetected(): boolean {
    return existsSync(this.paths.legacyDatabaseFile);
  }

  save(kind: string, id: string, payload: JsonObject, version?: number): JsonObject {
    const now = new Date().toISOString();
    return this.transaction((database) => {
      const next = version ?? Number((database.prepare(
        "SELECT COALESCE(MAX(version),0)+1 AS version FROM records WHERE kind=? AND id=?",
      ).get(kind, id) as { version: number }).version);
      database.prepare(`INSERT INTO records(
        kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
        .run(kind, id, next, JSON.stringify(payload), now, now);
      return { ...payload, id, version: next, created_at: now, updated_at: now };
    });
  }

  get(kind: string, id: string, version?: number): JsonObject {
    const row = version === undefined
      ? this.database.prepare(
        "SELECT * FROM records WHERE kind=? AND id=? ORDER BY version DESC LIMIT 1",
      ).get(kind, id)
      : this.database.prepare(
        "SELECT * FROM records WHERE kind=? AND id=? AND version=?",
      ).get(kind, id, version);
    if (!row) throw new Error(`Unknown ${kind}: ${id}`);
    return this.record(row as Record<string, unknown>);
  }

  list(kind: string, limit = 20, predicate?: (record: JsonObject) => boolean): JsonObject[] {
    const rows = this.database.prepare(`SELECT r.* FROM records r JOIN (
      SELECT id,MAX(version) version FROM records WHERE kind=? GROUP BY id
      ) latest ON latest.id=r.id AND latest.version=r.version
      WHERE r.kind=? ORDER BY r.updated_at DESC,r.id DESC`).all(kind, kind);
    const records = rows.map((row) => this.record(row as Record<string, unknown>));
    return (predicate ? records.filter(predicate) : records).slice(0, Math.max(1, Math.min(limit, 100)));
  }

  remove(kind: string, id: string): number {
    return Number(this.database.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id).changes);
  }

  appendEvent(stream: string, eventType: string, payload: JsonObject): JsonObject {
    return this.transaction((database) => {
      const sequence = Number((database.prepare(
        "SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM events WHERE stream=?",
      ).get(stream) as { sequence: number }).sequence);
      const created_at = new Date().toISOString();
      database.prepare(`INSERT INTO events(
        stream,sequence,event_type,payload_json,created_at) VALUES(?,?,?,?,?)`)
        .run(stream, sequence, eventType, JSON.stringify(payload), created_at);
      return { stream, sequence, event_type: eventType, payload, created_at };
    });
  }

  events(stream: string): JsonObject[] {
    return this.database.prepare(
      "SELECT * FROM events WHERE stream=? ORDER BY sequence",
    ).all(stream).map((row) => {
      const item = row as Record<string, unknown>;
      return { stream: item.stream, sequence: item.sequence, event_type: item.event_type,
        payload: JSON.parse(String(item.payload_json)), created_at: item.created_at };
    });
  }

  private record(row: Record<string, unknown>): JsonObject {
    return { ...JSON.parse(String(row.payload_json)), id: row.id, version: row.version,
      created_at: row.created_at, updated_at: row.updated_at };
  }

  close(): void {
    this.#database?.close();
    this.#database = null;
  }
}
