import { existsSync, lstatSync, mkdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, backupDatabase } from "./store-migrations.ts";
import { craftPaths, ensureLayout, type CraftPaths } from "./paths.ts";
import { MarkdownContentStore, type ContentKind } from "./content-store.ts";
import { dirname, join } from "node:path";

import { SCHEMA_VERSION } from "./store-schema.ts";
export { SCHEMA_VERSION } from "./store-schema.ts";
export type JsonObject = Record<string, unknown>;
export type SaveEntry = { kind: string; id: string; payload: JsonObject; version?: number };
export type RawRecord = { kind: string; id: string; version: number; payload: JsonObject; created_at: string; updated_at: string };
const RESERVED_FIELDS = new Set(["id", "version", "created_at", "updated_at"]);
const CONTENT_REFERENCE_RECORD_KINDS = [
  "knowledge_claim", "knowledge_fragment", "wiki_page",
  "memory_ledger", "episodic_memory", "semantic_memory",
  "experience_procedure",
] as const;
const MEMORY_PARTITIONED_KINDS = new Set([
  "memory_item", "episodic_memory", "semantic_memory", "memory_ledger", "memory_candidate", "memory_observation",
  "memory_confirmation", "memory_policy", "memory_compat_binding", "memory_consolidation", "memory_usage_signal",
  "memory_maintenance_candidate", "memory_maintenance_run", "memory_learning_cycle", "memory_session_archive",
]);
type MemoryScope = { kind: "global" | "user" | "project" | "workspace" | "task" | "session" | "team" | "organization"; id: string };

export function assertRegularSessionMemoryDirectories(dataRoot = join("/tmp", ".craft_data")): void {
  const memoryRoot = join(dataRoot, "memory");
  for (const directory of [dataRoot, memoryRoot]) {
    try { const stat = lstatSync(directory); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Session Memory path must use regular directories"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

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
  #memoryDatabases = new Map<string, DatabaseSync>();
  #pendingMemoryRows: Array<{ file: string; kind: string; id: string; version: number }> = [];

  constructor(paths = craftPaths()) {
    this.paths = paths;
    this.contentStore = new MarkdownContentStore(paths);
    this.contentStore.setProjectMemoryDirectoryResolver((scope, options) => {
      const projectId = scope.slice("project:".length);
      if (!projectId) return null;
      const roots = this.projectRoots(projectId);
      const preferred = options.project_root && roots.includes(realpathSync(options.project_root)) ? realpathSync(options.project_root) : undefined;
      const root = preferred ?? (roots.length === 1 ? roots[0] : undefined);
      return root ? this.projectMemoryDirectory(root, ["md"], options.create === true) : null;
    });
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
    } catch (error) {
      database.close();
      throw error;
    }
    this.#database = database;
    try {
      this.migrateLegacyMemoryRecords();
      this.rebuildDomainIndexes(database);
    } catch (error) {
      for (const partition of this.#memoryDatabases.values()) partition.close();
      this.#memoryDatabases.clear();
      this.#database = null;
      database.close();
      throw error;
    }
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
    // `records` also contains large trace and archive payloads. Loading the whole table with
    // `.all()` made every MCP product startup scale with the complete event history. The
    // primary key starts with `kind`, so restrict the cursor to record families that can own a
    // Markdown content reference and keep only one row resident at a time.
    const placeholders = CONTENT_REFERENCE_RECORD_KINDS.map(() => "?").join(",");
    const rows = database.prepare(`SELECT kind,id,version,payload_json,updated_at FROM records WHERE kind IN (${placeholders})`);
    for (const [path, domain] of entries) {
      const index = new DatabaseSync(path);
      try {
        index.exec("PRAGMA busy_timeout=15000; PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS content_index (kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, content_ref TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(kind,id,version)); DELETE FROM content_index;");
        const insert = index.prepare("INSERT INTO content_index(kind,id,version,content_ref,updated_at) VALUES(?,?,?,?,?)");
        for (const row of rows.iterate(...CONTENT_REFERENCE_RECORD_KINDS) as Iterable<Record<string, unknown>>) {
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
    const pendingStart = this.#pendingMemoryRows.length;
    const savepoint = `craft_atomic_${this.#transactionDepth}`;
    database.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    this.#transactionDepth += 1;
    try {
      const result = operation(database);
      database.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
      this.#transactionDepth -= 1;
      if (!nested) this.#pendingMemoryRows.splice(pendingStart);
      return result;
    } catch (error) {
      this.#transactionDepth -= 1;
      database.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
      const abandoned = this.#pendingMemoryRows.splice(pendingStart);
      this.cleanupMemoryRows(abandoned);
      throw error;
    }
  }

  private cleanupMemoryRows(rows: Array<{ file: string; kind: string; id: string; version: number }>): void {
    for (const row of rows) this.#memoryDatabases.get(row.file)?.prepare("DELETE FROM records WHERE kind=? AND id=? AND version=?")
      .run(row.kind, row.id, row.version);
  }

  legacyDatabaseDetected(): boolean {
    return existsSync(this.paths.legacyDatabaseFile);
  }

  save(kind: string, id: string, payload: JsonObject, version?: number): JsonObject {
    if (this.memoryScope(kind, payload)) return this.writeMemory(kind, id, payload, "save");
    return this.transaction((database) => this.insert(database, { kind, id, payload, version }));
  }

  create(kind: string, id: string, payload: JsonObject): JsonObject {
    if (this.memoryScope(kind, payload)) return this.writeMemory(kind, id, payload, "create");
    return this.transaction((database) => {
      const existing = database.prepare("SELECT 1 present FROM records WHERE kind=? AND id=? LIMIT 1")
        .get(kind, id);
      if (existing) throw new Error(`${kind} already exists: ${id}`);
      return this.insert(database, { kind, id, payload, version: 1 });
    });
  }

  /** Create an immutable set atomically with one transaction/savepoint and bounded duplicate checks. */
  createBatch(entries: readonly SaveEntry[]): JsonObject[] {
    if (!entries.length) return [];
    return this.transaction((database) => {
      const seen = new Set<string>();
      const idsByKind = new Map<string, string[]>();
      for (const entry of entries) {
        const key = JSON.stringify([entry.kind, entry.id]);
        if (seen.has(key)) throw new Error(`${entry.kind} already exists: ${entry.id}`);
        seen.add(key);
        const ids = idsByKind.get(entry.kind) ?? [];
        ids.push(entry.id);
        idsByKind.set(entry.kind, ids);
      }
      for (const [kind, ids] of idsByKind) for (let offset = 0; offset < ids.length; offset += 500) {
        const chunk = ids.slice(offset, offset + 500);
        const placeholders = chunk.map(() => "?").join(",");
        const existing = database.prepare(`SELECT id FROM records WHERE kind=? AND id IN (${placeholders}) LIMIT 1`)
          .get(kind, ...chunk) as { id: string } | undefined;
        if (existing) throw new Error(`${kind} already exists: ${existing.id}`);
      }
      const insert = database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)");
      return entries.map((entry) => {
        const payload = payloadOnly(entry.payload);
        const now = new Date().toISOString();
        insert.run(entry.kind, entry.id, 1, JSON.stringify(payload), now, now);
        return { ...payload, id: entry.id, version: 1, created_at: now, updated_at: now };
      });
    });
  }

  saveBatch(entries: SaveEntry[]): JsonObject[] {
    if (!entries.length) return [];
    return this.transaction((database) => entries.map((entry) => this.insert(database, entry)));
  }

  updateIfVersion(kind: string, id: string, expectedVersion: number, payload: JsonObject): JsonObject {
    if (this.memoryScope(kind, payload)) return this.writeMemory(kind, id, payload, "save", expectedVersion);
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

  private memoryScope(kind: string, payload: JsonObject): MemoryScope | null {
    if (!MEMORY_PARTITIONED_KINDS.has(kind)) return null;
    let value = payload.scope;
    if (kind === "memory_confirmation" && (!value || typeof value !== "object")) {
      const memoryId = typeof payload.memory_id === "string" ? payload.memory_id : "";
      value = memoryId ? this.find("memory_ledger", memoryId, undefined, false)?.scope : undefined;
    }
    if (kind === "memory_observation" && (!value || typeof value !== "object") && typeof payload.project_id === "string") {
      value = { kind: "project", id: payload.project_id };
    }
    if (value === undefined && typeof payload.scope_kind === "string" && typeof payload.scope_id === "string") {
      value = { kind: payload.scope_kind, id: payload.scope_id };
    }
    if (value === undefined || value === null) value = { kind: "global", id: "global" };
    if (typeof value === "string") {
      if (value === "global") value = { kind: "global", id: "global" };
      else {
        const separator = value.indexOf(":");
        if (separator > 0) value = { kind: value.slice(0, separator), id: value.slice(separator + 1) };
        else if (["user", "task", "workspace"].includes(value)) {
          const scopedId = payload[`${value}_id`];
          value = { kind: value, id: typeof scopedId === "string" && scopedId.trim() ? scopedId : "legacy" };
        }
        else throw new Error("Memory storage scope is malformed");
      }
    }
    if (typeof value !== "object" || Array.isArray(value)) throw new Error("Memory storage scope is malformed");
    const scope = value as Record<string, unknown>;
    if (!["global", "user", "project", "workspace", "task", "session", "team", "organization"].includes(String(scope.kind)) || typeof scope.id !== "string" || !scope.id.trim()) {
      throw new Error("Memory storage scope is malformed");
    }
    return { kind: scope.kind as MemoryScope["kind"], id: scope.id };
  }

  private memoryDatabaseFile(scope: MemoryScope): string {
    if (scope.kind === "global" || scope.kind === "user") return this.paths.memoryDatabaseFile;
    if (scope.kind === "session" || scope.kind === "task") {
      const id = scope.id;
      if (id.trim() !== id || Buffer.byteLength(id, "utf8") > 255 || id === "." || id === ".." || /[/\\\x00-\x1f\x7f]/u.test(id)) {
        throw new Error("session_id must be one bounded, safe directory name");
      }
      const memoryRoot = join("/tmp", ".craft_data", "memory");
      assertRegularSessionMemoryDirectories();
      return scope.kind === "session" ? join(memoryRoot, id, "memory.db") : join(this.paths.runtimeDir, "memory-tasks", id, "memory.db");
    }
    if (scope.kind !== "project") {
      const digest = createHash("sha256").update(scope.id).digest("hex").slice(0, 24);
      return join(this.paths.memoryDir, "scopes", `${scope.kind}-${digest}`, "memory.db");
    }
    const roots = this.projectRoots(scope.id);
    if (roots.length !== 1) throw new Error(roots.length ? "Project Memory storage root is ambiguous" : "Project Memory storage root is not registered");
    const directory = this.projectMemoryDirectory(roots[0]!, [], true)!;
    return join(directory, "memory.db");
  }

  private projectMemoryDirectory(root: string, children: string[], create: boolean): string | null {
    let directory = root;
    for (const part of [".craft_data", "memory", ...children]) {
      directory = join(directory, part);
      try {
        const stat = lstatSync(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Project Memory path must use regular directories");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (!create) return null;
        mkdirSync(directory, { mode: 0o700 });
      }
    }
    return directory;
  }

  private projectRoots(projectId: string): string[] {
    const acceptedProjectIds = new Set([projectId, projectId.startsWith("project:") ? projectId : `project:${projectId}`]);
    const rows = this.database.prepare("SELECT payload_json FROM records WHERE kind='scope_alias'").all() as Array<{ payload_json: string }>;
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload_json) as JsonObject;
        const scope = payload.scope as JsonObject | undefined;
        if (payload.status === "active" && payload.alias_kind === "legacy"
          && [projectId, `project:${projectId}`].includes(String(payload.alias))
          && scope?.kind === "project" && typeof scope.id === "string") acceptedProjectIds.add(scope.id);
      } catch { /* malformed aliases are ignored */ }
    }
    return [...new Set(rows.flatMap(row => {
      try {
        const payload = JSON.parse(row.payload_json) as JsonObject;
        const rowScope = payload.scope as JsonObject | undefined;
        if (payload.status !== "active" || payload.alias_kind !== "path" || rowScope?.kind !== "project" || !acceptedProjectIds.has(String(rowScope.id)) || typeof payload.alias !== "string") return [];
        const path = realpathSync(payload.alias);
        return statSync(path).isDirectory() ? [path] : [];
      } catch { return []; }
    }))].sort();
  }

  private memoryDatabase(scope: MemoryScope): { database: DatabaseSync; file: string } {
    const file = this.memoryDatabaseFile(scope);
    const existing = this.#memoryDatabases.get(file);
    if (existing) return { database: existing, file };
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    if (scope.kind === "session" || scope.kind === "task") {
      const directory = dirname(file);
      const stat = lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Session Memory path must use regular directories");
    }
    try { const stat = lstatSync(file); if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Memory database must be a regular file"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const database = new DatabaseSync(file);
    try {
      database.exec("PRAGMA busy_timeout=15000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
      applyMigrations(database);
      database.exec("CREATE TABLE IF NOT EXISTS content_index (kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, content_ref TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(kind,id,version))");
    } catch (error) { database.close(); throw error; }
    this.#memoryDatabases.set(file, database);
    return { database, file };
  }

  private migrateLegacyMemoryRecords(): void {
    const kinds = [...MEMORY_PARTITIONED_KINDS];
    const placeholders = kinds.map(() => "?").join(",");
    const database = this.database;
    const rows = database.prepare(`SELECT kind,id,version,payload_json,created_at,updated_at FROM records WHERE kind IN (${placeholders}) AND json_extract(payload_json,'$._memory_partition') IS NULL ORDER BY CASE kind WHEN 'memory_ledger' THEN 0 WHEN 'memory_candidate' THEN 1 WHEN 'memory_observation' THEN 2 ELSE 3 END,kind,id,version`).all(...kinds) as Array<Record<string, unknown>>;
    if (!rows.length) return;
    database.exec("PRAGMA wal_checkpoint(FULL)");
    this.backup();
    const retiredContent: string[] = [];
    for (const row of rows) {
      const kind = String(row.kind), id = String(row.id), version = Number(row.version);
      const payload = JSON.parse(String(row.payload_json)) as JsonObject;
      // `kind` comes from MEMORY_PARTITIONED_KINDS above, so this cannot be null.
      const scope = this.memoryScope(kind, payload)!;
      let migratedPayload = { ...payload };
      if (kind === "memory_ledger") migratedPayload = { ...migratedPayload,
        status: String(payload.status ?? "active"), sensitivity: String(payload.sensitivity ?? "internal") };
      const ref = migratedPayload.content_ref as JsonObject | undefined;
      if (kind === "memory_ledger" && ref && typeof ref.path === "string") {
        const body = this.contentStore.readCompatSync(ref as never, `${scope.kind}:${scope.id}`).body;
        const expectedRoot = scope.kind === "project" ? dirname(dirname(dirname(this.memoryDatabaseFile(scope)))) : undefined;
        const next = this.contentStore.writeSync({ kind: "memory", record_id: id, version, scope: `${scope.kind}:${scope.id}`,
          status: String(payload.status ?? "active"), sensitivity: String(payload.sensitivity ?? "internal"), source_id: String(payload.source_id), body,
          ...(expectedRoot ? { project_root: expectedRoot } : {}) });
        migratedPayload = { ...migratedPayload, content_ref: next };
        if (ref.path !== next.path) retiredContent.push(ref.path);
      }
      const { database: partition, file } = this.memoryDatabase(scope);
      const existing = partition.prepare("SELECT payload_json,created_at,updated_at FROM records WHERE kind=? AND id=? AND version=?").get(kind, id, version) as Record<string, unknown> | undefined;
      if (existing) {
        if (String(existing.payload_json) !== JSON.stringify(migratedPayload)) throw new Error(`Memory migration collision: ${kind}/${id}@${version}`);
      } else {
        partition.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
          .run(kind, id, version, JSON.stringify(migratedPayload), String(row.created_at), String(row.updated_at));
      }
      this.updateMemoryContentIndex(partition, kind, id, version, migratedPayload, String(row.updated_at));
      const header = this.memoryHeader(migratedPayload, scope, file);
      database.prepare("UPDATE records SET payload_json=? WHERE kind=? AND id=? AND version=?")
        .run(JSON.stringify(header), kind, id, version);
    }
    for (const path of retiredContent) {
      if (!path.startsWith(this.paths.memoryContentDir + "/")) continue;
      try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  private memoryHeader(payload: JsonObject, scope: MemoryScope, file: string): JsonObject {
    const projection: JsonObject = { scope };
    for (const key of ["source_id", "content_ref", "content_digest", "memory_id", "memory_version"]) {
      if (payload[key] !== undefined) projection[key] = payload[key];
    }
    return { ...projection, _memory_partition: { file, scope } };
  }

  private memoryPointer(kind: string, id: string, version?: number): JsonObject | null {
    const row = version === undefined
      ? this.database.prepare("SELECT payload_json FROM records WHERE kind=? AND id=? ORDER BY version DESC LIMIT 1").get(kind, id)
      : this.database.prepare("SELECT payload_json FROM records WHERE kind=? AND id=? AND version=?").get(kind, id, version);
    if (!row) return null;
    const payload = JSON.parse(String((row as { payload_json: string }).payload_json)) as JsonObject;
    return payload._memory_partition && typeof payload._memory_partition === "object" ? payload._memory_partition as JsonObject : null;
  }

  private writeMemory(kind: string, id: string, payload: JsonObject, mode: "create" | "save", expectedVersion?: number): JsonObject {
    const scope = this.memoryScope(kind, payload)!;
    const current = this.find(kind, id, undefined, false);
    if (mode === "create" && current) throw new Error(`${kind} already exists: ${id}`);
    if (mode === "save" && current && JSON.stringify(current.scope) !== JSON.stringify(scope)) {
      throw new Error("Memory record cannot change storage scope");
    }
    if (expectedVersion !== undefined && Number(current?.version ?? 0) !== expectedVersion) throw new Error(`Concurrent update detected for ${kind}: ${id}`);
    const { database: partition, file } = this.memoryDatabase(scope);
    if (mode === "create" && partition.prepare("SELECT 1 present FROM records WHERE kind=? AND id=? LIMIT 1").get(kind, id)) throw new Error(`${kind} already exists: ${id}`);
    const partitionVersion = Number((partition.prepare("SELECT COALESCE(MAX(version),0)+1 version FROM records WHERE kind=? AND id=?").get(kind, id) as { version: number }).version);
    const partitionPayload = { ...Object.fromEntries(Object.entries(payload).filter(([key]) => !RESERVED_FIELDS.has(key))), scope };
    const saved = this.transactionOn(partition, () => {
      const record = this.insert(partition, { kind, id, payload: partitionPayload, version: partitionVersion });
      this.updateMemoryContentIndex(partition, kind, id, Number(record.version), partitionPayload, String(record.updated_at));
      return record;
    });
    const header = this.memoryHeader(partitionPayload, scope, file);
    this.transaction((main) => {
      this.#pendingMemoryRows.push({ file, kind, id, version: partitionVersion });
      main.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
        .run(kind, id, Number(saved.version), JSON.stringify(header), String(saved.created_at), String(saved.updated_at));
    });
    return saved;
  }

  private transactionOn<T>(database: DatabaseSync, operation: () => T): T {
    database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); database.exec("COMMIT"); return result; }
    catch (error) { database.exec("ROLLBACK"); throw error; }
  }

  private updateMemoryContentIndex(database: DatabaseSync, kind: string, id: string, version: number, payload: JsonObject, updatedAt: string): void {
    const ref = payload.content_ref;
    if (!ref || typeof ref !== "object" || Array.isArray(ref) || (ref as JsonObject).kind !== "memory") {
      database.prepare("DELETE FROM content_index WHERE kind=? AND id=? AND version=?").run(kind, id, version);
      return;
    }
    database.prepare("INSERT OR REPLACE INTO content_index(kind,id,version,content_ref,updated_at) VALUES(?,?,?,?,?)")
      .run(kind, id, version, JSON.stringify(ref), updatedAt);
  }

  find(kind: string, id: string, version?: number, hydrate = true): JsonObject | null {
    const row = version === undefined
      ? this.database.prepare(
        "SELECT * FROM records WHERE kind=? AND id=? ORDER BY version DESC LIMIT 1",
      ).get(kind, id)
      : this.database.prepare(
        "SELECT * FROM records WHERE kind=? AND id=? AND version=?",
      ).get(kind, id, version);
    if (!row) return null;
    const raw = row as Record<string, unknown>;
    const pointer = JSON.parse(String(raw.payload_json)) as JsonObject;
    const partition = pointer._memory_partition as JsonObject | undefined;
    if (partition && partition.scope && typeof partition.scope === "object") {
      const scope = partition.scope as MemoryScope;
      const target = this.memoryDatabase(scope).database;
      const source = target.prepare("SELECT * FROM records WHERE kind=? AND id=? AND version=?").get(kind, id, Number(raw.version));
      if (!source) throw new Error(`Memory partition record is missing: ${kind}/${id}@${String(raw.version)}`);
      return this.record(source as Record<string, unknown>, hydrate);
    }
    return this.record(raw, hydrate);
  }

  private recordFromSnapshot(row: Record<string, unknown>, hydrate: boolean): JsonObject {
    const pointer = JSON.parse(String(row.payload_json)) as JsonObject;
    const partition = pointer._memory_partition as JsonObject | undefined;
    if (!partition || !partition.scope || typeof partition.scope !== "object") return this.record(row, hydrate);
    const target = this.memoryDatabase(partition.scope as MemoryScope).database;
    const source = target.prepare("SELECT * FROM records WHERE kind=? AND id=? AND version=?")
      .get(String(row.kind), String(row.id), Number(row.version));
    if (!source) throw new Error(`Memory partition record is missing: ${String(row.kind)}/${String(row.id)}@${String(row.version)}`);
    return this.record(source as Record<string, unknown>, hydrate);
  }

  /** Read a bounded set of latest records with one query per SQLite parameter batch. */
  findMany(kind: string, ids: readonly string[], hydrate = true): JsonObject[] {
    if (typeof kind !== "string" || !kind.trim()) throw new Error("kind must not be empty");
    if (!Array.isArray(ids) || ids.length > 10_000 || ids.some(id => typeof id !== "string" || !id.trim())) throw new Error("record ids exceed read bounds");
    const unique = [...new Set(ids)];
    const byId = new Map<string, JsonObject>();
    for (let offset = 0; offset < unique.length; offset += 500) {
      const batch = unique.slice(offset, offset + 500);
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.database.prepare(`SELECT r.* FROM records r JOIN (
        SELECT id,MAX(version) version FROM records WHERE kind=? AND id IN (${placeholders}) GROUP BY id
        ) latest ON latest.id=r.id AND latest.version=r.version WHERE r.kind=?`)
        .all(kind, ...batch, kind) as Array<Record<string, unknown>>;
      for (const row of rows) byId.set(String(row.id), this.record(row, hydrate));
    }
    return unique.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
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
      const header = row as Record<string, unknown>;
      const record = this.find(kind, String(header.id), Number(header.version), hydrate)!;
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
      json_extract(r.payload_json,'$.scope')=json_extract(s.value,'$.kind')||':'||json_extract(s.value,'$.id')
      OR (json_extract(s.value,'$.kind')='global' AND json_extract(r.payload_json,'$.scope')='global')
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
        const header = row as Record<string, unknown>;
        const item = this.recordFromSnapshot(header, false);
        if (predicate && !predicate(item)) continue;
        selected.push(this.recordFromSnapshot(header, true));
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

  /** Fingerprint exact latest record payloads without parsing or hydrating them. */
  latestRecordsDigest(kind: string, ids: readonly string[]): string {
    if (typeof kind !== "string" || !kind.trim()) throw new Error("kind must not be empty");
    if (!Array.isArray(ids) || ids.length > 10_000 || ids.some(id => typeof id !== "string" || !id.trim())) throw new Error("record ids exceed digest bounds");
    const requested = [...new Set(ids)].sort();
    const hash = createHash("sha256");
    hash.update(kind).update("\0");
    if (requested.length) {
      const placeholders = requested.map(() => "?").join(",");
      const rows = this.database.prepare(`SELECT r.id,r.version,r.payload_json FROM records r JOIN (
        SELECT id,MAX(version) version FROM records WHERE kind=? AND id IN (${placeholders}) GROUP BY id
        ) latest ON latest.id=r.id AND latest.version=r.version WHERE r.kind=? ORDER BY r.id`)
        .all(kind, ...requested, kind) as Array<{ id: string; version: number; payload_json: string }>;
      const byId = new Map(rows.map(row => [row.id, row]));
      for (const id of requested) {
        const row = byId.get(id);
        if (!row) { hash.update(id).update("\0missing\0"); continue; }
        hash.update(id).update("\0").update(String(row.version)).update("\0")
          .update(String(Buffer.byteLength(row.payload_json, "utf8"))).update("\0").update(row.payload_json).update("\0");
      }
    }
    return hash.digest("hex");
  }

  /** Bounded metadata history for one asset. Scope/ACL checks belong to its caller. */
  history(kind: string, id: string, before: number, limit: number): JsonObject[] {
    if (!Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 101) throw new Error("Invalid history bounds");
    const rows = this.database.prepare("SELECT * FROM records WHERE kind=? AND id=? AND version<? ORDER BY version DESC LIMIT ?").all(kind, id, before, limit);
    return rows.map(row => this.find(kind, id, Number(row.version), false)!).filter(Boolean);
  }

  /** Return every stored version without hydrating Markdown content. Used by
   * reversible content migrations and integrity tooling only. */
  rawRecords(kind?: string): RawRecord[] {
    const rows = kind === undefined
      ? this.database.prepare("SELECT * FROM records ORDER BY kind,id,version").all()
      : this.database.prepare("SELECT * FROM records WHERE kind=? ORDER BY id,version").all(kind);
    return rows.map((row) => {
      const item = row as Record<string, unknown>;
      const record = this.find(String(item.kind), String(item.id), Number(item.version), false)!;
      const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...payload } = record;
      return { kind: String(item.kind), id: String(item.id), version: Number(item.version), payload,
        created_at: String(record.created_at), updated_at: String(record.updated_at) };
    });
  }

  /** Migration-only in-place payload replacement. The caller must create a
   * database backup first; ordinary domain updates remain append-only. */
  replacePayload(kind: string, id: string, version: number, payload: JsonObject): void {
    const current = this.find(kind, id, version, false);
    const pointer = this.memoryPointer(kind, id, version);
    if (current && pointer) {
      const scope = current.scope as MemoryScope;
      const target = this.memoryDatabase(scope).database;
      const clean = Object.fromEntries(Object.entries(payload).filter(([key]) => !RESERVED_FIELDS.has(key)));
      const updatedAt = new Date().toISOString();
      this.transactionOn(target, () => {
        const result = target.prepare("UPDATE records SET payload_json=?,updated_at=? WHERE kind=? AND id=? AND version=?")
          .run(JSON.stringify(clean), updatedAt, kind, id, version);
        if (Number(result.changes) !== 1) throw new Error(`Unknown record version: ${kind}/${id}/${version}`);
        this.updateMemoryContentIndex(target, kind, id, version, clean, updatedAt);
      });
      this.transaction((database) => database.prepare("UPDATE records SET payload_json=?,updated_at=? WHERE kind=? AND id=? AND version=?")
        .run(JSON.stringify(this.memoryHeader(clean, scope, this.memoryDatabaseFile(scope))), updatedAt, kind, id, version));
      return;
    }
    this.transaction((database) => {
      const result = database.prepare("UPDATE records SET payload_json=?,updated_at=? WHERE kind=? AND id=? AND version=?")
        .run(JSON.stringify(payloadOnly(payload)), new Date().toISOString(), kind, id, version);
      if (Number(result.changes) !== 1) throw new Error(`Unknown record version: ${kind}/${id}/${version}`);
    });
  }

  replacePayloadBatch(entries: Array<{ kind: string; id: string; version: number; payload: JsonObject }>): void {
    if (!entries.length) return;
    if (entries.some(entry => this.memoryPointer(entry.kind, entry.id, entry.version))) {
      for (const entry of entries) this.replacePayload(entry.kind, entry.id, entry.version, entry.payload);
      return;
    }
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
    const current = this.find(kind, id, undefined, false);
    const pointer = this.memoryPointer(kind, id);
    if (current && pointer) {
      const target = this.memoryDatabase(current.scope as MemoryScope).database;
      const removed = Number(target.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id).changes);
      target.prepare("DELETE FROM content_index WHERE kind=? AND id=?").run(kind, id);
      this.transaction((database) => database.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id));
      return removed;
    }
    return this.transaction((database) => {
      const changes = Number(database.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id).changes);
      return changes;
    });
  }

  closeMemoryScope(scope: { kind: string; id: string }): void {
    const file = this.memoryDatabaseFile(scope as MemoryScope);
    const database = this.#memoryDatabases.get(file);
    if (!database) return;
    database.close();
    this.#memoryDatabases.delete(file);
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
  removeTraceRecords(traceId: string, eventIds: readonly string[], feedbackIds: readonly string[], telemetryIds: readonly string[] = []): number {
    return this.transaction((database) => {
      let changes = Number(database.prepare("DELETE FROM records WHERE kind='trace' AND id=?").run(traceId).changes);
      for (const id of eventIds) changes += Number(database.prepare("DELETE FROM records WHERE kind='trace_event' AND id=?").run(id).changes);
      for (const id of feedbackIds) changes += Number(database.prepare("DELETE FROM records WHERE kind='trace_feedback' AND id=?").run(id).changes);
      for (const id of telemetryIds) changes += Number(database.prepare("DELETE FROM records WHERE kind='telemetry_event' AND id=? AND json_extract(payload_json, '$.trace_id')=?").run(id, traceId).changes);
      changes += Number(database.prepare("DELETE FROM events WHERE stream=?").run(`trace:${traceId}`).changes);
      return changes;
    });
  }

  private record(row: Record<string, unknown>, hydrate = true): JsonObject {
    const payload = JSON.parse(String(row.payload_json)) as JsonObject;
    const record: JsonObject = { ...payload, id: row.id, version: row.version, created_at: row.created_at, updated_at: row.updated_at };
    if (hydrate && record.content_ref && (row.kind === "knowledge_claim" || row.kind === "memory_ledger" || row.kind === "episodic_memory" || row.kind === "semantic_memory")) {
      try { record.content = this.contentStore.readCompatSync(record.content_ref as never, typeof record.scope === "string" ? record.scope : undefined).body; }
      catch { record.content_unavailable = true; }
    }
    return record;
  }

  close(): void {
    for (const database of this.#memoryDatabases.values()) database.close();
    this.#memoryDatabases.clear();
    this.#database?.close();
    this.#database = null;
  }
}
