import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { craftPaths, ensureLayout, type CraftPaths } from "./paths.ts";

export const SCHEMA_VERSION = 2;
export type JsonObject = Record<string, unknown>;
export type SaveEntry = { kind: string; id: string; payload: JsonObject; version?: number };
const RESERVED_FIELDS = new Set(["id", "version", "created_at", "updated_at"]);

function payloadOnly(payload: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !RESERVED_FIELDS.has(key)));
}

function validLimit(limit: number): number {
  if (!Number.isFinite(limit) || !Number.isInteger(limit)) {
    throw new Error("limit must be a finite integer");
  }
  return Math.max(1, limit);
}

export class CraftStore {
  readonly paths: CraftPaths;
  #database: DatabaseSync | null = null;
  #ftsAvailable = false;

  constructor(paths = craftPaths()) {
    this.paths = paths;
  }

  async open(): Promise<this> {
    if (this.#database) return this;
    await ensureLayout(this.paths);
    const database = new DatabaseSync(this.paths.databaseFile);
    database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=15000;");
    database.exec("BEGIN IMMEDIATE");
    try {
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
    const schemaRow = database.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value?: string } | undefined;
    const previousVersion = Number(schemaRow?.value ?? 0);
    if (previousVersion > SCHEMA_VERSION) {
      throw new Error(`Craft database schema ${previousVersion} is newer than supported schema ${SCHEMA_VERSION}`);
    }
    try {
      database.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS capability_fts USING fts5(
        id UNINDEXED,name,description,body,tokenize='unicode61'
      );`);
      this.#ftsAvailable = true;
      if (previousVersion < 2) {
        database.exec(`DELETE FROM capability_fts;
          INSERT INTO capability_fts(id,name,description,body)
          SELECT r.id,json_extract(r.payload_json,'$.name'),json_extract(r.payload_json,'$.description'),
            json_extract(r.payload_json,'$.body') FROM records r JOIN (
              SELECT id,MAX(version) version FROM records WHERE kind='capability' GROUP BY id
            ) latest ON latest.id=r.id AND latest.version=r.version WHERE r.kind='capability';`);
      }
    } catch {
      this.#ftsAvailable = false;
    }
    database.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)")
      .run(String(SCHEMA_VERSION));
    database.exec("COMMIT");
    this.#database = database;
    return this;
    } catch (error) {
      database.exec("ROLLBACK");
      database.close();
      throw error;
    }
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
    return this.transaction((database) => this.insert(database, { kind, id, payload, version }));
  }

  create(kind: string, id: string, payload: JsonObject): JsonObject {
    return this.transaction((database) => {
      const existing = database.prepare("SELECT 1 present FROM records WHERE kind=? AND id=? LIMIT 1")
        .get(kind, id);
      if (existing) throw new Error(`${kind} already exists: ${id}`);
      return this.insert(database, { kind, id, payload, version: 1 });
    });
  }

  saveBatch(entries: SaveEntry[]): JsonObject[] {
    if (!entries.length) return [];
    return this.transaction((database) => entries.map((entry) => this.insert(database, entry)));
  }

  updateIfVersion(kind: string, id: string, expectedVersion: number, payload: JsonObject): JsonObject {
    return this.transaction((database) => {
      const current = Number((database.prepare(
        "SELECT COALESCE(MAX(version),0) AS version FROM records WHERE kind=? AND id=?",
      ).get(kind, id) as { version: number }).version);
      if (current !== expectedVersion) throw new Error(`Concurrent update detected for ${kind}: ${id}`);
      return this.insert(database, { kind, id, payload, version: current + 1 });
    });
  }

  private insert(database: DatabaseSync, entry: SaveEntry): JsonObject {
      const { kind, id, version } = entry;
      const payload = payloadOnly(entry.payload);
      const now = new Date().toISOString();
      const next = version ?? Number((database.prepare(
        "SELECT COALESCE(MAX(version),0)+1 AS version FROM records WHERE kind=? AND id=?",
      ).get(kind, id) as { version: number }).version);
      database.prepare(`INSERT INTO records(
        kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
        .run(kind, id, next, JSON.stringify(payload), now, now);
      if (kind === "capability" && this.#ftsAvailable) {
        database.prepare("DELETE FROM capability_fts WHERE id=?").run(id);
        database.prepare("INSERT INTO capability_fts(id,name,description,body) VALUES(?,?,?,?)")
          .run(id, String(payload.name ?? ""), String(payload.description ?? ""), String(payload.body ?? ""));
      }
      return { ...payload, id, version: next, created_at: now, updated_at: now };
  }

  find(kind: string, id: string, version?: number): JsonObject | null {
    const row = version === undefined
      ? this.database.prepare(
        "SELECT * FROM records WHERE kind=? AND id=? ORDER BY version DESC LIMIT 1",
      ).get(kind, id)
      : this.database.prepare(
        "SELECT * FROM records WHERE kind=? AND id=? AND version=?",
      ).get(kind, id, version);
    return row ? this.record(row as Record<string, unknown>) : null;
  }

  get(kind: string, id: string, version?: number): JsonObject {
    const record = this.find(kind, id, version);
    if (!record) throw new Error(`Unknown ${kind}: ${id}`);
    return record;
  }

  list(kind: string, limit = 20, predicate?: (record: JsonObject) => boolean): JsonObject[] {
    const bounded = validLimit(limit);
    const rows = this.database.prepare(`SELECT r.* FROM records r JOIN (
      SELECT id,MAX(version) version FROM records WHERE kind=? GROUP BY id
      ) latest ON latest.id=r.id AND latest.version=r.version
      WHERE r.kind=? ORDER BY r.updated_at DESC,r.id DESC ${predicate ? "" : "LIMIT ?"}`)
      .all(...(predicate ? [kind, kind] : [kind, kind, bounded]));
    const records = rows.map((row) => this.record(row as Record<string, unknown>));
    return (predicate ? records.filter(predicate) : records).slice(0, bounded);
  }

  count(kind: string): number {
    return Number((this.database.prepare(`SELECT COUNT(*) count FROM records r JOIN (
      SELECT id,MAX(version) version FROM records WHERE kind=? GROUP BY id
      ) latest ON latest.id=r.id AND latest.version=r.version WHERE r.kind=?`)
      .get(kind, kind) as { count: number }).count);
  }

  searchCapabilities(terms: string[], limit: number): JsonObject[] {
    const bounded = Math.min(validLimit(limit), 20);
    if (!terms.length) return [];
    if (this.#ftsAvailable) {
      const expression = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
      const rows = this.database.prepare(`SELECT r.*,bm25(capability_fts) rank FROM capability_fts
        JOIN records r ON r.kind='capability' AND r.id=capability_fts.id
        JOIN (SELECT id,MAX(version) version FROM records WHERE kind='capability' GROUP BY id) latest
          ON latest.id=r.id AND latest.version=r.version
        WHERE capability_fts MATCH ? ORDER BY rank LIMIT ?`).all(expression, bounded);
      return rows.map((row) => {
        const item = row as Record<string, unknown>;
        return { ...this.record(item), score: -Number(item.rank) };
      });
    }
    return this.list("capability", Number.MAX_SAFE_INTEGER).map((item) => {
      const text = [item.name, item.description, item.body].join(" ").toLowerCase();
      const score = terms.reduce((total, term) => total + Number(text.includes(term.toLowerCase())), 0);
      return { ...item, score };
    }).filter((item) => Number(item.score) > 0)
      .sort((left, right) => Number(right.score) - Number(left.score))
      .slice(0, bounded);
  }

  remove(kind: string, id: string): number {
    return this.transaction((database) => {
      const changes = Number(database.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id).changes);
      if (kind === "capability" && this.#ftsAvailable) database.prepare("DELETE FROM capability_fts WHERE id=?").run(id);
      return changes;
    });
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
    this.#ftsAvailable = false;
  }
}
