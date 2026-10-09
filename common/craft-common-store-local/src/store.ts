import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, backupDatabase } from "./store-migrations.ts";
import { craftPaths, ensureLayout, type CraftPaths } from "./paths.ts";
import { MarkdownContentStore, type ContentKind } from "./content-store.ts";

import { SCHEMA_VERSION } from "./store-schema.ts";
export { SCHEMA_VERSION } from "./store-schema.ts";
export type JsonObject = Record<string, unknown>;
export type SaveEntry = { kind: string; id: string; payload: JsonObject; version?: number };
export type RawRecord = { kind: string; id: string; version: number; payload: JsonObject; created_at: string; updated_at: string };
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

function storedSchemaVersion(database: DatabaseSync): number {
  try {
    const row = database.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value?: string } | undefined;
    return Number(row?.value ?? 0);
  } catch {
    return 0;
  }
}

export class CraftStore {
  readonly paths: CraftPaths;
  readonly contentStore: MarkdownContentStore;
  #database: DatabaseSync | null = null;
  #transactionDepth = 0;

  constructor(paths = craftPaths()) {
    this.paths = paths;
    this.contentStore = new MarkdownContentStore(paths);
  }

  async open(): Promise<this> {
    if (this.#database) return this;
    await ensureLayout(this.paths);
    const existed = existsSync(this.paths.databaseFile);
    const database = new DatabaseSync(this.paths.databaseFile);
    try {
      // Concurrent Hosts must wait before the journal-mode change takes a lock.
      database.exec("PRAGMA busy_timeout=15000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
      // Preserve an exact pre-migration copy before changing an existing
      // database. Future-schema databases are not touched and fail closed.
      if (existed && storedSchemaVersion(database) < SCHEMA_VERSION) {
        database.exec("PRAGMA wal_checkpoint(FULL)");
        this.backup();
      }
      // Schema upgrades go through the ordered migration registry, which
      // owns its own transaction. We do not wrap it here because SQLite
      // refuses nested BEGIN IMMEDIATE. If the migration refuses the
      // schema (e.g. a newer-than-supported version) we must close the
      // freshly opened connection so the file lock is released.
      applyMigrations(database, SCHEMA_VERSION);
      this.rebuildDomainIndexes(database);
    } catch (error) {
      database.close();
      throw error;
    }
    this.#database = database;
    return this;
  }

  /**
   * Apply pending migrations to an already-open database. Returns a
   * description of what changed. Caller is responsible for closing the
   * connection if they want to re-open from disk after a rollback.
   */
  applyMigrationsNow(target = SCHEMA_VERSION, options: { dryRun?: boolean } = {}) {
    // `applyMigrations` runs its own transaction; do not wrap it here.
    return applyMigrations(this.database, target, options);
  }

  /** Copy the live database file to `paths.backupsDir`. */
  backup(backupsDir = this.paths.backupsDir): string {
    return backupDatabase(this.paths.databaseFile, backupsDir);
  }

  private rebuildDomainIndexes(database: DatabaseSync): void {
    const entries: Array<[string, ContentKind]> = [
      [this.paths.knowledgeDatabaseFile, "knowledge"],
      [this.paths.memoryDatabaseFile, "memory"],
      [this.paths.experienceDatabaseFile, "experience"],
    ];
    const rows = database.prepare("SELECT kind,id,version,payload_json,updated_at FROM records").all() as Array<Record<string, unknown>>;
    for (const [path, domain] of entries) {
      const index = new DatabaseSync(path);
      try {
        index.exec("PRAGMA busy_timeout=15000; PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS content_index (kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, content_ref TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(kind,id,version)); DELETE FROM content_index;");
        const insert = index.prepare("INSERT INTO content_index(kind,id,version,content_ref,updated_at) VALUES(?,?,?,?,?)");
        for (const row of rows) {
          const payload = JSON.parse(String(row.payload_json)) as JsonObject;
          const ref = payload.content_ref;
          if (!ref || typeof ref !== "object" || Array.isArray(ref) || (ref as Record<string, unknown>).kind !== domain) continue;
          insert.run(String(row.kind), String(row.id), Number(row.version), JSON.stringify(ref), String(row.updated_at));
        }
        index.exec("COMMIT");
      } finally { index.close(); }
    }
  }

  get database(): DatabaseSync {
    if (!this.#database) throw new Error("CraftStore is not open.");
    return this.#database;
  }

  transaction<T>(operation: (database: DatabaseSync) => T): T {
    const database = this.database;
    const nested = this.#transactionDepth > 0;
    const savepoint = `craft_atomic_${this.#transactionDepth}`;
    database.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    this.#transactionDepth += 1;
    try {
      const result = operation(database);
      database.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
      this.#transactionDepth -= 1;
      return result;
    } catch (error) {
      this.#transactionDepth -= 1;
      database.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
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
      return { ...payload, id, version: next, created_at: now, updated_at: now };
  }

  find(kind: string, id: string, version?: number, hydrate = true): JsonObject | null {
    const row = version === undefined
      ? this.database.prepare(
        "SELECT * FROM records WHERE kind=? AND id=? ORDER BY version DESC LIMIT 1",
      ).get(kind, id)
      : this.database.prepare(
        "SELECT * FROM records WHERE kind=? AND id=? AND version=?",
      ).get(kind, id, version);
    return row ? this.record(row as Record<string, unknown>, hydrate) : null;
  }

  get(kind: string, id: string, version?: number): JsonObject {
    const record = this.find(kind, id, version);
    if (!record) throw new Error(`Unknown ${kind}: ${id}`);
    return record;
  }

  list(kind: string, limit = 20, predicate?: (record: JsonObject) => boolean, hydrate = true, dependencies?: { source_ids: string[]; document_ids: string[] }): JsonObject[] {
    const bounded = validLimit(limit);
    const rows = this.database.prepare(`SELECT r.* FROM records r JOIN (
      SELECT id,MAX(version) version FROM records WHERE kind=? GROUP BY id
      ) latest ON latest.id=r.id AND latest.version=r.version
      WHERE r.kind=? ${dependencies ? "AND (json_array_length(?)=0 OR json_extract(r.payload_json,'$.source_id') IN (SELECT value FROM json_each(?))) AND (json_array_length(?)=0 OR json_extract(r.payload_json,'$.document_id') IN (SELECT value FROM json_each(?)))" : ""} ORDER BY r.updated_at DESC,r.rowid DESC,r.id DESC ${predicate ? "" : "LIMIT ?"}`)
      .all(kind, kind, ...(dependencies ? [JSON.stringify(dependencies.source_ids), JSON.stringify(dependencies.source_ids), JSON.stringify(dependencies.document_ids), JSON.stringify(dependencies.document_ids)] : []), ...(predicate ? [] : [bounded]));
    const records: JsonObject[] = [];
    for (const row of rows) {
      const record = this.record(row as Record<string, unknown>, hydrate);
      if (predicate && !predicate(record)) continue;
      records.push(record);
      if (records.length === bounded) break;
    }
    return records;
  }

  /** SQL scope filtering precedes body hydration. Additional ACL predicates use metadata only. */
  listScoped(kind: string, scopes: readonly { kind: string; id: string }[], limit = 20, predicate?: (record: JsonObject) => boolean, temporal?: { known_at?: string; history?: boolean }): JsonObject[] {
    const bounded = validLimit(limit);
    if (!Array.isArray(scopes) || scopes.some(scope => !scope || typeof scope.kind !== "string" || typeof scope.id !== "string")) throw new Error("Invalid scoped query");
    if (!scopes.length) return [];
    const scopeSql = `EXISTS (SELECT 1 FROM json_each(?) s WHERE
      json_extract(r.payload_json,'$.scope')=CASE WHEN json_extract(s.value,'$.kind')='global' THEN 'global' ELSE json_extract(s.value,'$.kind')||':'||json_extract(s.value,'$.id') END
      OR (json_extract(r.payload_json,'$.scope.kind')=json_extract(s.value,'$.kind') AND json_extract(r.payload_json,'$.scope.id')=json_extract(s.value,'$.id')))`;
    const values = [JSON.stringify(scopes)];
    if (temporal?.known_at !== undefined && !Number.isFinite(Date.parse(temporal.known_at))) throw new Error("Invalid scoped known_at");
    const cutoff = temporal?.known_at === undefined ? "" : " AND updated_at<=?";
    const timeValues = temporal?.known_at === undefined ? [] : [new Date(temporal.known_at).toISOString()];
    const watermark = Number(this.database.prepare("SELECT COALESCE(MAX(rowid),0) watermark FROM records").get()!.watermark);
    const latest = temporal?.history === true ? "" : ` JOIN (SELECT id,MAX(version) version FROM records WHERE kind=? AND rowid<=?${cutoff} GROUP BY id) latest ON latest.id=r.id AND latest.version=r.version`;
    const parameters = [...(temporal?.history === true ? [] : [kind, watermark, ...timeValues]), kind, ...timeValues, ...values, watermark];
    const statement = this.database.prepare(`SELECT r.*,r.rowid read_rowid FROM records r${latest} WHERE r.kind=?${cutoff} AND ${scopeSql} AND r.rowid<=? AND (r.updated_at<? OR (r.updated_at=? AND r.rowid<?)) ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 512`);
    const selected: JsonObject[] = [];
    // Short, bounded metadata pages avoid retaining a SQLite iterator while a
    // predicate performs nested Store reads. Only authorized results hydrate.
    let cursorTime = "\uffff", cursorRow = Number.MAX_SAFE_INTEGER;
    for (;;) {
      const rows = statement.all(...parameters, cursorTime, cursorTime, cursorRow);
      for (const row of rows) {
        if (predicate && !predicate(this.record(row as Record<string, unknown>, false))) continue;
        selected.push(this.record(row as Record<string, unknown>));
        if (selected.length === bounded) return selected;
      }
      if (rows.length < 512) break;
      const last = rows[rows.length - 1]!;
      cursorTime = String(last.updated_at); cursorRow = Number(last.read_rowid);
    }
    return selected;
  }

  count(kind: string): number {
    return Number((this.database.prepare(`SELECT COUNT(*) count FROM records r JOIN (
      SELECT id,MAX(version) version FROM records WHERE kind=? GROUP BY id
      ) latest ON latest.id=r.id AND latest.version=r.version WHERE r.kind=?`)
      .get(kind, kind) as { count: number }).count);
  }

  /** Bounded metadata history for one asset. Scope/ACL checks belong to its caller. */
  history(kind: string, id: string, before: number, limit: number): JsonObject[] {
    if (!Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 101) throw new Error("Invalid history bounds");
    const rows = this.database.prepare("SELECT * FROM records WHERE kind=? AND id=? AND version<? ORDER BY version DESC LIMIT ?").all(kind, id, before, limit);
    return rows.map(row => ({ ...JSON.parse(String(row.payload_json)), id: row.id, version: row.version, created_at: row.created_at, updated_at: row.updated_at }));
  }

  /** Return every stored version without hydrating Markdown content. Used by
   * reversible content migrations and integrity tooling only. */
  rawRecords(kind?: string): RawRecord[] {
    const rows = kind === undefined
      ? this.database.prepare("SELECT * FROM records ORDER BY kind,id,version").all()
      : this.database.prepare("SELECT * FROM records WHERE kind=? ORDER BY id,version").all(kind);
    return rows.map((row) => {
      const item = row as Record<string, unknown>;
      return { kind: String(item.kind), id: String(item.id), version: Number(item.version),
        payload: JSON.parse(String(item.payload_json)) as JsonObject,
        created_at: String(item.created_at), updated_at: String(item.updated_at) };
    });
  }

  /** Migration-only in-place payload replacement. The caller must create a
   * database backup first; ordinary domain updates remain append-only. */
  replacePayload(kind: string, id: string, version: number, payload: JsonObject): void {
    this.transaction((database) => {
      const result = database.prepare("UPDATE records SET payload_json=?,updated_at=? WHERE kind=? AND id=? AND version=?")
        .run(JSON.stringify(payloadOnly(payload)), new Date().toISOString(), kind, id, version);
      if (Number(result.changes) !== 1) throw new Error(`Unknown record version: ${kind}/${id}/${version}`);
    });
  }

  replacePayloadBatch(entries: Array<{ kind: string; id: string; version: number; payload: JsonObject }>): void {
    if (!entries.length) return;
    this.transaction((database) => {
      const statement = database.prepare("UPDATE records SET payload_json=?,updated_at=? WHERE kind=? AND id=? AND version=?");
      for (const entry of entries) {
        const result = statement.run(JSON.stringify(payloadOnly(entry.payload)), new Date().toISOString(), entry.kind, entry.id, entry.version);
        if (Number(result.changes) !== 1) throw new Error(`Unknown record version: ${entry.kind}/${entry.id}/${entry.version}`);
      }
    });
  }

  searchCapabilities(terms: string[], limit: number): JsonObject[] {
    const bounded = Math.min(validLimit(limit), 20);
    if (!terms.length) return [];
    return this.list("capability", Number.MAX_SAFE_INTEGER).map((item) => {
      const text = [item.name, item.description, item.search_text ?? item.body].join(" ").toLowerCase();
      const score = terms.reduce((total, term) => total + Number(text.includes(term.toLowerCase())), 0);
      return { ...item, score };
    }).filter((item) => Number(item.score) > 0)
      .sort((left, right) => Number(right.score) - Number(left.score))
      .slice(0, bounded);
  }

  remove(kind: string, id: string): number {
    return this.transaction((database) => {
      const changes = Number(database.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id).changes);
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

  /** Atomically remove a trace and its versioned records after archival. */
  removeTraceRecords(traceId: string, eventIds: readonly string[], feedbackIds: readonly string[]): number {
    return this.transaction((database) => {
      let changes = Number(database.prepare("DELETE FROM records WHERE kind='trace' AND id=?").run(traceId).changes);
      for (const id of eventIds) changes += Number(database.prepare("DELETE FROM records WHERE kind='trace_event' AND id=?").run(id).changes);
      for (const id of feedbackIds) changes += Number(database.prepare("DELETE FROM records WHERE kind='trace_feedback' AND id=?").run(id).changes);
      changes += Number(database.prepare("DELETE FROM events WHERE stream=?").run(`trace:${traceId}`).changes);
      return changes;
    });
  }

  private record(row: Record<string, unknown>, hydrate = true): JsonObject {
    const payload = JSON.parse(String(row.payload_json)) as JsonObject;
    const record: JsonObject = { ...payload, id: row.id, version: row.version, created_at: row.created_at, updated_at: row.updated_at };
    if (hydrate && record.content_ref && (row.kind === "knowledge_claim" || row.kind === "memory_ledger" || row.kind === "episodic_memory" || row.kind === "semantic_memory")) {
      try { record.content = this.contentStore.readCompatSync(record.content_ref as never).body; }
      catch { record.content_unavailable = true; }
    }
    return record;
  }

  close(): void {
    this.#database?.close();
    this.#database = null;
  }
}
