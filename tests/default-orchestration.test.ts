import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

test("默认编排优先已验证 Workflow，并为无匹配任务给出安全增量研发计划", async () => {
  const root = join(tmpdir(), `craft-default-route-${process.pid}-${Date.now()}`);
  const skills = join(root, "skills");
  await mkdir(skills, { recursive: true });
  await writeFile(join(skills, "SKILL.md"), "---\nname: java-timeout\ndescription: Diagnose Java timeout safely\n---\nUse a focused test.");
  await writeFile(join(root, "existing.txt"), "ok");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  try {
    await service.sourceAdd({ path: skills });
    const verified = store.save("workflow", "workflow_timeout", { name: "Java timeout safe repair",
      description: "Run focused proof", lifecycle: "verified", inputs: [], steps: [{ id: "proof", type: "assertion",
        evaluator: "file_exists", path: "existing.txt" }] });
    const route = service.defaultRoute({ title: "修复超时", goal: "Java timeout safe repair" });
    assert.equal((route.workflow as JsonObject).id, verified.id);
    assert.equal((route.task as JsonObject).status, "active");
    assert.equal((route.capabilities as JsonObject[]).length, 1);
    const executed = service.defaultRouteExecute({ route_id: route.route_id, project_root: root });
    assert.equal((executed.outcome as JsonObject).verdict, "passed");
    assert.equal((executed.experience_candidates as JsonObject[]).length, 0);
    const forcedSafe = service.defaultRoute({ title: "Force safe", goal: "Java timeout safe repair",
      mode: "safe_incremental_development" });
    assert.equal(forcedSafe.workflow, null);
    const unexecutedWorkflow = service.defaultRoute({ title: "Unexecuted", goal: "Java timeout safe repair" });
    assert.throws(() => service.defaultRouteUpdate({ route_id: unexecutedWorkflow.route_id, stage_id: "baseline", summary: "wrong route" }), /Verified Workflow/);

    store.save("workflow", "workflow_timeout_tie", { name: "Java timeout second repair", lifecycle: "verified", inputs: [], steps: [] });
    assert.equal((service.defaultRoute({ title: "Tie", goal: "Java timeout" }).workflow as JsonObject).id, "workflow_timeout");
    assert.equal((service.defaultRoute({ title: "Emoji", goal: "😀" }).workflow as JsonObject | null), null);
    store.save("workflow", "workflow_timeout_tie", { name: "Java timeout second repair", lifecycle: "deprecated", inputs: [], steps: [] });
    const obsolete = service.defaultRoute({ title: "Obsolete", goal: "Java timeout safe repair" });
    const brokenPayload = { name: "Java timeout safe repair", lifecycle: "deprecated", inputs: [], steps: [] };
    store.database.prepare("UPDATE records SET payload_json=? WHERE kind=? AND id=? AND version=?")
      .run(JSON.stringify(brokenPayload), "workflow", "workflow_timeout", 1);
    assert.throws(() => service.defaultRouteExecute({ route_id: obsolete.route_id, project_root: root }), /no longer verified/);
    store.database.prepare("UPDATE records SET payload_json=? WHERE kind=? AND id=? AND version=?")
      .run(JSON.stringify({ ...brokenPayload, lifecycle: "verified" }), "workflow", "workflow_timeout", 1);
    const crashing = service.defaultRoute({ title: "Crash", goal: "Java timeout safe repair" });
    const originalRun = service.workflowRun;
    service.workflowRun = () => { throw new Error("crash"); };
    assert.equal((service.defaultRouteExecute({ route_id: crashing.route_id, project_root: root }).route as JsonObject).workflow_run_id, null);
    service.workflowRun = originalRun;

    const planned = service.defaultRoute({ title: "增量改造", goal: "Change Python controller safely",
      mode: "safe_incremental_development" });
    assert.equal((planned.workflow as JsonObject | null), null);
    const development = planned.development_plan as JsonObject;
    assert.deepEqual((development.stages as JsonObject[]).map((stage) => stage.id),
      ["baseline", "minimal_change", "verification", "review"]);
    assert.match(String((development.stages as JsonObject[])[0].constraints), /原有逻辑/);
    assert.throws(() => service.defaultRouteExecute({ route_id: planned.route_id, project_root: root }), /verified Workflow/);
    assert.throws(() => service.defaultRoute({ title: "Bad", goal: "bad", mode: "unsafe" }), /Unsupported route mode/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("经验候选只从同一 Subject 的多个有证据 Trial 中自动浮现", async () => {
  const root = join(tmpdir(), `craft-experience-candidates-${process.pid}-${Date.now()}`);
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  try {
    const task = service.taskOpen({ title: "经验", goal: "提炼" }).task as JsonObject;
    const workflow = service.workflowSave({ workflow_id: "workflow_candidate", name: "Candidate" });
    const evidence = service.evidenceRecord({ evidence_id: "evidence_candidate", source_type: "program",
      claim: "test passed", confidence: "confirmed" });
    const boundedEvidence = service.evidenceRecord({ evidence_id: "evidence_candidate_bounded", source_type: "program",
      claim: "manual boundary", confidence: "bounded" });
    for (const trialId of ["trial_candidate_1", "trial_candidate_2"]) {
      service.trialStart({ trial_id: trialId, task_id: task.id, subject_type: "workflow",
        subject_id: workflow.id, subject_version: workflow.version });
      service.outcomeRecord({ trial_id: trialId, verdict: "passed", summary: "passed", evidence_ids: [evidence.id] });
    }
    const candidates = service.experienceCandidateList({});
    assert.equal((candidates.experience_candidates as JsonObject[]).length, 1);
    assert.deepEqual((candidates.experience_candidates as JsonObject[])[0].trial_ids,
      ["trial_candidate_1", "trial_candidate_2"]);
    const boundedTrial = service.trialStart({ trial_id: "trial_candidate_3", task_id: task.id, subject_type: "workflow",
      subject_id: workflow.id, subject_version: workflow.version });
    service.outcomeRecord({ trial_id: boundedTrial.id, verdict: "passed", summary: "bounded", evidence_ids: [boundedEvidence.id] });
    assert.equal(((service.experienceCandidateList({}).experience_candidates as JsonObject[])[0].confirmed_evidence_ids as string[])
      .includes(String(boundedEvidence.id)), true);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("默认安全路线可按阶段续接、归档证据并形成可复用经验候选", async () => {
  const root = join(tmpdir(), `craft-route-lifecycle-${process.pid}-${Date.now()}`);
  const skills = join(root, "skills");
  await mkdir(skills, { recursive: true });
  await writeFile(join(skills, "SKILL.md"), "---\nname: java-repair\ndescription: Repair Java services safely\n---\nUse focused tests.");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  try {
    await service.sourceAdd({ path: skills });
    const route = service.defaultRoute({ goal: "Repair Java service safely" });
    assert.equal((route.task as JsonObject).title, "Repair Java service safely");
    assert.equal((route.workflow as JsonObject | null), null);
    assert.equal((route.development_plan as JsonObject).stages instanceof Array, true);
    assert.equal((route.next_action as JsonObject).stage_id, "baseline");
    const routeId = String(route.route_id);
    assert.match(String((service.defaultRouteResume({ task_id: (route.task as JsonObject).id }).next_action as JsonObject).stage_id), /baseline/);
    assert.throws(() => service.defaultRouteUpdate({ route_id: routeId, stage_id: "review", summary: "skip" }), /next required stage/);
    assert.throws(() => service.defaultRouteUpdate({ route_id: routeId, stage_id: "baseline", summary: "early verdict", verdict: "passed" }), /only allowed/);
    const evidence = service.evidenceRecord({ source_type: "program", claim: "focused test passed", confidence: "confirmed" });
    const artifact = service.artifactRegister({ kind: "test_receipt", name: "focused", uri: "file:///focused" });
    for (const stageId of ["baseline", "minimal_change", "verification"]) {
      const progress = service.defaultRouteUpdate({ route_id: routeId, stage_id: stageId,
        summary: `${stageId} done`, evidence_ids: [evidence.id], artifact_ids: [artifact.id] });
      assert.equal((progress.route as JsonObject).status, "awaiting_host");
    }
    assert.throws(() => service.defaultRouteUpdate({ route_id: routeId, stage_id: "review", summary: "missing verdict" }), /verdict is required/);
    assert.throws(() => service.defaultRouteUpdate({ route_id: routeId, stage_id: "review", summary: "bad verdict", verdict: "unknown" }), /Unsupported/);
    const finished = service.defaultRouteUpdate({ route_id: routeId, stage_id: "review", summary: "review passed",
      verdict: "passed", evidence_ids: [evidence.id] });
    assert.equal((finished.route as JsonObject).status, "completed");
    assert.equal((finished.task as JsonObject).status, "completed");
    assert.equal((finished.outcome as JsonObject).verdict, "passed");
    assert.equal((finished.trace as JsonObject[]).length, 5);
    assert.equal((service.defaultRouteResume({ task_id: (route.task as JsonObject).id }).next_action as JsonObject).kind, "completed");
    assert.throws(() => service.defaultRouteUpdate({ route_id: routeId, stage_id: "review", summary: "again", verdict: "passed" }), /already terminal/);

    const repeated = service.defaultRoute({ goal: "Repair Java service safely" });
    const repeatedId = String(repeated.route_id);
    for (const stageId of ["baseline", "minimal_change", "verification"]) {
      service.defaultRouteUpdate({ route_id: repeatedId, stage_id: stageId, summary: stageId });
    }
    service.defaultRouteUpdate({ route_id: repeatedId, stage_id: "review", summary: "failed review",
      verdict: "failed", evidence_ids: [evidence.id] });
    const candidates = service.experienceCandidateList({}).experience_candidates as JsonObject[];
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].subject_type, "route_strategy");

    const cancelled = service.defaultRoute({ goal: "Repair Java service safely" });
    const cancelledId = String(cancelled.route_id);
    for (const stageId of ["baseline", "minimal_change", "verification"]) {
      service.defaultRouteUpdate({ route_id: cancelledId, stage_id: stageId, summary: stageId });
    }
    const cancelledResult = service.defaultRouteUpdate({ route_id: cancelledId, stage_id: "review", summary: "cancelled",
      verdict: "cancelled", evidence_ids: [evidence.id] });
    assert.equal((cancelledResult.route as JsonObject).status, "cancelled");
    assert.equal((cancelledResult.task as JsonObject).status, "cancelled");
    const interrupted = service.defaultRoute({ goal: "😀" });
    const interruptedRoute = store.get("route", String(interrupted.route_id));
    const { id: _id, version: _version, created_at: _createdAt, updated_at: _updatedAt, ...interruptedPayload } = interruptedRoute;
    store.save("route", String(interrupted.route_id), { ...interruptedPayload, status: "awaiting_host",
      stage_state: (interruptedPayload.stage_state as JsonObject[]).map((stage) => ({ ...stage, status: "completed" })) });
    assert.equal((service.defaultRouteResume({ task_id: (interrupted.task as JsonObject).id }).next_action as JsonObject).kind, "complete_route");
    assert.throws(() => service.defaultRouteUpdate({ route_id: interrupted.route_id, stage_id: "review", summary: "late" }), /no pending stage/);
    const missingTrial = service.defaultRoute({ goal: "No linked trial" });
    const missingTrialRoute = store.get("route", String(missingTrial.route_id));
    const { id: _missingId, version: _missingVersion, created_at: _missingCreatedAt, updated_at: _missingUpdatedAt,
      ...missingTrialPayload } = missingTrialRoute;
    store.save("route", String(missingTrial.route_id), { ...missingTrialPayload, trial_id: null });
    assert.equal(service.defaultRouteResume({ task_id: (missingTrial.task as JsonObject).id }).trial, null);
    const noRouteTask = service.taskOpen({ title: "no route", goal: "read only" }).task as JsonObject;
    assert.throws(() => service.defaultRouteResume({ task_id: noRouteTask.id }), /No route/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("自然续接只恢复唯一的活动路线，不猜测并列或已完成任务", async () => {
  const root = join(tmpdir(), `craft-route-find-${process.pid}-${Date.now()}`);
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  try {
    const current = service.defaultRoute({ goal: "研发工作流改造", project_id: "craft" });
    const completed = service.taskOpen({ title: "研发工作流改造", goal: "旧任务", project_id: "craft" }).task as JsonObject;
    service.taskCheckpoint({ task_id: completed.id, summary: "done", status: "completed" });
    const found = service.defaultRouteFind({ query: "继续上次的研发工作流改造", project_id: "craft" });
    assert.equal(found.status, "matched");
    assert.equal((found.task as JsonObject).id, (current.task as JsonObject).id);
    assert.equal((found.next_action as JsonObject).stage_id, "baseline");
    assert.equal(service.defaultRouteFind({ query: "继续" }).status, "not_found");

    service.defaultRoute({ goal: "Java timeout repair", project_id: "craft" });
    service.defaultRoute({ goal: "Java timeout repair", project_id: "craft" });
    const ambiguous = service.defaultRouteFind({ query: "继续 Java timeout repair", project_id: "craft" });
    assert.equal(ambiguous.status, "ambiguous");
    assert.equal((ambiguous.candidates as JsonObject[]).length, 2);
    assert.equal(service.defaultRouteFind({ query: "Java timeout repair", project_id: "other" }).status, "not_found");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("重复通过的安全路线只能生成证据溯源的 Workflow 草案", async () => {
  const root = join(tmpdir(), `craft-route-workflow-proposal-${process.pid}-${Date.now()}`);
  const skills = join(root, "skills");
  await mkdir(skills, { recursive: true });
  await writeFile(join(skills, "SKILL.md"), "---\nname: safe-repair\ndescription: Repair services safely\n---\nUse evidence.");
  await writeFile(join(root, "proof.txt"), "ok");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  try {
    await service.sourceAdd({ path: skills });
    const evidence = service.evidenceRecord({ source_type: "program", claim: "focused test passed", confidence: "confirmed" });
    const completeRoute = (): JsonObject => {
      const route = service.defaultRoute({ goal: "Repair service safely" });
      for (const stageId of ["baseline", "minimal_change", "verification"]) {
        service.defaultRouteUpdate({ route_id: route.route_id, stage_id: stageId, summary: stageId });
      }
      service.defaultRouteUpdate({ route_id: route.route_id, stage_id: "review", summary: "passed",
        verdict: "passed", evidence_ids: [evidence.id] });
      return route;
    };
    const first = completeRoute();
    const proposalArgs = { route_id: first.route_id, workflow_id: "workflow_safe_repair", name: "Safe repair",
      description: "Reusable verified path candidate", steps: [{ id: "proof", type: "assertion", evaluator: "file_exists", path: "proof.txt" }] };
    const pending = service.defaultRoute({ goal: "Repair service safely" });
    assert.throws(() => service.routeWorkflowProposalCreate({ ...proposalArgs, route_id: pending.route_id }), /completed safe route/);
    store.save("workflow", "workflow_already_verified", { name: "Already verified", lifecycle: "verified", steps: [] });
    const verifiedRoute = service.defaultRoute({ goal: "Already verified" });
    assert.throws(() => service.routeWorkflowProposalCreate({ ...proposalArgs, route_id: verifiedRoute.route_id }), /completed safe route/);
    assert.throws(() => service.routeWorkflowProposalCreate(proposalArgs), /two passed/);
    completeRoute();
    assert.throws(() => service.routeWorkflowProposalCreate({ ...proposalArgs, workflow_id: "workflow_empty", steps: [] }), /at least one/);
    const proposal = service.routeWorkflowProposalCreate(proposalArgs);
    assert.equal((proposal.workflow as JsonObject).lifecycle, "draft");
    assert.equal(((proposal.workflow as JsonObject).derived_from as JsonObject).route_id, first.route_id);
    assert.equal((((proposal.workflow as JsonObject).derived_from as JsonObject).trial_ids as string[]).length, 2);
    assert.equal(service.workflowPlan({ workflow_id: "workflow_safe_repair" }).executable, true);
    assert.throws(() => service.routeWorkflowProposalCreate({ ...proposalArgs, workflow_id: "workflow_duplicate" }), /already exists/);

    const noStrategy = service.defaultRoute({ goal: "😀" });
    for (const stageId of ["baseline", "minimal_change", "verification"]) {
      service.defaultRouteUpdate({ route_id: noStrategy.route_id, stage_id: stageId, summary: stageId });
    }
    service.defaultRouteUpdate({ route_id: noStrategy.route_id, stage_id: "review", summary: "passed",
      verdict: "passed", evidence_ids: [evidence.id] });
    assert.throws(() => service.routeWorkflowProposalCreate({ ...proposalArgs, route_id: noStrategy.route_id }), /reusable strategy/);
    const failed = service.defaultRoute({ goal: "Repair service safely" });
    for (const stageId of ["baseline", "minimal_change", "verification"]) {
      service.defaultRouteUpdate({ route_id: failed.route_id, stage_id: stageId, summary: stageId });
    }
    service.defaultRouteUpdate({ route_id: failed.route_id, stage_id: "review", summary: "failed",
      verdict: "failed", evidence_ids: [evidence.id] });
    assert.throws(() => service.routeWorkflowProposalCreate({ ...proposalArgs, route_id: failed.route_id }), /completed safe route/);
    const failedRoute = store.get("route", String(failed.route_id));
    const { id: _failedId, version: _failedVersion, created_at: _failedCreatedAt, updated_at: _failedUpdatedAt, ...failedPayload } = failedRoute;
    store.save("route", String(failed.route_id), { ...failedPayload, status: "completed" });
    assert.throws(() => service.routeWorkflowProposalCreate({ ...proposalArgs, route_id: failed.route_id }), /passed route/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("项目 Policy 用结构化回执强制安全路线，并允许 Host Adapter 只领取下一安全动作", async () => {
  const root = join(tmpdir(), `craft-route-policy-${process.pid}-${Date.now()}`);
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  try {
    service.projectPolicySave({ project_id: "craft", name: "严格研发", enforcement: "required" });
    const policy = service.projectPolicySave({ policy_id: "project_policy_secondary", project_id: "craft",
      name: "严格研发第二版", enforcement: "required" });
    assert.throws(() => service.projectPolicySave({ project_id: "bad", name: "Bad", enforcement: "bad" }), /enforcement/);
    assert.throws(() => service.projectPolicySave({ project_id: "bad", name: "Bad", receipt_requirements: { unknown: [] } }), /receipt stage/);
    assert.throws(() => service.projectPolicySave({ project_id: "bad", name: "Bad", receipt_requirements: { baseline: ["git_diff", "git_diff"] } }), /unique/);
    assert.deepEqual(service.projectPolicySave({ project_id: "partial", name: "Partial", receipt_requirements: { baseline: ["git_diff"] } }).receipt_requirements,
      { baseline: ["git_diff"], minimal_change: [], verification: [], review: [] });
    assert.equal(service.projectPolicySave({ project_id: "advisory", name: "Advisory", enforcement: "advisory" }).enforcement, "advisory");
    assert.throws(() => service.hostAdapterSave({ name: "Bad", host: "bad", allowed_operations: ["complete_stage"] }), /adapter/);
    assert.throws(() => service.hostAdapterSave({ name: "Bad", host: "codex", allowed_operations: ["bad"] }), /unsupported operation/);
    const adapter = service.hostAdapterSave({ host_adapter_id: "adapter_codex", name: "Codex", host: "codex",
      allowed_operations: ["complete_stage"] });
    const route = service.defaultRoute({ goal: "安全改造服务", project_id: "craft" });
    assert.equal((route.policy as JsonObject).id, policy.id);
    const incompatible = service.hostAdapterSave({ name: "Only workflow", host: "generic", allowed_operations: ["execute_verified_workflow"] });
    assert.throws(() => service.hostAdapterDispatch({ host_adapter_id: incompatible.id, route_id: route.route_id }), /cannot dispatch/);
    const verified = store.save("workflow", "workflow_receipt_block", { name: "Verified", lifecycle: "verified", steps: [] });
    const verifiedRoute = service.defaultRoute({ goal: "Verified" });
    assert.equal((verifiedRoute.workflow as JsonObject).id, verified.id);
    assert.throws(() => service.routeReceiptRecord({ route_id: verifiedRoute.route_id, stage_id: "baseline", kind: "git_diff",
      status: "passed", command: "git diff --check", summary: "not a safe route" }), /active safe route/);
    assert.throws(() => service.defaultRouteUpdate({ route_id: route.route_id, stage_id: "baseline", summary: "无回执" }),
      /required receipts/);
    const dispatch = service.hostAdapterDispatch({ host_adapter_id: adapter.id, host_adapter_version: adapter.version, route_id: route.route_id });
    assert.equal((dispatch.action as JsonObject).kind, "complete_stage");
    const diff = service.routeReceiptRecord({ route_id: route.route_id, stage_id: "baseline", kind: "git_diff",
      status: "passed", command: "git diff --check", summary: "diff clean" });
    const testReceipt = service.routeReceiptRecord({ route_id: route.route_id, stage_id: "baseline", kind: "focused_test",
      status: "passed", command: "pnpm test -- route", summary: "focused test passed" });
    const updated = service.defaultRouteUpdate({ route_id: route.route_id, stage_id: "baseline", summary: "baseline done",
      receipt_ids: [(diff.receipt as JsonObject).id, (testReceipt.receipt as JsonObject).id] });
    assert.equal((updated.next_action as JsonObject).stage_id, "minimal_change");
    assert.throws(() => service.defaultRouteUpdate({ route_id: route.route_id, stage_id: "minimal_change", summary: "duplicate",
      receipt_ids: [(diff.receipt as JsonObject).id, (diff.receipt as JsonObject).id] }), /unique/);
    service.defaultRouteUpdate({ route_id: route.route_id, stage_id: "minimal_change", summary: "change done" });
    const failedReceipt = service.routeReceiptRecord({ route_id: route.route_id, stage_id: "verification", kind: "coverage",
      status: "failed", command: "pnpm coverage", summary: "coverage below threshold", uri: "file:///coverage" });
    assert.equal((failedReceipt.evidence as JsonObject).confidence, "rejected");
    const skippedReceipt = service.routeReceiptRecord({ route_id: route.route_id, stage_id: "verification", kind: "static_check",
      status: "skipped", command: "pnpm lint", summary: "not applicable" });
    assert.equal((skippedReceipt.evidence as JsonObject).confidence, "bounded");
    assert.throws(() => service.hostAdapterReport({ dispatch_id: (dispatch.dispatch as JsonObject).id, status: "unknown", summary: "bad" }), /status/);
    const report = service.hostAdapterReport({ dispatch_id: (dispatch.dispatch as JsonObject).id, status: "completed", summary: "baseline handed off" });
    assert.equal((report.dispatch as JsonObject).status, "completed");
    assert.throws(() => service.hostAdapterReport({ dispatch_id: (dispatch.dispatch as JsonObject).id, status: "completed", summary: "again" }), /terminal/);
    const other = service.defaultRoute({ goal: "其他安全改造", project_id: "craft" });
    const otherDiff = service.routeReceiptRecord({ route_id: other.route_id, stage_id: "baseline", kind: "git_diff",
      status: "passed", command: "git diff --check", summary: "other clean" });
    assert.throws(() => service.defaultRouteUpdate({ route_id: route.route_id, stage_id: "verification", summary: "wrong receipt",
      receipt_ids: [(otherDiff.receipt as JsonObject).id] }), /belong/);
    assert.throws(() => service.routeReceiptRecord({ route_id: route.route_id, stage_id: "verification", kind: "bad",
      status: "passed", command: "ok", summary: "bad" }), /receipt kind/);
    assert.throws(() => service.routeReceiptRecord({ route_id: route.route_id, stage_id: "verification", kind: "review",
      status: "bad", command: "ok", summary: "bad" }), /receipt status/);
    assert.throws(() => service.routeReceiptRecord({ route_id: route.route_id, stage_id: "verification", kind: "focused_test",
      status: "passed", command: "TOKEN=secret", summary: "bad" }), /sensitive/);
    const terminal = service.defaultRoute({ goal: "终态路线" });
    const terminalRecord = store.get("route", String(terminal.route_id));
    const { id: _terminalId, version: _terminalVersion, created_at: _terminalCreatedAt, updated_at: _terminalUpdatedAt, ...terminalPayload } = terminalRecord;
    store.save("route", String(terminal.route_id), { ...terminalPayload, status: "completed" });
    assert.throws(() => service.routeReceiptRecord({ route_id: terminal.route_id, stage_id: "baseline", kind: "git_diff",
      status: "passed", command: "git diff --check", summary: "terminal" }), /active safe route/);
    const malformed = service.defaultRoute({ goal: "无下一阶段" });
    const malformedRecord = store.get("route", String(malformed.route_id));
    const { id: _malformedId, version: _malformedVersion, created_at: _malformedCreatedAt, updated_at: _malformedUpdatedAt, ...malformedPayload } = malformedRecord;
    store.save("route", String(malformed.route_id), { ...malformedPayload, status: "awaiting_host",
      stage_state: (malformedPayload.stage_state as JsonObject[]).map((state) => ({ ...state, status: "completed" })) });
    assert.throws(() => service.routeReceiptRecord({ route_id: malformed.route_id, stage_id: "baseline", kind: "git_diff",
      status: "passed", command: "git diff --check", summary: "no action" }), /next required stage is none/);
    const legacy = service.defaultRoute({ goal: "旧路线兼容" });
    const legacyRecord = store.get("route", String(legacy.route_id));
    const { id: _legacyId, version: _legacyVersion, created_at: _legacyCreatedAt, updated_at: _legacyUpdatedAt, receipt_requirements: _legacyRequirements, ...legacyPayload } = legacyRecord;
    store.save("route", String(legacy.route_id), legacyPayload);
    assert.deepEqual((service.defaultRouteResume({ task_id: (legacy.task as JsonObject).id }).next_action as JsonObject).required_receipts, []);
    assert.equal((service.defaultRouteUpdate({ route_id: legacy.route_id, stage_id: "baseline", summary: "legacy baseline" }).route as JsonObject).status,
      "awaiting_host");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
