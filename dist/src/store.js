import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { craftPaths, ensureLayout } from "./paths.js";
export const SCHEMA_VERSION = 2;
const RESERVED_FIELDS = new Set(["id", "version", "created_at", "updated_at"]);
function payloadOnly(payload) {
    return Object.fromEntries(Object.entries(payload).filter(([key]) => !RESERVED_FIELDS.has(key)));
}
function validLimit(limit) {
    if (!Number.isFinite(limit) || !Number.isInteger(limit)) {
        throw new Error("limit must be a finite integer");
    }
    return Math.max(1, limit);
}
export class CraftStore {
    paths;
    #database = null;
    constructor(paths = craftPaths()) {
        this.paths = paths;
    }
    async open() {
        if (this.#database)
            return this;
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
            const schemaRow = database.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
            const previousVersion = Number(schemaRow?.value ?? 0);
            if (previousVersion > SCHEMA_VERSION) {
                throw new Error(`Craft database schema ${previousVersion} is newer than supported schema ${SCHEMA_VERSION}`);
            }
            database.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS capability_fts USING fts5(
      id UNINDEXED,name,description,body,tokenize='unicode61'
    );`);
            if (previousVersion < 2) {
                database.exec(`DELETE FROM capability_fts;
        INSERT INTO capability_fts(id,name,description,body)
        SELECT r.id,json_extract(r.payload_json,'$.name'),json_extract(r.payload_json,'$.description'),
          json_extract(r.payload_json,'$.body') FROM records r JOIN (
            SELECT id,MAX(version) version FROM records WHERE kind='capability' GROUP BY id
          ) latest ON latest.id=r.id AND latest.version=r.version WHERE r.kind='capability';`);
            }
            database.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)")
                .run(String(SCHEMA_VERSION));
            database.exec("COMMIT");
            this.#database = database;
            return this;
        }
        catch (error) {
            database.exec("ROLLBACK");
            database.close();
            throw error;
        }
    }
    get database() {
        if (!this.#database)
            throw new Error("CraftStore is not open.");
        return this.#database;
    }
    transaction(operation) {
        const database = this.database;
        database.exec("BEGIN IMMEDIATE");
        try {
            const result = operation(database);
            database.exec("COMMIT");
            return result;
        }
        catch (error) {
            database.exec("ROLLBACK");
            throw error;
        }
    }
    legacyDatabaseDetected() {
        return existsSync(this.paths.legacyDatabaseFile);
    }
    save(kind, id, payload, version) {
        return this.transaction((database) => this.insert(database, { kind, id, payload, version }));
    }
    saveBatch(entries) {
        if (!entries.length)
            return [];
        return this.transaction((database) => entries.map((entry) => this.insert(database, entry)));
    }
    updateIfVersion(kind, id, expectedVersion, payload) {
        return this.transaction((database) => {
            const current = Number(database.prepare("SELECT COALESCE(MAX(version),0) AS version FROM records WHERE kind=? AND id=?").get(kind, id).version);
            if (current !== expectedVersion)
                throw new Error(`Concurrent update detected for ${kind}: ${id}`);
            return this.insert(database, { kind, id, payload, version: current + 1 });
        });
    }
    insert(database, entry) {
        const { kind, id, version } = entry;
        const payload = payloadOnly(entry.payload);
        const now = new Date().toISOString();
        const next = version ?? Number(database.prepare("SELECT COALESCE(MAX(version),0)+1 AS version FROM records WHERE kind=? AND id=?").get(kind, id).version);
        database.prepare(`INSERT INTO records(
        kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
            .run(kind, id, next, JSON.stringify(payload), now, now);
        if (kind === "capability") {
            database.prepare("DELETE FROM capability_fts WHERE id=?").run(id);
            database.prepare("INSERT INTO capability_fts(id,name,description,body) VALUES(?,?,?,?)")
                .run(id, String(payload.name ?? ""), String(payload.description ?? ""), String(payload.body ?? ""));
        }
        return { ...payload, id, version: next, created_at: now, updated_at: now };
    }
    get(kind, id, version) {
        const row = version === undefined
            ? this.database.prepare("SELECT * FROM records WHERE kind=? AND id=? ORDER BY version DESC LIMIT 1").get(kind, id)
            : this.database.prepare("SELECT * FROM records WHERE kind=? AND id=? AND version=?").get(kind, id, version);
        if (!row)
            throw new Error(`Unknown ${kind}: ${id}`);
        return this.record(row);
    }
    list(kind, limit = 20, predicate) {
        const bounded = validLimit(limit);
        const rows = this.database.prepare(`SELECT r.* FROM records r JOIN (
      SELECT id,MAX(version) version FROM records WHERE kind=? GROUP BY id
      ) latest ON latest.id=r.id AND latest.version=r.version
      WHERE r.kind=? ORDER BY r.updated_at DESC,r.id DESC ${predicate ? "" : "LIMIT ?"}`)
            .all(...(predicate ? [kind, kind] : [kind, kind, bounded]));
        const records = rows.map((row) => this.record(row));
        return (predicate ? records.filter(predicate) : records).slice(0, bounded);
    }
    count(kind) {
        return Number(this.database.prepare(`SELECT COUNT(*) count FROM records r JOIN (
      SELECT id,MAX(version) version FROM records WHERE kind=? GROUP BY id
      ) latest ON latest.id=r.id AND latest.version=r.version WHERE r.kind=?`)
            .get(kind, kind).count);
    }
    searchCapabilities(terms, limit) {
        const bounded = Math.min(validLimit(limit), 20);
        if (!terms.length)
            return [];
        const expression = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
        const rows = this.database.prepare(`SELECT r.*,bm25(capability_fts) rank FROM capability_fts
      JOIN records r ON r.kind='capability' AND r.id=capability_fts.id
      JOIN (SELECT id,MAX(version) version FROM records WHERE kind='capability' GROUP BY id) latest
        ON latest.id=r.id AND latest.version=r.version
      WHERE capability_fts MATCH ? ORDER BY rank LIMIT ?`).all(expression, bounded);
        return rows.map((row) => {
            const item = row;
            return { ...this.record(item), score: -Number(item.rank) };
        });
    }
    remove(kind, id) {
        return this.transaction((database) => {
            const changes = Number(database.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id).changes);
            if (kind === "capability")
                database.prepare("DELETE FROM capability_fts WHERE id=?").run(id);
            return changes;
        });
    }
    appendEvent(stream, eventType, payload) {
        return this.transaction((database) => {
            const sequence = Number(database.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM events WHERE stream=?").get(stream).sequence);
            const created_at = new Date().toISOString();
            database.prepare(`INSERT INTO events(
        stream,sequence,event_type,payload_json,created_at) VALUES(?,?,?,?,?)`)
                .run(stream, sequence, eventType, JSON.stringify(payload), created_at);
            return { stream, sequence, event_type: eventType, payload, created_at };
        });
    }
    events(stream) {
        return this.database.prepare("SELECT * FROM events WHERE stream=? ORDER BY sequence").all(stream).map((row) => {
            const item = row;
            return { stream: item.stream, sequence: item.sequence, event_type: item.event_type,
                payload: JSON.parse(String(item.payload_json)), created_at: item.created_at };
        });
    }
    record(row) {
        return { ...JSON.parse(String(row.payload_json)), id: row.id, version: row.version,
            created_at: row.created_at, updated_at: row.updated_at };
    }
    close() {
        this.#database?.close();
        this.#database = null;
    }
}
//# sourceMappingURL=store.js.map