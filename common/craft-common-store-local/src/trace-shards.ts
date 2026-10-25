import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sqliteBusyTimeoutMs } from "./sqlite-busy-timeout.ts";
import type { JsonObject } from "./store.ts";

export const TRACE_KINDS = new Set(["trace", "trace_event", "trace_feedback", "telemetry_event", "trace_archive"]);
export type TraceRecordRow = { kind: string; id: string; version: number; payload_json: string; created_at: string; updated_at: string };
export type TraceEventRow = { stream: string; sequence: number; event_type: string; payload_json: string; created_at: string };
const SHARD_COUNT = 16;
const RESERVED = new Set(["id", "version", "created_at", "updated_at"]);

function payloadOnly(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !RESERVED.has(key)));
}

function record(row: Record<string, unknown>): JsonObject {
  return { ...JSON.parse(String(row.payload_json)) as JsonObject, id: String(row.id), version: Number(row.version),
    created_at: String(row.created_at), updated_at: String(row.updated_at) };
}

/** One Trace and all of its children use one WAL file and one write transaction. */
export class TraceShardStore {
  readonly directory: string;
  #databases = new Map<number, DatabaseSync>();
  #depth = new Map<number, number>();

  constructor(dataRoot: string) { this.directory = join(dataRoot, "trace", "v1"); }

  private shard(traceId: string): number {
    if (!traceId) throw new Error("Trace id must not be empty");
    return createHash("sha256").update(traceId).digest()[0]! % SHARD_COUNT;
  }

  private file(shard: number): string { return join(this.directory, `${shard.toString(16).padStart(2, "0")}.db`); }

  private database(shard: number, create: boolean): DatabaseSync | null {
    const current = this.#databases.get(shard);
    if (current) return current;
    const file = this.file(shard);
    if (!create && !existsSync(file)) return null;
    if (create) mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const directory of [join(this.directory, "..", ".."), join(this.directory, ".."), this.directory]) {
      const stat = lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Trace database path must use regular directories");
    }
    if (existsSync(file)) {
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Trace database must be a regular file");
    }
    const database = new DatabaseSync(file);
    try {
      database.exec(`PRAGMA busy_timeout=${sqliteBusyTimeoutMs()}; PRAGMA foreign_keys=ON;`);
      if (create && String((database.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toLowerCase() !== "wal")
        database.exec("PRAGMA journal_mode=WAL;");
      if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='records'").get()) database.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS records(
      kind TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,
      payload_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      PRIMARY KEY(kind,id,version));
      CREATE INDEX IF NOT EXISTS records_latest ON records(kind,id,version DESC);
      CREATE INDEX IF NOT EXISTS records_trace_id ON records(kind,json_extract(payload_json,'$.trace_id'),id,version DESC);
      CREATE TABLE IF NOT EXISTS events(stream TEXT NOT NULL,sequence INTEGER NOT NULL,event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(stream,sequence));
      COMMIT;`);
    } catch (error) { database.close(); throw error; }
    this.#databases.set(shard, database);
    return database;
  }

  private existing(): Array<[number, DatabaseSync]> {
    const result: Array<[number, DatabaseSync]> = [];
    for (let shard = 0; shard < SHARD_COUNT; shard++) {
      const database = this.database(shard, false);
      if (database) result.push([shard, database]);
    }
    return result;
  }

  transaction<T>(traceId: string, operation: () => T): T {
    const shard = this.shard(traceId), database = this.database(shard, true)!;
    const depth = this.#depth.get(shard) ?? 0, savepoint = `trace_nested_${depth}`;
    database.exec(depth ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    this.#depth.set(shard, depth + 1);
    try {
      const result = operation();
      database.exec(depth ? `RELEASE ${savepoint}` : "COMMIT");
      this.#depth.set(shard, depth);
      return result;
    } catch (error) {
      try { database.exec(depth ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK"); }
      catch (rollbackError) { this.#depth.set(shard, depth); throw rollbackError; }
      this.#depth.set(shard, depth);
      throw error;
    }
  }

  private target(kind: string, id: string, payload: JsonObject): { traceId: string; database: DatabaseSync } {
    const traceId = kind === "trace" || kind === "trace_archive" ? id : payload.trace_id;
    if (typeof traceId !== "string" || !traceId) throw new Error(`${kind} requires trace_id`);
    return { traceId, database: this.database(this.shard(traceId), true)! };
  }

  create(kind: string, id: string, payload: JsonObject): JsonObject {
    const { traceId, database } = this.target(kind, id, payload);
    return this.transaction(traceId, () => {
      if (database.prepare("SELECT 1 FROM records WHERE kind=? AND id=? LIMIT 1").get(kind, id)) throw new Error(`${kind} already exists: ${id}`);
      return this.insert(database, kind, id, payload, 1);
    });
  }

  save(kind: string, id: string, payload: JsonObject, version?: number): JsonObject {
    const { traceId, database } = this.target(kind, id, payload);
    return this.transaction(traceId, () => this.insert(database, kind, id, payload, version));
  }

  private insert(database: DatabaseSync, kind: string, id: string, value: JsonObject, version?: number): JsonObject {
    const payload = payloadOnly(value), now = new Date().toISOString();
    const next = version ?? Number((database.prepare("SELECT COALESCE(MAX(version),0)+1 version FROM records WHERE kind=? AND id=?")
      .get(kind, id) as { version: number }).version);
    database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run(kind, id, next, JSON.stringify(payload), now, now);
    return { ...payload, id, version: next, created_at: now, updated_at: now };
  }

  find(kind: string, id: string, version?: number, traceId?: string): JsonObject | null {
    const databases = traceId || kind === "trace" || kind === "trace_archive"
      ? [this.database(this.shard(traceId ?? id), false)].filter((value): value is DatabaseSync => value !== null)
      : this.existing().map(([, database]) => database);
    for (const database of databases) {
      const row = (version === undefined
        ? database.prepare("SELECT * FROM records WHERE kind=? AND id=? ORDER BY version DESC LIMIT 1").get(kind, id)
        : database.prepare("SELECT * FROM records WHERE kind=? AND id=? AND version=?").get(kind, id, version)) as Record<string, unknown> | undefined;
      if (row) return record(row);
    }
    return null;
  }

  list(kind: string, limit: number, predicate?: (value: JsonObject) => boolean): JsonObject[] {
    const records: JsonObject[] = [];
    for (const [, database] of this.existing()) {
      const rows = database.prepare(`SELECT r.* FROM records r JOIN
        (SELECT id,MAX(version) version FROM records WHERE kind=? GROUP BY id) latest
        ON latest.id=r.id AND latest.version=r.version WHERE r.kind=? ORDER BY r.updated_at DESC,r.rowid DESC ${predicate ? "" : "LIMIT ?"}`)
        .all(kind, kind, ...(predicate ? [] : [limit])) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const value = record(row);
        if (!predicate || predicate(value)) records.push(value);
      }
    }
    return records.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || String(b.id).localeCompare(String(a.id))).slice(0, limit);
  }

  count(kind: string): number {
    return this.existing().reduce((total, [, database]) => total + Number((database.prepare(
      "SELECT COUNT(*) n FROM (SELECT id FROM records WHERE kind=? GROUP BY id)").get(kind) as { n: number }).n), 0);
  }

  children(kind: string, traceId: string): JsonObject[] {
    const database = this.database(this.shard(traceId), false);
    if (!database) return [];
    const rows = database.prepare(`SELECT r.* FROM records r JOIN
      (SELECT id,MAX(version) version FROM records WHERE kind=? AND json_extract(payload_json,'$.trace_id')=? GROUP BY id) latest
      ON latest.id=r.id AND latest.version=r.version WHERE r.kind=? ORDER BY r.id`).all(kind, traceId, kind) as Array<Record<string, unknown>>;
    return rows.map(record);
  }

  retentionCandidates(cutoff: string, limit: number): JsonObject[] {
    const candidates: JsonObject[] = [];
    for (const [, database] of this.existing()) {
      const rows = database.prepare(`SELECT r.* FROM records r JOIN
        (SELECT id,MAX(version) version FROM records WHERE kind='trace' GROUP BY id) latest
        ON latest.id=r.id AND latest.version=r.version WHERE r.kind='trace'
        AND json_extract(r.payload_json,'$.status') IN ('completed','failed','cancelled','blocked')
        AND COALESCE(json_extract(r.payload_json,'$.last_event_at'),r.updated_at,json_extract(r.payload_json,'$.started_at')) < ?
        ORDER BY COALESCE(json_extract(r.payload_json,'$.last_event_at'),r.updated_at,json_extract(r.payload_json,'$.started_at')) ASC LIMIT ?`)
        .all(cutoff, limit) as Array<Record<string, unknown>>;
      candidates.push(...rows.map(record));
    }
    return candidates.sort((a, b) => String(a.last_event_at ?? a.updated_at).localeCompare(String(b.last_event_at ?? b.updated_at))).slice(0, limit);
  }

  remove(traceId: string, eventIds: readonly string[], feedbackIds: readonly string[], telemetryIds: readonly string[]): number {
    const database = this.database(this.shard(traceId), false);
    if (!database) return 0;
    return this.transaction(traceId, () => {
      let changes = Number(database.prepare("DELETE FROM records WHERE kind='trace' AND id=?").run(traceId).changes);
      for (const [kind, ids] of [["trace_event", eventIds], ["trace_feedback", feedbackIds], ["telemetry_event", telemetryIds]] as const)
        for (const id of ids) changes += Number(database.prepare("DELETE FROM records WHERE kind=? AND id=? AND json_extract(payload_json,'$.trace_id')=?").run(kind, id, traceId).changes);
      changes += Number(database.prepare("DELETE FROM events WHERE stream=?").run(`trace:${traceId}`).changes);
      return changes;
    });
  }

  appendEvent(traceId: string, eventType: string, payload: JsonObject): JsonObject {
    const database = this.database(this.shard(traceId), true)!;
    return this.transaction(traceId, () => {
      const stream = `trace:${traceId}`;
      const sequence = Number((database.prepare("SELECT COALESCE(MAX(sequence),0)+1 sequence FROM events WHERE stream=?")
        .get(stream) as { sequence: number }).sequence);
      const created_at = new Date().toISOString();
      database.prepare("INSERT INTO events(stream,sequence,event_type,payload_json,created_at) VALUES(?,?,?,?,?)")
        .run(stream, sequence, eventType, JSON.stringify(payload), created_at);
      return { stream, sequence, event_type: eventType, payload, created_at };
    });
  }

  events(traceId: string): JsonObject[] {
    const database = this.database(this.shard(traceId), false);
    if (!database) return [];
    return (database.prepare("SELECT * FROM events WHERE stream=? ORDER BY sequence").all(`trace:${traceId}`) as Array<Record<string, unknown>>)
      .map(row => ({ stream: row.stream, sequence: row.sequence, event_type: row.event_type,
        payload: JSON.parse(String(row.payload_json)), created_at: row.created_at }));
  }

  /** Idempotent copy for offline migration. Exact raw row comparison preserves every historical version. */
  importLegacy(traceId: string, records: readonly TraceRecordRow[], events: readonly TraceEventRow[]): void {
    this.transaction(traceId, () => {
      const database = this.database(this.shard(traceId), true)!;
      const readRecord = database.prepare("SELECT kind,id,version,payload_json,created_at,updated_at FROM records WHERE kind=? AND id=? AND version=?");
      const insertRecord = database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)");
      for (const row of records) {
        const owner = row.kind === "trace" || row.kind === "trace_archive" ? row.id : (JSON.parse(row.payload_json) as JsonObject).trace_id;
        if (!TRACE_KINDS.has(row.kind) || owner !== traceId) throw new Error("Trace migration record has a different owner");
        const current = readRecord.get(row.kind, row.id, row.version);
        if (current) { if (JSON.stringify(current) !== JSON.stringify(row)) throw new Error("Trace migration record conflicts with shard"); }
        else insertRecord.run(row.kind, row.id, row.version, row.payload_json, row.created_at, row.updated_at);
      }
      const readEvent = database.prepare("SELECT stream,sequence,event_type,payload_json,created_at FROM events WHERE stream=? AND sequence=?");
      const insertEvent = database.prepare("INSERT INTO events(stream,sequence,event_type,payload_json,created_at) VALUES(?,?,?,?,?)");
      for (const row of events) {
        if (row.stream !== `trace:${traceId}`) throw new Error("Trace migration stream has a different owner");
        const current = readEvent.get(row.stream, row.sequence);
        if (current) { if (JSON.stringify(current) !== JSON.stringify(row)) throw new Error("Trace migration event conflicts with shard"); }
        else insertEvent.run(row.stream, row.sequence, row.event_type, row.payload_json, row.created_at);
      }
    });
  }

  close(): void { for (const database of this.#databases.values()) database.close(); this.#databases.clear(); this.#depth.clear(); }
}
