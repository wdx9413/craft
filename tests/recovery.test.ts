import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

async function fixture(name: string) {
  const root = join(tmpdir(), `craft-recovery-${name}-${process.pid}-${Date.now()}`);
  const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  const task = service.taskOpen({ title: name, goal: "Recover durable work" }).task as JsonObject;
  const evidence = service.evidenceRecord({ evidence_id: `${name}-evidence`, source_type: "program",
    claim: "Recovery action completed", confidence: "confirmed" });
  return { root, store, service, task, evidence };
}

function seed(f: Awaited<ReturnType<typeof fixture>>, now: string) {
  f.store.create("durable_wait", "due", { task_id: f.task.id, condition: "time", resume_at: now, status: "waiting" });
  f.store.create("durable_wait", "future", { task_id: f.task.id, condition: "time", resume_at: "2030-01-01T00:00:00.000Z", status: "waiting" });
  f.store.create("durable_wait", "approval", { task_id: f.task.id, condition: "approval", approval_scope: "publish", status: "waiting" });
  f.store.create("durable_wait", "event", { task_id: f.task.id, condition: "event", event_key: "webhook", status: "waiting" });
  f.store.create("external_effect", "unknown", { task_id: f.task.id, status: "indeterminate", provider: "api", target: "record" });
  f.store.create("external_effect", "unknown-2", { task_id: f.task.id, status: "indeterminate", provider: "api", target: "record-2" });
  f.store.create("external_effect", "comp-unknown", { task_id: f.task.id, status: "compensation_indeterminate", compensation_id: "comp" });
  f.store.create("external_effect", "saga-success", { task_id: f.task.id, status: "succeeded", compensation: { action: "undo" } });
  f.store.create("external_effect", "saga-failure", { task_id: f.task.id, status: "failed" });
  f.store.create("effect_saga", "saga", { task_id: f.task.id, status: "active", effect_ids: ["saga-success", "saga-failure"] });
  f.store.create("effect_saga", "healthy-saga", { task_id: f.task.id, status: "active", effect_ids: ["saga-success"] });
}

test("recovery queue projects, leases, completes, defers, and invalidates durable work", async () => {
  const f = await fixture("lifecycle"); const now = "2029-01-01T00:00:00.000Z"; seed(f, now);
  const server = new McpServer(f.service, "full");
  try {
    const refreshed = await server.handlers.craft_recovery_queue_refresh({ now, limit: 100 });
    assert.equal(refreshed.count, 6);
    assert.equal((f.service.recoveryQueueRefresh({ now, limit: 100 }).items as JsonObject[]).length, 6);
    assert.equal(f.service.recoveryWorkClaim({ worker_id: "worker", actions: ["missing"], now }).item, null);

    const effectLease = await server.handlers.craft_recovery_work_claim({ worker_id: "worker",
      actions: ["reconcile_effect"], now, lease_seconds: 60 });
    const effectItem = effectLease.item as JsonObject;
    assert.equal(effectItem.action, "reconcile_effect");
    assert.throws(() => f.service.recoveryWorkReport({ item_id: effectItem.id, lease_token: effectLease.lease_token,
      outcome: "completed", summary: "done", evidence_ids: [f.evidence.id], now }), /still actionable/);
    const leasedEffectId = String(effectItem.subject_id);
    f.store.save("external_effect", leasedEffectId, { ...f.store.get("external_effect", leasedEffectId), status: "failed" });
    const completed = await server.handlers.craft_recovery_work_report({ item_id: effectItem.id, lease_token: effectLease.lease_token,
      outcome: "completed", summary: "remote state resolved", evidence_ids: [f.evidence.id], now });
    assert.equal((completed.item as JsonObject).status, "completed"); assert.equal(completed.stale, false);

    const approvalLease = f.service.recoveryWorkClaim({ worker_id: "human-desk", actions: ["request_approval"], now });
    const approvalItem = approvalLease.item as JsonObject;
    f.store.save("durable_wait", "approval", { ...f.store.get("durable_wait", "approval"), approval_scope: "changed" });
    const stale = f.service.recoveryWorkReport({ item_id: approvalItem.id, lease_token: approvalLease.lease_token,
      outcome: "failed", summary: "old approval", evidence_ids: [f.evidence.id], now });
    assert.equal(stale.stale, true); assert.equal((stale.item as JsonObject).status, "stale");

    const deferredLease = f.service.recoveryWorkClaim({ worker_id: "worker", actions: ["resolve_compensation"], now });
    const deferred = f.service.recoveryWorkReport({ item_id: (deferredLease.item as JsonObject).id,
      lease_token: deferredLease.lease_token, outcome: "deferred", summary: "needs owner", now });
    assert.equal((deferred.item as JsonObject).status, "deferred");

    const sagaLease = f.service.recoveryWorkClaim({ worker_id: "worker", actions: ["execute_compensation"], now });
    const failed = f.service.recoveryWorkReport({ item_id: (sagaLease.item as JsonObject).id,
      lease_token: sagaLease.lease_token, outcome: "failed", summary: "adapter unavailable", evidence_ids: [f.evidence.id], now });
    assert.equal((failed.item as JsonObject).status, "failed");

    const dueLease = f.service.recoveryWorkClaim({ worker_id: "scheduler", actions: ["resume_due_wait"], now, lease_seconds: 10 });
    assert.equal(f.service.recoveryLeaseRecover({ now: "2029-01-01T00:00:05.000Z", limit: 10 }).recovered, 0);
    assert.throws(() => f.service.recoveryWorkReport({ item_id: (dueLease.item as JsonObject).id, lease_token: dueLease.lease_token,
      outcome: "failed", summary: "late", evidence_ids: [f.evidence.id], now: "2029-01-01T00:00:10.000Z" }), /expired/);
    assert.equal((await server.handlers.craft_recovery_lease_recover({ now: "2029-01-01T00:00:11.000Z", limit: 10 })).recovered, 1);
    f.store.save("durable_wait", "due", { ...f.store.get("durable_wait", "due"), status: "completed" });
    f.service.recoveryQueueRefresh({ now: "2029-01-01T00:00:12.000Z" });
    assert.equal(f.store.get("recovery_item", "recovery:durable_wait:due:resume_due_wait").status, "superseded");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("recovery queue fails closed on malformed leases, reports, limits, and source state", async () => {
  const f = await fixture("errors"); const now = "2029-01-01T00:00:00.000Z"; seed(f, now);
  try {
    assert.throws(() => f.service.recoveryQueueRefresh({ now: "bad" }), /ISO/);
    assert.throws(() => f.service.recoveryQueueRefresh({ now, limit: 0 }), /integer/);
    assert.equal(typeof f.service.recoveryQueueRefresh({}).refreshed_at, "string");
    f.service.recoveryQueueRefresh({ now });
    assert.throws(() => f.service.recoveryWorkClaim({ worker_id: "worker", actions: [], now }), /non-empty/);
    assert.throws(() => f.service.recoveryWorkClaim({ worker_id: "worker", actions: ["x", "x"], now }), /unique/);
    assert.throws(() => f.service.recoveryWorkClaim({ worker_id: " ", actions: ["reconcile_effect"], now }), /worker_id/);
    assert.throws(() => f.service.recoveryWorkClaim({ worker_id: "worker", actions: ["reconcile_effect"], now, lease_seconds: 0 }), /integer/);
    assert.throws(() => f.service.recoveryWorkReport({ item_id: "recovery:durable_wait:due:resume_due_wait",
      lease_token: "none", outcome: "failed", summary: "none", evidence_ids: [f.evidence.id], now }), /not leased/);
    const lease = f.service.recoveryWorkClaim({ worker_id: "worker", actions: ["reconcile_effect"], now }); const item = lease.item as JsonObject;
    assert.throws(() => f.service.recoveryWorkReport({ item_id: item.id, lease_token: "wrong", outcome: "failed",
      summary: "bad", evidence_ids: [f.evidence.id], now }), /invalid/);
    assert.throws(() => f.service.recoveryWorkReport({ item_id: item.id, lease_token: lease.lease_token, outcome: "other",
      summary: "bad", evidence_ids: [f.evidence.id], now }), /Unsupported/);
    assert.throws(() => f.service.recoveryWorkReport({ item_id: item.id, lease_token: lease.lease_token, outcome: "failed",
      summary: "bad", evidence_ids: [], now }), /non-empty/);
    assert.throws(() => f.service.recoveryLeaseRecover({ now, limit: 1001 }), /integer/);
    f.store.save("external_effect", "comp-unknown", { ...f.store.get("external_effect", "comp-unknown"), status: "compensated" });
    f.service.recoveryQueueRefresh({ now });
    assert.equal(f.store.get("recovery_item", "recovery:external_effect:comp-unknown:resolve_compensation").status, "superseded");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
