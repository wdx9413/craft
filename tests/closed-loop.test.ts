import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

test("eval runner executes comparable held-out workflow trials and produces a version comparison", async () => {
  const root = join(tmpdir(), `craft-eval-runner-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "ok.txt"), "ok");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  try {
    const task = service.taskOpen({ title: "Eval", goal: "Compare workflows" }).task as JsonObject;
    const suite = service.evaluationSuiteSave({ name: "Held", cases: [{ case_id: "one", split: "held_out" },
      { case_id: "two", split: "held_out" }] });
    const workflow = (workflowId: string): JsonObject => service.workflowSave({ workflow_id: workflowId, name: workflowId,
      steps: [{ id: "proof", type: "assertion", evaluator: "file_exists", path: "ok.txt" }] });
    const baseline = workflow("baseline"); const candidate = workflow("candidate");
    const result = service.evaluationRunnerRun({ runner_id: "runner", task_id: task.id, suite_id: suite.id,
      split: "held_out", project_root: root, trials_per_case: 2, subjects: [
        { label: "baseline", subject_type: "workflow", subject_id: baseline.id, subject_version: baseline.version },
        { label: "candidate", subject_type: "workflow", subject_id: candidate.id, subject_version: candidate.version },
      ] });
    assert.equal((result.evaluation_runs as JsonObject[]).length, 2);
    assert.equal(typeof (result.comparison as JsonObject).assessment, "string");
    assert.equal((result.aggregate as JsonObject).baseline_trials, 4);
    assert.throws(() => service.evaluationRunnerRun({ task_id: task.id, suite_id: suite.id, split: "held_out",
      project_root: root, subjects: [{ label: "agent", subject_type: "agent_profile", subject_id: "a", subject_version: 1 }] }), /workflow/);
    assert.throws(() => service.evaluationRunnerRun({ task_id: task.id, suite_id: suite.id, split: "held_out", project_root: root,
      subjects: [{ label: "only", subject_type: "workflow", subject_id: baseline.id, subject_version: baseline.version }] }), /at least two/);
    assert.throws(() => service.evaluationRunnerRun({ task_id: task.id, suite_id: suite.id, suite_version: suite.version,
      split: "invalid", project_root: root, subjects: [{ label: "left", subject_type: "workflow", subject_id: baseline.id, subject_version: baseline.version },
        { label: "right", subject_type: "workflow", subject_id: candidate.id, subject_version: candidate.version }] }), /Unsupported evaluation split/);
    assert.throws(() => service.evaluationRunnerRun({ task_id: task.id, suite_id: suite.id, split: "development", project_root: root,
      subjects: [{ label: "left", subject_type: "workflow", subject_id: baseline.id, subject_version: baseline.version },
        { label: "right", subject_type: "workflow", subject_id: candidate.id, subject_version: candidate.version }] }), /has no development cases/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("experience miner keeps repeated trace evidence as a proposal-only candidate and drift monitor separates alerts", async () => {
  const root = join(tmpdir(), `craft-miner-${process.pid}-${Date.now()}`);
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  try {
    const task = service.taskOpen({ title: "Mine", goal: "Learn safely" }).task as JsonObject;
    const subject = service.workflowSave({ workflow_id: "subject", name: "Subject" });
    const evidence = service.evidenceRecord({ source_type: "program", claim: "observed", confidence: "confirmed" });
    for (const trialId of ["one", "two"]) {
      service.trialStart({ trial_id: trialId, task_id: task.id, subject_type: "workflow", subject_id: subject.id,
        subject_version: subject.version });
      service.trialTraceAppend({ trial_id: trialId, event_type: "tool.failed", data: { tool: "x" }, evidence_ids: [evidence.id] });
      service.outcomeRecord({ trial_id: trialId, verdict: "failed", failure_type: "tool_error", summary: "failed", evidence_ids: [evidence.id] });
    }
    const nullFailure = service.trialStart({ trial_id: "null-failure", task_id: task.id, subject_type: "workflow", subject_id: subject.id,
      subject_version: subject.version });
    store.create("outcome", `outcome_${nullFailure.id}`, { trial_id: nullFailure.id, verdict: "failed", failure_type: null,
      summary: "failed", scores: {}, costs: {}, evidence_ids: [evidence.id], source: "program_verified" });
    const mined = service.experienceMine({ subject_type: "workflow", subject_id: subject.id, subject_version: subject.version });
    const candidate = (mined.candidates as JsonObject[])[0];
    assert.equal(candidate.lifecycle, "proposal_only");
    assert.equal(candidate.failure_type, "tool_error");
    assert.equal((candidate.trial_ids as string[]).length, 2);
    assert.equal((service.experienceMine({ subject_type: "workflow", subject_id: subject.id, subject_version: 999 }).candidates as JsonObject[]).length, 0);

    for (const value of [10, 10, 20, 20]) service.operationalSignalRecord({ subject_type: "workflow", subject_id: subject.id,
      metric: "latency_ms", value, task_id: task.id });
    assert.throws(() => service.operationalSignalRecord({ subject_type: "workflow", subject_id: subject.id, metric: "latency_ms", value: -1 }), /non-negative/);
    const drift = service.operationalDriftEvaluate({ subject_type: "workflow", subject_id: subject.id,
      metric: "latency_ms", window_size: 2, direction: "lower", threshold: 0.5 });
    assert.equal(drift.alert, true);
    assert.equal((service.operationalDriftEvaluate({ subject_type: "workflow", subject_id: subject.id,
      metric: "latency_ms", window_size: 3, direction: "lower", threshold: 0.5 }).alert), false);
    assert.equal((service.operationalDriftEvaluate({ subject_type: "workflow", subject_id: subject.id,
      metric: "latency_ms", window_size: 2, direction: "higher", threshold: 0.5 }).alert), false);
    assert.throws(() => service.operationalDriftEvaluate({ subject_type: "workflow", subject_id: subject.id,
      metric: "latency_ms", direction: "sideways", threshold: 0.5 }), /direction/);
    assert.throws(() => service.operationalDriftEvaluate({ subject_type: "workflow", subject_id: subject.id,
      metric: "latency_ms", direction: "lower", threshold: -1 }), /threshold/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
