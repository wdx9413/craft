import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { JsonObject } from "./store.ts";
import { CraftStore } from "./store.ts";

const CATEGORIES = new Set(["projects", "domains", "troubleshooting", "decisions", "workflows"]);
const TYPES = new Map<string, string>([["domain_rule", "fact"], ["technical_decision", "decision"], ["workflow", "rule"], ["troubleshooting", "failure_mode"], ["stable_project_fact", "fact"]]);
const SECRET = /(?:password|passwd|token|secret|api[_-]?key|cookie|authorization)\s*[:=]\s*\S{8,}/i;
const FORBIDDEN = /个人述职|述职|\bddo\b|\bokr\b|绩效|个人能力|能力成长|个人总结|周报|月报|季度总结|上半年总结|下半年计划|阶段进展|项目进展|会议纪要|会议记录|文案润色|翻译润色/i;
const MAX_FILES = 10_000;
const MAX_BYTES = 256 * 1024;

type Entry = JsonObject & { rel_path: string; page_digest: string; title: string; summary: string; eligibility: string; reason: string | null; category: string; knowledge_type: string; scope: string; project: string | null; tags: string[]; evidence_type: string | null };
type CandidateHandler = (entry: Entry, migration: JsonObject, sourceId: string, candidateId: string) => { evidence_id: string; claim_id: string };

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
    const content = await readFile(file, "utf8"); const page_digest = digest(content); if (!safe(content)) return this.excluded(rel_path, page_digest, "sensitive_or_disallowed");
    const { metadata, body } = frontmatter(content); const title = metadata.title || heading(body, relative(pagesRoot, file));
    const category = metadata.category ?? relative(pagesRoot, file).split("/")[0] ?? ""; const knowledge_type = metadata.knowledge_type ?? "";
    if (metadata.status !== "confirmed") return this.excluded(rel_path, page_digest, "not_confirmed", title, category, knowledge_type);
    if (!CATEGORIES.has(category) || !TYPES.has(knowledge_type)) return this.excluded(rel_path, page_digest, "unsupported_metadata", title, category, knowledge_type);
    const reuse = metadata.reuse_reason ?? ""; const evidence_type = metadata.evidence_type ?? null; if (!reuse || !evidence_type || !metadata.evidence_ref) return this.excluded(rel_path, page_digest, "missing_evidence_or_reuse_reason", title, category, knowledge_type);
    const summary = `来源摘要：${reuse}`; if (!safe(`${title}\n${summary}`)) return this.excluded(rel_path, page_digest, "sensitive_or_disallowed", title, category, knowledge_type);
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

  private excluded(rel_path: string, page_digest: string, reason: string, title = "", category = "", knowledge_type = ""): Entry { return { rel_path, page_digest, title, summary: "", eligibility: "excluded", reason, category, knowledge_type, scope: "project", project: null, tags: [], evidence_type: null }; }
  private canonicalKey(entry: Entry): string { return digest({ title: entry.title.toLowerCase(), category: entry.category, project: entry.project ?? "", knowledge_type: entry.knowledge_type, content_digest: entry.page_digest }); }
  private failure(migration_id: string, stage: string, source_locator: string, code: string): JsonObject { return { migration_id, stage, source_locator, code: safe(code) ? code : "redacted_failure", failure_digest: digest(code) }; }
  private report(migrationId: string, stage: string, failures: JsonObject[]): string { const reportId = id("legacy_knowledge_migration_report"); this.store.create("legacy_knowledge_migration_report", reportId, { migration_id: migrationId, stage, failure_count: failures.length, failures, content_free: true }); return reportId; }
}
