import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { sessionStorageScopeId, type CraftPaths } from "../common/craft-common-store-local/src/paths.ts";

type Row = { kind: string; id: string; version: number; payload_json: string };
type Cursor = [string, string, number];

/** A single read-only connection detects central database changes between pages. */
export class ContextStoragePreflightReader {
  private readonly database: DatabaseSync;
  private readonly paths: CraftPaths;
  private readonly dataVersion: number;
  private closed = false;
  constructor(paths: CraftPaths) {
    this.paths = paths;
    this.database = new DatabaseSync(paths.databaseFile, { readOnly: true });
    this.dataVersion = this.currentDataVersion();
  }
  private currentDataVersion(): number { return Number((this.database.prepare("PRAGMA data_version").get() as { data_version: number }).data_version); }
  close(): void { if (!this.closed) { this.database.close(); this.closed = true; } }
  readPage(cursor: Cursor = ["", "", 0], limit = 100): {
  records: Array<{ kind: string; id: string; version: number; status: string; source_digest: string }>;
  next_cursor: Cursor | null;
  } {
  if (this.closed) throw new Error("Context preflight reader is closed");
  if (this.currentDataVersion() !== this.dataVersion) throw new Error("Context preflight database changed; restart inventory");
  if (!Array.isArray(cursor) || cursor.length !== 3 || typeof cursor[0] !== "string" || typeof cursor[1] !== "string"
    || !Number.isSafeInteger(cursor[2]) || cursor[2] < 0) throw new Error("Context preflight cursor is invalid");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Context preflight limit must be between 1 and 500");
    const rows = this.database.prepare(`SELECT kind,id,version,payload_json FROM records
      WHERE kind IN ('context_ephemeral_index','context_resume_snapshot')
        AND (kind>? OR (kind=? AND id>?) OR (kind=? AND id=? AND version>?))
      ORDER BY kind,id,version LIMIT ?`).all(cursor[0], cursor[0], cursor[1], cursor[0], cursor[1], cursor[2], limit + 1) as Row[];
    const page = rows.slice(0, limit);
    const records = page.map(row => {
      let status = "unbound";
      try {
        const value = JSON.parse(row.payload_json) as Record<string, unknown>;
        if (typeof value.session_host === "string" && typeof value.session_id === "string" && typeof value.session_scope_id === "string") {
          const scope = sessionStorageScopeId(value.session_host, value.session_id);
          if (scope !== value.session_scope_id) status = "identity_mismatch";
          else if (!value._context_partition) status = "central_ready";
          else {
            const pointer = value._context_partition as { file?: unknown; scope?: { kind?: unknown; id?: unknown } };
            const expected = join(this.paths.root, "sessions", scope, "context", "context.db");
            if (typeof pointer.file !== "string" || resolve(pointer.file) !== resolve(expected)
              || pointer.scope?.kind !== "session" || pointer.scope.id !== scope) status = "pointer_mismatch";
            else status = this.partitionStatus(expected, row, value);
          }
        }
      } catch { status = "invalid"; }
      return { kind: row.kind, id: row.id, version: row.version, status, source_digest: `sha256:${createHash("sha256").update(row.payload_json).digest("hex")}` };
    });
    const last = page.at(-1);
    if (this.currentDataVersion() !== this.dataVersion) throw new Error("Context preflight database changed; restart inventory");
    return { records, next_cursor: rows.length > limit && last ? [last.kind, last.id, last.version] : null };
  }
  private partitionStatus(path: string, row: Row, header: Record<string, unknown>): string {
    try {
      for (const dir of [this.paths.root, join(this.paths.root, "sessions"), join(this.paths.root, "sessions", String(header.session_scope_id)), join(this.paths.root, "sessions", String(header.session_scope_id), "context")]) {
        const stat = lstatSync(dir);
        if (stat.isSymbolicLink() || !stat.isDirectory()) return "partition_unsafe";
      }
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) return "partition_unsafe";
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        const source = database.prepare("SELECT payload_json FROM records WHERE kind=? AND id=? AND version=?").get(row.kind, row.id, row.version) as { payload_json?: string } | undefined;
        if (!source || typeof source.payload_json !== "string") return "partition_row_missing";
        const value = JSON.parse(source.payload_json) as Record<string, unknown>;
        if (value.session_id !== header.session_id || value.session_host !== header.session_host || value.session_scope_id !== header.session_scope_id) return "partition_identity_mismatch";
        if (typeof header.context_payload_digest !== "string") return "partition_digest_missing";
        const digest = `sha256:${createHash("sha256").update(source.payload_json).digest("hex")}`;
        return digest === header.context_payload_digest ? "partition_digest_verified" : "partition_digest_mismatch";
      } finally { database.close(); }
    } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "partition_missing" : "partition_unreadable"; }
  }
}

export function contextStoragePreflight(paths: CraftPaths, cursor: Cursor = ["", "", 0], limit = 100): ReturnType<ContextStoragePreflightReader["readPage"]> {
  const reader = new ContextStoragePreflightReader(paths);
  try { return reader.readPage(cursor, limit); } finally { reader.close(); }
}
