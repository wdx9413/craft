import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";
import { WorkbenchWebApp } from "../src/workbench-server.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-task-control-"));
  const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  service.codexHost.executor = async () => ({ exitCode: 0, signal: null, stderr: "", timedOut: false, cancelled: false, outputLimited: false,
    stdout: `${JSON.stringify({ type: "turn.completed", usage: {} })}\n` });
  const task = service.taskOpen({ title: "Controlled delivery", goal: "Ship a verified result" }).task as JsonObject;
  return { root, store, service, task };
}

async function terminalLaunch(f: Awaited<ReturnType<typeof fixture>>, id: string, acceptance = false): Promise<JsonObject> {
  const prepared = f.service.workLaunchPrepare({ launch_id: id, task_id: f.task.id, host: "codex-cli", workspace: f.root,
    prompt: "inspect", sandbox: "read-only", ...(acceptance ? { acceptance_name: "Done", acceptance_criteria: [{ id: "human", name: "Human review", method: "human", required: true }] } : {}) });
  const launch = prepared.launch as JsonObject; await f.service.hostRuns.wait(String(launch.run_id)); return launch;
}

test("task control pins one task boundary and materializes a deterministic delivery state", async () => {
  const f = await fixture();
  try {
    const saved = f.service.taskControlSave({ contract_id: "control", task_id: f.task.id, workspace: f.root,
      allowed_effects: ["read_only"], acceptance_required: false });
    const contract = saved.contract as JsonObject; assert.equal(saved.idempotent, false);
    assert.equal(f.service.taskControlSave({ contract_id: "control", task_id: f.task.id, workspace: f.root,
      allowed_effects: ["read_only"], acceptance_required: false }).idempotent, true);
    const before = f.service.taskControlRefresh({ contract_id: contract.id }).state as JsonObject;
    assert.deepEqual([before.status, before.action, before.actor], ["prepared", "prepare_work_launch", "human_or_host"]);
    const launch = await terminalLaunch(f, "launch");
    const bound = f.service.taskControlBindLaunch({ contract_id: contract.id, launch_id: launch.id });
    assert.equal(bound.idempotent, false); assert.equal(f.service.taskControlBindLaunch({ contract_id: contract.id, launch_id: launch.id }).idempotent, true);
    const state = f.service.taskControlRefresh({ contract_id: contract.id }).state as JsonObject;
    assert.deepEqual([state.status, state.action, state.actor], ["ready_for_delivery", "deliver", "human"]);
    assert.equal(f.service.taskControlRefresh({ contract_id: contract.id }).idempotent, true);
    const view = f.service.taskControlGet({ contract_id: contract.id });
    assert.equal((view.contract as JsonObject).launch_id, launch.id); assert.equal((view.delivery_loop as JsonObject).action, "deliver");
    const home = f.service.homeView({ limit: 10 });
    assert.equal(((home.task_controls as JsonObject[])[0]).action, "deliver");
    assert.equal(VERSION, "0.11.59");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("task control preserves approval and acceptance as explicit human actions", async () => {
  const f = await fixture();
  try {
    const contract = (f.service.taskControlSave({ task_id: f.task.id, workspace: f.root, allowed_effects: ["local_write"], acceptance_required: true }).contract as JsonObject);
    const write = f.service.workLaunchPrepare({ launch_id: "write", task_id: f.task.id, host: "codex-cli", workspace: f.root, prompt: "edit", sandbox: "workspace-write", acceptance_name: "Done", acceptance_criteria: [{ id: "human", name: "Human review", method: "human", required: true }] }).launch as JsonObject;
    f.service.taskControlBindLaunch({ contract_id: contract.id, launch_id: write.id });
    let state = f.service.taskControlRefresh({ contract_id: contract.id }).state as JsonObject;
    assert.deepEqual([state.status, state.action, state.actor], ["awaiting_approval", "review_work_launch", "human"]);
    const attention = f.service.attentionRefresh({ now: "2030-01-01T00:00:00Z" }).cards as JsonObject[];
    assert.ok(attention.some((item) => item.source_kind === "task_control_state" && item.action === "review_work_launch"));
    f.service.workLaunchDecide({ launch_id: write.id, actor: "user", approved: true, prompt: "edit" }); await f.service.hostRuns.wait(String((f.service.workLaunchGet({ launch_id: write.id }).launch as JsonObject).run_id));
    state = f.service.taskControlRefresh({ contract_id: contract.id }).state as JsonObject;
    assert.deepEqual([state.status, state.action], ["awaiting_acceptance", "collect_acceptance"]);
    f.service.acceptanceHumanReview({ plan_id: String(write.acceptance_plan_id), criterion_id: "human", reviewer: "user", result: "passed", summary: "confirmed" });
    state = f.service.taskControlRefresh({ contract_id: contract.id }).state as JsonObject;
    assert.equal(state.action, "deliver");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("task control fails closed on scope drift and creates content-free resumable handoffs", async () => {
  const f = await fixture();
  try {
    const profile = f.store.create("activation_profile", "profile", { task_id: f.task.id, allowed_effects: ["read_only"], status: "recommended" });
    const budget = f.store.create("budget_account", "budget", { owner_type: "task", owner_id: f.task.id, status: "active" });
    const contract = (f.service.taskControlSave({ contract_id: "guarded", task_id: f.task.id, workspace: f.root, allowed_effects: ["read_only"], acceptance_required: false,
      activation_profile_id: profile.id, activation_profile_version: profile.version, budget_account_id: budget.id, budget_account_version: budget.version }).contract as JsonObject);
    assert.throws(() => f.service.taskControlSave({ contract_id: "guarded", task_id: f.task.id, workspace: f.root, allowed_effects: ["local_write"] }), /conflict/);
    const wrongTask = f.service.taskOpen({ title: "Wrong", goal: "Wrong" }).task as JsonObject;
    const foreign = f.service.workLaunchPrepare({ task_id: wrongTask.id, host: "codex-cli", workspace: f.root, prompt: "read", sandbox: "read-only" }).launch as JsonObject;
    await f.service.hostRuns.wait(String(foreign.run_id));
    assert.throws(() => f.service.taskControlBindLaunch({ contract_id: contract.id, launch_id: foreign.id }), /does not match/);
    const wrongWorkspace = f.service.workLaunchPrepare({ task_id: f.task.id, host: "codex-cli", workspace: tmpdir(), prompt: "read", sandbox: "read-only" }).launch as JsonObject;
    await f.service.hostRuns.wait(String(wrongWorkspace.run_id));
    assert.throws(() => f.service.taskControlBindLaunch({ contract_id: contract.id, launch_id: wrongWorkspace.id }), /workspace/);
    const wrongEffect = f.service.workLaunchPrepare({ task_id: f.task.id, host: "codex-cli", workspace: f.root, prompt: "edit", sandbox: "workspace-write" }).launch as JsonObject;
    assert.throws(() => f.service.taskControlBindLaunch({ contract_id: contract.id, launch_id: wrongEffect.id }), /effect/);
    const failed = await terminalLaunch(f, "failed");
    f.store.save("host_run", String(failed.run_id), { ...f.store.get("host_run", String(failed.run_id)), status: "failed" });
    f.service.taskControlBindLaunch({ contract_id: contract.id, launch_id: failed.id });
    const recovery = f.service.taskControlRefresh({ contract_id: contract.id }).state as JsonObject;
    assert.deepEqual([recovery.status, recovery.action], ["recovery", "retry_or_handoff"]);
    const recoveryAttention = f.service.attentionRefresh({ now: "2030-01-01T00:00:00Z" }).cards as JsonObject[];
    assert.ok(recoveryAttention.some((item) => item.source_kind === "task_control_state" && item.action === "retry_or_handoff"));
    const handoff = f.service.taskControlHandoff({ handoff_id: "handoff", contract_id: contract.id, reason: "operator_handoff" });
    assert.equal((handoff.handoff as JsonObject).resume_action, "retry_or_handoff");
    assert.equal(JSON.stringify(handoff).includes("inspect"), false);
    assert.equal(f.service.taskControlHandoff({ handoff_id: "handoff", contract_id: contract.id, reason: "operator_handoff" }).idempotent, true);
    assert.throws(() => f.service.taskControlHandoff({ handoff_id: "handoff", contract_id: contract.id, reason: "user_pause" }), /conflict/);
    assert.throws(() => f.service.taskControlGet({ contract_id: " " }), /contract_id/);
    assert.throws(() => f.service.taskControlHandoff({ contract_id: contract.id, reason: "raw prompt" }), /unsupported/);
    const core = new McpServer(f.service, "core"); const full = new McpServer(f.service, "full");
    assert.ok(core.tools.some((item) => item.name === "craft_task_control_get")); assert.equal(core.tools.some((item) => item.name === "craft_task_control_bind_launch"), false);
    assert.equal(((await full.handlers.craft_task_control_get({ contract_id: contract.id })).state as JsonObject).action, "retry_or_handoff");
    assert.equal(((await full.handlers.craft_task_control_save({ contract_id: "mcp-control", task_id: f.task.id, workspace: f.root, allowed_effects: ["read_only"] })).contract as JsonObject).id, "mcp-control");
    assert.equal(((await full.handlers.craft_task_control_bind_launch({ contract_id: "mcp-control", launch_id: failed.id })).contract as JsonObject).launch_id, failed.id);
    assert.equal(((await full.handlers.craft_task_control_refresh({ contract_id: "mcp-control" })).state as JsonObject).action, "retry_or_handoff");
    assert.equal(((await full.handlers.craft_task_control_handoff({ contract_id: "mcp-control", reason: "recovery" })).handoff as JsonObject).resume_action, "retry_or_handoff");
    assert.equal(((await full.handle({ id: "bind", method: "tools/call", params: { name: "craft_task_control_bind_launch", arguments: { contract_id: contract.id, launch_id: failed.id } } }))?.result as JsonObject).isError, false);
    const app = new WorkbenchWebApp(f.service, "token", "http://127.0.0.1:4173");
    const workbenchContract = "workbench-control";
    assert.equal(app.handle({ method: "POST", path: "/api/task-controls", token: "token", body: JSON.stringify({ contract_id: workbenchContract, task_id: f.task.id, workspace: f.root, allowed_effects: ["read_only"], acceptance_required: false }) }).status, 201);
    assert.equal(app.handle({ method: "GET", path: `/api/task-controls/${workbenchContract}`, token: "token" }).status, 200);
    assert.equal(app.handle({ method: "POST", path: `/api/task-controls/${workbenchContract}/refresh`, token: "token", body: "{}" }).status, 200);
    assert.equal(app.handle({ method: "POST", path: `/api/task-controls/${workbenchContract}/bind-launch`, token: "token", body: JSON.stringify({ launch_id: failed.id }) }).status, 200);
    assert.equal(app.handle({ method: "POST", path: `/api/task-controls/${workbenchContract}/handoff`, token: "token", body: JSON.stringify({ handoff_id: "workbench-handoff", reason: "recovery" }) }).status, 201);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("task control rejects malformed pins and keeps every non-terminal control state explicit", async () => {
  const f = await fixture();
  try {
    assert.equal(((f.service.taskControlSave({ task_id: f.task.id, workspace: f.root }).contract as JsonObject).allowed_effects as string[])[0], "read_only");
    assert.throws(() => f.service.taskControlSave({ task_id: f.task.id, workspace: f.root, allowed_effects: "read_only" }), /array/);
    assert.throws(() => f.service.taskControlSave({ task_id: f.task.id, workspace: f.root, allowed_effects: [] }), /unsupported/);
    assert.throws(() => f.service.taskControlSave({ task_id: f.task.id, workspace: f.root, allowed_effects: ["read_only", "read_only"] }), /unsupported/);
    assert.throws(() => f.service.taskControlSave({ task_id: f.task.id, workspace: f.root, allowed_effects: ["unsafe"] }), /unsupported/);
    assert.throws(() => f.service.taskControlSave({ task_id: f.task.id, workspace: f.root, activation_profile_version: 1 }), /activation_profile_id/);
    const profile = f.store.create("activation_profile", "foreign-profile", { task_id: "foreign", allowed_effects: ["read_only"] });
    assert.throws(() => f.service.taskControlSave({ task_id: f.task.id, workspace: f.root, activation_profile_id: profile.id }), /does not match/);
    const tooBroad = f.store.create("activation_profile", "too-broad", { task_id: f.task.id, allowed_effects: ["local_write"] });
    assert.throws(() => f.service.taskControlSave({ task_id: f.task.id, workspace: f.root, allowed_effects: ["read_only"], activation_profile_id: tooBroad.id }), /exceeds/);
    const budget = f.store.create("budget_account", "foreign-budget", { owner_id: "foreign" });
    assert.throws(() => f.service.taskControlSave({ task_id: f.task.id, workspace: f.root, budget_account_id: budget.id }), /does not match/);
    assert.throws(() => f.service.taskControlSave({ task_id: f.task.id, workspace: f.root, activation_profile_id: tooBroad.id, activation_profile_version: 2 }), /version/);

    const required = (f.service.taskControlSave({ contract_id: "required", task_id: f.task.id, workspace: f.root, acceptance_required: true }).contract as JsonObject);
    const noAcceptance = f.service.workLaunchPrepare({ task_id: f.task.id, host: "codex-cli", workspace: f.root, prompt: "read", sandbox: "read-only" }).launch as JsonObject;
    await f.service.hostRuns.wait(String(noAcceptance.run_id));
    assert.throws(() => f.service.taskControlBindLaunch({ contract_id: required.id, launch_id: noAcceptance.id }), /requires an acceptance/);

    const denied = (f.service.taskControlSave({ contract_id: "denied", task_id: f.task.id, workspace: f.root, allowed_effects: ["local_write"] }).contract as JsonObject);
    const deniedLaunch = f.store.create("work_launch", "denied-launch", { task_id: f.task.id, workspace: f.root, sandbox: "workspace-write", status: "denied" });
    f.service.taskControlBindLaunch({ contract_id: denied.id, launch_id: deniedLaunch.id });
    assert.equal(((f.service.taskControlRefresh({ contract_id: denied.id }).state as JsonObject).action), "revise_contract_or_open_new_launch");
    const waiting = (f.service.taskControlSave({ contract_id: "waiting", task_id: f.task.id, workspace: f.root }).contract as JsonObject);
    f.store.create("work_launch", "waiting-launch", { task_id: f.task.id, workspace: f.root, sandbox: "read-only", status: "prepared" });
    f.service.taskControlBindLaunch({ contract_id: waiting.id, launch_id: "waiting-launch" });
    assert.equal(((f.service.taskControlRefresh({ contract_id: waiting.id }).state as JsonObject).action), "wait_for_host");
    f.store.create("work_launch", "unsupported-launch", { task_id: f.task.id, workspace: f.root, sandbox: "unsupported", status: "prepared" });
    assert.throws(() => f.service.taskControlBindLaunch({ contract_id: waiting.id, launch_id: "unsupported-launch" }), /effect/);

    const blocked = (f.service.taskControlSave({ contract_id: "blocked", task_id: f.task.id, workspace: f.root }).contract as JsonObject);
    f.store.create("host_run", "blocked-run", { status: "completed" }); f.store.create("work_launch", "blocked-launch", { task_id: f.task.id, workspace: f.root, sandbox: "read-only", status: "running", run_id: "blocked-run", acceptance_plan_id: "blocked-plan" }); f.store.create("acceptance_assessment", "assessment_blocked-plan", { status: "blocked" });
    f.service.taskControlBindLaunch({ contract_id: blocked.id, launch_id: "blocked-launch" });
    assert.equal(((f.service.taskControlRefresh({ contract_id: blocked.id }).state as JsonObject).action), "human_handoff");
    const cards = f.service.attentionRefresh({ now: "2030-01-01T00:00:00Z" }).cards as JsonObject[];
    assert.ok(cards.some((item) => item.source_kind === "task_control_state" && item.action === "human_handoff"));

    const mocked = (f.service.taskControlSave({ contract_id: "mocked", task_id: f.task.id, workspace: f.root }).contract as JsonObject);
    f.store.create("host_run", "mocked-run", { status: "completed" }); f.store.create("work_launch", "mocked-launch", { task_id: f.task.id, workspace: f.root, sandbox: "read-only", status: "running", run_id: "mocked-run" });
    f.service.taskControlBindLaunch({ contract_id: mocked.id, launch_id: "mocked-launch" });
    const original = f.service.taskControl.delivery.refresh.bind(f.service.taskControl.delivery);
    f.service.taskControl.delivery.refresh = () => ({ loop: { id: "unexpected", version: 1, action: "unexpected" }, idempotent: false });
    assert.equal(((f.service.taskControlRefresh({ contract_id: mocked.id }).state as JsonObject).action), "wait_for_host");
    f.service.taskControl.delivery.refresh = () => ({ loop: null, idempotent: false });
    assert.equal(((f.service.taskControlRefresh({ contract_id: mocked.id }).state as JsonObject).action), "wait_for_host");
    f.service.taskControl.delivery.refresh = original;
    f.store.create("work_launch", "other-write", { task_id: f.task.id, workspace: f.root, sandbox: "workspace-write", status: "awaiting_approval" });
    assert.throws(() => f.service.taskControlBindLaunch({ contract_id: denied.id, launch_id: "other-write" }), /another/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
