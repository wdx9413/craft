import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

test("experience mining produces bounded success and failure patterns, then advances only a read-only held-out shadow run", async () => {
  const root = join(tmpdir(), `craft-v098-shadow-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true }); await writeFile(join(root, "ok.txt"), "ok");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open(); const service = new CraftService(store);
  try {
    const task = service.taskOpen({ title: "Mine", goal: "Learn safely" }).task as JsonObject;
    const suite = service.evaluationSuiteSave({ suite_id: "held", name: "Held", cases: [
      { case_id: "one", split: "held_out" }, { case_id: "two", split: "held_out" },
    ] });
    const baseline = service.workflowSave({ workflow_id: "baseline", name: "Baseline", steps: [
      { id: "proof", type: "assertion", evaluator: "file_exists", path: "ok.txt" },
    ] });
    const candidate = service.workflowSave({ workflow_id: "candidate", name: "Candidate", steps: [
      { id: "proof", type: "assertion", evaluator: "file_exists", path: "ok.txt" },
    ] });
    const evidence = service.evidenceRecord({ evidence_id: "mining-evidence", source_type: "program", confidence: "confirmed", claim: "observed" });
    for (const [trialId, verdict] of [["success-one", "passed"], ["success-two", "passed"], ["failure-one", "failed"], ["failure-two", "failed"]] as const) {
      service.trialStart({ trial_id: trialId, task_id: task.id, subject_type: "workflow", subject_id: candidate.id, subject_version: candidate.version });
      service.trialTraceAppend({ trial_id: trialId, event_type: verdict === "passed" ? "test.passed" : "test.failed",
        data: { private_input: "must-not-be-mined" } });
      service.outcomeRecord({ trial_id: trialId, verdict, summary: verdict, failure_type: verdict === "failed" ? "missing_proof" : undefined,
        evidence_ids: [evidence.id] });
    }
    const mined = service.experienceMine({ subject_type: "workflow", subject_id: candidate.id, subject_version: candidate.version });
    const candidates = mined.candidates as JsonObject[];
    assert.deepEqual(candidates.map((item) => item.pattern_kind).sort(), ["failure", "success"]);
    assert.equal(JSON.stringify(candidates).includes("must-not-be-mined"), false);
    const success = candidates.find((item) => item.pattern_kind === "success")!;
    const experiment = service.experienceShadowExperimentCreate({ task_id: task.id, mining_candidate_id: success.id });
    const policy = service.signoffPolicySave({ policy_id: "shadow-policy", name: "Shadow policy", requirements: [] });
    const evaluated = service.experienceShadowExperimentEvaluate({ experiment_id: (experiment.experiment as JsonObject).id, shadow_evaluation_id: "shadow-success",
      suite_id: suite.id, suite_version: suite.version, project_root: root, baseline_workflow_id: baseline.id, baseline_workflow_version: baseline.version,
      candidate_workflow_id: candidate.id, candidate_workflow_version: candidate.version, trials_per_case: 1, min_trials: 2,
      signoff_policy_id: policy.id, signoff_policy_version: policy.version });
    assert.equal(evaluated.status, "signoff_ready");
    assert.equal((evaluated.shadow_evaluation as JsonObject).status, "signoff_ready");
    assert.equal(((evaluated.signoff_preparation as JsonObject).policy as JsonObject).id, policy.id);
    assert.equal(((evaluated.experiment as JsonObject).status), "signoff_ready");
    assert.throws(() => service.experienceShadowExperimentEvaluate({ experiment_id: (experiment.experiment as JsonObject).id,
      suite_id: suite.id, project_root: root, baseline_workflow_id: baseline.id, baseline_workflow_version: baseline.version,
      candidate_workflow_id: candidate.id, candidate_workflow_version: candidate.version, trials_per_case: 1, min_trials: 2 }), /planned/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("shadow evaluation rejects non-held-out, non-read-only, or unsuccessful proposals without publication", async () => {
  const root = join(tmpdir(), `craft-v098-reject-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true }); const store = await new CraftStore(craftPaths(join(root, "data"))).open(); const service = new CraftService(store);
  try {
    const task = service.taskOpen({ title: "Reject", goal: "Do not publish" }).task as JsonObject;
    const invalidCandidate = store.create("experience_mining_candidate", "invalid", { lifecycle: "verified" });
    const invalidExperiment = store.create("experience_shadow_experiment", "invalid", { task_id: task.id,
      mining_candidate_id: invalidCandidate.id, mining_candidate_version: invalidCandidate.version, status: "planned" });
    assert.throws(() => service.experienceShadowExperimentEvaluate({ experiment_id: invalidExperiment.id }), /proposal-only/);
    const candidate = service.workflowSave({ workflow_id: "candidate", name: "Candidate" });
    const pending = service.trialStart({ trial_id: "pending", task_id: task.id, subject_type: "workflow", subject_id: candidate.id, subject_version: candidate.version });
    assert.equal(service.trialGet({ trial_id: pending.id }).outcome, null);
    const evidence = service.evidenceRecord({ source_type: "program", confidence: "confirmed", claim: "failure" });
    for (const trialId of ["one", "two"]) {
      service.trialStart({ trial_id: trialId, task_id: task.id, subject_type: "workflow", subject_id: candidate.id, subject_version: candidate.version });
      service.outcomeRecord({ trial_id: trialId, verdict: "failed", summary: "failed", failure_type: "repeat", evidence_ids: [evidence.id] });
    }
    const mined = service.experienceMine({ subject_type: "workflow", subject_id: candidate.id, subject_version: candidate.version });
    const experiment = service.experienceShadowExperimentCreate({ task_id: task.id,
      mining_candidate_id: (mined.candidates as JsonObject[])[0].id }).experiment as JsonObject;
    const trainOnly = service.evaluationSuiteSave({ name: "Development only", cases: [{ case_id: "development", split: "development" }] });
    assert.throws(() => service.experienceShadowExperimentEvaluate({ experiment_id: experiment.id, suite_id: trainOnly.id, project_root: root,
      baseline_workflow_id: candidate.id, baseline_workflow_version: candidate.version,
      candidate_workflow_id: candidate.id, candidate_workflow_version: candidate.version }), /held_out/);
    const held = service.evaluationSuiteSave({ name: "Held", cases: [{ case_id: "held", split: "held_out" }] });
    const unsafe = service.workflowSave({ workflow_id: "unsafe", name: "Unsafe", steps: [
      { id: "write", type: "assertion", evaluator: "file_exists", path: "nope", side_effect: "local_write" },
    ] });
    assert.throws(() => service.experienceShadowExperimentEvaluate({ experiment_id: experiment.id, suite_id: held.id, project_root: root,
      baseline_workflow_id: candidate.id, baseline_workflow_version: candidate.version,
      candidate_workflow_id: unsafe.id, candidate_workflow_version: unsafe.version,
      signoff_policy_id: "missing", signoff_policy_version: 1 }), /read-only/);
    const failing = service.workflowSave({ workflow_id: "failing", name: "Failing", steps: [
      { id: "missing", type: "assertion", evaluator: "file_exists", path: "missing.txt" },
    ] });
    const policy = service.signoffPolicySave({ name: "Policy", requirements: [] });
    const rejected = service.experienceShadowExperimentEvaluate({ experiment_id: experiment.id, suite_id: held.id, project_root: root,
      baseline_workflow_id: candidate.id, baseline_workflow_version: candidate.version,
      candidate_workflow_id: failing.id, candidate_workflow_version: failing.version,
      signoff_policy_id: policy.id, signoff_policy_version: policy.version, min_trials: 1 });
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.publication_allowed, false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
