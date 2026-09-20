import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { JsonObject } from "./infrastructure/store.ts";
import { CraftStore } from "./infrastructure/store.ts";

const CATEGORIES = new Set(["projects", "domains", "troubleshooting", "decisions", "workflows"]);
const TYPES = new Map<string, string>([["domain_rule", "fact"], ["technical_decision", "decision"], ["workflow", "rule"], ["troubleshooting", "failure_mode"], ["stable_project_fact", "fact"]]);
const SECRET = /(?:password|passwd|token|secret|api[_-]?key|cookie|authorization)\s*[:=]\s*\S{8,}/i;
const FORBIDDEN = /个人述职|述职|\bddo\b|\bokr\b|绩效|个人能力|能力成长|个人总结|周报|月报|季度总结|上半年总结|下半年计划|阶段进展|项目进展|会议纪要|会议记录|文案润色|翻译润色/i;
const MAX_FILES = 10_000;
const MAX_BYTES = 256 * 1024;

type Entry = JsonObject & { rel_path: string; page_digest: string; title: string; summary: string; eligibility: string; reason: string | null; category: string; knowledge_type: string; scope: string; project: string | null; tags: string[]; evidence_type: string | null };
type CandidateHandler = (entry: Entry, migration: JsonObject, sourceId: string, candidateId: string) => { evidence_id: string; claim_id: string };
type ModelAssessment = { candidate_id: string; source_digest: string; decision: "supported" | "revalidate" | "reject"; reason: string };

function digest(value: unknown): string { return `sha256:${createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")}`; }
function id(prefix: string): string { return `${prefix}_${randomUUID().replaceAll("-", "")}`; }
function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function payload(record: JsonObject): JsonObject { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
function safe(value: string): boolean { return !SECRET.test(value) && !FORBIDDEN.test(value); }
function frontmatter(content: string): { metadata: Record<string, string>; body: string } {
  const lines = content.split(/\r?\n/); if (lines[0] !== "---") return { metadata: {}, body: content };
  const end = lines.slice(1).findIndex((line) => line === "---"); if (end < 0) throw new Error("frontmatter is not closed");
  const metadata: Record<string, string> = {};
  for (const line of lines.slice(1, end + 1)) { const at = line.indexOf(":"); if (at > 0) metadata[line.slice(0, at).trim()] = line.slice(at + 1).trim(); }
  return { metadata, body: lines.slice(end + 2).join("\n") };
}
function heading(body: string, fallback: string): string { return body.split(/\r?\n/).find((line) => line.startsWith("# "))?.slice(2).trim() || fallback; }
function tags(value: string | undefined): string[] { return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : []; }
function candidateId(migrationId: string, entry: Entry): string { return `legacy_knowledge_candidate_${createHash("sha256").update(`${migrationId}:${entry.rel_path}:${entry.page_digest}`).digest("hex").slice(0, 24)}`; }

export class LegacyKnowledgeMigrationKernel {
  readonly store: CraftStore;

  constructor(store: CraftStore) { this.store = store; }

  sourceSnapshot(args: JsonObject): JsonObject { return { migration: this.store.get("legacy_knowledge_migration", text(args.migration_id, "migration_id")), content_free: true }; }
  async sourceDiff(args: JsonObject): Promise<JsonObject> {
    const migration = this.store.get("legacy_knowledge_migration", text(args.migration_id, "migration_id"));
    const sourceRoot = text(args.source_root ?? migration.source_root, "source_root");
    const latest = await this.discover({ migration_id: `${String(migration.id)}_diff_${Date.now()}`, source_root: sourceRoot });
    const next = latest.migration as JsonObject; const before = new Map((migration.entries as JsonObject[]).map((x) => [String(x.rel_path), x])); const after = new Map((next.entries as JsonObject[]).map((x) => [String(x.rel_path), x]));
    const changed: JsonObject[] = []; const tombstones: string[] = [];
    for (const [path, entry] of after) if (before.get(path)?.page_digest !== entry.page_digest) changed.push({ rel_path: path, previous_digest: before.get(path)?.page_digest ?? null, current_digest: entry.page_digest, eligibility: entry.eligibility });
    for (const path of before.keys()) if (!after.has(path)) tombstones.push(path);
    const drifted = changed.length > 0 || tombstones.length > 0; const saved = drifted ? this.store.save("legacy_knowledge_migration", String(migration.id), { ...payload(migration), status: "stale", latest_source_digest: next.source_digest, drift_count: changed.length + tombstones.length }) : migration;
    return { migration_id: migration.id, previous_digest: migration.source_digest, current_digest: next.source_digest, changed: drifted, entries: changed, tombstones, migration: saved, content_free: true };
  }

  async discover(args: JsonObject): Promise<JsonObject> {
    const sourceRoot = await realpath(resolve(text(args.source_root, "source_root")));
    const pagesRoot = resolve(sourceRoot, "data", "pages");
    const root = await realpath(pagesRoot).catch(() => { throw new Error("source_root must contain data/pages"); });
    if (relative(sourceRoot, root).startsWith("..")) throw new Error("data/pages escapes source_root");
    const files = await this.markdownFiles(root); const entries: Entry[] = [];
    for (const file of files) entries.push(await this.entry(sourceRoot, root, file));
    const manifest = entries.map(({ rel_path, page_digest, eligibility, reason }) => ({ rel_path, page_digest, eligibility, reason })).sort((a, b) => a.rel_path.localeCompare(b.rel_path));
    const migrationId = String(args.migration_id ?? `legacy_knowledge_migration_${digest({ sourceRoot, manifest }).slice(-24)}`);
    const identity = { source_root: sourceRoot, source_digest: digest(manifest), entries, policy: "confirmed-only; no-drafts; no-raw-body; no-sensitive-content" };
    const existing = this.store.find("legacy_knowledge_migration", migrationId);
    if (existing) { if (existing.identity_digest !== digest(identity)) throw new Error("Legacy knowledge discovery idempotency conflict"); return { migration: existing, idempotent: true }; }
    const migration = this.store.create("legacy_knowledge_migration", migrationId, { ...identity, identity_digest: digest(identity), status: "discovered" });
    return { migration, idempotent: false };
  }

  async importCandidates(args: JsonObject, sourceId: string, create: CandidateHandler): Promise<JsonObject> {
    const migration = this.store.get("legacy_knowledge_migration", text(args.migration_id, "migration_id"));
    const selected = Array.isArray(args.candidate_ids) ? args.candidate_ids.map((item) => text(item, "candidate_ids item")) : [];
    if (!selected.length) throw new Error("candidate_ids must be a non-empty array");
    const entries = migration.entries as Entry[]; const failures: JsonObject[] = []; const candidates: JsonObject[] = [];
    for (const relPath of selected) {
      const entry = entries.find((item) => item.rel_path === relPath);
      if (!entry) { failures.push(this.failure(String(migration.id), "import", relPath, "unknown_candidate")); continue; }
      if (entry.eligibility !== "eligible") { failures.push(this.failure(String(migration.id), "import", relPath, `excluded_${entry.reason ?? "policy"}`)); continue; }
      const sourceState = await this.sourceState(String(migration.source_root), entry);
      if (sourceState !== "current") { failures.push(this.failure(String(migration.id), "import", relPath, sourceState)); continue; }
      const candidate_id = candidateId(String(migration.id), entry); const existing = this.store.find("legacy_knowledge_migration_candidate", candidate_id);
      if (existing) { candidates.push({ ...existing, idempotent: true }); continue; }
      const duplicate = this.store.list("legacy_knowledge_migration_candidate", MAX_FILES, (item) => item.canonical_key === this.canonicalKey(entry) && item.status !== "retracted")[0];
      if (duplicate) { candidates.push(this.store.create("legacy_knowledge_migration_candidate", candidate_id, { migration_id: migration.id, source_id: sourceId, source_locator: entry.rel_path, source_digest: entry.page_digest, canonical_key: this.canonicalKey(entry), title: entry.title, summary: entry.summary, category: entry.category, knowledge_type: entry.knowledge_type, scope: entry.scope, project: entry.project, tags: entry.tags, status: "duplicate", duplicate_of: duplicate.id, evidence_id: null, claim_id: null, memory_id: null, wiki_page_id: null, import_authority: false })); continue; }
      try {
        const refs = create(entry, migration, sourceId, candidate_id);
        candidates.push(this.store.create("legacy_knowledge_migration_candidate", candidate_id, { migration_id: migration.id, source_id: sourceId, source_locator: entry.rel_path, source_digest: entry.page_digest, canonical_key: this.canonicalKey(entry), title: entry.title, summary: entry.summary, category: entry.category, knowledge_type: entry.knowledge_type, scope: entry.scope, project: entry.project, tags: entry.tags, status: "candidate", duplicate_of: null, evidence_id: refs.evidence_id, claim_id: refs.claim_id, memory_id: null, wiki_page_id: null, import_authority: false }));
      } catch (error) { failures.push(this.failure(String(migration.id), "import", relPath, error instanceof Error ? error.message : "candidate_import_failed")); }
    }
    return { candidates, failures, report_id: failures.length ? this.report(String(migration.id), "import", failures) : null };
  }

  /**
   * Repair provenance omitted by an older candidate-only import.
   *
   * It never changes a Claim's status, body, Evidence confidence, or Source trust.
   * It only reconnects an existing Claim to the immutable Source descriptor already
   * pinned by its migration Candidate, after proving the local page still has the
   * captured digest.  That lets the normal evidence review distinguish
   * "source is known but not revalidated" from "source is unknown".
   */
  async rebindProvenance(args: JsonObject): Promise<JsonObject> {
    const migration = this.store.get("legacy_knowledge_migration", text(args.migration_id, "migration_id"));
    const requested = args.candidate_ids === undefined ? null : new Set(
      Array.isArray(args.candidate_ids) && args.candidate_ids.length
        ? args.candidate_ids.map((item) => text(item, "candidate_ids item"))
        : (() => { throw new Error("candidate_ids must be a non-empty array"); })(),
    );
    const candidates = this.store.list("legacy_knowledge_migration_candidate", MAX_FILES,
      (candidate) => candidate.migration_id === migration.id && (requested === null || requested.has(String(candidate.id))));
    const rebound: JsonObject[] = []; const unchanged: JsonObject[] = []; const failures: JsonObject[] = [];
    for (const candidate of candidates) {
      if (candidate.status !== "candidate" || !candidate.claim_id || !candidate.source_id) {
        unchanged.push({ candidate_id: candidate.id, reason: "candidate_not_rebindable" }); continue;
      }
      const entry = (migration.entries as Entry[]).find((item) => item.rel_path === candidate.source_locator);
      if (!entry) { failures.push(this.failure(String(migration.id), "rebind_provenance", String(candidate.source_locator ?? candidate.id), "source_entry_missing")); continue; }
      const state = await this.sourceState(String(migration.source_root), entry);
      if (state !== "current") { failures.push(this.failure(String(migration.id), "rebind_provenance", entry.rel_path, state)); continue; }
      const source = this.store.find("knowledge_source", String(candidate.source_id));
      if (!source || source.status !== "active" || source.trust === "untrusted") { failures.push(this.failure(String(migration.id), "rebind_provenance", entry.rel_path, "source_unavailable")); continue; }
      const claim = this.store.find("knowledge_claim", String(candidate.claim_id));
      if (!claim) { failures.push(this.failure(String(migration.id), "rebind_provenance", entry.rel_path, "claim_missing")); continue; }
      if (claim.source_id === candidate.source_id && claim.source_page_digest === candidate.source_digest) {
        unchanged.push({ candidate_id: candidate.id, claim_id: claim.id, reason: "already_bound" }); continue;
      }
      const saved = this.store.save("knowledge_claim", String(claim.id), { ...payload(claim), source_id: candidate.source_id,
        source_locator: candidate.source_locator, source_page_digest: candidate.source_digest,
        provenance_rebound_at: new Date().toISOString(), provenance_rebound_by: "offline-migration-rebind" });
      rebound.push({ candidate_id: candidate.id, claim_id: saved.id, claim_version: saved.version, source_id: saved.source_id, source_page_digest: saved.source_page_digest });
    }
    return { migration_id: migration.id, rebound, unchanged, failures, report_id: failures.length ? this.report(String(migration.id), "rebind_provenance", failures) : null, content_free: true };
  }

  /**
   * Apply a Host model's bounded content review to imported candidates.
   *
   * The model is allowed to judge whether the immutable page is coherent and
   * useful enough to enter Context as historical, bounded knowledge.  It is not
   * allowed to turn that page into confirmed live-system truth.  A supported
   * assessment therefore creates bounded Evidence, restores the complete
   * sanitised page body, and moves the Claim to `reviewed`; an uncertain or
   * negative assessment only records the decision.
   */
  async reviewCandidates(args: JsonObject): Promise<JsonObject> {
    const migration = this.store.get("legacy_knowledge_migration", text(args.migration_id, "migration_id"));
    const reviewer = text(args.reviewer, "reviewer"); const modelRef = text(args.model_ref, "model_ref");
    if (!Array.isArray(args.assessments) || !args.assessments.length) throw new Error("assessments must be a non-empty array");
    const assessments = (args.assessments as JsonObject[]).map((value): ModelAssessment => {
      const decision = text(value.decision, "assessment decision") as ModelAssessment["decision"];
      if (!new Set(["supported", "revalidate", "reject"]).has(decision)) throw new Error("assessment decision is unsupported");
      return { candidate_id: text(value.candidate_id, "assessment candidate_id"), source_digest: text(value.source_digest, "assessment source_digest"), decision, reason: text(value.reason, "assessment reason") };
    });
    if (new Set(assessments.map((item) => item.candidate_id)).size !== assessments.length) throw new Error("assessment candidate_ids must be unique");
    const reviewed: JsonObject[] = []; const deferred: JsonObject[] = []; const failures: JsonObject[] = [];
    for (const assessment of assessments) {
      const candidate = this.store.find("legacy_knowledge_migration_candidate", assessment.candidate_id);
      if (!candidate || candidate.migration_id !== migration.id || candidate.status !== "candidate" || !candidate.claim_id) {
        failures.push({ candidate_id: assessment.candidate_id, code: "candidate_not_reviewable" }); continue;
      }
      if (candidate.source_digest !== assessment.source_digest) {
        failures.push({ candidate_id: candidate.id, code: "assessment_source_digest_mismatch" }); continue;
      }
      const entry = (migration.entries as Entry[]).find((item) => item.rel_path === candidate.source_locator);
      if (!entry) { failures.push({ candidate_id: candidate.id, code: "source_entry_missing" }); continue; }
      const page = await this.readSourcePage(String(migration.source_root), entry);
      if (!page) { failures.push({ candidate_id: candidate.id, code: "source_unavailable_or_drifted" }); continue; }
      const reviewIdentity = { candidate_id: candidate.id, claim_id: candidate.claim_id, source_digest: candidate.source_digest, decision: assessment.decision, reviewer, model_ref: modelRef, reason_digest: digest(assessment.reason), policy: "bounded_model_source_review_v1" };
      const reviewId = `knowledge_model_review_${digest(reviewIdentity).slice(-24)}`;
      const prior = this.store.find("knowledge_model_review", reviewId);
      const review = prior ?? this.store.create("knowledge_model_review", reviewId, { ...reviewIdentity, automated: true, reviewed_at: new Date().toISOString(), content_free: true });
      if (assessment.decision !== "supported") { deferred.push({ candidate_id: candidate.id, decision: assessment.decision, review_id: review.id }); continue; }
      const claim = this.store.get("knowledge_claim", String(candidate.claim_id));
      const reviewedScope = candidate.scope === "shared" ? "global"
        : candidate.project ? `project:${String(candidate.project)}` : "project:unbound";
      if (claim.status === "reviewed" && claim.scope === reviewedScope) { reviewed.push({ candidate_id: candidate.id, claim_id: claim.id, review_id: review.id, idempotent: true }); continue; }
      if (!new Set(["candidate", "reviewed"]).has(String(claim.status))) { failures.push({ candidate_id: candidate.id, code: "claim_not_candidate" }); continue; }
      const evidenceId = `evidence_${reviewId}`;
      const evidence = this.store.find("evidence", evidenceId) ?? this.store.create("evidence", evidenceId, {
        source_type: "model_source_review", confidence: "bounded",
        claim: "Immutable source page was reviewed for coherent historical reuse; live-system validity was not asserted.",
        locator: String(page.metadata.evidence_ref), observed_at: new Date().toISOString(),
        metadata: { source_id: candidate.source_id, source_locator: candidate.source_locator, source_digest: candidate.source_digest, review_id: review.id, reviewer, model_ref: modelRef },
      });
      const nextVersion = Number(claim.version) + 1;
      const contentRef = this.store.contentStore.writeSync({ kind: "knowledge", record_id: String(claim.id), version: nextVersion,
        scope: reviewedScope, status: "reviewed", sensitivity: "internal", source_id: String(candidate.source_id), title: String(candidate.title), body: page.body.trim() });
      const evidenceIds = [...new Set([...(Array.isArray(claim.evidence_ids) ? claim.evidence_ids.map(String) : []), String(evidence.id)])].sort();
      const saved = this.store.save("knowledge_claim", String(claim.id), { ...payload(claim), source_id: candidate.source_id,
        source_locator: candidate.source_locator, source_page_digest: candidate.source_digest, legacy_scope: claim.scope, scope: reviewedScope, content_ref: contentRef,
        content_digest: contentRef.digest, evidence_ids: evidenceIds, status: "reviewed",
        review: { reviewer, model_ref: modelRef, review_id: review.id, reason_digest: digest(assessment.reason), reviewed_at: new Date().toISOString(), automated: true, confidence: "bounded" } });
      this.store.save("legacy_knowledge_migration_candidate", String(candidate.id), { ...payload(candidate), model_review_id: review.id, reviewed_claim_version: saved.version });
      reviewed.push({ candidate_id: candidate.id, claim_id: saved.id, claim_version: saved.version, review_id: review.id, evidence_id: evidence.id, idempotent: false });
    }
    return { migration_id: migration.id, reviewed, deferred, failures, reviewer, model_ref: modelRef };
  }

  publishReady(args: JsonObject): JsonObject {
    const candidate = this.store.get("legacy_knowledge_migration_candidate", text(args.candidate_id, "candidate_id"));
    if (candidate.status === "published") return { candidate, idempotent: true };
    if (candidate.status !== "candidate") throw new Error("Only a non-duplicate candidate can be published");
    const claim = this.store.get("knowledge_claim", text(candidate.claim_id, "candidate claim_id")); if (claim.status !== "reviewed") throw new Error("Candidate Claim must be independently reviewed before publication");
    return { candidate, claim, idempotent: false };
  }

  completePublish(candidateId: string, wikiPageId: string, memoryId: string): JsonObject {
    const candidate = this.store.get("legacy_knowledge_migration_candidate", candidateId);
    return this.store.save("legacy_knowledge_migration_candidate", candidateId, { ...payload(candidate), status: "published", wiki_page_id: wikiPageId, memory_id: memoryId, published_at: new Date().toISOString(), import_authority: false });
  }

  retractReady(args: JsonObject): JsonObject {
    const candidate = this.store.get("legacy_knowledge_migration_candidate", text(args.candidate_id, "candidate_id"));
    if (candidate.status === "retracted") return { candidate, idempotent: true };
    if (candidate.status !== "published") throw new Error("Only a published candidate can be retracted");
    return { candidate, idempotent: false };
  }

  completeRetraction(candidateId: string, reason: string): JsonObject {
    const candidate = this.store.get("legacy_knowledge_migration_candidate", candidateId);
    return this.store.save("legacy_knowledge_migration_candidate", candidateId, { ...payload(candidate), status: "retracted", retracted_at: new Date().toISOString(), retraction_reason_digest: digest(reason), import_authority: false });
  }

  failureReport(args: JsonObject): JsonObject { const migrationId = text(args.migration_id, "migration_id"); return { reports: this.store.list("legacy_knowledge_migration_report", MAX_FILES, (item) => item.migration_id === migrationId) }; }
  recordFailure(migrationId: string, stage: string, sourceLocator: string, code: string): string { return this.report(migrationId, stage, [this.failure(migrationId, stage, sourceLocator, code)]); }

  private async markdownFiles(root: string): Promise<string[]> {
    const result: string[] = []; const walk = async (directory: string): Promise<void> => {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const target = resolve(directory, item.name); if (item.isSymbolicLink()) continue;
        if (item.isDirectory()) await walk(target); else if (item.isFile() && item.name.endsWith(".md")) { result.push(target); if (result.length > MAX_FILES) throw new Error("legacy knowledge file limit exceeded"); }
      }
    }; await walk(root); return result.sort();
  }

  private async entry(sourceRoot: string, pagesRoot: string, file: string): Promise<Entry> {
    const info = await stat(file); const rel_path = relative(sourceRoot, file).split("\\").join("/");
    if (info.size > MAX_BYTES) return this.excluded(rel_path, digest(`${file}:${info.size}`), "file_too_large");
    const content = await readFile(file, "utf8"); const page_digest = digest(content);
    const { metadata, body } = frontmatter(content); const title = metadata.title || heading(body, relative(pagesRoot, file));
    const category = metadata.category ?? relative(pagesRoot, file).split("/")[0]!; const knowledge_type = metadata.knowledge_type ?? "";
    if (metadata.status !== "confirmed") return this.excluded(rel_path, page_digest, "not_confirmed", title, category, knowledge_type);
    if (!CATEGORIES.has(category) || !TYPES.has(knowledge_type)) return this.excluded(rel_path, page_digest, "unsupported_metadata", title, category, knowledge_type);
    const reuse = metadata.reuse_reason ?? ""; const evidence_type = metadata.evidence_type ?? null; if (!reuse || !evidence_type || !metadata.evidence_ref) return this.excluded(rel_path, page_digest, "missing_evidence_or_reuse_reason", title, category, knowledge_type);
    const summary = `来源摘要：${reuse}`; if (!safe(`${title}\n${summary}`)) return this.excluded(rel_path, page_digest, "sensitive_or_disallowed", title, category, knowledge_type);
    if (!safe(content)) return this.excluded(rel_path, page_digest, "sensitive_or_disallowed", title, category, knowledge_type);
    return { rel_path, page_digest, title, summary, eligibility: "eligible", reason: null, category, knowledge_type, scope: metadata.scope ?? "project", project: metadata.project ?? null, tags: tags(metadata.tags), evidence_type };
  }

  private async sourceState(sourceRoot: string, entry: Entry): Promise<string> {
    const target = resolve(sourceRoot, entry.rel_path); const relativePath = relative(sourceRoot, target);
    if (!relativePath || relativePath.startsWith("..")) return "invalid_source_locator";
    try {
      const resolved = await realpath(target); if (relative(sourceRoot, resolved).startsWith("..")) return "source_path_escape";
      const info = await stat(resolved); if (!info.isFile() || info.size > MAX_BYTES) return "source_unavailable";
      const content = await readFile(resolved, "utf8"); if (!safe(content)) return "source_sensitive_or_disallowed";
      return digest(content) === entry.page_digest ? "current" : "source_digest_drift";
    } catch { return "source_unavailable"; }
  }

  private async readSourcePage(sourceRoot: string, entry: Entry): Promise<{ metadata: Record<string, string>; body: string } | null> {
    const target = resolve(sourceRoot, entry.rel_path); const relativePath = relative(sourceRoot, target);
    if (!relativePath || relativePath.startsWith("..")) return null;
    try {
      const resolved = await realpath(target); if (relative(sourceRoot, resolved).startsWith("..")) return null;
      const info = await stat(resolved); if (!info.isFile() || info.size > MAX_BYTES) return null;
      const content = await readFile(resolved, "utf8"); if (!safe(content) || digest(content) !== entry.page_digest) return null;
      const parsed = frontmatter(content);
      if (parsed.metadata.status !== "confirmed" || !parsed.metadata.evidence_ref || !parsed.body.trim()) return null;
      return parsed;
    } catch { return null; }
  }

  private excluded(rel_path: string, page_digest: string, reason: string, title = "", category = "", knowledge_type = ""): Entry { return { rel_path, page_digest, title, summary: "", eligibility: "excluded", reason, category, knowledge_type, scope: "project", project: null, tags: [], evidence_type: null }; }
  private canonicalKey(entry: Entry): string { return digest({ title: entry.title.toLowerCase(), category: entry.category, project: entry.project ?? "", knowledge_type: entry.knowledge_type, content_digest: entry.page_digest }); }
  private failure(migration_id: string, stage: string, source_locator: string, code: string): JsonObject { return { migration_id, stage, source_locator, code: safe(code) ? code : "redacted_failure", failure_digest: digest(code) }; }
  private report(migrationId: string, stage: string, failures: JsonObject[]): string { const reportId = id("legacy_knowledge_migration_report"); this.store.create("legacy_knowledge_migration_report", reportId, { migration_id: migrationId, stage, failure_count: failures.length, failures, content_free: true }); return reportId; }
}
