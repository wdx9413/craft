import { randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "../../src/infrastructure/store.ts";
import { object, optionalScope } from "../../src/validation.ts";
import { stableDigest, payload } from "../../src/digest.ts";

const OBSERVATION_KINDS = new Set(["success", "failure", "correction"]);
const PATTERN_KINDS = new Set(["success_strategy", "failure_pattern"]);
const AXES = new Set(["context", "tools", "generation", "orchestration", "memory", "output"]);
const SUBJECT_KINDS = new Set(["workflow", "harness_refinement", "capability_asset", "activation_profile"]);
const SOURCES = new Set(["verified_work_loop_receipt", "outcome", "acceptance_gate", "trace"]);
const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{8,}/iu;

function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); const result = value.trim(); if (SECRET.test(result)) throw new Error(`${name} must not contain credentials or secrets`); return result; }


/**
 * Keeps diagnostic experience separate from active instructions.  It retains
 * rejected intervention evidence, but grants neither routing nor write power.
 */
export class ExperienceLedgerKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  observe(args: JsonObject): JsonObject {
    const source = this.reference(args.source_ref, "source_ref", SOURCES); const kind = text(args.kind, "kind"); if (!OBSERVATION_KINDS.has(kind)) throw new Error("Experience observation kind is unsupported");
    const scope = optionalScope(args);
    const evidenceIds = this.evidenceIds(args.evidence_ids); const identity = { source, kind, scenario_key: text(args.scenario_key, "scenario_key"), ...(scope ? { scope } : {}), finding_digest: stableDigest(text(args.finding, "finding")), evidence_ids: evidenceIds, content_free: true };
    const observationId = String(args.observation_id ?? `experience_observation_${stableDigest(identity).slice(-20)}`); const existing = this.store.find("experience_observation", observationId); const identityDigest = stableDigest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Experience observation idempotency conflict"); return { observation: existing, idempotent: true }; }
    return { observation: this.store.create("experience_observation", observationId, { ...identity, identity_digest: identityDigest, status: "recorded" }), idempotent: false };
  }

  compile(args: JsonObject): JsonObject {
    const scenarioKey = text(args.scenario_key, "scenario_key"); const ids = this.ids(args.observation_ids, "observation_ids", 2);
    const observations = ids.map((id) => this.store.get("experience_observation", id)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    if (observations.some((item) => item.scenario_key !== scenarioKey || item.status !== "recorded")) throw new Error("Experience observations do not match the scenario");
    const scopes = new Set(observations.map((item) => stableDigest(item.scope ?? null)));
    if (scopes.size !== 1) throw new Error("Experience observations do not share one scope");
    if (new Set(observations.map((item) => `${(item.source as JsonObject).kind}:${(item.source as JsonObject).id}:${(item.source as JsonObject).version}`)).size < 2) throw new Error("Experience patterns require independent source records");
    const kind = text(args.kind, "kind"); if (!PATTERN_KINDS.has(kind)) throw new Error("Experience pattern kind is unsupported");
    const scope = observations[0]!.scope;
    const identity = { scenario_key: scenarioKey, kind, ...(scope ? { scope } : {}), observation_refs: observations.map((item) => ({ id: item.id, version: item.version })), hypothesis_digest: stableDigest(text(args.hypothesis, "hypothesis")), applicability_digest: stableDigest(text(args.applicability, "applicability")), counterexample_digest: stableDigest(text(args.counterexample, "counterexample")), evidence_ids: [...new Set(observations.flatMap((item) => item.evidence_ids as string[]))].sort(), content_free: true };
    const patternId = String(args.pattern_id ?? `experience_pattern_${stableDigest(identity).slice(-20)}`); const existing = this.store.find("experience_pattern", patternId); const identityDigest = stableDigest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Experience pattern idempotency conflict"); return { pattern: existing, idempotent: true }; }
    return { pattern: this.store.create("experience_pattern", patternId, { ...identity, identity_digest: identityDigest, status: "diagnostic_only", execution_visible: false }), idempotent: false };
  }

  propose(args: JsonObject): JsonObject {
    const patterns = this.ids(args.pattern_ids, "pattern_ids", 1).map((id) => this.store.get("experience_pattern", id));
    const subject = this.reference(args.subject_ref, "subject_ref", SUBJECT_KINDS); const axes = this.ids(args.design_axes, "design_axes", 1);
    if (axes.length > 2 || axes.some((axis) => !AXES.has(axis))) throw new Error("Experience intervention may change at most two design axes");
    const identity = { pattern_refs: patterns.map((item) => ({ id: item.id, version: item.version })), subject, design_axes: axes, diff_digest: stableDigest(text(args.diff_summary, "diff_summary")), hypothesis_digest: stableDigest(text(args.hypothesis, "hypothesis")), lifecycle: "draft", execution_visible: false };
    const interventionId = String(args.intervention_id ?? `experience_intervention_${randomUUID().replaceAll("-", "")}`); const existing = this.store.find("experience_intervention", interventionId); const identityDigest = stableDigest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Experience intervention idempotency conflict"); return { intervention: existing, idempotent: true }; }
    return { intervention: this.store.create("experience_intervention", interventionId, { ...identity, identity_digest: identityDigest, evaluation_status: "not_run", publication_allowed: false }), idempotent: false, next_action: "run_shadow_evaluation" };
  }

  evaluate(args: JsonObject): JsonObject {
    const intervention = this.store.get("experience_intervention", text(args.intervention_id, "intervention_id")); if (intervention.lifecycle !== "draft") throw new Error("Only a draft Experience intervention can be evaluated");
    const assessment = this.store.get("evaluation_reliability", text(args.assessment_id, "assessment_id")); const status = String(assessment.status);
    if (!new Set(["eligible", "rejected", "inconclusive"]).has(status)) throw new Error("Experience assessment status is unsupported");
    const lifecycle = status === "eligible" ? "signoff_required" : status === "rejected" ? "rejected" : "inconclusive";
    return { intervention: this.store.save("experience_intervention", String(intervention.id), { ...payload(intervention), lifecycle, evaluation_status: status, assessment_id: assessment.id, assessment_version: assessment.version, publication_allowed: false, retry_condition_digest: status === "rejected" ? stableDigest(text(args.retry_condition, "retry_condition")) : null }) };
  }

  decide(args: JsonObject): JsonObject {
    const intervention = this.store.get("experience_intervention", text(args.intervention_id, "intervention_id")); const decision = text(args.decision, "decision");
    if (!new Set(["accept", "reject"]).has(decision)) throw new Error("Experience intervention decision is unsupported");
    if (decision === "accept") {
      if (intervention.lifecycle !== "signoff_required") throw new Error("Experience intervention is not ready for Signoff");
      const signoff = this.store.get("signoff", text(args.signoff_id, "signoff_id"));
      if (signoff.decision !== "passed" || signoff.subject_type !== "experience_intervention" || signoff.subject_id !== intervention.id || Number(signoff.subject_version) !== Number(intervention.version)) throw new Error("Experience intervention requires exact passed Signoff");
    }
    if (decision === "reject" && intervention.lifecycle === "accepted") throw new Error("Accepted Experience intervention cannot be rejected without rollback");
    const lifecycle = decision === "accept" ? "accepted" : "rejected";
    const saved = this.store.save("experience_intervention", String(intervention.id), { ...payload(intervention), lifecycle, publication_allowed: false, decision_reason_digest: stableDigest(text(args.reason, "reason")), signoff_id: decision === "accept" ? text(args.signoff_id, "signoff_id") : null, retry_condition_digest: decision === "reject" ? stableDigest(text(args.retry_condition, "retry_condition")) : intervention.retry_condition_digest ?? null });
    return { intervention: saved, active_asset_changed: false, next_action: lifecycle === "accepted" ? "create_or_link_existing_governed_candidate" : "retain_rejected_evidence" };
  }

  get(args: JsonObject): JsonObject {
    const intervention = this.store.get("experience_intervention", text(args.intervention_id, "intervention_id"));
    return { intervention, patterns: (intervention.pattern_refs as JsonObject[]).map((item) => this.store.get("experience_pattern", String(item.id), Number(item.version))) };
  }

  private reference(value: unknown, name: string, allowed: Set<string>): JsonObject {
    const input = object(value, name); const kind = text(input.kind, `${name}.kind`); if (!allowed.has(kind)) throw new Error(`${name}.kind is unsupported`);
    const id = text(input.id, `${name}.id`); const version = Number(input.version); if (!Number.isInteger(version) || version < 1) throw new Error(`${name}.version must be a positive integer`);
    this.store.get(kind, id, version); return { kind, id, version };
  }
  private ids(value: unknown, name: string, minimum: number): string[] {
    if (!Array.isArray(value) || value.length < minimum) throw new Error(`${name} must contain at least ${minimum} values`);
    const values = value.map((item) => text(item, name)); if (new Set(values).size !== values.length) throw new Error(`${name} must contain unique values`); return values.sort();
  }
  private evidenceIds(value: unknown): string[] { const ids = this.ids(value, "evidence_ids", 1); for (const id of ids) if (!new Set(["confirmed", "bounded"]).has(String(this.store.get("evidence", id).confidence))) throw new Error("Experience Evidence must be confirmed or bounded"); return ids; }
}
