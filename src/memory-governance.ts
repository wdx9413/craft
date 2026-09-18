import { createHash, randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";
import { KnowledgeMemoryRuntime } from "./knowledge-memory-runtime.ts";

const SECRET = /(?:api[_-]?key|authorization|cookie|password|passwd|secret|token)\s*[:=]\s*[^\s]{6,}/iu;
const KINDS = new Set(["working", "episodic", "preference", "procedural"]);
const STATUSES = new Set(["candidate", "approved", "rejected", "conflict_pending", "expired"]);
const CONFIDENCE = new Set(["confirmed", "bounded", "unverified"]);
const SCOPE = new Set(["user", "project", "workspace", "task", "session"]);
const POLICY_MODES = new Set(["off", "propose", "governed"]);
const POLICY_CONFIDENCE = new Set(["confirmed", "bounded"]);
function id(prefix: string): string { return `${prefix}_${randomUUID().replaceAll("-", "")}`; }
function text(v: unknown, name: string): string { if (typeof v !== "string" || !v.trim()) throw new Error(`${name} must not be empty`); return v.trim(); }
function digest(v: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(v)).digest("hex")}`; }
function noSecret(v: string, name: string): string { if (SECRET.test(v)) throw new Error(`${name} must not contain credentials or secrets`); return v; }
function payload(r: JsonObject): JsonObject { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...p } = r; return p; }
function evidenceIds(v: unknown): string[] { if (v === undefined) return []; if (!Array.isArray(v)) throw new Error("evidence_ids must be an array"); const values = v.map((x) => text(x, "evidence_ids")); if (new Set(values).size !== values.length) throw new Error("evidence_ids must be unique"); return values.sort(); }

/** Candidate-first memory governance. It is deliberately separate from the legacy projections. */
export class MemoryGovernanceKernel {
  readonly store: CraftStore;
  readonly ledger: KnowledgeMemoryRuntime;
  constructor(store: CraftStore, ledger: KnowledgeMemoryRuntime) { this.store = store; this.ledger = ledger; }

  policyGet(args: JsonObject = {}): JsonObject {
    const policyId = text(args.policy_id ?? "default", "policy_id");
    const stored = this.store.find("memory_policy", policyId);
    return { policy: stored ?? { id: policyId, version: 1, mode: "propose", min_confidence: "confirmed", auto_commit: false, source: "builtin" } };
  }

  policySave(args: JsonObject): JsonObject {
    const policyId = text(args.policy_id ?? "default", "policy_id");
    const mode = text(args.mode, "mode"); if (!POLICY_MODES.has(mode)) throw new Error("memory policy mode is unsupported");
    const minConfidence = text(args.min_confidence ?? "confirmed", "min_confidence");
    if (!POLICY_CONFIDENCE.has(minConfidence)) throw new Error("min_confidence must be confirmed or bounded");
    const updatedBy = noSecret(text(args.updated_by ?? "operator", "updated_by"), "updated_by");
    const identity = { mode, min_confidence: minConfidence, auto_commit: mode === "governed" };
    const existing = this.store.find("memory_policy", policyId);
    if (existing && existing.identity_digest === digest(identity)) return { policy: existing, idempotent: true };
    const payloadValue = { ...identity, updated_by: updatedBy, identity_digest: digest(identity), status: "active" };
    return { policy: existing
      ? this.store.save("memory_policy", policyId, { ...payload(existing), ...payloadValue, policy_revision: Number(existing.policy_revision ?? 1) + 1 })
      : this.store.create("memory_policy", policyId, { ...payloadValue, policy_revision: 1 }), idempotent: false };
  }

  propose(args: JsonObject): JsonObject {
    const policy = this.policyGet().policy as JsonObject;
    if (policy.mode === "off") return { candidate: null, conflicts: [], auto_committed: false, status: "disabled", policy };
    const kind = text(args.kind, "kind"); if (!KINDS.has(kind)) throw new Error("memory kind is unsupported");
    const scopeKind = text(args.scope_kind, "scope_kind"); if (!SCOPE.has(scopeKind)) throw new Error("scope_kind is unsupported");
    const scopeId = text(args.scope_id, "scope_id"); const content = noSecret(text(args.content, "content"), "content");
    const confidence = text(args.confidence ?? "unverified", "confidence"); if (!CONFIDENCE.has(confidence)) throw new Error("confidence is unsupported");
    const ids = evidenceIds(args.evidence_ids); ids.forEach((e) => this.store.get("evidence", e));
    const sourceId = text(args.source_id, "source_id"); this.store.get("knowledge_source", sourceId);
    let validUntil: string | null = null;
    if (args.valid_until !== undefined && args.valid_until !== null) { const parsed = new Date(text(args.valid_until, "valid_until")); if (Number.isNaN(parsed.valueOf())) throw new Error("valid_until must be an ISO timestamp"); validUntil = parsed.toISOString(); }
    if (validUntil === null && kind === "working") validUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    if (validUntil === null && kind === "episodic") validUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    if (kind === "procedural" && !ids.length) throw new Error("procedural memory requires Evidence");
    const identity = { source_id: sourceId, kind, scope: { kind: scopeKind, id: scopeId }, topic: String(args.topic ?? ""), content_digest: digest(content), sensitivity: String(args.sensitivity ?? "internal"), confidence, evidence_ids: ids, valid_until: validUntil };
    const candidateId = String(args.candidate_id ?? id("memory_candidate")); const existing = this.store.find("memory_candidate", candidateId);
    if (existing) { if (existing.identity_digest !== digest(identity)) throw new Error("Memory candidate idempotency conflict"); return { candidate: existing, idempotent: true }; }
    const conflicts = this.store.list("memory_candidate", 10_000, (item) => Boolean(item.status !== "rejected" && item.status !== "expired" && item.scope && JSON.stringify(item.scope) === JSON.stringify(identity.scope) && item.topic === identity.topic && item.content_digest !== identity.content_digest));
    const status = conflicts.length ? "conflict_pending" : "candidate";
    const candidate = this.store.create("memory_candidate", candidateId, { ...identity, content, status, conflict_ids: conflicts.map((x) => x.id), proposed_by: String(args.proposed_by ?? "agent"), identity_digest: digest(identity) });
    for (const conflict of conflicts) this.store.save("memory_candidate", String(conflict.id), { ...payload(conflict), status: "conflict_pending", conflict_ids: [...new Set([...(conflict.conflict_ids as string[] ?? []), candidate.id])] });
    const eligible = policy.mode === "governed" && conflicts.length === 0 && ids.length > 0 && ids.every((e) => {
      const confidenceValue = String(this.store.get("evidence", e).confidence);
      return policy.min_confidence === "bounded" ? ["bounded", "confirmed"].includes(confidenceValue) : confidenceValue === "confirmed";
    });
    if (eligible) {
      const approved = this.store.save("memory_candidate", candidateId, { ...payload(candidate), status: "approved", review: { reviewer: "governed-policy", reason_digest: digest("policy threshold"), reviewed_at: new Date().toISOString() } });
      const memory = this.remember({ candidate_id: approved.id }).memory as JsonObject;
      return { candidate: approved, conflicts, memory, auto_committed: true, idempotent: false, policy };
    }
    return { candidate, conflicts, auto_committed: false, idempotent: false, policy };
  }

  review(args: JsonObject): JsonObject {
    const candidate = this.store.get("memory_candidate", text(args.candidate_id, "candidate_id")); const decision = text(args.decision, "decision");
    if (!new Set(["approve", "reject"]).has(decision)) throw new Error("decision must be approve or reject");
    const reviewer = text(args.reviewer, "reviewer"); const reason = noSecret(text(args.reason, "reason"), "reason");
    if (decision === "approve") {
      const ids = candidate.evidence_ids as string[]; const trusted = ids.some((e) => ["bounded", "confirmed"].includes(String(this.store.get("evidence", e).confidence)));
      if (!trusted) throw new Error("Memory candidate approval requires bounded or confirmed Evidence");
      if (candidate.status === "conflict_pending") throw new Error("Resolve Memory conflict before approval");
    }
    const saved = this.store.save("memory_candidate", String(candidate.id), { ...payload(candidate), status: decision === "approve" ? "approved" : "rejected", review: { reviewer, reason_digest: digest(reason), reviewed_at: new Date().toISOString() } });
    return { candidate: saved };
  }

  remember(args: JsonObject): JsonObject {
    const candidate = this.store.get("memory_candidate", text(args.candidate_id, "candidate_id")); if (candidate.status !== "approved") throw new Error("Only approved Memory candidates can enter the Ledger");
    const result = this.ledger.remember({ memory_id: args.memory_id, source_id: candidate.source_id, kind: candidate.kind, scope_kind: (candidate.scope as JsonObject).kind, scope_id: (candidate.scope as JsonObject).id, content: candidate.content, sensitivity: candidate.sensitivity, confidence: candidate.confidence, evidence_ids: candidate.evidence_ids, valid_until: candidate.valid_until });
    const saved = this.store.save("memory_candidate", String(candidate.id), { ...payload(candidate), ledger_memory_id: (result.memory as JsonObject).id, status: "approved" });
    return { candidate: saved, memory: result.memory };
  }

  listConflicts(args: JsonObject = {}): JsonObject { return { conflicts: this.store.list("memory_candidate", Number(args.limit ?? 100), (x) => x.status === "conflict_pending") }; }
  resolveConflict(args: JsonObject): JsonObject {
    const candidate = this.store.get("memory_candidate", text(args.candidate_id, "candidate_id")); const resolution = text(args.resolution, "resolution");
    if (!new Set(["keep", "supersede", "dismiss"]).has(resolution)) throw new Error("resolution is unsupported");
    const reason = noSecret(text(args.reason, "reason"), "reason"); const conflictIds = Array.isArray(candidate.conflict_ids) ? candidate.conflict_ids as string[] : [];
    const saved = this.store.save("memory_candidate", String(candidate.id), { ...payload(candidate), status: resolution === "dismiss" ? "candidate" : "candidate", conflict_resolution: { resolution, actor: text(args.actor, "actor"), reason_digest: digest(reason), at: new Date().toISOString() }, conflict_ids: [] });
    for (const conflictId of conflictIds) { const other = this.store.find("memory_candidate", String(conflictId)); if (other) this.store.save("memory_candidate", String(other.id), { ...payload(other), conflict_ids: (other.conflict_ids as string[] ?? []).filter((x) => x !== candidate.id), status: "candidate" }); }
    return { candidate: saved };
  }

  expirySweep(args: JsonObject = {}): JsonObject {
    const now = new Date(args.now === undefined ? Date.now() : text(args.now, "now")); if (Number.isNaN(now.valueOf())) throw new Error("now must be an ISO timestamp"); const expired: JsonObject[] = [];
    for (const candidate of this.store.list("memory_candidate", 10_000, (x) => x.status === "candidate" || x.status === "approved")) if (candidate.valid_until && Date.parse(String(candidate.valid_until)) < now.valueOf()) expired.push(this.store.save("memory_candidate", String(candidate.id), { ...payload(candidate), status: "expired" }));
    for (const memory of this.store.list("memory_ledger", 10_000, (x) => Boolean(x.status === "active" && x.valid_until && Date.parse(String(x.valid_until)) < now.valueOf()))) expired.push(this.ledger.transition({ memory_id: memory.id, status: "expired", reason: "valid_until elapsed" }).memory as JsonObject);
    return { expired, count: expired.length, now: now.toISOString() };
  }

  sessionFinalize(args: JsonObject): JsonObject {
    const summary = noSecret(text(args.summary, "summary"), "summary"); const candidateIds = evidenceIds(args.candidate_ids); const candidates = candidateIds.map((candidateId) => this.store.get("memory_candidate", candidateId));
    return { session_id: text(args.session_id, "session_id"), summary_digest: digest(summary), candidates: candidates.map((candidate) => ({ candidate_id: candidate.id, status: candidate.status })) , content_free: true };
  }
  consolidate(args: JsonObject): JsonObject {
    const ids = evidenceIds(args.candidate_ids); if (ids.length < 2) throw new Error("candidate_ids must contain at least two ids"); const candidates = ids.map((candidateId) => this.store.get("memory_candidate", candidateId));
    if (candidates.some((candidate) => candidate.status !== "approved")) throw new Error("Only approved candidates can be consolidated");
    const consolidationId = String(args.consolidation_id ?? id("memory_consolidation")); const identity = { candidate_ids: ids, summary_digest: digest(noSecret(text(args.summary, "summary"), "summary")) }; const existing = this.store.find("memory_consolidation", consolidationId);
    if (existing) { if (existing.identity_digest !== digest(identity)) throw new Error("Memory consolidation idempotency conflict"); return { consolidation: existing, idempotent: true }; }
    return { consolidation: this.store.create("memory_consolidation", consolidationId, { ...identity, identity_digest: digest(identity), status: "candidate", ledger_memory_id: null, content_free: true }), idempotent: false };
  }
}
