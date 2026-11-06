import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../core/mcp.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { assertDeliveryEvaluationCurrent } from "../core/delivery-evaluation.ts";
import { deliveryEvaluationFixture } from "./helpers/delivery-evaluation-fixture.ts";

test("evaluation rechecks Host and acceptance revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-delivery-revision-")); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    for (const [id, kind, recordId] of [["host-check", "host_run", "host-delivery-host-check-base"], ["acceptance-check", "acceptance_assessment", "assessment_plan-delivery-acceptance-check-candidate"]] as const) {
      const run = deliveryEvaluationFixture(service, id);
      assertDeliveryEvaluationCurrent(store, run);
      const record = store.get(kind, recordId);
      store.save(kind, recordId, { ...record, status: "changed" });
      assert.throws(() => assertDeliveryEvaluationCurrent(store, run), /binding changed or is unbound/);
    }
    const forged = deliveryEvaluationFixture(service, "forged-check");
    const delivery = store.get("work_delivery", "delivery-forged-check-base");
    store.save("work_delivery", String(delivery.id), { ...delivery, status: "accepted" });
    const comparison = store.get("delivery_evaluation_comparison", String((forged.comparison_ids as string[])[0]));
    const updated = store.save("delivery_evaluation_comparison", String(comparison.id), { ...comparison, baseline_delivery_version: Number(delivery.version) + 1 });
    assert.throws(() => assertDeliveryEvaluationCurrent(store, { ...forged, comparison_versions: [{ id: updated.id, version: updated.version }] }), /observation is inconsistent/);
    const duplicateRun = deliveryEvaluationFixture(service, "duplicate-recheck");
    const original = store.get("delivery_evaluation_comparison", String((duplicateRun.comparison_ids as string[])[0]));
    const duplicate = service.deliveryEvaluationCompare({ case_id: original.case_id, baseline_delivery_id: original.baseline_delivery_id,
      candidate_delivery_id: original.candidate_delivery_id, environment_fingerprint: duplicateRun.environment,
      budget_fingerprint: duplicateRun.budget, comparison_id: "duplicate-comparison" }).comparison as JsonObject;
    assert.throws(() => assertDeliveryEvaluationCurrent(store, { ...duplicateRun,
      comparison_ids: [original.id, duplicate.id], comparison_versions: [{ id: original.id, version: original.version }, { id: duplicate.id, version: duplicate.version }] }), /distinct deliveries, launches and outcomes/);
    const otherRun = deliveryEvaluationFixture(service, "duplicate-recheck-other");
    const other = store.get("delivery_evaluation_comparison", String((otherRun.comparison_ids as string[])[0]));
    const originalDelivery = store.get("work_delivery", String(original.baseline_delivery_id));
    store.create("work_delivery", "duplicate-launch-delivery", { ...originalDelivery });
    const compareAlias = (baselineId: string, comparisonId: string) => service.deliveryEvaluationCompare({ case_id: other.case_id,
      baseline_delivery_id: baselineId, candidate_delivery_id: other.candidate_delivery_id,
      environment_fingerprint: duplicateRun.environment, budget_fingerprint: duplicateRun.budget, comparison_id: comparisonId }).comparison as JsonObject;
    const checkAlias = (alias: JsonObject) => assertDeliveryEvaluationCurrent(store, { ...duplicateRun,
      comparison_ids: [original.id, alias.id], comparison_versions: [{ id: original.id, version: original.version }, { id: alias.id, version: alias.version }] });
    assert.throws(() => checkAlias(compareAlias("duplicate-launch-delivery", "duplicate-launch-comparison")), /distinct deliveries, launches and outcomes/);
    const originalLaunch = store.get("work_launch", String(originalDelivery.launch_id));
    store.create("work_launch", "duplicate-outcome-launch", { ...originalLaunch });
    service.workDeliveryObserve({ delivery_id: "duplicate-outcome-delivery", launch_id: "duplicate-outcome-launch" });
    assert.throws(() => checkAlias(compareAlias("duplicate-outcome-delivery", "duplicate-outcome-comparison")), /distinct deliveries, launches and outcomes/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("delivery evaluation compares only sanitized Cases and immutable observed deliveries", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-delivery-eval-")); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    const delivery = (id: string, status: string, outcome: string) => { const plan = ["accepted", "rejected"].includes(status) ? `plan-${id}` : undefined; store.create("host_run", `host-${id}`, { status: status === "host_failed" ? "failed" : "completed" }); if (plan) store.create("acceptance_assessment", `assessment_${plan}`, { status: status === "accepted" ? "passed" : "failed" }); store.create("work_launch", `launch-${id}`, { trial_id: `trial-${id}`, run_id: `host-${id}`, ...(plan ? { acceptance_plan_id: plan } : {}) }); store.create("outcome", `outcome_trial-${id}`, { verdict: outcome, costs: { tokens: 1 } }); service.workDeliveryObserve({ delivery_id: id, launch_id: `launch-${id}` }); };
    delivery("base", "host_failed", "failed"); delivery("candidate", "accepted", "passed"); delivery("equal", "ready_for_delivery", "passed");
    delivery("rejected", "rejected", "failed"); delivery("base-two", "host_failed", "failed"); delivery("candidate-two", "accepted", "passed");
    const development = service.deliveryEvaluationCaseSave({ case_id: "dev", name: "Dev", domain: "software", partition: "development", acceptance_contract_ref: "contract:v1", sanitized: true }).case as JsonObject;
    assert.equal(service.deliveryEvaluationCaseSave({ case_id: "dev", name: "Dev", domain: "software", partition: "development", acceptance_contract_ref: "contract:v1", sanitized: true }).idempotent, true);
    const comparison = service.deliveryEvaluationCompare({ case_id: development.id, baseline_delivery_id: "base", candidate_delivery_id: "candidate", environment_fingerprint: "env", budget_fingerprint: "budget" }).comparison as JsonObject; assert.equal(comparison.verdict, "improved"); assert.equal(comparison.promotion_eligible, false);
    assert.equal(service.deliveryEvaluationCompare({ case_id: development.id, baseline_delivery_id: "base", candidate_delivery_id: "candidate", environment_fingerprint: "env", budget_fingerprint: "budget" }).idempotent, true);
    assert.equal((service.deliveryEvaluationCompare({ case_id: development.id, baseline_delivery_id: "candidate", candidate_delivery_id: "equal", environment_fingerprint: "env", budget_fingerprint: "budget", comparison_id: "regression" }).comparison as JsonObject).verdict, "inconclusive");
    const compare = (baseline: string, candidate: string) => service.deliveryEvaluationCompare({ case_id: development.id, baseline_delivery_id: baseline, candidate_delivery_id: candidate, environment_fingerprint: "env", budget_fingerprint: "budget" }).comparison as JsonObject;
    assert.equal(compare("equal", "candidate").verdict, "inconclusive");
    assert.equal(compare("candidate", "candidate").verdict, "equal");
    assert.equal(compare("rejected", "candidate").verdict, "improved");
    const unassessed = service.deliveryEvaluationRun({ environment_fingerprint: "env", budget_fingerprint: "budget", min_trials: 1,
      items: [{ case_id: development.id, baseline_delivery_id: "base", candidate_delivery_id: "equal" }] }).run as JsonObject;
    assert.equal(unassessed.status, "inconclusive");
    assert.equal((unassessed.aggregate as JsonObject).inconclusive, 1);
    const mcp = new McpServer(service, "full"); assert.equal((((await mcp.handlers.craft_delivery_evaluation_compare({ case_id: "dev", baseline_delivery_id: "candidate", candidate_delivery_id: "base", environment_fingerprint: "env", budget_fingerprint: "budget", comparison_id: "mcp" })).comparison as JsonObject).verdict), "regressed"); assert.equal(((await mcp.handlers.craft_delivery_evaluation_case_save({ case_id: "mcp-case", name: "MCP", domain: "video", partition: "development", acceptance_contract_ref: "contract:v1", sanitized: true })).case as JsonObject).id, "mcp-case");
    const held = service.deliveryEvaluationCaseSave({ case_id: "held-run", name: "Held run", domain: "software", partition: "held_out", acceptance_contract_ref: "contract:v1", sanitized: true, approved_by: "reviewer" }).case as JsonObject; const heldTwo = service.deliveryEvaluationCaseSave({ case_id: "held-run-two", name: "Held run two", domain: "software", partition: "held_out", acceptance_contract_ref: "contract:v1", sanitized: true, approved_by: "reviewer" }).case as JsonObject;
    const run = service.deliveryEvaluationRun({ run_id: "batch", environment_fingerprint: "env", budget_fingerprint: "budget", min_trials: 2, items: [{ case_id: held.id, baseline_delivery_id: "base", candidate_delivery_id: "candidate" }, { case_id: heldTwo.id, baseline_delivery_id: "base-two", candidate_delivery_id: "candidate-two" }] }).run as JsonObject; assert.equal(run.status, "eligible_for_signoff"); assert.equal(run.promotion_eligible, false); assert.equal((run.aggregate as JsonObject).improved, 2); assert.equal(service.deliveryEvaluationRun({ run_id: "batch", environment_fingerprint: "env", budget_fingerprint: "budget", min_trials: 2, items: [{ case_id: held.id, baseline_delivery_id: "base", candidate_delivery_id: "candidate" }, { case_id: heldTwo.id, baseline_delivery_id: "base-two", candidate_delivery_id: "candidate-two" }] }).idempotent, true);
    const repeated = service.deliveryEvaluationRun({ run_id: "repeat-one-case", environment_fingerprint: "env", budget_fingerprint: "budget", min_trials: 2, items: [{ case_id: held.id, baseline_delivery_id: "base", candidate_delivery_id: "candidate" }, { case_id: held.id, baseline_delivery_id: "base-two", candidate_delivery_id: "candidate-two" }] }).run as JsonObject;
    assert.equal(repeated.status, "inconclusive"); assert.equal(repeated.distinct_case_count, 1); assert.equal((repeated.aggregate as JsonObject).total, 2);
    assert.equal(((await mcp.handlers.craft_delivery_evaluation_run({ run_id: "inconclusive", environment_fingerprint: "env", budget_fingerprint: "budget", min_trials: 3, items: [{ case_id: "dev", baseline_delivery_id: "base", candidate_delivery_id: "candidate" }, { case_id: held.id, baseline_delivery_id: "base-two", candidate_delivery_id: "candidate-two" }] })).run as JsonObject).status, "inconclusive"); assert.equal((service.deliveryEvaluationRun({ environment_fingerprint: "env", budget_fingerprint: "budget", items: [{ case_id: held.id, baseline_delivery_id: "base", candidate_delivery_id: "candidate" }] }).run as JsonObject).status, "inconclusive"); assert.equal((service.deliveryEvaluationRun({ run_id: "mixed", environment_fingerprint: "env", budget_fingerprint: "budget", min_trials: 2, items: [{ case_id: "dev", baseline_delivery_id: "base", candidate_delivery_id: "candidate" }, { case_id: held.id, baseline_delivery_id: "base-two", candidate_delivery_id: "candidate-two" }] }).run as JsonObject).status, "inconclusive"); assert.equal((service.deliveryEvaluationRun({ run_id: "rejected-run", environment_fingerprint: "env", budget_fingerprint: "budget", min_trials: 1, items: [{ case_id: held.id, baseline_delivery_id: "candidate", candidate_delivery_id: "base" }] }).run as JsonObject).status, "rejected"); assert.throws(() => service.deliveryEvaluationRun({ run_id: "batch", environment_fingerprint: "env", budget_fingerprint: "budget", min_trials: 3, items: [{ case_id: held.id, baseline_delivery_id: "base", candidate_delivery_id: "candidate" }] }), /conflict/); assert.throws(() => service.deliveryEvaluationRun({ environment_fingerprint: "env", budget_fingerprint: "budget", items: [] }), /items/); assert.throws(() => service.deliveryEvaluationRun({ environment_fingerprint: "env", budget_fingerprint: "budget", items: "bad" }), /items/); assert.throws(() => service.deliveryEvaluationRun({ environment_fingerprint: "env", budget_fingerprint: "budget", items: [null] }), /items/); assert.throws(() => service.deliveryEvaluationRun({ run_id: "too-many", environment_fingerprint: "env", budget_fingerprint: "budget", min_trials: 101, items: [{ case_id: "dev", baseline_delivery_id: "base", candidate_delivery_id: "candidate" }] }), /min_trials/); assert.throws(() => service.deliveryEvaluationRun({ run_id: "bad-run", environment_fingerprint: "env", budget_fingerprint: "budget", min_trials: 0, items: [{ case_id: "dev", baseline_delivery_id: "base", candidate_delivery_id: "candidate" }] }), /min_trials/);
    const pair = { case_id: held.id, baseline_delivery_id: "base", candidate_delivery_id: "candidate" };
    assert.throws(() => service.deliveryEvaluationRun({ environment_fingerprint: "env", budget_fingerprint: "budget", items: [pair, pair] }), /distinct cases and deliveries/);
    assert.throws(() => service.deliveryEvaluationRun({ environment_fingerprint: "env", budget_fingerprint: "budget", items: [pair, { ...pair, case_id: heldTwo.id }] }), /distinct cases and deliveries/);
    assert.throws(() => service.deliveryEvaluationRun({ environment_fingerprint: "env", budget_fingerprint: "budget", items: [{ ...pair, candidate_delivery_id: "base" }] }), /distinct cases and deliveries/);
    assert.throws(() => service.deliveryEvaluationRun({ environment_fingerprint: "env", budget_fingerprint: "budget", items: [pair, { case_id: heldTwo.id, baseline_delivery_id: "candidate-two", candidate_delivery_id: "base" }] }), /distinct cases and deliveries/);
    store.create("work_delivery", "duplicate-base", { launch_id: "launch-base", status: "host_failed" });
    assert.throws(() => service.deliveryEvaluationRun({ environment_fingerprint: "env", budget_fingerprint: "budget", items: [pair, { case_id: heldTwo.id, baseline_delivery_id: "duplicate-base", candidate_delivery_id: "candidate-two" }] }), /distinct launches and outcomes/);
    store.create("work_launch", "shared-trial-launch", { trial_id: "trial-base" });
    store.create("work_delivery", "shared-outcome", { launch_id: "shared-trial-launch", status: "host_failed" });
    assert.throws(() => service.deliveryEvaluationRun({ environment_fingerprint: "env", budget_fingerprint: "budget", items: [pair, { case_id: heldTwo.id, baseline_delivery_id: "shared-outcome", candidate_delivery_id: "candidate-two" }] }), /distinct launches and outcomes/);
    assert.throws(() => service.deliveryEvaluationCaseSave({ case_id: "bad", name: "Bad", domain: "x", partition: "other", acceptance_contract_ref: "x", sanitized: true }), /partition/); assert.throws(() => service.deliveryEvaluationCaseSave({ case_id: "raw", name: "Raw", domain: "x", partition: "development", acceptance_contract_ref: "x", sanitized: false }), /sanitized/); assert.throws(() => service.deliveryEvaluationCaseSave({ case_id: "held", name: "Held", domain: "x", partition: "held_out", acceptance_contract_ref: "x", sanitized: true }), /approval/); assert.throws(() => service.deliveryEvaluationCaseSave({ case_id: "held2", name: "Held", domain: "x", partition: "held_out", acceptance_contract_ref: "x", sanitized: true, approved_by: " " }), /approval/); assert.equal((service.deliveryEvaluationCaseSave({ case_id: "held3", name: "Held", domain: "x", partition: "held_out", acceptance_contract_ref: "x", sanitized: true, approved_by: "reviewer" }).case as JsonObject).partition, "held_out"); assert.throws(() => service.deliveryEvaluationCaseSave({ case_id: "dev", name: "Changed", domain: "software", partition: "development", acceptance_contract_ref: "contract:v1", sanitized: true }), /conflict/); assert.throws(() => service.deliveryEvaluationCaseSave({ case_id: " ", name: "x", domain: "x", partition: "development", acceptance_contract_ref: "x", sanitized: true }), /case_id/);
    assert.throws(() => service.deliveryEvaluationCompare({ case_id: "dev", baseline_delivery_id: "base", candidate_delivery_id: "candidate", environment_fingerprint: "env2", budget_fingerprint: "budget" }), /conflict/);
    store.create("work_launch", "launch-no-trial", {}); store.create("work_delivery", "no-trial", { launch_id: "launch-no-trial", status: "accepted" }); store.create("work_launch", "launch-no-outcome", { trial_id: "missing" }); store.create("work_delivery", "no-outcome", { launch_id: "launch-no-outcome", status: "accepted" }); assert.throws(() => service.deliveryEvaluationCompare({ case_id: "dev", baseline_delivery_id: "no-trial", candidate_delivery_id: "candidate", environment_fingerprint: "x", budget_fingerprint: "x", comparison_id: "no-trial" }), /Outcome/); assert.throws(() => service.deliveryEvaluationCompare({ case_id: "dev", baseline_delivery_id: "no-outcome", candidate_delivery_id: "candidate", environment_fingerprint: "x", budget_fingerprint: "x", comparison_id: "no-outcome" }), /Outcome/);
    assertDeliveryEvaluationCurrent(store, run);
    assert.throws(() => assertDeliveryEvaluationCurrent(store, { ...run, aggregate: { ...(run.aggregate as JsonObject), improved: 999 } }), /aggregate is inconsistent/);
    assert.throws(() => assertDeliveryEvaluationCurrent(store, { ...run, min_trials: 101 }), /aggregate is inconsistent/);
    assert.throws(() => assertDeliveryEvaluationCurrent(store, { ...run, status: "rejected" }), /status is inconsistent/);
    store.create("task", "gate-task", {});
    store.create("harness_topology", "gate-baseline", { task_id: "gate-task", mode: "baseline", lifecycle: "active" });
    store.create("harness_topology", "gate-candidate", { task_id: "gate-task", mode: "candidate", lifecycle: "shadow_only" });
    store.create("a2a_agent_trust", "gate-trust", { status: "active" });
    store.create("evidence", "gate-evidence", { confidence: "confirmed" });
    assert.equal((service.harnessTopologyPromote({ topology_id: "gate-candidate", evaluation_run_id: run.id, evidence_ids: ["gate-evidence"] }).topology as JsonObject).lifecycle, "routing_eligible");
    assert.equal((service.a2aCollaborationSessionCreate({ session_id: "gate-session", task_id: "gate-task", trust_id: "gate-trust", evaluation_run_id: run.id, justification_evidence_id: "gate-evidence", budget: {} }).session as JsonObject).lifecycle, "active");
    assert.equal((service.taskBenchmarkCandidatePropose({ evaluation_run_id: run.id, summary: "Candidate", candidate_axes: "tools" }).candidate as JsonObject).lifecycle, "draft");
    assert.throws(() => assertDeliveryEvaluationCurrent(store, { comparison_ids: ["missing"], comparison_versions: [] }), /bindings/);
    assert.throws(() => assertDeliveryEvaluationCurrent(store, { comparison_ids: ["missing"], comparison_versions: [{ id: "missing", version: 1 }] }), /changed/);
    const baselineOutcome = store.get("outcome", "outcome_trial-base");
    store.save("outcome", "outcome_trial-base", { ...baselineOutcome, costs: { tokens: 2 } });
    assert.throws(() => assertDeliveryEvaluationCurrent(store, run), /source changed/);
    assert.throws(() => service.harnessTopologyPromote({ topology_id: "gate-candidate", evaluation_run_id: run.id, evidence_ids: ["gate-evidence"] }), /source changed/);
    assert.equal((service.harnessTopologySelect({ task_id: "gate-task", baseline_topology_id: "gate-baseline" }).topology as JsonObject).id, "gate-baseline");
    assert.throws(() => service.a2aCollaborationSessionCreate({ session_id: "gate-session", task_id: "gate-task", trust_id: "gate-trust", evaluation_run_id: run.id, justification_evidence_id: "gate-evidence", budget: {} }), /source changed/);
    assert.throws(() => service.taskBenchmarkCandidatePropose({ evaluation_run_id: run.id, summary: "Candidate", candidate_axes: "tools" }), /source changed/);
    assert.throws(() => service.deliveryEvaluationCompare({ case_id: development.id, baseline_delivery_id: "base", candidate_delivery_id: "candidate", environment_fingerprint: "env", budget_fingerprint: "budget" }), /conflict/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
