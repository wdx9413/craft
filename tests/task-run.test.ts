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
  const root = await mkdtemp(join(tmpdir(), "craft-task-run-")); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  service.codexHost.executor = async () => ({ exitCode: 0, signal: null, stderr: "", timedOut: false, cancelled: false, outputLimited: false, stdout: `${JSON.stringify({ type: "turn.completed", usage: {} })}\n` });
  const task = service.taskOpen({ title: "Run", goal: "Complete one controlled task" }).task as JsonObject;
  return { root, store, service, task };
}

function contract(f: Awaited<ReturnType<typeof fixture>>, id: string, effect = "read_only", acceptance = false): JsonObject {
  return f.service.taskControlSave({ contract_id: id, task_id: f.task.id, workspace: f.root, allowed_effects: [effect], acceptance_required: acceptance }).contract as JsonObject;
}

test("Task Run binds a real read-only launch, persists only digests, and safely pauses, resumes, hands off, and cancels", async () => {
  const f = await fixture();
  try {
    const control = contract(f, "read");
    const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "read-run", host: "codex-cli", workspace: f.root, prompt: "inspect private business data", sandbox: "read-only", environment: { image: "same" }, budget: { usd: 1 } });
    const taskRun = prepared.task_run as JsonObject; const launch = prepared.launch as JsonObject; assert.equal((f.service.taskRunRefresh({ task_run_id: taskRun.id }).state as JsonObject).action, "wait_for_host"); await f.service.hostRuns.wait(String(launch.run_id));
    assert.equal(f.service.taskRuns.create({ task_run_id: taskRun.id, contract_id: control.id, launch_id: launch.id, environment: { image: "same" }, budget: { usd: 1 } }).idempotent, true);
    assert.equal((f.service.taskRunGet({ task_run_id: taskRun.id }).run as JsonObject).id, taskRun.id);
    const ready = f.service.taskRunRefresh({ task_run_id: taskRun.id, environment: { image: "same" }, budget: { usd: 1 } }).state as JsonObject;
    assert.deepEqual([ready.status, ready.action], ["ready_for_delivery", "deliver"]); assert.equal(JSON.stringify(taskRun).includes("private business data"), false);
    const paused = f.service.taskRunPause({ task_run_id: taskRun.id, reason: "user" }).run as JsonObject; assert.equal(paused.lifecycle, "paused"); assert.equal((f.service.taskRunRefresh({ task_run_id: taskRun.id }).state as JsonObject).action, "resume_or_handoff");
    assert.equal(f.service.taskRunPause({ task_run_id: taskRun.id, reason: "user" }).idempotent, true);
    assert.equal(f.service.taskRunResume({ task_run_id: taskRun.id, environment: { image: "same" }, budget: { usd: 1 } }).idempotent, false);
    assert.equal(f.service.taskRunResume({ task_run_id: taskRun.id }).idempotent, true);
    const handoff = f.service.taskRunHandoff({ task_run_id: taskRun.id, handoff_id: "handoff", reason: "review" }).handoff as JsonObject; assert.equal(handoff.resume_action, "deliver"); assert.equal(f.service.taskRunHandoff({ task_run_id: taskRun.id, handoff_id: "handoff", reason: "review" }).idempotent, true); assert.throws(() => f.service.taskRunHandoff({ task_run_id: taskRun.id, handoff_id: "handoff", reason: "different" }), /conflict/);
    assert.equal(JSON.stringify(handoff).includes("private business data"), false);
    assert.equal((f.service.taskRunCancel({ task_run_id: taskRun.id, reason: "done" }).run as JsonObject).lifecycle, "cancelled"); assert.equal(f.service.taskRunCancel({ task_run_id: taskRun.id, reason: "done" }).idempotent, true);
    assert.equal((f.service.taskRunRefresh({ task_run_id: taskRun.id }).state as JsonObject).status, "cancelled"); assert.throws(() => f.service.taskRunPause({ task_run_id: taskRun.id, reason: "again" }), /Cancelled/); assert.throws(() => f.service.taskRunResume({ task_run_id: taskRun.id }), /Cancelled/);
    assert.throws(() => f.service.taskRunGet({ task_run_id: "" }), /task_run_id/);
    assert.equal(VERSION, "0.11.56");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Task Run keeps approval, acceptance, recovery, and input drift explicit and MCP splits core from full controls", async () => {
  const f = await fixture();
  try {
    const control = contract(f, "write", "local_write", true);
    const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "write-run", host: "codex-cli", workspace: f.root, prompt: "edit", sandbox: "workspace-write", environment: { image: "same" }, budget: { usd: 1 }, acceptance_name: "review", acceptance_criteria: [{ id: "human", name: "Human", method: "human", required: true }] });
    const taskRun = prepared.task_run as JsonObject; const launch = prepared.launch as JsonObject;
    assert.equal((f.service.taskRunRefresh({ task_run_id: taskRun.id }).state as JsonObject).action, "review_work_launch");
    assert.equal((f.service.taskRunRefresh({ task_run_id: taskRun.id, environment: { image: "drift" } }).state as JsonObject).action, "revalidate_inputs");
    f.service.workLaunchDecide({ launch_id: launch.id, actor: "user", approved: true, prompt: "edit" }); await f.service.hostRuns.wait(String((f.service.workLaunchGet({ launch_id: launch.id }).launch as JsonObject).run_id));
    assert.equal((f.service.taskRunRefresh({ task_run_id: taskRun.id }).state as JsonObject).action, "collect_acceptance");
    f.service.acceptanceHumanReview({ plan_id: String(launch.acceptance_plan_id), criterion_id: "human", reviewer: "user", result: "passed", summary: "checked" }); assert.equal((f.service.taskRunRefresh({ task_run_id: taskRun.id }).state as JsonObject).action, "deliver");
    const failedControl = contract(f, "failed"); const failed = f.service.taskRunPrepare({ contract_id: failedControl.id, task_run_id: "failed-run", host: "codex-cli", workspace: f.root, prompt: "read", sandbox: "read-only" }); const failedLaunch = failed.launch as JsonObject; await f.service.hostRuns.wait(String(failedLaunch.run_id));
    const host = f.store.get("host_run", String(failedLaunch.run_id)); const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...hostPayload } = host; f.store.save("host_run", String(host.id), { ...hostPayload, status: "failed" }); f.service.deliveryLoopRefresh({ launch_id: failedLaunch.id });
    assert.equal((f.service.taskRunRefresh({ task_run_id: "failed-run" }).state as JsonObject).action, "retry_or_handoff");
    const blockedControl = contract(f, "blocked"); const blocked = f.service.taskRunPrepare({ contract_id: blockedControl.id, task_run_id: "blocked-run", host: "codex-cli", workspace: f.root, prompt: "read", sandbox: "read-only", acceptance_name: "review", acceptance_criteria: [{ id: "human", name: "Human", method: "human", required: true }] }); const blockedLaunch = blocked.launch as JsonObject; await f.service.hostRuns.wait(String(blockedLaunch.run_id)); f.store.save("acceptance_assessment", `assessment_${blockedLaunch.acceptance_plan_id}`, { plan_id: blockedLaunch.acceptance_plan_id, status: "blocked" });
    f.service.deliveryLoopRefresh({ launch_id: blockedLaunch.id }); assert.equal((f.service.taskRunRefresh({ task_run_id: "blocked-run" }).state as JsonObject).action, "human_handoff");
    const core = new McpServer(f.service, "core"); const full = new McpServer(f.service, "full"); assert.ok(core.tools.some((item) => item.name === "craft_task_run_get")); assert.equal(core.tools.some((item) => item.name === "craft_task_run_prepare"), false); assert.ok(full.tools.some((item) => item.name === "craft_task_run_prepare")); assert.equal(((await full.handlers.craft_task_run_get({ task_run_id: taskRun.id })).run as JsonObject).id, taskRun.id);
    const mcpControl = contract(f, "mcp", "local_write"); assert.ok(((await full.handlers.craft_task_run_prepare({ contract_id: mcpControl.id, host: "codex-cli", workspace: f.root, prompt: "edit", sandbox: "workspace-write" })).task_run as JsonObject).id);
    await full.handlers.craft_task_run_refresh({ task_run_id: taskRun.id }); await full.handlers.craft_task_run_pause({ task_run_id: taskRun.id, reason: "mcp" }); await full.handlers.craft_task_run_resume({ task_run_id: taskRun.id }); await full.handlers.craft_task_run_handoff({ task_run_id: taskRun.id, reason: "mcp" });
    const app = new WorkbenchWebApp(f.service, "token", "http://127.0.0.1:4173"); const request = (method: string, path: string, body?: JsonObject) => app.handle({ method, path, token: "token", origin: "http://127.0.0.1:4173", body: body ? JSON.stringify(body) : undefined }); const webControl = contract(f, "web", "local_write"); assert.equal(request("POST", "/api/task-runs", { contract_id: webControl.id, host: "codex-cli", workspace: f.root, prompt: "edit", sandbox: "workspace-write" }).status, 201);
    assert.equal(request("GET", `/api/task-runs/${taskRun.id}`).status, 200); assert.equal(request("POST", `/api/task-runs/${taskRun.id}/refresh`).status, 200); assert.equal(request("POST", `/api/task-runs/${taskRun.id}/pause`, { reason: "ui" }).status, 200); assert.equal(request("POST", `/api/task-runs/${taskRun.id}/resume`).status, 200); assert.equal(request("POST", `/api/task-runs/${taskRun.id}/handoff`, { reason: "ui" }).status, 201); assert.equal(request("POST", `/api/task-runs/${taskRun.id}/cancel`, { reason: "ui" }).status, 200); await full.handlers.craft_task_run_cancel({ task_run_id: taskRun.id, reason: "mcp" });
    const liveControl = contract(f, "live"); const live = f.service.taskRunPrepare({ contract_id: liveControl.id, task_run_id: "live-run", host: "codex-cli", workspace: f.root, prompt: "read", sandbox: "read-only" }); const liveLaunch = live.launch as JsonObject; assert.equal((f.service.taskRunCancel({ task_run_id: "live-run", reason: "stop" }).run as JsonObject).lifecycle, "cancelled"); await f.service.hostRuns.wait(String(liveLaunch.run_id));
    assert.throws(() => f.service.taskRunPrepare({ contract_id: control.id, host: "codex-cli", workspace: f.root, prompt: "again" }), /already bound/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Task Run fails closed for an invalid bound identity and keeps null Host observations explicit", async () => {
  const f = await fixture();
  try {
    const rawLaunch = (id: string, host: string, dispatchId: string) => f.store.create("work_launch", id, { task_id: f.task.id, host, dispatch_id: dispatchId, workspace: f.root, sandbox: "read-only", prompt_digest: "sha256:prompt" });
    rawLaunch("inactive-launch", "codex-cli", "missing"); f.store.create("task_control_contract", "inactive", { task_id: f.task.id, launch_id: "inactive-launch", status: "inactive" }); assert.throws(() => f.service.taskRuns.create({ contract_id: "inactive", launch_id: "inactive-launch" }), /active/);
    rawLaunch("unsupported-launch", "other", "missing"); f.store.create("task_control_contract", "unsupported", { task_id: f.task.id, launch_id: "unsupported-launch", status: "active" }); assert.throws(() => f.service.taskRuns.create({ contract_id: "unsupported", launch_id: "unsupported-launch" }), /unsupported/);
    f.store.create("codex_dispatch", "raw-dispatch", { request_digest: "sha256:request" }); rawLaunch("raw-launch", "codex-cli", "raw-dispatch"); f.store.create("task_control_contract", "raw", { task_id: f.task.id, launch_id: "raw-launch", status: "active" }); const run = f.service.taskRuns.create({ task_run_id: "raw-run", contract_id: "raw", launch_id: "raw-launch" }).run as JsonObject; assert.throws(() => f.service.taskRuns.create({ task_run_id: run.id, contract_id: "raw", launch_id: "raw-launch", budget: { usd: 2 } }), /conflict/); assert.equal((f.service.taskRunRefresh({ task_run_id: run.id }).state as JsonObject).action, "wait_for_host");
    f.store.create("host_run", "terminal", { status: "completed" }); const current = f.store.get("work_launch", "raw-launch"); const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...launchPayload } = current; f.store.save("work_launch", "raw-launch", { ...launchPayload, run_id: "terminal" }); assert.equal((f.service.taskRunRefresh({ task_run_id: run.id }).state as JsonObject).action, "human_handoff");
    f.store.create("claude_dispatch", "claude-dispatch", { request_digest: "sha256:claude" }); rawLaunch("claude-launch", "claude-code", "claude-dispatch"); f.store.create("task_control_contract", "claude", { task_id: f.task.id, launch_id: "claude-launch", status: "active" }); assert.match(String((f.service.taskRuns.create({ contract_id: "claude", launch_id: "claude-launch" }).run as JsonObject).id), /^task_run_/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
