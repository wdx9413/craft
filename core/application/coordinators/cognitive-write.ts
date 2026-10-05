import type { CraftStore, JsonObject } from "../../infrastructure/store.ts";
import type { KnowledgeSourceRegistry } from "../../../capability/craft-knowledge/knowledge-source-registry.ts";
import type { MemoryGovernanceKernel } from "../../memory-governance.ts";
import { digestJson } from "../../digest.ts";
import { text } from "../../validation.ts";

type Command = (args: JsonObject) => JsonObject;

/** Owns the capture/revalidation sequence; existing kernels retain their gates. */
export class CognitiveWriteCoordinator {
  readonly store: CraftStore;
  readonly sources: KnowledgeSourceRegistry;
  readonly memory: MemoryGovernanceKernel;
  readonly evidenceRecord: Command;
  readonly reviewClaim: Command;
  constructor(store: CraftStore, sources: KnowledgeSourceRegistry, memory: MemoryGovernanceKernel, evidenceRecord: Command, reviewClaim: Command) {
    this.store = store; this.sources = sources; this.memory = memory; this.evidenceRecord = evidenceRecord; this.reviewClaim = reviewClaim;
  }

  captureUserStatement(args: JsonObject): JsonObject {
    if (args.explicit_consent !== true) throw new Error("Explicit user consent is required to capture durable Memory");
    if (typeof args.content !== "string" || !args.content.trim()) throw new Error("content must not be empty");
    const content = args.content;
    if (/(?:api[_-]?key|authorization|cookie|password|secret|token)["']?\s*[:=]\s*[^\s]+/iu.test(content)) throw new Error("content must not contain sensitive assignments");
    const kind = String(args.kind ?? "preference");
    if (!new Set(["working", "episodic", "preference", "procedural"]).has(kind)) throw new Error("Memory capture kind is unsupported");
    const scopeKind = text(args.scope_kind ?? "user", "scope_kind"); const scopeId = text(args.scope_id ?? "local", "scope_id");
    const topic = args.topic === undefined ? undefined : text(args.topic, "topic");
    const policy = this.memory.policyGet().policy as JsonObject;
    // Disabled capture is a read-only decision, not a partial source/Evidence write.
    if (policy.mode === "off") return { candidate: null, conflicts: [], auto_committed: false, status: "disabled", policy, next_action: "memory_disabled" };
    this.sources.installBuiltins();
    const captureIdentity = { kind, scope_kind: scopeKind, scope_id: scopeId, topic: topic ?? null, content_digest: digestJson(content) };
    const suffix = digestJson(captureIdentity).slice(-20);
    const evidence = this.evidenceRecord({ evidence_id: String(args.evidence_id ?? `evidence_memory_statement_${suffix}`), source_type: "human", confidence: "bounded",
      claim: "Explicit user statement captured for governed Memory.", locator: `memory-capture:${scopeKind}:${scopeId}`, metadata: { capture_digest: digestJson(captureIdentity), user_authored: true } });
    const proposed = this.memory.propose({ candidate_id: String(args.candidate_id ?? `memory_candidate_statement_${suffix}`), source_id: "builtin.evidence-wiki", kind,
      scope_kind: scopeKind, scope_id: scopeId, ...(args.scope_envelope === undefined ? {} : { scope_envelope: args.scope_envelope }), ...(topic === undefined ? {} : { topic }), content, sensitivity: args.sensitivity ?? "internal", confidence: "bounded",
      evidence_ids: [evidence.id], proposed_by: "explicit-user-statement", valid_until: args.valid_until });
    // Governed policy can already approve and commit; neither deny that fact nor commit twice.
    if (proposed.auto_committed === true) return { ...proposed, evidence, next_action: "available_for_scoped_context" };
    const candidate = proposed.candidate as JsonObject;
    if (args.auto_accept !== true || candidate.status !== "candidate") return { ...proposed, evidence, auto_committed: false,
      next_action: candidate.status === "conflict_pending" ? "resolve_conflict" : "review_or_accept" };
    const reviewed = this.memory.review({ candidate_id: candidate.id, decision: "approve", reviewer: "automated-user-statement-review", reason: "Direct user statement with bounded Evidence." }).candidate as JsonObject;
    const remembered = this.memory.remember({ candidate_id: reviewed.id, memory_id: args.memory_id }).memory as JsonObject;
    return { candidate: reviewed, memory: remembered, evidence, auto_committed: true, next_action: "available_for_scoped_context" };
  }

  sweepExpiredClaims(args: JsonObject = {}): JsonObject {
    const now = new Date(args.now === undefined ? Date.now() : text(args.now, "now"));
    if (Number.isNaN(now.valueOf())) throw new Error("now must be an ISO timestamp");
    const expired: JsonObject[] = [];
    for (const claim of this.store.list("knowledge_claim", 10_000, (x) => x.status === "reviewed" && Boolean(x.valid_until) && Date.parse(String(x.valid_until)) < now.valueOf())) {
      const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...payload } = claim;
      if (payload.content_ref !== undefined) delete payload.content;
      expired.push(this.store.save("knowledge_claim", String(claim.id), { ...payload, status: "expired", expiry_reason_digest: digestJson("valid_until elapsed") }));
    }
    return { expired, count: expired.length, now: now.toISOString() };
  }

  resolveClaimConflict(args: JsonObject): JsonObject {
    const claim = this.store.get("knowledge_claim", text(args.claim_id, "claim_id"));
    const decision = text(args.decision, "decision");
    if (!new Set(["reviewed", "disputed", "superseded"]).has(decision)) throw new Error("knowledge conflict decision is unsupported");
    if (decision === "reviewed") {
      const ids = Array.isArray(claim.evidence_ids) ? claim.evidence_ids as unknown[] : [];
      if (!ids.some((e) => ["bounded", "confirmed"].includes(String(this.store.get("evidence", String(e)).confidence)))) throw new Error("Conflict resolution requires bounded or confirmed Evidence");
    }
    return this.reviewClaim({ claim_id: claim.id, status: decision, reviewer: args.reviewer, reason: args.reason });
  }
}
