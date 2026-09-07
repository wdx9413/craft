import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

test("trial-backed orchestration captures pinned routes, trace, evidence, cost, outcomes, and comparisons", async () => {
  const root = join(tmpdir(), `craft-orchestration-trial-${process.pid}-${Date.now()}`);
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  try {
    const task = service.taskOpen({ title: "Orchestrate", goal: "Evaluate a plan" }).task as JsonObject;
    const firstProfile = service.saveVersioned("agent_profile", "profile", { profile_id: "p1", name: "P1",
      role: "worker", host: "codex", model: "m1" }, ["name", "role", "host", "model"]);
    service.saveVersioned("agent_profile", "profile", { profile_id: "p1", name: "P1 v2",
      role: "worker", host: "codex", model: "m2" }, ["name", "role", "host", "model"]);
    service.saveVersioned("agent_profile", "profile", { profile_id: "p2", name: "P2",
      role: "reviewer", host: "claude", model: "m" }, ["name", "role", "host", "model"]);
    const harness = service.harnessConfigurationSave({ name: "Harness", dimensions: {} });
    const suite = service.evaluationSuiteSave({ name: "Plan suite", cases: [{ case_id: "held", split: "held_out" }] });
    const artifact = service.artifactRegister({ artifact_id: "node_artifact", kind: "report", name: "Node",
      uri: "file:///node" });
    const evidence = service.evidenceRecord({ evidence_id: "node_evidence", source_type: "host",
      claim: "Node attempt observed", confidence: "bounded", artifact_id: artifact.id });
    assert.throws(() => service.orchestrationTrialStart({ task_id: "missing", goal: "x", nodes: [] }), /Unknown task/);
    assert.throws(() => service.orchestrationTrialStart({ trial_id: "", task_id: task.id, goal: "x", nodes: [
      { id: "x", role: "worker", objective: "work", profile_ids: ["p2"] },
    ] }), /trial_id must not be empty/);
    assert.throws(() => service.orchestrationCreate({ plan_id: "", goal: "x", nodes: [
      { id: "x", role: "worker", objective: "work", profile_ids: ["p2"] },
    ] }), /plan_id must not be empty/);

    const started = service.orchestrationTrialStart({ plan_id: "plan_success", trial_id: "trial_success",
      task_id: task.id, case_id: "held", goal: "Build then review", max_concurrency: 1,
      policy: { retry: true }, harness_configuration_id: harness.id,
      harness_configuration_version: harness.version, environment: { host: "test" },
      budget: { tokens: 100 }, nodes: [
        { id: "build", role: "worker", objective: "build", profile_ids: ["p1", "p2"] },
        { id: "review", role: "reviewer", objective: "review", profile_ids: ["p2"], depends_on: ["build"] },
      ] });
    const initialPlan = started.plan as JsonObject;
    store.appendEvent("trial:trial_success", "legacy.event", {});
    assert.equal(initialPlan.version, 1);
    assert.equal((started.trial as JsonObject).harness_configuration_id, harness.id);
    assert.throws(() => service.orchestrationTrialFinalize({ plan_id: initialPlan.id }), /still running/);
    assert.throws(() => service.orchestrationTrialStart({ plan_id: "duplicate_trial_plan", trial_id: "trial_success",
      task_id: task.id, goal: "duplicate", nodes: [
        { id: "x", role: "worker", objective: "work", profile_ids: ["p2"] },
      ] }), /Trial already exists/);
    assert.equal(store.find("orchestration_plan", "duplicate_trial_plan"), null);
    assert.throws(() => service.orchestrationTrialStart({ plan_id: "invalid_environment", task_id: task.id,
      goal: "invalid", environment: [], nodes: [
        { id: "x", role: "worker", objective: "work", profile_ids: ["p2"] },
      ] }), /environment must be an object/);
    assert.throws(() => service.orchestrationCreate({ plan_id: initialPlan.id, goal: "duplicate", nodes: [
      { id: "x", role: "worker", objective: "work", profile_ids: ["p2"] },
    ] }), /already exists/);
    const firstDispatch = service.orchestrationDispatch({ plan_id: initialPlan.id, claimed_by: "host", capacity: 1 });
    const firstLease = (firstDispatch.leases as JsonObject[])[0];
    assert.equal(firstLease.profile_version, 2);
    assert.equal(service.orchestrationDispatch({ plan_id: initialPlan.id, claimed_by: "host",
      capacity: 1 }).leases instanceof Array, true);
    assert.throws(() => service.orchestrationSubmit({ plan_id: initialPlan.id, lease_id: firstLease.lease_id,
      verdict: "failed", costs: { tokens: "bad" } }), /Cost tokens/);
    assert.throws(() => service.orchestrationSubmit({ plan_id: initialPlan.id, lease_id: firstLease.lease_id,
      verdict: "failed", artifact_ids: ["missing"] }), /Unknown artifact/);
    assert.throws(() => service.orchestrationSubmit({ plan_id: initialPlan.id, lease_id: firstLease.lease_id,
      verdict: "failed", evidence_ids: ["missing"] }), /Unknown evidence/);
    assert.throws(() => service.orchestrationSubmit({ plan_id: initialPlan.id, lease_id: firstLease.lease_id,
      verdict: "failed", summary: "" }), /summary must not be empty/);
    const rerouted = service.orchestrationSubmit({ plan_id: initialPlan.id, lease_id: firstLease.lease_id,
      verdict: "failed", provenance: "model_judged", summary: "retry with reviewer", costs: { tokens: 10 },
      artifact_ids: [artifact.id], evidence_ids: [evidence.id] });
    assert.equal(rerouted.status, "running");
    const retryDispatch = service.orchestrationDispatch({ plan_id: initialPlan.id, claimed_by: "host" });
    const retryLease = (retryDispatch.leases as JsonObject[])[0];
    assert.equal(retryLease.profile_id, "p2");
    service.orchestrationSubmit({ plan_id: initialPlan.id, lease_id: retryLease.lease_id,
      verdict: "passed", provenance: "program_verified", costs: { tokens: 5 } });
    const reviewDispatch = service.orchestrationDispatch({ plan_id: initialPlan.id, claimed_by: "host" });
    const completed = service.orchestrationSubmit({ plan_id: initialPlan.id,
      lease_id: (reviewDispatch.leases as JsonObject[])[0].lease_id, verdict: "passed",
      provenance: "human_approved", costs: { tokens: 3 } });
    assert.equal(completed.status, "completed");
    const captured = service.trialGet({ trial_id: "trial_success" });
    const outcome = captured.outcome as JsonObject;
    assert.equal(outcome.verdict, "passed");
    assert.equal((outcome.costs as JsonObject).tokens, 18);
    assert.equal(typeof (outcome.costs as JsonObject).wall_duration_ms, "number");
    assert.equal((outcome.scores as JsonObject).route_retries, 1);
    assert.equal((outcome.evidence_ids as string[]).includes("node_evidence"), true);
    assert.equal((captured.trace as JsonObject[]).at(-1)?.event_type, "orchestration.completed");
    const traceLength = (captured.trace as JsonObject[]).length;
    assert.equal((service.orchestrationTrialFinalize({ plan_id: initialPlan.id }).trace as JsonObject[]).length,
      traceLength);
    assert.throws(() => service.orchestrationSubmit({ plan_id: initialPlan.id,
      lease_id: retryLease.lease_id, verdict: "passed" }), /Unknown lease/);

    const runPlan = (planId: string, trialId: string | undefined, verdict: "passed" | "failed" | "blocked",
      withDependent = false): JsonObject => {
      const trialRun = service.orchestrationTrialStart({ plan_id: planId, ...(trialId ? { trial_id: trialId } : {}),
        task_id: task.id, case_id: "held", goal: planId, nodes: [
          { id: "root", role: "worker", objective: "work", profile_ids: ["p2"] },
          ...(withDependent ? [{ id: "child", role: "reviewer", objective: "review",
            profile_ids: ["p2"], depends_on: ["root"] }] : []),
        ] });
      const dispatch = service.orchestrationDispatch({ plan_id: planId, claimed_by: "host" });
      service.orchestrationSubmit({ plan_id: planId, lease_id: (dispatch.leases as JsonObject[])[0].lease_id,
        verdict, costs: { tokens: 1 } });
      return trialRun.trial as JsonObject;
    };
    const secondTrial = runPlan("plan_second", undefined, "passed");
    const failedTrial = runPlan("plan_failed", "trial_failed", "failed", true);
    const blockedTrial = runPlan("plan_blocked", "trial_blocked", "blocked");
    assert.equal(String(secondTrial.id).startsWith("trial_"), true);
    assert.equal((service.trialGet({ trial_id: failedTrial.id }).outcome as JsonObject).failure_type, "node_failed");
    assert.equal((service.trialGet({ trial_id: blockedTrial.id }).outcome as JsonObject).failure_type, "node_blocked");

    const partial = service.orchestrationTrialStart({ plan_id: "plan_partial", trial_id: "trial_partial",
      task_id: task.id, goal: "Recover finalization", harness_configuration_id: harness.id, nodes: [
        { id: "root", role: "worker", objective: "work", profile_ids: ["p2"] },
      ] });
    const partialPlan = partial.plan as JsonObject;
    const partialNodes = (partialPlan.nodes as JsonObject[]).map((node) => ({ ...node, status: "passed" }));
    store.save("orchestration_plan", String(partialPlan.id), { ...partialPlan, nodes: partialNodes,
      status: "completed" });
    const stableKey = createHash("sha256").update("plan_partial:trial_partial").digest("hex");
    const partialArtifact = service.artifactRegister({ artifact_id: `artifact_${stableKey}`,
      kind: "orchestration_receipt", name: "partial", uri: "craft://partial" });
    const partialEvidence = service.evidenceRecord({ evidence_id: `evidence_${stableKey}`,
      source_type: "orchestration", claim: "partial", confidence: "confirmed",
      artifact_id: partialArtifact.id });
    store.appendEvent("trial:trial_partial", "orchestration.completed", {
      evidence_ids: [partialEvidence.id], artifact_ids: [partialArtifact.id] });
    assert.equal((service.orchestrationTrialFinalize({ plan_id: partialPlan.id }).outcome as JsonObject).verdict,
      "passed");

    const firstEvaluation = service.evaluationRunRecord({ suite_id: suite.id, split: "held_out",
      subject_type: "orchestration_plan", subject_id: initialPlan.id, subject_version: initialPlan.version,
      trial_ids: [(started.trial as JsonObject).id] });
    const secondEvaluation = service.evaluationRunRecord({ suite_id: suite.id, split: "held_out",
      subject_type: "orchestration_plan", subject_id: "plan_second", subject_version: secondTrial.subject_version,
      trial_ids: [secondTrial.id] });
    const comparison = service.evaluationCompare({ baseline_run_id: firstEvaluation.id,
      candidate_run_id: secondEvaluation.id });
    assert.equal(typeof (comparison.comparison as JsonObject).assessment, "string");
    const legacy = service.orchestrationCreate({ plan_id: "legacy_plan", goal: "Legacy", nodes: [
      { id: "legacy", role: "worker", objective: "work", profile_ids: ["p2"] },
    ] });
    const { accumulated_costs: _costs, ...legacyPayload } = legacy;
    store.save("orchestration_plan", "legacy_plan", legacyPayload);
    const legacyDispatch = service.orchestrationDispatch({ plan_id: "legacy_plan", claimed_by: "host" });
    assert.equal(service.orchestrationSubmit({ plan_id: "legacy_plan",
      lease_id: (legacyDispatch.leases as JsonObject[])[0].lease_id, verdict: "passed" }).status, "completed");
    assert.throws(() => service.orchestrationTrialFinalize({ plan_id: "legacy_plan" }), /not linked/);
    assert.equal(firstProfile.version, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
