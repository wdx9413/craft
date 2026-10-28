import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { AsyncLocalStorage } from "node:async_hooks";
import { applyMigrations, backupDatabase } from "./store-migrations.ts";
import { canonicalCandidatePath, craftPaths, ensureLayout, ensureProjectStorageDirectory, existingProjectStorageDirectory, projectStorageDirectory,
  ensureSessionStorageDirectory, ensureSessionStorageDirectoryForScopeId, isLegacySafeSessionId, parseSessionStorageScopeId, sessionStorageDirectory,
  sessionStorageDirectoryForScopeId, sessionStorageScopeId, type CraftPaths } from "./paths.ts";
import { MarkdownContentStore, type ContentKind, type ContentRef } from "./content-store.ts";
import { TraceShardStore, TRACE_SHARDED_KINDS } from "./trace-shards.ts";
import { CodebaseShardStore, CODEBASE_GRAPH_KINDS } from "./codebase-shards.ts";
import { sqliteBusyTimeoutMs } from "./sqlite-busy-timeout.ts";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import { SCHEMA_VERSION } from "./store-schema.ts";
export { SCHEMA_VERSION } from "./store-schema.ts";
export type JsonObject = Record<string, unknown>;
const contextLockBudget = new AsyncLocalStorage<number>();

/** Bound only primary writer acquisition for latency-sensitive Context calls. */
export function withContextLockBudget<T>(operation: () => T): T {
  return contextLockBudget.run(250, operation);
}
export type SaveEntry = { kind: string; id: string; payload: JsonObject; version?: number };
export type RawRecord = { kind: string; id: string; version: number; payload: JsonObject; created_at: string; updated_at: string };
const RESERVED_FIELDS = new Set(["id", "version", "created_at", "updated_at", "_craft_logical_record_id"]);
// Scope aliases are strings; canonicalJson(string) is exactly JSON.stringify(string).
function scopeAliasDigest(alias: string): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(alias)).digest("hex")}`;
}
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
const EXPERIENCE_PARTITIONED_KINDS = new Set([
  "experience_evaluation_dispatch", "experience_graph_draft", "experience_improvement_proposal", "experience_intervention",
  "experience_asset_migration", "experience_asset_migration_failure", "experience_legacy_source", "experience_mining_candidate", "experience_observation", "experience_pattern",
  "experience_procedure", "experience_procedure_gate", "experience_release", "experience_scenario_classification_request_ref",
  "experience_shadow_evaluation", "experience_shadow_experiment", "experience_skill_export",
  "workflow_evolution_observation", "workflow_evolution_proposal", "workflow_evolution_request",
]);
const EVOLUTION_PARTITIONED_KINDS = new Set(["evolution_cycle"]);
type PartitionDomain = "memory" | "experience" | "knowledge" | "evolution";
const PARTITION_LABELS: Record<PartitionDomain, string> = { memory: "Memory", experience: "Experience", knowledge: "Knowledge", evolution: "Evolution" };
type MemoryScope = { kind: "global" | "user" | "project" | "workspace" | "task" | "session" | "team" | "organization" | "legacy"; id: string };
type MigrationBackupFileOps = { write: typeof writeFileSync; rename: typeof renameSync; unlink: typeof unlinkSync };
type ContentMigrationSnapshot = { path: string; digest: string; markdown: string };
type PartitionRow = { file: string; kind: string; id: string; version: number; logicalId?: string };

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

function blockedSummary(blocked: JsonObject[], summaryOnly: boolean): JsonObject {
  const reasons: Record<string, number> = {};
  for (const item of blocked) {
    const reason = String(item.reason);
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  return summaryOnly ? { blocked: [], blocked_count: blocked.length, blocked_reasons: reasons }
    : { blocked, blocked_count: blocked.length };
}

function knowledgeMigrationFailureKind(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /database is locked|SQLITE_BUSY/u.test(message) ? "write_lock"
    : /Content reference path is outside the canonical directory/u.test(message) ? "content_path_out_of_scope"
    : /collision/u.test(message) ? "version_collision"
    : /no such file|ENOENT/u.test(message) ? "source_missing"
    : /Project Knowledge storage root is not registered/u.test(message) ? "project_root_missing"
    : /Project Knowledge storage root is ambiguous/u.test(message) ? "project_root_ambiguous"
    : /scope/u.test(message) ? "scope_validation"
    : /content|digest|manifest/u.test(message) ? "content_validation"
    : "other";
}

function blockedFailureKinds(blocked: JsonObject[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of blocked) if (typeof item.failure_kind === "string") {
    result[item.failure_kind] = (result[item.failure_kind] ?? 0) + 1;
  }
  return result;
}

function blockedFailurePhases(blocked: JsonObject[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of blocked) if (typeof item.failure_phase === "string") {
    result[item.failure_phase] = (result[item.failure_phase] ?? 0) + 1;
  }
  return result;
}

function storedSchemaVersion(database: DatabaseSync): number {
  try {
    const row = database.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value?: string } | undefined;
    return Number(row?.value ?? 0);
  } catch {
    return 0;
  }
}

function tableExists(database: DatabaseSync, name: string): boolean {
  return database.prepare("SELECT 1 present FROM sqlite_master WHERE type='table' AND name=? LIMIT 1").get(name) !== undefined;
}

function storageFailure(error: unknown, database: DatabaseSync, role: string, phase: string, waitedMs?: number): unknown {
  if (!error || typeof error !== "object") return error;
  const value = error as { code?: unknown; errcode?: unknown; message?: unknown; stage?: unknown; safeDetails?: unknown };
  const busy = value.code === "ERR_SQLITE_ERROR" && [5, 6].includes(Number(value.errcode))
    || /database (?:is )?(?:locked|busy)|sqlite_busy|sqlite_locked/iu.test(String(value.message ?? ""));
  if (!busy) return error;
  let busyTimeoutMs: number | null = null;
  try { busyTimeoutMs = Number(database.prepare("PRAGMA busy_timeout").get()!.timeout); } catch { /* Keep the diagnostic content-free if SQLite is already unusable. */ }
  Object.assign(value, {
    stage: typeof value.stage === "string" ? value.stage : "storage_lock",
    safeDetails: { ...(value.safeDetails && typeof value.safeDetails === "object" ? value.safeDetails as Record<string, unknown>
      : { database_role: role, phase, busy_timeout_ms: busyTimeoutMs, retryable: true }),
    ...(waitedMs === undefined ? {} : { waited_ms: waitedMs }) },
  });
  return error;
}

function ensureJournalMode(database: DatabaseSync): void {
  const current = String((database.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toLowerCase();
  if (current !== "wal") database.exec("PRAGMA journal_mode=WAL;");
}

/** Current databases need only read checks; reserve a writer lock for real initialization or repair. */
function ensureCurrentSchema(database: DatabaseSync): void {
  if (!tableExists(database, "meta")) { applyMigrations(database); return; }
  const row = database.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value?: string } | undefined;
  const version = Number(row?.value ?? 0);
  const hasAppliedAt = version < 2 || (database.prepare("PRAGMA table_info(meta)").all() as Array<{ name: string }>).some(column => column.name === "applied_at");
  if (version !== SCHEMA_VERSION || !hasAppliedAt) applyMigrations(database);
}

export class CraftStore {
  readonly paths: CraftPaths;
  readonly contentStore: MarkdownContentStore;
  #database: DatabaseSync | null = null;
  #transactionDepth = 0;
  #memoryDatabases = new Map<string, DatabaseSync>();
  #memoryReadDatabases = new Map<string, DatabaseSync>();
  #pendingMemoryRows: PartitionRow[] = [];
  #pendingMemoryDeletes: PartitionRow[] = [];
  readonly traceShards: TraceShardStore;
  readonly codebaseShards: CodebaseShardStore;

  constructor(paths = craftPaths()) {
    this.paths = paths;
    this.traceShards = new TraceShardStore(paths.root);
    this.codebaseShards = new CodebaseShardStore(paths.root);
    this.contentStore = new MarkdownContentStore(paths);
    this.contentStore.setSessionMemoryDirectoryResolver((sessionId, writing) =>
      join(this.sessionStorageRoot(sessionId, writing), "memory", "md"));
    this.contentStore.setProjectKnowledgeDirectoryResolver((scope, options) => {
      const roots = this.projectRoots(scope.slice("project:".length));
      if (roots.length !== 1) return null;
      const legacy = this.legacyProjectContentDirectory(roots[0]!, "knowledge", options.reference_path, options.create === true);
      if (legacy) return legacy;
      return this.projectDomainDirectory(roots[0]!, "knowledge", options.create === true, ["md"]);
    });
    this.contentStore.setProjectExperienceDirectoryResolver((scope, options) => {
      const roots = this.projectRoots(scope.slice("project:".length));
      if (roots.length !== 1) return null;
      const legacy = this.legacyProjectContentDirectory(roots[0]!, "experience", options.reference_path, options.create === true);
      if (legacy) return legacy;
      return this.projectDomainDirectory(roots[0]!, "experience", options.create === true, ["md"]);
    });
    this.contentStore.setProjectMemoryDirectoryResolver((scope, options) => {
      const projectId = scope.slice("project:".length);
      if (!projectId) return null;
      const roots = this.projectRoots(projectId);
      const preferred = options.project_root && roots.includes(realpathSync(options.project_root)) ? realpathSync(options.project_root) : undefined;
      const root = preferred ?? (roots.length === 1 ? roots[0] : undefined);
      if (!root) return null;
      const legacy = this.legacyProjectContentDirectory(root, "memory", options.reference_path, options.create === true);
      return legacy ?? this.projectMemoryDirectory(root, ["md"], options.create === true);
    });
  }

  async open(options: { skipLegacyPartitionMigration?: boolean } = {}): Promise<this> {
    if (this.#database) return this;
    await ensureLayout(this.paths);
    const existed = existsSync(this.paths.databaseFile);
    const database = new DatabaseSync(this.paths.databaseFile);
    try {
      // Concurrent Hosts must wait before the journal-mode change takes a lock.
      database.exec(`PRAGMA busy_timeout=${sqliteBusyTimeoutMs()}; PRAGMA foreign_keys=ON;`);
      ensureJournalMode(database);
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
      ensureCurrentSchema(database);
    } catch (error) {
      database.close();
      throw error;
    }
    this.#database = database;
    try {
      if (!options.skipLegacyPartitionMigration) {
        this.migrateLegacyMemoryRecords();
        this.migrateLegacyExperienceRecords();
        this.rebuildDomainIndexes(database);
      }
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

  /** Preserve only records being moved out of the shared database. Copying
   * the full Craft database here made a handful of legacy rows block startup
   * behind multi-gigabyte Trace and telemetry files. */
  private backupLegacyPartitionRecords(domain: PartitionDomain, rows: Array<Record<string, unknown>>, fileOps: MigrationBackupFileOps = {
    write: writeFileSync, rename: renameSync, unlink: unlinkSync,
  }): void {
    const groups = new Map<string, { scope: MemoryScope; rows: Array<Record<string, unknown>> }>();
    for (const row of rows) {
      const kind = String(row.kind), id = String(row.id);
      const payload = JSON.parse(String(row.payload_json)) as JsonObject;
      const scope = this.memoryScope(kind, { ...payload, id }, domain !== "experience")!;
      const key = `${scope.kind}:${scope.id}`;
      const group = groups.get(key) ?? { scope, rows: [] };
      group.rows.push(row);
      groups.set(key, group);
    }
    for (const { scope, rows: scopedRows } of groups.values()) {
      const snapshots = new Map<string, ContentMigrationSnapshot>();
      if (domain === "memory") for (const row of scopedRows) {
        const payload = JSON.parse(String(row.payload_json)) as JsonObject;
        const ref = payload.content_ref as ContentRef | undefined;
        if (!ref) continue;
        if (ref.kind !== "memory" || ref.record_id !== row.id || ref.version !== Number(row.version)) throw new Error("Memory migration content identity drifted");
        const snapshot = this.legacyContentSnapshot(ref.path, dirname(ref.path), "Memory");
        const { manifest } = this.contentStore.readCompatSync(ref, `${scope.kind}:${scope.id}`);
        if (!this.memoryContentScopeMatches(manifest.scope, scope)) throw new Error("Memory migration content scope drifted");
        if (this.legacyContentSnapshot(ref.path, dirname(ref.path), "Memory").digest !== snapshot.digest) throw new Error("Memory migration content changed concurrently");
        snapshots.set(ref.path, snapshot);
      }
      const databaseFile = this.partitionDatabaseFile(domain, scope, true);
      this.writeLegacyPartitionBackup(domain, scope, dirname(databaseFile), scopedRows, fileOps, [...snapshots.values()]);
    }
  }

  private writeLegacyPartitionBackup(domain: PartitionDomain, scope: MemoryScope, capabilityRoot: string,
    rows: Array<Record<string, unknown>>, fileOps: MigrationBackupFileOps, snapshots: ContentMigrationSnapshot[] = []): void {
    this.ensureCapabilityDirectory(capabilityRoot, domain);
    const backupsDir = join(capabilityRoot, "backups");
    mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
    const backupStat = lstatSync(backupsDir);
    if (backupStat.isSymbolicLink() || !backupStat.isDirectory()) throw new Error(`${domain} backup path must be a regular directory`);
    const records = rows.map(row => ({ kind: String(row.kind), id: String(row.id), version: Number(row.version),
      payload_json: String(row.payload_json), created_at: String(row.created_at), updated_at: String(row.updated_at) }));
    const content = `${JSON.stringify({ schema: "craft.capability-partition-migration-backup.v1", domain, scope, records,
      ...(snapshots.length ? { content_snapshots: snapshots } : {}) })}\n`;
    const digest = createHash("sha256").update(content).digest("hex");
    const target = join(backupsDir, `legacy-partition-${digest}.json`);
    if (existsSync(target)) {
      const targetStat = lstatSync(target);
      if (targetStat.isSymbolicLink() || !targetStat.isFile()) throw new Error(`${domain} migration backup must be a regular file`);
      if (readFileSync(target, "utf8") !== content) throw new Error(`${domain} migration backup identity conflict`);
      return;
    }
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fileOps.write(temporary, content, { flag: "wx", mode: 0o600 });
      fileOps.rename(temporary, target);
    } catch (error) {
      try { fileOps.unlink(temporary); } catch (cleanupError) { if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError; }
      if (existsSync(target)) {
        const targetStat = lstatSync(target);
        if (targetStat.isSymbolicLink() || !targetStat.isFile()) throw new Error(`${domain} migration backup must be a regular file`);
        if (readFileSync(target, "utf8") === content) return;
      }
      throw error;
    }
  }

  /** Create a capability directory beneath the data root without following symlinks. */
  private ensureCapabilityDirectory(directory: string, domain: PartitionDomain): void {
    const root = resolve(this.paths.root), target = resolve(directory);
    if (target === root || !target.startsWith(`${root}${sep}`)) {
      throw new Error("Capability directory must remain within the Craft data root");
    }
    const rootStat = lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Craft data root must be a regular directory");
    let current = root;
    for (const part of target.slice(root.length + 1).split(sep)) {
      current = join(current, part);
      try {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${domain} backup root must be a regular directory`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        mkdirSync(current, { mode: 0o700 });
      }
    }
  }

  private rebuildDomainIndexes(database: DatabaseSync): void {
    const entries: Array<[string, ContentKind]> = [
      [this.paths.knowledgeDatabaseFile, "knowledge"],
      [this.paths.memoryDatabaseFile, "memory"],
      [this.paths.experienceDatabaseFile, "experience"],
    ];
    // `records` also contains large trace and archive payloads. Restrict the cursor to record
    // families that can own a Markdown reference, then route the small references in one pass.
    // Reopening each product previously repeated this indexed scan once per capability database.
    const placeholders = CONTENT_REFERENCE_RECORD_KINDS.map(() => "?").join(",");
    const rows = database.prepare(`SELECT kind,id,version,payload_json,updated_at FROM records WHERE kind IN (${placeholders})`);
    const references: Record<ContentKind, Array<{ kind: string; id: string; version: number; content_ref: string; updated_at: string }>> = {
      knowledge: [], memory: [], experience: [],
    };
    for (const row of rows.iterate(...CONTENT_REFERENCE_RECORD_KINDS) as Iterable<Record<string, unknown>>) {
      const payload = JSON.parse(String(row.payload_json)) as JsonObject;
      const ref = payload.content_ref;
      if (!ref || typeof ref !== "object" || Array.isArray(ref)) continue;
      const domain = (ref as Record<string, unknown>).kind;
      if (domain !== "knowledge" && domain !== "memory" && domain !== "experience") continue;
      references[domain].push({ kind: String(row.kind), id: String(row.id), version: Number(row.version),
        content_ref: JSON.stringify(ref), updated_at: String(row.updated_at) });
    }
    for (const [path, domain] of entries) {
      const index = new DatabaseSync(path);
      try {
        index.exec(`PRAGMA busy_timeout=${sqliteBusyTimeoutMs()};`);
        ensureJournalMode(index);
        const expected = references[domain].map((row) => [row.kind, row.id, row.version, row.content_ref, row.updated_at] as const)
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        const matches = (): boolean => {
          try {
            const current = index.prepare("SELECT kind,id,version,content_ref,updated_at FROM content_index")
              .all() as Array<{ kind: string; id: string; version: number; content_ref: string; updated_at: string }>;
            const actual = current.map((row) => [row.kind, row.id, Number(row.version), row.content_ref, row.updated_at] as const)
              .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
            return actual.length === expected.length && actual.every((row, offset) => JSON.stringify(row) === JSON.stringify(expected[offset]));
          } catch (error) {
            if (error instanceof Error && /no such table/iu.test(error.message)) return false;
            throw error;
          }
        };
        // Most starts are read-only: avoid taking a writer lock when the index
        // is already current. Recheck after BEGIN IMMEDIATE so simultaneous
        // Hosts do not repeat the same rebuild once the first one commits.
        if (matches()) continue;
        index.exec("BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS content_index (kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, content_ref TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(kind,id,version));");
        if (matches()) { index.exec("COMMIT"); continue; }
        index.exec("DELETE FROM content_index;");
        const insert = index.prepare("INSERT INTO content_index(kind,id,version,content_ref,updated_at) VALUES(?,?,?,?,?)");
        for (const ref of references[domain]) insert.run(ref.kind, ref.id, ref.version, ref.content_ref, ref.updated_at);
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
    const deletionStart = this.#pendingMemoryDeletes.length;
    const savepoint = `craft_atomic_${this.#transactionDepth}`;
    const beginStartedAt = performance.now();
    try { if (nested) database.exec(`SAVEPOINT ${savepoint}`); else this.beginImmediate(database, "primary"); }
    catch (error) { throw storageFailure(error, database, "primary", nested ? "savepoint_begin" : "transaction_begin",
      nested ? undefined : Math.max(0, Math.round(performance.now() - beginStartedAt))); }
    this.#transactionDepth += 1;
    let result: T;
    try {
      result = operation(database);
      database.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
    } catch (error) {
      this.#transactionDepth -= 1;
      database.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
      this.#pendingMemoryDeletes.splice(deletionStart);
      this.cleanupMemoryRows(this.#pendingMemoryRows.splice(pendingStart));
      throw storageFailure(error, database, "primary", nested ? "savepoint_operation" : "transaction_operation");
    }
    this.#transactionDepth -= 1;
    if (!nested) {
      this.#pendingMemoryRows.splice(pendingStart);
      // Central publication has committed. Retire only versions that are still
      // unreferenced; rollback never destroys a previously visible body.
      const retired = this.#pendingMemoryDeletes.splice(0);
      try { this.cleanupMemoryRows(retired); }
      catch (error) {
        this.#pendingMemoryDeletes.unshift(...retired);
        throw Object.assign(new Error("Transaction committed; partition retirement remains pending", { cause: error }), {
          code: "CRAFT_PARTITION_RETIREMENT_PENDING", committed: true, pending_retirements: retired.length,
        });
      }
    }
    return result;
  }

  /** Run a bounded read on one SQLite snapshot without reserving the writer. */
  readSnapshot<T>(operation: (database: DatabaseSync) => T): T {
    const database = this.database;
    if (this.#transactionDepth > 0) return operation(database);
    database.exec("BEGIN DEFERRED");
    try {
      const result = operation(database);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  /** Keep all writes for one Trace on its own WAL writer, while old Traces stay on the legacy database. */
  traceTransaction<T>(traceId: string, operation: () => T): T {
    return this.legacyTrace(traceId) ? this.transaction(() => operation()) : this.traceShards.transaction(traceId, operation);
  }

  private legacyTrace(traceId: string): boolean {
    return this.database.prepare("SELECT 1 FROM records WHERE kind='trace' AND id=? LIMIT 1").get(traceId) !== undefined;
  }

  private traceWriteIsLegacy(kind: string, id: string, payload: JsonObject): boolean {
    if (this.database.prepare("SELECT 1 FROM records WHERE kind=? AND id=? LIMIT 1").get(kind, id)) return true;
    const traceId = kind === "trace" || kind === "trace_archive" ? id : payload.trace_id;
    return typeof traceId === "string" && this.legacyTrace(traceId);
  }

  private cleanupMemoryRows(rows: PartitionRow[]): void {
    if (!rows.length) return;
    const clean = () => {
      for (const row of rows) {
        const pointer = this.partitionPointer(row.kind, row.logicalId ?? row.id, row.version);
        if (pointer?.file === row.file && (pointer.recordId ?? row.logicalId ?? row.id) === row.id) continue;
        const database = this.#memoryDatabases.get(row.file)!;
        this.transactionOn(database, () => {
          database.prepare("DELETE FROM records WHERE kind=? AND id=? AND version=?").run(row.kind, row.id, row.version);
          database.prepare("DELETE FROM content_index WHERE kind=? AND id=? AND version=?").run(row.kind, row.id, row.version);
        });
      }
    };
    // Hold the publication lock while checking references and retiring rows.
    // This is maintenance after writes; normal partition reads remain read-only.
    if (this.#transactionDepth > 0) { clean(); return; }
    this.database.exec("BEGIN IMMEDIATE");
    this.#transactionDepth += 1;
    try { clean(); this.database.exec("COMMIT"); }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
    finally { this.#transactionDepth -= 1; }
  }

  legacyDatabaseDetected(): boolean {
    return existsSync(this.paths.legacyDatabaseFile);
  }

  bindSessionStorageHost(sessionId: string, host: string): string {
    const scopeId = sessionStorageScopeId(host, sessionId);
    const id = `session_storage_${createHash("sha256").update(scopeId).digest("hex")}`;
    const current = this.find("session_storage_identity", id);
    if (current) {
      if (current.session_id !== null && current.session_id !== sessionId || current.host !== host || current.scope_id !== scopeId)
        throw new Error("Session storage Host identity conflicts with an existing session");
      if (current.session_id === null) this.save("session_storage_identity", id, { ...current, session_id: sessionId });
      return sessionStorageDirectoryForScopeId(this.paths, scopeId);
    }
    try { this.create("session_storage_identity", id, { host, session_id: sessionId, session_digest: createHash("sha256").update(sessionId).digest("hex"), scope_id: scopeId, content_free: true }); }
    catch (error) {
      const raced = this.find("session_storage_identity", id);
      if (raced?.host !== host || raced.session_id !== sessionId || raced.scope_id !== scopeId) throw error;
    }
    return sessionStorageDirectoryForScopeId(this.paths, scopeId);
  }

  resolveSessionStorageScopeId(sessionId: string, requestedHost?: string): string {
    if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("session_id must be a non-empty identifier under 65536 UTF-8 bytes");
    const parsed = parseSessionStorageScopeId(sessionId);
    if (parsed) {
      if (requestedHost && parsed.host !== requestedHost) throw new Error("Session storage scope Host does not match the requested Host");
      return sessionId;
    }
    if (requestedHost) return sessionStorageScopeId(requestedHost, sessionId);
    const digest = createHash("sha256").update(sessionId).digest("hex");
    const bindings = this.list("session_storage_identity", 10_000, item => item.session_digest === digest && item.session_id === sessionId, false);
    const scopeIds = [...new Set(bindings.map(item => String(item.scope_id ?? "")).filter(Boolean))];
    if (scopeIds.length > 1) throw new Error("Session storage Host is ambiguous; specify the Host identity");
    if (scopeIds.length === 1) return parseSessionStorageScopeId(scopeIds[0]!)?.host === "craft-mcp" ? sessionId : scopeIds[0]!;
    const legacy = this.find("session_storage_identity", `session_storage_${digest}`);
    if (legacy?.session_id === sessionId && legacy.host !== "craft-mcp") return sessionStorageScopeId(String(legacy.observed_host ?? legacy.host), sessionId);
    return sessionId;
  }

  sessionStorageRoot(sessionId: string, create = false, requestedHost?: string): string {
    const parsed = parseSessionStorageScopeId(sessionId);
    if (parsed) {
      const identityId = `session_storage_${createHash("sha256").update(sessionId).digest("hex")}`;
      const binding = this.find("session_storage_identity", identityId);
      if (binding && (binding.scope_id !== sessionId || binding.host !== parsed.host || binding.session_digest !== parsed.digest))
        throw new Error("Session storage Host identity conflicts with its scope ID");
      if (create && !binding) this.create("session_storage_identity", identityId,
        { host: parsed.host, session_id: null, session_digest: parsed.digest, scope_id: sessionId, content_free: true });
      return create ? ensureSessionStorageDirectoryForScopeId(this.paths, sessionId) : sessionStorageDirectoryForScopeId(this.paths, sessionId);
    }
    if (requestedHost) {
      if (create) this.bindSessionStorageHost(sessionId, requestedHost);
      const scopeId = sessionStorageScopeId(requestedHost, sessionId);
      return create ? ensureSessionStorageDirectoryForScopeId(this.paths, scopeId) : sessionStorageDirectoryForScopeId(this.paths, scopeId);
    }
    sessionStorageDirectory(this.paths, "craft-mcp", sessionId);
    const digest = createHash("sha256").update(sessionId).digest("hex");
    const bindings = this.list("session_storage_identity", 10_000, item => item.session_digest === digest && item.session_id === sessionId, false);
    const hosts = [...new Set(bindings.map(item => String(item.host)))];
    if (hosts.length > 1) throw new Error("Session storage Host is ambiguous; specify the Host identity");
    const legacyId = `session_storage_${digest}`;
    const legacyBinding = this.find("session_storage_identity", legacyId);
    const host = hosts[0] ?? (legacyBinding?.session_id === sessionId ? String(legacyBinding.observed_host ?? legacyBinding.host) : "craft-mcp");
    if (create && !hosts.length && !legacyBinding) this.bindSessionStorageHost(sessionId, host);
    return create ? ensureSessionStorageDirectory(this.paths, host, sessionId) : sessionStorageDirectory(this.paths, host, sessionId);
  }

  save(kind: string, id: string, payload: JsonObject, version?: number): JsonObject {
    this.assertPartitionDomain(kind, id, payload);
    const existingPointer = this.partitionPointer(kind, id);
    if (this.memoryScope(kind, { ...payload, id }, true, Boolean(existingPointer))) {
      if (kind === "evolution_cycle" && existingPointer?.domain === "evolution") return this.saveEvolutionPartition(id, payload, version);
      return this.writeMemory(kind, id, payload, "save", undefined, version);
    }
    if (TRACE_SHARDED_KINDS.has(kind) && !this.traceWriteIsLegacy(kind, id, payload)) return this.traceShards.save(kind, id, payload, version);
    if (CODEBASE_GRAPH_KINDS.has(kind) && this.codebaseShards.raw(kind, id)
      && !this.database.prepare("SELECT 1 FROM records WHERE kind=? AND id=? LIMIT 1").get(kind, id))
      return this.codebaseShards.save(kind, id, payload, version);
    return this.transaction((database) => {
      this.assertPartitionDomain(kind, id, payload);
      return this.insert(database, { kind, id, payload, version });
    });
  }

  create(kind: string, id: string, payload: JsonObject): JsonObject {
    if (this.memoryScope(kind, { ...payload, id })) return this.writeMemory(kind, id, payload, "create");
    if (TRACE_SHARDED_KINDS.has(kind) && !this.traceWriteIsLegacy(kind, id, payload)) return this.traceShards.create(kind, id, payload);
    if (CODEBASE_GRAPH_KINDS.has(kind) && this.codebaseShards.raw(kind, id)) throw new Error(`${kind} already exists: ${id}`);
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
    const traceId = this.traceBatchId(entries);
    if (traceId) return this.traceTransaction(traceId, () => entries.map(entry => this.create(entry.kind, entry.id, entry.payload)));
    if (entries.some(entry => this.partitionDomain(entry.kind, entry.payload))) {
      return this.transaction(() => entries.map(entry => this.create(entry.kind, entry.id, entry.payload)));
    }
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
    const traceId = this.traceBatchId(entries);
    if (traceId) return this.traceTransaction(traceId, () => entries.map(entry => this.save(entry.kind, entry.id, entry.payload, entry.version)));
    return this.transaction(() => entries.map(entry => this.save(entry.kind, entry.id, entry.payload, entry.version)));
  }

  private traceBatchId(entries: readonly SaveEntry[]): string | null {
    if (!entries.some(entry => TRACE_SHARDED_KINDS.has(entry.kind))) return null;
    const ids = entries.map(entry => TRACE_SHARDED_KINDS.has(entry.kind)
      ? entry.kind === "trace" || entry.kind === "trace_archive" ? entry.id : entry.payload.trace_id
      : null);
    if (ids.some(id => typeof id !== "string" || !id) || new Set(ids).size !== 1)
      throw new Error("Trace batch must contain one Trace and no unrelated records");
    return ids[0] as string;
  }

  updateIfVersion(kind: string, id: string, expectedVersion: number, payload: JsonObject): JsonObject {
    this.assertPartitionDomain(kind, id, payload);
    if (this.memoryScope(kind, { ...payload, id })) return this.writeMemory(kind, id, payload, "save", expectedVersion);
    if (TRACE_SHARDED_KINDS.has(kind) && !this.traceWriteIsLegacy(kind, id, payload)) {
      const traceId = kind === "trace" || kind === "trace_archive" ? id : String(payload.trace_id ?? "");
      return this.traceShards.transaction(traceId, () => {
        const current = this.traceShards.find(kind, id, undefined, traceId);
        if (Number(current?.version ?? 0) !== expectedVersion) throw new Error(`Concurrent update detected for ${kind}: ${id}`);
        return this.traceShards.save(kind, id, payload, expectedVersion + 1);
      });
    }
    if (CODEBASE_GRAPH_KINDS.has(kind) && !this.database.prepare("SELECT 1 FROM records WHERE kind=? AND id=? LIMIT 1").get(kind, id)) {
      const current = this.codebaseShards.raw(kind, id);
      if (current) {
        if (current.version !== expectedVersion) throw new Error(`Concurrent update detected for ${kind}: ${id}`);
        return this.codebaseShards.save(kind, id, payload, expectedVersion + 1);
      }
    }
    return this.transaction((database) => {
      this.assertPartitionDomain(kind, id, payload);
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

  /** Advance a project Evolution Cycle and append its event in one project-local transaction. */
  advanceEvolutionCycle(id: string, expectedVersion: number, payload: JsonObject, eventType: string, eventPayload: JsonObject): JsonObject {
    const pointer = this.partitionPointer("evolution_cycle", id);
    if (pointer?.domain !== "evolution") throw new Error("Evolution Cycle project partition is unavailable");
    const { database } = this.memoryDatabase(pointer.scope, "evolution");
    const stream = `evolution:${id}`;
    return this.transactionOn(database, () => {
      const priorRow = database.prepare("SELECT * FROM records WHERE kind='evolution_cycle' AND id=? ORDER BY version DESC LIMIT 1")
        .get(id) as Record<string, unknown> | undefined;
      if (!priorRow) throw new Error("Evolution Cycle partition record is unavailable");
      const current = this.record(priorRow, false);
      const transitionId = String(eventPayload.transition_id ?? "");
      if (!transitionId) throw new Error("Evolution Cycle event requires a transition ID");
      const priorEvent = database.prepare("SELECT * FROM events WHERE stream=? AND json_extract(payload_json,'$.transition_id')=? ORDER BY sequence DESC LIMIT 1")
        .get(stream, transitionId) as Record<string, unknown> | undefined;
      if (priorEvent) {
        const priorPayload = JSON.parse(String(priorEvent.payload_json)) as JsonObject;
        if (priorPayload.request_digest !== eventPayload.request_digest) throw new Error("Evolution Cycle transition idempotency conflict");
        return { cycle: current, event: priorPayload, idempotent: true };
      }
      if (Number(current.version) !== expectedVersion) throw new Error("Evolution Cycle version conflict; reread before advancing");
      const sequence = Number((database.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM events WHERE stream=?")
        .get(stream) as { sequence: number }).sequence);
      if (eventPayload.cycle_id !== id || Number(eventPayload.sequence) !== sequence) throw new Error("Evolution Cycle event sequence is stale");
      const saved = this.insert(database, { kind: "evolution_cycle", id, payload, version: expectedVersion + 1 });
      const created_at = new Date().toISOString();
      database.prepare("INSERT INTO events(stream,sequence,event_type,payload_json,created_at) VALUES(?,?,?,?,?)")
        .run(stream, sequence, eventType, JSON.stringify(eventPayload), created_at);
      return { cycle: saved, event: eventPayload, idempotent: false };
    });
  }

  private saveEvolutionPartition(id: string, payload: JsonObject, version?: number): JsonObject {
    const pointer = this.partitionPointer("evolution_cycle", id);
    if (pointer?.domain !== "evolution") throw new Error("Evolution Cycle project partition is unavailable");
    const { database } = this.memoryDatabase(pointer.scope, "evolution");
    // partitionPointer already proves the central pointer exists; find() fails closed if the partition row is missing.
    const current = this.find("evolution_cycle", id, undefined, false)!;
    const expectedVersion = Number.isSafeInteger(payload.version) ? Number(payload.version) : Number(current.version);
    return this.transactionOn(database, () => {
      const latest = Number((database.prepare("SELECT COALESCE(MAX(version),0) AS version FROM records WHERE kind='evolution_cycle' AND id=?")
        .get(id) as { version: number }).version);
      if (latest !== expectedVersion) throw new Error(`Concurrent update detected for evolution_cycle: ${id}`);
      const nextVersion = version ?? latest + 1;
      if (nextVersion !== latest + 1) throw new Error("Evolution Cycle versions must be appended in order");
      return this.insert(database, { kind: "evolution_cycle", id, payload, version: nextVersion });
    });
  }

  private partitionDomain(kind: string, payload: JsonObject): PartitionDomain | null {
    if (EVOLUTION_PARTITIONED_KINDS.has(kind)) return "evolution";
    if (MEMORY_PARTITIONED_KINDS.has(kind)) return "memory";
    if (EXPERIENCE_PARTITIONED_KINDS.has(kind)) return "experience";
    if ((kind.startsWith("knowledge_") && !kind.startsWith("knowledge_memory_")) || kind.startsWith("wiki_")) return "knowledge";
    if (kind !== "evidence") return null;
    const metadata = payload.metadata && typeof payload.metadata === "object" ? payload.metadata as JsonObject : {};
    if (["knowledge", "memory", "experience"].includes(String(metadata.capability_owner))) return metadata.capability_owner as PartitionDomain;
    // These Evidence types have an explicit Knowledge ownership contract.
    if (payload.source_type === "knowledge_fragment" || metadata.provenance === "codex_session_program_verification"
      || payload.source_type === "host_model_review" && typeof metadata.review_id === "string" && metadata.review_id.startsWith("knowledge_host_review_")) return "knowledge";
    return null;
  }

  private assertPartitionDomain(kind: string, id: string, payload: JsonObject): void {
    const pointer = this.partitionPointer(kind, id);
    if (pointer && pointer.domain !== this.partitionDomain(kind, payload)) throw new Error("Record cannot change capability storage owner");
  }

  private knowledgeScope(kind: string, payload: JsonObject, allowMissingParents = false): MemoryScope | undefined {
    const metadata = payload.metadata && typeof payload.metadata === "object" ? payload.metadata as JsonObject : {};
    let declared: unknown = payload.scope ?? metadata.scope;
    if (declared === undefined && typeof payload.project_scope_id === "string") declared = payload.project_scope_id;
    if (declared === undefined && typeof metadata.project_scope_id === "string") declared = metadata.project_scope_id;
    const contentRef = payload.content_ref as JsonObject | undefined;
    if (declared === undefined && contentRef?.kind === "knowledge" && typeof contentRef.scope === "string") declared = contentRef.scope;
    if (declared === undefined && typeof payload.project_id === "string") declared = { kind: "project", id: payload.project_id };
    const refs: Array<[string, string]> = [];
    const ref = (parentKind: string, id: unknown) => { if (typeof id === "string" && id) refs.push([parentKind, id]); };
    if (kind !== "knowledge_claim") ref("knowledge_claim", payload.claim_id);
    if (kind !== "knowledge_source") ref("knowledge_source", payload.source_id ?? metadata.source_id);
    if (kind !== "knowledge_document") ref("knowledge_document", payload.document_id);
    if (kind.startsWith("wiki_candidate_")) ref("wiki_skill_candidate", payload.candidate_id);
    for (const id of Array.isArray(payload.case_ids) ? payload.case_ids : []) ref("knowledge_evaluation_case", id);
    for (const id of Array.isArray(payload.expected_claim_ids) ? payload.expected_claim_ids : []) ref("knowledge_claim", id);
    for (const item of Array.isArray(payload.candidate_claim_refs) ? payload.candidate_claim_refs as JsonObject[] : []) ref("knowledge_claim", item.claim_id ?? item.id);
    for (const id of Array.isArray(payload.claim_ids) ? payload.claim_ids : []) ref("knowledge_claim", id);
    for (const item of Array.isArray(payload.claim_refs) ? payload.claim_refs as JsonObject[] : []) ref("knowledge_claim", item.claim_id ?? item.id);
    ref("knowledge_claim", payload.from_claim_id);
    ref("knowledge_claim", payload.to_claim_id);
    for (const id of Array.isArray(payload.evidence_ids) ? payload.evidence_ids : []) ref("evidence", id);
    for (const id of Array.isArray(payload.source_evidence_ids) ? payload.source_evidence_ids : []) ref("evidence", id);
    ref("evidence", payload.evidence_id);
    for (const endpoint of [payload.source, payload.target]) {
      if (endpoint && typeof endpoint === "object" && !Array.isArray(endpoint)) {
        const item = endpoint as JsonObject;
        if (typeof item.kind === "string" && (item.kind.startsWith("knowledge_") || item.kind === "evidence")) ref(item.kind, item.id);
      }
    }
    const scopes = refs.map(([parentKind, id]) => {
      const parent = this.find(parentKind, id, undefined, false);
      // This fixed built-in descriptor is a per-install catalogue for the
      // central Knowledge root. Its `user:local` applicability is not custody
      // for derived project/global facts.
      if (parentKind === "knowledge_source" && id === "builtin.evidence-wiki") return [{ kind: "global" as const, id: "global" }];
      if (parentKind === "knowledge_source" && id === "builtin.serena-project-knowledge"
        && parent?.kind === "serena" && parent.locator === ".serena/memories") {
        const templateScope = this.memoryScope(parentKind, parent, false);
        return [templateScope!];
      }
      if (!parent) {
        if (allowMissingParents) return [];
        throw new Error(`Knowledge storage parent is unavailable: ${parentKind}/${id}`);
      }
      const pointer = this.partitionPointer(parentKind, id);
      const scope = pointer?.domain === "knowledge" ? pointer.scope : this.memoryScope(parentKind, parent, false);
      return scope ? [scope] : [];
    }).flat();
    let declaredScope: MemoryScope | undefined;
    if (declared !== undefined && declared !== null) {
      if (typeof declared === "string") {
        if (declared === "global") declaredScope = { kind: "global", id: "global" };
        else {
          const separator = declared.indexOf(":");
          if (separator > 0) declaredScope = { kind: declared.slice(0, separator) as MemoryScope["kind"], id: declared.slice(separator + 1) };
          else if (["user", "task", "workspace"].includes(declared)) {
            const id = payload[`${declared}_id`];
            declaredScope = { kind: declared as MemoryScope["kind"], id: typeof id === "string" && id.trim() ? id : "legacy" };
          } else throw new Error("Memory storage scope is malformed");
        }
      } else if (typeof declared === "object" && !Array.isArray(declared)) {
        const candidate = declared as Record<string, unknown>;
        if (typeof candidate.kind !== "string" || typeof candidate.id !== "string" || !candidate.id.trim()) throw new Error("Memory storage scope is malformed");
        declaredScope = { kind: candidate.kind as MemoryScope["kind"], id: candidate.id };
      } else throw new Error("Memory storage scope is malformed");
      if (!(["global", "user", "project", "workspace", "task", "session", "team", "organization", "legacy"] as string[]).includes(declaredScope.kind)) {
        throw new Error("Memory storage scope is malformed");
      }
      if (declaredScope.kind === "project" && declaredScope.id.startsWith("project:")) declaredScope = { ...declaredScope, id: declaredScope.id.slice("project:".length) };
    }
    // Historical Knowledge pointers may retain the canonical `project:` prefix
    // inside the project id; declared string scopes store the same id without it.
    const specific = scopes.filter(scope => scope.kind !== "global" && scope.kind !== "user")
      .map(scope => scope.kind === "project" && scope.id.startsWith("project:") ? { ...scope, id: scope.id.slice("project:".length) } : scope);
    const unique = new Map(specific.map(scope => [JSON.stringify(scope), scope]));
    if (unique.size > 1) throw new Error("Knowledge record cannot combine different storage scopes");
    if (unique.size === 1 && scopes.some(scope => scope.kind === "user")) {
      throw new Error("Knowledge record cannot combine different storage scopes");
    }
    if (unique.size === 1) {
      const inherited = [...unique.values()][0]!;
      if (declaredScope && JSON.stringify(declaredScope) !== JSON.stringify(inherited)
        && inherited.kind !== "global" && inherited.kind !== "user") throw new Error("Knowledge record cannot combine different storage scopes");
      return declaredScope ?? inherited;
    }
    // Global and user-local sources/evidence may support a narrower derived
    // record, but they do not establish that record's scope when it is omitted.
    const neutral = new Map(scopes.map(scope => [JSON.stringify(scope), scope]));
    if (neutral.size === 1) {
      const inherited = [...neutral.values()][0]!;
      if (declaredScope && inherited.kind === "user" && declaredScope.kind === "user"
        && JSON.stringify(declaredScope) !== JSON.stringify(inherited)) throw new Error("Knowledge record cannot combine different storage scopes");
      if (declaredScope) return declaredScope;
      const mayInheritNeutralParent = refs.some(([parentKind]) => ["knowledge_claim", "knowledge_evaluation_case", "wiki_skill_candidate"].includes(parentKind))
        || kind !== "knowledge_claim" && refs.some(([parentKind]) => parentKind === "knowledge_source");
      return mayInheritNeutralParent ? inherited : undefined;
    }
    if (neutral.size > 1) throw new Error("Knowledge record cannot combine different storage scopes");
    return declaredScope;
  }

  private memoryScope(kind: string, payload: JsonObject, storage = true, allowMissingKnowledgeParents = false): MemoryScope | null {
    const domain = this.partitionDomain(kind, payload);
    if (!domain) return null;
    let value = payload.scope;
    // The built-in Serena descriptor is a configuration template, not data for
    // an actual project named selected-project. Its descendants still resolve
    // the declared project scope and cannot be ingested without a real binding.
    if (storage && kind === "knowledge_source" && payload.id === "builtin.serena-project-knowledge"
      && payload.kind === "serena" && payload.locator === ".serena/memories"
      && value && typeof value === "object" && (value as JsonObject).kind === "project" && (value as JsonObject).id === "selected-project") {
      return { kind: "global", id: "global" };
    }
    if (kind === "evidence" && value === undefined && payload.metadata && typeof payload.metadata === "object") {
      const metadata = payload.metadata as JsonObject;
      value = metadata.scope ?? metadata.project_scope_id;
    }
    if (domain === "knowledge") {
      value = this.knowledgeScope(kind, payload, allowMissingKnowledgeParents);
      if (value === undefined || value === null) throw new Error("Knowledge storage scope is unavailable");
    }
    if (domain === "experience" && (value === undefined || value === null) && payload.source && typeof payload.source === "object") {
      value = (payload.source as JsonObject).scope;
    }
    if (domain === "experience" && (value === undefined || value === null) && typeof payload.project_id === "string") {
      value = { kind: "project", id: payload.project_id };
    }
    if (domain === "experience" && (value === undefined || value === null) && kind === "workflow_evolution_request") {
      const refs = Array.isArray(payload.observation_refs) ? payload.observation_refs as JsonObject[] : [];
      const scopes = refs.flatMap((ref) => {
        const source = ref.source && typeof ref.source === "object" ? ref.source as JsonObject : {};
        const sourceScope = source.scope;
        if (typeof sourceScope === "string") {
          if (sourceScope === "global") return [{ kind: "global", id: "global" }];
          const separator = sourceScope.indexOf(":");
          if (separator > 0) return [{ kind: sourceScope.slice(0, separator), id: sourceScope.slice(separator + 1) }];
          throw new Error("Experience observation scope is malformed");
        }
        if (sourceScope && typeof sourceScope === "object") {
          if (Array.isArray(sourceScope)) throw new Error("Experience observation scope is malformed");
          const candidate = sourceScope as Record<string, unknown>;
          if (typeof candidate.kind !== "string" || typeof candidate.id !== "string" || !candidate.id.trim()) {
            throw new Error("Experience observation scope is malformed");
          }
          return [{ kind: candidate.kind, id: candidate.id }];
        }
        return [];
      });
      const uniqueScopes = new Map(scopes.map((candidate) => [JSON.stringify(candidate), candidate]));
      if (uniqueScopes.size > 1) throw new Error("Experience request cannot combine observations from different scopes");
      if (uniqueScopes.size === 1) value = [...uniqueScopes.values()][0];
    }
    if (domain === "experience") {
      const parent = kind === "experience_asset_migration_failure" || kind === "experience_procedure_gate" || kind === "experience_release" || kind === "experience_skill_export"
        || kind === "experience_evaluation_dispatch" ? ["experience_procedure", String(payload.procedure_id ?? payload.id)]
        : kind === "experience_shadow_evaluation" ? ["experience_shadow_experiment", String(payload.experiment_id ?? "")]
        : kind === "workflow_evolution_proposal" ? ["workflow_evolution_request", String(payload.request_id ?? "")]
        : null;
      if (parent) {
        const parentRecord = parent[1] ? this.find(parent[0]!, parent[1], undefined, false) : null;
        if (!parentRecord) {
          if (storage && (value === undefined || value === null)) throw new Error("Experience storage parent is unavailable");
        } else {
          const parentScope = this.partitionPointer(parent[0]!, parent[1]!)?.scope
            ?? this.memoryScope(parent[0]!, parentRecord, false)!;
          if (value === undefined || value === null) value = parentScope;
          else if (storage && JSON.stringify(this.memoryScope("experience_observation", { scope: value }, false)) !== JSON.stringify(parentScope)) {
            throw new Error("Experience child storage scope differs from parent");
          }
        }
      }
    }
    if (domain === "memory" && kind === "memory_confirmation" && (!value || typeof value !== "object")) {
      const memoryId = typeof payload.memory_id === "string" ? payload.memory_id : "";
      value = memoryId ? this.find("memory_ledger", memoryId, undefined, false)?.scope : undefined;
    }
    if (domain === "memory" && kind === "memory_observation" && (!value || typeof value !== "object") && typeof payload.project_id === "string") {
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
    if ((!(["global", "user", "project", "workspace", "task", "session", "team", "organization"].includes(String(scope.kind)))
      && !(domain === "knowledge" && scope.kind === "legacy")) || typeof scope.id !== "string" || !scope.id.trim()) {
      throw new Error("Memory storage scope is malformed");
    }
    if (domain === "evolution" && scope.kind !== "project") throw new Error("Evolution Cycle storage requires project scope");
    return { kind: scope.kind as MemoryScope["kind"], id: scope.id };
  }

  private memoryDatabaseFile(scope: MemoryScope, create = true): string {
    if (scope.kind === "global" || scope.kind === "user") return this.paths.memoryDatabaseFile;
    if (scope.kind === "session") return join(this.sessionStorageRoot(scope.id, create), "memory", "memory.db");
    if (scope.kind === "task") {
      const id = scope.id;
      if (id.trim() !== id || Buffer.byteLength(id, "utf8") > 255 || id === "." || id === ".." || /[/\\\x00-\x1f\x7f]/u.test(id)) {
        throw new Error("task_id must be one bounded, safe directory name");
      }
      return join(this.paths.runtimeDir, "memory-tasks", id, "memory.db");
    }
    if (scope.kind !== "project") {
      const digest = createHash("sha256").update(scope.id).digest("hex").slice(0, 24);
      return join(this.paths.memoryDir, "scopes", `${scope.kind}-${digest}`, "memory.db");
    }
    const roots = this.projectRoots(scope.id);
    if (roots.length !== 1) throw new Error(roots.length ? "Project Memory storage root is ambiguous" : "Project Memory storage root is not registered");
    const directory = this.projectMemoryDirectory(roots[0]!, [], create);
    return join(directory ?? join(projectStorageDirectory(this.paths, roots[0]!), "memory"), "memory.db");
  }

  private experienceDatabaseFile(scope: MemoryScope, create = true): string {
    if (scope.kind === "global" || scope.kind === "user") return this.paths.experienceDatabaseFile;
    if (scope.kind !== "project") {
      const digest = createHash("sha256").update(`${scope.kind}:${scope.id}`).digest("hex").slice(0, 24);
      return join(this.paths.experienceDir, "scopes", `${scope.kind}-${digest}`, "experience.db");
    }
    const roots = this.projectRoots(scope.id);
    if (roots.length !== 1) throw new Error(roots.length ? "Project Experience storage root is ambiguous" : "Project Experience storage root is not registered");
    const directory = this.projectDomainDirectory(roots[0]!, "experience", create);
    return join(directory ?? join(projectStorageDirectory(this.paths, roots[0]!), "experience"), "experience.db");
  }

  private partitionDatabaseFile(domain: PartitionDomain, scope: MemoryScope, create = true): string {
    if (domain === "memory") return this.memoryDatabaseFile(scope, create);
    if (domain === "experience") return this.experienceDatabaseFile(scope, create);
    if (domain === "evolution") {
      if (scope.kind !== "project") throw new Error("Evolution Cycle storage requires project scope");
      const roots = this.projectRoots(scope.id);
      if (roots.length !== 1) throw new Error(roots.length ? "Project Evolution storage root is ambiguous" : "Project Evolution storage root is not registered");
      const directory = this.projectDomainDirectory(roots[0]!, "evolution", create);
      return join(directory ?? join(projectStorageDirectory(this.paths, roots[0]!), "evolution"), "evolution.db");
    }
    if (scope.kind === "global" || scope.kind === "user") return this.paths.knowledgeDatabaseFile;
    if (scope.kind !== "project") {
      const digest = createHash("sha256").update(`${scope.kind}:${scope.id}`).digest("hex").slice(0, 24);
      return join(this.paths.knowledgeDir, "scopes", `${scope.kind}-${digest}`, "knowledge.db");
    }
    const roots = this.projectRoots(scope.id);
    if (roots.length !== 1) throw new Error(roots.length ? "Project Knowledge storage root is ambiguous" : "Project Knowledge storage root is not registered");
    const directory = this.projectDomainDirectory(roots[0]!, "knowledge", create);
    return join(directory ?? join(projectStorageDirectory(this.paths, roots[0]!), "knowledge"), "knowledge.db");
  }

  private projectMemoryDirectory(root: string, children: string[], create: boolean): string | null {
    return this.projectDomainDirectory(root, "memory", create, children);
  }

  /** An old project Markdown reference may be read only from its exact former domain tree. */
  private legacyProjectContentDirectory(root: string, domain: PartitionDomain, referencePath?: string, writing = false): string | null {
    if (!referencePath || writing) return null;
    const directory = join(root, ".craft_data", domain, "md");
    const file = resolve(referencePath);
    const expected = canonicalCandidatePath(directory);
    const actual = canonicalCandidatePath(file);
    if (domain === "experience" ? !actual.startsWith(`${expected}${sep}`) : dirname(actual) !== expected) return null;
    let referenceDirectory = dirname(file);
    while (canonicalCandidatePath(referenceDirectory) !== expected && dirname(referenceDirectory) !== referenceDirectory) {
      referenceDirectory = dirname(referenceDirectory);
    }
    // The earlier containment check ensures the ancestor walk reaches this
    // canonical directory before filesystem root; no second miss branch is
    // reachable after the loop exits.
    const subdirectories: string[] = [];
    for (let current = dirname(file); current !== referenceDirectory; current = dirname(current)) {
      subdirectories.unshift(current);
    }
    for (const path of [dirname(dirname(referenceDirectory)), dirname(referenceDirectory), referenceDirectory, ...subdirectories, file]) {
      let stat;
      try { stat = lstatSync(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      if (stat.isSymbolicLink() || (path === file ? !stat.isFile() : !stat.isDirectory())) {
        throw new Error("Legacy project content path must use regular files and directories");
      }
    }
    return referenceDirectory;
  }

  private projectDomainDirectory(root: string, domain: PartitionDomain, create: boolean, children: string[] = []): string | null {
    let directory = create ? ensureProjectStorageDirectory(this.paths, root) : existingProjectStorageDirectory(this.paths, root);
    if (!directory) return null;
    for (const part of [domain, ...children]) {
      directory = join(directory, part);
      try {
        const stat = lstatSync(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Project capability data path must use regular directories");
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
    const roots = rows.flatMap(row => {
      try {
        const payload = JSON.parse(row.payload_json) as JsonObject;
        const rowScope = payload.scope as JsonObject | undefined;
        if (payload.status !== "active" || payload.alias_kind !== "path" || rowScope?.kind !== "project" || !acceptedProjectIds.has(String(rowScope.id))
          || typeof payload.alias !== "string" || payload.alias_digest !== undefined && payload.alias_digest !== scopeAliasDigest(payload.alias)) return [];
        const path = realpathSync(payload.alias);
        return statSync(path).isDirectory() ? [path] : [];
      } catch { return []; }
    });
    const identityIds = [...acceptedProjectIds];
    // `acceptedProjectIds` always contains projectId and its canonical alias.
    const identities = this.database.prepare(`SELECT id,payload_json FROM records WHERE kind='project_identity' AND id IN (${identityIds.map(() => "?").join(",")})`)
      .all(...identityIds) as Array<{ id: string; payload_json: string }>;
    roots.push(...identities.flatMap(row => {
      try {
        const payload = JSON.parse(row.payload_json) as JsonObject;
        const canonical = payload.canonical_scope as JsonObject | undefined;
        if (canonical?.kind !== "project" || !acceptedProjectIds.has(String(canonical.id))
          || typeof payload.identity_digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(payload.identity_digest)
          || typeof payload.local_path_alias !== "string" || !isAbsolute(payload.local_path_alias)) return [];
        const path = realpathSync(payload.local_path_alias);
        return statSync(path).isDirectory() ? [path] : [];
      } catch { return []; }
    }));
    return [...new Set(roots)].sort();
  }

  private memoryDatabase(scope: MemoryScope, domain: PartitionDomain = "memory"): { database: DatabaseSync; file: string } {
    const file = this.partitionDatabaseFile(domain, scope);
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
      database.exec(`PRAGMA busy_timeout=${sqliteBusyTimeoutMs()}; PRAGMA foreign_keys=ON;`);
      ensureJournalMode(database);
      ensureCurrentSchema(database);
      if (!tableExists(database, "content_index")) database.exec("CREATE TABLE content_index (kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, content_ref TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(kind,id,version))");
    } catch (error) { database.close(); throw error; }
    this.#memoryDatabases.set(file, database);
    return { database, file };
  }

  /** Reads never initialize a partition or acquire a SQLite writer lock. */
  private memoryDatabaseForRead(scope: MemoryScope, domain: PartitionDomain = "memory", pointerFile?: string): { database: DatabaseSync; file: string } {
    const current = this.partitionDatabaseFile(domain, scope, false);
    const file = pointerFile ?? current;
    if (canonicalCandidatePath(file) !== canonicalCandidatePath(current)) {
      let legacy: string[] = [];
      if (scope.kind === "project") {
        const roots = this.projectRoots(scope.id);
        if (roots.length !== 1) throw new Error("Legacy project partition root is unavailable or ambiguous");
        legacy = [join(roots[0]!, ".craft_data", domain, `${domain}.db`)];
      } else if (domain === "memory" && scope.kind === "session") {
        legacy = [join("/tmp", ".craft_data", "memory", scope.id, "memory.db"),
          join("/tmp", ".craft_data", "memory", createHash("sha256").update(scope.id).digest("hex").slice(0, 32), "memory.db")];
      }
      if (!legacy.some(path => canonicalCandidatePath(path) === canonicalCandidatePath(file))) throw new Error("Partition pointer leaves its registered legacy scope");
      for (const path of [...(scope.kind === "session" ? [join("/tmp", ".craft_data")] : []), dirname(dirname(file)), dirname(file)]) {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Legacy partition path must use regular directories");
      }
    }
    const cached = this.#memoryReadDatabases.get(file);
    if (cached) return { database: cached, file };
    try {
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Memory database must be a regular file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Memory partition database is unavailable");
      throw error;
    }
    const database = new DatabaseSync(file, { readOnly: true });
    try { database.exec(`PRAGMA busy_timeout=${sqliteBusyTimeoutMs()}; PRAGMA query_only=ON;`); }
    catch (error) { database.close(); throw error; }
    this.#memoryReadDatabases.set(file, database);
    return { database, file };
  }

  private migrateLegacyMemoryRecords(): void {
    const kinds = [...MEMORY_PARTITIONED_KINDS];
    const placeholders = kinds.map(() => "?").join(",");
    const database = this.database;
    const rows = database.prepare(`SELECT kind,id,version,payload_json,created_at,updated_at FROM records WHERE kind IN (${placeholders}) AND json_extract(payload_json,'$._memory_partition') IS NULL ORDER BY CASE kind WHEN 'memory_ledger' THEN 0 WHEN 'memory_candidate' THEN 1 WHEN 'memory_observation' THEN 2 ELSE 3 END,kind,id,version`).all(...kinds) as Array<Record<string, unknown>>;
    if (!rows.length) return;
    this.backupLegacyPartitionRecords("memory", rows);
    const retiredContent: string[] = [];
    for (const row of rows) {
      const kind = String(row.kind), id = String(row.id), version = Number(row.version);
      const payload = JSON.parse(String(row.payload_json)) as JsonObject;
      // `kind` comes from MEMORY_PARTITIONED_KINDS above, so this cannot be null.
      const scope = this.memoryScope(kind, { ...payload, id })!;
      let migratedPayload = { ...payload };
      if (kind === "memory_ledger") migratedPayload = { ...migratedPayload,
        status: String(payload.status ?? "active"), sensitivity: String(payload.sensitivity ?? "internal") };
      const ref = migratedPayload.content_ref as JsonObject | undefined;
      if (kind === "memory_ledger" && ref && typeof ref.path === "string") {
        const { body, manifest } = this.contentStore.readCompatSync(ref as never, `${scope.kind}:${scope.id}`);
        if (!this.memoryContentScopeMatches(manifest.scope, scope)) throw new Error("Memory migration content scope drifted");
        const roots = scope.kind === "project" ? this.projectRoots(scope.id) : [];
        if (scope.kind === "project" && roots.length !== 1) throw new Error("Project Memory storage root is unavailable or ambiguous");
        const expectedRoot = roots[0];
        const next = this.contentStore.writeSync({ kind: "memory", record_id: id, version, scope: manifest.scope,
          status: String(payload.status ?? "active"), sensitivity: String(payload.sensitivity ?? "internal"), source_id: String(payload.source_id), body,
          ...(expectedRoot ? { project_root: expectedRoot } : {}) });
        migratedPayload = { ...migratedPayload, content_ref: next };
        if (ref.path !== next.path) retiredContent.push(ref.path);
      }
      const { database: partition, file } = this.memoryDatabase(scope);
      this.transactionOn(partition, () => {
        const existing = partition.prepare("SELECT payload_json FROM records WHERE kind=? AND id=? AND version=?").get(kind, id, version) as { payload_json: string } | undefined;
        if (existing) {
          if (String(existing.payload_json) !== JSON.stringify(migratedPayload)) throw new Error(`Memory migration collision: ${kind}/${id}@${version}`);
        } else {
          partition.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
            .run(kind, id, version, JSON.stringify(migratedPayload), String(row.created_at), String(row.updated_at));
        }
        this.updateMemoryContentIndex(partition, kind, id, version, migratedPayload, String(row.updated_at));
      });
      const header = this.memoryHeader(migratedPayload, scope, file);
      const result = database.prepare("UPDATE records SET payload_json=? WHERE kind=? AND id=? AND version=? AND payload_json=?")
        .run(JSON.stringify(header), kind, id, version, String(row.payload_json));
      if (Number(result.changes) === 0) {
        const current = database.prepare("SELECT payload_json FROM records WHERE kind=? AND id=? AND version=?").get(kind, id, version) as { payload_json: string } | undefined;
        if (current?.payload_json !== JSON.stringify(header)) throw new Error(`Memory migration changed concurrently: ${kind}/${id}@${version}`);
      }
    }
    for (const path of retiredContent) {
      if (!path.startsWith(this.paths.memoryContentDir + "/")) continue;
      try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  private migrateLegacyExperienceRecords(): void {
    const kinds = [...EXPERIENCE_PARTITIONED_KINDS];
    const placeholders = kinds.map(() => "?").join(",");
    const database = this.database;
    const rows = database.prepare(`SELECT kind,id,version,payload_json,created_at,updated_at FROM records WHERE kind IN (${placeholders}) AND json_extract(payload_json,'$._experience_partition') IS NULL ORDER BY CASE kind WHEN 'workflow_evolution_request' THEN 0 WHEN 'experience_procedure' THEN 1 WHEN 'experience_shadow_experiment' THEN 2 ELSE 3 END,kind,id,version`).all(...kinds) as Array<Record<string, unknown>>;
    if (!rows.length) return;
    this.backupLegacyPartitionRecords("experience", rows);
    for (const row of rows) {
      const kind = String(row.kind), id = String(row.id), version = Number(row.version);
      const payload = JSON.parse(String(row.payload_json)) as JsonObject;
      const scope = this.memoryScope(kind, { ...payload, id }, false)!;
      const migratedPayload = { ...payload };
      if (kind === "experience_procedure" && scope.kind === "project" && payload.content_ref) {
        migratedPayload.content_ref = this.contentStore.relocateSync(payload.content_ref as never, `project:${scope.id}`);
      }
      const { database: partition, file } = this.memoryDatabase(scope, "experience");
      this.transactionOn(partition, () => {
        const existing = partition.prepare("SELECT payload_json FROM records WHERE kind=? AND id=? AND version=?").get(kind, id, version) as { payload_json: string } | undefined;
        if (existing) {
          if (String(existing.payload_json) !== JSON.stringify(migratedPayload)) throw new Error(`Experience migration collision: ${kind}/${id}@${version}`);
        } else {
          partition.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
            .run(kind, id, version, JSON.stringify(migratedPayload), String(row.created_at), String(row.updated_at));
        }
        this.updateMemoryContentIndex(partition, kind, id, version, migratedPayload, String(row.updated_at), "experience");
      });
      const header = this.memoryHeader(migratedPayload, scope, file, "experience");
      const result = database.prepare("UPDATE records SET payload_json=? WHERE kind=? AND id=? AND version=? AND payload_json=?")
        .run(JSON.stringify(header), kind, id, version, String(row.payload_json));
      if (Number(result.changes) === 0) {
        const current = database.prepare("SELECT payload_json FROM records WHERE kind=? AND id=? AND version=?").get(kind, id, version) as { payload_json: string } | undefined;
        if (current?.payload_json !== JSON.stringify(header)) throw new Error(`Experience migration changed concurrently: ${kind}/${id}@${version}`);
      }
    }
  }

  /** Move a bounded keyset page. Legacy reads keep working while the background owner drains pages. */
  reconcileKnowledgeStorage(args: { max_records?: number; cursor?: string; dry_run?: boolean; summary_only?: boolean } = {}): JsonObject {
    const limit = args.max_records ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("max_records must be between 1 and 500");
    if (args.dry_run !== undefined && typeof args.dry_run !== "boolean") throw new Error("dry_run must be boolean");
    if (args.summary_only !== undefined && typeof args.summary_only !== "boolean") throw new Error("summary_only must be boolean");
    const summaryOnly = args.summary_only === true;
    let after: [string, string, number] = ["", "", 0];
    if (args.cursor !== undefined) {
      if (typeof args.cursor !== "string" || !/^[A-Za-z0-9_-]{1,4096}$/u.test(args.cursor)) throw new Error("Knowledge migration cursor is invalid");
      try {
        const value: unknown = JSON.parse(Buffer.from(args.cursor, "base64url").toString("utf8"));
        if (!Array.isArray(value) || value.length !== 3 || typeof value[0] !== "string" || typeof value[1] !== "string"
          || !Number.isSafeInteger(value[2]) || value[2] < 1) throw new Error();
        after = value as [string, string, number];
      } catch { throw new Error("Knowledge migration cursor is invalid"); }
    }
    if (after[0] === "content_scan") {
      if (after[2] !== 1) throw new Error("Knowledge migration cursor is invalid");
      return this.retireLegacyKnowledgeContent(after[1], limit, args.dry_run === true, summaryOnly);
    }
    const rows = this.database.prepare(`SELECT kind,id,version,payload_json,created_at,updated_at FROM records
      WHERE (kind GLOB 'knowledge_*' OR kind GLOB 'wiki_*' OR kind='evidence') AND kind NOT GLOB 'knowledge_memory_*'
        AND json_extract(payload_json,'$._knowledge_partition') IS NULL
        AND (kind>? OR (kind=? AND id>?) OR (kind=? AND id=? AND version>?))
      ORDER BY kind,id,version LIMIT ?`).all(after[0], after[0], after[1], after[0], after[1], after[2], limit + 1) as Array<Record<string, unknown>>;
    const page = rows.slice(0, limit), hasMore = rows.length > limit;
    if (!page.length) return this.retireLegacyKnowledgeContent("", limit, args.dry_run === true, summaryOnly);
    const blocked: JsonObject[] = [];
    const groups = new Map<string, { scope: MemoryScope; rows: Array<Record<string, unknown>> }>();
    const pendingPublications: Array<{ row: Record<string, unknown>; header: JsonObject }> = [];
    let skipped = 0, migrated = 0;
    for (const row of page) {
      const payload = JSON.parse(String(row.payload_json)) as JsonObject;
      if (this.partitionDomain(String(row.kind), payload) !== "knowledge") { skipped++; continue; }
      try {
        const scope = this.memoryScope(String(row.kind), { ...payload, id: row.id })!;
        const file = this.partitionDatabaseFile("knowledge", scope, false);
        const group = groups.get(file) ?? { scope, rows: [] }; group.rows.push(row); groups.set(file, group);
      } catch (error) {
        blocked.push({ kind: row.kind, id: row.id, version: row.version, reason: "storage_scope_unavailable",
          failure_kind: knowledgeMigrationFailureKind(error), failure_phase: "scope_resolution" });
      }
    }
    if (args.dry_run === true) for (const group of groups.values()) {
      const validRows: Array<Record<string, unknown>> = [];
      for (const row of group.rows) {
        try { this.knowledgeContentMigrationSnapshot(group.scope, row); validRows.push(row); }
        catch (error) {
          blocked.push({ kind: row.kind, id: row.id, version: row.version, reason: "partition_migration_failed",
            failure_kind: knowledgeMigrationFailureKind(error), failure_phase: "content_preflight" });
        }
      }
      group.rows = validRows;
    }
    const migrateGroup = (scope: MemoryScope, groupRows: Array<Record<string, unknown>>): void => {
      let failure_phase = "partition_path";
      try {
        const file = this.partitionDatabaseFile("knowledge", scope);
        const snapshots = new Map<string, ContentMigrationSnapshot>();
        failure_phase = "content_validation";
        if (scope.kind === "project") for (const row of groupRows) {
          const snapshot = this.knowledgeContentMigrationSnapshot(scope, row);
          if (snapshot) snapshots.set(snapshot.path, snapshot);
        }
        failure_phase = "backup";
        this.writeLegacyPartitionBackup("knowledge", scope, dirname(file), groupRows,
          { write: writeFileSync, rename: renameSync, unlink: unlinkSync }, [...snapshots.values()]);
        failure_phase = "partition_open";
        const partition = this.memoryDatabase(scope, "knowledge").database;
        failure_phase = "partition_stage";
        const staged = this.transactionOn(partition, () => groupRows.map(row => {
          const kind = String(row.kind), id = String(row.id), version = Number(row.version);
          const payload = JSON.parse(String(row.payload_json)) as JsonObject;
          const ref = payload.content_ref as JsonObject | undefined;
          const migratedPayload = scope.kind === "project" && ref?.kind === "knowledge"
            ? { ...payload, content_ref: this.contentStore.relocateSync(ref as never, `project:${scope.id}`) } : payload;
          const encoded = JSON.stringify(migratedPayload);
          const prior = partition.prepare("SELECT payload_json FROM records WHERE kind=? AND id=? AND version=?").get(kind, id, version) as { payload_json: string } | undefined;
          if (prior && prior.payload_json !== encoded) throw new Error("Knowledge migration collision");
          if (!prior) partition.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
            .run(kind, id, version, encoded, String(row.created_at), String(row.updated_at));
          this.updateMemoryContentIndex(partition, kind, id, version, migratedPayload, String(row.updated_at), "knowledge");
          return { row, header: this.memoryHeader(migratedPayload, scope, file, "knowledge") };
        }));
        pendingPublications.push(...staged);
      } catch (error) {
        const failure_kind = knowledgeMigrationFailureKind(error);
        if (groupRows.length > 1 && ["content_path_out_of_scope", "scope_validation", "content_validation", "source_missing"].includes(failure_kind)) {
          const middle = Math.floor(groupRows.length / 2);
          migrateGroup(scope, groupRows.slice(0, middle));
          migrateGroup(scope, groupRows.slice(middle));
          return;
        }
        for (const row of groupRows) blocked.push({ kind: row.kind, id: row.id, version: row.version,
          reason: "partition_migration_failed", failure_kind, failure_phase });
      }
    };
    if (args.dry_run !== true) {
      for (const { scope, rows: groupRows } of groups.values()) migrateGroup(scope, groupRows);
      if (pendingPublications.length) {
        try {
          this.transaction(database => {
            for (const { row, header } of pendingPublications) {
              const encoded = JSON.stringify(header);
              const changed = database.prepare("UPDATE records SET payload_json=? WHERE kind=? AND id=? AND version=? AND payload_json=?")
                .run(encoded, String(row.kind), String(row.id), Number(row.version), String(row.payload_json));
              if (Number(changed.changes) === 0) {
                const current = database.prepare("SELECT payload_json FROM records WHERE kind=? AND id=? AND version=?")
                  .get(String(row.kind), String(row.id), Number(row.version)) as { payload_json: string } | undefined;
                if (current?.payload_json !== encoded) throw new Error("Knowledge migration changed concurrently");
              }
            }
          });
          migrated += pendingPublications.length;
        } catch (error) {
          const failure_kind = knowledgeMigrationFailureKind(error);
          for (const { row } of pendingPublications) blocked.push({ kind: row.kind, id: row.id, version: row.version,
            reason: "partition_migration_failed", failure_kind, failure_phase: "central_publish" });
        }
      }
    }
    const last = page.at(-1)!;
    const cursor = Buffer.from(JSON.stringify(hasMore ? [last.kind, last.id, last.version] : ["content_scan", "", 1])).toString("base64url");
    return { status: "partial", phase: "records", examined: page.length,
      migratable: [...groups.values()].reduce((total, group) => total + group.rows.length, 0), migrated, skipped,
      ...blockedSummary(blocked, summaryOnly), blocked_failure_kinds: blockedFailureKinds(blocked),
      blocked_failure_phases: blockedFailurePhases(blocked), summary_only: summaryOnly,
      has_more: true, next_cursor: cursor, dry_run: args.dry_run === true, raw_content_stored: false };
  }

  private knowledgeContentMigrationSnapshot(scope: MemoryScope, row: Record<string, unknown>): ContentMigrationSnapshot | null {
    if (scope.kind !== "project") return null;
    const payload = JSON.parse(String(row.payload_json)) as JsonObject;
    const ref = payload.content_ref as ContentRef | undefined;
    if (ref?.kind !== "knowledge") return null;
    const expectedScope = `project:${scope.id}`;
    const { manifest } = this.contentStore.readCompatSync(ref, expectedScope);
    if (manifest.scope !== expectedScope) throw new Error("Knowledge migration content scope drifted");
    if (!resolve(ref.path).startsWith(`${resolve(this.paths.knowledgeContentDir)}${sep}`)) return null;
    return this.legacyKnowledgeSnapshot(ref.path);
  }

  private memoryContentScopeMatches(value: string, scope: MemoryScope): boolean {
    return value === `${scope.kind}:${scope.id}` || value === "global" && scope.kind === "global" && scope.id === "global";
  }

  private legacyKnowledgeSnapshot(path: string): ContentMigrationSnapshot {
    return this.legacyContentSnapshot(path, this.paths.knowledgeContentDir, "Knowledge");
  }

  private legacyContentSnapshot(path: string, directory: string, capability: string): ContentMigrationSnapshot {
    const root = resolve(directory), rootStat = lstatSync(root), stat = lstatSync(path);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || stat.isSymbolicLink() || !stat.isFile() || stat.size > 8 * 1024 * 1024
      || !realpathSync(path).startsWith(realpathSync(root) + sep) || !resolve(path).startsWith(root + sep)) throw new Error(`Legacy ${capability} content must be a bounded regular file`);
    const markdown = readFileSync(path, "utf8");
    return { path, digest: `sha256:${createHash("sha256").update(markdown).digest("hex")}`, markdown };
  }

  /** Files themselves are the retry queue: never remove a legacy body before
   * its scoped copy, self-contained backup and all versioned references agree. */
  private retireLegacyKnowledgeContent(after: string, limit: number, dryRun: boolean, summaryOnly: boolean): JsonObject {
    const root = this.paths.knowledgeContentDir;
    const stat = lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Legacy Knowledge content directory must be regular");
    const names = readdirSync(root).filter(name => name.endsWith(".md") && name > after).sort();
    const page = names.slice(0, limit), hasMore = names.length > limit;
    const blocked: JsonObject[] = [];
    let skipped = 0, migratable = 0, retired = 0;
    const placeholders = CONTENT_REFERENCE_RECORD_KINDS.map(() => "?").join(",");
    const referenced = this.database.prepare(`SELECT 1 FROM records WHERE kind IN (${placeholders})
      AND json_extract(payload_json,'$.content_ref.path')=? LIMIT 1`);
    // One metadata scan per page, rather than re-parsing every historical
    // record for each file. A final point check still runs under the writer transaction.
    const referencedPaths = new Set(this.database.prepare(`SELECT DISTINCT json_extract(payload_json,'$.content_ref.path') path
      FROM records WHERE kind IN (${placeholders}) AND json_extract(payload_json,'$.content_ref.path') IS NOT NULL`)
      .all(...CONTENT_REFERENCE_RECORD_KINDS).map(row => String(row.path)));
    for (const name of page) {
      const path = join(root, name);
      const identity = { kind: "knowledge_content", id: createHash("sha256").update(name).digest("hex"), version: 1 };
      try {
        const snapshot = this.legacyKnowledgeSnapshot(path);
        const { manifest, body } = this.contentStore.readUncheckedSync(path);
        if (manifest.record_kind !== "knowledge" || !manifest.scope.startsWith("project:")) { skipped++; continue; }
        if (referencedPaths.has(path)) {
          blocked.push({ ...identity, reason: "legacy_content_still_referenced" }); continue;
        }
        const scope: MemoryScope = { kind: "project", id: manifest.scope.slice("project:".length) };
        const file = this.partitionDatabaseFile("knowledge", scope, false);
        const ref: ContentRef = { kind: "knowledge", record_id: manifest.record_id, version: manifest.record_version, path,
          scope: manifest.scope, digest: manifest.body_digest, bytes: Buffer.byteLength(body), format: "markdown", title: manifest.title ?? manifest.record_id };
        this.contentStore.readCompatSync(ref, manifest.scope);
        migratable++;
        if (dryRun) continue;
        const moved = this.contentStore.relocateSync(ref, manifest.scope);
        this.writeLegacyPartitionBackup("knowledge", scope, dirname(file), [],
          { write: writeFileSync, rename: renameSync, unlink: unlinkSync }, [snapshot]);
        this.transaction(() => {
          // The short writer transaction prevents publication of a competing
          // reference between this check and unlink. Copy and backup happened outside it.
          if (referenced.get(...CONTENT_REFERENCE_RECORD_KINDS, path)) throw new Error("Legacy Knowledge content acquired a reference");
          this.contentStore.readSync(moved);
          if (this.legacyKnowledgeSnapshot(path).digest !== snapshot.digest) throw new Error("Legacy Knowledge content changed concurrently");
          unlinkSync(path);
        });
        retired++;
      } catch { blocked.push({ ...identity, reason: "legacy_content_retirement_failed" }); }
    }
    return { status: blocked.length || hasMore ? "partial" : "completed", phase: "content", examined: page.length,
      migratable, migrated: 0, retired_content: retired, skipped, ...blockedSummary(blocked, summaryOnly), summary_only: summaryOnly,
      has_more: hasMore,
      next_cursor: hasMore ? Buffer.from(JSON.stringify(["content_scan", page.at(-1), 1])).toString("base64url") : null,
      dry_run: dryRun, raw_content_stored: false };
  }

  private memoryHeader(payload: JsonObject, scope: MemoryScope, file: string, domain: PartitionDomain = "memory"): JsonObject {
    const projection: JsonObject = { scope };
    for (const key of ["source_id", "document_id", "claim_id", "content_ref", "content_digest", "memory_id", "memory_version", "procedure_id", "scenario_key", "source_session_id"]) {
      if (payload[key] !== undefined) projection[key] = payload[key];
    }
    return { ...projection, [`_${domain}_partition`]: { file, scope } };
  }

  private partitionPointer(kind: string, id: string, version?: number): { domain: PartitionDomain; scope: MemoryScope; file: string; recordId?: string } | null {
    let row = version === undefined
      ? this.database.prepare("SELECT payload_json FROM records WHERE kind=? AND id=? ORDER BY version DESC LIMIT 1").get(kind, id)
      : this.database.prepare("SELECT payload_json FROM records WHERE kind=? AND id=? AND version=?").get(kind, id, version);
    if (!row && kind === "evolution_cycle") row = this.database.prepare("SELECT payload_json FROM records WHERE kind=? AND id=? ORDER BY version DESC LIMIT 1").get(kind, id);
    if (!row) return null;
    return this.partitionPointerFromPayload(JSON.parse(String((row as { payload_json: string }).payload_json)) as JsonObject);
  }

  private partitionPointerFromPayload(payload: JsonObject): { domain: PartitionDomain; scope: MemoryScope; file: string; recordId?: string } | null {
    for (const domain of ["memory", "experience", "knowledge", "evolution"] as const) {
      const pointer = payload[`_${domain}_partition`] as JsonObject | undefined;
      if (!pointer || !pointer.scope || typeof pointer.scope !== "object") continue;
      const scope = pointer.scope as MemoryScope;
      return { domain, scope, file: typeof pointer.file === "string" ? pointer.file : this.partitionDatabaseFile(domain, scope, false),
        ...(typeof pointer.record_id === "string" ? { recordId: pointer.record_id } : {}) };
    }
    return null;
  }

  private memoryPointer(kind: string, id: string, version?: number): JsonObject | null {
    const pointer = this.partitionPointer(kind, id, version);
    return pointer?.domain === "memory" ? { file: pointer.file, scope: pointer.scope } : null;
  }

  private writeMemory(kind: string, id: string, payload: JsonObject, mode: "create" | "save", expectedVersion?: number, version?: number): JsonObject {
    const domain = this.partitionDomain(kind, payload)!;
    const current = this.find(kind, id, undefined, false);
    const currentPointer = mode === "save" && current ? this.partitionPointer(kind, id) : null;
    const scope = this.memoryScope(kind, { ...payload, id }, true, Boolean(currentPointer))!;
    if (mode === "create" && current) throw new Error(`${kind} already exists: ${id}`);
    if (mode === "save" && current && JSON.stringify(currentPointer?.scope ?? this.memoryScope(kind, current)) !== JSON.stringify(scope)) {
      throw new Error("Memory record cannot change storage scope");
    }
    // A normal save is optimistic too: bind it to the version observed before
    // staging so a concurrent delete or update cannot publish a dangling or
    // stale pointer. Callers that need retry semantics can re-read and retry.
    const payloadVersion = Number.isSafeInteger(payload.version) ? Number(payload.version) : Number(current?.version ?? 0);
    const requiredVersion = mode === "save" ? expectedVersion ?? payloadVersion : expectedVersion;
    if (requiredVersion !== undefined && Number(current?.version ?? 0) !== requiredVersion) throw new Error(`Concurrent update detected for ${kind}: ${id}`);
    const { database: partition, file } = this.memoryDatabase(scope, domain);
    return this.transaction(main => {
      // Acquire the publication lock before staging. If BEGIN times out, no
      // partition state has changed. A crash after staging leaves an immutable
      // unpublished row that an identical retry can safely adopt under this lock.
      if (domain === "experience") this.memoryScope(kind, { ...payload, id });
      this.assertPartitionDomain(kind, id, payload);
      const latestRow = main.prepare("SELECT * FROM records WHERE kind=? AND id=? ORDER BY version DESC LIMIT 1").get(kind, id);
      const latest = latestRow ? this.record(latestRow as Record<string, unknown>, false) : null;
      if (mode === "create" && latest) throw new Error(`${kind} already exists: ${id}`);
      const latestScope = latest ? this.partitionPointerFromPayload(latest)?.scope ?? this.memoryScope(kind, latest) : null;
      if (latest && JSON.stringify(latestScope) !== JSON.stringify(scope)) throw new Error("Memory record cannot change storage scope");
      if (requiredVersion !== undefined && Number(latest?.version ?? 0) !== requiredVersion) {
        throw new Error(`Concurrent update detected for ${kind}: ${id}`);
      }
      const partitionPayload = { ...payloadOnly(payload), ...(domain === "memory" ? { scope } : {}) };
      const partitionVersion = version ?? Number(latest?.version ?? 0) + 1;
      const saved = this.transactionOn(partition, () => {
        const prior = partition.prepare("SELECT * FROM records WHERE kind=? AND id=? AND version=?")
          .get(kind, id, partitionVersion) as Record<string, unknown> | undefined;
        if (prior) {
          if (String(prior.payload_json) !== JSON.stringify(partitionPayload)) {
            throw new Error(mode === "create" ? `${kind} already exists: ${id}` : `Unpublished partition version conflicts for ${kind}: ${id}`);
          }
          return this.record(prior, false);
        }
        const record = this.insert(partition, { kind, id, payload: partitionPayload, version: partitionVersion });
        this.updateMemoryContentIndex(partition, kind, id, Number(record.version), partitionPayload, String(record.updated_at), domain);
        return record;
      });
      this.#pendingMemoryRows.push({ file, kind, id, version: partitionVersion });
      const header = this.memoryHeader(partitionPayload, scope, file, domain);
      main.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
        .run(kind, id, Number(saved.version), JSON.stringify(header), String(saved.created_at), String(saved.updated_at));
      return saved;
    });
  }

  /** Bounded keyset scan for background asset maintenance, including historical revisions. */
  experienceDefinitionMigrationPage(afterId: string, afterVersion: number, limit: number): JsonObject[] {
    if (!Number.isSafeInteger(afterVersion) || afterVersion < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Experience migration page bounds are invalid");
    }
    const rows = this.database.prepare(`SELECT * FROM records WHERE kind='experience_procedure'
      AND (id>? OR (id=? AND version>?)) ORDER BY id,version LIMIT ?`).all(afterId, afterId, afterVersion, limit);
    return rows.map(row => this.recordFromSnapshot(row as Record<string, unknown>, false));
  }

  /** Change only a checked definition's physical location; logical history remains immutable. */
  relocateExperienceDefinition(id: string, version: number, expected: JsonObject, next: JsonObject): void {
    for (const key of ["format", "procedure_id", "procedure_version", "kind", "digest"]) {
      if (expected[key] !== next[key]) throw new Error("Experience definition relocation cannot change identity");
    }
    if (typeof next.path !== "string" || !next.path.trim()) throw new Error("Experience definition relocation requires a path");
    const pointer = this.partitionPointer("experience_procedure", id, version);
    if (!pointer) throw new Error("Experience definition relocation record is missing");
    const { database } = this.memoryDatabase(pointer.scope, "experience");
    this.transactionOn(database, () => {
      const row = database.prepare("SELECT payload_json FROM records WHERE kind='experience_procedure' AND id=? AND version=?")
        .get(pointer.recordId ?? id, version) as { payload_json: string } | undefined;
      if (!row) throw new Error("Experience definition relocation record is missing");
      const payload = JSON.parse(row.payload_json) as JsonObject;
      if (next.scope !== payload.scope) throw new Error("Experience definition relocation cannot change scope");
      const current = JSON.stringify(payload.definition_ref);
      if (current === JSON.stringify(next)) return;
      if (current !== JSON.stringify(expected)) throw new Error("Experience definition relocation changed concurrently");
      database.prepare("UPDATE records SET payload_json=? WHERE kind='experience_procedure' AND id=? AND version=?")
        .run(JSON.stringify({ ...payload, definition_ref: next }), pointer.recordId ?? id, version);
    });
  }

  private transactionOn<T>(database: DatabaseSync, operation: () => T): T {
    // Never wait for a partition writer while holding the central publication
    // lock. Other writers can retry after this optimistic attempt rolls back.
    const previousTimeout = this.#transactionDepth > 0
      ? Number(database.prepare("PRAGMA busy_timeout").get()!.timeout) : undefined;
    if (previousTimeout !== undefined) database.exec("PRAGMA busy_timeout=0;");
    try {
      const role = database === this.#database ? "primary" : "capability_partition";
      const beginStartedAt = performance.now();
      try { this.beginImmediate(database, role); }
      catch (error) { throw storageFailure(error, database, role, "transaction_begin",
        Math.max(0, Math.round(performance.now() - beginStartedAt))); }
      try { const result = operation(); database.exec("COMMIT"); return result; }
      catch (error) { database.exec("ROLLBACK"); throw storageFailure(error, database, database === this.#database ? "primary" : "capability_partition", "transaction_operation"); }
    } finally { if (previousTimeout !== undefined) database.exec(`PRAGMA busy_timeout=${previousTimeout};`); }
  }

  private beginImmediate(database: DatabaseSync, role: string): void {
    const limit = role === "primary" ? contextLockBudget.getStore() : undefined;
    const previous = limit === undefined ? undefined : Number(database.prepare("PRAGMA busy_timeout").get()!.timeout);
    const changeTimeout = previous !== undefined && limit !== undefined && previous > limit;
    if (changeTimeout) database.exec(`PRAGMA busy_timeout=${limit};`);
    try {
      try { database.exec("BEGIN IMMEDIATE"); }
      catch (error) {
        const failure = storageFailure(error, database, role, "transaction_begin");
        const details = failure && typeof failure === "object" ? (failure as { safeDetails?: Record<string, unknown> }).safeDetails : undefined;
        // Retry only BEGIN in Hook mode; never replay an operation after it starts.
        if (process.env.CRAFT_HOOK_MODE !== "1" || role !== "primary"
          || details?.phase !== "transaction_begin" || details.retryable !== true) throw failure;
        const wait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
        Atomics.wait(wait, 0, 0, 25);
        try { database.exec("BEGIN IMMEDIATE"); }
        catch (retryError) { throw storageFailure(retryError, database, role, "transaction_begin"); }
      }
    } finally { if (changeTimeout) database.exec(`PRAGMA busy_timeout=${previous};`); }
  }

  private updateMemoryContentIndex(database: DatabaseSync, kind: string, id: string, version: number, payload: JsonObject, updatedAt: string, domain: PartitionDomain = "memory"): void {
    const ref = payload.content_ref;
    if (!ref || typeof ref !== "object" || Array.isArray(ref) || (ref as JsonObject).kind !== domain) {
      database.prepare("DELETE FROM content_index WHERE kind=? AND id=? AND version=?").run(kind, id, version);
      return;
    }
    database.prepare("INSERT OR REPLACE INTO content_index(kind,id,version,content_ref,updated_at) VALUES(?,?,?,?,?)")
      .run(kind, id, version, JSON.stringify(ref), updatedAt);
  }

  find(kind: string, id: string, version?: number, hydrate = true): JsonObject | null {
    let row = version === undefined
      ? this.database.prepare(
        "SELECT * FROM records WHERE kind=? AND id=? ORDER BY version DESC LIMIT 1",
      ).get(kind, id)
      : this.database.prepare(
        "SELECT * FROM records WHERE kind=? AND id=? AND version=?",
      ).get(kind, id, version);
    if (!row && kind === "evolution_cycle") row = this.database.prepare(
      "SELECT * FROM records WHERE kind=? AND id=? ORDER BY version DESC LIMIT 1",
    ).get(kind, id);
    if (!row) return TRACE_SHARDED_KINDS.has(kind) ? this.traceShards.find(kind, id, version)
      : CODEBASE_GRAPH_KINDS.has(kind) ? this.codebaseShards.find(kind, id, version) : null;
    const raw = row as Record<string, unknown>;
    const partition = this.partitionPointerFromPayload(JSON.parse(String(raw.payload_json)) as JsonObject);
    if (partition) {
      const target = this.memoryDatabaseForRead(partition.scope, partition.domain, partition.file).database;
      const source = partition.domain === "evolution" && version === undefined
        ? target.prepare("SELECT * FROM records WHERE kind=? AND id=? ORDER BY version DESC LIMIT 1").get(kind, partition.recordId ?? id)
        : target.prepare("SELECT * FROM records WHERE kind=? AND id=? AND version=?").get(kind, partition.recordId ?? id, Number(version ?? raw.version));
      if (!source) throw new Error(`${PARTITION_LABELS[partition.domain]} partition record is missing: ${kind}/${id}@${String(version ?? raw.version)}`);
      return this.record({ ...(source as Record<string, unknown>), id }, hydrate);
    }
    return this.record(raw, hydrate);
  }

  private recordFromSnapshot(row: Record<string, unknown>, hydrate: boolean): JsonObject {
    const partition = this.partitionPointerFromPayload(JSON.parse(String(row.payload_json)) as JsonObject);
    if (!partition) return this.record(row, hydrate);
    const target = this.memoryDatabaseForRead(partition.scope, partition.domain, partition.file).database;
    const source = partition.domain === "evolution"
      ? target.prepare("SELECT * FROM records WHERE kind=? AND id=? ORDER BY version DESC LIMIT 1").get(String(row.kind), partition.recordId ?? String(row.id))
      : target.prepare("SELECT * FROM records WHERE kind=? AND id=? AND version=?").get(String(row.kind), partition.recordId ?? String(row.id), Number(row.version));
    if (!source) throw new Error(`${PARTITION_LABELS[partition.domain]} partition record is missing: ${String(row.kind)}/${String(row.id)}@${String(row.version)}`);
    return this.record({ ...(source as Record<string, unknown>), id: row.id }, hydrate);
  }

  /** Read a bounded set of latest records with one query per SQLite parameter batch. */
  findMany(kind: string, ids: readonly string[], hydrate = true): JsonObject[] {
    if (typeof kind !== "string" || !kind.trim()) throw new Error("kind must not be empty");
    if (!Array.isArray(ids) || ids.length > 10_000 || ids.some(id => typeof id !== "string" || !id.trim())) throw new Error("record ids exceed read bounds");
    const unique = [...new Set(ids)];
    if (TRACE_SHARDED_KINDS.has(kind) || CODEBASE_GRAPH_KINDS.has(kind)) return unique.flatMap(id => {
      const found = this.find(kind, id, undefined, hydrate);
      return found ? [found] : [];
    });
    const byId = new Map<string, JsonObject>();
    for (let offset = 0; offset < unique.length; offset += 500) {
      const batch = unique.slice(offset, offset + 500);
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.database.prepare(`SELECT r.* FROM records r JOIN (
        SELECT id,MAX(version) version FROM records WHERE kind=? AND id IN (${placeholders}) GROUP BY id
        ) latest ON latest.id=r.id AND latest.version=r.version WHERE r.kind=?`)
        .all(kind, ...batch, kind) as Array<Record<string, unknown>>;
      for (const row of rows) byId.set(String(row.id), this.recordFromSnapshot(row, hydrate));
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
      // The ordered query already contains the exact latest version. Re-reading
      // every row through find() turns a bounded list into N additional SQLite
      // queries (and N latest-version lookups against the shared WAL database).
      const record = this.recordFromSnapshot(header, hydrate);
      if (predicate && !predicate(record)) continue;
      records.push(record);
      if (records.length === bounded) break;
    }
    if (!TRACE_SHARDED_KINDS.has(kind) && !CODEBASE_GRAPH_KINDS.has(kind)) return records;
    const merged = new Map<string, JsonObject>();
    for (const item of TRACE_SHARDED_KINDS.has(kind) ? this.traceShards.list(kind, bounded, predicate)
      : this.codebaseShards.list(kind, bounded, predicate)) merged.set(String(item.id), item);
    for (const item of records) merged.set(String(item.id), item); // Legacy rows win until migrated.
    return [...merged.values()].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || String(b.id).localeCompare(String(a.id))).slice(0, bounded);
  }

  /** List one stable ID-ordered page; callers may persist the returned ID as a resumable cursor. */
  listByIdPage(kind: string, afterId: string, limit = 100): { records: JsonObject[]; has_more: boolean; next_cursor: string | null } {
    if (typeof kind !== "string" || !kind.trim()) throw new Error("kind must not be empty");
    if (typeof afterId !== "string") throw new Error("after_id must be a string");
    const bounded = validLimit(limit);
    if (bounded > 1_000) throw new Error("page limit must not exceed 1000");
    const rows = this.database.prepare(`SELECT r.* FROM records r JOIN (
      SELECT id,MAX(version) version FROM records WHERE kind=? GROUP BY id
      ) latest ON latest.id=r.id AND latest.version=r.version
      WHERE r.kind=? AND r.id>? ORDER BY r.id ASC LIMIT ?`).all(kind, kind, afterId, bounded + 1) as Array<Record<string, unknown>>;
    const hasMore = rows.length > bounded;
    const page = rows.slice(0, bounded);
    const records = page.map(row => this.recordFromSnapshot(row, true));
    return { records, has_more: hasMore, next_cursor: hasMore && page.length ? String(page[page.length - 1]!.id) : null };
  }

  /** Fetch a bounded page of terminal traces eligible for archival without hydrating unrelated history. */
  listTraceRetentionCandidates(cutoff: string, limit: number): JsonObject[] {
    const bounded = validLimit(limit);
    const rows = this.database.prepare(`SELECT r.* FROM records r JOIN (
      SELECT id,MAX(version) version FROM records WHERE kind='trace' GROUP BY id
      ) latest ON latest.id=r.id AND latest.version=r.version
      WHERE r.kind='trace'
        AND json_extract(r.payload_json,'$.status') IN ('completed','failed','cancelled','blocked')
        AND COALESCE(json_extract(r.payload_json,'$.last_event_at'),r.updated_at,json_extract(r.payload_json,'$.started_at')) < ?
      ORDER BY COALESCE(json_extract(r.payload_json,'$.last_event_at'),r.updated_at,json_extract(r.payload_json,'$.started_at')) ASC
      LIMIT ?`).all(cutoff, bounded) as Array<Record<string, unknown>>;
    const merged = new Map<string, JsonObject>();
    for (const item of this.traceShards.retentionCandidates(cutoff, bounded)) merged.set(String(item.id), item);
    for (const row of rows) { const item = this.record(row, true); merged.set(String(item.id), item); }
    return [...merged.values()].sort((a, b) => String(a.last_event_at ?? a.updated_at).localeCompare(String(b.last_event_at ?? b.updated_at))).slice(0, bounded);
  }

  /** Resolve a Trace child without scanning unrelated Trace shards. */
  findTraceChild(kind: "trace_event" | "trace_feedback", id: string, traceId: string): JsonObject | null {
    const row = this.database.prepare("SELECT * FROM records WHERE kind=? AND id=? ORDER BY version DESC LIMIT 1").get(kind, id) as Record<string, unknown> | undefined;
    return row ? this.record(row, true) : this.traceShards.find(kind, id, undefined, traceId);
  }

  /** Read only one trace's latest child records; used to build an archive outside write transactions. */
  listTraceChildren(kind: "trace_event" | "trace_feedback" | "telemetry_event", traceId: string): JsonObject[] {
    const rows = this.database.prepare(`SELECT r.* FROM records r JOIN (
      SELECT id,MAX(version) version FROM records WHERE kind=? AND json_extract(payload_json,'$.trace_id')=? GROUP BY id
      ) latest ON latest.id=r.id AND latest.version=r.version
      WHERE r.kind=? AND json_extract(r.payload_json,'$.trace_id')=? ORDER BY r.id`).all(kind, traceId, kind, traceId) as Array<Record<string, unknown>>;
    const merged = new Map<string, JsonObject>();
    for (const item of this.traceShards.children(kind, traceId)) merged.set(String(item.id), item);
    for (const row of rows) { const item = this.record(row, true); merged.set(String(item.id), item); }
    return [...merged.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  /** SQL scope filtering precedes body hydration. Additional ACL predicates use metadata only. */
  listScoped(kind: string, scopes: readonly { kind: string; id: string }[], limit = 20, predicate?: (record: JsonObject) => boolean, temporal?: { known_at?: string; history?: boolean }, options: { hydrateContent?: boolean } = {}): JsonObject[] {
    const bounded = validLimit(limit);
    if (!Array.isArray(scopes) || scopes.some(scope => !scope || typeof scope.kind !== "string" || typeof scope.id !== "string")) throw new Error("Invalid scoped query");
    if (!scopes.length) return [];
    const scopeSql = `EXISTS (SELECT 1 FROM json_each(?) s WHERE
      json_extract(r.payload_json,'$.scope')=json_extract(s.value,'$.kind')||':'||json_extract(s.value,'$.id')
      OR (json_extract(r.payload_json,'$.scope')=json_extract(s.value,'$.id') AND substr(json_extract(s.value,'$.id'),1,length(json_extract(s.value,'$.kind'))+1)=json_extract(s.value,'$.kind')||':')
      OR (json_extract(s.value,'$.kind')='global' AND json_extract(r.payload_json,'$.scope')='global')
      OR (json_extract(r.payload_json,'$.scope.kind')=json_extract(s.value,'$.kind') AND json_extract(r.payload_json,'$.scope.id')=json_extract(s.value,'$.id'))
      OR (json_extract(r.payload_json,'$.scope.kind')=json_extract(s.value,'$.kind') AND substr(json_extract(s.value,'$.id'),1,length(json_extract(s.value,'$.kind'))+1)=json_extract(s.value,'$.kind')||':' AND json_extract(r.payload_json,'$.scope.id')=substr(json_extract(s.value,'$.id'),length(json_extract(s.value,'$.kind'))+2)))`;
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
        selected.push(this.recordFromSnapshot(header, options.hydrateContent !== false));
        if (selected.length === bounded) return selected;
      }
      if (rows.length < 512) break;
      const last = rows[rows.length - 1]!;
      cursorTime = String(last.updated_at); cursorRow = Number(last.read_rowid);
    }
    return selected;
  }

  count(kind: string): number {
    const central = Number((this.database.prepare(`SELECT COUNT(*) count FROM records r JOIN (
      SELECT id,MAX(version) version FROM records WHERE kind=? GROUP BY id
      ) latest ON latest.id=r.id AND latest.version=r.version WHERE r.kind=?`)
      .get(kind, kind) as { count: number }).count);
    return central + (TRACE_SHARDED_KINDS.has(kind) ? this.traceShards.count(kind)
      : CODEBASE_GRAPH_KINDS.has(kind) ? this.codebaseShards.count(kind) : 0);
  }

  /** Count latest records for multiple kinds in one indexed query. */
  countMany(kinds: readonly string[]): Record<string, number> {
    if (!Array.isArray(kinds) || kinds.length > 1_000 || kinds.some(kind => typeof kind !== "string" || !kind.trim())) {
      throw new Error("record count kinds exceed bounds");
    }
    const unique = [...new Set(kinds)];
    const counts = Object.fromEntries(unique.map(kind => [kind, 0]));
    if (!unique.length) return counts;
    const rows = this.database.prepare(`SELECT kind,COUNT(*) AS count FROM (
      SELECT kind,id,MAX(version) AS version FROM records
      WHERE kind IN (SELECT value FROM json_each(?)) GROUP BY kind,id
      ) latest GROUP BY kind`).all(JSON.stringify(unique)) as Array<{ kind: string; count: number }>;
    for (const row of rows) counts[row.kind] = Number(row.count);
    for (const kind of unique) {
      if (TRACE_SHARDED_KINDS.has(kind)) counts[kind] += this.traceShards.count(kind);
      else if (CODEBASE_GRAPH_KINDS.has(kind)) counts[kind] += this.codebaseShards.count(kind);
    }
    return counts;
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
      if (CODEBASE_GRAPH_KINDS.has(kind)) for (const id of requested) {
        if (byId.has(id)) continue;
        const row = this.codebaseShards.raw(kind, id);
        if (row) byId.set(id, row);
      }
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
    if (CODEBASE_GRAPH_KINDS.has(kind) && !this.database.prepare("SELECT 1 FROM records WHERE kind=? AND id=? LIMIT 1").get(kind, id))
      return this.codebaseShards.history(kind, id, before, limit);
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
    this.replacePayloadBatch([{ kind, id, version, payload }]);
  }

  replacePayloadBatch(entries: Array<{ kind: string; id: string; version: number; payload: JsonObject }>): void {
    if (!entries.length) return;
    for (const { kind, id, version } of entries) {
      const pointer = this.partitionPointer(kind, id, version);
      if (pointer) {
        this.assertCurrentPartitionPointer(pointer);
        this.memoryDatabase(pointer.scope, pointer.domain);
      }
    }
    this.transaction(main => {
      for (const { kind, id, version, payload } of entries) {
        const current = this.find(kind, id, version, false);
        if (!current) throw new Error(`Unknown record version: ${kind}/${id}/${version}`);
        const pointer = this.partitionPointer(kind, id, version);
        const clean = payloadOnly(payload), updatedAt = new Date().toISOString();
        if (!pointer) {
          main.prepare("UPDATE records SET payload_json=?,updated_at=? WHERE kind=? AND id=? AND version=?")
            .run(JSON.stringify(clean), updatedAt, kind, id, version);
          continue;
        }
        const { scope, domain, file } = pointer;
        if (domain !== this.partitionDomain(kind, clean)) throw new Error("Record cannot change capability storage owner");
        if (JSON.stringify(this.memoryScope(kind, { ...clean, id })) !== JSON.stringify(scope)) throw new Error("Memory record cannot change storage scope");
        const target = this.memoryDatabase(scope, domain).database;
        // Physical revision identity makes in-place logical migrations atomic:
        // the old payload stays readable until all central pointers commit.
        const recordId = `${id}:revision:${randomUUID()}`;
        this.transactionOn(target, () => {
          const exists = target.prepare("SELECT 1 present FROM records WHERE kind=? AND id=? AND version=?")
            .get(kind, pointer.recordId ?? id, version);
          if (!exists) throw new Error(`Unknown record version: ${kind}/${id}/${version}`);
          target.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
            .run(kind, recordId, version, JSON.stringify({ ...clean, _craft_logical_record_id: id }), String(current.created_at), updatedAt);
          this.updateMemoryContentIndex(target, kind, recordId, version, clean, updatedAt, domain);
        });
        this.#pendingMemoryRows.push({ file, kind, id: recordId, logicalId: id, version });
        const header = this.memoryHeader(clean, scope, file, domain);
        (header[`_${domain}_partition`] as JsonObject).record_id = recordId;
        main.prepare("UPDATE records SET payload_json=?,updated_at=? WHERE kind=? AND id=? AND version=?")
          .run(JSON.stringify(header), updatedAt, kind, id, version);
        // Keep superseded immutable payloads in their scoped database. A central
        // pre-migration backup may still point to them during an explicit restore.
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
    return this.transaction(main => {
      const rows = main.prepare("SELECT version FROM records WHERE kind=? AND id=?").all(kind, id);
      const partitions = new Map<string, DatabaseSync>();
      for (const row of rows) {
        const pointer = this.partitionPointer(kind, id, Number(row.version));
        if (pointer) {
          this.assertCurrentPartitionPointer(pointer);
          if (!partitions.has(pointer.file)) partitions.set(pointer.file, this.memoryDatabase(pointer.scope, pointer.domain).database);
        }
      }
      for (const [file, target] of partitions) {
        const versions = target.prepare("SELECT id,version FROM records WHERE kind=? AND (id=? OR json_extract(payload_json,'$._craft_logical_record_id')=?)")
          .all(kind, id, id);
        for (const row of versions) this.#pendingMemoryDeletes.push({ file, kind, id: String(row.id), logicalId: id, version: Number(row.version) });
      }
      return Number(main.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id).changes);
    });
  }

  private assertCurrentPartitionPointer(pointer: { domain: PartitionDomain; scope: MemoryScope; file: string }): void {
    const current = this.partitionDatabaseFile(pointer.domain, pointer.scope, false);
    if (canonicalCandidatePath(pointer.file) !== canonicalCandidatePath(current)) {
      throw new Error("Legacy partition requires verified storage migration before mutation");
    }
  }

  /** Copy verified legacy rows into the new partition, then switch each central pointer with CAS.
   * A crash before CAS leaves only an unpublished copy; retrying compares the immutable row. */
  async migrateLegacyPartitionVersions(entries: Array<{ kind: string; id: string; version: number }>): Promise<{
    migrated: number; already_current: number; backup_directory: string | null;
  }> {
    if (!entries.length) return { migrated: 0, already_current: 0, backup_directory: null };
    if (entries.length > 500) throw new Error("Legacy partition migration page is too large");
    type Move = { kind: string; id: string; version: number; domain: PartitionDomain; scope: MemoryScope;
      source: string; target: string; physicalId: string; header: string; centralCreatedAt: string; centralUpdatedAt: string;
      row: { payload_json: string; created_at: string; updated_at: string } };
    const moves: Move[] = [];
    let alreadyCurrent = 0;
    const unique = new Set<string>();
    for (const { kind, id, version } of entries) {
      if (!kind || !id || !Number.isSafeInteger(version) || version < 1) throw new Error("Legacy partition identity is invalid");
      const key = JSON.stringify([kind, id, version]);
      if (unique.has(key)) throw new Error("Legacy partition migration page repeats an identity");
      unique.add(key);
      const central = this.database.prepare("SELECT payload_json,created_at,updated_at FROM records WHERE kind=? AND id=? AND version=?")
        .get(kind, id, version) as Move["row"] | undefined;
      if (!central) throw new Error("Legacy partition pointer is missing");
      const pointer = this.partitionPointerFromPayload(JSON.parse(central.payload_json) as JsonObject);
      if (!pointer) throw new Error("Legacy partition pointer is missing");
      const target = this.partitionDatabaseFile(pointer.domain, pointer.scope, false);
      if (canonicalCandidatePath(pointer.file) === canonicalCandidatePath(target)) { alreadyCurrent++; continue; }
      const source = this.memoryDatabaseForRead(pointer.scope, pointer.domain, pointer.file);
      const physicalId = pointer.recordId ?? id;
      const row = source.database.prepare("SELECT payload_json,created_at,updated_at FROM records WHERE kind=? AND id=? AND version=?")
        .get(kind, physicalId, version) as Move["row"] | undefined;
      if (!row) throw new Error("Legacy partition row is missing");
      moves.push({ kind, id, version, domain: pointer.domain, scope: pointer.scope,
        source: source.file, target, physicalId, header: central.payload_json,
        centralCreatedAt: central.created_at, centralUpdatedAt: central.updated_at, row });
    }
    if (!moves.length) return { migrated: 0, already_current: alreadyCurrent, backup_directory: null };
    const migrationRoot = join(this.paths.backupsDir, "storage-migration");
    for (const path of [this.paths.root, this.paths.backupsDir]) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Storage migration backup path must use regular directories");
    }
    try { mkdirSync(migrationRoot, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const migrationRootStat = lstatSync(migrationRoot);
    if (migrationRootStat.isSymbolicLink() || !migrationRootStat.isDirectory()) {
      throw new Error("Storage migration backup path must use regular directories");
    }
    const backupDirectory = join(migrationRoot, `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`);
    mkdirSync(backupDirectory, { mode: 0o700 });
    const sources = new Map<string, DatabaseSync>();
    for (const move of moves) {
      sources.set(move.source, this.memoryDatabaseForRead(move.scope, move.domain, move.source).database);
      sources.set(move.target, this.memoryDatabase(move.scope, move.domain).database);
    }
    const backupManifest: Array<{ source: string; backup: string }> = [];
    for (const [source, database] of sources) {
      const destination = join(backupDirectory, `${backupManifest.length}-${createHash("sha256").update(source).digest("hex").slice(0, 16)}.db`);
      await backup(database, destination);
      const check = new DatabaseSync(destination, { readOnly: true });
      try {
        if (String((check.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check) !== "ok") {
          throw new Error("Legacy partition backup failed integrity check");
        }
      } finally { check.close(); }
      backupManifest.push({ source, backup: destination });
    }
    const manifestPath = join(backupDirectory, "manifest.json");
    const centralRecords = moves.map(move => ({ kind: move.kind, id: move.id, version: move.version,
      payload_json: move.header, created_at: move.centralCreatedAt, updated_at: move.centralUpdatedAt }));
    writeFileSync(`${manifestPath}.tmp`, `${JSON.stringify({ schema: "craft.storage-migration-backup.v1",
      central_database: this.paths.databaseFile, central_records: centralRecords, files: backupManifest })}\n`, { mode: 0o600, flag: "wx" });
    renameSync(`${manifestPath}.tmp`, manifestPath);
    let migrated = 0;
    for (const move of moves) {
      const sourceRow = this.memoryDatabaseForRead(move.scope, move.domain, move.source).database.prepare(
        "SELECT payload_json,created_at,updated_at FROM records WHERE kind=? AND id=? AND version=?",
      ).get(move.kind, move.physicalId, move.version) as Move["row"] | undefined;
      if (!sourceRow || JSON.stringify(sourceRow) !== JSON.stringify(move.row)) {
        throw new Error("Legacy partition source changed concurrently");
      }
      const payload = JSON.parse(move.row.payload_json) as JsonObject;
      const contentRef = payload.content_ref as ContentRef | undefined;
      if (contentRef) {
        const scope = `${move.scope.kind}:${move.scope.id}`;
        payload.content_ref = this.contentStore.relocateSync(contentRef, scope);
      }
      const target = this.memoryDatabase(move.scope, move.domain).database;
      const encoded = JSON.stringify(payload);
      this.transactionOn(target, () => {
        const current = target.prepare("SELECT payload_json FROM records WHERE kind=? AND id=? AND version=?")
          .get(move.kind, move.physicalId, move.version) as { payload_json: string } | undefined;
        if (current && current.payload_json !== encoded) throw new Error("Legacy partition migration target conflicts");
        if (!current) {
          target.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
            .run(move.kind, move.physicalId, move.version, encoded, move.row.created_at, move.row.updated_at);
          this.updateMemoryContentIndex(target, move.kind, move.physicalId, move.version, payload, move.row.updated_at, move.domain);
        }
      });
      const header = JSON.parse(move.header) as JsonObject;
      const pointer = header[`_${move.domain}_partition`] as JsonObject;
      pointer.file = move.target;
      if (payload.content_ref) header.content_ref = payload.content_ref;
      const result = this.database.prepare("UPDATE records SET payload_json=? WHERE kind=? AND id=? AND version=? AND payload_json=?")
        .run(JSON.stringify(header), move.kind, move.id, move.version, move.header);
      if (Number(result.changes) !== 1) {
        const currentRow = this.database.prepare("SELECT payload_json FROM records WHERE kind=? AND id=? AND version=?")
          .get(move.kind, move.id, move.version) as { payload_json: string } | undefined;
        if (!currentRow || currentRow.payload_json !== JSON.stringify(header)) {
          throw new Error("Legacy partition pointer changed concurrently");
        }
        alreadyCurrent++;
      } else migrated++;
    }
    return { migrated, already_current: alreadyCurrent, backup_directory: backupDirectory };
  }

  closeMemoryScope(scope: { kind: string; id: string }): void {
    const file = this.memoryDatabaseFile(scope as MemoryScope, false);
    const files = scope.kind === "session" ? [file,
      ...(isLegacySafeSessionId(scope.id) ? [join("/tmp", ".craft_data", "memory", scope.id, "memory.db"),
        join("/tmp", ".craft_data", "memory", createHash("sha256").update(scope.id).digest("hex").slice(0, 32), "memory.db")] : [])]
      : [file];
    const canonicalFiles = new Set(files.map(canonicalCandidatePath));
    for (const databases of [this.#memoryDatabases, this.#memoryReadDatabases]) {
      for (const [path, database] of databases) {
        if (!canonicalFiles.has(canonicalCandidatePath(path))) continue;
        database.close();
        databases.delete(path);
      }
    }
  }

  appendEvent(stream: string, eventType: string, payload: JsonObject): JsonObject {
    if (stream.startsWith("trace:") && !this.legacyTrace(stream.slice(6)))
      return this.traceShards.appendEvent(stream.slice(6), eventType, payload);
    if (stream.startsWith("evolution:")) {
      const cycleId = stream.slice("evolution:".length), pointer = this.partitionPointer("evolution_cycle", cycleId);
      if (pointer?.domain !== "evolution") throw new Error("Evolution Cycle project partition is unavailable");
      const { database } = this.memoryDatabase(pointer.scope, "evolution");
      return this.transactionOn(database, () => {
        const nextSequence = Number((database.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM events WHERE stream=?")
          .get(stream) as { sequence: number }).sequence);
        const requestedSequence = Number(payload.sequence);
        const sequence = Number.isSafeInteger(requestedSequence) && requestedSequence > 0 ? requestedSequence : nextSequence;
        if (sequence < nextSequence) {
          const existing = database.prepare("SELECT * FROM events WHERE stream=? AND sequence=?").get(stream, sequence) as Record<string, unknown> | undefined;
          if (existing && existing.event_type === eventType && String(existing.payload_json) === JSON.stringify(payload))
            return { stream, sequence, event_type: eventType, payload, created_at: existing.created_at };
          throw new Error("Evolution Cycle event sequence conflicts with an existing event");
        }
        if (sequence !== nextSequence) throw new Error("Evolution Cycle event sequence is stale");
        const created_at = new Date().toISOString();
        database.prepare("INSERT INTO events(stream,sequence,event_type,payload_json,created_at) VALUES(?,?,?,?,?)")
          .run(stream, sequence, eventType, JSON.stringify(payload), created_at);
        return { stream, sequence, event_type: eventType, payload, created_at };
      });
    }
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

  events(stream: string, limit?: number): JsonObject[] {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error("Event limit must be a positive safe integer");
    if (stream.startsWith("trace:") && !this.legacyTrace(stream.slice(6))) return this.traceShards.events(stream.slice(6), limit);
    const cycleId = stream.startsWith("evolution:") ? stream.slice("evolution:".length) : "";
    const pointer = cycleId ? this.partitionPointer("evolution_cycle", cycleId) : null;
    if (cycleId && pointer?.domain !== "evolution") throw new Error("Evolution Cycle project partition is unavailable");
    const source = pointer?.domain === "evolution" ? this.memoryDatabaseForRead(pointer.scope, "evolution", pointer.file).database : this.database;
    return source.prepare(
      "SELECT * FROM events WHERE stream=? ORDER BY sequence LIMIT ?",
    ).all(stream, limit ?? -1).map((row) => {
      const item = row as Record<string, unknown>;
      return { stream: item.stream, sequence: item.sequence, event_type: item.event_type,
        payload: JSON.parse(String(item.payload_json)), created_at: item.created_at };
    });
  }

  /** Atomically remove a trace and its versioned records after archival. */
  removeTraceRecords(traceId: string, eventIds: readonly string[], feedbackIds: readonly string[], telemetryIds: readonly string[] = []): number {
    if (!this.legacyTrace(traceId)) return this.traceShards.remove(traceId, eventIds, feedbackIds, telemetryIds);
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
    const { _craft_logical_record_id: _logicalId, ...payload } = JSON.parse(String(row.payload_json)) as JsonObject;
    const record: JsonObject = { ...payload, id: row.id, version: row.version, created_at: row.created_at, updated_at: row.updated_at };
    const metadata = record.metadata;
    if (row.kind === "evidence" && metadata && typeof metadata === "object" && !Array.isArray(metadata)
      && (metadata as JsonObject).provenance === "codex_session_program_verification"
      && (record.confidence === "confirmed" || record.confidence === "bounded")) {
      record.recorded_confidence = record.confidence;
      record.confidence = "unverified";
    }
    if (hydrate && record.content_ref && (row.kind === "knowledge_claim" || row.kind === "memory_ledger" || row.kind === "episodic_memory" || row.kind === "semantic_memory")) {
      try { record.content = this.contentStore.readCompatSync(record.content_ref as never, typeof record.scope === "string" ? record.scope : undefined).body; }
      catch { record.content_unavailable = true; }
    }
    return record;
  }

  close(): void {
    this.traceShards.close();
    this.codebaseShards.close();
    for (const database of this.#memoryDatabases.values()) database.close();
    for (const database of this.#memoryReadDatabases.values()) database.close();
    this.#memoryDatabases.clear();
    this.#memoryReadDatabases.clear();
    this.#database?.close();
    this.#database = null;
  }
}
