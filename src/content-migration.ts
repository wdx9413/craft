import { readFileSync } from "node:fs";
import { CraftStore, type JsonObject, type RawRecord } from "./store.ts";
import { contentReference, validateContentBody, type ContentKind, type ContentRef } from "./content-store.ts";

const INLINE_KINDS = new Set(["knowledge_claim", "memory_ledger", "episodic_memory", "semantic_memory"]);
const WIKI_KINDS = new Set(["wiki_page"]);

export interface ContentMigrationResult {
  dry_run: boolean;
  scanned: number;
  migrated: number;
  skipped: number;
  backup_path: string | null;
  records: Array<{ kind: string; id: string; version: number; action: "migrate" | "skip" }>;
}

type Pending = { row: RawRecord; body: string; kind: ContentKind };

/** Converts legacy inline bodies and Wiki file paths into the portable
 * Markdown content store. This is intentionally an explicit, repeatable
 * operation; normal writes never mutate historical SQLite payloads. */
export class ContentMigrationKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  status(): JsonObject {
    const rows = this.store.rawRecords();
    const managed = rows.filter((row) => INLINE_KINDS.has(row.kind) || WIKI_KINDS.has(row.kind));
    const inline = managed.filter((row) => typeof row.payload.content === "string" && !row.payload.content_ref).length;
    const referenced = managed.filter((row) => contentReference(row.payload.content_ref)).length;
    return { scanned: managed.length, inline, referenced, pending: inline };
  }

  verify(args: JsonObject = {}): JsonObject {
    const kind = args.kind === undefined ? undefined : String(args.kind);
    const rows = this.store.rawRecords(kind).filter((row) => INLINE_KINDS.has(row.kind) || WIKI_KINDS.has(row.kind));
    const results = rows.map((row) => {
      const ref = row.payload.content_ref;
      if (!contentReference(ref)) return { kind: row.kind, id: row.id, version: row.version, status: "legacy" };
      const verification = this.store.contentStore.verifySync(ref);
      return { kind: row.kind, id: row.id, version: row.version, ...verification };
    });
    return { results, verified: results.filter((item) => item.status === "verified").length,
      failed: results.filter((item) => item.status !== "verified").length };
  }

  migrate(args: JsonObject = {}): ContentMigrationResult {
    const dryRun = args.dry_run === true;
    const rows = this.store.rawRecords().filter((row) => INLINE_KINDS.has(row.kind) || WIKI_KINDS.has(row.kind));
    const pending: Pending[] = [];
    const records: ContentMigrationResult["records"] = [];
    for (const row of rows) {
      const existing = row.payload.content_ref;
      if (contentReference(existing)) {
        // Existing refs are verified rather than silently replaced. Drift is a
        // hard stop because migration must never discard user edits.
        const current = this.store.contentStore.readCompatSync(existing);
        if (this.store.contentStore.isCanonicalRef(existing)) {
          records.push({ kind: row.kind, id: row.id, version: row.version, action: "skip" });
          continue;
        }
        const kind: ContentKind = existing.kind;
        validateContentBody(current.body);
        pending.push({ row, body: current.body, kind });
        records.push({ kind: row.kind, id: row.id, version: row.version, action: "migrate" });
        continue;
      }
      const body = this.bodyFor(row);
      const kind: ContentKind = WIKI_KINDS.has(row.kind) ? "knowledge" : row.kind === "knowledge_claim" ? "knowledge" : "memory";
      validateContentBody(body);
      pending.push({ row, body, kind });
      records.push({ kind: row.kind, id: row.id, version: row.version, action: "migrate" });
    }
    if (dryRun) return { dry_run: true, scanned: rows.length, migrated: pending.length, skipped: rows.length - pending.length, backup_path: null, records };
    if (!pending.length) return { dry_run: false, scanned: rows.length, migrated: 0, skipped: rows.length, backup_path: null, records };
    const backupPath = this.store.backup();
    try {
      const entries = pending.map((plan) => {
        const ref = this.store.contentStore.writeSync({ kind: plan.kind, record_id: plan.row.id, version: plan.row.version,
          scope: this.scopeFor(plan.row), status: this.statusFor(plan.row), sensitivity: "internal", source_id: this.sourceFor(plan.row), body: plan.body });
        const payload: JsonObject = { ...plan.row.payload, content_ref: ref, content_digest: ref.digest, content_storage: "markdown" };
        delete payload.content;
        if (plan.row.kind === "wiki_page") payload.file_path = ref.path;
        return { kind: plan.row.kind, id: plan.row.id, version: plan.row.version, payload };
      });
      this.store.replacePayloadBatch(entries);
    } catch (error) {
      throw new Error(`Content migration rolled back; database backup: ${backupPath}; ${error instanceof Error ? error.message : String(error)}`);
    }
    return { dry_run: false, scanned: rows.length, migrated: pending.length, skipped: rows.length - pending.length, backup_path: backupPath, records };
  }

  private bodyFor(row: RawRecord): string {
    if (typeof row.payload.content === "string" && row.payload.content.trim()) return row.payload.content;
    if (WIKI_KINDS.has(row.kind) && typeof row.payload.file_path === "string" && row.payload.file_path.trim()) {
      const path = row.payload.file_path;
      try { return this.store.contentStore.readUncheckedSync(path).body; }
      catch (error) {
        if (error instanceof Error && /frontmatter/iu.test(error.message)) return readFileSync(path, "utf8");
        throw error;
      }
    }
    throw new Error(`Legacy ${row.kind}/${row.id}/${row.version} has no readable content body`);
  }

  private scopeFor(row: RawRecord): string {
    if (typeof row.payload.scope === "string") return row.payload.scope;
    const kind = row.payload.scope_kind === undefined ? "global" : String(row.payload.scope_kind);
    return row.payload.scope_id === undefined ? kind : `${kind}:${String(row.payload.scope_id)}`;
  }

  private statusFor(row: RawRecord): string {
    return typeof row.payload.status === "string" ? row.payload.status : WIKI_KINDS.has(row.kind) ? "active" : "candidate";
  }

  private sourceFor(row: RawRecord): string {
    return typeof row.payload.source_id === "string" ? row.payload.source_id
      : typeof row.payload.source === "string" ? row.payload.source : "legacy-import";
  }
}
