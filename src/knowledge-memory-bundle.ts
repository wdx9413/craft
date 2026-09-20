/**
 * Portable, review-preserving exchange of governed Knowledge, Memory and Experience.
 *
 * The bundle is data, not a database copy: Markdown bodies travel with a digest while the
 * receiver recreates local content references.  Import never overwrites an existing record;
 * it first produces a deterministic plan that classifies every entry as add, duplicate or
 * conflict.  That makes two personal machines mergeable without turning sync into an implicit
 * authority escalation.
 */
import { randomUUID } from "node:crypto";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { contentReference } from "./infrastructure/content-store.ts";
import { canonicalJson, payload, stableDigest } from "./digest.ts";
import { optionalScope, text } from "./validation.ts";

const FORMAT = "craft.knowledge-memory-bundle";
const SCHEMA = 1;
const KINDS = new Set([
  "knowledge_source", "evidence", "knowledge_claim", "memory_ledger",
  "knowledge_claim_support",
  "experience_observation", "experience_pattern", "experience_intervention",
  "workflow_evolution_observation", "workflow_evolution_request", "workflow_evolution_proposal",
]);
const CONTENT_KINDS: Readonly<Record<string, "knowledge" | "memory">> = {
  knowledge_claim: "knowledge", memory_ledger: "memory",
};

type BundleEntry = {
  readonly kind: string;
  readonly id: string;
  readonly version: number;
  readonly payload: JsonObject;
  readonly content_body?: string;
  readonly digest: string;
};

function stripContentPath(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripContentPath);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as JsonObject).flatMap(([key, child]) => {
    if (key === "path" && (value as JsonObject).record_id !== undefined && (value as JsonObject).kind !== undefined) return [];
    return [[key, stripContentPath(child)]];
  }));
}

function entryDigest(entry: Omit<BundleEntry, "digest">): string {
  return stableDigest({ kind: entry.kind, id: entry.id, version: entry.version, payload: entry.payload, content_body: entry.content_body ?? null });
}

function isObject(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}

function scopeString(scope: { kind: string; id: string }): string { return `${scope.kind}:${scope.id}`; }

function exactScope(value: unknown, scope: { kind: string; id: string }): boolean {
  return canonicalJson(value) === canonicalJson(scope);
}

/** Deep module for bundle construction, validation, merge planning and import. */
export class KnowledgeMemoryBundleKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  export(args: JsonObject): JsonObject {
    const scope = optionalScope(args);
    if (!scope) throw new Error("Data Bundle export requires scope_kind and scope_id");
    const includeCandidates = args.include_candidates !== false;
    const includeGlobal = args.include_global === true;
    const limit = this.limit(args.limit);
    const target = scopeString(scope);
    const claims = this.store.list("knowledge_claim", limit, (claim) =>
      (includeCandidates || claim.status !== "candidate") && (claim.scope === target || includeGlobal && claim.scope === "global"));
    const memories = this.store.list("memory_ledger", limit, (memory) => exactScope(memory.scope, scope));
    const supports = this.store.list("knowledge_claim_support", limit, (support) => claims.some((claim) => claim.id === support.claim_id));
    const evidenceIds = new Set<string>([
      ...claims.flatMap((claim) => Array.isArray(claim.evidence_ids) ? claim.evidence_ids.map(String) : []),
      ...memories.flatMap((memory) => Array.isArray(memory.evidence_ids) ? memory.evidence_ids.map(String) : []),
      ...supports.map((support) => String(support.evidence_id)),
    ]);
    const sourceIds = new Set<string>([
      ...claims.map((claim) => claim.source_id === undefined ? "" : String(claim.source_id)),
      ...memories.map((memory) => String(memory.source_id)),
    ]);
    sourceIds.delete("");
    const evidence = this.store.list("evidence", limit, (item) => evidenceIds.has(String(item.id)));
    const sources = this.store.list("knowledge_source", limit, (item) => sourceIds.has(String(item.id)));
    const observationIds = new Set<string>();
    const workflowObservations = this.store.list("workflow_evolution_observation", limit, (item) =>
      Array.isArray(item.evidence_ids) && item.evidence_ids.some((id) => evidenceIds.has(String(id))));
    const experienceObservations = this.store.list("experience_observation", limit, (item) =>
      Array.isArray(item.evidence_ids) && item.evidence_ids.some((id) => evidenceIds.has(String(id))));
    experienceObservations.forEach((item) => observationIds.add(String(item.id)));
    const patterns = this.store.list("experience_pattern", limit, (item) =>
      Array.isArray(item.observation_refs) && item.observation_refs.some((ref) => isObject(ref, "observation_ref").id !== undefined && observationIds.has(String(isObject(ref, "observation_ref").id))));
    const patternIds = new Set(patterns.map((item) => String(item.id)));
    const interventions = this.store.list("experience_intervention", limit, (item) =>
      Array.isArray(item.pattern_refs) && item.pattern_refs.some((ref) => patternIds.has(String(isObject(ref, "pattern_ref").id))));
    const workflowRequests = this.store.list("workflow_evolution_request", limit, (item) =>
      Array.isArray(item.observation_refs) && item.observation_refs.some((ref) => workflowObservations.some((observation) => String(observation.id) === String(isObject(ref, "observation_ref").id))));
    const requestIds = new Set(workflowRequests.map((item) => String(item.id)));
    const workflowProposals = this.store.list("workflow_evolution_proposal", limit, (item) => requestIds.has(String(item.request_id)));
    const records = [
      ...sources.map((record) => this.entry("knowledge_source", record)),
      ...evidence.map((record) => this.entry("evidence", record)),
      ...claims.map((record) => this.entry("knowledge_claim", record)),
      ...supports.map((record) => this.entry("knowledge_claim_support", record)),
      ...memories.map((record) => this.entry("memory_ledger", record)),
      ...experienceObservations.map((record) => this.entry("experience_observation", record)),
      ...patterns.map((record) => this.entry("experience_pattern", record)),
      ...interventions.map((record) => this.entry("experience_intervention", record)),
      ...workflowObservations.map((record) => this.entry("workflow_evolution_observation", record)),
      ...workflowRequests.map((record) => this.entry("workflow_evolution_request", record)),
      ...workflowProposals.map((record) => this.entry("workflow_evolution_proposal", record)),
    ];
    const identity = { format: FORMAT, schema_version: SCHEMA, scope, records };
    return { bundle: { ...identity, exported_at: args.exported_at === undefined ? new Date().toISOString() : text(args.exported_at, "exported_at"), digest: stableDigest(identity) }, record_count: records.length };
  }

  verify(args: JsonObject): JsonObject {
    const bundle = this.bundle(args.bundle);
    return { valid: stableDigest(this.identity(bundle)) === bundle.digest, format: bundle.format, schema_version: bundle.schema_version, record_count: bundle.records.length };
  }

  importPlan(args: JsonObject): JsonObject {
    const bundle = this.bundle(args.bundle);
    this.assertValid(bundle);
    const entries = bundle.records.map((entry) => this.entryFrom(entry));
    const seen = new Set<string>();
    const decisions = entries.map((entry) => {
      const key = `${entry.kind}:${entry.id}`;
      if (seen.has(key)) throw new Error("Data Bundle contains duplicate record identities");
      seen.add(key);
      const existing = this.store.find(entry.kind, entry.id);
      if (!existing) return { kind: entry.kind, id: entry.id, action: "add", digest: entry.digest };
      const local = this.entry(entry.kind, existing);
      return { kind: entry.kind, id: entry.id, action: local.digest === entry.digest ? "duplicate" : "conflict", digest: entry.digest, local_digest: local.digest };
    });
    return { format: FORMAT, bundle_digest: bundle.digest, scope: bundle.scope, decisions,
      additions: decisions.filter((item) => item.action === "add").length,
      duplicates: decisions.filter((item) => item.action === "duplicate").length,
      conflicts: decisions.filter((item) => item.action === "conflict").length,
      requires_explicit_apply: true };
  }

  importApply(args: JsonObject): JsonObject {
    if (args.approved !== true) throw new Error("Data Bundle import requires approved: true after reviewing import_plan");
    const bundle = this.bundle(args.bundle);
    const plan = this.importPlan({ bundle });
    const importId = String(args.import_id ?? `knowledge_memory_import_${randomUUID().replaceAll("-", "")}`);
    const existing = this.store.find("knowledge_memory_import", importId);
    if (existing) {
      if (existing.bundle_digest !== bundle.digest) throw new Error("Data Bundle import idempotency conflict");
      return { import: existing, plan, idempotent: true };
    }
    const entries = bundle.records.map((entry) => this.entryFrom(entry));
    const actions = new Map((plan.decisions as JsonObject[]).map((item) => [`${String(item.kind)}:${String(item.id)}`, String(item.action)]));
    const imported: string[] = [];
    for (const entry of entries.sort((left, right) => this.rank(left.kind) - this.rank(right.kind) || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id))) {
      if (actions.get(`${entry.kind}:${entry.id}`) !== "add") continue;
      this.importEntry(entry);
      imported.push(`${entry.kind}:${entry.id}`);
    }
    const receipt = this.store.create("knowledge_memory_import", importId, {
      bundle_digest: bundle.digest, scope: bundle.scope, imported, additions: Number(plan.additions),
      duplicates: Number(plan.duplicates), conflicts: Number(plan.conflicts), conflict_free: Number(plan.conflicts) === 0,
      imported_at: new Date().toISOString(),
    });
    return { import: receipt, plan, idempotent: false };
  }

  private entry(actualKind: string, record: JsonObject): BundleEntry {
    const raw = payload(record);
    const portable = stripContentPath(raw) as JsonObject;
    const contentKind = CONTENT_KINDS[actualKind];
    const contentBody = contentKind && contentReference(raw.content_ref) ? this.store.contentStore.readCompatSync(raw.content_ref).body : undefined;
    const base = { kind: actualKind, id: String(record.id), version: Number(record.version), payload: portable, ...(contentBody === undefined ? {} : { content_body: contentBody }) };
    return { ...base, digest: entryDigest(base) };
  }

  private importEntry(entry: BundleEntry): void {
    const next = { ...entry.payload };
    const contentKind = CONTENT_KINDS[entry.kind];
    if (contentKind) {
      if (entry.content_body === undefined) throw new Error(`Data Bundle ${entry.kind} requires content_body`);
      const scope = contentKind === "knowledge" ? text(next.scope, "knowledge.scope") : (() => {
        const memoryScope = isObject(next.scope, "memory.scope");
        return `${text(memoryScope.kind, "memory.scope.kind")}:${text(memoryScope.id, "memory.scope.id")}`;
      })();
      const priorRef = isObject(next.content_ref, "content_ref");
      const contentVersion = Number(priorRef.version ?? entry.version);
      if (!Number.isSafeInteger(contentVersion) || contentVersion < 1) throw new Error("Data Bundle content reference version is invalid");
      const ref = this.store.contentStore.writeSync({ kind: contentKind, record_id: entry.id, version: contentVersion, scope,
        status: String(next.status ?? (contentKind === "knowledge" ? "candidate" : "active")), sensitivity: String(next.sensitivity ?? "internal"),
        source_id: String(next.source_id ?? "builtin.evidence-wiki"), title: typeof next.title === "string" ? next.title : undefined, body: entry.content_body });
      // `content_digest` belongs to the domain identity (and historically uses the
      // canonical record digest); `content_ref.digest` is the Markdown-body digest. They
      // need not be equal, so importing must not rewrite an otherwise identical identity.
      next.content_ref = ref;
      if (next.content_digest === undefined) next.content_digest = ref.digest;
    }
    this.store.save(entry.kind, entry.id, next, entry.version);
  }

  private bundle(value: unknown): JsonObject & { format: string; schema_version: number; scope: JsonObject; records: unknown[]; digest: string } {
    const bundle = isObject(value, "bundle") as JsonObject & { format: string; schema_version: number; scope: JsonObject; records: unknown[]; digest: string };
    if (bundle.format !== FORMAT || bundle.schema_version !== SCHEMA || !Array.isArray(bundle.records) || typeof bundle.digest !== "string") throw new Error("Data Bundle format is unsupported");
    const scope = isObject(bundle.scope, "bundle.scope");
    if (!optionalScope({ scope_kind: scope.kind, scope_id: scope.id })) throw new Error("Data Bundle scope is missing");
    return bundle;
  }

  private identity(bundle: JsonObject & { format: string; schema_version: number; scope: JsonObject; records: unknown[]; digest: string }): JsonObject {
    return { format: bundle.format, schema_version: bundle.schema_version, scope: bundle.scope, records: bundle.records };
  }

  private assertValid(bundle: JsonObject & { format: string; schema_version: number; scope: JsonObject; records: unknown[]; digest: string }): void {
    if (stableDigest(this.identity(bundle)) !== bundle.digest) throw new Error("Data Bundle digest is invalid");
  }

  private entryFrom(value: unknown): BundleEntry {
    const entry = isObject(value, "bundle.record");
    const kind = text(entry.kind, "bundle.record.kind"); if (!KINDS.has(kind)) throw new Error("Data Bundle record kind is unsupported");
    const version = Number(entry.version); if (!Number.isSafeInteger(version) || version < 1) throw new Error("Data Bundle record version is invalid");
    const base = { kind, id: text(entry.id, "bundle.record.id"), version, payload: isObject(entry.payload, "bundle.record.payload"),
      ...(entry.content_body === undefined ? {} : { content_body: text(entry.content_body, "bundle.record.content_body") }) };
    const digest = text(entry.digest, "bundle.record.digest");
    if (entryDigest(base) !== digest) throw new Error("Data Bundle record digest is invalid");
    return { ...base, digest };
  }

  private limit(value: unknown): number {
    const limit = value === undefined ? 2_000 : Number(value);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("Data Bundle limit must be an integer between 1 and 10000");
    return limit;
  }

  private rank(kind: string): number {
    return ["knowledge_source", "evidence", "knowledge_claim", "knowledge_claim_support", "memory_ledger"].indexOf(kind) + 1 || 9;
  }
}
