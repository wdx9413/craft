import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DecisionPointContextGate } from "../core/decision-context-gate.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-decision-context-gate-"));
  return { root, store: await new CraftStore(craftPaths(root)).open() };
}

test("decision context gate records only measured inputs and covers ready, blocked, skipped, replay and validation paths", async () => {
  const f = await fixture();
  try {
    const context = { reply: {} as JsonObject, async resolve() { return this.reply; } };
    const gate = new DecisionPointContextGate(f.store, context as never);

    context.reply = { skipped: true, items: undefined, receipt: null, reason: "scope_missing" };
    const skipped = await gate.open({ gate_id: "skipped", decision_kind: "choose", query: "q", require_context: true });
    assert.equal((skipped.gate as JsonObject).status, "skipped");
    assert.equal(((skipped.gate as JsonObject).decision_metrics as JsonObject).cache_observation, "unavailable");

    context.reply = { skipped: true, items: [], receipt: null };
    const defaultReason = await gate.open({ gate_id: "default-reason", decision_kind: "choose", query: "q" });
    assert.equal((defaultReason.gate as JsonObject).skipped_reason, "scope_unavailable");

    context.reply = { items: [], receipt: null };
    const blocked = await gate.open({ gate_id: "blocked", decision_kind: "choose", query: "q", require_context: true });
    assert.equal((blocked.gate as JsonObject).action, "clarify_or_replan");

    f.store.create("task", "task", { title: "test" });
    const receipt = f.store.create("context_resolution_receipt", "receipt", { identity_digest: "receipt" });
    context.reply = { items: [{ memory_id: "m" }], receipt };
    const args = { gate_id: "ready", decision_kind: "choose", query: "q", task_id: "task", required_constraint_ids: ["a", "b"], recalled_constraint_ids: ["a"],
      context_input_tokens: 3, error_injection_count: 0, cost_units: 0.1, latency_ms: 2, cache_observation: "observed", cache_hit_tokens: 2 };
    const ready = await gate.open(args);
    assert.equal((ready.gate as JsonObject).action, "continue");
    assert.equal((((ready.gate as JsonObject).decision_metrics as JsonObject).cache_hit_tokens), 2);
    assert.equal((gate.get({ gate_id: "ready" }).gate as JsonObject).id, "ready");
    assert.equal((await gate.open(args)).idempotent, true);
    await assert.rejects(() => gate.open({ ...args, query: "changed" }), /idempotency conflict/);

    context.reply = { items: [], receipt: null };
    const generated = await gate.open({ decision_kind: "choose", query: "q", scope_kind: "project", scope_id: "project-a", cache_observation: "unavailable" });
    assert.match(String((generated.gate as JsonObject).id), /^decision_context_gate_/);

    for (const input of [
      { required_constraint_ids: "bad" },
      { required_constraint_ids: ["a", "a"] },
      { required_constraint_ids: ["a"], recalled_constraint_ids: ["b"] },
      { context_input_tokens: -1 },
      { context_input_tokens: Number.NaN },
      { cache_observation: "invalid" },
    ]) await assert.rejects(() => gate.open({ gate_id: `invalid-${JSON.stringify(input)}`, decision_kind: "choose", query: "q", ...input }), /array|unique|subset|non-negative|cache_observation/);
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
