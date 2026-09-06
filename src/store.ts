import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { craftPaths, ensureLayout, type CraftPaths } from "./paths.ts";

export const SCHEMA_VERSION = 1;

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

  close(): void {
    this.#database?.close();
    this.#database = null;
  }
}
