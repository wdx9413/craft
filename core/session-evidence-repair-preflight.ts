import { lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { canonicalCandidatePath, projectStorageDirectory, type CraftPaths } from "../common/craft-common-store-local/src/paths.ts";
import type { JsonObject } from "../common/craft-common-store-local/src/store.ts";
import { projectAliases } from "./storage-migration-preflight.ts";

type PartitionScope = { kind?: string; id?: string };
type PartitionPointer = { scope?: PartitionScope | null; file?: string; record_id?: string };
type EvidenceRecord = JsonObject & {
  _knowledge_partition?: PartitionPointer;
  metadata?: JsonObject;
  confidence?: unknown;
  identity_digest?: unknown;
  source_id?: unknown;
};

/** Read one ID-ordered page without opening a writer or creating Craft files. */
export function preflightSessionEvidencePage(paths: CraftPaths, options: { cursor?: string; limit?: number } = {}) {
  const cursor = options.cursor ?? "", limit = options.limit ?? 100;
  if (typeof cursor !== "string" || cursor.length > 1024 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid repair bounds");
  const primary = new DatabaseSync(paths.databaseFile, { readOnly: true });
  const partitions = new Map<string, DatabaseSync>();
  try {
    const aliases = projectAliases(primary);
    const rows = primary.prepare(`SELECT r.id,r.version,r.payload_json FROM records r JOIN
      (SELECT id,MAX(version) version FROM records WHERE kind='evidence' GROUP BY id) latest
      ON latest.id=r.id AND latest.version=r.version WHERE r.kind='evidence' AND r.id>? ORDER BY r.id LIMIT ?`)
      .all(cursor, limit + 1) as Array<{ id: string; version: number; payload_json: string }>;
    let affected = 0, blocked = 0;
    const page = rows.slice(0, limit);
    for (const row of page) {
      const header = JSON.parse(row.payload_json) as EvidenceRecord;
      const pointer = header._knowledge_partition;
      let payload: EvidenceRecord = header;
      if (pointer) {
        const scope = pointer.scope, scopeId = typeof scope?.id === "string" && !scope.id.startsWith("project:") ? `project:${scope.id}` : scope?.id;
        const roots = typeof scopeId === "string" ? aliases.get(scopeId) ?? [] : [];
        if (scope?.kind !== "project" || roots.length !== 1 || typeof pointer.file !== "string") { blocked++; continue; }
        const expected = join(projectStorageDirectory(paths, roots[0]!), "knowledge", "knowledge.db");
        if (canonicalCandidatePath(pointer.file) !== canonicalCandidatePath(expected)) { blocked++; continue; }
        try {
          const st = lstatSync(pointer.file);
          if (st.isSymbolicLink() || !st.isFile()) { blocked++; continue; }
          let db = partitions.get(pointer.file);
          if (!db) { db = new DatabaseSync(pointer.file, { readOnly: true }); partitions.set(pointer.file, db); }
          const item = db.prepare("SELECT payload_json FROM records WHERE kind='evidence' AND id=? AND version=?")
            .get(pointer.record_id ?? row.id, row.version) as { payload_json: string } | undefined;
          if (!item) { blocked++; continue; }
          payload = JSON.parse(item.payload_json) as EvidenceRecord;
          if (payload.metadata?.provenance === "codex_session_program_verification" && payload.metadata?.scope !== scopeId) { blocked++; continue; }
        } catch { blocked++; continue; }
      }
      if (payload.metadata?.provenance !== "codex_session_program_verification" || !["confirmed", "bounded"].includes(String(payload.confidence))) continue;
      affected++;
      const scope = payload.metadata?.scope, roots = typeof scope === "string" ? aliases.get(scope) ?? [] : [];
      if (!/^project:[A-Za-z0-9_-]{1,96}$/u.test(String(scope)) || payload.metadata?.project_scope_id !== scope
        || typeof payload.identity_digest !== "string" || roots.length !== 1) { blocked++; continue; }
      if (typeof payload.source_id === "string") {
        const parent = primary.prepare("SELECT payload_json FROM records WHERE kind='knowledge_source' AND id=? ORDER BY version DESC LIMIT 1")
          .get(payload.source_id) as { payload_json: string } | undefined;
        if (!parent) { blocked++; continue; }
        const parentScope = (JSON.parse(parent.payload_json) as EvidenceRecord)._knowledge_partition?.scope;
        if (parentScope?.kind === "project" && String(parentScope.id).replace(/^project:/u, "") !== String(scope).slice("project:".length)) { blocked++; continue; }
      }
    }
    return { scanned: page.length, affected, blocked, has_more: rows.length > limit,
      next_cursor: rows.length > limit ? page.at(-1)!.id : null, dry_run: true };
  } finally { for (const db of partitions.values()) db.close(); primary.close(); }
}
