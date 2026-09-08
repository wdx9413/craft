import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore } from "../src/store.ts";

test("service persists capabilities, tasks, feedback, artifacts, evidence, and versioned assets", async () => {
  const root = join(tmpdir(), `craft-service-${process.pid}-${Date.now()}`);
  const skills = join(root, "skills");
  await mkdir(skills, { recursive: true });
  const otherSkills = join(root, "other-skills");
  await mkdir(otherSkills, { recursive: true });
  await writeFile(join(skills, "SKILL.md"), "---\nname: diagnose\ndescription: trace failures\n---\nUse evidence.");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  try {
    const source = await service.sourceAdd({ path: skills });
    const labelledSource = await service.sourceAdd({ path: otherSkills, label: "Other", scan: false });
    assert.throws(() => service.sourceAdd({ path: skills, scan: "false" }), /scan must be a boolean/);
    assert.equal(service.sourceList().sources instanceof Array, true);
    assert.equal((await service.capabilitySearch({ query: "trace" })).capabilities instanceof Array, true);
    const capability = ((await service.capabilitySearch({ query: "trace" })).capabilities as Record<string, unknown>[])[0];
    assert.equal(service.capabilityGet({ asset_id: capability.id }).name, "diagnose");
    service.sourceUpdate({ source_id: source.id, label: "Skills" });
    service.sourceUpdate({ source_id: labelledSource.id, enabled: true });
    assert.throws(() => service.sourceUpdate({ source_id: source.id, enabled: "false" }), /enabled must be a boolean/);
    await service.sourceScan({ source_id: source.id });
    await service.sourceScan({});

    const opened = service.taskOpen({ title: "Fix", goal: "Find cause", project_id: "p" });
    const taskId = String((opened.task as Record<string, unknown>).id);
    assert.equal((service.taskOpen({ task_id: taskId }).task as Record<string, unknown>).status, "active");
    assert.equal((service.taskList({ project_id: "p", status: "active" }).tasks as unknown[]).length, 1);
    assert.throws(() => service.taskList({ status: "bad" }), /Unsupported task status/);
    assert.throws(() => service.taskCheckpoint({ task_id: taskId, summary: "x", status: "bad" }), /Unsupported task status/);
    assert.throws(() => service.taskCheckpoint({ task_id: taskId, summary: "x", completed: "bad" }), /completed must be an array/);
    service.feedbackRecord({ corrected: "Prefer proof", task_id: taskId });
    service.taskCheckpoint({ task_id: taskId, summary: "Done", status: "completed" });
    assert.equal((service.taskOpen({ task_id: taskId }).feedback as unknown[]).length, 1);
    assert.throws(() => service.feedbackRecord({ corrected: "x" }), /task_id/);
    assert.throws(() => service.feedbackRecord({ corrected: "x", scope: "bad" }), /scope/);
    service.feedbackRecord({ corrected: "global", scope: "user" });

    const artifact = service.artifactRegister({ kind: "report", name: "R", uri: "file:///r" });
    const evidence = service.evidenceRecord({ source_type: "test", claim: "passes", confidence: "confirmed",
      artifact_id: artifact.id });
    assert.equal(service.get("artifact", "artifact_id", { artifact_id: artifact.id }).name, "R");
    assert.equal(service.get("evidence", "evidence_id", { evidence_id: evidence.id }).claim, "passes");
    assert.throws(() => service.evidenceRecord({ source_type: "x", claim: "y", confidence: "bad" }), /confidence/);
    assert.throws(() => service.evidenceRecord({ source_type: "x", claim: "y", artifact_id: "missing" }), /Unknown artifact/);
    service.evidenceRecord({ source_type: "model", claim: "maybe" });
    assert.equal((service.list("evidence", "items", { query: "passes", limit: 5 }).items as unknown[]).length, 1);
    assert.equal((service.list("evidence", "items", {}).items as unknown[]).length, 2);
    assert.throws(() => service.list("evidence", "items", { limit: Number.NaN }), /limit/);

    const workflow = service.saveVersioned("workflow", "workflow", { name: "Review" }, ["name"]);
    service.saveVersioned("workflow", "workflow", { workflow_id: workflow.id, name: "Review v2" }, ["name"]);
    assert.equal(service.get("workflow", "workflow_id", { workflow_id: workflow.id, version: 1 }).name, "Review");
    assert.throws(() => service.get("workflow", "workflow_id", { workflow_id: workflow.id, version: 1.5 }), /version/);
    const runnable = service.saveVersioned("workflow", "workflow", { name: "Runnable",
      inputs: [{ name: "file", required: true }], steps: [{ id: "exists", type: "assertion",
        evaluator: "file_exists", path: "{{file}}" }] }, ["name"]);
    const plan = service.workflowPlan({ workflow_id: runnable.id, inputs: { file: "skills/SKILL.md" } });
    assert.equal(plan.executable, true);
    assert.throws(() => service.workflowPlan({ workflow_id: runnable.id, inputs: [] }), /inputs must be an object/);
    assert.throws(() => service.workflowPlan({ workflow_id: runnable.id, inputs: { file: "x" }, approved_side_effects: "bad" }), /approved_side_effects/);
    const run = service.workflowRun({ workflow_id: runnable.id, inputs: { file: "skills/SKILL.md" }, project_root: root });
    assert.equal(run.status, "passed");
    assert.equal(service.workflowRun({ workflow_id: runnable.id, inputs: { file: "missing" }, project_root: root }).status, "failed");
    const passedTrial = service.workflowTrialRun({ task_id: taskId, workflow_id: runnable.id,
      inputs: { file: "skills/SKILL.md" }, project_root: root });
    assert.equal((passedTrial.workflow_run as Record<string, unknown>).status, "passed");
    assert.equal((passedTrial.outcome as Record<string, unknown>).verdict, "passed");
    assert.equal((passedTrial.trace as unknown[]).length, 2);
    assert.equal((passedTrial.artifact as Record<string, unknown>).kind, "workflow_receipt");
    const failedTrial = service.workflowTrialRun({ task_id: taskId, workflow_id: runnable.id,
      inputs: { file: "missing" }, project_root: root });
    assert.equal((failedTrial.outcome as Record<string, unknown>).verdict, "failed");
    const originalWorkflowRun = service.workflowRun;
    service.workflowRun = () => { throw new Error("sensitive crash detail"); };
    const crashedTrial = service.workflowTrialRun({ task_id: taskId, workflow_id: runnable.id,
      inputs: { file: "skills/SKILL.md" }, project_root: root });
    service.workflowRun = originalWorkflowRun;
    assert.equal(crashedTrial.workflow_run, null);
    assert.equal(crashedTrial.artifact, null);
    assert.equal((crashedTrial.outcome as Record<string, unknown>).verdict, "failed");
    assert.equal(JSON.stringify(crashedTrial).includes("sensitive crash detail"), false);
    service.saveVersioned("agent_profile", "profile", { profile_id: "p", name: "P", role: "worker",
      host: "local", model: "test" }, ["name", "role", "host", "model"]);
    const orchestration = service.orchestrationCreate({ goal: "Build", max_concurrency: 2, nodes: [
      { id: "work", role: "worker", objective: "do", profile_ids: ["p"] },
    ] });
    const dispatched = service.orchestrationDispatch({ plan_id: orchestration.id, claimed_by: "host", capacity: 9 });
    const leaseId = String(((dispatched.leases as Record<string, unknown>[])[0]).lease_id);
    assert.throws(() => service.orchestrationSubmit({ plan_id: orchestration.id, lease_id: leaseId,
      verdict: "passed", claimed_by: "other" }), /owner/);
    assert.equal(service.orchestrationSubmit({ plan_id: orchestration.id, lease_id: leaseId, verdict: "passed" }).status, "completed");
    assert.throws(() => service.orchestrationDispatch({ plan_id: orchestration.id, claimed_by: "host" }), /not running/);
    assert.throws(() => service.orchestrationCreate({ goal: "x", max_concurrency: 0, nodes: [
      { id: "x", role: "r", objective: "o", profile_ids: ["p"] },
    ] }), /max_concurrency/);
    assert.throws(() => service.orchestrationCreate({ goal: "x" }), /At least one/);
    assert.throws(() => service.orchestrationCreate({ goal: "x", policy: [], nodes: [
      { id: "x", role: "r", objective: "o", profile_ids: ["p"] },
    ] }), /policy must be an object/);
    const invalidCapacity = service.orchestrationCreate({ goal: "x", nodes: [
      { id: "x", role: "r", objective: "o", profile_ids: ["p"] },
    ] });
    assert.throws(() => service.orchestrationDispatch({ plan_id: invalidCapacity.id, claimed_by: "h", capacity: "bad" }), /capacity/);
    const recoverable = service.orchestrationCreate({ goal: "Recover", lease_ttl_seconds: 60, budget: { tokens: 1 }, nodes: [
      { id: "recover", role: "worker", objective: "do", profile_ids: ["p"] },
      { id: "blocked", role: "reviewer", objective: "review", profile_ids: ["p"], depends_on: ["recover"] },
    ] });
    const recoverDispatch = service.orchestrationDispatch({ plan_id: recoverable.id, claimed_by: "h" });
    const recoverLease = (recoverDispatch.leases as Record<string, unknown>[])[0];
    assert.throws(() => service.orchestrationRenew({ plan_id: recoverable.id, lease_id: recoverLease.lease_id,
      claimed_by: "other" }), /owner/);
    assert.throws(() => service.orchestrationRenew({ plan_id: recoverable.id, lease_id: "missing", claimed_by: "h" }), /Unknown lease/);
    const renewed = service.orchestrationRenew({ plan_id: recoverable.id, lease_id: recoverLease.lease_id, claimed_by: "h" });
    assert.equal(renewed.status, "running");
    const firstSubmit = service.orchestrationSubmit({ plan_id: recoverable.id, lease_id: recoverLease.lease_id,
      claimed_by: "h", verdict: "passed", costs: { tokens: 2 }, idempotency_key: "once" });
    assert.equal(firstSubmit.budget_exceeded, true);
    assert.equal(firstSubmit.status, "failed");
    const duplicateSubmit = service.orchestrationSubmit({ plan_id: recoverable.id, lease_id: recoverLease.lease_id,
      claimed_by: "h", verdict: "passed", costs: { tokens: 2 }, idempotency_key: "once" });
    assert.equal(duplicateSubmit.version, firstSubmit.version);
    assert.throws(() => service.orchestrationSubmit({ plan_id: recoverable.id, lease_id: recoverLease.lease_id,
      verdict: "failed", idempotency_key: "once" }), /different submission/);
    assert.throws(() => service.orchestrationCreate({ goal: "bad budget", budget: { tokens: -1 }, nodes: [
      { id: "x", role: "r", objective: "o", profile_ids: ["p"] },
    ] }), /budget limit/);
    assert.throws(() => service.orchestrationRenew({ plan_id: recoverable.id, lease_id: recoverLease.lease_id,
      claimed_by: "h" }), /not running/);
    const legacyPlan = service.orchestrationCreate({ goal: "Legacy submit", nodes: [
      { id: "legacy", role: "worker", objective: "do", profile_ids: ["p"] },
    ] });
    const { budget: _budget, submission_receipts: _receipts, ...legacyPayload } = legacyPlan;
    store.save("orchestration_plan", String(legacyPlan.id), legacyPayload);
    const legacyDispatch = service.orchestrationDispatch({ plan_id: legacyPlan.id, claimed_by: "h" });
    assert.equal(service.orchestrationSubmit({ plan_id: legacyPlan.id,
      lease_id: (legacyDispatch.leases as Record<string, unknown>[])[0].lease_id, verdict: "passed" }).status, "completed");
    assert.throws(() => service.saveVersioned("workflow", "workflow", {}, ["name"]), /name/);
    assert.equal((service.info().counts as Record<string, number>).workflow, 2);
    service.sourceRemove({ source_id: source.id });
    service.sourceRemove({ source_id: labelledSource.id });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("service validates required text", async () => {
  const root = join(tmpdir(), `craft-service-invalid-${process.pid}-${Date.now()}`);
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  try {
    assert.throws(() => service.taskOpen({ title: "", goal: "x" }), /title/);
    assert.throws(() => service.sourceAdd({ path: "" }), /path/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("experience kernel qualifies and rolls back workflows with immutable trials", async () => {
  const root = join(tmpdir(), `craft-experience-${process.pid}-${Date.now()}`);
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  try {
    const taskPack = service.taskOpen({ title: "Qualification", goal: "Verify a workflow" });
    const taskId = String((taskPack.task as Record<string, unknown>).id);
    assert.equal((service.evaluationSuiteSave({ name: "Empty" }).cases as unknown[]).length, 0);
    const harness = service.harnessConfigurationSave({ name: "Careful", dimensions: {
      context: { retrieval: "bounded" }, tools: { allow: ["tests"] }, generation: { budget: 1 },
      orchestration: { topology: "single" }, memory: { policy: "task" }, output: { validator: "tests" },
    } });
    const harnessV2 = service.harnessConfigurationSave({ configuration_id: harness.id,
      name: "Careful 2", dimensions: {} });
    assert.equal(harnessV2.version, 2);
    assert.throws(() => service.harnessConfigurationSave({ name: "bad", dimensions: { unknown: {} } }), /dimension/);
    assert.throws(() => service.harnessConfigurationSave({ name: "bad", dimensions: { context: [] } }), /must be an object/);

    const draft = service.workflowSave({ workflow_id: "workflow_qualified", name: "Qualified", steps: [] });
    assert.equal(draft.lifecycle, "draft");
    const legacy = service.saveVersioned("workflow", "workflow", { workflow_id: "workflow_legacy", name: "Legacy" }, ["name"]);
    assert.equal(service.workflowTransition({ workflow_id: legacy.id, target: "candidate", reason: "migrate" }).lifecycle, "candidate");
    assert.throws(() => service.workflowTransition({ workflow_id: draft.id, target: "verified", reason: "skip" }), /Invalid/);
    assert.throws(() => service.workflowTransition({ workflow_id: draft.id, target: "unknown", reason: "x" }), /Unsupported/);
    const corrupt = store.save("workflow", "workflow_corrupt", { name: "Corrupt", lifecycle: "other" });
    assert.throws(() => service.workflowTransition({ workflow_id: corrupt.id, target: "candidate", reason: "x" }), /Invalid/);
    const candidate = service.workflowTransition({ workflow_id: draft.id, target: "candidate", reason: "ready" });
    assert.equal(candidate.lifecycle, "candidate");

    const suite = service.evaluationSuiteSave({ name: "Held out", cases: [
      { case_id: "dev-1" }, { case_id: "held-1", split: "held_out" },
      { case_id: "held-2", split: "held_out" },
    ] });
    assert.throws(() => service.evaluationSuiteSave({ name: "bad", cases: [{ case_id: "x", split: "bad" }] }), /split/);
    assert.throws(() => service.evaluationSuiteSave({ name: "bad", cases: [
      { case_id: "x" }, { case_id: "x" },
    ] }), /unique/);
    assert.throws(() => service.evaluationSuiteSave({ name: "bad", cases: ["x"] }), /must be an object/);

    const trial = service.trialStart({ trial_id: "trial_pass", task_id: taskId, case_id: "held-1",
      subject_type: "workflow", subject_id: candidate.id, subject_version: candidate.version,
      harness_configuration_id: harness.id, harness_configuration_version: 1,
      environment: { host: "codex" }, budget: { tokens: 1000 } });
    assert.equal(trial.harness_configuration_version, 1);
    assert.throws(() => service.trialStart({ trial_id: "trial_pass", task_id: taskId,
      subject_type: "workflow", subject_id: candidate.id, subject_version: candidate.version }), /already exists/);
    const pending = service.trialStart({ task_id: taskId, case_id: "held-2", subject_type: "workflow",
      subject_id: candidate.id, subject_version: candidate.version, harness_configuration_id: harness.id });
    assert.equal(service.trialGet({ trial_id: pending.id }).outcome, null);
    const traceArtifact = service.artifactRegister({ kind: "log", name: "trace", uri: "file:///trace" });
    const evidence = service.evidenceRecord({ source_type: "test", claim: "held-out passed", confidence: "confirmed",
      artifact_id: traceArtifact.id });
    service.trialTraceAppend({ trial_id: trial.id, event_type: "tool.completed", source: "program",
      data: { exit_code: 0 }, artifact_ids: [traceArtifact.id], evidence_ids: [evidence.id] });
    service.trialTraceAppend({ trial_id: trial.id, event_type: "assistant.completed" });
    assert.throws(() => service.trialTraceAppend({ trial_id: trial.id, event_type: "bad",
      artifact_ids: ["missing"] }), /Unknown artifact/);
    assert.throws(() => service.trialTraceAppend({ trial_id: trial.id, event_type: "bad",
      evidence_ids: ["missing"] }), /Unknown evidence/);
    const outcome = service.outcomeRecord({ trial_id: trial.id, verdict: "passed", summary: "All checks passed",
      scores: { correctness: 1 }, costs: { tokens: 120 }, evidence_ids: [evidence.id], source: "program_verified" });
    assert.equal(outcome.verdict, "passed");
    assert.equal((service.trialGet({ trial_id: trial.id }).trace as unknown[]).length, 2);
    assert.throws(() => service.outcomeRecord({ trial_id: trial.id, verdict: "passed", summary: "again" }), /already exists/);
    assert.throws(() => service.outcomeRecord({ trial_id: pending.id, verdict: "unknown", summary: "x" }), /verdict/);
    assert.throws(() => service.outcomeRecord({ trial_id: pending.id, verdict: "passed", summary: "x",
      evidence_ids: ["missing"] }), /Unknown evidence/);
    store.save("evaluation_suite", "suite_legacy", { name: "Legacy suite" });
    assert.throws(() => service.evaluationRunRecord({ suite_id: "suite_legacy", split: "held_out",
      subject_type: "workflow", subject_id: candidate.id, subject_version: candidate.version,
      trial_ids: [trial.id] }), /partition/);

    assert.throws(() => service.evaluationRunRecord({ suite_id: suite.id, split: "bad",
      subject_type: "workflow", subject_id: candidate.id, subject_version: candidate.version, trial_ids: [trial.id] }), /split/);
    assert.throws(() => service.evaluationRunRecord({ suite_id: suite.id, split: "held_out",
      subject_type: "workflow", subject_id: candidate.id, subject_version: candidate.version, trial_ids: [] }), /trial_ids/);
    assert.throws(() => service.evaluationRunRecord({ suite_id: suite.id, split: "held_out",
      subject_type: "workflow", subject_id: candidate.id, subject_version: candidate.version,
      trial_ids: [trial.id, trial.id] }), /trial_ids/);
    assert.throws(() => service.evaluationRunRecord({ suite_id: suite.id, split: "held_out",
      subject_type: "workflow", subject_id: draft.id, subject_version: draft.version, trial_ids: [trial.id] }), /subject mismatch/);
    assert.throws(() => service.evaluationRunRecord({ suite_id: suite.id, split: "development",
      subject_type: "workflow", subject_id: candidate.id, subject_version: candidate.version, trial_ids: [trial.id] }), /partition/);
    assert.throws(() => service.evaluationRunRecord({ suite_id: suite.id, split: "held_out",
      subject_type: "workflow", subject_id: candidate.id, subject_version: candidate.version, trial_ids: [pending.id] }), /no outcome/);

    const noCase = service.trialStart({ task_id: taskId, subject_type: "workflow",
      subject_id: candidate.id, subject_version: candidate.version });
    assert.throws(() => service.evaluationRunRecord({ suite_id: suite.id, split: "held_out",
      subject_type: "workflow", subject_id: candidate.id, subject_version: candidate.version, trial_ids: [noCase.id] }), /partition/);
    const otherWorkflow = service.workflowSave({ workflow_id: "workflow_other", name: "Other" });
    const otherTrial = service.trialStart({ task_id: taskId, case_id: "held-1", subject_type: "workflow",
      subject_id: otherWorkflow.id, subject_version: otherWorkflow.version });
    assert.throws(() => service.evaluationRunRecord({ suite_id: suite.id, split: "held_out",
      subject_type: "workflow", subject_id: candidate.id, subject_version: candidate.version, trial_ids: [otherTrial.id] }), /subject mismatch/);
    const profile = service.saveVersioned("agent_profile", "profile", {
      profile_id: "profile_eval", name: "Evaluator", role: "judge", host: "local", model: "test",
    }, ["name", "role", "host", "model"]);
    const profileTrial = service.trialStart({ task_id: taskId, case_id: "held-1", subject_type: "agent_profile",
      subject_id: profile.id, subject_version: profile.version });
    assert.throws(() => service.evaluationRunRecord({ suite_id: suite.id, split: "held_out",
      subject_type: "workflow", subject_id: candidate.id, subject_version: candidate.version, trial_ids: [profileTrial.id] }), /subject mismatch/);

    const evalRun = service.evaluationRunRecord({ run_id: "eval_pass", suite_id: suite.id,
      suite_version: suite.version, split: "held_out", subject_type: "workflow",
      subject_id: candidate.id, subject_version: candidate.version, trial_ids: [trial.id], metrics: { pass_rate: 1 } });
    assert.equal(evalRun.verdict, "passed");
    const devTrial = service.trialStart({ task_id: taskId, case_id: "dev-1", subject_type: "workflow",
      subject_id: candidate.id, subject_version: candidate.version });
    service.outcomeRecord({ trial_id: devTrial.id, verdict: "passed", summary: "development passed" });
    const devRun = service.evaluationRunRecord({ suite_id: suite.id, split: "development",
      subject_type: "workflow", subject_id: candidate.id, subject_version: candidate.version, trial_ids: [devTrial.id] });
    assert.throws(() => service.workflowTransition({ workflow_id: candidate.id, target: "verified",
      reason: "not held out", evaluation_run_id: devRun.id }), /passed held-out/);
    service.outcomeRecord({ trial_id: profileTrial.id, verdict: "passed", summary: "profile passed" });
    const profileRun = service.evaluationRunRecord({ suite_id: suite.id, split: "held_out",
      subject_type: "agent_profile", subject_id: profile.id, subject_version: profile.version,
      trial_ids: [profileTrial.id] });
    assert.throws(() => service.workflowTransition({ workflow_id: candidate.id, target: "verified",
      reason: "wrong subject type", evaluation_run_id: profileRun.id }), /passed held-out/);
    service.outcomeRecord({ trial_id: otherTrial.id, verdict: "passed", summary: "other passed" });
    const otherRun = service.evaluationRunRecord({ suite_id: suite.id, split: "held_out",
      subject_type: "workflow", subject_id: otherWorkflow.id, subject_version: otherWorkflow.version,
      trial_ids: [otherTrial.id] });
    assert.throws(() => service.workflowTransition({ workflow_id: candidate.id, target: "verified",
      reason: "wrong subject", evaluation_run_id: otherRun.id }), /passed held-out/);
    assert.throws(() => service.workflowTransition({ workflow_id: candidate.id, target: "verified",
      reason: "wrong", evaluation_run_id: "missing" }), /Unknown evaluation_run/);
    const verified = service.workflowTransition({ workflow_id: candidate.id, target: "verified",
      reason: "qualified", evaluation_run_id: evalRun.id });
    assert.equal(verified.lifecycle, "verified");
    const deprecated = service.workflowTransition({ workflow_id: verified.id, target: "deprecated", reason: "regression" });
    assert.equal(deprecated.lifecycle, "deprecated");
    assert.throws(() => service.workflowTransition({ workflow_id: deprecated.id, target: "candidate", reason: "x" }), /Invalid/);
    assert.throws(() => service.workflowRollback({ workflow_id: deprecated.id, target_version: draft.version,
      reason: "bad target" }), /verified/);
    const restored = service.workflowRollback({ workflow_id: deprecated.id, target_version: verified.version,
      reason: "restore known good" });
    assert.equal(restored.rollback_to_version, verified.version);

    const failedTrial = service.trialStart({ task_id: taskId, case_id: "held-2", subject_type: "workflow",
      subject_id: restored.id, subject_version: restored.version });
    service.outcomeRecord({ trial_id: failedTrial.id, verdict: "failed", summary: "Regression" });
    const failedRun = service.evaluationRunRecord({ suite_id: suite.id, split: "held_out",
      subject_type: "workflow", subject_id: restored.id, subject_version: restored.version,
      trial_ids: [failedTrial.id] });
    assert.equal(failedRun.verdict, "failed");
    const restoredCandidate = service.workflowSave({ workflow_id: restored.id, name: "Changed" });
    const promotedCandidate = service.workflowTransition({ workflow_id: restoredCandidate.id,
      target: "candidate", reason: "retry" });
    assert.throws(() => service.workflowTransition({ workflow_id: promotedCandidate.id, target: "verified",
      reason: "old version", evaluation_run_id: evalRun.id }), /passed held-out/);
    assert.throws(() => service.workflowTransition({ workflow_id: promotedCandidate.id, target: "verified",
      reason: "failed eval", evaluation_run_id: failedRun.id }), /passed held-out/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("graders and signoff policies preserve provenance and gate exact versions", async () => {
  const root = join(tmpdir(), `craft-signoff-${process.pid}-${Date.now()}`);
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  try {
    const taskPack = service.taskOpen({ title: "Signoff", goal: "Apply independent graders" });
    const taskId = String((taskPack.task as Record<string, unknown>).id);
    const draft = service.workflowSave({ workflow_id: "workflow_signoff", name: "Signoff workflow" });
    const candidate = service.workflowTransition({ workflow_id: draft.id, target: "candidate", reason: "grade it" });
    const suite = service.evaluationSuiteSave({ name: "Signoff suite", cases: [
      { case_id: "held", split: "held_out" }, { case_id: "dev", split: "development" },
    ] });
    const trial = service.trialStart({ task_id: taskId, case_id: "held", subject_type: "workflow",
      subject_id: candidate.id, subject_version: candidate.version });
    service.outcomeRecord({ trial_id: trial.id, verdict: "passed", summary: "base checks passed" });
    const evaluation = service.evaluationRunRecord({ suite_id: suite.id, split: "held_out",
      subject_type: "workflow", subject_id: candidate.id, subject_version: candidate.version,
      trial_ids: [trial.id] });

    assert.throws(() => service.graderSave({ name: "bad", grader_type: "unknown" }), /grader type/);
    assert.throws(() => service.graderSave({ name: "bad", grader_type: "program", configuration: [] }), /configuration/);
    const program = service.graderSave({ grader_id: "grader_program", name: "Program gate",
      grader_type: "program", configuration: { command: "test" } });
    const model = service.graderSave({ grader_id: "grader_model", name: "Rubric", grader_type: "model" });
    const human = service.graderSave({ grader_id: "grader_human", name: "Reviewer", grader_type: "human" });
    const humanNoScore = service.graderSave({ grader_id: "grader_human_no_score", name: "Reviewer 2",
      grader_type: "human" });
    service.graderSave({ grader_id: "grader_operational", name: "Business result", grader_type: "operational" });
    const evidence = service.evidenceRecord({ source_type: "test", claim: "program passed", confidence: "confirmed" });
    assert.throws(() => service.gradeRecord({ trial_id: trial.id, grader_id: program.id,
      grader_version: program.version, verdict: "unknown", summary: "bad" }), /grade verdict/);
    assert.throws(() => service.gradeRecord({ trial_id: trial.id, grader_id: program.id,
      grader_version: program.version, verdict: "passed", summary: "bad", score: 2 }), /score/);
    assert.throws(() => service.gradeRecord({ trial_id: trial.id, grader_id: program.id,
      grader_version: program.version, verdict: "passed", summary: "bad", evidence_ids: ["missing"] }), /Unknown evidence/);
    const programGrade = service.gradeRecord({ trial_id: trial.id, grader_id: program.id,
      grader_version: program.version, verdict: "passed", summary: "tests passed", score: 0.9,
      evidence_ids: [evidence.id], metadata: { runner: "node:test" } });
    assert.throws(() => service.gradeRecord({ trial_id: trial.id, grader_id: program.id,
      grader_version: program.version, verdict: "passed", summary: "duplicate" }), /already exists/);
    const modelGrade = service.gradeRecord({ trial_id: trial.id, grader_id: model.id,
      grader_version: model.version, verdict: "passed", summary: "rubric passed" });
    const humanGrade = service.gradeRecord({ trial_id: trial.id, grader_id: human.id,
      grader_version: human.version, verdict: "inconclusive", summary: "needs review", score: null });
    const humanNoScoreGrade = service.gradeRecord({ trial_id: trial.id, grader_id: humanNoScore.id,
      grader_version: humanNoScore.version, verdict: "passed", summary: "approved" });

    assert.throws(() => service.signoffPolicySave({ name: "bad", requirements: ["program"] }), /must be an object/);
    assert.throws(() => service.signoffPolicySave({ name: "bad", requirements: [{ grader_type: "bad" }] }), /grader type/);
    assert.throws(() => service.signoffPolicySave({ name: "bad", requirements: [
      { grader_type: "program" }, { grader_type: "program" },
    ] }), /unique/);
    assert.throws(() => service.signoffPolicySave({ name: "bad", require_held_out: "yes" }), /boolean/);
    const policy = service.signoffPolicySave({ policy_id: "policy_strict", name: "Strict",
      requirements: [{ grader_type: "program", minimum_score: 0.8 },
        { grader_type: "model", minimum_score: null }] });
    const signoff = service.signoffEvaluate({ signoff_id: "signoff_pass", policy_id: policy.id,
      policy_version: policy.version, evaluation_run_id: evaluation.id,
      grade_ids: [programGrade.id, modelGrade.id] });
    assert.equal(signoff.decision, "passed");
    assert.equal(service.workflowTransition({ workflow_id: candidate.id, target: "verified",
      reason: "policy passed", signoff_id: signoff.id }).signoff_id, signoff.id);

    const scorePolicy = service.signoffPolicySave({ name: "Higher score",
      requirements: [{ grader_type: "program", minimum_score: 0.95 }] });
    const failedSignoff = service.signoffEvaluate({ policy_id: scorePolicy.id, evaluation_run_id: evaluation.id,
      grade_ids: [programGrade.id] });
    assert.equal(failedSignoff.decision, "failed");
    const humanPolicy = service.signoffPolicySave({ name: "Human required",
      requirements: [{ grader_type: "human" }] });
    assert.equal(service.signoffEvaluate({ policy_id: humanPolicy.id, evaluation_run_id: evaluation.id,
      grade_ids: [humanGrade.id] }).decision, "failed");
    const scoredHumanPolicy = service.signoffPolicySave({ name: "Scored human",
      requirements: [{ grader_type: "human", minimum_score: 0.5 }] });
    assert.equal(service.signoffEvaluate({ policy_id: scoredHumanPolicy.id, evaluation_run_id: evaluation.id,
      grade_ids: [humanNoScoreGrade.id] }).decision, "failed");
    assert.throws(() => service.signoffEvaluate({ policy_id: policy.id, evaluation_run_id: evaluation.id,
      grade_ids: [programGrade.id, programGrade.id] }), /grade_ids/);

    const other = service.workflowSave({ name: "Other" });
    const otherCandidate = service.workflowTransition({ workflow_id: other.id, target: "candidate", reason: "test" });
    assert.throws(() => service.workflowTransition({ workflow_id: otherCandidate.id, target: "verified",
      reason: "wrong signoff", signoff_id: failedSignoff.id }), /passed signoff/);
    const otherTrial = service.trialStart({ task_id: taskId, subject_type: "workflow",
      subject_id: other.id, subject_version: other.version });
    const otherGrade = service.gradeRecord({ trial_id: otherTrial.id, grader_id: model.id,
      grader_version: model.version, verdict: "failed", summary: "outside" });
    assert.throws(() => service.signoffEvaluate({ policy_id: policy.id, evaluation_run_id: evaluation.id,
      grade_ids: [otherGrade.id] }), /outside/);

    const devTrial = service.trialStart({ task_id: taskId, case_id: "dev", subject_type: "workflow",
      subject_id: candidate.id, subject_version: candidate.version });
    service.outcomeRecord({ trial_id: devTrial.id, verdict: "failed", summary: "development failed" });
    const devEvaluation = service.evaluationRunRecord({ suite_id: suite.id, split: "development",
      subject_type: "workflow", subject_id: candidate.id, subject_version: candidate.version,
      trial_ids: [devTrial.id] });
    const permissive = service.signoffPolicySave({ name: "Advisory", requirements: [],
      require_held_out: false, require_outcome_passed: false });
    assert.equal(service.signoffEvaluate({ policy_id: permissive.id, evaluation_run_id: devEvaluation.id }).decision,
      "passed");

    const advisoryDraft = service.workflowSave({ name: "Advisory development" });
    const advisoryCandidate = service.workflowTransition({ workflow_id: advisoryDraft.id,
      target: "candidate", reason: "advisory" });
    const advisoryTrial = service.trialStart({ task_id: taskId, case_id: "dev", subject_type: "workflow",
      subject_id: advisoryCandidate.id, subject_version: advisoryCandidate.version });
    service.outcomeRecord({ trial_id: advisoryTrial.id, verdict: "passed", summary: "development passed" });
    const advisoryEvaluation = service.evaluationRunRecord({ suite_id: suite.id, split: "development",
      subject_type: "workflow", subject_id: advisoryCandidate.id, subject_version: advisoryCandidate.version,
      trial_ids: [advisoryTrial.id] });
    const advisorySignoff = service.signoffEvaluate({ policy_id: permissive.id,
      evaluation_run_id: advisoryEvaluation.id });
    assert.throws(() => service.workflowTransition({ workflow_id: advisoryCandidate.id, target: "verified",
      reason: "development cannot promote", signoff_id: advisorySignoff.id }), /passed signoff/);

    const failedDraft = service.workflowSave({ name: "Advisory failure" });
    const failedCandidate = service.workflowTransition({ workflow_id: failedDraft.id,
      target: "candidate", reason: "advisory" });
    const heldFailure = service.trialStart({ task_id: taskId, case_id: "held", subject_type: "workflow",
      subject_id: failedCandidate.id, subject_version: failedCandidate.version });
    service.outcomeRecord({ trial_id: heldFailure.id, verdict: "failed", summary: "held-out failed" });
    const failedEvaluation = service.evaluationRunRecord({ suite_id: suite.id, split: "held_out",
      subject_type: "workflow", subject_id: failedCandidate.id, subject_version: failedCandidate.version,
      trial_ids: [heldFailure.id] });
    const advisoryFailure = service.signoffEvaluate({ policy_id: permissive.id,
      evaluation_run_id: failedEvaluation.id });
    assert.throws(() => service.workflowTransition({ workflow_id: failedCandidate.id, target: "verified",
      reason: "failure cannot promote", signoff_id: advisoryFailure.id }), /passed signoff/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
