import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AttentionKernel } from "../core/attention.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { CraftService } from "../core/service.ts";
import { WorkbenchWebApp } from "../core/interfaces/workbench-server.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "craft-attention-batch-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store, kernel: new AttentionKernel(store), service: new CraftService(store) };
}

function cards(kernel: AttentionKernel, count: number): string[] {
  for (let index = 0; index < count; index += 1) {
    kernel.store.create("autonomy_request", `approval-${index}`, {
      status: "pending_approval", task_id: "task", action: "external_write", target: `target-${index}`,
    });
  }
  return (kernel.refresh({ now: "2030-01-01T00:00:00Z" }).cards as JsonObject[]).map((card) => String(card.id));
}

test("a batch returns one receipt per card and never rolls back unrelated successes", async () => {
  const f = await fixture();
  try {
    const ids = cards(f.kernel, 3);
    // One card's source drifts after the refresh: its own decision must fail,
    // while the two untouched cards still succeed.
    f.store.save("autonomy_request", "approval-1", { status: "pending_approval", task_id: "task", action: "external_write", target: "target-1" });
    const result = f.kernel.decideBatch({ item_ids: ids, decision: "acknowledge", decided_by: "user" });
    assert.equal(result.succeeded, 2);
    assert.equal(result.failed, 1);
    const rows = result.results as JsonObject[];
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => [row.item_id, row.ok]), [
      [ids[0], true], [ids[1], false], [ids[2], true],
    ]);
    assert.match(String(rows[1]!.error), /source changed/u);
    assert.equal(f.store.get("attention_item", ids[0]!).status, "acknowledged");
    assert.equal(f.store.get("attention_item", ids[2]!).status, "acknowledged");
    assert.equal(f.store.get("attention_item", ids[1]!).status, "open", "the failed card is not mutated");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("batch input is validated, deduplicated and bounded", async () => {
  const f = await fixture();
  try {
    const ids = cards(f.kernel, 2);
    assert.throws(() => f.kernel.decideBatch({ item_ids: [], decision: "acknowledge", decided_by: "u" }), /non-empty/u);
    assert.throws(() => f.kernel.decideBatch({ item_ids: ids, decision: "skip", decided_by: "u" }), /unsupported/u);
    assert.throws(() => f.kernel.decideBatch({
      item_ids: Array.from({ length: 51 }, (_, index) => `x-${index}`), decision: "acknowledge", decided_by: "u",
    }), /at most 50/u);
    const deduped = f.kernel.decideBatch({ item_ids: [ids[0], ids[0]], decision: "acknowledge", decided_by: "u" });
    assert.equal((deduped.results as JsonObject[]).length, 1);
    assert.equal(deduped.succeeded, 1);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("defer batches carry the same until/reason validation on every card", async () => {
  const f = await fixture();
  try {
    const ids = cards(f.kernel, 2);
    const result = f.kernel.decideBatch({
      item_ids: ids, decision: "defer", decided_by: "user",
      deferred_until: "2030-01-01T01:00:00Z", now: "2030-01-01T00:00:00Z", reason: "later",
    });
    assert.equal(result.succeeded, 2);
    for (const id of ids) assert.equal(f.store.get("attention_item", id).status, "deferred");
    // Re-deferring a deferred card is allowed by the single-card contract;
    // the batch still validates the new until value on every card.
    const extended = f.kernel.decideBatch({
      item_ids: ids, decision: "defer", decided_by: "user",
      deferred_until: "2030-01-01T02:00:00Z", now: "2030-01-01T00:00:00Z",
    });
    assert.equal(extended.succeeded, 2);
    assert.equal(f.store.get("attention_item", ids[0]!).deferred_until, "2030-01-01T02:00:00.000Z");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("service, MCP handler and HTTP all route the batch through one kernel method", async () => {
  const f = await fixture();
  try {
    const ids = cards(f.kernel, 2);
    const viaService = f.service.attentionDecideBatch({ item_ids: ids, decision: "acknowledge", decided_by: "user" });
    assert.equal(viaService.succeeded, 2);
    const { createActionHandlers } = await import("../core/application/actions/action-handlers.ts");
    const handlers = createActionHandlers(f.service) as Record<string, (args: JsonObject) => unknown>;
    assert.equal(typeof handlers.craft_attention_decide_batch, "function");
    const app = new WorkbenchWebApp(f.service, "token", "http://127.0.0.1:4173");
    const response = app.handle({ method: "POST", path: "/api/inbox/decide-batch", token: "token",
      body: JSON.stringify({ item_ids: ids, decision: "defer", decided_by: "user", deferred_until: "2030-01-01T02:00:00Z", now: "2030-01-01T01:00:00Z" }) });
    // Cards were acknowledged by the service call above; a deferred batch on
    // them is refused per card. The important contract is the route exists and
    // returns per-card receipts rather than a single bulk status.
    const payload = JSON.parse(response.body) as { results: JsonObject[]; succeeded: number; failed: number };
    assert.equal(response.status, 200);
    assert.equal(payload.results.length, 2);
    assert.equal(payload.failed, 2);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
