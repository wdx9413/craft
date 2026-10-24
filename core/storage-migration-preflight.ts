import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isAbsolute, join } from "node:path";
import { stableDigest } from "../common/craft-common-base/src/digest.ts";
import { canonicalCandidatePath, parseSessionStorageScopeId, projectStorageDirectory, sessionStorageDirectory, sessionStorageScopeId, type CraftPaths } from "../common/craft-common-store-local/src/paths.ts";

type Scope = { kind: string; id: string };
type Partition = { file: string; scope: Scope };
type LegacyStatus = "current" | "legacy_ready" | "missing_file" | "missing_root" | "ambiguous_root" | "unbound_session" | "pointer_out_of_scope";
type Row = { kind: string; id: string; version: number; payload_json: string };

export interface StoragePreflightEntry {
  kind: string;
  id: string;
  version: number;
  domain: "knowledge" | "memory" | "experience";
  status: LegacyStatus;
  source_file: string;
  target_file: string | null;
  source_size_bytes: number | null;
}

function cursorKey(cursor?: string): [string, string, number] {
  if (cursor === undefined) return ["", "", 0];
  if (!/^[A-Za-z0-9_-]{1,4096}$/u.test(cursor)) throw new Error("Storage preflight cursor is invalid");
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(value) && value.length === 3 && typeof value[0] === "string" && typeof value[1] === "string"
      && Number.isSafeInteger(value[2]) && Number(value[2]) >= 0) return value as [string, string, number];
  } catch { /* invalid cursors are reported below */ }
  throw new Error("Storage preflight cursor is invalid");
}

function regularFileSize(path: string): number | null {
  try {
    const stat = lstatSync(path);
    return stat.isSymbolicLink() || !stat.isFile() ? null : stat.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function projectAliases(database: DatabaseSync): Map<string, string[]> {
  const result = new Map<string, Set<string>>();
  for (const row of database.prepare("SELECT payload_json FROM records WHERE kind='scope_alias'").all() as Array<{ payload_json: string }>) {
    const item = JSON.parse(row.payload_json) as Record<string, unknown>;
    const scope = item.scope as Scope | undefined;
    if (item.status !== "active" || item.alias_kind !== "path" || scope?.kind !== "project"
      || typeof scope.id !== "string" || typeof item.alias !== "string" || item.alias_digest !== stableDigest(item.alias)) continue;
    try {
      const root = realpathSync(item.alias);
      if (!statSync(root).isDirectory()) continue;
      const roots = result.get(scope.id) ?? new Set<string>();
      roots.add(root); result.set(scope.id, roots);
    } catch { /* missing roots remain blocked, never guessed */ }
  }
  for (const row of database.prepare("SELECT id,payload_json FROM records WHERE kind='project_identity'").all() as Array<{ id: string; payload_json: string }>) {
    const item = JSON.parse(row.payload_json) as Record<string, unknown>;
    const canonical = item.canonical_scope as Scope | undefined;
    if (canonical?.kind !== "project" || canonical.id !== row.id || typeof item.local_path_alias !== "string"
      || !isAbsolute(item.local_path_alias)
      || item.identity_digest !== stableDigest({ canonical, project_kind: item.project_kind, remote_digest: item.remote_digest })) continue;
    try {
      const root = realpathSync(item.local_path_alias);
      if (!statSync(root).isDirectory()) continue;
      const roots = result.get(canonical.id) ?? new Set<string>();
      roots.add(root); result.set(canonical.id, roots);
    } catch { /* missing project identities remain unbound */ }
  }
  return new Map([...result].map(([key, roots]) => [key, [...roots].sort()]));
}

function partitionCandidateKinds(database: DatabaseSync): string[] {
  const kinds = database.prepare("SELECT DISTINCT kind FROM records").all() as Array<{ kind: string }>;
  return kinds.map(row => row.kind).filter(kind => /^(?:memory_|experience_|knowledge_|wiki_|workflow_evolution_|episodic_memory$|semantic_memory$|evidence$)/u.test(kind));
}

/** Reusable read-only inventory. Scope aliases and record kinds are loaded once per scan. */
export class StorageMigrationPreflightReader {
  private readonly paths: CraftPaths;
  private readonly database: DatabaseSync;
  private readonly aliases: Map<string, string[]>;
  private readonly kinds: string[];
  private readonly unpartitionedKnowledgeVersions: number;
  private readonly codebaseCheckpointVersions: number;
  private closed = false;

  constructor(paths: CraftPaths) {
    this.paths = paths;
    this.database = new DatabaseSync(paths.databaseFile, { readOnly: true });
    try {
      this.aliases = projectAliases(this.database);
      this.kinds = partitionCandidateKinds(this.database);
      this.unpartitionedKnowledgeVersions = this.count("SELECT COUNT(*) n FROM records WHERE kind='knowledge_claim' AND json_extract(payload_json,'$._knowledge_partition.file') IS NULL");
      this.codebaseCheckpointVersions = this.count("SELECT COUNT(*) n FROM records WHERE kind='workspace_checkpoint'");
    } catch (error) {
      this.database.close();
      this.closed = true;
      throw error;
    }
  }

  private count(sql: string): number {
    return Number((this.database.prepare(sql).get() as { n: number }).n);
  }

  /** Read one bounded page while reusing the scan's scope mapping and connection. */
  readPage(args: { max_records?: number; cursor?: string } = {}): {
    entries: StoragePreflightEntry[]; examined: number; has_more: boolean; next_cursor: string | null;
    unpartitioned_knowledge_versions: number; codebase_checkpoint_versions: number;
  } {
    if (this.closed) throw new Error("Storage preflight reader is closed");
    const limit = args.max_records ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("max_records must be between 1 and 500");
    const after = cursorKey(args.cursor);
    const { paths, database, aliases, kinds } = this;
    const placeholders = kinds.map(() => "?").join(",");
    const rows = kinds.length ? database.prepare(`SELECT kind,id,version,payload_json FROM records
      WHERE kind IN (${placeholders}) AND (json_extract(payload_json,'$._memory_partition.file') IS NOT NULL
        OR json_extract(payload_json,'$._knowledge_partition.file') IS NOT NULL
        OR json_extract(payload_json,'$._experience_partition.file') IS NOT NULL)
        AND (kind>? OR (kind=? AND id>?) OR (kind=? AND id=? AND version>?))
      ORDER BY kind,id,version LIMIT ?`).all(...kinds, after[0], after[0], after[1], after[0], after[1], after[2], limit + 1) as Row[] : [];
    const page = rows.slice(0, limit), entries: StoragePreflightEntry[] = [];
    for (const row of page) {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      const domain = (["memory", "knowledge", "experience"] as const).find(name => payload[`_${name}_partition`] !== undefined)!;
      const partition = payload[`_${domain}_partition`] as Partition;
      const source = partition.file, scope = partition.scope;
      let target: string | null = null, status: LegacyStatus = "pointer_out_of_scope";
      if (typeof source === "string" && scope && typeof scope.id === "string") {
        if (scope.kind === "project") {
          const ids = new Set([scope.id, scope.id.startsWith("project:") ? scope.id : `project:${scope.id}`]);
          const roots = [...new Set([...ids].flatMap(id => aliases.get(id) ?? []))];
          if (!roots.length) status = "missing_root";
          else if (roots.length > 1) status = "ambiguous_root";
          else {
            const root = roots[0]!;
            target = join(projectStorageDirectory(paths, root), domain, `${domain}.db`);
            const legacy = join(root, ".craft_data", domain, `${domain}.db`);
            if (canonicalCandidatePath(source) === canonicalCandidatePath(target)) status = "current";
            else if (canonicalCandidatePath(source) === canonicalCandidatePath(legacy)) status = "legacy_ready";
          }
        } else if (domain === "memory" && scope.kind === "session") {
          const bindingId = `session_storage_${createHash("sha256").update(scope.id).digest("hex")}`;
          const parsedScope = parseSessionStorageScopeId(scope.id);
          let bindingRow = database.prepare("SELECT payload_json FROM records WHERE kind='session_storage_identity' AND id=? ORDER BY version DESC LIMIT 1")
            .get(bindingId) as { payload_json: string } | undefined;
          if (!parsedScope) {
            const boundRows = database.prepare(`SELECT payload_json FROM records AS binding WHERE kind='session_storage_identity'
              AND json_extract(payload_json,'$.session_id')=? AND version=(SELECT MAX(version) FROM records AS latest
                WHERE latest.kind=binding.kind AND latest.id=binding.id)`)
              .all(scope.id) as Array<{ payload_json: string }>;
            if (boundRows.length === 1) bindingRow = boundRows[0];
            else if (boundRows.length > 1) bindingRow = undefined;
          }
          if (!bindingRow) status = "unbound_session";
          else {
            try {
              const binding = JSON.parse(bindingRow.payload_json) as { host?: string; session_id?: string | null; session_digest?: string; scope_id?: string };
              if (typeof binding.host !== "string") throw new Error("Session binding identity mismatch");
              let sessionId: string;
              let targetScopeId: string;
              if (parsedScope) {
                const digestMatches = binding.session_digest === parsedScope.digest
                  && (binding.session_id === null || typeof binding.session_id === "string"
                    && createHash("sha256").update(binding.session_id).digest("hex") === parsedScope.digest);
                if (binding.host !== parsedScope.host || binding.scope_id !== scope.id || !digestMatches) throw new Error("Session binding identity mismatch");
                sessionId = typeof binding.session_id === "string" ? binding.session_id : scope.id;
                targetScopeId = scope.id;
              } else {
                if (binding.session_id !== scope.id) throw new Error("Session binding identity mismatch");
                sessionId = scope.id;
                targetScopeId = typeof binding.scope_id === "string" ? binding.scope_id : sessionStorageScopeId(binding.host, scope.id);
                if (targetScopeId !== sessionStorageScopeId(binding.host, scope.id)) throw new Error("Session binding identity mismatch");
              }
              target = join(sessionStorageDirectory(paths, binding.host, targetScopeId), "memory", "memory.db");
              const old = [join("/tmp", ".craft_data", "memory", sessionId, "memory.db"),
                join("/tmp", ".craft_data", "memory", createHash("sha256").update(sessionId).digest("hex").slice(0, 32), "memory.db")];
              if (canonicalCandidatePath(source) === canonicalCandidatePath(target)) status = "current";
              else if (old.some(path => canonicalCandidatePath(source) === canonicalCandidatePath(path))) status = "legacy_ready";
            } catch { status = "unbound_session"; target = null; }
          }
        } else {
          target = join(paths.root, domain, `${domain}.db`);
          if (canonicalCandidatePath(source) === canonicalCandidatePath(target)) status = "current";
        }
      }
      const size = typeof source === "string" ? regularFileSize(source) : null;
      if ((status === "legacy_ready" || status === "current") && size === null) status = "missing_file";
      entries.push({ kind: row.kind, id: row.id, version: row.version, domain, status,
        source_file: typeof source === "string" ? source : "", target_file: target, source_size_bytes: size });
    }
    const last = page.at(-1);
    const hasMore = rows.length > limit;
    const nextCursor = hasMore && last ? Buffer.from(JSON.stringify([last.kind, last.id, last.version])).toString("base64url") : null;
    return { entries, examined: entries.length, has_more: hasMore, next_cursor: nextCursor,
      unpartitioned_knowledge_versions: this.unpartitionedKnowledgeVersions,
      codebase_checkpoint_versions: this.codebaseCheckpointVersions };
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}

/** Read-only, bounded physical-pointer inventory. It never opens a writable Store. */
export function storageMigrationPreflight(paths: CraftPaths, args: { max_records?: number; cursor?: string } = {}): {
  entries: StoragePreflightEntry[]; examined: number; has_more: boolean; next_cursor: string | null;
  unpartitioned_knowledge_versions: number; codebase_checkpoint_versions: number;
} {
  const reader = new StorageMigrationPreflightReader(paths);
  try { return reader.readPage(args); }
  finally { reader.close(); }
}
