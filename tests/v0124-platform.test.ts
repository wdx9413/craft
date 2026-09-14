import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AutonomousRuntimeKernel } from "../src/autonomous-runtime.ts";
import { CapabilityLifecycleKernel } from "../src/capability-lifecycle.ts";
import { MemoryConsolidationKernel } from "../src/memory-consolidation.ts";
import { PlatformOperationsKernel } from "../src/platform-operations.ts";
import { RemoteInteropKernel } from "../src/remote-interop.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { McpServer } from "../src/mcp.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-v0124-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  return { root, store };
}

test("v0.12.4 bounded autonomous runtime executes, checkpoints, resumes, and cancels", async () => {
  const f = await fixture();
  try {
    const kernel = new AutonomousRuntimeKernel(f.store);
    f.store.create("task", "task", { title: "Task", goal: "Goal" });
    assert.throws(() => kernel.prepare({ task_id: 1 as never, goal: "Goal", model: "m" }), /task_id/);
    assert.throws(() => kernel.prepare({ task_id: "task", goal: " ", model: "m" }), /goal/);
    assert.throws(() => kernel.prepare({ task_id: "task", goal: "Goal", model: "m", limits: { max_steps: 0 } }), /max_steps/);
    assert.throws(() => kernel.prepare({ task_id: "task", goal: "Goal", model: "m", limits: { max_tokens: 0 } }), /max_tokens/);
    kernel.prepare({ run_id: "defaults", task_id: "task", goal: "Goal", model: "m", limits: [] });
    const prepared = kernel.prepare({ run_id: "run", task_id: "task", goal: "Goal", model: "m" });
    assert.equal(kernel.prepare({ run_id: "run", task_id: "task", goal: "Goal", model: "m" }).idempotent, true);
    assert.throws(() => kernel.prepare({ run_id: "run", task_id: "task", goal: "Other", model: "m" }), /conflict/);
    const readyResume = kernel.prepare({ run_id: "ready-resume", task_id: "task", goal: "Goal", model: "m" });
    assert.equal((kernel.resume({ run_id: String((readyResume.run as JsonObject).id) }).run as JsonObject).status, "running");
    assert.throws(() => kernel.checkpoint({ run_id: "run", state: [] }), /state/);
    assert.throws(() => kernel.checkpoint({ run_id: "run", state: { large: "x".repeat(1_000_001) } }), /checkpoint limit/);
    const run = prepared.run as JsonObject;
    const paused = kernel.checkpoint({ run_id: run.id, state: { step: 1 }, reason: "manual" });
    assert.equal((paused.run as JsonObject).status, "paused");
    assert.equal((kernel.resume({ run_id: run.id }).run as JsonObject).status, "running");
    const result = await kernel.run({ run_id: run.id, task_id: "task", goal: "Goal", model: "m", turns: [] }, {
      next: async () => ({ kind: "action", action: "inspect", args: { path: "a" }, tokens: 2 }),
    }, async (action, args) => ({ action, args, ok: true }));
    assert.equal((result.run as JsonObject).status, "failed");
    const pausedRun = kernel.prepare({ run_id: "paused-run", task_id: "task", goal: "Goal", model: "m" });
    kernel.checkpoint({ run_id: String((pausedRun.run as JsonObject).id), state: { ready: true } });
    const resumedResult = await kernel.run({ run_id: "paused-run", task_id: "task", goal: "Goal", model: "m" }, { next: async () => ({ kind: "final", message: "resumed" }) }, async () => ({}));
    assert.equal((resumedResult.run as JsonObject).status, "completed");
    let noArgsTurn = 0;
    const noArgs = await kernel.run({ run_id: "no-args", task_id: "task", goal: "Goal", model: "m" }, { next: async () => noArgsTurn++ === 0 ? { kind: "action", action: "inspect" } : { kind: "final", message: "done" } }, async () => ({ ok: true }));
    assert.equal((noArgs.run as JsonObject).status, "completed");
    const mismatchA = kernel.prepare({ run_id: "mismatch-a", task_id: "task", goal: "Goal", model: "m" });
    const mismatchCheckpoint = kernel.checkpoint({ run_id: String((mismatchA.run as JsonObject).id), state: { a: true } });
    const mismatchB = kernel.prepare({ run_id: "mismatch-b", task_id: "task", goal: "Goal", model: "m" });
    assert.throws(() => kernel.resume({ run_id: String((mismatchB.run as JsonObject).id), checkpoint_id: String((mismatchCheckpoint.checkpoint as JsonObject).id) }), /another run/);
    await assert.rejects(() => kernel.run({ run_id: "bad-tokens", task_id: "task", goal: "Goal", model: "m" }, { next: async () => ({ kind: "final", message: "bad", tokens: -1 }) }, async () => ({})), /tokens/);
    await assert.rejects(() => kernel.run({ run_id: "bad-args", task_id: "task", goal: "Goal", model: "m" }, { next: async () => ({ kind: "action", action: "bad", args: [] as never }) }, async () => ({})), /args/);
    await assert.rejects(() => kernel.run({ run_id: "secret-args", task_id: "task", goal: "Goal", model: "m" }, { next: async () => ({ kind: "action", action: "bad", args: { token: "x" } }) }, async () => ({})), /secrets/);
    const f2 = await fixture();
    try {
      const second = new AutonomousRuntimeKernel(f2.store); f2.store.create("task", "task", {});
      const scripted = await second.run({ run_id: "run", task_id: "task", goal: "Goal", model: "m", turns: [
        { kind: "action", action: "inspect", args: { path: "a" }, tokens: 1 }, { kind: "final", message: "done", tokens: 1 },
      ] }, { next: async ({ history }) => history.length ? { kind: "final", message: "done", tokens: 1 } : { kind: "action", action: "inspect", args: { path: "a" }, tokens: 1 } }, async () => ({ ok: true }));
      assert.equal((scripted.run as JsonObject).status, "completed");
      assert.equal((second.get({ run_id: "run" }).turns as JsonObject[]).length, 2);
      assert.equal(second.resume({ run_id: "run" }).idempotent, true);
      assert.equal(second.cancel({ run_id: "run", reason: "done" }).idempotent, true);
    } finally { f2.store.close(); await rm(f2.root, { recursive: true, force: true }); }
    assert.throws(() => kernel.resume({ run_id: run.id, checkpoint_id: "missing" }), /Unknown/);
    const cancelRun = kernel.prepare({ run_id: "cancel-run", task_id: "task", goal: "Goal", model: "m" });
    assert.equal((kernel.cancel({ run_id: String((cancelRun.run as JsonObject).id), reason: "stop" }).run as JsonObject).status, "cancelled");
    assert.equal(kernel.cancel({ run_id: run.id, reason: "stop" }).idempotent, true);
    assert.equal(kernel.cancel({ run_id: String((cancelRun.run as JsonObject).id), reason: "stop" }).idempotent, true);
    assert.equal(((await kernel.run({ run_id: run.id, task_id: "task", goal: "Goal", model: "m", turns: [{ kind: "final", message: "x" }] }, { next: async () => ({ kind: "final", message: "x" }) }, async () => ({}))).run as JsonObject).status, "failed");
    assert.throws(() => kernel.checkpoint({ run_id: String((resumedResult.run as JsonObject).id), state: { late: true } }), /terminal/);
    const defaultCancel = kernel.prepare({ run_id: "default-cancel", task_id: "task", goal: "Goal", model: "m" });
    assert.equal((kernel.cancel({ run_id: String((defaultCancel.run as JsonObject).id) }).run as JsonObject).status, "cancelled");
    assert.equal(kernel.resume({ run_id: String((defaultCancel.run as JsonObject).id) }).idempotent, true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.4 capability lifecycle covers install, activate, upgrade, disable and retirement", async () => {
  const f = await fixture();
  try {
    const kernel = new CapabilityLifecycleKernel(f.store);
    assert.throws(() => kernel.register({ capability_id: 1 as never, name: "Bad", source: "local" }), /capability_id/);
    f.store.create("capability_lifecycle", "bad-state", { lifecycle: "unknown", name: "Bad" });
    f.store.create("capability_lifecycle", "missing-state", { name: "Missing State" });
    assert.throws(() => kernel.install({ capability_id: "bad-state" }), /Unsupported/);
    assert.equal((kernel.install({ capability_id: "missing-state" }).capability as JsonObject).lifecycle, "installed");
    assert.throws(() => kernel.register({ capability_id: "x", name: "x", source: "s", source_version: "", effect: "read_only" }), /source_version/);
    const created = kernel.register({ capability_id: "x", name: "Search", source: "local", source_version: "1.0.0", effect: "read_only" });
    kernel.register({ capability_id: "defaults", name: "Defaults", source: "local" });
    assert.equal(kernel.register({ capability_id: "x", name: "Search", source: "local", source_version: "1.0.0", effect: "read_only" }).idempotent, true);
    assert.throws(() => kernel.register({ capability_id: "x", name: "Other", source: "local", source_version: "1.0.0" }), /different manifest/);
    assert.throws(() => kernel.activate({ capability_id: "x" }), /installed/);
    const installed = kernel.install({ capability_id: "x" }); assert.equal((installed.capability as JsonObject).lifecycle, "installed");
    assert.equal(kernel.install({ capability_id: "x" }).idempotent, true);
    assert.equal((kernel.activate({ capability_id: "x" }).capability as JsonObject).lifecycle, "active");
    assert.equal(kernel.activate({ capability_id: "x" }).idempotent, true);
    assert.equal(kernel.install({ capability_id: "x" }).idempotent, true);
    assert.equal(kernel.disable({ capability_id: "x", reason: "review" }).idempotent, false);
    assert.equal(kernel.disable({ capability_id: "x", reason: "review" }).idempotent, true);
    assert.throws(() => kernel.activate({ capability_id: "x" }), /Disabled/);
    assert.equal((kernel.install({ capability_id: "x" }).capability as JsonObject).lifecycle, "installed");
    assert.equal((kernel.upgrade({ capability_id: "x", source_version: "2.0.0", source_digest: "sha256:new" }).capability as JsonObject).lifecycle, "installed");
    assert.equal(kernel.upgrade({ capability_id: "x", source_version: "2.0.0", source_digest: "sha256:other" }).idempotent, false);
    assert.equal(kernel.upgrade({ capability_id: "x", source_version: "2.0.0", source_digest: "sha256:other" }).idempotent, true);
    assert.equal((kernel.activate({ capability_id: "x" }).capability as JsonObject).lifecycle, "active");
    assert.equal((kernel.retire({ capability_id: "x", reason: "replaced" }).capability as JsonObject).lifecycle, "retired");
    assert.equal(kernel.retire({ capability_id: "x" }).idempotent, true);
    assert.throws(() => kernel.install({ capability_id: "x" }), /Retired/);
    assert.throws(() => kernel.upgrade({ capability_id: "x", source_version: "3.0.0", source_digest: "sha256:3" }), /Retired/);
    assert.throws(() => kernel.activate({ capability_id: "x" }), /Retired/);
    assert.equal(kernel.disable({ capability_id: "x" }).idempotent, true);
    const second = kernel.register({ capability_id: "y", name: "Search", source: "other", source_version: "1.0.0" }); kernel.install({ capability_id: "y" }); kernel.activate({ capability_id: "y" });
    kernel.register({ capability_id: "z", name: "Search", source: "third", source_version: "1.0.0" }); kernel.install({ capability_id: "z" }); kernel.activate({ capability_id: "z" });
    kernel.install({ capability_id: "defaults" }); kernel.activate({ capability_id: "defaults" });
    assert.equal((kernel.resolve({ name: "Search" }).ambiguous), true); assert.equal(kernel.resolve({ name: "Defaults" }).selected !== null, true); assert.equal(kernel.resolve({ name: "Missing" }).selected, null); assert.equal((kernel.list().capabilities as JsonObject[]).length, 6); assert.ok(created.capability);
    void second;
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.4 memory consolidation and remote interop preserve provenance and fail closed", async () => {
  const f = await fixture();
  try {
    const memory = new MemoryConsolidationKernel(f.store);
    assert.throws(() => memory.remember({ content: 1 as never }), /content/);
    assert.throws(() => memory.remember({ content: "" }), /content/);
    const one = memory.remember({ memory_id: "m1", content: "Use short prompts", scope: "user" });
    const two = memory.remember({ memory_id: "m2", content: "Verify receipts", scope: "user", source: "review" });
    const three = memory.remember({ content: "Prefer deterministic checks", task_id: "task", confidence: 0.9 });
    assert.equal(memory.remember({ memory_id: "m1", content: "Use short prompts", scope: "user" }).idempotent, true);
    assert.throws(() => memory.remember({ memory_id: "m1", content: "changed", scope: "user" }), /conflict/);
    assert.throws(() => memory.consolidate({ memory_ids: [] }), /at least/);
    assert.throws(() => memory.consolidate({}), /at least/);
    const oneRecord = one.memory as JsonObject; const twoRecord = two.memory as JsonObject;
    const semantic = memory.consolidate({ semantic_id: "s1", memory_ids: [oneRecord.id, twoRecord.id] });
    assert.equal(memory.consolidate({ semantic_id: "s1", memory_ids: [oneRecord.id, twoRecord.id] }).idempotent, true);
    assert.equal((memory.search({ query: "receipts" }).results as JsonObject[]).length, 1);
    assert.equal((memory.resolve({ semantic_id: "s1", status: "superseded" }).memory as JsonObject).status, "superseded");
    assert.throws(() => memory.resolve({ semantic_id: "s1", status: "nope" }), /Unsupported/);
    const semanticTwo = memory.consolidate({ memory_ids: [(three.memory as JsonObject).id] });
    memory.consolidate({ semantic_id: "s3", memory_ids: [(three.memory as JsonObject).id], scope: "task", content: "Prefer deterministic checks", confidence: 0.9 });
    assert.throws(() => memory.consolidate({ semantic_id: "s1", memory_ids: [oneRecord.id, twoRecord.id], content: "changed" }), /conflict/);
    assert.equal((memory.search({ query: "deterministic", scope: "task" }).results as JsonObject[]).length, 2);
    assert.equal((memory.search({ query: "deterministic", scope: "user" }).results as JsonObject[]).length, 0);
    assert.equal((memory.resolve({ semantic_id: (semanticTwo.memory as JsonObject).id, status: "active", resolution: "kept" }).memory as JsonObject).status, "active");
    const remote = new RemoteInteropKernel(f.store);
    assert.throws(() => remote.prepare({ endpoint: 1 as never, agent: "a", operation: "x", task_id: "t", input_digest: "d" }), /endpoint/);
    assert.throws(() => remote.prepare({ endpoint: "http://bad", agent: "a", operation: "x", task_id: "t", input_digest: "d" }), /HTTPS/);
    const prepared = remote.prepare({ request_id: "r1", endpoint: "https://remote.test", agent: "a", operation: "x", task_id: "t", input_digest: "d" });
    const generated = remote.prepare({ endpoint: "https://remote.test", agent: "a", operation: "x", task_id: "t", input_digest: "generated" });
    assert.equal(remote.prepare({ request_id: "r1", endpoint: "https://remote.test", agent: "a", operation: "x", task_id: "t", input_digest: "d" }).idempotent, true);
    assert.throws(() => remote.prepare({ request_id: "r1", endpoint: "https://remote.test", agent: "b", operation: "x", task_id: "t", input_digest: "d" }), /conflict/);
    const dispatched = await remote.dispatch({ request_id: "r1" }, { dispatch: async () => ({ remote_id: "rr", status: "completed", result_digest: "sha256:r" }) });
    assert.equal((dispatched.request as JsonObject).status, "completed");
    assert.equal((await remote.dispatch({ request_id: "r1" }, { dispatch: async () => ({ remote_id: "bad", status: "failed" }) })).idempotent, true);
    assert.equal(remote.report({ request_id: "r1", status: "completed", result_digest: "sha256:r" }).idempotent, true);
    assert.throws(() => remote.report({ request_id: "r1", status: "failed" }), /terminal/);
    await assert.rejects(() => remote.dispatch({ request_id: String((generated.request as JsonObject).id) }, { dispatch: async () => ({ remote_id: "", status: "accepted" }) }), /invalid result/);
    const accepted = await remote.dispatch({ request_id: String((generated.request as JsonObject).id) }, { dispatch: async () => ({ remote_id: "accepted", status: "accepted" }) });
    assert.equal((accepted.request as JsonObject).status, "accepted");
    assert.equal(remote.report({ request_id: String((generated.request as JsonObject).id), status: "completed" }).idempotent, false);
    assert.throws(() => remote.report({ request_id: String((generated.request as JsonObject).id), status: "nope" }), /Unsupported/);
    const cancelled = remote.prepare({ endpoint: "https://remote.test", agent: "a", operation: "cancel", task_id: "t", input_digest: "cancel" });
    remote.report({ request_id: String((cancelled.request as JsonObject).id), status: "cancelled" });
    await assert.rejects(() => remote.dispatch({ request_id: String((cancelled.request as JsonObject).id) }, { dispatch: async () => ({ remote_id: "again", status: "completed" }) }), /not dispatchable/);
    const failed = remote.prepare({ endpoint: "https://remote.test", agent: "a", operation: "fail", task_id: "t", input_digest: "fail" });
    await remote.dispatch({ request_id: String((failed.request as JsonObject).id) }, { dispatch: async () => ({ remote_id: "failed", status: "failed" }) });
    assert.equal((await remote.dispatch({ request_id: String((failed.request as JsonObject).id) }, { dispatch: async () => ({ remote_id: "again", status: "completed" }) })).idempotent, true);
    assert.throws(() => remote.report({ request_id: String((failed.request as JsonObject).id), status: "completed" }), /terminal/);
    assert.equal((remote.get({ request_id: (prepared.request as JsonObject).id }).receipts as JsonObject[]).length, 1);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.4 platform operations export role decisions and the MCP surface", async () => {
  const f = await fixture();
  try {
    const service = new CraftService(f.store); const ops = new PlatformOperationsKernel(f.store);
    assert.throws(() => ops.memberSave({ name: 1 as never }), /name/);
    const admin = ops.memberSave({ member_id: "admin", name: "Admin", roles: ["admin"] });
    assert.equal(ops.memberSave({ member_id: "admin", name: "Admin", roles: ["admin"] }).idempotent, true);
    assert.throws(() => ops.memberSave({ member_id: "admin", name: "Other", roles: ["admin"] }), /conflict/);
    const member = ops.memberSave({ member_id: "member", name: "Member" });
    assert.equal(ops.authorize({ member_id: (admin.member as JsonObject).id, action: "publish", required_role: "owner" }).allowed, true);
    assert.equal(ops.authorize({ member_id: (member.member as JsonObject).id, action: "publish", required_role: "owner" }).allowed, false);
    const generatedMember = ops.memberSave({ name: "Generated" });
    assert.equal(ops.authorize({ member_id: (generatedMember.member as JsonObject).id, action: "read" }).allowed, true);
    assert.equal(ops.authorize({ authorization_id: "explicit-auth", member_id: (generatedMember.member as JsonObject).id, action: "read" }).allowed, true);
    f.store.save("platform_member", "inactive", { name: "Inactive", roles: ["member"], identity_digest: "inactive", active: false });
    assert.equal(ops.authorize({ member_id: "inactive", action: "write" }).allowed, false);
    f.store.save("platform_member", "inactive-admin", { name: "Inactive Admin", roles: ["admin"], identity_digest: "inactive-admin", active: false });
    assert.equal(ops.authorize({ member_id: "inactive-admin", action: "write" }).allowed, false);
    ops.observe({ observation_id: "obs", event: "runtime.completed", value: { ok: true } });
    ops.observe({ observation_id: "obs2", event: "runtime.started", status: "running", run_id: "run", metric: "latency", value: 1 });
    ops.observe({ event: "runtime.generated" });
    assert.equal((ops.exportObservations({ limit: 1 }).observations as JsonObject[]).length, 1);
    assert.equal((ops.exportObservations({}).observations as JsonObject[]).length, 3);
    assert.throws(() => ops.exportObservations({ limit: 0 }), /limit/);
    const mcp = new McpServer(service, "full");
    for (const name of ["craft_capability_lifecycle_list", "craft_memory_search", "craft_remote_interop_get", "craft_platform_observability_export"]) assert.ok(mcp.tools.some((tool) => tool.name === name));
    const info = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "craft_platform_observability_export", arguments: { limit: 10 } } });
    assert.equal((info?.result as JsonObject).isError, false);
    const call = async (name: string, args: JsonObject) => await mcp.handlers[name]!(args);
    f.store.create("task", "handler-task", {});
    await assert.rejects(() => service.autonomousRuntimeRun({ run_id: "handler-empty", task_id: "handler-task", goal: "goal", model: "m" }), /turns/);
    await call("craft_autonomous_runtime_prepare", { run_id: "handler-run", task_id: "handler-task", goal: "goal", model: "m" });
    await call("craft_autonomous_runtime_checkpoint", { run_id: "handler-run", state: { ok: true } });
    await call("craft_autonomous_runtime_resume", { run_id: "handler-run" });
    await call("craft_autonomous_runtime_get", { run_id: "handler-run" });
    await call("craft_autonomous_runtime_cancel", { run_id: "handler-run", reason: "stop" });
    await call("craft_autonomous_runtime_run", { run_id: "handler-final", task_id: "handler-task", goal: "goal", model: "m", turns: [{ kind: "final", message: "done" }] });
    await service.autonomousRuntimeRun({ run_id: "handler-action", task_id: "handler-task", goal: "goal", model: "m", turns: [{ kind: "action", action: "inspect", args: { path: "x" } }, { kind: "final", message: "done" }], action_results: { inspect: { ok: true } } });
    await service.autonomousRuntimeRun({ run_id: "handler-fallback", task_id: "handler-task", goal: "goal", model: "m", turns: [{ kind: "action", action: "inspect", args: { path: "x" } }, { kind: "final", message: "done" }] });
    await service.autonomousRuntimeRun({ run_id: "handler-model-fallback", task_id: "handler-task", goal: "goal", model: "m", turns: [{ kind: "action", action: "inspect", args: { path: "x" } }] });
    await service.autonomousRuntimeRun({ run_id: "handler-array-result", task_id: "handler-task", goal: "goal", model: "m", turns: [{ kind: "action", action: "inspect", args: { path: "x" } }, { kind: "final", message: "done" }], action_results: { inspect: [] as never } });
    await service.autonomousRuntimeRun({ run_id: "handler-string-result", task_id: "handler-task", goal: "goal", model: "m", turns: [{ kind: "action", action: "inspect", args: { path: "x" } }, { kind: "final", message: "done" }], action_results: { inspect: "bad" as never } });
    await call("craft_capability_lifecycle_register", { capability_id: "handler-cap", name: "Handler", source: "local" });
    await call("craft_capability_lifecycle_install", { capability_id: "handler-cap" });
    await call("craft_capability_lifecycle_activate", { capability_id: "handler-cap" });
    await call("craft_capability_lifecycle_disable", { capability_id: "handler-cap" });
    await call("craft_capability_lifecycle_upgrade", { capability_id: "handler-cap", source_version: "2.0.0", source_digest: "sha256:2" });
    await call("craft_capability_lifecycle_retire", { capability_id: "handler-cap" });
    await call("craft_capability_lifecycle_resolve", { name: "Handler" });
    await call("craft_capability_lifecycle_list", {});
    await call("craft_memory_remember_episode", { memory_id: "handler-memory", content: "remember" });
    await call("craft_memory_consolidate", { semantic_id: "handler-semantic", memory_ids: ["handler-memory"] });
    await call("craft_memory_search", { query: "remember" });
    await call("craft_memory_resolve", { semantic_id: "handler-semantic", status: "active" });
    await call("craft_remote_interop_prepare", { request_id: "handler-remote", endpoint: "https://remote.test", agent: "agent", operation: "read", task_id: "handler-task", input_digest: "sha256:i" });
    await call("craft_remote_interop_dispatch", { request_id: "handler-remote", status: "completed", remote_id: "remote" });
    await call("craft_remote_interop_get", { request_id: "handler-remote" });
    await call("craft_remote_interop_report", { request_id: "handler-remote", status: "completed" });
    await service.remoteInteropPrepare({ request_id: "service-remote-default", endpoint: "https://remote.test", agent: "agent", operation: "read", task_id: "handler-task", input_digest: "sha256:default" });
    await service.remoteInteropDispatch({ request_id: "service-remote-default" });
    await assert.rejects(() => service.remoteInteropDispatch({ request_id: "service-remote-default", status: "invalid" as never }), /Unsupported remote status/);
    await service.remoteInteropPrepare({ request_id: "service-remote-explicit", endpoint: "https://remote.test", agent: "agent", operation: "read", task_id: "handler-task", input_digest: "sha256:explicit" });
    await service.remoteInteropDispatch({ request_id: "service-remote-explicit", status: "completed", remote_id: "remote-explicit", result_digest: "sha256:result" });
    await call("craft_platform_member_save", { member_id: "handler-member", name: "Handler" });
    await call("craft_platform_authorize", { member_id: "handler-member", action: "read" });
    await call("craft_platform_observe", { observation_id: "handler-observation", event: "handler" });
    await call("craft_platform_observability_export", {});
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("release version is v0.12.24", () => { assert.equal(VERSION, "0.12.25"); });
