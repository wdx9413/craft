import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

test("promotion separates cost from duration and is required before a Workflow becomes verified", async () => {
  const root = join(tmpdir(), `craft-v097-promotion-${process.pid}-${Date.now()}`);
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

test("runtime adapters can lease and report only their declared controlled operations", async () => {
  const root = join(tmpdir(), `craft-v097-adapter-${process.pid}-${Date.now()}`);
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
