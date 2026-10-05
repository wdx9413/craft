import type { CraftStore, JsonObject } from "../../infrastructure/store.ts";
import { payload, stableDigest } from "../../digest.ts";
import { object, text } from "../../validation.ts";
import { scopeAccess, scopeAllows, scopeEnvelope, scopeFromKey } from "../../scope-policy.ts";
import { ProcedureDefinitionStore, procedureDefinitionRef } from "../../../capability/craft-experience/procedure-definition.ts";

type Command = (args: JsonObject) => JsonObject;
const KINDS: Record<string, string[]> = { knowledge: ["knowledge_claim", "knowledge_source", "knowledge_document"], memory: ["memory_ledger", "memory_candidate"], experience: ["experience_procedure", "workflow_design"], codebase: ["codebase_index"] };
const array = (v: unknown): JsonObject[] => Array.isArray(v) ? v as JsonObject[] : [];
function version(v: unknown, key: string): number { if (!Number.isSafeInteger(v) || Number(v) < 1) throw new Error(`${key} must be a positive integer`); return Number(v); }

/** Shared revision reads; each product keeps authority over restoration and promotion. */
export class ComponentAssets {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }
  private locate(member: string, args: JsonObject): { kind: string; current: JsonObject } {
    const kind = String(args.kind ?? KINDS[member]?.[0]);
    if (!KINDS[member]?.includes(kind)) throw new Error("Asset kind does not belong to this component");
    const current = this.store.get(kind, text(args.asset_id, "asset_id")); this.authorize(current, args);
    return { kind, current };
  }
  private authorize(record: JsonObject, args: JsonObject): void {
    const value = record.scope ?? (record.workspace_id ? { kind: "workspace", id: record.workspace_id } : this.store.get("knowledge_source", String(record.source_id)).scope);
    const scope = typeof value === "string" ? scopeFromKey(value) : object(value, "scope") as { kind: string; id: string };
    if (scope.kind !== text(args.scope_kind, "scope_kind") || scope.id !== text(args.scope_id, "scope_id")
      || !scopeAllows(scopeEnvelope(record.scope_envelope, scope), scopeAccess(args)) || record.sensitivity === "restricted" && args.allow_restricted !== true) throw new Error("Asset scope or audience denied");
    if (record.source_id) {
      const source = this.store.get("knowledge_source", String(record.source_id));
      const sourceScope = source.scope as { kind: string; id: string };
      if (!scopeAllows(scopeEnvelope(source.scope_envelope, sourceScope), scopeAccess(args))) throw new Error("Asset source audience denied");
    }
  }
  private summary(item: JsonObject): JsonObject {
    return { id: item.id, record_version: item.version, content_revision: item.definition_digest ?? item.content_digest ?? item.source_revision_digest ?? item.input_digest ?? item.identity_digest ?? null,
      state: item.status ?? item.lifecycle ?? "unknown", created_at: item.created_at, author: item.proposed_by ?? item.author ?? "unknown", source_id: item.source_id ?? null };
  }
  inspect(member: string, args: JsonObject): JsonObject {
    const { kind, current } = this.locate(member, args), action = String(args.action ?? "history");
    if (action === "explain") return this.explain(member, kind, current, args);
    if (action === "history") {
      const limit = args.limit === undefined ? 30 : version(args.limit, "limit"); if (limit > 100) throw new Error("History limit exceeds 100");
      const before = args.before_version === undefined ? Number.MAX_SAFE_INTEGER : version(args.before_version, "before_version");
      const records = this.store.history(kind, String(current.id), before, limit + 1).filter(item => { this.authorize(item, args); return true; });
      return { member, kind, current: this.summary(current), versions: records.slice(0, limit).map(item => this.summary(item)), has_more: records.length > limit, next_before_version: records.length > limit ? records[limit - 1]!.version : null, restorations: this.store.list("asset_restoration", 100, r => r.member === member && (r.asset_id === current.id || r.restored_id === current.id)) };
    }
    const selected = this.store.get(kind, String(current.id), version(args.version, "version")); this.authorize(selected, args);
    if (action === "read") return { member, kind, version: this.summary(selected), asset: selected, execution_authorized: false, historical: selected.version !== current.version };
    if (action !== "diff") throw new Error("Unknown asset inspection action");
    const otherId = String(args.target_asset_id ?? current.id);
    this.authorize(this.store.get(kind, otherId), args);
    const other = this.store.get(kind, otherId, version(args.target_version, "target_version")); this.authorize(other, args);
    const keys = [...new Set([...Object.keys(payload(selected)), ...Object.keys(payload(other))])].sort();
    const changes = keys.filter(key => stableDigest(selected[key] ?? null) !== stableDigest(other[key] ?? null)).map(key => ({ field: key, before: selected[key] ?? null, after: other[key] ?? null }));
    return { member, kind, from: this.summary(selected), to: this.summary(other), content_changed: this.summary(selected).content_revision === null || this.summary(other).content_revision === null ? null : this.summary(selected).content_revision !== this.summary(other).content_revision, changes };
  }
  private explain(member: string, kind: string, current: JsonObject, args: JsonObject): JsonObject {
    const source = current.source_id ? this.store.get("knowledge_source", String(current.source_id)) : kind === "knowledge_source" ? current : null;
    const reasons: string[] = [];
    if (source && (source.status !== "active" || source.trust === "untrusted")) reasons.push("source_unavailable");
    if (current.valid_until && Date.parse(String(current.valid_until)) <= Date.now()) reasons.push("expired");
    if (member === "knowledge" && kind === "knowledge_claim" && current.status !== "reviewed") reasons.push(`claim_${String(current.status)}`);
    if (member === "memory" && (kind !== "memory_ledger" || current.status !== "active")) reasons.push(`memory_${String(current.status)}`);
    if (member === "experience" && current.routeable !== true) reasons.push("not_routeable");
    if (member === "codebase") {
      const workspace = this.store.get("workspace", String(current.workspace_id));
      if (workspace.latest_checkpoint_id !== current.checkpoint_id) reasons.push("checkpoint_changed");
      if (this.store.find("codebase_activation", `codebase_activation_${current.workspace_id}`)?.status !== "active") reasons.push("index_disabled");
    }
    const receipts = this.store.list(member === "codebase" ? "codebase_query_receipt" : "context_resolution_receipt", 101, receipt => {
      if (member === "codebase") return receipt.index_id === current.id;
      const scope = receipt.scope as JsonObject | undefined, access = receipt.scope_access as JsonObject | undefined;
      return scope?.kind === args.scope_kind && scope?.id === args.scope_id && !receipt.allow_restricted && !access?.principal_present && !access?.tenant_present
        && (array(receipt.memory_refs).some(ref => ref.memory_id === current.id) || array(receipt.contributions).some(part => array(part.references).some(ref => ref.id === current.id)));
    });
    const feedback = this.store.list("context_feedback", 101, item => receipts.some(r => r.id === item.receipt_id));
    const details: JsonObject = {};
    if (member === "knowledge" && source) {
      const documents = this.store.list("knowledge_document", 101, doc => doc.source_id === source.id);
      details.documents = documents.slice(0, 100).map(doc => ({ id: doc.id, path: doc.path, status: doc.status, content_digest: doc.content_digest })); details.documents_truncated = documents.length > 100;
      details.ingestions = this.store.list("knowledge_ingest_receipt", 20, x => x.source_id === source.id);
      details.provenance = { source_id: source.id, source_version: source.version, document_id: current.document_id ?? null, document_digest: current.document_digest ?? null, fragment_id: current.fragment_id ?? null, evidence_ids: current.evidence_ids ?? [] };
    }
    if (member === "memory") {
      const proofs = Array.isArray(current.evidence_ids) ? current.evidence_ids.map(id => this.store.get("evidence", String(id))) : [];
      details.authorship = proofs.some(p => (p.metadata as JsonObject | undefined)?.user_authored === true) ? "explicit_user_statement" : current.proposed_by ?? "unknown";
      details.replacement_id = current.replacement_id ?? null; details.effective_from = current.effective_from ?? null;
      details.feedback = feedback.slice(0, 100).map(f => ({ outcome: f.outcome, evidence_verified: f.evidence_verified === true }));
    }
    if (member === "experience") {
      details.configuration = procedureDefinitionRef(current.definition_ref) ? new ProcedureDefinitionStore(this.store.paths).read(current.definition_ref).definition : null;
      details.invocations = this.store.list("procedure_invocation", 20, r => r.procedure_id === current.id && r.scope === current.scope).map(r => ({ id: r.id, lifecycle: r.lifecycle, procedure_version: r.procedure_version, definition_digest: r.definition_digest, subscenario_id: r.subscenario_id, graph_state: r.graph_state, dispatch_count: r.dispatch_count, max_dispatches: r.max_dispatches }));
      details.gates = this.store.list("experience_procedure_gate", 100, g => g.procedure_id === current.id);
      details.outcomes = this.store.list("procedure_invocation_outcome", 100, o => o.procedure_id === current.id && o.scope === current.scope);
      details.diagnosis = { recall_recorded: receipts.length > 0, followed: "unknown", verified_outcomes: (details.outcomes as JsonObject[]).filter(o => o.status === "passed").length, model_effect_proven: false };
    }
    if (member === "codebase") { details.analysis = current.analysis; details.diagnostics = array(current.diagnostics).slice(0, 100); details.checkpoint_id = current.checkpoint_id; details.candidate_only = true; }
    return { member, kind, asset: this.summary(current), reasons, eligible_by_record_state: reasons.length === 0, relevance_evaluated: false,
      receipts: receipts.slice(0, 100).map(r => ({ id: r.id, version: r.version, created_at: r.created_at, memory_refs: r.memory_refs, contributions: r.contributions, query_digest: r.query_digest })), receipts_truncated: receipts.length > 100, followed: "unknown", ...details };
  }
  restore(member: string, args: JsonObject, commands: { memory: Command; knowledge: Command; experience: Command; codebase: Command }): JsonObject {
    return this.store.transaction(() => {
      const { kind, current } = this.locate(member, args);
      if (kind !== KINDS[member]![0]) throw new Error("Only primary component assets can be restored");
      const previous = this.store.get(kind, String(current.id), version(args.version, "version")); this.authorize(previous, args);
      const reason = text(args.reason, "reason");
      if (previous.source_id) {
        const source = this.store.get("knowledge_source", String(previous.source_id));
        if (source.status !== "active" || source.trust === "untrusted") throw new Error("Restoration cannot bypass source revocation");
      }
      const requestId = text(args.request_id, "request_id"), identity = { member, asset_id: current.id, version: previous.version, reason_digest: stableDigest(reason), scope_kind: args.scope_kind, scope_id: args.scope_id };
      const id = `asset_restore_${stableDigest([member, requestId]).slice(-24)}`, existing = this.store.find("asset_restoration", id);
      if (existing) { if (existing.request_digest !== stableDigest(identity)) throw new Error("Restoration request conflict"); return { restoration: existing, idempotent: true }; }
      if (current.version !== version(args.expected_version, "expected_version")) throw new Error("Asset changed; reload before restoration");
      const newId = `restored_${stableDigest(identity).slice(-24)}`;
      let result: JsonObject;
      if (member === "knowledge") result = commands.knowledge({ claim_id: newId, kind: previous.kind, content: previous.content, scope: previous.scope, scope_envelope: current.scope_envelope, source_id: previous.source_id, evidence_ids: previous.evidence_ids ?? [], tags: previous.tags ?? [] });
      else if (member === "memory") result = commands.memory({ candidate_id: newId, source_id: previous.source_id, kind: previous.kind, content: previous.content, scope_kind: args.scope_kind, scope_id: args.scope_id, scope_envelope: current.scope_envelope, sensitivity: current.sensitivity, confidence: "bounded", evidence_ids: previous.evidence_ids ?? [], topic: previous.topic || undefined, proposed_by: "version-restoration", auto_accept: false });
      else if (member === "experience") {
        if (!procedureDefinitionRef(previous.definition_ref)) throw new Error("Restoration requires a checked Procedure definition");
        const definition = new ProcedureDefinitionStore(this.store.paths).read(previous.definition_ref);
        result = commands.experience({ ...args, procedure_id: newId, expected_version: undefined, scope: previous.scope, procedure_kind: definition.kind, definition: definition.definition, title: previous.title, scenario_id: (previous.scenario_signature as JsonObject).scenario_id ?? "restored", scope_envelope: current.scope_envelope });
      }
      else {
        const workspace = this.store.get("workspace", String(current.workspace_id));
        if (previous.checkpoint_id !== workspace.latest_checkpoint_id) throw new Error("Restore the workspace separately; a historical index cannot serve current code");
        if (!["builtin-regex-static-v1", "typescript-checker"].includes(String(previous.analyzer))) throw new Error("Restore this analyzer through its original checkpoint-pinned import adapter");
        result = commands.codebase({ workspace_id: current.workspace_id, checkpoint_id: previous.checkpoint_id, index_id: newId, analyzer: previous.analyzer === "builtin-regex-static-v1" ? "heuristic" : "typescript" });
      }
      let restored = object(result.claim ?? result.candidate ?? result.procedure ?? result.index, "restored asset");
      if (member === "knowledge" && previous.document_id) {
        restored = this.store.save(kind, String(restored.id), { ...payload(restored), source_revision_id: previous.source_revision_id, document_id: previous.document_id, document_digest: previous.document_digest, fragment_id: previous.fragment_id, revalidation_required: true });
        result = { ...result, claim: restored };
      }
      const record = this.store.create("asset_restoration", id, { ...identity, request_digest: stableDigest(identity), restored_id: restored.id, restored_kind: member === "memory" ? "memory_candidate" : kind, execution_authorized: false, activation: member === "codebase" ? "rebuilt_current_checkpoint" : "governed_candidate" });
      return { restoration: record, result, idempotent: false };
    });
  }
}
