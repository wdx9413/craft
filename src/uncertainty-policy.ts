import { createHash, randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

const SCOPES = ["core", "global", "project", "task", "case"] as const;
const MODES = new Set(["observe_only", "supervised", "bounded_autonomous", "autonomous", "locked"]);
const ACTIONS = new Set(["collecting", "human_required", "abstained", "unchanged", "rejected", "blocked"]);
const ESCALATIONS = new Set(["deterministic_check", "approved_model", "independent_evaluator", "authorized_context", "readonly_expert", "additional_trial"]);
function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function finite(value: unknown, name: string, fallback: number): number { const result = value === undefined ? fallback : Number(value); if (!Number.isFinite(result) || result < 0 || result > 1) throw new Error(`${name} must be between 0 and 1`); return result; }
function integer(value: unknown, name: string, fallback: number): number { const result = value === undefined ? fallback : Number(value); if (!Number.isInteger(result) || result < 0 || result > 100) throw new Error(`${name} must be an integer between 0 and 100`); return result; }
function strings(value: unknown, name: string): string[] { if (!Array.isArray(value)) throw new Error(`${name} must be an array`); const result = value.map((item) => text(item, name)); if (new Set(result).size !== result.length) throw new Error(`${name} must contain unique values`); return result.sort(); }
function payload(record: JsonObject): JsonObject { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }

export class UncertaintyPolicyKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  save(args: JsonObject): JsonObject {
    const scope = text(args.scope, "scope"); const rank = SCOPES.indexOf(scope as typeof SCOPES[number]); if (rank < 0) throw new Error("Uncertainty Policy scope is unsupported");
    const mode = text(args.mode ?? "bounded_autonomous", "mode"); if (!MODES.has(mode)) throw new Error("Uncertainty Policy mode is unsupported");
    const onUncertain = text(args.on_uncertain ?? (mode === "supervised" ? "human_required" : "collecting"), "on_uncertain"); if (!ACTIONS.has(onUncertain)) throw new Error("Uncertainty Policy action is unsupported");
    const fallback = text(args.fallback ?? "unchanged", "fallback"); if (!ACTIONS.has(fallback) || fallback === "collecting") throw new Error("Uncertainty Policy fallback is unsupported");
    const escalations = strings(args.escalations ?? [], "escalations"); if (escalations.some((item) => !ESCALATIONS.has(item))) throw new Error("Uncertainty Policy escalation is unsupported");
    const identity = { scope, scope_id: text(args.scope_id ?? scope, "scope_id"), mode, on_uncertain: onUncertain, fallback, confidence_threshold: finite(args.confidence_threshold, "confidence_threshold", 0.8), consistency_threshold: finite(args.consistency_threshold, "consistency_threshold", 0.8), max_attempts: integer(args.max_attempts, "max_attempts", 2), escalations, human_fallback: args.human_fallback === true, core_safety_floor: scope === "core" };
    if (mode === "autonomous" && onUncertain === "human_required" && !identity.human_fallback) throw new Error("Autonomous Policy cannot require a disabled human fallback");
    const policyId = String(args.policy_id ?? `uncertainty_policy_${scope}_${identity.scope_id}`); const identityDigest = digest(identity); const existing = this.store.find("uncertainty_policy", policyId);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Uncertainty Policy idempotency conflict"); return { policy: existing, idempotent: true }; }
    return { policy: this.store.create("uncertainty_policy", policyId, { ...identity, rank, identity_digest: identityDigest }), idempotent: false };
  }

  resolve(args: JsonObject): JsonObject {
    const ids = strings(args.policy_ids, "policy_ids"); if (!ids.length) throw new Error("policy_ids must include a Core Safety Floor");
    const policies = ids.map((id) => this.store.get("uncertainty_policy", id)).sort((a, b) => Number(a.rank) - Number(b.rank));
    if (policies[0]?.scope !== "core" || new Set(policies.map((item) => item.scope)).size !== policies.length) throw new Error("Uncertainty Policy chain must start with one Core Safety Floor and contain unique scopes");
    for (let index = 1; index < policies.length; index += 1) if (Number(policies[index]!.rank) <= Number(policies[index - 1]!.rank)) throw new Error("Uncertainty Policy chain scope order is invalid");
    const effective = Object.assign({}, ...policies.map((item) => payload(item))); const confidence = finite(args.confidence, "confidence", 0); const consistency = finite(args.consistency, "consistency", 0);
    const evidence = strings(args.evidence_confidences ?? [], "evidence_confidences"); const missing = evidence.length === 0 || evidence.some((item) => item === "unverified"); const conflict = args.conflict === true; const hard = args.safety_floor_violation === true;
    const uncertain = missing || conflict || confidence < Number(effective.confidence_threshold) || consistency < Number(effective.consistency_threshold); const attempt = integer(args.attempt, "attempt", 0);
    let status = hard ? "blocked" : uncertain ? String(effective.on_uncertain) : "unchanged";
    if (status === "human_required" && effective.human_fallback !== true) status = String(effective.fallback);
    if (status === "collecting" && (attempt >= Number(effective.max_attempts) || (effective.escalations as string[]).length === 0)) status = String(effective.fallback);
    if (!ACTIONS.has(status)) throw new Error("Resolved uncertainty status is unsupported");
    const identity = { policy_refs: policies.map((item) => ({ id: item.id, version: item.version })), subject_ref: text(args.subject_ref, "subject_ref"), confidence, consistency, evidence_confidences: evidence, conflict, safety_floor_violation: hard, attempt, status };
    const resolutionId = String(args.resolution_id ?? `uncertainty_resolution_${digest(identity).slice(-16)}`); const identityDigest = digest(identity); const existing = this.store.find("uncertainty_resolution", resolutionId);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Uncertainty Resolution idempotency conflict"); return { resolution: existing, idempotent: true }; }
    const next = status === "collecting" ? (effective.escalations as string[]).slice(0, 1) : [];
    return { resolution: this.store.create("uncertainty_resolution", resolutionId, { ...identity, identity_digest: identityDigest, mode: effective.mode, next_escalations: next, execution_authority: false }), idempotent: false };
  }

  adjudicate(args: JsonObject): JsonObject {
    const resolution = this.store.get("uncertainty_resolution", text(args.resolution_id, "resolution_id")); if (resolution.safety_floor_violation === true) throw new Error("Adjudication cannot override the Core Safety Floor");
    if (!new Set(["human_required", "abstained", "unchanged"]).has(String(resolution.status))) throw new Error("Uncertainty Resolution is not eligible for Adjudication");
    const decision = text(args.decision, "decision"); if (!new Set(["accepted", "rejected", "blocked", "unchanged"]).has(decision)) throw new Error("Adjudication decision is unsupported");
    const evidenceIds = strings(args.evidence_ids, "evidence_ids"); if (!evidenceIds.length) throw new Error("Adjudication requires Evidence");
    for (const id of evidenceIds) if (!new Set(["confirmed", "bounded"]).has(String(this.store.get("evidence", id).confidence))) throw new Error("Adjudication Evidence must be confirmed or bounded");
    const identity = { resolution_id: resolution.id, resolution_version: resolution.version, decision, actor: text(args.actor, "actor"), reason: text(args.reason, "reason"), scope: text(args.scope, "scope"), valid_until: text(args.valid_until, "valid_until"), evidence_ids: evidenceIds };
    const adjudicationId = String(args.adjudication_id ?? `adjudication_${randomUUID().replaceAll("-", "")}`); const identityDigest = digest(identity); const existing = this.store.find("adjudication", adjudicationId);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Adjudication idempotency conflict"); return { adjudication: existing, idempotent: true }; }
    return { adjudication: this.store.create("adjudication", adjudicationId, { ...identity, identity_digest: identityDigest, preserves_conflicting_evidence: true, overrides_safety_floor: false }), idempotent: false };
  }
}
