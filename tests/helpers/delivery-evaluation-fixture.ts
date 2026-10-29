import type { CraftService } from "../../core/service.ts";
import type { JsonObject } from "../../core/infrastructure/store.ts";

export function observedDeliveryFixture(service: CraftService, deliveryId: string, status: string, verdict: string): void {
  const store = service.store, launchId = `launch-${deliveryId}`, runId = `host-${deliveryId}`;
  const acceptancePlan = status === "accepted" || status === "rejected" ? `plan-${deliveryId}` : undefined;
  store.create("host_run", runId, { status: status === "host_failed" ? "failed" : "completed" });
  if (acceptancePlan) store.create("acceptance_assessment", `assessment_${acceptancePlan}`, { status: status === "accepted" ? "passed" : "failed" });
  store.create("work_launch", launchId, { trial_id: `trial-${deliveryId}`, run_id: runId, ...(acceptancePlan ? { acceptance_plan_id: acceptancePlan } : {}) });
  store.create("outcome", `outcome_trial-${deliveryId}`, { verdict, costs: {} });
  service.workDeliveryObserve({ delivery_id: deliveryId, launch_id: launchId });
}

/** Build a version-bound evaluation for control-plane tests. */
export function deliveryEvaluationFixture(service: CraftService, id: string, status = "eligible_for_signoff", environment = "fixture", budget = "fixture"): JsonObject {
  const store = service.store;
  for (const [side, deliveryStatus, verdict] of [["base", "host_failed", "failed"], ["candidate", "accepted", "passed"]] as const) {
    const name = `${id}-${side}`;
    observedDeliveryFixture(service, `delivery-${name}`, deliveryStatus, verdict);
  }
  service.deliveryEvaluationCaseSave({ case_id: `case-${id}`, name: "fixture", domain: "test", partition: "held_out", acceptance_contract_ref: "fixture", sanitized: true, approved_by: "fixture" });
  const run = service.deliveryEvaluationRun({ run_id: id, environment_fingerprint: environment, budget_fingerprint: budget, min_trials: 1,
    items: [{ case_id: `case-${id}`, baseline_delivery_id: `delivery-${id}-base`, candidate_delivery_id: `delivery-${id}-candidate` }] }).run as JsonObject;
  return status === "eligible_for_signoff" ? run : store.save("delivery_evaluation_run", id, { ...run, status });
}
