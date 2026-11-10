import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HostDriver } from "../core/host-driver.ts";
import { HostRunKernel } from "../core/host-run.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { McpServer } from "../core/mcp.ts";
import { TraceKernel } from "../core/trace-kernel.ts";

async function fixture(name: string) {
  const root = join(tmpdir(), `craft-host-run-${name}-${process.pid}-${Date.now()}`);
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  const task = service.taskOpen({ title: name, goal: "Manage a host run" }).task as JsonObject;
  return { root, store, service, task };
}

test("Host registration checks the current task owner under the registration lock", async () => {
  const f = await fixture("assignment-race");
  const other = await new CraftStore(craftPaths(f.root)).open();
  try {
    other.transaction(database => database.exec("PRAGMA busy_timeout=0"));
    const driver: HostDriver = { host: "sim", dispatchKind: "sim_dispatch", prepare: args => args,
      execute: async () => ({ receipt: { id: "receipt", cancelled: false, status: "completed" } }) };
    const kernel = new HostRunKernel(f.store, [driver]);
    f.store.create("sim_dispatch", "dispatch", { task_id: f.task.id, status: "prepared" });
    const assignmentId = `task_assignment_${f.task.id}`;
    f.store.create("task_assignment", assignmentId, { task_id: f.task.id, status: "active", owner: "new-owner" });
    assert.throws(() => kernel.start({ run_id: "old", host: "sim", dispatch_id: "dispatch", prompt: "go", actor: "old-owner" }), /only that owner/u);
    assert.equal(f.store.find("host_run", "old"), null);
    const find = f.store.find.bind(f.store); let checked = false;
    f.store.find = (kind, id, version) => {
      if (kind === "task_assignment" && id === assignmentId) {
        checked = true;
        assert.throws(() => other.save("task_assignment", assignmentId, { ...other.get("task_assignment", assignmentId), owner: "other-owner" }), /busy|locked/u);
      }
      return find(kind, id, version);
    };
    kernel.start({ run_id: "new", host: "sim", dispatch_id: "dispatch", prompt: "go", actor: "new-owner" });
    f.store.find = find;
    assert.equal(checked, true);
    await kernel.wait("new");
  } finally { other.close(); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("managed Host runs expose content-free progress and complete idempotently", async () => {
  const f = await fixture("complete");
  try {
    f.service.codexHost.executor = async (request) => {
      request.observe?.({ stream: "stdout", bytes: 12, digest: "sha256:a" });
      request.observe?.({ stream: "stderr", bytes: 3, digest: "sha256:b" });
      return { exitCode: 0, signal: null, stderr: "", timedOut: false, cancelled: false, outputLimited: false, stdout: `${JSON.stringify({ type: "turn.completed", usage: {} })}\n` };
    };
    f.service.codexDispatchPrepare({ dispatch_id: "dispatch", task_id: f.task.id, workspace: f.root, prompt: "inspect" });
    assert.throws(() => f.service.hostRunStart({ run_id: "invalid-prompt", host: "codex-cli", dispatch_id: "dispatch", prompt: "changed" }), /does not match/u);
    assert.equal(f.store.find("host_run", "invalid-prompt"), null);
    assert.equal(f.store.get("codex_dispatch", "dispatch").status, "prepared");
    const mcp = new McpServer(f.service, "full"); const started = await mcp.handlers.craft_host_run_start({ run_id: "run", host: "codex-cli", dispatch_id: "dispatch", prompt: "inspect" });
    assert.equal(started.idempotent, false);
    assert.equal(f.service.hostRunStart({ run_id: "run", host: "codex-cli", dispatch_id: "dispatch", prompt: "inspect" }).idempotent, true);
    assert.throws(() => f.service.hostRunStart({ run_id: "run", host: "codex-cli", dispatch_id: "dispatch", prompt: "changed" }), /does not match/u);
    assert.throws(() => f.service.hostRunStart({ run_id: "run", host: "claude-code", dispatch_id: "other", prompt: "inspect" }), /conflict/);
    await f.service.hostRuns.wait("run");
    const state = f.service.hostRunGet({ run_id: "run" }); const run = state.run as JsonObject; const events = state.events as JsonObject[];
    assert.equal(run.status, "completed"); assert.equal(run.event_count, 2); assert.equal(state.active, false);
    assert.deepEqual(events.map((event) => event.event_type), ["host.output", "host.output", "host.finished"]);
    assert.equal("content" in (events[0].payload as JsonObject), false);
    assert.equal(f.service.hostRunCancel({ run_id: "run", reason: "late" }).idempotent, true);
    f.service.codexHost.executor = async () => ({ exitCode: 1, signal: null, stdout: "", stderr: "failed", timedOut: false, cancelled: false, outputLimited: false });
    f.service.codexDispatchPrepare({ dispatch_id: "failed-dispatch", task_id: f.task.id, workspace: f.root, prompt: "fail" });
    f.service.hostRunStart({ run_id: "failed-run", host: "codex-cli", dispatch_id: "failed-dispatch", prompt: "fail" }); await f.service.hostRuns.wait("failed-run"); assert.equal(f.store.get("host_run", "failed-run").status, "failed");
    f.service.codexHost.executor = async () => ({ exitCode: 1, signal: "SIGTERM", stdout: "", stderr: "", timedOut: false, cancelled: true, outputLimited: false });
    f.service.codexDispatchPrepare({ dispatch_id: "cancelled-dispatch", task_id: f.task.id, workspace: f.root, prompt: "cancel" });
    f.service.hostRunStart({ run_id: "cancelled-run", host: "codex-cli", dispatch_id: "cancelled-dispatch", prompt: "cancel" }); await f.service.hostRuns.wait("cancelled-run"); assert.equal(f.store.get("host_run", "cancelled-run").status, "cancelled");
    await f.service.hostRuns.wait("not-active");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("managed Host cancellation persists even if this process does not own the runner", async () => {
  const f = await fixture("cancel");
  try {
    f.service.claudeHost.executor = (request) => new Promise((resolve) => {
      request.observe?.({ stream: "stdout", bytes: 1, digest: "sha256:c" });
      request.signal?.addEventListener("abort", () => resolve({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "", timedOut: false, cancelled: true, outputLimited: false }), { once: true });
    });
    f.service.claudeDispatchPrepare({ dispatch_id: "dispatch", task_id: f.task.id, workspace: f.root, prompt: "inspect" });
    const generated = f.service.hostRunStart({ host: "claude-code", dispatch_id: "dispatch", prompt: "inspect" }).run as JsonObject;
    assert.match(String(generated.id), /^host_run_[a-f0-9]{32}$/u);
    assert.throws(() => f.service.hostRunCancel({ run_id: generated.id, reason: " " }), /empty/);
    const mcp = new McpServer(f.service, "full"); assert.equal((await mcp.handlers.craft_host_run_get({ run_id: generated.id })).active, true);
    const cancelled = await mcp.handlers.craft_host_run_cancel({ run_id: generated.id, reason: "user_requested" }); assert.equal(cancelled.idempotent, false);
    await f.service.hostRuns.wait(String(generated.id));
    assert.equal((f.service.hostRunGet({ run_id: generated.id }).run as JsonObject).status, "cancelled");
    f.store.create("host_run", "orphan", { host: "codex-cli", dispatch_id: "missing", status: "running", cancel_requested: false });
    assert.equal(f.service.hostRunCancel({ run_id: "orphan", reason: "stop" }).idempotent, false);
    assert.equal(f.store.get("host_run", "orphan").cancel_requested, true);
    assert.equal(f.store.get("host_run", "orphan").status, "running");
    assert.equal(f.service.hostRunCancel({ run_id: "orphan", reason: "stop" }).idempotent, true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("rolled-back cancellation does not abort a Host, and a completed Host is not relabeled cancelled", async () => {
  const f = await fixture("cancel-rollback");
  try {
    let signal: AbortSignal | undefined;
    let finish!: (value: { exitCode: number; signal: null; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean; outputLimited: boolean }) => void;
    f.service.codexHost.executor = request => { signal = request.signal; return new Promise(resolve => { finish = resolve; }); };
    f.service.codexDispatchPrepare({ dispatch_id: "dispatch", task_id: f.task.id, workspace: f.root, prompt: "inspect" });
    const run = f.service.hostRunStart({ run_id: "rollback-run", host: "codex-cli", dispatch_id: "dispatch", prompt: "inspect" }).run as JsonObject;
    assert.throws(() => f.store.transaction(() => { f.service.hostRunCancel({ run_id: run.id, reason: "stop" }); throw new Error("rollback"); }), /rollback/u);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(signal?.aborted, false);
    assert.equal(f.store.get("host_run", String(run.id)).cancel_requested, false);
    f.service.hostRunCancel({ run_id: run.id, reason: "stop" });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(signal?.aborted, true);
    finish({ exitCode: 0, signal: null, stdout: `${JSON.stringify({ type: "turn.completed", usage: {} })}\n`, stderr: "", timedOut: false, cancelled: false, outputLimited: false });
    await f.service.hostRuns.wait(String(run.id));
    assert.equal(f.store.get("host_run", String(run.id)).status, "completed");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("output and cancellation serialize across database connections", async () => {
  const f = await fixture("cancel-output-race");
  const otherStore = await new CraftStore(craftPaths(f.root)).open();
  try {
    otherStore.transaction(database => database.exec("PRAGMA busy_timeout=0"));
    let observe!: NonNullable<Parameters<HostDriver["execute"]>[1]>["observe"];
    const driver: HostDriver = { host: "sim", dispatchKind: "sim_dispatch", prepare: args => args,
      execute: async (_args, options) => new Promise(resolve => {
        observe = options?.observe;
        options?.signal?.addEventListener("abort", () => resolve({ receipt: { id: "receipt", cancelled: true } }), { once: true });
      }) };
    f.store.create("sim_dispatch", "dispatch", { task_id: f.task.id, status: "prepared" });
    const owner = new HostRunKernel(f.store, [driver]);
    const remote = new HostRunKernel(otherStore, []);
    owner.start({ run_id: "race-run", host: "sim", dispatch_id: "dispatch", prompt: "go" });
    const get = f.store.get.bind(f.store);
    let collided = false;
    f.store.get = (kind, id, version) => {
      if (kind === "host_run" && id === "race-run" && !collided) {
        collided = true;
        assert.throws(() => remote.cancel({ run_id: id, reason: "stop" }), /busy|locked/u);
      }
      return get(kind, id, version);
    };
    observe!({ stream: "stdout", bytes: 2, digest: "sha256:xx" });
    f.store.get = get;
    assert.equal(collided, true);
    assert.equal(f.store.get("host_run", "race-run").event_count, 1);
    remote.cancel({ run_id: "race-run", reason: "stop" });
    await Promise.race([owner.wait("race-run"), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000))]);
    const run = f.store.get("host_run", "race-run");
    assert.equal(run.event_count, 1);
    assert.equal(run.cancel_requested, true);
    assert.equal(run.status, "cancelled");
  } finally { otherStore.close(); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("one dispatch cannot acquire two Host runs even before its driver marks it running", async () => {
  const f = await fixture("unique-dispatch");
  const otherStore = await new CraftStore(craftPaths(f.root)).open();
  try {
    let executions = 0;
    let finish!: (value: JsonObject) => void;
    const driver: HostDriver = { host: "sim", dispatchKind: "sim_dispatch", prepare: args => args,
      execute: async () => { executions++; return new Promise(resolve => { finish = resolve; }); } };
    f.store.create("sim_dispatch", "unique", { task_id: f.task.id, status: "prepared" });
    const owner = new HostRunKernel(f.store, [driver]);
    const other = new HostRunKernel(otherStore, [driver]);
    owner.start({ run_id: "first", host: "sim", dispatch_id: "unique", prompt: "go" });
    assert.equal(other.start({ run_id: "first", host: "sim", dispatch_id: "unique", prompt: "go" }).idempotent, true);
    assert.throws(() => other.start({ run_id: "second", host: "sim", dispatch_id: "unique", prompt: "go" }), /already has a run/u);
    assert.equal(executions, 1);
    finish({ receipt: { id: "receipt", status: "completed", cancelled: false } });
    await owner.wait("first");
    assert.throws(() => other.start({ run_id: "third", host: "sim", dispatch_id: "unique", prompt: "go" }), /already has a run/u);
    assert.equal(executions, 1);
  } finally { otherStore.close(); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Host run recovery is explicit and failures remain attributable", async () => {
  const f = await fixture("recovery");
  try {
    const rejecting: HostDriver = { host: "codex-cli", dispatchKind: "codex_dispatch", prepare: (args) => args, execute: async (_args, options) => new Promise((_resolve, reject) => { options?.signal?.addEventListener("abort", () => reject(new Error("driver crash")), { once: true }); }) };
    const unknown: HostDriver = { host: "claude-code", dispatchKind: "claude_dispatch", prepare: (args) => args, execute: async () => { throw "driver crash"; } };
    let projections = 0; const kernel = new HostRunKernel(f.store, [rejecting, unknown], undefined, () => { projections += 1; if (projections === 1) throw new Error("projection failed"); throw "projection failed"; }, new TraceKernel(f.store));
    f.store.create("codex_dispatch", "crash", { task_id: f.task.id, status: "prepared" });
    f.store.create("claude_dispatch", "unknown", { task_id: f.task.id, status: "prepared" });
    kernel.start({ run_id: "crash-run", host: "codex-cli", dispatch_id: "crash", prompt: "go" });
    kernel.start({ run_id: "unknown-run", host: "claude-code", dispatch_id: "unknown", prompt: "go" });
    assert.equal(kernel.recover({ owner_id: kernel.ownerId, confirmed_original_runner_stopped: true }).count, 0); kernel.cancel({ run_id: "crash-run", reason: "cancel crash" });
    await Promise.all([kernel.wait("crash-run"), kernel.wait("unknown-run")]);
    assert.equal(f.store.get("host_run", "crash-run").status, "interrupted"); assert.equal(f.store.get("host_run", "crash-run").error_class, "Error"); assert.equal(f.store.get("host_run", "unknown-run").error_class, "UnknownError");
    assert.equal(f.store.events("host-run:crash-run").some((event) => event.event_type === "host.projection_failed"), true); assert.equal(f.store.events("host-run:unknown-run").some((event) => event.event_type === "host.projection_failed"), true);
    const unobserved = new HostRunKernel(f.store, [unknown]); f.store.create("claude_dispatch", "unobserved", { task_id: f.task.id, status: "prepared" }); unobserved.start({ run_id: "unobserved-run", host: "claude-code", dispatch_id: "unobserved", prompt: "go" }); await unobserved.wait("unobserved-run"); assert.equal(f.store.events("host-run:unobserved-run").length, 0);
    assert.throws(() => kernel.start({ host: "missing", dispatch_id: "x", prompt: "x" }), /unavailable/);
    f.store.create("codex_dispatch", "used", { task_id: f.task.id, status: "running" });
    assert.throws(() => kernel.start({ host: "codex-cli", dispatch_id: "used", prompt: "x" }), /prepared/);
    f.store.create("host_run", "orphan-running", { owner_id: "old-runner", status: "running", cancel_requested: false });
    f.store.create("host_run", "orphan-cancel", { owner_id: "old-runner", status: "cancel_requested", cancel_requested: true });
    f.store.create("host_run", "other-owner", { owner_id: "other-runner", status: "running", cancel_requested: false });
    assert.throws(() => kernel.recover({}), /confirmed/);
    assert.throws(() => kernel.recover({ confirmed_original_runner_stopped: true }), /owner_id/);
    const mcp = new McpServer(f.service, "full"); await assert.rejects(async () => mcp.handlers.craft_host_run_recover({ owner_id: "old-runner", confirmed_original_runner_stopped: false }), /confirmed/);
    const recovered = await mcp.handlers.craft_host_run_recover({ owner_id: "old-runner", confirmed_original_runner_stopped: true }); assert.equal(recovered.count, 2);
    assert.equal(f.store.get("host_run", "orphan-running").status, "interrupted");
    assert.equal(f.store.get("host_run", "other-owner").status, "running"); assert.equal(kernel.recover({ owner_id: "old-runner", confirmed_original_runner_stopped: true }).count, 0);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
