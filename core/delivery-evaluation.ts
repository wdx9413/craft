import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { text } from "./validation.ts";
import { digestJson } from "./digest.ts";
import { workDeliveryStatus } from "./work-delivery.ts";


function items(value: unknown): JsonObject[] { if (!Array.isArray(value) || !value.length || value.some((item) => item === null || typeof item !== "object" || Array.isArray(item))) throw new Error("items must be a non-empty object array"); return value as JsonObject[]; }
function positiveInteger(value: unknown, name: string, fallback: number): number { const parsed = value === undefined ? fallback : Number(value); if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw new Error(`${name} must be an integer between 1 and 100`); return parsed; }

function outcome(store: CraftStore, delivery: JsonObject): JsonObject { const launch = store.get("work_launch", String(delivery.launch_id)); const value = launch.trial_id ? store.find("outcome", `outcome_${launch.trial_id}`) : null; if (!value) throw new Error("Delivery has no Host Outcome"); return value; }
function quality(status: unknown): number | null {
  if (status === "accepted") return 1;
  if (status === "rejected" || status === "host_failed") return 0;
  return null; // Prepared, blocked or unassessed is not a measured business outcome.
}

/** Revalidate every stored comparison and its bound revisions before use. */
export function assertDeliveryEvaluationCurrent(store: CraftStore, run: JsonObject): void {
  const refs = run.comparison_versions;
  const ids = run.comparison_ids;
  if (!Array.isArray(refs) || !refs.length || !Array.isArray(ids) || refs.length !== ids.length
    || new Set(ids).size !== ids.length) throw new Error("Delivery evaluation has no complete comparison bindings");
  const seen = new Set<string>();
  const deliveries = new Set<string>(), launches = new Set<string>(), outcomes = new Set<string>();
  const comparisons: JsonObject[] = [];
  for (const value of refs) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Delivery evaluation comparison binding is invalid");
    const ref = value as JsonObject;
    if (typeof ref.id !== "string" || !ids.includes(ref.id) || seen.has(ref.id) || !Number.isSafeInteger(ref.version)) throw new Error("Delivery evaluation comparison binding is invalid");
    seen.add(ref.id);
    const comparison = store.find("delivery_evaluation_comparison", ref.id, undefined, false);
    if (!comparison || comparison.version !== ref.version) throw new Error("Delivery evaluation comparison changed");
    comparisons.push(comparison);
    const checks = [["delivery_evaluation_case", "case"], ["work_delivery", "baseline_delivery"], ["work_delivery", "candidate_delivery"],
      ["outcome", "baseline_outcome"], ["outcome", "candidate_outcome"]] as const;
    for (const [kind, prefix] of checks) {
      const id = comparison[`${prefix}_id`], version = comparison[`${prefix}_version`];
      if (typeof id !== "string" || !Number.isSafeInteger(version) || store.find(kind, id, undefined, false)?.version !== version) throw new Error("Delivery evaluation source changed or is unbound");
    }
    for (const side of ["baseline", "candidate"] as const) {
      const delivery = store.get("work_delivery", String(comparison[`${side}_delivery_id`]));
      const launch = typeof delivery.launch_id === "string" ? store.find("work_launch", delivery.launch_id) : null;
      const host = typeof delivery.run_id === "string" ? store.find("host_run", delivery.run_id) : null;
      if (!launch || launch.version !== delivery.launch_version || !host || host.version !== delivery.run_version || launch.run_id !== host.id) throw new Error("Delivery evaluation Host binding changed or is unbound");
      if (typeof launch.trial_id !== "string" || comparison[`${side}_outcome_id`] !== `outcome_${launch.trial_id}`) throw new Error("Delivery evaluation outcome is not bound to its launch");
      const outcomeId = String(comparison[`${side}_outcome_id`]);
      if (deliveries.has(String(delivery.id)) || launches.has(String(launch.id)) || outcomes.has(outcomeId)) throw new Error("Delivery evaluation requires distinct deliveries, launches and outcomes");
      deliveries.add(String(delivery.id)); launches.add(String(launch.id)); outcomes.add(outcomeId);
      let acceptance: JsonObject | null = null;
      if (delivery.acceptance_id !== null) {
        acceptance = typeof delivery.acceptance_id === "string" ? store.find("acceptance_assessment", delivery.acceptance_id) : null;
        if (!acceptance || acceptance.version !== delivery.acceptance_version || delivery.acceptance_id !== `assessment_${launch.acceptance_plan_id}`) throw new Error("Delivery evaluation acceptance binding changed or is unbound");
      } else if (delivery.acceptance_version !== null || launch.acceptance_plan_id !== undefined) throw new Error("Delivery evaluation acceptance binding changed or is unbound");
      const identity = { launch_id: launch.id, launch_version: launch.version, run_id: host.id, run_version: host.version, acceptance_id: acceptance?.id ?? null, acceptance_version: acceptance?.version ?? null, status: workDeliveryStatus(launch, host, acceptance) };
      if (delivery.status !== identity.status || delivery.observation_digest !== digestJson(identity)) throw new Error("Delivery evaluation delivery observation is inconsistent");
    }
    const caseRecord = store.get("delivery_evaluation_case", String(comparison.case_id));
    const baseline = store.get("work_delivery", String(comparison.baseline_delivery_id)); const candidate = store.get("work_delivery", String(comparison.candidate_delivery_id));
    const b = quality(baseline.status), c = quality(candidate.status);
    const verdict = b === null || c === null ? "inconclusive" : c > b ? "improved" : c < b ? "regressed" : "equal";
    if (comparison.partition !== caseRecord.partition || comparison.verdict !== verdict || comparison.environment !== run.environment || comparison.budget !== run.budget) throw new Error("Delivery evaluation comparison result is inconsistent");
  }
  const aggregate = { improved: comparisons.filter(item => item.verdict === "improved").length, equal: comparisons.filter(item => item.verdict === "equal").length,
    regressed: comparisons.filter(item => item.verdict === "regressed").length, inconclusive: comparisons.filter(item => item.verdict === "inconclusive").length, total: comparisons.length };
  const caseCount = new Set(comparisons.map(item => item.case_id)).size;
  if (!Number.isSafeInteger(run.min_trials) || Number(run.min_trials) < 1 || Number(run.min_trials) > 100 || digestJson(run.aggregate) !== digestJson(aggregate) || run.distinct_case_count !== caseCount) throw new Error("Delivery evaluation aggregate is inconsistent");
  const status = aggregate.regressed ? "rejected" : aggregate.inconclusive || caseCount < Number(run.min_trials) ? "inconclusive"
    : aggregate.improved && comparisons.every(item => item.partition === "held_out") ? "eligible_for_signoff" : "inconclusive";
  if (run.status !== status) throw new Error("Delivery evaluation status is inconsistent");
}

/** Comparable, content-free evaluation bridge for completed Work Deliveries. */
export class DeliveryEvaluationKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  caseSave(args: JsonObject): JsonObject {
    const caseId = text(args.case_id, "case_id"); const partition = text(args.partition, "partition"); if (!new Set(["development", "held_out"]).has(partition)) throw new Error("Evaluation case partition is unsupported");
    const item = { name: text(args.name, "name"), domain: text(args.domain, "domain"), partition, acceptance_contract_ref: text(args.acceptance_contract_ref, "acceptance_contract_ref"), sanitized: args.sanitized === true };
    if (!item.sanitized) throw new Error("Evaluation cases must be sanitized"); if (partition === "held_out" && (typeof args.approved_by !== "string" || !args.approved_by.trim())) throw new Error("Held-out case requires independent approval");
    const existing = this.store.find("delivery_evaluation_case", caseId); const definitionDigest = digestJson(item); if (existing) { if (existing.definition_digest !== definitionDigest) throw new Error("Evaluation case idempotency conflict"); return { case: existing, idempotent: true }; }
    return { case: this.store.create("delivery_evaluation_case", caseId, { ...item, definition_digest: definitionDigest, approved_by: args.approved_by ?? null }), idempotent: false };
  }

  compare(args: JsonObject): JsonObject {
    const item = this.store.get("delivery_evaluation_case", text(args.case_id, "case_id")); const baseline = this.store.get("work_delivery", text(args.baseline_delivery_id, "baseline_delivery_id")); const candidate = this.store.get("work_delivery", text(args.candidate_delivery_id, "candidate_delivery_id"));
    const environment = text(args.environment_fingerprint, "environment_fingerprint"); const budget = text(args.budget_fingerprint, "budget_fingerprint");
    const baselineOutcome = outcome(this.store, baseline); const candidateOutcome = outcome(this.store, candidate); const baselineQuality = quality(baseline.status); const candidateQuality = quality(candidate.status);
    const identity = { case_id: item.id, case_version: item.version, baseline_delivery_id: baseline.id, baseline_delivery_version: baseline.version, candidate_delivery_id: candidate.id, candidate_delivery_version: candidate.version,
      baseline_outcome_id: baselineOutcome.id, baseline_outcome_version: baselineOutcome.version, candidate_outcome_id: candidateOutcome.id, candidate_outcome_version: candidateOutcome.version, environment, budget };
    const comparisonId = String(args.comparison_id ?? `delivery_comparison_${baseline.id}_${candidate.id}_${item.id}`); const existing = this.store.find("delivery_evaluation_comparison", comparisonId); const comparisonDigest = digestJson(identity); if (existing) { if (existing.comparison_digest !== comparisonDigest) throw new Error("Delivery comparison idempotency conflict"); return { comparison: existing, idempotent: true }; }
    const verdict = candidateQuality === null || baselineQuality === null ? "inconclusive"
      : candidateQuality > baselineQuality ? "improved" : candidateQuality < baselineQuality ? "regressed" : "equal";
    return { comparison: this.store.create("delivery_evaluation_comparison", comparisonId, { ...identity, comparison_digest: comparisonDigest, partition: item.partition, verdict, baseline: { delivery_status: baseline.status, outcome_verdict: baselineOutcome.verdict, quality: baselineQuality, costs: baselineOutcome.costs }, candidate: { delivery_status: candidate.status, outcome_verdict: candidateOutcome.verdict, quality: candidateQuality, costs: candidateOutcome.costs }, promotion_eligible: false }), idempotent: false };
  }

  run(args: JsonObject): JsonObject {
    const environment = text(args.environment_fingerprint, "environment_fingerprint"); const budget = text(args.budget_fingerprint, "budget_fingerprint"); const minTrials = positiveInteger(args.min_trials, "min_trials", 2);
    const entries = items(args.items).map((item) => ({ case_id: text(item.case_id, "items.case_id"), baseline_delivery_id: text(item.baseline_delivery_id, "items.baseline_delivery_id"), candidate_delivery_id: text(item.candidate_delivery_id, "items.candidate_delivery_id") }));
    const cases = new Set<string>(); const deliveries = new Set<string>();
    for (const entry of entries) {
      if (deliveries.has(entry.baseline_delivery_id) || deliveries.has(entry.candidate_delivery_id) || entry.baseline_delivery_id === entry.candidate_delivery_id) throw new Error("Evaluation run requires distinct cases and deliveries");
      cases.add(entry.case_id); deliveries.add(entry.baseline_delivery_id); deliveries.add(entry.candidate_delivery_id);
    }
    const launches = new Set<string>(); const outcomes = new Set<string>();
    for (const deliveryId of deliveries) {
      const delivery = this.store.get("work_delivery", deliveryId);
      const launchId = text(delivery.launch_id, "work_delivery.launch_id");
      const resultId = text(outcome(this.store, delivery).id, "outcome.id");
      if (launches.has(launchId) || outcomes.has(resultId)) throw new Error("Evaluation run requires distinct launches and outcomes");
      launches.add(launchId); outcomes.add(resultId);
    }
    const comparisons = entries.map((entry) => this.compare({ ...entry, environment_fingerprint: environment, budget_fingerprint: budget }).comparison as JsonObject);
    const aggregate = { improved: comparisons.filter((item) => item.verdict === "improved").length, equal: comparisons.filter((item) => item.verdict === "equal").length, regressed: comparisons.filter((item) => item.verdict === "regressed").length, inconclusive: comparisons.filter((item) => item.verdict === "inconclusive").length, total: comparisons.length };
    const allHeldOut = comparisons.every((item) => item.partition === "held_out"); const status = aggregate.regressed ? "rejected" : aggregate.inconclusive || cases.size < minTrials ? "inconclusive" : aggregate.improved && allHeldOut ? "eligible_for_signoff" : "inconclusive";
    const identity = { environment, budget, min_trials: minTrials, comparison_ids: comparisons.map((item) => item.id).sort(), comparison_versions: comparisons.map((item) => ({ id: item.id, version: item.version })).sort((left, right) => String(left.id).localeCompare(String(right.id))) };
    const runId = String(args.run_id ?? `delivery_evaluation_run_${digestJson(identity).slice(7, 23)}`); const existing = this.store.find("delivery_evaluation_run", runId); const runDigest = digestJson(identity);
    if (existing) { if (existing.run_digest !== runDigest) throw new Error("Delivery evaluation run idempotency conflict"); return { run: existing, comparisons, idempotent: true }; }
    return { run: this.store.create("delivery_evaluation_run", runId, { ...identity, run_digest: runDigest, aggregate, distinct_case_count: cases.size, status, recommendation: status === "eligible_for_signoff" ? "signoff_required" : status === "rejected" ? "reject_candidate" : "collect_more_comparable_trials", promotion_eligible: false }), comparisons, idempotent: false };
  }
}
