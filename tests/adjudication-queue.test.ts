import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AdjudicationQueueKernel, batchKey } from "../core/adjudication-queue.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "craft-adj-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { store, queue: new AdjudicationQueueKernel(store) };
}

const item = (id: string, priorityValue: number, overrides: Record<string, unknown> = {}) => ({
  item_id: id, item_kind: "contract", decision_kind: "interface_change", priority: priorityValue,
  summary: `change ${id}`, ...overrides,
});

test("exactly one card is focused, the rest wait marked, and priority orders the focus", async () => {
  const f = await fixture();
  try {
    // Five simultaneous changes is the case section 6.4 describes.
    for (const [id, priorityValue] of [["a", 10], ["b", 90], ["c", 50], ["d", 70], ["e", 20]] as const) {
      f.queue.enqueue(item(id, priorityValue));
    }
    const view = f.queue.view({});
    // The highest priority takes the centre; everything else is marked and waiting.
    assert.equal((view.focused as Record<string, unknown>).id, "b");
    assert.equal((view.waiting as unknown[]).length, 4);
    assert.equal((view.waiting as Record<string, unknown>[]).every((entry) => entry.marked === true), true);
    // Only the focused item is unmarked, so "what needs me now" is unambiguous.
    assert.equal((view.focused as Record<string, unknown>).marked, undefined);

    // A tie is broken by id, so the focus does not depend on arrival order.
    f.queue.enqueue(item("z", 95));
    f.queue.enqueue(item("y", 95));
    assert.equal((f.queue.view({}).focused as Record<string, unknown>).id, "y");

    // Nothing open: no focus, no batch.
    for (const id of ["a", "b", "c", "d", "e", "y", "z"]) {
      f.queue.resolve({ item_ids: [id], decision: "approved", decided_at: "2030-01-01T00:00:00Z",
        authorizations: [{ item_id: id, approved_by: "u1", receipt_digest: `sha256:${id}` }] });
    }
    assert.deepEqual(f.queue.view({}), { focused: null, waiting: [], batches: [] });
  } finally { f.store.close(); }
});

test("same-kind items merge into one card, and the batch reports its effect count", async () => {
  const f = await fixture();
  try {
    // Three services needing the same interface change: one judgement, so one card.
    for (const id of ["svc1", "svc2", "svc3"]) f.queue.enqueue(item(id, 50, { item_kind: "contract" }));
    // A different decision kind does not join, even though the item kind matches.
    f.queue.enqueue({ item_id: "del", item_kind: "contract", decision_kind: "deletion", priority: 50, summary: "delete" });

    const view = f.queue.view({});
    assert.equal((view.batches as unknown[]).length, 1);
    const batch = (view.batches as Record<string, unknown>[])[0];
    assert.equal(batch.effect_count, 3);
    assert.deepEqual(batch.item_ids, ["svc1", "svc2", "svc3"]);
    assert.equal(batch.batch_key, batchKey("contract", "interface_change"));

    // The unrelated deletion does not join the card. With equal priorities the focus is the
    // alphabetically first id, which is `del`, and the three services wait — but the batch
    // is still reported, because batches are computed across all open items rather than
    // only around whatever happens to be focused.
    assert.equal((view.focused as Record<string, unknown>).id, "del");
    assert.equal((view.waiting as unknown[]).length, 3);
    assert.deepEqual((view.waiting as Record<string, unknown>[]).map((entry) => entry.id), ["svc1", "svc2", "svc3"]);
    assert.equal((view.batches as Record<string, unknown>[])[0].focused_id, "svc1");

    // Resolving the group leaves the deletion alone, and then there is no batch at all.
    f.queue.resolve({ item_ids: ["svc1", "svc2", "svc3"], decision: "approved", decided_at: "2030-01-01T00:00:00Z",
      authorizations: ["svc1", "svc2", "svc3"].map((id) => ({ item_id: id, approved_by: "u1", receipt_digest: `sha256:${id}` })) });
    assert.deepEqual(f.queue.view({}).batches, []);
    f.queue.resolve({ item_ids: ["del"], decision: "approved", decided_at: "2030-01-01T00:00:00Z",
      authorizations: [{ item_id: "del", approved_by: "u1", receipt_digest: "sha256:d" }] });
    assert.deepEqual(f.queue.view({}), { focused: null, waiting: [], batches: [] });
  } finally { f.store.close(); }
});

test("several groups report as several batches, ordered deterministically", async () => {
  const f = await fixture();
  try {
    // Two unrelated groups are open at once. Each is a card of its own, and the order is
    // by batch key rather than by whichever group happened to be enqueued first.
    for (const id of ["b1", "b2"]) f.queue.enqueue({ item_id: id, item_kind: "schema", decision_kind: "migration", priority: 10, summary: id });
    for (const id of ["a1", "a2"]) f.queue.enqueue({ item_id: id, item_kind: "contract", decision_kind: "interface_change", priority: 10, summary: id });
    const view = f.queue.view({});
    assert.equal((view.batches as unknown[]).length, 2);
    assert.deepEqual((view.batches as Record<string, unknown>[]).map((entry) => entry.batch_key),
      [batchKey("contract", "interface_change"), batchKey("schema", "migration")]);
    assert.deepEqual((view.batches as Record<string, unknown>[]).map((entry) => entry.effect_count), [2, 2]);
  } finally { f.store.close(); }
});

test("a batch is one action but not one signature: every effect needs its own authorization", async () => {
  const f = await fixture();
  try {
    for (const id of ["svc1", "svc2", "svc3"]) f.queue.enqueue(item(id, 50));
    const ids = ["svc1", "svc2", "svc3"];

    // One signature over three effects is exactly what section 6.4 forbids.
    assert.throws(() => f.queue.resolve({ item_ids: ids, decision: "approved", decided_at: "2030-01-01T00:00:00Z",
      authorizations: [{ item_id: "svc1", approved_by: "u1", receipt_digest: "sha256:one" }] }),
      /one action, not one signature: 3 effect\(s\) require 3 authorization record\(s\), received 1/);
    // Too many records is equally wrong: it would mean an authorization for an effect that
    // was not part of this decision.
    assert.throws(() => f.queue.resolve({ item_ids: ["svc1"], decision: "approved", decided_at: "2030-01-01T00:00:00Z",
      authorizations: [
        { item_id: "svc1", approved_by: "u1", receipt_digest: "sha256:a" },
        { item_id: "svc2", approved_by: "u1", receipt_digest: "sha256:b" }] }),
      /1 effect\(s\) require 1 authorization record\(s\), received 2/);
    // A record for an effect outside the batch does not cover the one inside it.
    assert.throws(() => f.queue.resolve({ item_ids: ["svc1"], decision: "approved", decided_at: "2030-01-01T00:00:00Z",
      authorizations: [{ item_id: "other", approved_by: "u1", receipt_digest: "sha256:a" }] }),
      /authorization is missing for effect: svc1/);

    const resolved = f.queue.resolve({ item_ids: ids, decision: "approved", decided_at: "2030-01-01T00:00:00Z",
      authorizations: [
        { item_id: "svc1", approved_by: "u1", receipt_digest: "sha256:a" },
        { item_id: "svc2", approved_by: "u1", receipt_digest: "sha256:b" },
        { item_id: "svc3", approved_by: "u2", receipt_digest: "sha256:c" }] });
    assert.equal(resolved.effects, 3);
    const records = resolved.authorizations as Record<string, unknown>[];
    assert.equal(records.length, 3);
    // Each record names its own effect, approver, time and digest, so "who approved this
    // one" is answerable per effect rather than per card.
    assert.deepEqual(records.map((entry) => entry.item_id).sort(), ["svc1", "svc2", "svc3"]);
    assert.deepEqual(records.map((entry) => entry.approved_by).sort(), ["u1", "u1", "u2"]);
    assert.equal(records.every((entry) => entry.batch_size === 3), true);
    assert.equal(records.every((entry) => entry.decided_at === "2030-01-01T00:00:00Z"), true);

    // Per-item lookup returns that item's own record.
    const one = f.queue.authorizations({ item_id: "svc3" });
    assert.equal((one.authorizations as unknown[]).length, 1);
    assert.equal((one.authorizations as Record<string, unknown>[])[0].approved_by, "u2");
    // Decided items leave the queue.
    assert.equal((f.queue.view({}).focused as unknown) ?? null, null);
  } finally { f.store.close(); }
});

test("a batch must share one kind and decision, and cannot be widened by listing items", async () => {
  const f = await fixture();
  try {
    f.queue.enqueue(item("a", 50));
    f.queue.enqueue({ item_id: "b", item_kind: "contract", decision_kind: "deletion", priority: 50, summary: "b" });
    // Merging two different judgements into one card would present one decision for two
    // questions, which is the failure the batch rule is meant to avoid.
    assert.throws(() => f.queue.resolve({ item_ids: ["a", "b"], decision: "approved", decided_at: "2030-01-01T00:00:00Z",
      authorizations: [
        { item_id: "a", approved_by: "u1", receipt_digest: "sha256:a" },
        { item_id: "b", approved_by: "u1", receipt_digest: "sha256:b" }] }),
      /must contain items of the same kind and decision/);
  } finally { f.store.close(); }
});

test("decided items cannot be re-enqueued or re-resolved, and malformed input is refused by name", async () => {
  const f = await fixture();
  try {
    f.queue.enqueue(item("a", 50));
    // Re-enqueuing an open item updates it rather than creating a second card.
    const updated = f.queue.enqueue(item("a", 80));
    assert.equal(Number((updated.item as Record<string, unknown>).priority), 80);
    assert.equal((f.store.list("adjudication_item", 10) as unknown[]).length, 1);

    f.queue.resolve({ item_ids: ["a"], decision: "approved", decided_at: "2030-01-01T00:00:00Z",
      authorizations: [{ item_id: "a", approved_by: "u1", receipt_digest: "sha256:a" }] });
    assert.throws(() => f.queue.enqueue(item("a", 10)), /already decided/);
    assert.throws(() => f.queue.resolve({ item_ids: ["a"], decision: "approved", decided_at: "2030-01-01T00:00:00Z",
      authorizations: [{ item_id: "a", approved_by: "u1", receipt_digest: "sha256:a" }] }), /not open/);

    assert.throws(() => f.queue.enqueue(item("bad id!", 50)), /unsupported characters/);
    assert.throws(() => f.queue.enqueue(item("x", 50, { item_kind: "Bad Kind" })), /not a valid kind/);
    assert.throws(() => f.queue.enqueue(item("x", 101)), /priority must be an integer between 0 and 100/);
    assert.throws(() => f.queue.enqueue(item("x", 1.5)), /priority must be an integer/);
    assert.throws(() => f.queue.resolve({ item_ids: [], decision: "approved", decided_at: "2030-01-01T00:00:00Z", authorizations: [] }),
      /non-empty array/);
    assert.throws(() => f.queue.resolve({ item_ids: "a", decision: "approved", decided_at: "2030-01-01T00:00:00Z", authorizations: [] }),
      /must be a non-empty array/);
    f.queue.enqueue(item("dup", 10));
    assert.throws(() => f.queue.resolve({ item_ids: ["dup", "dup"], decision: "approved", decided_at: "2030-01-01T00:00:00Z",
      authorizations: [{ item_id: "dup", approved_by: "u", receipt_digest: "d" }] }), /unique values/);
    assert.throws(() => f.queue.resolve({ item_ids: ["dup"], decision: "maybe", decided_at: "2030-01-01T00:00:00Z",
      authorizations: [{ item_id: "dup", approved_by: "u", receipt_digest: "d" }] }), /decision is unsupported/);
    assert.throws(() => f.queue.resolve({ item_ids: ["dup"], decision: "approved", decided_at: "nope",
      authorizations: [{ item_id: "dup", approved_by: "u", receipt_digest: "d" }] }), /must be an ISO timestamp/);
    assert.throws(() => f.queue.resolve({ item_ids: ["dup"], decision: "approved", decided_at: "2030-01-01T00:00:00Z",
      authorizations: [] }), /non-empty array/);
    assert.throws(() => f.queue.resolve({ item_ids: ["dup"], decision: "approved", decided_at: "2030-01-01T00:00:00Z",
      authorizations: ["nope"] }), /authorizations\[0\] must be an object/);
    assert.throws(() => f.queue.resolve({ item_ids: ["dup"], decision: "approved", decided_at: "2030-01-01T00:00:00Z",
      authorizations: [{ item_id: "dup", approved_by: "u", receipt_digest: "d" },
        { item_id: "dup", approved_by: "u", receipt_digest: "d" }] }), /duplicate effect/);
    assert.throws(() => f.queue.resolve({ item_ids: ["dup"], decision: "approved", decided_at: "2030-01-01T00:00:00Z",
      authorizations: [{ item_id: "dup", receipt_digest: "d" }] }), /approved_by must not be empty/);
    assert.throws(() => f.queue.view({ limit: 0 }), /between 1 and 1000/);
    assert.deepEqual(f.queue.authorizations({ item_id: "none" }).authorizations, []);
  } finally { f.store.close(); }
});
