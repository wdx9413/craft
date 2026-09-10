import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

test("controlled driver executes only policy-approved deterministic workflows and recovers leases", async () => {
  const root = join(tmpdir(), `craft-v096-driver-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true }); await writeFile(join(root, "proof.txt"), "ok");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open(); const service = new CraftService(store);
  try {
    const task = service.taskOpen({ title: "Driver", goal: "Execute deterministically" }).task as JsonObject;
    const workflow = service.workflowSave({ workflow_id: "proof", name: "Proof", steps: [
      { id: "proof", type: "assertion", evaluator: "file_exists", path: "proof.txt" },
    ] });
    const policy = service.runtimePolicySave({ name: "Driver policy", allowed_effects: ["read_only"],
      trusted_hosts: ["craft-driver"], path_allowlist: ["proof.txt"], max_attempts: 2, lease_ttl_seconds: 1 });
    service.runtimeRunStart({ run_id: "driver-run", task_id: task.id, policy_id: policy.id, environment: { image: "fixed" }, operations: [{
      operation_id: "workflow-op", kind: "workflow", effect: "read_only", objective: "prove", execution: {
        workflow_id: workflow.id, workflow_version: workflow.version, project_root: root, inputs: { marker: "explicit" },
      },
    }] });
    const tick = service.runtimeDriverTick({ run_id: "driver-run", driver_id: "craft-driver" });
    assert.equal((tick.executed as JsonObject[]).length, 1);
    assert.equal((service.runtimeRunGet({ run_id: "driver-run" }).run as JsonObject).status, "completed");

    service.runtimeRunStart({ run_id: "lease-run", task_id: task.id, policy_id: policy.id, environment: {}, operations: [{
      operation_id: "lease-op", kind: "agent", effect: "read_only", objective: "host work",
    }] });
    service.runtimeDispatch({ run_id: "lease-run", claimed_by: "craft-driver" });
    const reclaimed = service.runtimeLeaseRecover({ run_id: "lease-run", now: "2999-01-01T00:00:00.000Z" });
    assert.deepEqual(reclaimed.recovered_operation_ids, ["lease-op"]);
    assert.throws(() => service.runtimeDriverTick({ run_id: "lease-run", driver_id: "other" }), /trusted/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("held-out promotion applies repeated-trial confidence, regression budgets, and a program grader", async () => {
  const root = join(tmpdir(), `craft-v096-eval-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true }); await writeFile(join(root, "ok.txt"), "ok");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open(); const service = new CraftService(store);
  try {
    const task = service.taskOpen({ title: "Eval", goal: "Promote only evidence" }).task as JsonObject;
    const suite = service.evaluationSuiteSave({ name: "Held", cases: [{ case_id: "one", split: "held_out" }, { case_id: "two", split: "held_out" }] });
    const good = (workflowId: string) => service.workflowSave({ workflow_id: workflowId, name: workflowId, steps: [
      { id: "proof", type: "assertion", evaluator: "file_exists", path: "ok.txt" },
    ] });
    const baseline = good("baseline"); const candidate = good("candidate");
    const runner = service.evaluationRunnerRun({ task_id: task.id, suite_id: suite.id, split: "held_out", project_root: root,
      trials_per_case: 2, subjects: [
        { label: "baseline", subject_type: "workflow", subject_id: baseline.id, subject_version: baseline.version },
        { label: "candidate", subject_type: "workflow", subject_id: candidate.id, subject_version: candidate.version },
      ] });
    const comparison = (runner.comparisons as JsonObject[])[0];
    const grader = service.graderSave({ name: "Gate", grader_type: "program", rules: { minimum_pass_rate: 1 } });
    const grade = service.evaluationProgramGrade({ evaluation_run_id: (runner.evaluation_runs as JsonObject[])[1].id,
      grader_id: grader.id, grader_version: grader.version });
    assert.equal(((grade.grades as JsonObject[])[0]).verdict, "passed");
    const defaultGrader = service.graderSave({ name: "Default gate", grader_type: "program" });
    assert.equal((service.evaluationProgramGrade({ evaluation_run_id: (runner.evaluation_runs as JsonObject[])[0].id,
      grader_id: defaultGrader.id }).passed), true);
    const durationGrader = service.graderSave({ name: "Duration gate", grader_type: "program", configuration: { maximum_mean_duration_ms: 1_000_000 } });
    assert.equal((service.evaluationProgramGrade({ evaluation_run_id: (runner.evaluation_runs as JsonObject[])[0].id,
      grader_id: durationGrader.id }).passed), true);
    const promotion = service.evaluationPromotionAssess({ comparison_id: comparison.id, min_trials: 4,
      min_pass_rate_delta: 0 });
    assert.equal(promotion.eligible, true);
    assert.equal(typeof ((promotion.comparison as JsonObject).paired as JsonObject).candidate_wins, "number");
    assert.equal((service.evaluationPromotionAssess({ comparison_id: comparison.id, min_trials: 5 }).eligible), false);
    assert.equal((service.evaluationProgramGrade({ evaluation_run_id: (runner.evaluation_runs as JsonObject[])[1].id,
      grader_id: grader.id }).grades as JsonObject[]).length, 4);
    const badGrader = service.graderSave({ name: "Bad gate", grader_type: "program", configuration: { minimum_pass_rate: 2 } });
    assert.throws(() => service.evaluationProgramGrade({ evaluation_run_id: (runner.evaluation_runs as JsonObject[])[1].id,
      grader_id: badGrader.id }), /configuration/);
    const human = service.graderSave({ name: "Human", grader_type: "human" });
    assert.throws(() => service.evaluationProgramGrade({ evaluation_run_id: (runner.evaluation_runs as JsonObject[])[1].id,
      grader_id: human.id }), /program grader/);
    assert.throws(() => service.evaluationPromotionAssess({ comparison_id: comparison.id, max_cost_regression_ratio: -1 }), /thresholds/);
    const failing = service.workflowSave({ workflow_id: "failing-candidate", name: "Failing candidate", steps: [
      { id: "missing", type: "assertion", evaluator: "file_exists", path: "missing.txt" },
    ] });
    const wins = service.evaluationRunnerRun({ runner_id: "wins", task_id: task.id, suite_id: suite.id, split: "held_out", project_root: root,
      subjects: [{ label: "fail", subject_type: "workflow", subject_id: failing.id, subject_version: failing.version },
        { label: "pass", subject_type: "workflow", subject_id: candidate.id, subject_version: candidate.version }] });
    const failedGrade = service.evaluationProgramGrade({ evaluation_run_id: (wins.evaluation_runs as JsonObject[])[0].id,
      grader_id: grader.id, grader_version: grader.version });
    assert.equal(((failedGrade.grades as JsonObject[])[0]).verdict, "failed");
    const winPromotion = service.evaluationPromotionAssess({ comparison_id: ((wins.comparisons as JsonObject[])[0]).id, min_trials: 2 });
    assert.equal(((winPromotion.comparison as JsonObject).paired as JsonObject).candidate_wins, 2);
    const losses = service.evaluationRunnerRun({ runner_id: "losses", task_id: task.id, suite_id: suite.id, split: "held_out", project_root: root,
      subjects: [{ label: "pass", subject_type: "workflow", subject_id: candidate.id, subject_version: candidate.version },
        { label: "fail", subject_type: "workflow", subject_id: failing.id, subject_version: failing.version }] });
    const lossPromotion = service.evaluationPromotionAssess({ comparison_id: ((losses.comparisons as JsonObject[])[0]).id, min_trials: 2 });
    assert.equal(((lossPromotion.comparison as JsonObject).paired as JsonObject).baseline_wins, 2);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("adaptive harness compiles a host-neutral IR into a controlled runtime and keeps mined candidates in shadow", async () => {
  const root = join(tmpdir(), `craft-v096-harness-${process.pid}-${Date.now()}`);
  const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    const task = service.taskOpen({ title: "Harness", goal: "Safely evolve" }).task as JsonObject;
    const policy = service.runtimePolicySave({ name: "IR", allowed_effects: ["read_only"] });
    const selection = service.harnessSelect({ task_id: task.id, risk: "high", budget: { tokens: 20 }, requires_external_effect: false });
    assert.equal((selection.strategy as JsonObject).topology, "planner_executor_evaluator");
    const ir = service.agentIrCompile({ task_id: task.id, harness_id: (selection.harness as JsonObject).id,
      harness_version: (selection.harness as JsonObject).version,
      goal: "inspect then judge", operations: [{ id: "plan", kind: "agent", effect: "read_only", objective: "plan" },
        { id: "judge", kind: "grader", effect: "read_only", objective: "judge", depends_on: ["plan"] },
        { id: "workflow", kind: "workflow", effect: "read_only", objective: "workflow", execution: { workflow_id: "future", project_root: root, inputs: {} } }] });
    const lowered = service.agentIrLower({ ir_id: ir.id, ir_version: ir.version, run_id: "ir-run", policy_id: policy.id, environment: { image: "fixed" } });
    assert.equal((lowered.operations as JsonObject[]).length, 3);
    const experiment = service.experienceShadowExperimentCreate({ task_id: task.id, mining_candidate_id: "missing" });
    assert.equal(experiment.status, "rejected");
    assert.throws(() => service.harnessSelect({ task_id: task.id, risk: "unknown" }), /risk/);
    assert.throws(() => service.agentIrCompile({ task_id: task.id, harness_id: (selection.harness as JsonObject).id, goal: "bad", operations: [] }), /uniquely/);
    assert.throws(() => service.agentIrCompile({ task_id: task.id, harness_id: (selection.harness as JsonObject).id, goal: "bad", operations: [
      { id: "one", kind: "agent", effect: "read_only", objective: "one", depends_on: ["missing"] },
    ] }), /dependencies/);

    const subject = service.workflowSave({ workflow_id: "mined", name: "Mined" });
    const evidence = service.evidenceRecord({ source_type: "program", confidence: "confirmed", claim: "failure" });
    for (const trialId of ["mine-one", "mine-two"]) {
      service.trialStart({ trial_id: trialId, task_id: task.id, subject_type: "workflow", subject_id: subject.id, subject_version: subject.version });
      service.outcomeRecord({ trial_id: trialId, verdict: "failed", failure_type: "repeat", summary: "failed", evidence_ids: [evidence.id] });
    }
    const mined = service.experienceMine({ subject_type: "workflow", subject_id: subject.id, subject_version: subject.version });
    assert.equal(service.experienceShadowExperimentCreate({ task_id: task.id,
      mining_candidate_id: (mined.candidates as JsonObject[])[0].id }).status, "planned");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("driver blocks unsafe deterministic execution, retries deterministic failures, and exhausts leases safely", async () => {
  const root = join(tmpdir(), `craft-v096-policy-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true }); const store = await new CraftStore(craftPaths(join(root, "data"))).open(); const service = new CraftService(store);
  try {
    const task = service.taskOpen({ title: "Policy", goal: "Reject unsafe work" }).task as JsonObject;
    const policy = service.runtimePolicySave({ name: "Strict", allowed_effects: ["read_only", "external_write"], trusted_hosts: ["driver"],
      path_allowlist: ["allowed.txt", "missing.txt"], command_allowlist: [], max_attempts: 2, lease_ttl_seconds: 1 });
    const add = (id: string, workflow: JsonObject) => service.runtimeRunStart({ run_id: `${id}-run`, task_id: task.id, policy_id: policy.id,
      environment: {}, operations: [{ operation_id: id, kind: "workflow", effect: String((workflow.steps as JsonObject[])[0].side_effect ?? "read_only"),
        objective: id, execution: { workflow_id: workflow.id, workflow_version: workflow.version, project_root: root, inputs: {} } }] });
    const external = service.workflowSave({ workflow_id: "external", name: "External", steps: [
      { id: "external", type: "assertion", evaluator: "file_exists", path: "allowed.txt", side_effect: "external_write" },
    ] });
    add("external-op", external); assert.equal(((service.runtimeDriverTick({ run_id: "external-op-run", driver_id: "driver" }).executed as JsonObject[])[0]).blocked, true);
    const path = service.workflowSave({ workflow_id: "path", name: "Path", steps: [
      { id: "path", type: "assertion", evaluator: "file_exists", path: "blocked.txt" },
    ] });
    add("path-op", path); service.runtimeDriverTick({ run_id: "path-op-run", driver_id: "driver" });
    const escape = service.workflowSave({ workflow_id: "escape", name: "Escape", steps: [
      { id: "escape", type: "assertion", evaluator: "file_exists", path: "../escape.txt" },
    ] });
    add("escape-op", escape); service.runtimeDriverTick({ run_id: "escape-op-run", driver_id: "driver" });
    const command = service.workflowSave({ workflow_id: "command", name: "Command", steps: [
      { id: "command", type: "command", command: [process.execPath, "-e", ""], side_effect: "read_only" },
    ] });
    add("command-op", command); service.runtimeDriverTick({ run_id: "command-op-run", driver_id: "driver" });
    const secret = service.workflowSave({ workflow_id: "secret", name: "Secret", steps: [
      { id: "secret", type: "command", command: [process.execPath, "-e", ""], env: { TOKEN: "x" }, side_effect: "read_only" },
    ] });
    const allowedCommand = service.runtimePolicySave({ runtime_policy_id: policy.id, name: "Strict v2", allowed_effects: ["read_only"], trusted_hosts: ["driver"],
      path_allowlist: ["."], command_allowlist: [process.execPath], max_attempts: 2 });
    service.runtimeRunStart({ run_id: "secret-run", task_id: task.id, policy_id: allowedCommand.id, environment: {}, operations: [{
      operation_id: "secret-op", kind: "workflow", effect: "read_only", objective: "secret", execution: { workflow_id: secret.id, workflow_version: secret.version, project_root: root, inputs: {} },
    }] });
    service.runtimeDriverTick({ run_id: "secret-run", driver_id: "driver" });
  const cleanCommand = service.workflowSave({ workflow_id: "clean-command", name: "Clean command", steps: [
      { id: "clean", type: "command", command: [process.execPath, "-e", ""], side_effect: "read_only" },
    ] });
    service.runtimeRunStart({ run_id: "clean-command-run", task_id: task.id, policy_id: allowedCommand.id, environment: {}, operations: [{
      operation_id: "clean-command-op", kind: "workflow", effect: "read_only", objective: "clean", execution: {
        workflow_id: cleanCommand.id, workflow_version: cleanCommand.version, project_root: root, inputs: {},
      },
    }] });
    assert.equal(((service.runtimeDriverTick({ run_id: "clean-command-run", driver_id: "driver" }).executed as JsonObject[])[0]).status, "passed");
    const failing = service.workflowSave({ workflow_id: "failing", name: "Failing", steps: [
      { id: "missing", type: "assertion", evaluator: "file_exists", path: "missing.txt" },
    ] });
    add("retry-op", failing); service.runtimeDriverTick({ run_id: "retry-op-run", driver_id: "driver" });
    assert.equal((service.runtimeOperationGet({ operation_id: "retry-op" }).operation as JsonObject).status, "pending");
    service.runtimeDriverTick({ run_id: "retry-op-run", driver_id: "driver" });
    assert.equal((service.runtimeRunGet({ run_id: "retry-op-run" }).run as JsonObject).status, "failed");
    service.runtimeRunStart({ run_id: "exhausted-run", task_id: task.id, policy_id: allowedCommand.id, environment: {}, operations: [{
      operation_id: "exhausted", kind: "agent", effect: "read_only", objective: "exhausted",
    }] });
    service.runtimeDispatch({ run_id: "exhausted-run", claimed_by: "host" });
    service.runtimeLeaseRecover({ run_id: "exhausted-run", now: "2999-01-01T00:00:00.000Z" });
    service.runtimeDispatch({ run_id: "exhausted-run", claimed_by: "host" });
    assert.deepEqual(service.runtimeLeaseRecover({ run_id: "exhausted-run", now: "2999-01-01T00:00:00.000Z" }).recovered_operation_ids, ["exhausted"]);
    assert.equal((service.runtimeOperationGet({ operation_id: "exhausted" }).operation as JsonObject).status, "failed");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("runtime and adaptive controls reject malformed branches without changing the approved path", async () => {
  const root = join(tmpdir(), `craft-v096-branches-${process.pid}-${Date.now()}`);
  const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    const task = service.taskOpen({ title: "Branches", goal: "Cover controls" }).task as JsonObject;
    const policy = service.runtimePolicySave({ name: "Branches", allowed_effects: ["read_only"], trusted_hosts: ["driver"],
      max_attempts: 2, lease_ttl_seconds: 1 });
    assert.throws(() => service.runtimePolicySave({ name: "Duplicate host", allowed_effects: ["read_only"], trusted_hosts: ["driver", "driver"] }), /unique/);
    assert.throws(() => service.runtimeRunStart({ task_id: task.id, policy_id: policy.id, environment: {}, operations: [
      { operation_id: "self-dependency", kind: "agent", effect: "read_only", objective: "self", depends_on: ["self-dependency"] },
    ] }), /depend on itself/);
    const run = service.runtimeRunStart({ run_id: "dag-run", task_id: task.id, policy_id: policy.id, environment: {}, operations: [
      { operation_id: "left", kind: "agent", effect: "read_only", objective: "left" },
      { operation_id: "right", kind: "agent", effect: "read_only", objective: "right" },
      { operation_id: "join", kind: "grader", effect: "read_only", objective: "join", depends_on: ["left", "right"] },
    ] });
    assert.equal((run.operations as JsonObject[]).length, 3);
    const first = service.runtimeDispatch({ run_id: "dag-run", claimed_by: "host", kinds: ["agent"] }).operations as JsonObject[];
    assert.equal(first.length, 1);
    assert.throws(() => service.runtimeDispatch({ run_id: "dag-run", claimed_by: "host", kinds: ["bad"] }), /kinds/);
    service.runtimeRunStart({ run_id: "legacy-run", task_id: task.id, policy_id: policy.id, environment: {}, operations: [
      { operation_id: "legacy-parent", kind: "agent", effect: "read_only", objective: "parent" },
      { operation_id: "legacy-child", kind: "agent", effect: "read_only", objective: "child", parent_operation_id: "legacy-parent" },
    ] });
    const legacyChild = service.runtimeOperationGet({ operation_id: "legacy-child" }).operation as JsonObject;
    store.save("runtime_operation", "legacy-child", { ...legacyChild, depends_on: null });
    const legacyParent = (service.runtimeDispatch({ run_id: "legacy-run", claimed_by: "host" }).operations as JsonObject[])[0];
    service.runtimeOperationSubmit({ operation_id: "legacy-parent", lease_id: legacyParent.lease_id, claimed_by: "host", verdict: "passed" });
    const dispatchedLegacyChild = (service.runtimeDispatch({ run_id: "legacy-run", claimed_by: "host" }).operations as JsonObject[])[0];
    assert.equal(dispatchedLegacyChild.operation_id, "legacy-child");
    service.runtimeOperationSubmit({ operation_id: "legacy-child", lease_id: dispatchedLegacyChild.lease_id, claimed_by: "host", verdict: "passed" });
    service.runtimeRunStart({ run_id: "legacy-root-run", task_id: task.id, policy_id: policy.id, environment: {}, operations: [
      { operation_id: "zzz-anchor", kind: "agent", effect: "read_only", objective: "anchor" },
    ] });
    store.create("runtime_operation", "legacy-root", { run_id: "legacy-root-run", operation_id: "legacy-root", kind: "agent", effect: "read_only",
      objective: "legacy root", parent_operation_id: null, status: "pending", attempts: 0, submission_receipts: [] });
    assert.equal((service.runtimeDispatch({ run_id: "legacy-root-run", claimed_by: "host" }).operations as JsonObject[])[0].operation_id, "legacy-root");
    assert.throws(() => service.runtimeLeaseRecover({ run_id: "dag-run", now: "bad-time" }), /timestamp/);
    assert.equal((service.runtimeDriverTick({ run_id: "dag-run", driver_id: "driver" }).executed as JsonObject[]).length, 0);
    assert.equal((service.harnessSelect({ task_id: task.id, risk: "low" }).strategy as JsonObject).topology, "single");
    assert.equal((service.harnessSelect({ task_id: task.id, risk: "medium" }).strategy as JsonObject).topology, "incremental");
    assert.equal((service.harnessSelect({ task_id: task.id, risk: "low", requires_external_effect: true }).strategy as JsonObject).topology,
      "planner_executor_evaluator");
    const harness = service.harnessSelect({ task_id: task.id, risk: "low" }).harness as JsonObject;
    assert.throws(() => service.agentIrCompile({ task_id: task.id, harness_id: harness.id, goal: "self", operations: [
      { id: "self", kind: "agent", effect: "read_only", objective: "self", depends_on: ["self"] },
    ] }), /depend on itself/);
    assert.throws(() => service.agentIrCompile({ task_id: task.id, harness_id: harness.id, goal: "duplicate", operations: [
      { id: "one", kind: "agent", effect: "read_only", objective: "one", depends_on: ["two", "two"] },
      { id: "two", kind: "agent", effect: "read_only", objective: "two" },
    ] }), /unique/);
    assert.throws(() => service.agentIrCompile({ task_id: task.id, harness_id: harness.id, goal: "type", operations: [
      { id: "bad", kind: "bad", effect: "read_only", objective: "bad" },
    ] }), /unsupported/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
