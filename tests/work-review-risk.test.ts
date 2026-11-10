import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { runBuiltinAcceptanceTicks } from "../core/acceptance-worker.ts";
import { WorkbenchWebApp } from "../core/workbench-server.ts";
import { McpServer } from "../core/mcp.ts";
import { digestJson } from "../core/digest.ts";
import { reviewRisks, riskReviewCriteria, taskReviewRisk, RISK_REVIEW_CRITERION } from "../core/work-review-risk.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-risk-review-")); const store = await new CraftStore(craftPaths(root)).open(), service = new CraftService(store);
  const task = service.taskOpen({ title: "Governed data migration", goal: "Deliver independently reviewed output" }).task as JsonObject;
  let calls = 0;
  service.codexHost.executor = async () => { calls++; await writeFile(join(root, "result.txt"), "ready"); return { exitCode: 0, signal: null, stdout: JSON.stringify({ type: "turn.completed", usage: {} }) + "\n", stderr: "", timedOut: false, cancelled: false, outputLimited: false }; };
  const criteria = [{ id: "bytes", name: "Check bytes", method: "program" }];
  return { root, store, service, task, criteria, calls: () => calls, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}
test("risk rules validate structured declarations and retain deterministic checks", async () => {
  assert.deepEqual(reviewRisks(undefined, []), []);
  assert.deepEqual(reviewRisks(undefined, ["external_write"]), ["external_write"]);
  assert.deepEqual(reviewRisks(["data_migration", "permission_change"], ["external_write"]), ["data_migration", "external_write", "permission_change"]);
  for (const value of [null, "high", ["unknown"], ["data_migration", "data_migration"], [1]]) assert.throws(() => reviewRisks(value, []));
  assert.equal(riskReviewCriteria(undefined, null), undefined);
  for (const criteria of [undefined, [], [null], [{ method: "model" }], [{ method: "program", required: false }]]) assert.throws(() => riskReviewCriteria(criteria, {}), /mandatory deterministic/);
  const program = { id: "bytes", method: "program" }, review = { id: RISK_REVIEW_CRITERION, method: "human" };
  assert.deepEqual(riskReviewCriteria([program, review], {}), [program, review]);
  for (const extra of [[review, review], [{ ...review, required: false }], [{ ...review, method: "model" }]]) assert.throws(() => riskReviewCriteria([program, ...extra], {}), /downgraded/);
  const f = await fixture(); try {
    assert.equal(taskReviewRisk(f.store, String(f.task.id)), null);
    f.store.create("task_control_contract", "empty-declaration", { task_id: f.task.id, review_risks: [] });
    assert.equal(taskReviewRisk(f.store, String(f.task.id)), null);
    f.store.save("task_control_contract", "empty-declaration", { task_id: f.task.id, review_risks: "corrupt" });
    assert.throws(() => taskReviewRisk(f.store, String(f.task.id)), /must be an array/);
    f.store.save("task_control_contract", "empty-declaration", { task_id: "unrelated" });
    f.store.create("task_control_contract", "legacy-external", { task_id: "external-task", allowed_effects: ["external_write"] });
    assert.deepEqual(taskReviewRisk(f.store, "external-task")!.risks, ["external_write"]);
    const legacyTask = f.service.taskOpen({ title: "Legacy permissions", goal: "Keep original contract identity" }).task as JsonObject;
    const legacy = { task_id: legacyTask.id, workspace: f.root, allowed_effects: ["external_write"], acceptance_required: false, activation_profile: null, budget_account: null };
    const legacyRecord = f.store.create("task_control_contract", "legacy-identity", { ...legacy, identity_digest: digestJson(legacy), status: "active", launch_id: null });
    assert.equal((f.service.taskControlSave({ contract_id: legacyRecord.id, task_id: legacyTask.id, workspace: f.root, allowed_effects: ["external_write"] }).contract as JsonObject).version, legacyRecord.version);
    f.store.create("task_control_contract", "raw-risk", { task_id: "raw-risk-task", review_risks: ["permission_change"] });
    assert.deepEqual(taskReviewRisk(f.store, "raw-risk-task")!.risks, ["permission_change"]);
    const one = f.service.taskControlSave({ task_id: f.task.id, workspace: f.root, review_risks: ["data_migration", "permission_change"] }).contract as JsonObject;
    const two = f.service.taskControlSave({ contract_id: "another", task_id: f.task.id, workspace: f.root, review_risks: ["asset_promotion"] }).contract as JsonObject;
    assert.equal(f.service.taskControlSave({ task_id: f.task.id, workspace: f.root, review_risks: ["permission_change", "data_migration"] }).idempotent, true);
    assert.throws(() => f.service.taskControlSave({ task_id: f.task.id, workspace: f.root }), /idempotency conflict/);
    const decision = taskReviewRisk(f.store, String(f.task.id))!;
    assert.equal((decision.rule_ids as unknown[]).length, 3); assert.equal((decision.input_refs as unknown[]).length, 2);
    assert.deepEqual([one.review_risks, two.review_risks], [["data_migration", "permission_change"], ["asset_promotion"]]);
  } finally { await f.close(); }
});
test("risk-pinned execution blocks bypasses, reviews frozen output and preserves gates through replan", async () => {
  const f = await fixture(); try {
    const mcp = new McpServer(f.service, "full");
    const control = (await mcp.handlers.craft_task_control_save({ task_id: f.task.id, workspace: f.root, allowed_effects: ["local_write"], review_risks: ["data_migration"] }) as JsonObject).contract as JsonObject;
    assert.equal(f.calls(), 0);
    assert.throws(() => f.service.workLaunchPrepare({ task_id: f.task.id, host: "codex-cli", workspace: f.root, prompt: "bypass" }), /Task Run contract/);
    assert.throws(() => f.service.taskRunPrepare({ contract_id: control.id, host: "codex-cli", prompt: "migrate", sandbox: "workspace-write" }), /mandatory deterministic/);
    assert.equal(f.store.list("work_launch").length, 0);
    const web = new WorkbenchWebApp(f.service, "token", "http://127.0.0.1:4173", { workbenchDir: resolve("../craft-workbench/workbench") });
    for (const module of ["task-replan-ui.js", "work-review-risk-ui.js"]) {
      for (const prefix of ["/", "/workbench/"]) {
        const asset = web.handle({ method: "GET", path: prefix + module, token: "token" });
        assert.equal(asset.status, 200); assert.match(String(asset.body), /export function renderTask/);
      }
    }
    const response = web.handle({ method: "POST", path: "/api/task-runs", token: "token", origin: "http://127.0.0.1:4173", body: JSON.stringify({ task_run_id: "source", contract_id: control.id, host: "codex-cli", prompt: "migrate", sandbox: "workspace-write", acceptance_criteria: f.criteria }) });
    assert.equal(response.status, 201);
    const prepared = JSON.parse(String(response.body)) as JsonObject;
    const launch = f.service.workLaunchDecide({ launch_id: (prepared.launch as JsonObject).id, actor: "worker", approved: true, prompt: "migrate" }).launch as JsonObject;
    await f.service.hostRuns.wait(String(launch.run_id));
    const planId = String(launch.acceptance_plan_id);
    const criteria = (f.store.get("acceptance_plan", planId).criteria as JsonObject[]);
    assert.equal(criteria.length, 2); assert.equal(criteria[1]!.required, true);
    assert.throws(() => f.service.acceptancePlanSave({ task_id: f.task.id, launch_id: launch.id, plan_id: "weaken", criteria: [{ id: "model", name: "Model says done", method: "model" }] }), /mandatory deterministic/);
    assert.throws(() => f.service.acceptanceHumanReview({ plan_id: planId, criterion_id: RISK_REVIEW_CRITERION, reviewer: "worker", result: "passed", summary: "self-certify" }), /frozen review report/);
    const fileJob = () => f.service.acceptanceFileEvaluationPrepare({ plan_id: planId, criterion_id: "bytes", workspace: f.root, relative_path: "result.txt", expected_sha256: createHash("sha256").update("ready").digest("hex") });
    fileJob(); await runBuiltinAcceptanceTicks(f.service);
    assert.equal((f.service.taskRunRefresh({ task_run_id: "source" }).state as JsonObject).action, "collect_acceptance");
    const freeze = (id: string) => f.service.workReviewFreeze({ candidate_id: id, task_run_id: "source", task_run_version: f.store.get("task_run", "source").version, launch_version: f.store.get("work_launch", String(launch.id)).version, host_run_version: f.store.get("host_run", String(launch.run_id)).version, plan_version: f.store.get("acceptance_plan", planId).version, criterion_id: RISK_REVIEW_CRITERION, relative_paths: ["result.txt"], actor: "worker" }).candidate as JsonObject;
    const candidate = freeze("risk-candidate");
    assert.throws(() => f.service.workReviewReport({ candidate_id: candidate.id, candidate_version: candidate.version, reviewer: "worker", result: "passed", summary: "self", findings: [] }), /Producer/);
    f.service.workReviewReport({ candidate_id: candidate.id, candidate_version: candidate.version, reviewer: "independent", result: "failed", summary: "Need a safer migration plan", findings: [{ severity: "blocker", path: "result.txt", message: "Missing rollback procedure" }] });
    await runBuiltinAcceptanceTicks(f.service);
    f.store.create("task_control_contract", "legacy-minimal-contract", { task_id: f.task.id, status: "inactive" });
    f.service.taskControlSave({ contract_id: "low-risk-cannot-downgrade", task_id: f.task.id, workspace: f.root });
    assert.deepEqual(taskReviewRisk(f.store, String(f.task.id))!.risks, ["data_migration"]);
    const source = f.store.get("work_launch", String(launch.id));
    const proposal = f.service.taskReplanPrepare({ proposal_id: "revised", new_task_run_id: "next", source_launch_id: launch.id, task_version: f.store.get("task", String(f.task.id)).version, launch_version: source.version, host_run_version: f.store.get("host_run", String(launch.run_id)).version, actor: "worker", change_type: "plan_change", change_summary: "Add rollback instructions", prompt: "produce revised migration" }).proposal as JsonObject;
    const approved = f.service.taskReplanDecide({ proposal_id: proposal.id, proposal_version: proposal.version, actor: "worker", decision: "approve", confirmed_new_plan_and_budget: true }).proposal as JsonObject;
    const next = f.service.taskReplanExecute({ proposal_id: approved.id, proposal_version: approved.version, actor: "worker" });
    const nextLaunch = next.launch as JsonObject;
    assert.equal(nextLaunch.status, "awaiting_approval"); assert.equal(f.calls(), 1);
    assert.deepEqual((nextLaunch.review_risk as JsonObject).risks, ["data_migration"]);
    assert.equal(f.store.list("work_review_policy", 100, item => item.plan_id === nextLaunch.acceptance_plan_id).length, 1);
    assert.throws(() => f.service.acceptanceHumanReview({ plan_id: nextLaunch.acceptance_plan_id, criterion_id: RISK_REVIEW_CRITERION, reviewer: "someone", result: "passed", summary: "Reuse prior reviewer" }), /frozen review report/);
    const started = f.service.workLaunchDecide({ launch_id: nextLaunch.id, actor: "worker", approved: true, prompt: "produce revised migration" }).launch as JsonObject;
    await f.service.hostRuns.wait(String(started.run_id));
    await runBuiltinAcceptanceTicks(f.service);
    const newPlan = f.store.get("acceptance_plan", String(started.acceptance_plan_id));
    const revised = f.service.workReviewFreeze({ candidate_id: "revised-candidate", task_run_id: "next", task_run_version: f.store.get("task_run", "next").version, launch_version: f.store.get("work_launch", String(started.id)).version, host_run_version: f.store.get("host_run", String(started.run_id)).version, plan_version: newPlan.version, criterion_id: RISK_REVIEW_CRITERION, relative_paths: ["result.txt"], actor: "worker" }).candidate as JsonObject;
    f.service.workReviewReport({ candidate_id: revised.id, candidate_version: revised.version, reviewer: "independent", result: "passed", summary: "Revised migration is acceptable", findings: [] });
    assert.equal((f.service.taskRunRefresh({ task_run_id: "next" }).state as JsonObject).action, "collect_acceptance");
    await runBuiltinAcceptanceTicks(f.service);
    assert.equal((f.service.taskRunRefresh({ task_run_id: "next" }).state as JsonObject).action, "deliver");
    const projected = (f.service.homeTask({ task_id: f.task.id }).task_runs as JsonObject[]).find(item => item.id === "next")!;
    assert.deepEqual((projected.review_risk as JsonObject).risks, ["data_migration"]); assert.equal(f.calls(), 2);
    assert.throws(() => f.service.taskControlSave({ contract_id: "late-risk", task_id: f.task.id, workspace: f.root, review_risks: ["permission_change"] }), /before.*first execution/);
  } finally { await f.close(); }
});

test("risk gate preparation rolls back atomically and retry cannot drop its inherited policy", async (t) => {
  const f = await fixture(); try {
    const control = f.service.taskControlSave({ task_id: f.task.id, workspace: f.root, allowed_effects: ["read_only", "external_write"] }).contract as JsonObject;
    assert.deepEqual(control.review_risks, ["external_write"]);
    const request = { task_run_id: "original", contract_id: control.id, host: "codex-cli", prompt: "inspect", acceptance_criteria: f.criteria };
    const create = f.store.create.bind(f.store);
    const fault = t.mock.method(f.store, "create", (...args: Parameters<typeof f.store.create>) => { const result = create(...args); if (args[0] === "work_review_policy") throw new Error("simulated risk policy storage failure"); return result; });
    assert.throws(() => f.service.taskRunPrepare(request), /storage failure/); fault.mock.restore();
    for (const kind of ["work_launch", "acceptance_plan", "work_review_policy", "task_run", "codex_dispatch"]) assert.equal(f.store.list(kind).length, 0, kind);
    assert.equal(f.calls(), 0);
    const prepared = f.service.taskRunPrepare(request), launch = prepared.launch as JsonObject; await f.service.hostRuns.wait(String(launch.run_id));
    f.service.acceptanceFileEvaluationPrepare({ plan_id: launch.acceptance_plan_id, criterion_id: "bytes", workspace: f.root, relative_path: "result.txt", expected_sha256: "0".repeat(64) });
    await runBuiltinAcceptanceTicks(f.service);
    // Complete the independent check as blocked; both checks are now current and failed/blocked.
    const plan = f.store.get("acceptance_plan", String(launch.acceptance_plan_id));
    const candidate = f.service.workReviewFreeze({ candidate_id: "retry-risk", task_run_id: "original", task_run_version: f.store.get("task_run", "original").version, launch_version: f.store.get("work_launch", String(launch.id)).version, host_run_version: f.store.get("host_run", String(launch.run_id)).version, plan_version: plan.version, criterion_id: RISK_REVIEW_CRITERION, relative_paths: ["result.txt"], actor: "worker" }).candidate as JsonObject;
    f.service.workReviewReport({ candidate_id: candidate.id, candidate_version: candidate.version, reviewer: "independent", result: "blocked", summary: "Need fresh deterministic evidence", findings: [] });
    await runBuiltinAcceptanceTicks(f.service);
    const source = f.store.get("task_run", "original"), currentLaunch = f.store.get("work_launch", String(launch.id));
    const next = f.service.taskRunRetry({ task_run_id: source.id, task_run_version: source.version, launch_version: currentLaunch.version, host_run_version: f.store.get("host_run", String(launch.run_id)).version, new_task_run_id: "retried", actor: "worker", prompt: "inspect corrected bytes" });
    await f.service.hostRuns.wait(String((next.launch as JsonObject).run_id));
    assert.deepEqual(((next.launch as JsonObject).review_risk as JsonObject).risks, ["external_write"]);
    assert.equal(f.store.list("work_review_policy", 100, item => item.plan_id === (next.launch as JsonObject).acceptance_plan_id).length, 1);
    assert.throws(() => f.service.workLaunchRetry({ launch_id: launch.id, prompt: "escape" }));
    assert.equal(f.calls(), 2);
  } finally { await f.close(); }
});

test("WorkControl plan mode pins risk before execution and keeps the complete acceptance contract", async () => {
  const f = await fixture(); try {
    await writeFile(join(f.root, "result.txt"), "before");
    const workspace = f.service.workspaceOpen({ workspace_id: "risk-workspace", name: "Risk workspace", root_path: f.root, include_paths: ["result.txt"] }).workspace as JsonObject;
    const result = await new McpServer(f.service, "full").handlers.craft_work_control_prepare({ interaction_mode: "plan", workspace_id: workspace.id, title: "Migration planning", goal: "Review a bounded migration", host: "codex-cli", prompt: "inspect", acceptance_criteria: f.criteria, review_risks: ["data_migration"] }) as JsonObject;
    assert.equal(result.interaction_mode, "plan"); assert.equal(f.calls(), 0);
    const launch = result.launch as JsonObject;
    assert.deepEqual((launch.review_risk as JsonObject).risks, ["data_migration"]);
    assert.equal(launch.deferred_start, true);
    assert.equal(((((result.work_loop as JsonObject).task_semantics as JsonObject).accept as JsonObject).criteria as JsonObject[]).length, 2);
    assert.equal((f.store.get("acceptance_plan", String(launch.acceptance_plan_id)).criteria as JsonObject[]).length, 2);
  } finally { await f.close(); }
});
