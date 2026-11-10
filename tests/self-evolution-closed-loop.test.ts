import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";

/**
 * End-to-end self-evolution loop: a proposal-only Experience candidate must pass
 * a shadow held-out comparison, a calibrated Judge Gate, signoff, and canary in
 * that order. A model/human-graded signoff policy must not reach canary without
 * an eligible Judge Gate.
 */
test("self-evolution loop gates a judge-backed proposal on a calibrated Judge Gate through signoff and canary", async () => {
  const root = join(tmpdir(), `craft-self-evolution-loop-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "ok.txt"), "ok");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  try {
    const task = service.taskOpen({ title: "Evolve", goal: "Learn a safer workflow" }).task as JsonObject;
    const subject = service.workflowSave({ workflow_id: "loop-subject", name: "Subject" });
    const evidence = service.evidenceRecord({ source_type: "program", claim: "observed", confidence: "confirmed" });
    for (const trialId of ["loop-one", "loop-two"]) {
      service.trialStart({ trial_id: trialId, task_id: task.id, subject_type: "workflow", subject_id: subject.id,
        subject_version: subject.version });
      service.trialTraceAppend({ trial_id: trialId, event_type: "tool.failed", data: { tool: "x" }, evidence_ids: [evidence.id] });
      service.outcomeRecord({ trial_id: trialId, verdict: "failed", failure_type: "tool_error", summary: "failed", evidence_ids: [evidence.id] });
    }
    const candidate = ((service.experienceMine({ subject_type: "workflow", subject_id: subject.id,
      subject_version: subject.version }).candidates as JsonObject[])[0])!;
    assert.equal(candidate.lifecycle, "proposal_only");
    // Each evaluate finalizes the experiment, so blocked and ready runs use a
    // separate experiment over the same proposal-only candidate.
    const experiment = service.experienceShadowExperimentCreate({ task_id: task.id, mining_candidate_id: String(candidate.id),
      experiment_id: "loop-exp-blocked" }).experiment as JsonObject;
    const readyExperiment = service.experienceShadowExperimentCreate({ task_id: task.id, mining_candidate_id: String(candidate.id),
      experiment_id: "loop-exp-ready" }).experiment as JsonObject;

    const suite = service.evaluationSuiteSave({ name: "Held", cases: [{ case_id: "one", split: "held_out" }] });
    const workflow = (workflowId: string): JsonObject => service.workflowSave({ workflow_id: workflowId, name: workflowId,
      steps: [{ id: "proof", type: "assertion", evaluator: "file_exists", path: "ok.txt" }] });
    const baseline = workflow("loop-baseline");
    const proposed = workflow("loop-proposed");

    const judgePolicy = service.signoffPolicySave({ name: "Judge policy", requirements: [{ grader_type: "model" }] });
    assert.throws(() => service.experienceShadowExperimentEvaluate({ experiment_id: String(experiment.id), suite_id: suite.id,
      baseline_workflow_id: baseline.id, candidate_workflow_id: proposed.id, signoff_policy_id: judgePolicy.id,
      project_root: root, trials_per_case: 1 }),
    /requires a model or human Judge; pass an eligible judge_gate_id/u);

    const judge = service.judgeAdapterSave({ judge_id: "loop-judge", name: "Judge", grader_type: "model" });
    service.judgeCalibrationRecord({ calibration_id: "loop-calibration", judge_id: judge.id, total: 3, agreed: 3,
      gold_case_ids: ["one", "two", "three"] });
    const gateAssessment = store.create("evaluation_reliability", "loop-gate-assessment", { status: "eligible" });
    const eligibleGate = service.evaluationJudgeGate({ assessment_id: gateAssessment.id, judge_id: judge.id });
    assert.equal((eligibleGate.gate as JsonObject).status, "eligible");
    const blockedGate = store.create("evaluation_judge_gate", "loop-blocked", { status: "inconclusive" });

    const blocked = service.experienceShadowExperimentEvaluate({ experiment_id: String(experiment.id), suite_id: suite.id,
      baseline_workflow_id: baseline.id, candidate_workflow_id: proposed.id, signoff_policy_id: judgePolicy.id,
      project_root: root, trials_per_case: 1, min_trials: 1, judge_gate_id: String(blockedGate.id) });
    assert.equal(blocked.status, "rejected");
    assert.ok(((((blocked.promotion as JsonObject).promotion as JsonObject)).checks as JsonObject[])
      .some((c) => c.check === "judge_gate" && c.passed === false));

    const ready = service.experienceShadowExperimentEvaluate({ experiment_id: String(readyExperiment.id), suite_id: suite.id,
      baseline_workflow_id: baseline.id, candidate_workflow_id: proposed.id, signoff_policy_id: judgePolicy.id,
      project_root: root, trials_per_case: 1, min_trials: 1, judge_gate_id: String((eligibleGate.gate as JsonObject).id) });
    assert.equal(ready.status, "signoff_ready");
    const candidateRunId = String((ready.signoff_preparation as JsonObject).candidate_evaluation_run_id);
    const comparison = store.create("evaluation_comparison", "loop-comparison", { candidate_run_id: candidateRunId });
    const reliability = store.create("evaluation_reliability", "loop-reliability", { status: "eligible",
      comparison_id: comparison.id });
    const signoff = store.create("signoff", "loop-signoff", { decision: "passed", evaluation_run_id: candidateRunId });
    const adapted = service.adaptationCandidateCreate({ task_id: task.id,
      trial_ids: [(candidate.trial_ids as string[])[0] as string, (candidate.trial_ids as string[])[1] as string],
      evidence_ids: [evidence.id], hypothesis: "route through the verified candidate",
      applicability: "workflow trials with a held-out suite", design_axes: { orchestration: "candidate" } });
    assert.equal((adapted.candidate as JsonObject).lifecycle, "draft");
    const candidateId = String((adapted.candidate as JsonObject).id);
    assert.throws(() => service.adaptationCandidateAuthorizeCanary({ candidate_id: candidateId,
      assessment_id: reliability.id, signoff_id: signoff.id, judge_gate_id: String(blockedGate.id) }),
    /eligible calibrated Judge Gate/u);
    const canary = service.adaptationCandidateAuthorizeCanary({ candidate_id: candidateId,
      assessment_id: reliability.id, signoff_id: signoff.id, judge_gate_id: String((eligibleGate.gate as JsonObject).id) });
    assert.equal((canary.candidate as JsonObject).lifecycle, "canary_ready");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
