import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { CraftStore, type JsonObject, type RawRecord } from "./store.ts";
import { contentReference, contentTitle, validateContentBody, type ContentKind, type ContentRef } from "./content-store.ts";

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

export interface LegacySourceRehydrateResult {
  dry_run: boolean;
  migration_id: string;
  scanned: number;
  eligible: number;
  migrated: number;
  skipped: number;
  backup_path: string | null;
  records: Array<{ candidate_id: string; claim_id: string; source_locator: string; action: "migrate" | "skip" }>;
}

type Pending = { row: RawRecord; body: string; kind: ContentKind; title: string };
type SourcePending = { row: RawRecord; body: string; ref: ContentRef; candidateId: string; locator: string; title: string };

function digest(value: string): string { return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`; }

function legacyBody(raw: string): string {
  const lines = raw.split(/\r?\n/u);
  if (lines[0] !== "---") return raw.trim();
  const end = lines.slice(1).findIndex((line) => line === "---");
  if (end < 0) throw new Error("Legacy source frontmatter is not closed");
  const body = lines.slice(end + 2).join("\n").trim();
  validateContentBody(body);
  return body;
}

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
        pending.push({ row, body: current.body, kind, title: this.titleFor(row, current.body) });
        records.push({ kind: row.kind, id: row.id, version: row.version, action: "migrate" });
        continue;
      }
      const body = this.bodyFor(row);
      const kind: ContentKind = WIKI_KINDS.has(row.kind) ? "knowledge" : row.kind === "knowledge_claim" ? "knowledge" : "memory";
      validateContentBody(body);
      pending.push({ row, body, kind, title: this.titleFor(row, body) });
      records.push({ kind: row.kind, id: row.id, version: row.version, action: "migrate" });
    }
    if (dryRun) return { dry_run: true, scanned: rows.length, migrated: pending.length, skipped: rows.length - pending.length, backup_path: null, records };
    if (!pending.length) return { dry_run: false, scanned: rows.length, migrated: 0, skipped: rows.length, backup_path: null, records };
    const backupPath = this.store.backup();
    try {
      const entries = pending.map((plan) => {
        const ref = this.store.contentStore.writeSync({ kind: plan.kind, record_id: plan.row.id, version: plan.row.version,
          scope: this.scopeFor(plan.row), status: this.statusFor(plan.row), sensitivity: "internal", source_id: this.sourceFor(plan.row), title: plan.title, body: plan.body });
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

  /** Rehydrates imported Claim bodies from their digest-pinned source pages.
   * The ordinary migration only moves the SQLite payload. This second,
   * explicit step restores the original page body without changing Claim
   * identity, version, status, evidence, or source metadata. */
  rehydrateLegacy(args: JsonObject = {}): LegacySourceRehydrateResult {
    const migrationId = String(args.migration_id ?? "").trim();
    if (!migrationId) throw new Error("migration_id must not be empty");
    const migration = this.store.get("legacy_knowledge_migration", migrationId);
    const sourceRoot = realpathSync(resolve(String(args.source_root ?? migration.source_root)));
    const migrationRows = this.store.rawRecords("legacy_knowledge_migration_candidate")
      .filter((row) => row.payload.migration_id === migrationId && row.payload.status === "candidate" && typeof row.payload.claim_id === "string" && String(row.payload.claim_id).trim());
    const latestClaims = new Map<string, RawRecord>();
    for (const row of this.store.rawRecords("knowledge_claim")) {
      const current = latestClaims.get(row.id);
      if (!current || row.version > current.version) latestClaims.set(row.id, row);
    }
    const pending: SourcePending[] = [];
    const records: LegacySourceRehydrateResult["records"] = [];
    for (const candidate of migrationRows) {
      const claimId = String(candidate.payload.claim_id).trim();
      const locator = String(candidate.payload.source_locator ?? "").trim();
      const claim = latestClaims.get(claimId);
      if (!claim || !contentReference(claim.payload.content_ref)) throw new Error(`Legacy source rehydrate claim reference is missing: ${claimId}`);
      if (!locator) throw new Error(`Legacy source locator is missing: ${candidate.id}`);
      const sourcePath = resolve(sourceRoot, locator);
      const relativePath = relative(sourceRoot, sourcePath);
      if (!relativePath || relativePath.startsWith("..")) throw new Error(`Legacy source locator escapes source root: ${locator}`);
      const resolvedPath = realpathSync(sourcePath);
      const resolvedRelative = relative(sourceRoot, resolvedPath);
      if (!resolvedRelative || resolvedRelative.startsWith("..")) throw new Error(`Legacy source path escapes source root: ${locator}`);
      const raw = readFileSync(resolvedPath, "utf8");
      const sourceDigest = String(candidate.payload.source_digest ?? "");
      if (!sourceDigest || digest(raw) !== sourceDigest) throw new Error(`Legacy source digest drifted: ${locator}`);
      const body = legacyBody(raw);
      const ref = claim.payload.content_ref as ContentRef;
      const title = this.titleFor(candidate, body, claim);
      const namedPath = this.store.contentStore.namedPathFor("knowledge", claim.id, claim.version, title);
      if (digest(body) === ref.digest && resolve(ref.path) === resolve(namedPath)) records.push({ candidate_id: candidate.id, claim_id: claimId, source_locator: locator, action: "skip" });
      else {
        pending.push({ row: claim, body, ref, candidateId: candidate.id, locator, title });
        records.push({ candidate_id: candidate.id, claim_id: claimId, source_locator: locator, action: "migrate" });
      }
    }
    const result = { dry_run: args.dry_run === true, migration_id: migrationId, scanned: migrationRows.length,
      eligible: migrationRows.length, migrated: pending.length, skipped: migrationRows.length - pending.length, backup_path: null as string | null, records };
    if (result.dry_run || !pending.length) return result;
    const backupPath = this.store.backup();
    try {
      const entries = pending.map((item) => {
        const next = this.store.contentStore.rewriteSync({ kind: "knowledge", record_id: item.row.id, version: item.row.version,
          scope: this.scopeFor(item.row), status: this.statusFor(item.row), sensitivity: "internal", source_id: this.sourceFor(item.row), title: item.title, current_path: item.ref.path, body: item.body });
        return { kind: item.row.kind, id: item.row.id, version: item.row.version,
          payload: { ...item.row.payload, content_ref: next, content_digest: next.digest, content_storage: "markdown" } };
      });
      this.store.replacePayloadBatch(entries);
    } catch (error) {
      throw new Error(`Legacy source rehydrate rolled back; database backup: ${backupPath}; ${error instanceof Error ? error.message : String(error)}`);
    }
    return { ...result, backup_path: backupPath };
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

  private titleFor(row: RawRecord, body: string, fallback?: RawRecord): string {
    const candidate = row.payload.title ?? row.payload.name ?? fallback?.payload.title ?? fallback?.payload.name;
    return contentTitle(body, typeof candidate === "string" ? candidate : undefined, row.id);
  }
}
