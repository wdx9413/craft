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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { contentReference } from "./infrastructure/content-store.ts";
import { canonicalJson, payload, stableDigest } from "./digest.ts";
import { optionalScope, text } from "./validation.ts";
import { ProcedureDefinitionStore, procedureDefinitionRef, type ProcedureDefinition } from "../capability/craft-experience/procedure-definition.ts";

const FORMAT = "craft.knowledge-memory-bundle";
const SCHEMA = 3;
const SUPPORTED_SCHEMAS = new Set([1, 2, 3]);
const KINDS = new Set([
  "knowledge_source", "evidence", "knowledge_claim", "memory_ledger",
  "knowledge_claim_support",
  "experience_observation", "experience_pattern", "experience_intervention",
  "workflow_evolution_observation", "workflow_evolution_request", "workflow_evolution_proposal",
  "experience_procedure", "experience_procedure_gate", "experience_skill_export",
  "project_identity", "scope_alias", "knowledge_source_revision", "knowledge_fragment",
  "knowledge_ingest_candidate", "memory_candidate", "memory_usage_signal", "maintenance_schedule_receipt",
]);
const CONTENT_KINDS: Readonly<Record<string, "knowledge" | "memory" | "experience">> = {
  knowledge_claim: "knowledge", memory_ledger: "memory", experience_procedure: "experience",
};

type BundleEntry = {
  readonly kind: string;
  readonly id: string;
  readonly version: number;
  readonly payload: JsonObject;
  readonly content_body?: string;
  /** Portable authority for a Workflow/Graph Procedure; never an absolute path. */
  readonly procedure_definition?: ProcedureDefinition;
  readonly digest: string;
};

function stripContentPath(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripContentPath);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as JsonObject).flatMap(([key, child]) => {
    const record = value as JsonObject;
    if (key === "path" && ((record.record_id !== undefined && record.kind !== undefined)
      || (record.format === "json" && record.procedure_id !== undefined))) return [];
    return [[key, stripContentPath(child)]];
  }));
}

function entryDigest(entry: Omit<BundleEntry, "digest">): string {
  return stableDigest({ kind: entry.kind, id: entry.id, version: entry.version, payload: entry.payload,
    content_body: entry.content_body ?? null, procedure_definition: entry.procedure_definition ?? null });
}

function isObject(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}

/** Content bodies are digest-pinned bytes, not identifiers: never trim them on import. */
function body(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
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
    const revisions = this.store.list("knowledge_source_revision", limit, (item) => sourceIds.has(String(item.source_id)));
    const revisionIds = new Set(revisions.map((item) => String(item.id)));
    const fragments = this.store.list("knowledge_fragment", limit, (item) => revisionIds.has(String(item.source_revision_id)));
    const evidence = this.store.list("evidence", limit, (item) => evidenceIds.has(String(item.id)) || revisionIds.has(String(item.source_revision_id)));
    const sources = this.store.list("knowledge_source", limit, (item) => sourceIds.has(String(item.id)));
    const aliases = this.store.list("scope_alias", limit, (item) => (item.scope as JsonObject | undefined)?.kind === scope.kind && (item.scope as JsonObject | undefined)?.id === scope.id);
    const identities = this.store.list("project_identity", limit, (item) => String(item.id) === scope.id);
    const memoryCandidates = this.store.list("memory_candidate", limit, (item) => exactScope(item.scope, scope));
    const usageSignals = this.store.list("memory_usage_signal", limit, (item) => exactScope(item.scope, scope));
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
    const proposalIds = new Set(workflowProposals.map((item) => String(item.id)));
    const procedures = this.store.list("experience_procedure", limit, (item) => proposalIds.has(String(item.proposal_id)) || item.scope === target);
    const procedureIds = new Set(procedures.map((item) => String(item.id)));
    const procedureGates = this.store.list("experience_procedure_gate", limit, (item) => procedureIds.has(String(item.procedure_id)));
    // A Skill export is a device-local, disabled artifact.  The procedure and its
    // Markdown body are portable; copying an absolute artifact path would not be.
    // Receivers may explicitly export their own draft after the procedure is routed.
    const records = [
      ...identities.map((record) => this.entry("project_identity", record)),
      ...aliases.map((record) => this.entry("scope_alias", record)),
      ...sources.map((record) => this.entry("knowledge_source", record)),
      ...revisions.map((record) => this.entry("knowledge_source_revision", record)),
      ...fragments.map((record) => this.entry("knowledge_fragment", record)),
      ...evidence.map((record) => this.entry("evidence", record)),
      ...claims.map((record) => this.entry("knowledge_claim", record)),
      ...supports.map((record) => this.entry("knowledge_claim_support", record)),
      ...memories.map((record) => this.entry("memory_ledger", record)),
      ...memoryCandidates.map((record) => this.entry("memory_candidate", record)),
      ...usageSignals.map((record) => this.entry("memory_usage_signal", record)),
      ...experienceObservations.map((record) => this.entry("experience_observation", record)),
      ...patterns.map((record) => this.entry("experience_pattern", record)),
      ...interventions.map((record) => this.entry("experience_intervention", record)),
      ...workflowObservations.map((record) => this.entry("workflow_evolution_observation", record)),
      ...workflowRequests.map((record) => this.entry("workflow_evolution_request", record)),
      ...workflowProposals.map((record) => this.entry("workflow_evolution_proposal", record)),
      ...procedures.map((record) => this.entry("experience_procedure", record)),
      ...procedureGates.map((record) => this.entry("experience_procedure_gate", record)),
    ];
    const deviceId = args.device_id === undefined ? "local" : text(args.device_id, "device_id");
    const cursor = args.cursor === undefined ? null : text(args.cursor, "cursor");
    const exportId = args.export_id === undefined ? `craft_export_${randomUUID().replaceAll("-", "")}` : text(args.export_id, "export_id");
    const identity = { format: FORMAT, schema_version: SCHEMA, scope, device_id: deviceId, export_id: exportId, cursor, records };
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
    const conflicts = (plan.decisions as JsonObject[]).filter((item) => item.action === "conflict");
    for (const conflict of conflicts) this.store.create("knowledge_memory_conflict", `knowledge_memory_conflict_${stableDigest({ bundle: bundle.digest, kind: conflict.kind, id: conflict.id }).slice(7, 31)}`, {
      bundle_digest: bundle.digest, kind: conflict.kind, record_id: conflict.id, incoming_digest: conflict.digest, local_digest: conflict.local_digest, status: "candidate",
    });
    const receipt = this.store.create("knowledge_memory_import", importId, {
      bundle_digest: bundle.digest, scope: bundle.scope, imported, additions: Number(plan.additions),
      duplicates: Number(plan.duplicates), conflicts: Number(plan.conflicts), conflict_free: Number(plan.conflicts) === 0,
      imported_at: new Date().toISOString(), merge_receipt: { device_id: bundle.device_id ?? null, export_id: bundle.export_id ?? null, cursor: bundle.cursor ?? null },
    });
    return { import: receipt, plan, idempotent: false };
  }

  /**
   * Portable transports deliberately move a verified Bundle, never a SQLite file.
   * `git_worktree` only writes a reviewable JSON file; committing or pushing it
   * remains an explicit user action outside Craft.
   */
  transport(args: JsonObject): JsonObject {
    const operation = text(args.operation, "operation");
    const transport = text(args.transport, "transport");
    if (transport !== "directory" && transport !== "git_worktree") throw new Error("Bundle transport must be directory or git_worktree");
    const root = args.transport_root === undefined ? join(this.store.paths.artifactsDir, "bundles") : resolve(text(args.transport_root, "transport_root"));
    if (transport === "git_worktree" && !existsSync(join(root, ".git"))) return { status: "unavailable", reason: "git_worktree_unavailable" };
    const directory = transport === "git_worktree" ? join(root, ".craft", "craft-bundles") : root;
    if (operation === "write") {
      if (args.allow_local_write !== true) throw new Error("Bundle transport write requires allow_local_write: true");
      const bundle = this.bundle(args.bundle); this.assertValid(bundle);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const fileName = `craft-bundle-${bundle.digest.replace(/^sha256:/u, "")}.json`;
      const path = join(directory, fileName);
      writeFileSync(path, `${JSON.stringify(bundle)}\n`, { encoding: "utf8", mode: 0o600 });
      return { status: "written", transport, file_name: fileName, bundle_digest: bundle.digest,
        receipt: this.transportReceipt("write", transport, root, fileName, bundle.digest) };
    }
    if (operation === "read") {
      const fileName = text(args.file_name, "file_name");
      if (!/^craft-bundle-[a-f0-9]{64}\.json$/u.test(fileName)) throw new Error("Bundle transport file_name is invalid");
      const path = join(directory, fileName);
      if (!existsSync(path)) return { status: "unavailable", reason: "bundle_file_unavailable" };
      const bundle = this.bundle(JSON.parse(readFileSync(path, "utf8")));
      this.assertValid(bundle);
      return { status: "read", transport, bundle, receipt: this.transportReceipt("read", transport, root, fileName, bundle.digest) };
    }
    return { status: "unavailable", reason: "bundle_transport_operation_unsupported" };
  }

  private entry(actualKind: string, record: JsonObject): BundleEntry {
    const raw = payload(record);
    const portable = stripContentPath(raw) as JsonObject;
    const contentKind = CONTENT_KINDS[actualKind];
    const contentBody = contentKind && contentReference(raw.content_ref) ? this.store.contentStore.readCompatSync(raw.content_ref).body : undefined;
    const procedureDefinition = actualKind === "experience_procedure" && procedureDefinitionRef(raw.definition_ref)
      ? new ProcedureDefinitionStore(this.store.paths).read(raw.definition_ref) : undefined;
    const base = { kind: actualKind, id: String(record.id), version: Number(record.version), payload: portable,
      ...(contentBody === undefined ? {} : { content_body: contentBody }),
      ...(procedureDefinition === undefined ? {} : { procedure_definition: procedureDefinition }) };
    return { ...base, digest: entryDigest(base) };
  }

  private importEntry(entry: BundleEntry): void {
    const next = { ...entry.payload };
    const contentKind = CONTENT_KINDS[entry.kind];
    if (contentKind) {
      if (entry.content_body === undefined) throw new Error(`Data Bundle ${entry.kind} requires content_body`);
      const scope = contentKind === "knowledge" || contentKind === "experience" ? text(next.scope, `${contentKind}.scope`) : (() => {
        const memoryScope = isObject(next.scope, "memory.scope");
        return `${text(memoryScope.kind, "memory.scope.kind")}:${text(memoryScope.id, "memory.scope.id")}`;
      })();
      const priorRef = isObject(next.content_ref, "content_ref");
      const contentVersion = Number(priorRef.version ?? entry.version);
      if (!Number.isSafeInteger(contentVersion) || contentVersion < 1) throw new Error("Data Bundle content reference version is invalid");
      const ref = this.store.contentStore.writeSync({ kind: contentKind, record_id: entry.id, version: contentVersion, scope,
        status: String(next.status ?? (contentKind === "knowledge" || contentKind === "experience" ? "candidate" : "active")), sensitivity: String(next.sensitivity ?? "internal"),
        source_id: String(next.source_id ?? "builtin.evidence-wiki"), title: typeof next.title === "string" ? next.title : undefined, body: entry.content_body });
      // `content_digest` belongs to the domain identity (and historically uses the
      // canonical record digest); `content_ref.digest` is the Markdown-body digest. They
      // need not be equal, so importing must not rewrite an otherwise identical identity.
      next.content_ref = ref;
      if (next.content_digest === undefined) next.content_digest = ref.digest;
    }
    if (entry.kind === "experience_procedure") {
      if (entry.procedure_definition !== undefined) {
        if (entry.procedure_definition.procedure_id !== entry.id || entry.procedure_definition.procedure_version !== entry.version) throw new Error("Data Bundle Procedure definition identity is invalid");
        const ref = new ProcedureDefinitionStore(this.store.paths).write(entry.procedure_definition, String(next.title ?? entry.id));
        next.definition_ref = ref; next.definition_digest = ref.digest;
      } else if (procedureDefinitionRef(next.definition_ref)) {
        // Pre-structured bundles could only carry a machine-local absolute reference. Preserve
        // their Markdown review view, but never route it as if the missing JSON were portable.
        delete next.definition_ref; next.definition_digest = null; next.routeable = false;
        if (next.lifecycle === "routeable") next.lifecycle = "revalidation_required";
      }
    }
    this.store.save(entry.kind, entry.id, next, entry.version);
  }

  private bundle(value: unknown): JsonObject & { format: string; schema_version: number; scope: JsonObject; records: unknown[]; digest: string; device_id?: string; export_id?: string; cursor?: string | null } {
    const bundle = isObject(value, "bundle") as JsonObject & { format: string; schema_version: number; scope: JsonObject; records: unknown[]; digest: string };
    if (bundle.format !== FORMAT || !SUPPORTED_SCHEMAS.has(bundle.schema_version) || !Array.isArray(bundle.records) || typeof bundle.digest !== "string") throw new Error("Data Bundle format is unsupported");
    const scope = isObject(bundle.scope, "bundle.scope");
    if (!optionalScope({ scope_kind: scope.kind, scope_id: scope.id })) throw new Error("Data Bundle scope is missing");
    return bundle;
  }

  private identity(bundle: JsonObject & { format: string; schema_version: number; scope: JsonObject; records: unknown[]; digest: string; device_id?: string; export_id?: string; cursor?: string | null }): JsonObject {
    return bundle.schema_version === 1
      ? { format: bundle.format, schema_version: bundle.schema_version, scope: bundle.scope, records: bundle.records }
      : { format: bundle.format, schema_version: bundle.schema_version, scope: bundle.scope, device_id: bundle.device_id, export_id: bundle.export_id, cursor: bundle.cursor ?? null, records: bundle.records };
  }

  private assertValid(bundle: JsonObject & { format: string; schema_version: number; scope: JsonObject; records: unknown[]; digest: string; device_id?: string; export_id?: string; cursor?: string | null }): void {
    if (stableDigest(this.identity(bundle)) !== bundle.digest) throw new Error("Data Bundle digest is invalid");
  }

  private entryFrom(value: unknown): BundleEntry {
    const entry = isObject(value, "bundle.record");
    const kind = text(entry.kind, "bundle.record.kind"); if (!KINDS.has(kind)) throw new Error("Data Bundle record kind is unsupported");
    const version = Number(entry.version); if (!Number.isSafeInteger(version) || version < 1) throw new Error("Data Bundle record version is invalid");
    const base = { kind, id: text(entry.id, "bundle.record.id"), version, payload: isObject(entry.payload, "bundle.record.payload"),
      ...(entry.content_body === undefined ? {} : { content_body: body(entry.content_body, "bundle.record.content_body") }),
      ...(entry.procedure_definition === undefined ? {} : { procedure_definition: entry.procedure_definition as ProcedureDefinition }) };
    const digest = text(entry.digest, "bundle.record.digest");
    const actualDigest = entryDigest(base);
    if (actualDigest !== digest) throw new Error(`Data Bundle record digest is invalid for ${kind}:${base.id}`);
    return { ...base, digest };
  }

  private limit(value: unknown): number {
    const limit = value === undefined ? 2_000 : Number(value);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("Data Bundle limit must be an integer between 1 and 10000");
    return limit;
  }

  private rank(kind: string): number {
    return ["project_identity", "scope_alias", "knowledge_source", "knowledge_source_revision", "knowledge_fragment", "evidence", "knowledge_claim", "knowledge_claim_support", "memory_ledger", "memory_candidate", "memory_usage_signal", "experience_observation", "experience_pattern", "experience_intervention", "workflow_evolution_observation", "workflow_evolution_request", "workflow_evolution_proposal", "experience_procedure", "experience_procedure_gate", "experience_skill_export"].indexOf(kind) + 1 || 99;
  }

  private transportReceipt(operation: "write" | "read", transport: string, root: string, fileName: string, bundleDigest: string): JsonObject {
    const identity = { operation, transport, root_digest: stableDigest(resolve(root)), file_name: fileName, bundle_digest: bundleDigest };
    const id = `knowledge_memory_bundle_transport_${stableDigest(identity).slice(-20)}`;
    return this.store.find("knowledge_memory_bundle_transport_receipt", id) ?? this.store.create("knowledge_memory_bundle_transport_receipt", id, identity);
  }
}
