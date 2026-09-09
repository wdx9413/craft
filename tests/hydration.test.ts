import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

async function fixture(name: string) {
  const root = join(tmpdir(), `craft-hydration-${name}-${process.pid}-${Date.now()}`); const project = join(root, "project"); await mkdir(project, { recursive: true });
  const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  const task = store.create("task", "task", { title: name, goal: "Resume safely", status: "active" });
  service.workspaceOpen({ workspace_id: "ws", name: "Workspace", root_path: project, include_paths: ["."] });
  const budget = service.budgetOpen({ budget_id: "budget", owner_type: "task", owner_id: task.id, limits: { tokens: 100 } }).account as JsonObject;
  return { root, store, service, task, budget };
}

test("long tasks dehydrate, wait without a process, revalidate, lease once, and hydrate with evidence", async () => {
  const f = await fixture("lifecycle"); const mcp = new McpServer(f.service, "full");
  try {
    const wait = f.service.durableWaitCreate({ wait_id: "wait", task_id: f.task.id, workspace_id: "ws", condition: "event",
      event_key: "approved", policy_fingerprint: "policy-v1" }).wait as JsonObject;
    const run = f.store.create("runtime_run", "run", { task_id: f.task.id, status: "waiting", policy_fingerprint: "policy-v1", environment_fingerprint: "env-v1" });
    const recovery = f.store.create("recovery_item", "recovery", { task_id: f.task.id, status: "open" });
    const captured = await mcp.handlers.craft_dehydration_capture({ snapshot_id: "snapshot", task_id: f.task.id, workspace_id: "ws",
      wait_id: wait.id, runtime_run_id: run.id, budget_ids: [f.budget.id], recovery_item_ids: [recovery.id],
      now: "2030-01-01T00:00:00.000Z", ttl_seconds: 3600 });
    const snapshot = captured.snapshot as JsonObject;
    assert.equal(snapshot.raw_context_stored, false); assert.equal(snapshot.credentials_stored, false);
    assert.equal((await mcp.handlers.craft_dehydration_capture({ snapshot_id: "snapshot", task_id: f.task.id, workspace_id: "ws",
      wait_id: wait.id, runtime_run_id: run.id, budget_ids: [f.budget.id], recovery_item_ids: [recovery.id],
      now: "2030-01-01T00:30:00.000Z" })).idempotent, true);
    const waiting = await mcp.handlers.craft_hydration_claim({ snapshot_id: snapshot.id, state_fingerprint: snapshot.state_fingerprint,
      host_id: "codex", claim_key: "attempt", now: "2030-01-01T00:00:10.000Z" });
    assert.equal((waiting.inspection as JsonObject).readiness, "still_waiting"); assert.equal(waiting.dispatch, undefined);
    f.service.durableWaitResume({ wait_id: wait.id, signal: "event", signal_key: "approved", policy_fingerprint: "policy-v1" });
    const claimed = await mcp.handlers.craft_hydration_claim({ snapshot_id: snapshot.id, state_fingerprint: snapshot.state_fingerprint,
      host_id: "codex", claim_key: "attempt", now: "2030-01-01T00:01:00.000Z", lease_ttl_seconds: 60 });
    const leased = claimed.snapshot as JsonObject; assert.equal((claimed.dispatch as JsonObject).mode, "resume");
    assert.equal((await mcp.handlers.craft_hydration_claim({ snapshot_id: snapshot.id, state_fingerprint: snapshot.state_fingerprint,
      host_id: "codex", claim_key: "attempt", now: "2030-01-01T00:01:01.000Z" })).idempotent, true);
    assert.throws(() => f.service.hydrationClaim({ snapshot_id: snapshot.id, state_fingerprint: snapshot.state_fingerprint,
      host_id: "claude", claim_key: "other", now: "2030-01-01T00:01:01.000Z" }), /already claimed/);
    const evidence = f.service.evidenceRecord({ evidence_id: "hydrated", source_type: "host", claim: "State restored" });
    const completed = await mcp.handlers.craft_hydration_report({ snapshot_id: snapshot.id, lease_id: leased.lease_id, host_id: "codex",
      outcome: "completed", summary: "Restored state", evidence_ids: [evidence.id], now: "2030-01-01T00:01:02.000Z" });
    assert.equal((completed.snapshot as JsonObject).status, "hydrated");
    assert.throws(() => f.service.hydrationClaim({ snapshot_id: snapshot.id, state_fingerprint: snapshot.state_fingerprint,
      host_id: "codex", claim_key: "again" }), /not claimable/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("workspace drift hydrates in replan mode, abandonment and expired leases remain recoverable", async () => {
  const f = await fixture("replan"); const mcp = new McpServer(f.service, "full");
  try {
    const captured = f.service.dehydrationCapture({ snapshot_id: "replan", task_id: f.task.id, workspace_id: "ws",
      now: "2030-01-01T00:00:00.000Z", ttl_seconds: 3600 }).snapshot as JsonObject;
    const workspace = f.store.get("workspace", "ws"); f.store.save("workspace", "ws", { ...workspace, state_revision: Number(workspace.state_revision) + 1 });
    const inspection = await mcp.handlers.craft_hydration_inspect({ snapshot_id: captured.id });
    assert.equal(inspection.readiness, "needs_replan");
    const claim = f.service.hydrationClaim({ snapshot_id: captured.id, state_fingerprint: captured.state_fingerprint,
      host_id: "host", claim_key: "one", now: "2030-01-01T00:00:01.000Z", lease_ttl_seconds: 30 });
    assert.equal((claim.dispatch as JsonObject).mode, "replan");
    const abandoned = f.service.hydrationReport({ snapshot_id: captured.id, lease_id: (claim.snapshot as JsonObject).lease_id,
      host_id: "host", outcome: "abandoned", summary: "Host unavailable", now: "2030-01-01T00:00:02.000Z" });
    assert.equal((abandoned.snapshot as JsonObject).status, "frozen");
    const second = f.service.hydrationClaim({ snapshot_id: captured.id, state_fingerprint: captured.state_fingerprint,
      host_id: "host2", claim_key: "two", now: "2030-01-01T00:00:03.000Z", lease_ttl_seconds: 30 }).snapshot as JsonObject;
    const recovered = await mcp.handlers.craft_hydration_lease_recover({ now: "2030-01-01T00:00:34.000Z", limit: 1 });
    assert.equal(recovered.count, 1); assert.equal((recovered.recovered as JsonObject[])[0].status, "frozen");
    assert.notEqual(second.version, (recovered.recovered as JsonObject[])[0].version);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("dehydration fails closed for unrelated state, stale identity, unsafe budgets, malformed leases, and missing components", async () => {
  const f = await fixture("errors");
  try {
    assert.throws(() => f.service.dehydrationCapture({ task_id: 3, workspace_id: "ws" }), /task_id/);
    assert.throws(() => f.service.dehydrationCapture({ task_id: f.task.id }), /requires workspace/);
    f.store.save("task", f.task.id as string, { ...f.task, status: "completed" });
    assert.throws(() => f.service.dehydrationCapture({ task_id: f.task.id, workspace_id: "ws" }), /active or paused/);
    const task = f.store.save("task", f.task.id as string, { ...f.task, status: "paused" });
    const other = f.store.create("task", "other-task", { title: "Other", goal: "Other", status: "active" });
    const otherWait = f.store.create("durable_wait", "other-wait", { task_id: other.id, workspace_id: null, status: "waiting" });
    const otherRun = f.store.create("runtime_run", "other-run", { task_id: other.id, status: "waiting" });
    assert.throws(() => f.service.dehydrationCapture({ task_id: task.id, wait_id: otherWait.id }), /belong to the task/);
    assert.throws(() => f.service.dehydrationCapture({ task_id: task.id, runtime_run_id: otherRun.id }), /belong to the task/);
    const wait = f.store.create("durable_wait", "wait-mismatch", { task_id: task.id, workspace_id: "other-workspace", status: "waiting" });
    assert.throws(() => f.service.dehydrationCapture({ task_id: task.id, workspace_id: "ws", wait_id: wait.id }), /does not match/);
    const foreignBudget = f.service.budgetOpen({ budget_id: "foreign", owner_type: "task", owner_id: other.id, limits: {} }).account as JsonObject;
    assert.throws(() => f.service.dehydrationCapture({ task_id: task.id, workspace_id: "ws", budget_ids: [foreignBudget.id] }), /owned/);
    f.service.budgetClose({ budget_id: f.budget.id });
    assert.throws(() => f.service.dehydrationCapture({ task_id: task.id, workspace_id: "ws", budget_ids: [f.budget.id] }), /active/);
    const badRecovery = f.store.create("recovery_item", "bad-recovery", { task_id: other.id, status: "completed" });
    assert.throws(() => f.service.dehydrationCapture({ task_id: task.id, workspace_id: "ws", recovery_item_ids: [badRecovery.id] }), /recovery items/);
    assert.throws(() => f.service.dehydrationCapture({ task_id: task.id, workspace_id: "ws", budget_ids: "bad" }), /array/);
    assert.throws(() => f.service.dehydrationCapture({ task_id: task.id, workspace_id: "ws", recovery_item_ids: ["x", "x"] }), /unique/);
    assert.throws(() => f.service.dehydrationCapture({ task_id: task.id, workspace_id: "ws", ttl_seconds: 1 }), /between/);
    const snap = f.service.dehydrationCapture({ snapshot_id: "fixed", task_id: task.id, workspace_id: "ws",
      now: "2030-01-01T00:00:00.000Z", ttl_seconds: 60 }).snapshot as JsonObject;
    const localRun = f.store.create("runtime_run", "local-run", { task_id: task.id, status: "waiting" });
    assert.throws(() => f.service.dehydrationCapture({ snapshot_id: "fixed", task_id: task.id, runtime_run_id: localRun.id }), /idempotency/);
    assert.throws(() => f.service.hydrationClaim({ snapshot_id: snap.id, state_fingerprint: "wrong", host_id: "h", claim_key: "c" }), /fingerprint/);
    assert.throws(() => f.service.hydrationClaim({ snapshot_id: snap.id, state_fingerprint: snap.state_fingerprint, host_id: "h", claim_key: "c", now: "bad" }), /ISO/);
    assert.throws(() => f.service.hydrationClaim({ snapshot_id: snap.id, state_fingerprint: snap.state_fingerprint, host_id: "h", claim_key: "c", now: "2030-01-01T00:02:00.000Z" }), /expired/);
    const claim = f.service.hydrationClaim({ snapshot_id: snap.id, state_fingerprint: snap.state_fingerprint, host_id: "h", claim_key: "c",
      now: "2030-01-01T00:00:01.000Z" }).snapshot as JsonObject;
    assert.throws(() => f.service.hydrationReport({ snapshot_id: snap.id, lease_id: "bad", host_id: "h", outcome: "completed", summary: "x" }), /lease/);
    assert.throws(() => f.service.hydrationReport({ snapshot_id: snap.id, lease_id: claim.lease_id, host_id: "h", outcome: "completed", summary: "x", now: "2030-01-01T00:10:00.000Z" }), /expired/);
    f.store.save("dehydration_snapshot", snap.id as string, { ...claim, lease_expires_at: "2031-01-01T00:00:00.000Z" });
    assert.throws(() => f.service.hydrationReport({ snapshot_id: snap.id, lease_id: claim.lease_id, host_id: "h", outcome: "bad", summary: "x" }), /outcome/);
    assert.throws(() => f.service.hydrationReport({ snapshot_id: snap.id, lease_id: claim.lease_id, host_id: "h", outcome: "completed", summary: "x" }), /requires Evidence/);
    assert.throws(() => f.service.hydrationReport({ snapshot_id: snap.id, lease_id: claim.lease_id, host_id: "h", outcome: "completed", summary: "x", evidence_ids: ["missing"] }), /Unknown evidence/);
    assert.throws(() => f.service.hydrationLeaseRecover({ now: "bad" }), /ISO/);
    assert.throws(() => f.service.hydrationLeaseRecover({ limit: 0 }), /between/);

    const localWait = f.store.create("durable_wait", "local-wait", { task_id: task.id, workspace_id: "ws", status: "waiting", policy_fingerprint: null });
    const runBudget = f.service.budgetOpen({ budget_id: "run-budget", owner_type: "runtime_run", owner_id: localRun.id, limits: {} }).account as JsonObject;
    const comprehensive = f.service.dehydrationCapture({ task_id: task.id, workspace_id: "ws", wait_id: localWait.id,
      runtime_run_id: localRun.id, budget_ids: [runBudget.id] }).snapshot as JsonObject;
    assert.match(String(comprehensive.id), /^dehydration_/);
    f.store.save("task", task.id as string, { ...f.store.get("task", task.id as string), title: "Changed" });
    f.store.save("runtime_run", localRun.id as string, { ...localRun, status: "changed" });
    f.store.save("durable_wait", localWait.id as string, { ...localWait, status: "cancelled" });
    f.store.save("budget_account", runBudget.id as string, { ...runBudget, status: "closed" });
    const changed = f.service.hydrationInspect({ snapshot_id: comprehensive.id });
    assert.deepEqual(new Set((changed.issues as JsonObject[]).map((item) => item.issue)),
      new Set(["version_changed", "terminal", "not_active"]));
    f.store.remove("durable_wait", localWait.id as string); f.store.remove("budget_account", runBudget.id as string);
    const missing = f.service.hydrationInspect({ snapshot_id: comprehensive.id });
    assert.equal((missing.issues as JsonObject[]).filter((item) => item.issue === "missing").length, 2);

    const inspectSnap = f.service.dehydrationCapture({ snapshot_id: "inspect", task_id: task.id, workspace_id: "ws", runtime_run_id: "local-run", now: "2030-01-01T00:00:00.000Z" }).snapshot as JsonObject;
    f.store.remove("task", task.id as string); f.store.remove("workspace", "ws"); f.store.remove("runtime_run", "local-run");
    const inspection = f.service.hydrationInspect({ snapshot_id: inspectSnap.id });
    assert.equal(inspection.readiness, "needs_replan"); assert.equal((inspection.issues as JsonObject[]).length, 3);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
