import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";

test("promotion separates cost from duration and is required before a Workflow becomes verified", async () => {
  const root = join(tmpdir(), `craft-promotion-gates-promotion-${process.pid}-${Date.now()}`);
  const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    const task = service.taskOpen({ title: "Promotion", goal: "Compare exactly" }).task as JsonObject;
    const suite = service.evaluationSuiteSave({ name: "Held", cases: [{ case_id: "case", split: "held_out" }] });
    const baseline = service.workflowSave({ workflow_id: "baseline-v097", name: "Baseline" });
    const candidateDraft = service.workflowSave({ workflow_id: "candidate-v097", name: "Candidate" });
    const candidate = service.workflowTransition({ workflow_id: candidateDraft.id, target: "candidate", reason: "evaluate" });
    const record = (trialId: string, subject: JsonObject, costs: JsonObject) => {
      service.trialStart({ trial_id: trialId, task_id: task.id, case_id: "case", subject_type: "workflow",
        subject_id: subject.id, subject_version: subject.version });
      service.outcomeRecord({ trial_id: trialId, verdict: "passed", summary: "passed", costs });
      return service.evaluationRunRecord({ run_id: `eval_${trialId}`, suite_id: suite.id, split: "held_out",
        subject_type: "workflow", subject_id: subject.id, subject_version: subject.version, trial_ids: [trialId] });
    };
    const baselineRun = record("baseline-trial", baseline, { tokens: 10, duration_ms: 100 });
    const candidateRun = record("candidate-trial", candidate, { tokens: 30, duration_ms: 50 });
    const comparison = service.evaluationCompare({ comparison_id: "comparison-v097", baseline_run_id: baselineRun.id, candidate_run_id: candidateRun.id });
    const rejected = service.evaluationPromotionAssess({ comparison_id: comparison.id, min_trials: 1,
      max_cost_regression_ratio: 2, max_duration_regression_ratio: 1 });
    assert.equal(rejected.eligible, false);
    assert.equal((rejected.comparison as JsonObject).cost_regression_ratio, 3);
    assert.equal((rejected.comparison as JsonObject).duration_regression_ratio, 0.5);
    const absentCost = service.evaluationPromotionAssess({ comparison_id: comparison.id, promotion_id: "missing-cost-v097", min_trials: 1,
      cost_metric: "credits", max_cost_regression_ratio: 1 });
    assert.equal(absentCost.eligible, false);
    assert.equal((absentCost.comparison as JsonObject).cost_regression_ratio, null);
    const noDurationBaseline = record("baseline-no-duration", baseline, { tokens: 10 });
    const noDurationCandidate = record("candidate-no-duration", candidate, { tokens: 10 });
    const noDurationComparison = service.evaluationCompare({ comparison_id: "no-duration-v097",
      baseline_run_id: noDurationBaseline.id, candidate_run_id: noDurationCandidate.id });
    const absentDuration = service.evaluationPromotionAssess({ comparison_id: noDurationComparison.id, min_trials: 1,
      max_duration_regression_ratio: 1 });
    assert.equal(absentDuration.eligible, false);
    assert.equal((absentDuration.comparison as JsonObject).duration_regression_ratio, null);
    assert.throws(() => service.workflowTransition({ workflow_id: candidate.id, target: "verified", reason: "missing promotion",
      evaluation_run_id: candidateRun.id }), /promotion/);
    assert.throws(() => service.workflowTransition({ workflow_id: candidate.id, target: "verified", reason: "rejected promotion",
      evaluation_run_id: candidateRun.id, promotion_id: (rejected.promotion as JsonObject).id }), /eligible promotion/);

    const acceptable = service.evaluationPromotionAssess({ comparison_id: comparison.id, promotion_id: "accepted-v097", min_trials: 1,
      max_cost_regression_ratio: 3, max_duration_regression_ratio: 1 });
    const verified = service.workflowTransition({ workflow_id: candidate.id, target: "verified", reason: "compared",
      evaluation_run_id: candidateRun.id, promotion_id: (acceptable.promotion as JsonObject).id });
    assert.equal(verified.lifecycle, "verified");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("evaluation run and program grader reject invalid provenance and grade idempotently", async () => {
  const root = join(tmpdir(), `craft-evaluation-edges-${process.pid}-${Date.now()}`);
  const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    const task = service.taskOpen({ title: "Evaluation edges", goal: "Exercise provenance guards" }).task as JsonObject;
    const suite = service.evaluationSuiteSave({ name: "Edge suite", cases: [
      { case_id: "held-a", split: "held_out" }, { case_id: "held-b", split: "held_out" },
      { case_id: "search", split: "search" },
    ] });
    const subject = service.workflowSave({ workflow_id: "evaluation-edge-workflow", name: "Evaluation edge workflow" });
    const other = service.workflowSave({ workflow_id: "evaluation-edge-other", name: "Other workflow" });
    const record = (trialId: string, caseId: string, workflow = subject, verdict: "passed" | "failed" = "passed", includeOutcome = true,
      environment: JsonObject = {}, budget: JsonObject = {}) => {
      service.trialStart({ trial_id: trialId, task_id: task.id, case_id: caseId, subject_type: "workflow", subject_id: workflow.id,
        subject_version: workflow.version, environment, budget });
      if (includeOutcome) service.outcomeRecord({ trial_id: trialId, verdict, summary: verdict, costs: { tokens: 3, duration_ms: 5 } });
      return trialId;
    };
    const validA = record("edge-a", "held-a");
    const validB = record("edge-b", "held-a", subject, "failed");
    const differentCase = record("edge-case", "held-b");
    const wrongSubject = record("edge-subject", "held-a", other);
    const wrongPartition = record("edge-partition", "search");
    const missingOutcome = record("edge-no-outcome", "held-a", subject, "passed", false);
    service.trialStart({ trial_id: "edge-no-case", task_id: task.id, subject_type: "workflow", subject_id: subject.id, subject_version: subject.version });
    const runA = service.evaluationRunRecord({ run_id: "edge-run-a", suite_id: suite.id, split: "held_out", subject_type: "workflow",
      subject_id: subject.id, subject_version: subject.version, trial_ids: [validA, validB] });
    assert.equal(runA.verdict, "failed");
    assert.throws(() => service.evaluationRunRecord({ suite_id: suite.id, split: "unknown", subject_type: "workflow",
      subject_id: subject.id, subject_version: subject.version, trial_ids: [validA] }), /Unsupported evaluation split/);
    assert.throws(() => service.evaluationRunRecord({ suite_id: suite.id, split: "held_out", subject_type: "workflow",
      subject_id: subject.id, subject_version: subject.version, trial_ids: [] }), /unique trials/);
    assert.throws(() => service.evaluationRunRecord({ suite_id: suite.id, split: "held_out", subject_type: "workflow",
      subject_id: subject.id, subject_version: subject.version, trial_ids: [validA, validA] }), /unique trials/);
    assert.throws(() => service.evaluationRunRecord({ suite_id: suite.id, split: "held_out", subject_type: "workflow",
      subject_id: subject.id, subject_version: subject.version, trial_ids: [wrongSubject] }), /subject mismatch/);
    assert.throws(() => service.evaluationRunRecord({ suite_id: suite.id, split: "held_out", subject_type: "workflow",
      subject_id: subject.id, subject_version: subject.version, trial_ids: [wrongPartition] }), /suite partition/);
    assert.throws(() => service.evaluationRunRecord({ suite_id: suite.id, split: "held_out", subject_type: "workflow",
      subject_id: subject.id, subject_version: subject.version, trial_ids: ["edge-no-case"] }), /suite partition/);
    assert.throws(() => service.evaluationRunRecord({ suite_id: suite.id, split: "held_out", subject_type: "workflow",
      subject_id: subject.id, subject_version: subject.version, trial_ids: [missingOutcome] }), /no outcome/);
    const runB = service.evaluationRunRecord({ run_id: "edge-run-b", suite_id: suite.id, split: "held_out", subject_type: "workflow",
      subject_id: subject.id, subject_version: subject.version, trial_ids: [differentCase] });
    assert.throws(() => service.evaluationCompare({ baseline_run_id: runA.id, candidate_run_id: runA.id }), /different runs/);
    assert.throws(() => service.evaluationCompare({ baseline_run_id: runA.id, candidate_run_id: runB.id }), /case_ids differ/);
    const sameCaseCandidateTrial = record("edge-same-case-candidate", "held-a", other);
    const sameCaseCandidateTrial2 = record("edge-same-case-candidate-2", "held-a", other);
    const sameCaseCandidateRun = service.evaluationRunRecord({ run_id: "edge-same-case-candidate-run", suite_id: suite.id, split: "held_out",
      subject_type: "workflow", subject_id: other.id, subject_version: other.version, trial_ids: [sameCaseCandidateTrial, sameCaseCandidateTrial2] });
    const sameCaseComparison = service.evaluationCompare({ baseline_run_id: runA.id, candidate_run_id: sameCaseCandidateRun.id });
    assert.equal(service.evaluationReliabilityAssess({ comparison_id: sameCaseComparison.id, assessment_id: "reliability-too-few",
      min_trials: 3 }).status, "inconclusive");
    assert.equal(service.evaluationReliabilityAssess({ comparison_id: sameCaseComparison.id, assessment_id: "reliability-tied",
      min_trials: 2 }).status, "rejected");

    const grader = service.graderSave({ grader_id: "edge-program-grader", name: "Program", grader_type: "program",
      configuration: { minimum_pass_rate: 0.5 } });
    const firstGrade = service.evaluationProgramGrade({ evaluation_run_id: runA.id, grader_id: grader.id });
    assert.equal(firstGrade.passed, true);
    assert.equal((service.evaluationProgramGrade({ evaluation_run_id: runA.id, grader_id: grader.id }).grades as JsonObject[])[0]?.id,
      (firstGrade.grades as JsonObject[])[0]?.id);
    const strict = service.graderSave({ grader_id: "edge-strict-grader", name: "Strict", grader_type: "program",
      configuration: { minimum_pass_rate: 0.75, maximum_mean_duration_ms: 0 } });
    assert.equal(service.evaluationProgramGrade({ evaluation_run_id: runA.id, grader_id: strict.id }).passed, false);
    const defaults = service.graderSave({ grader_id: "edge-default-grader", name: "Defaults", grader_type: "program", configuration: {} });
    assert.equal(service.evaluationProgramGrade({ evaluation_run_id: runA.id, grader_id: defaults.id }).passed, false);
    const modelGrader = service.graderSave({ grader_id: "edge-model-grader", name: "Model", grader_type: "model" });
    assert.throws(() => service.evaluationProgramGrade({ evaluation_run_id: runA.id, grader_id: modelGrader.id }), /program grader/);
    const invalid = service.graderSave({ grader_id: "edge-invalid-grader", name: "Invalid", grader_type: "program",
      configuration: { minimum_pass_rate: 2 } });
    assert.throws(() => service.evaluationProgramGrade({ evaluation_run_id: runA.id, grader_id: invalid.id }), /configuration is invalid/);
    assert.throws(() => service.evaluationPromotionAssess({ comparison_id: sameCaseComparison.id, min_trials: 1,
      min_pass_rate_delta: 2 }), /thresholds are invalid/);

    const passRun = service.evaluationRunRecord({ run_id: "edge-pass-run", suite_id: suite.id, split: "held_out", subject_type: "workflow",
      subject_id: subject.id, subject_version: subject.version, trial_ids: [validA] });
    const failedTrial = record("edge-counterexample", "held-a", other, "failed");
    const failRun = service.evaluationRunRecord({ run_id: "edge-fail-run", suite_id: suite.id, split: "held_out", subject_type: "workflow",
      subject_id: other.id, subject_version: other.version, trial_ids: [failedTrial] });
    const baselineWin = service.evaluationCompare({ baseline_run_id: passRun.id, candidate_run_id: failRun.id });
    service.evaluationPromotionAssess({ comparison_id: baselineWin.id, min_trials: 1 });

    const alteredSuite = service.evaluationSuiteSave({ name: "Altered suite", cases: [{ case_id: "held-a", split: "held_out" }] });
    const alteredTrial1 = record("edge-other-suite-1", "held-a", other);
    const alteredTrial2 = record("edge-other-suite-2", "held-a", other);
    const alteredRun = service.evaluationRunRecord({ run_id: "edge-other-suite-run", suite_id: alteredSuite.id, split: "held_out", subject_type: "workflow",
      subject_id: other.id, subject_version: other.version, trial_ids: [alteredTrial1, alteredTrial2] });
    assert.throws(() => service.evaluationCompare({ baseline_run_id: runA.id, candidate_run_id: alteredRun.id }), /suite_id differs/);

    const coordinator = (service as unknown as { evaluationRuns: { evaluationPairedComparison(a: JsonObject, b: JsonObject): JsonObject } }).evaluationRuns;
    assert.equal(coordinator.evaluationPairedComparison({ trial_ids: [validA] }, { trial_ids: [differentCase] }).unmatched_baseline_trials, 1);

    const baselineTrials: string[] = [], candidateTrials: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      baselineTrials.push(record(`reliability-base-${i}`, "held-a", subject, "failed", true, { node: 24 }, { tokens: 10 }));
      candidateTrials.push(record(`reliability-candidate-${i}`, "held-a", other, "passed", true, { node: 24 }, { tokens: 10 }));
    }
    const baselineRun = service.evaluationRunRecord({ run_id: "reliability-baseline", suite_id: suite.id, split: "held_out",
      subject_type: "workflow", subject_id: subject.id, subject_version: subject.version, trial_ids: baselineTrials });
    const candidateRun = service.evaluationRunRecord({ run_id: "reliability-candidate", suite_id: suite.id, split: "held_out",
      subject_type: "workflow", subject_id: other.id, subject_version: other.version, trial_ids: candidateTrials });
    const comparison = service.evaluationCompare({ comparison_id: "reliability-comparison", baseline_run_id: baselineRun.id, candidate_run_id: candidateRun.id });
    assert.equal(service.evaluationReliabilityAssess({ comparison_id: comparison.id, min_trials: 20 }).status, "eligible");
    assert.throws(() => service.evaluationReliabilityAssess({ comparison_id: comparison.id, assessment_id: "invalid-budget-ratio", min_trials: 20,
      max_budget_ratio: -1 }), /max_budget_ratio/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("runtime adapters can lease and report only their declared controlled operations", async () => {
  const root = join(tmpdir(), `craft-promotion-gates-adapter-${process.pid}-${Date.now()}`);
  const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    const task = service.taskOpen({ title: "Adapter", goal: "Host work stays attributable" }).task as JsonObject;
    const policy = service.runtimePolicySave({ name: "Read only", allowed_effects: ["read_only"] });
    const adapter = service.runtimeAdapterSave({ name: "Codex controlled", host: "codex", allowed_kinds: ["agent", "grader"],
      allowed_effects: ["read_only"], max_concurrency: 1, supports_pause_resume: true, supports_evidence_receipts: true });
    service.runtimeRunStart({ run_id: "adapter-run", task_id: task.id, policy_id: policy.id, environment: {}, operations: [
      { operation_id: "agent-op", kind: "agent", effect: "read_only", objective: "inspect" },
      { operation_id: "workflow-op", kind: "workflow", effect: "read_only", objective: "leave for driver" },
      { operation_id: "grader-op", kind: "grader", effect: "read_only", objective: "judge", depends_on: ["agent-op"] },
    ] });
    const lease = service.runtimeAdapterDispatch({ runtime_adapter_id: adapter.id, runtime_adapter_version: adapter.version, run_id: "adapter-run" });
    assert.equal((lease.operations as JsonObject[]).length, 1);
    assert.equal(((lease.operations as JsonObject[])[0]).operation_id, "agent-op");
    const externalArtifact = service.artifactRegister({ kind: "log", name: "host log", uri: "craft://host-log" });
    const externalEvidence = service.evidenceRecord({ source_type: "host", confidence: "bounded", claim: "host log", artifact_id: externalArtifact.id });
    const reported = service.runtimeAdapterReport({ runtime_adapter_id: adapter.id, runtime_adapter_version: adapter.version, operation_id: "agent-op",
      lease_id: (lease.operations as JsonObject[])[0].lease_id, verdict: "passed", summary: "inspected", costs: { tokens: 7 },
      artifact_ids: [externalArtifact.id], evidence_ids: [externalEvidence.id], retryable: false, idempotency_key: "adapter-report" });
    assert.equal((reported.operation as JsonObject).status, "passed");
    const grader = service.runtimeAdapterDispatch({ runtime_adapter_id: adapter.id, run_id: "adapter-run" });
    assert.equal(((grader.operations as JsonObject[])[0]).operation_id, "grader-op");
    const agentOnly = service.runtimeAdapterSave({ name: "Agent only", host: "generic", allowed_kinds: ["agent"],
      allowed_effects: ["read_only"], max_concurrency: 1 });
    assert.throws(() => service.runtimeAdapterReport({ runtime_adapter_id: agentOnly.id, operation_id: "grader-op",
      lease_id: (grader.operations as JsonObject[])[0].lease_id, verdict: "passed", summary: "wrong adapter" }), /authorized/);
    assert.throws(() => service.runtimeAdapterSave({ name: "Bad kind", host: "codex", allowed_kinds: ["unknown"],
      allowed_effects: ["read_only"], max_concurrency: 1 }), /unsupported/);
    assert.throws(() => service.runtimeAdapterSave({ name: "Bad host", host: "unknown", allowed_kinds: ["agent"],
      allowed_effects: ["read_only"], max_concurrency: 1 }), /host/);
    assert.throws(() => service.runtimeAdapterSave({ name: "Bad environment", host: "codex", allowed_kinds: ["agent"],
      allowed_effects: ["read_only"], execution_environment: "unknown", max_concurrency: 1 }), /environment/);
    assert.throws(() => service.runtimeAdapterSave({ name: "Unsafe", host: "codex", allowed_kinds: ["agent"],
      allowed_effects: ["external_write"], max_concurrency: 1 }), /effects/);
    assert.throws(() => service.runtimeDispatch({ run_id: "adapter-run", claimed_by: "host", effects: ["unknown"] }), /effects/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
