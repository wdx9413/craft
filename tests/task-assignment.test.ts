import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";
import { WorkbenchWebApp } from "../core/workbench-server.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-task-assignment-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  let calls = 0;
  service.codexHost.executor = async () => { calls++; throw new Error("simulated failure"); };
  const task = service.taskOpen({ title: "Handoff", goal: "preserve responsibility" }).task as JsonObject;
  const contract = service.taskControlSave({ task_id: task.id, workspace: root, allowed_effects: ["read_only"] }).contract as JsonObject;
  const prepared = service.taskRunPrepare({ task_run_id: "source", contract_id: contract.id, host: "codex-cli", prompt: "inspect" });
  const launch = prepared.launch as JsonObject;
  await service.hostRuns.wait(String(launch.run_id));
  const snapshot = () => service.taskRunHandoff({ task_run_id: "source", reason: "handoff current state" }).handoff as JsonObject;
  const handoff = snapshot();
  const request = { task_run_id: "source", action: "claim", actor: "user:alpha", reason: "take responsibility", request_id: "claim-alpha", assignment_version: 0, handoff_id: handoff.id, handoff_version: handoff.version };
  return { root, store, service, task, launch, snapshot, request, calls: () => calls };
}

test("HTTP claim, guarded continuation, MCP transfer and release preserve responsibility without granting completion", async (t) => {
  const f = await fixture();
  try {
    const before = f.store.get("task_run", "source");
    const shownHandoff = (f.service.homeTask({ task_id: f.task.id }).task_handoffs as JsonObject[]).find(item => item.id === f.request.handoff_id)!;
    assert.equal(shownHandoff.version, f.request.handoff_version);
    const web = new WorkbenchWebApp(f.service, "token", "http://127.0.0.1:4173");
    const response = web.handle({ method: "POST", path: "/api/task-runs/source/assignment", token: "token", origin: "http://127.0.0.1:4173", body: JSON.stringify({ ...f.request, task_run_id: "wrong-body-run" }) });
    assert.equal(response.status, 200);
    let assignment = f.store.get("task_assignment", `task_assignment_${f.task.id}`);
    assert.equal(assignment.owner, "user:alpha");
    assert.equal(assignment.status, "active");
    assert.equal(f.calls(), 1);
    assert.throws(() => f.service.taskRunAssignment({ ...f.request, action: "transfer", recipient: "user:beta", assignment_version: assignment.version, request_id: "stale-owner-reference" }), /assignment is stale/);
    assert.deepEqual(f.store.get("task_run", "source"), before);
    const mcp = new McpServer(f.service, "full");
    assert.equal((await mcp.handlers.craft_task_run_assignment(f.request) as JsonObject).idempotent, true);
    assert.throws(() => f.service.taskRunAssignment({ ...f.request, actor: "user:beta" }), /idempotency conflict/);
    assert.throws(() => f.service.taskRunAssignment({ ...f.request, request_id: "competing", assignment_version: assignment.version, actor: "user:beta" }), /active owner/);
    for (const action of ["pause", "resume", "cancel"] as const) {
      const args = { task_run_id: "source", reason: "other operator", actor: "user:beta" };
      const invoke = { pause: () => f.service.taskRunPause(args), resume: () => f.service.taskRunResume(args), cancel: () => f.service.taskRunCancel(args) };
      assert.throws(invoke[action], /active owner/);
    }
    const retryArgs = { task_run_id: "source", task_run_version: before.version, launch_version: f.store.get("work_launch", String(f.launch.id)).version, host_run_version: f.store.get("host_run", String(f.launch.run_id)).version, new_task_run_id: "continued", prompt: "repair", actor: "user:alpha" };
    assert.throws(() => f.service.taskRunRetry({ ...retryArgs, actor: "user:beta" }), /active owner/);
    assert.throws(() => f.service.workLaunchRetry({ launch_id: f.launch.id, prompt: "bypass owner" }), /active owner/);
    const next = f.service.taskRunRetry(retryArgs).launch as JsonObject;
    await f.service.hostRuns.wait(String(next.run_id));
    assert.equal(f.calls(), 2);
    assert.equal((f.service.homeTask({ task_id: f.task.id }).task_assignment as JsonObject).owner, "user:alpha");
    const fresh = f.service.taskRunHandoff({ task_run_id: "continued", reason: "transfer current attempt" }).handoff as JsonObject;
    assert.equal((fresh.assignment_ref as JsonObject).owner, "user:alpha");
    const transfer = { task_run_id: "continued", action: "transfer", actor: "user:alpha", recipient: "user:beta", assignment_version: assignment.version, handoff_id: fresh.id, handoff_version: fresh.version, reason: "operator switch", request_id: "transfer-beta" };
    assignment = (await mcp.handlers.craft_task_run_assignment(transfer) as JsonObject).assignment as JsonObject;
    assert.equal(assignment.owner, "user:beta");
    assert.equal(f.calls(), 2);
    assert.throws(() => f.service.taskRunPause({ task_run_id: "continued", reason: "old owner", actor: "user:alpha" }), /active owner/);
    const release = { task_run_id: "continued", action: "release", actor: "user:beta", assignment_version: assignment.version, reason: "handoff later", request_id: "release-beta" };
    const originalAppend = f.store.appendEvent.bind(f.store);
    const fault = t.mock.method(f.store, "appendEvent", (...args: Parameters<typeof f.store.appendEvent>) => { originalAppend(...args); throw new Error("simulated assignment event failure"); });
    assert.throws(() => f.service.taskRunAssignment(release), /event failure/);
    fault.mock.restore();
    assert.deepEqual(f.store.get("task_assignment", String(assignment.id)), assignment);
    assert.equal(f.store.find("task_assignment_action", "task_assignment_action_release-beta"), null);
    const released = f.service.taskRunAssignment(release).assignment as JsonObject;
    assert.equal(released.status, "released");
    assert.equal((f.service.taskRunAssignment(f.request).assignment as JsonObject).status, "released");
    assert.equal(f.store.events(`task:${f.task.id}`).filter(event => event.event_type === "task.assignment_claim").length, 1);
    const releasedSnapshot = f.service.taskRunHandoff({ task_run_id: "continued", reason: "new owner after release" }).handoff as JsonObject;
    const claimedAgain = f.service.taskRunAssignment({ ...f.request, task_run_id: "continued", handoff_id: releasedSnapshot.id, handoff_version: releasedSnapshot.version, assignment_version: released.version, actor: "user:gamma", request_id: "claim-gamma" }).assignment as JsonObject;
    assert.equal(claimedAgain.owner, "user:gamma");
    assert.equal(f.calls(), 2);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("assignment rejects invalid requests, stale handoffs, live work and owner/version conflicts", async () => {
  const f = await fixture();
  try {
    for (const patch of [{ request_id: "bad/id" }, { request_id: "a".repeat(129) }, { actor: " " }, { reason: "" }, { action: "finish" }, { assignment_version: -1 }, { assignment_version: "0" }, { assignment_version: 0.5 }, { assignment_version: 1 }, { handoff_version: "1" }, { handoff_version: 999 }, { action: "transfer", recipient: "user:alpha" }, { action: "release" }]) assert.throws(() => f.service.taskRunAssignment({ ...f.request, ...patch }));
    const other = f.service.taskRunPrepare({ task_run_id: "other", contract_id: (f.service.taskControlSave({ contract_id: "other-control", task_id: f.task.id, workspace: f.root, allowed_effects: ["read_only"] }).contract as JsonObject).id, host: "codex-cli", prompt: "other" }).launch as JsonObject;
    await f.service.hostRuns.wait(String(other.run_id));
    assert.throws(() => f.service.taskRunAssignment({ ...f.request, task_run_id: "other" }), /does not match/);
    const oldRun = f.store.get("task_run", "source");
    f.service.taskRunPause({ task_run_id: "source", reason: "changed" });
    assert.throws(() => f.service.taskRunAssignment(f.request), /stale/);
    f.service.taskRunResume({ task_run_id: "source" });
    let handoff = f.snapshot();
    const currentRequest = () => ({ ...f.request, handoff_id: handoff.id, handoff_version: handoff.version });
    const task = f.store.get("task", String(f.task.id));
    f.store.save("task", String(task.id), { ...task, goal: "changed goal" });
    assert.throws(() => f.service.taskRunAssignment(currentRequest()), /stale/);
    handoff = f.snapshot();
    const host = f.store.get("host_run", String(f.launch.run_id));
    f.store.save("host_run", String(host.id), { ...host, status: "running" });
    handoff = f.snapshot();
    assert.throws(() => f.service.taskRunAssignment(currentRequest()), /still active/);
    f.store.save("host_run", String(host.id), { ...host, status: "failed" });
    handoff = f.snapshot();
    f.service.taskRunCancel({ task_run_id: oldRun.id, reason: "cancelled" });
    handoff = f.snapshot();
    assert.throws(() => f.service.taskRunAssignment(currentRequest()), /stale/);
    assert.equal(f.store.list("task_assignment", 100).length, 0);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("assignment is shared across services and write approval remains separate from claiming", async () => {
  const f = await fixture();
  const otherStore = await new CraftStore(craftPaths(f.root)).open();
  try {
    const other = new CraftService(otherStore);
    const assignment = f.service.taskRunAssignment(f.request).assignment as JsonObject;
    assert.throws(() => other.taskRunAssignment({ ...f.request, request_id: "second-service", actor: "user:beta" }), /version changed/);
    assert.throws(() => other.taskRunAssignment({ ...f.request, request_id: "second-service", actor: "user:beta", assignment_version: assignment.version }), /active owner/);
    assert.equal((other.taskRunGet({ task_run_id: "source" }).assignment as JsonObject).owner, "user:alpha");
    const input = { task_id: f.task.id, host: "codex-cli", workspace: f.root, prompt: "edit", sandbox: "workspace-write", launch_id: "write-continuation" };
    assert.throws(() => f.service.workLaunchPrepare(input), /active owner/);
    const pending = f.service.workLaunchPrepare({ ...input, actor: "user:alpha" }).launch as JsonObject;
    assert.equal(pending.status, "awaiting_approval");
    assert.throws(() => f.service.hostRunStart({ host: "codex-cli", dispatch_id: pending.dispatch_id, prompt: "edit", actor: "user:beta" }), /active owner/);
    assert.equal(f.calls(), 1);
    assert.throws(() => f.service.workLaunchDecide({ launch_id: pending.id, actor: "user:beta", approved: true, prompt: "edit" }), /active owner/);
    assert.equal(f.calls(), 1);
    const approved = f.service.workLaunchDecide({ launch_id: pending.id, actor: "user:alpha", approved: true, prompt: "edit" }).launch as JsonObject;
    await f.service.hostRuns.wait(String(approved.run_id));
    assert.equal(f.calls(), 2);
    assert.equal((f.service.taskRunGet({ task_run_id: "source" }).assignment as JsonObject).owner, "user:alpha");
  } finally { otherStore.close(); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
