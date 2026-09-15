import { createHash, randomUUID } from "node:crypto";
import type { JsonObject } from "./store.ts";
import { CraftStore } from "./store.ts";

function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function payload(record: JsonObject): JsonObject { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
function unique(value: unknown, name: string, exact?: number): string[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${name} must be a non-empty array`);
  const values = value.map((item) => text(item, name)); if (new Set(values).size !== values.length || exact !== undefined && values.length !== exact) throw new Error(`${name} must contain exactly ${exact ?? "unique"} values`);
  return values.sort();
}
function integer(value: unknown, name: string, minimum: number, maximum: number): number { const result = Number(value); if (!Number.isInteger(result) || result < minimum || result > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`); return result; }

/**
 * A small product-proof protocol. It does not execute a model; it makes a
 * real Host session and an independent observed outcome mandatory before a
 * Harness result can count.  The five-trial promotion rule is intentionally
 * strict; 3–4 trial experiments remain diagnostic/inconclusive.
 */
export class RuntimeAcceptanceKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  plan(args: JsonObject): JsonObject {
    const caseIds = unique(args.case_ids, "case_ids", 2); const hostIds = unique(args.host_ids, "host_ids", 2);
    const trials = integer(args.trials_per_pair, "trials_per_pair", 3, 5);
    const identity = { case_ids: caseIds, host_ids: hostIds, baseline_harness: text(args.baseline_harness, "baseline_harness"), candidate_harness: text(args.candidate_harness, "candidate_harness"), environment_fingerprint: text(args.environment_fingerprint, "environment_fingerprint"), budget_fingerprint: text(args.budget_fingerprint, "budget_fingerprint"), trials_per_pair: trials, observer_kind: text(args.observer_kind, "observer_kind") };
    if (identity.baseline_harness === identity.candidate_harness) throw new Error("Runtime acceptance candidate must differ from baseline");
    const planId = String(args.plan_id ?? `runtime_acceptance_${randomUUID().replaceAll("-", "")}`); const existing = this.store.find("runtime_acceptance_plan", planId); const planDigest = digest(identity);
    if (existing) { if (existing.plan_digest !== planDigest) throw new Error("Runtime acceptance plan idempotency conflict"); return { plan: existing, idempotent: true }; }
    return { plan: this.store.create("runtime_acceptance_plan", planId, { ...identity, plan_digest: planDigest, status: "collecting", raw_case_content_stored: false }), idempotent: false };
  }

  record(args: JsonObject): JsonObject {
    const plan = this.store.get("runtime_acceptance_plan", text(args.plan_id, "plan_id")); if (plan.status !== "collecting") throw new Error("Runtime acceptance plan is not collecting observations");
    const hostId = text(args.host_id, "host_id"); if (!(plan.host_ids as string[]).includes(hostId)) throw new Error("Runtime acceptance Host is not in the plan");
    const caseId = text(args.case_id, "case_id"); if (!(plan.case_ids as string[]).includes(caseId)) throw new Error("Runtime acceptance Case is not in the plan");
    const arm = text(args.arm, "arm"); if (arm !== "baseline" && arm !== "candidate") throw new Error("Runtime acceptance arm is unsupported");
    const harness = arm === "baseline" ? plan.baseline_harness : plan.candidate_harness; if (text(args.harness, "harness") !== harness) throw new Error("Runtime acceptance Harness does not match the selected arm");
    const trialIndex = integer(args.trial_index, "trial_index", 1, Number(plan.trials_per_pair));
    if (text(args.environment_fingerprint, "environment_fingerprint") !== plan.environment_fingerprint || text(args.budget_fingerprint, "budget_fingerprint") !== plan.budget_fingerprint) throw new Error("Runtime acceptance environment or budget does not match");
    const session = this.store.get("host_session", text(args.host_session_id, "host_session_id")); if (session.host_id !== hostId || session.environment_fingerprint !== plan.environment_fingerprint) throw new Error("Runtime acceptance Host Session does not match");
    const observation = this.store.get("outcome_observation", text(args.observation_id, "observation_id"));
    if (observation.trace_id !== session.trace_id || observation.host_id !== hostId || observation.observer_kind !== plan.observer_kind || observation.observer_id === hostId) throw new Error("Runtime acceptance Outcome Observation is not independent or does not match the Host Session");
    const identity = { plan_id: plan.id, plan_version: plan.version, host_id: hostId, case_id: caseId, arm, harness, trial_index: trialIndex, host_session_id: session.id, host_session_version: session.version, observation_id: observation.id, observation_version: observation.version, verdict: observation.verdict };
    const recordId = String(args.record_id ?? `runtime_acceptance_record_${plan.id}_${hostId}_${caseId}_${arm}_${trialIndex}`); const recordDigest = digest(identity); const existing = this.store.find("runtime_acceptance_record", recordId);
    if (existing) { if (existing.record_digest !== recordDigest) throw new Error("Runtime acceptance record idempotency conflict"); return { record: existing, idempotent: true }; }
    const duplicate = this.store.list("runtime_acceptance_record", 10_000, (item) => item.plan_id === plan.id && item.host_id === hostId && item.case_id === caseId && item.arm === arm && item.trial_index === trialIndex)[0];
    if (duplicate) throw new Error("Runtime acceptance slot is already recorded");
    return { record: this.store.create("runtime_acceptance_record", recordId, { ...identity, record_digest: recordDigest }), idempotent: false };
  }

  evaluate(args: JsonObject): JsonObject {
    const plan = this.store.get("runtime_acceptance_plan", text(args.plan_id, "plan_id")); const records = this.store.list("runtime_acceptance_record", 10_000, (item) => item.plan_id === plan.id);
    const pairs = (plan.host_ids as string[]).flatMap((host) => (plan.case_ids as string[]).flatMap((caseId) => Array.from({ length: Number(plan.trials_per_pair) }, (_, index) => ({ host, caseId, trial: index + 1 }))));
    let candidateWins = 0; let baselineWins = 0; let ties = 0; let incomplete = 0;
    for (const pair of pairs) {
      const select = (arm: string) => records.find((record) => record.host_id === pair.host && record.case_id === pair.caseId && record.trial_index === pair.trial && record.arm === arm);
      const baseline = select("baseline"); const candidate = select("candidate");
      if (!baseline || !candidate) { incomplete += 1; continue; }
      const basePassed = baseline.verdict === "passed"; const candidatePassed = candidate.verdict === "passed";
      if (candidatePassed && !basePassed) candidateWins += 1; else if (basePassed && !candidatePassed) baselineWins += 1; else ties += 1;
    }
    const total = pairs.length; const complete = incomplete === 0; const strictProof = Number(plan.trials_per_pair) === 5 && candidateWins === total && baselineWins === 0;
    const status = !complete ? "inconclusive" : strictProof ? "eligible" : baselineWins >= candidateWins ? "rejected" : "inconclusive";
    const evaluationId = String(args.evaluation_id ?? `runtime_acceptance_evaluation_${plan.id}`); const identity = { plan_id: plan.id, plan_version: plan.version, total_pairs: total, candidate_wins: candidateWins, baseline_wins: baselineWins, ties, incomplete, status };
    const existing = this.store.find("runtime_acceptance_evaluation", evaluationId); const evaluationDigest = digest(identity);
    if (existing) { if (existing.evaluation_digest !== evaluationDigest) throw new Error("Runtime acceptance evaluation idempotency conflict"); return { evaluation: existing, idempotent: true }; }
    const evaluation = this.store.create("runtime_acceptance_evaluation", evaluationId, { ...identity, evaluation_digest: evaluationDigest, candidate_default_activation_permitted: status === "eligible" });
    const saved = this.store.save("runtime_acceptance_plan", String(plan.id), { ...payload(plan), status: "evaluated", latest_evaluation_id: evaluation.id });
    return { plan: saved, evaluation, idempotent: false };
  }

  get(args: JsonObject): JsonObject { const plan = this.store.get("runtime_acceptance_plan", text(args.plan_id, "plan_id")); return { plan, records: this.store.list("runtime_acceptance_record", 10_000, (item) => item.plan_id === plan.id), evaluation: plan.latest_evaluation_id ? this.store.get("runtime_acceptance_evaluation", String(plan.latest_evaluation_id)) : null }; }
}
