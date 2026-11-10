import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { WorkbenchWebApp } from "../core/workbench-server.ts";
import { McpServer } from "../core/mcp.ts";
import { digestJson } from "../core/digest.ts";
import { assertExecutionRootActive, guardNewExecutionRoot, registerExecutionFence } from "../core/task-execution-fence.ts";

async function fixture(options: { success?: boolean; acceptance?: boolean; budget?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "craft-task-replan-")); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  let calls = 0;
  service.codexHost.executor = async () => { calls++; if (calls === 1 && !options.success) throw new Error("simulated environment failure"); return { exitCode: 0, signal: null, stdout: JSON.stringify({ type: "turn.completed", usage: {} }) + "\n", stderr: "", timedOut: false, cancelled: false, outputLimited: false }; };
  const task = service.taskOpen({ title: "Replan", goal: "preserve the goal" }).task as JsonObject;
  const account = options.budget ? service.budgetOpen({ budget_id: "scope-budget", owner_type: "task", owner_id: task.id, limits: { usd: 1 } }).account as JsonObject : null;
  const control = service.taskControlSave({ task_id: task.id, workspace: root, allowed_effects: ["read_only"], budget_account_id: account?.id }).contract as JsonObject;
  const prepared = service.taskRunPrepare({ task_run_id: "original", contract_id: control.id, host: "codex-cli", prompt: "inspect", total_timeout_ms: 60000, acceptance_criteria: options.acceptance ? [{ id: "review", name: "Owner verification", method: "human" }] : undefined });
  const launch = prepared.launch as JsonObject; await service.hostRuns.wait(String(launch.run_id));
  const request = (id = "proposal", next = "successor") => ({ proposal_id: id, source_launch_id: launch.id, task_version: store.get("task", String(task.id)).version, launch_version: store.get("work_launch", String(launch.id)).version, host_run_version: store.get("host_run", String(launch.run_id)).version, new_task_run_id: next, actor: "user:owner", change_type: "plan_change", change_summary: "Use a repaired workflow and explicitly authorize another execution window", prompt: "inspect using the repaired workflow", total_timeout_ms: 120000 });
  const approve = (proposal: JsonObject) => service.taskReplanDecide({ proposal_id: proposal.id, proposal_version: proposal.version, actor: "user:owner", decision: "approve", confirmed_new_plan_and_budget: true }).proposal as JsonObject;
  return { root, store, service, task, control, launch, request, approve, calls: () => calls };
}

test("bounded task cannot reset its root without a pinned, evidenced and explicitly approved replan", async () => {
  const f = await fixture();
  try {
    const before = f.store.get("work_launch", String(f.launch.id));
    const inherited = f.service.taskReplanPrepare({ ...f.request("inherited", "inherited-next"), total_timeout_ms: undefined }).proposal as JsonObject;
    assert.equal(inherited.total_timeout_ms, 60000);
    assert.throws(() => f.service.workLaunchPrepare({ task_id: f.task.id, host: "codex-cli", workspace: f.root, prompt: "reset root" }), /evidence-backed replan/);
    const web = new WorkbenchWebApp(f.service, "token", "http://127.0.0.1:4173");
    const response = web.handle({ method: "POST", path: "/api/task-replans/prepare", token: "token", origin: "http://127.0.0.1:4173", body: JSON.stringify(f.request()) });
    assert.equal(response.status, 201);
    let proposal = (JSON.parse(String(response.body)) as JsonObject).proposal as JsonObject;
    assert.equal(proposal.status, "pending"); assert.equal(f.calls(), 1);
    assert.equal(f.service.taskReplanPrepare(f.request()).idempotent, true);
    assert.throws(() => f.service.taskReplanPrepare({ ...f.request(), prompt: "changed" }), /idempotency conflict/);
    const execute = () => ({ proposal_id: proposal.id, proposal_version: proposal.version, actor: "user:owner", prompt: f.request().prompt });
    assert.throws(() => f.service.taskReplanExecute(execute()), /approved version/);
    assert.throws(() => f.service.taskReplanDecide({ proposal_id: proposal.id, proposal_version: proposal.version, actor: "user:owner", decision: "approve" }), /explicit/);
    const decision = { proposal_id: proposal.id, proposal_version: proposal.version, actor: "user:owner", decision: "approve", confirmed_new_plan_and_budget: true };
    const approvalResponse = web.handle({ method: "POST", path: "/api/task-replans/proposal/decide", token: "token", origin: "http://127.0.0.1:4173", body: JSON.stringify({ ...decision, proposal_id: "wrong-body" }) });
    assert.equal(approvalResponse.status, 200); proposal = (JSON.parse(String(approvalResponse.body)) as JsonObject).proposal as JsonObject;
    assert.equal(f.service.taskReplanDecide(decision).idempotent, true); assert.equal(f.calls(), 1);
    const result = await new McpServer(f.service, "full").handlers.craft_task_replan_execute(execute()) as JsonObject;
    await f.service.hostRuns.wait(String((result.launch as JsonObject).run_id));
    assert.equal(f.calls(), 2);
    assert.equal((f.service.taskRunRefresh({ task_run_id: "successor" }).state as JsonObject).action, "deliver");
    assert.equal((f.service.taskRunRefresh({ task_run_id: "original" }).state as JsonObject).status, "superseded");
    assert.throws(() => f.service.taskRunResume({ task_run_id: "original" }), /superseded/);
    assert.equal(f.service.taskReplanExecute(execute()).idempotent, true); assert.equal(f.calls(), 2);
    assert.deepEqual(f.store.get("work_launch", String(f.launch.id)), before);
    assert.throws(() => assertExecutionRootActive(f.store, before), /superseded/);
    assert.equal((f.service.homeTask({ task_id: f.task.id }).task_replans as JsonObject[])[0].status, "consumed");
    const read = web.handle({ method: "GET", path: "/api/task-replans/proposal", token: "token" }); assert.equal(read.status, 200);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("replan consumption rolls back preparation failures and only one approved proposal can replace a source", async (t) => {
  const f = await fixture();
  try {
    let one = f.approve(f.service.taskReplanPrepare(f.request("one", "next-one")).proposal as JsonObject);
    const two = f.approve(f.service.taskReplanPrepare(f.request("two", "next-two")).proposal as JsonObject);
    const fence = f.store.get("task_execution_fence", `task_execution_fence_${f.task.id}`);
    const originalSave = f.store.save.bind(f.store);
    const fault = t.mock.method(f.store, "save", (...args: Parameters<typeof f.store.save>) => { const result = originalSave(...args); if (args[0] === "work_launch" && args[1] === "replan_launch_next-one") throw new Error("simulated replan persistence failure"); return result; });
    const execute = (p: JsonObject) => ({ proposal_id: p.id, proposal_version: p.version, actor: "user:owner", prompt: f.request().prompt });
    assert.throws(() => f.service.taskReplanExecute(execute(one)), /persistence failure/); fault.mock.restore();
    assert.equal(f.calls(), 1); assert.deepEqual(f.store.get("task_execution_fence", String(fence.id)), fence);
    for (const [kind, id] of [["task_run", "next-one"], ["task_replan_execution_permit", "replan_launch_next-one"], ["task_replan_consumption", "one"]]) assert.equal(f.store.find(kind!, id!), null);
    const next = f.service.taskReplanExecute(execute(one)); await f.service.hostRuns.wait(String((next.launch as JsonObject).run_id));
    assert.throws(() => f.service.taskReplanExecute(execute(two)), /superseded/);
    assert.equal(f.calls(), 2); assert.equal(f.store.find("task_run", "next-two"), null);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("replan validates bounded inputs, fresh scoped evidence and replay-safe decisions", async (t) => {
  const f = await fixture();
  try {
    for (const patch of [{ proposal_id: "bad/id" }, { new_task_run_id: "../bad" }, { change_type: "unknown" }, { change_summary: "x".repeat(8001) }, { prompt: "x".repeat(128001) }, { evidence_refs: "bad" }, { change_type: "new_evidence", evidence_refs: [] }, { total_timeout_ms: 999 }, { total_budget_usd: -1 }, { total_budget_usd: 1 }, { task_version: 999 }, { launch_version: 999 }, { host_run_version: 999 }, { environment: { changed: true } }, { budget: { changed: true } }]) assert.throws(() => f.service.taskReplanPrepare({ ...f.request(), ...patch }));
    const evidence = (patch: JsonObject = {}, asserted = false) => f.service.evidenceRecord({ evidence_id: "fresh", source_type: "program", confidence: "confirmed", claim: "Simulated repaired environment observation", observed_at: new Date().toISOString(), metadata: { task_id: f.task.id }, ...patch }, asserted);
    let ev = evidence();
    for (const patch of [{ metadata: {} }, { metadata: { task_id: f.task.id, revoked: true } }, { metadata: { task_id: f.task.id, retracted: true } }, { observed_at: "bad" }, { observed_at: "2000-01-01T00:00:00.000Z" }, { observed_at: "2999-01-01T00:00:00.000Z" }, { confidence: "rejected" }, { source_type: "human" }, { confidence: "bounded" }]) {
      ev = evidence(patch);
      assert.throws(() => f.service.taskReplanPrepare({ ...f.request(), change_type: "environment_repair", evidence_refs: [{ id: ev.id, version: ev.version }] }));
    }
    ev = evidence({}, true);
    assert.throws(() => f.service.taskReplanPrepare({ ...f.request(), change_type: "new_evidence", evidence_refs: [{ id: ev.id, version: ev.version }] }), /confirmed program/);
    ev = evidence();
    const ref = { id: ev.id, version: ev.version };
    for (const refs of [[ref, ref], Array(21).fill(ref), [{ id: ev.id, version: Number(ev.version) - 1 }]]) assert.throws(() => f.service.taskReplanPrepare({ ...f.request(), change_type: "new_evidence", evidence_refs: refs }));
    const usedKey = digestJson([f.task.id, ev.id, ev.version]);
    f.store.create("task_replan_evidence_use", usedKey, { task_id: f.task.id, proposal_id: "prior-plan" });
    assert.throws(() => f.service.taskReplanPrepare({ ...f.request(), change_type: "new_evidence", evidence_refs: [ref] }), /already authorized/);
    ev = evidence();
    const prepared = f.service.taskReplanPrepare({ ...f.request(), change_type: "environment_repair", evidence_refs: [{ id: ev.id, version: ev.version }] }).proposal as JsonObject;
    const get = f.store.get.bind(f.store);
    const corruption = t.mock.method(f.store, "get", (...args: Parameters<typeof f.store.get>) => args[0] === "evidence" ? { ...get(...args), claim: "corrupt observation" } : get(...args));
    assert.throws(() => f.approve(prepared), /evidence changed/); corruption.mock.restore();
    const fence = f.store.get("task_execution_fence", `task_execution_fence_${f.task.id}`);
    f.store.save("task_execution_fence", String(fence.id), { ...fence });
    assert.throws(() => f.approve(prepared), /fence changed/);
    const p = f.service.taskReplanPrepare(f.request("revocable", "revoked-next")).proposal as JsonObject;
    assert.throws(() => f.service.taskReplanDecide({ proposal_id: p.id, proposal_version: 999, actor: "user:owner", decision: "approve" }), /version changed/);
    assert.throws(() => f.service.taskReplanDecide({ proposal_id: p.id, proposal_version: p.version, actor: "user:owner", decision: "unknown" }), /unsupported/);
    const approved = f.approve(p);
    const revoke = { proposal_id: approved.id, proposal_version: approved.version, actor: "user:owner", decision: "revoke" };
    assert.equal((f.service.taskReplanDecide(revoke).proposal as JsonObject).status, "revoked");
    assert.equal(f.service.taskReplanDecide(revoke).idempotent, true);
    assert.throws(() => f.service.taskReplanExecute({ proposal_id: approved.id, proposal_version: approved.version, actor: "user:owner" }), /approved version/);
    const rejected = f.service.taskReplanPrepare(f.request("reject", "rejected-next")).proposal as JsonObject;
    f.service.taskReplanDecide({ proposal_id: rejected.id, proposal_version: rejected.version, actor: "user:owner", decision: "reject" });
    assert.throws(() => f.approve({ ...rejected, version: Number(rejected.version) + 1 }), /proposal state/);
    const expired = f.service.taskReplanPrepare(f.request("expired", "expired-next")).proposal as JsonObject;
    const clock = t.mock.method(Date, "now", () => Date.parse(String(expired.expires_at)) + 1);
    assert.throws(() => f.approve(expired), /expired/); clock.mock.restore();
    const changed = f.service.taskReplanPrepare(f.request("changed", "changed-next")).proposal as JsonObject;
    const task = f.store.get("task", String(f.task.id)); f.store.save("task", String(task.id), { ...task, goal: "Updated goal" });
    assert.throws(() => f.approve(changed), /source changed/);
    assert.equal(f.calls(), 1);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("replan refuses active or unknown work and preserves acceptance and task budget references", async (t) => {
  const f = await fixture({ success: true, acceptance: true, budget: true });
  try {
    assert.throws(() => f.service.taskReplanPrepare(f.request()), /stopped failed work/);
    const plan = f.store.get("acceptance_plan", String(f.launch.acceptance_plan_id));
    f.service.acceptanceHumanReview({ plan_id: plan.id, reviewer: "operator", criterion_id: "review", result: "failed", summary: "Repair required" });
    const h = f.service.taskRunHandoff({ task_run_id: "original", reason: "assign owner" }).handoff as JsonObject;
    f.service.taskRunAssignment({ task_run_id: "original", handoff_id: h.id, handoff_version: h.version, assignment_version: 0, actor: "user:owner", reason: "Own replanning", request_id: "owner", action: "claim" });
    const originalGet = f.store.get.bind(f.store);
    const stopped = t.mock.method(f.store, "get", (...args: Parameters<typeof f.store.get>) => args[0] === "host_run" ? { ...originalGet(...args), status: "interrupted", stopped_confirmation: { source: "explicit_operator_confirmation" } } : originalGet(...args));
    assert.equal((f.service.taskReplanPrepare(f.request("stopped", "stopped-next")).proposal as JsonObject).status, "pending"); stopped.mock.restore();
    for (const patch of [{ kind: "work_launch", values: { deferred_start: true } }, { kind: "work_launch", values: { activation_plan_id: "managed" } }, { kind: "host_run", values: { status: "running" } }, { kind: "host_run", values: { cleanup_unconfirmed: true } }, { kind: "host_run", values: { status: "interrupted", stopped_confirmation: undefined } }, { kind: "host_run", values: { finished_at: "bad" } }]) {
      const altered = t.mock.method(f.store, "get", (...args: Parameters<typeof f.store.get>) => args[0] === patch.kind ? { ...originalGet(...args), ...patch.values } : originalGet(...args));
      assert.throws(() => f.service.taskReplanPrepare(f.request())); altered.mock.restore();
    }
    const reserved = f.store.create("budget_reservation", "pending", { budget_id: `internal_budget_${f.launch.dispatch_id}`, status: "reserved" });
    assert.throws(() => f.service.taskReplanPrepare(f.request()), /unresolved model cost/);
    f.store.save("budget_reservation", String(reserved.id), { ...reserved, status: "settled" });
    f.store.create("work_launch", "unrelated-legacy", { task_id: f.task.id, host: "codex-cli", dispatch_id: "unrelated", retry_of: null });
    const p = f.approve(f.service.taskReplanPrepare(f.request()).proposal as JsonObject);
    assert.throws(() => f.service.taskReplanExecute({ proposal_id: p.id, proposal_version: p.version, actor: "user:owner", prompt: "wrong" }), /does not match/);
    const result = f.service.taskReplanExecute({ proposal_id: p.id, proposal_version: p.version, actor: "user:owner" });
    await f.service.hostRuns.wait(String((result.launch as JsonObject).run_id));
    const run = result.task_run as JsonObject, control = f.store.get("task_control_contract", String(run.contract_id));
    assert.equal((control.budget_account as JsonObject).id, "scope-budget");
    assert.equal((f.service.taskRunRefresh({ task_run_id: "successor" }).state as JsonObject).action, "collect_acceptance");
    assert.equal(f.calls(), 2);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("legacy denied roots can enter replanning without inventing Host or acceptance receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-legacy-replan-"));
  const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    const task = service.taskOpen({ title: "Denied legacy", goal: "inspect safely" }).task as JsonObject;
    const launch = store.create("work_launch", "legacy-denied", { task_id: task.id, host: "codex-cli", status: "denied", retry_of: null });
    registerExecutionFence(store, launch, false);
    assert.equal(store.find("task_execution_fence", `task_execution_fence_${task.id}`), null);
    registerExecutionFence(store, { ...launch, id: "registration-child", retry_of: launch.id }, false);
    const request = { proposal_id: "legacy-proposal", new_task_run_id: "legacy-next", source_launch_id: launch.id, task_version: task.version, launch_version: launch.version, actor: "operator", change_type: "plan_change", change_summary: "Use an allowed inspection", prompt: "Inspect within allowed scope" };
    const proposal = service.taskReplanPrepare(request).proposal as JsonObject;
    assert.equal(proposal.total_timeout_ms, null); assert.equal(proposal.total_budget_usd, null);
    const source = proposal.source_snapshot as JsonObject; assert.equal(source.host_run_id, null); assert.equal(source.task_run_id, null); assert.equal(source.plan_id, null);
    service.taskReplanDecide({ proposal_id: proposal.id, proposal_version: proposal.version, actor: "operator", decision: "approve", confirmed_new_plan_and_budget: true });
    const fence = store.get("task_execution_fence", `task_execution_fence_${task.id}`);
    guardNewExecutionRoot(store, String(task.id), "retry", { retry_of: launch.id });
    for (const data of [{ status: "consumed", task_id: task.id }, { status: "preparing", task_id: "other" }, { status: "preparing", task_id: task.id, argument_digest: "wrong" }]) {
      store.save("task_replan_execution_permit", "invalid", data);
      assert.throws(() => guardNewExecutionRoot(store, String(task.id), "invalid", {}), /evidence-backed/);
    }
    const duplicate = store.create("task_run", "duplicate-one", { launch_id: launch.id, contract_id: "unused" });
    store.create("task_run", "duplicate-two", { launch_id: launch.id });
    assert.throws(() => service.taskReplanPrepare({ ...request, proposal_id: "ambiguous" }), /ambiguous/);
    assert.equal(duplicate.launch_id, launch.id);
    store.create("work_launch", "legacy-child", { task_id: task.id, retry_of: launch.id });
    assert.throws(() => service.taskReplanPrepare({ ...request, proposal_id: "old-leaf" }), /latest attempt/);
    assert.equal(fence.active_root_launch_id, launch.id);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
