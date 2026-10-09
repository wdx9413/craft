import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { digestJson } from "../../common/craft-common-base/src/digest.ts";
import { text } from "../../common/craft-common-base/src/validation.ts";
import type { MemoryGovernanceKernel } from "./memory-governance.ts";

/** The host supplies Evidence/source ports; this package never imports a harness. */
export class MemoryCapture {
  readonly memory: MemoryGovernanceKernel;
  readonly bootstrap: () => unknown;
  readonly evidenceRecord: (args: JsonObject) => JsonObject;
  constructor(memory: MemoryGovernanceKernel, bootstrap: () => unknown, evidenceRecord: (args: JsonObject) => JsonObject) { this.memory = memory; this.bootstrap = bootstrap; this.evidenceRecord = evidenceRecord; }
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
    const hints = topic === undefined && kind === "preference" ? (this.memory.topicSuggestions({ ...args, content, scope_kind: scopeKind, scope_id: scopeId }).suggestions as JsonObject[]).filter(hint => hint.content_digest !== digestJson(content)) : [];
    this.bootstrap();
    const captureIdentity = { kind, scope_kind: scopeKind, scope_id: scopeId, topic: topic ?? null, content_digest: digestJson(content) };
    const suffix = digestJson(captureIdentity).slice(-20);
    const evidence = this.evidenceRecord({ evidence_id: String(args.evidence_id ?? `evidence_memory_statement_${suffix}`), source_type: "human", confidence: "bounded",
      claim: "Explicit user statement captured for governed Memory.", locator: `memory-capture:${scopeKind}:${scopeId}`, metadata: { capture_digest: digestJson(captureIdentity), user_authored: true } });
    const proposed = this.memory.propose({ candidate_id: String(args.candidate_id ?? `memory_candidate_statement_${suffix}`), source_id: "builtin.evidence-wiki", kind,
      scope_kind: scopeKind, scope_id: scopeId, ...(args.scope_envelope === undefined ? {} : { scope_envelope: args.scope_envelope }), ...(topic === undefined ? {} : { topic }), content, sensitivity: args.sensitivity ?? "internal", confidence: "bounded",
      proposal_only: hints.length > 0, evidence_ids: [evidence.id], proposed_by: "explicit-user-statement", valid_until: args.valid_until });
    const retainedCandidate = proposed.candidate as JsonObject;
    if (proposed.idempotent === true && retainedCandidate.ledger_memory_id) {
      const retained = this.memory.ledger.get({ ...args, scope_kind: scopeKind, scope_id: scopeId, memory_id: retainedCandidate.ledger_memory_id }).memory as JsonObject;
      if (retained.status === "active") return { ...proposed, memory: retained, evidence, already_retained: true, auto_committed: false, next_action: "available_for_scoped_context" };
    }
    if (hints.length > 0) return { ...proposed, evidence, topic_suggestions: hints, auto_committed: false, next_action: "confirm_topic_or_explicit_replacement" };
    // Governed policy can already approve and commit; neither deny that fact nor commit twice.
    if (proposed.auto_committed === true) return { ...proposed, evidence, next_action: "available_for_scoped_context" };
    const candidate = proposed.candidate as JsonObject;
    if (args.auto_accept !== true || candidate.status !== "candidate") return { ...proposed, evidence, auto_committed: false,
      next_action: candidate.status === "conflict_pending" ? "resolve_conflict" : "review_or_accept" };
    const reviewed = this.memory.review({ candidate_id: candidate.id, decision: "approve", reviewer: "automated-user-statement-review", reason: "Direct user statement with bounded Evidence." }).candidate as JsonObject;
    const remembered = this.memory.remember({ candidate_id: reviewed.id, memory_id: args.memory_id }).memory as JsonObject;
    return { candidate: reviewed, memory: remembered, evidence, auto_committed: true, next_action: "available_for_scoped_context" };
  }

}
