import { lstatSync, realpathSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { canonicalCandidatePath, projectStorageDirectory, type CraftPaths } from "../common/craft-common-store-local/src/paths.ts";

export type CodebaseMigrationStatus = "current" | "legacy_ready" | "missing_root" | "ambiguous_root"
  | "missing_workspace" | "invalid_checkpoint" | "source_out_of_scope" | "missing_snapshot";
export interface CodebaseMigrationEntry {
  id: string; version: number; status: CodebaseMigrationStatus; workspace_id: string;
  source_root: string; target_root: string | null; entry_count: number;
}

function cursorVersion(cursor?: string): [string, number] {
  if (cursor === undefined) return ["", 0];
  if (!/^[A-Za-z0-9_-]{1,4096}$/u.test(cursor)) throw new Error("Codebase migration cursor is invalid");
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string"
      && Number.isSafeInteger(value[1]) && Number(value[1]) >= 0) return value as [string, number];
  } catch { /* invalid cursor reported below */ }
  throw new Error("Codebase migration cursor is invalid");
}

function workspaceRoots(database: DatabaseSync, workspaceIds: string[]): Map<string, string[]> {
  const mapped = new Map<string, Set<string>>();
  if (!workspaceIds.length) return new Map();
  const placeholders = workspaceIds.map(() => "?").join(",");
  for (const row of database.prepare(`SELECT id,payload_json FROM records WHERE kind='workspace' AND id IN (${placeholders})`).all(...workspaceIds) as Array<{ id: string; payload_json: string }>) {
    let payload: Record<string, unknown>;
    try { const value: unknown = JSON.parse(row.payload_json);
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      payload = value as Record<string, unknown>;
    } catch { continue; }
    if (!Number.isSafeInteger(payload.state_revision)) continue;
    const key = JSON.stringify([row.id, payload.state_revision]);
    const roots = mapped.get(key) ?? new Set<string>();
    roots.add(typeof payload.root_path === "string" ? payload.root_path : ""); mapped.set(key, roots);
  }
  return new Map([...mapped].map(([key, roots]) => [key, [...roots]]));
}

/** Read-only, keyset-paged inventory. A checkpoint root is taken only from its matching Workspace state revision. */
export function codebaseStoragePreflight(paths: CraftPaths, args: { max_records?: number; cursor?: string } = {}): {
  entries: CodebaseMigrationEntry[]; examined: number; has_more: boolean; next_cursor: string | null;
} {
  const limit = args.max_records ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("max_records must be between 1 and 500");
  const after = cursorVersion(args.cursor);
  const database = new DatabaseSync(paths.databaseFile, { readOnly: true });
  try {
    // Bind the checkpoint page and its Workspace revisions to one read snapshot.
    database.exec("BEGIN");
    const rows = database.prepare(`SELECT id,version,payload_json FROM records WHERE kind='workspace_checkpoint'
      AND (id>? OR (id=? AND version>?)) ORDER BY id,version LIMIT ?`)
      .all(after[0], after[0], after[1], limit + 1) as Array<{ id: string; version: number; payload_json: string }>;
    const page = rows.slice(0, limit);
    const workspaceIds = [...new Set(page.flatMap(row => {
      try { const value: unknown = JSON.parse(row.payload_json); return value && typeof value === "object" && !Array.isArray(value)
        && typeof (value as Record<string, unknown>).workspace_id === "string" ? [String((value as Record<string, unknown>).workspace_id)] : []; }
      catch { return []; }
    }))];
    const roots = workspaceRoots(database, workspaceIds);
    database.exec("COMMIT");
    const entries = page.map(row => {
      let payload: Record<string, unknown>;
      try { const value: unknown = JSON.parse(row.payload_json);
        payload = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
      catch { payload = {}; }
      const workspaceId = typeof payload.workspace_id === "string" ? payload.workspace_id : "";
      const source = typeof payload.snapshot_root === "string" ? payload.snapshot_root : "";
      const sources = roots.get(JSON.stringify([workspaceId, payload.state_revision]));
      const entryCount = Array.isArray(payload.entries) ? payload.entries.length : 0;
      const base = { id: row.id, version: row.version, workspace_id: workspaceId,
        source_root: source, target_root: null, entry_count: entryCount };
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(row.id) || !Number.isSafeInteger(row.version) || row.version < 1
        || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(workspaceId) || !source
        || !Array.isArray(payload.entries) || !Number.isSafeInteger(payload.state_revision)) {
        return { ...base, status: "invalid_checkpoint" as const };
      }
      if (!sources) return { ...base, status: "missing_workspace" as const };
      let unavailable = false;
      const existing = [...new Set(sources.flatMap(root => {
        try { const real = realpathSync(root); if (statSync(real).isDirectory()) return [real]; unavailable = true; return []; }
        catch { unavailable = true; return []; }
      }))];
      if (!existing.length) return { ...base, status: "missing_root" as const };
      if (existing.length > 1 || unavailable) return { ...base, status: "ambiguous_root" as const };
      const root = existing[0]!;
      const target = join(projectStorageDirectory(paths, root), "codebase", "snapshots", workspaceId, row.id);
      const candidates = [target, join(root, ".craft_data", "codebase", "snapshots", workspaceId, row.id),
        join(root, ".craft_data", "codebase", "runtime", "workspaces", workspaceId, "snapshots", row.id),
        join(paths.runtimeDir, "workspaces", workspaceId, "snapshots", row.id)];
      let position: number;
      try { position = candidates.findIndex(path => canonicalCandidatePath(path) === canonicalCandidatePath(source)); }
      catch { position = -1; }
      if (position < 0) return { ...base, target_root: target, status: "source_out_of_scope" as const };
      try {
        const stat = lstatSync(source);
        if (stat.isSymbolicLink() || !stat.isDirectory()) return { ...base, target_root: target, status: "missing_snapshot" as const };
      } catch { return { ...base, target_root: target, status: "missing_snapshot" as const }; }
      return { ...base, target_root: target, status: position === 0 ? "current" as const : "legacy_ready" as const };
    });
    const last = page.at(-1), hasMore = rows.length > limit;
    return { entries, examined: entries.length, has_more: hasMore,
      next_cursor: hasMore && last ? Buffer.from(JSON.stringify([last.id, last.version])).toString("base64url") : null };
  } finally { database.close(); }
}

/** Detect concurrent commits across pages without retaining a long-lived read transaction. */
export class CodebaseStoragePreflightReader {
  private readonly database: DatabaseSync;
  private readonly dataVersion: number;
  private readonly paths: CraftPaths;
  constructor(paths: CraftPaths) {
    this.paths = paths;
    this.database = new DatabaseSync(paths.databaseFile, { readOnly: true });
    try { this.dataVersion = this.version(); }
    catch (error) { this.database.close(); throw error; }
  }
  private version(): number {
    return Number((this.database.prepare("PRAGMA data_version").get() as { data_version: number }).data_version);
  }
  readPage(args: { max_records?: number; cursor?: string } = {}): ReturnType<typeof codebaseStoragePreflight> {
    if (this.version() !== this.dataVersion) throw new Error("Codebase preflight database changed; restart inventory");
    const page = codebaseStoragePreflight(this.paths, args);
    if (this.version() !== this.dataVersion) throw new Error("Codebase preflight database changed; restart inventory");
    return page;
  }
  close(): void { this.database.close(); }
}
