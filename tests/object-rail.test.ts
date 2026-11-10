import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { ObjectRailKernel } from "../core/object-rail.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "craft-rail-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { store, rail: new ObjectRailKernel(store) };
}

const at = "2030-01-01T00:00:00Z";
const object = (store: CraftStore, id: string, over: Record<string, unknown> = {}) =>
  store.create("hatched_object", id, { object_kind: "migration", origin: "human", intention: `work ${id}`,
    fields: {}, pending_fields: [], state: "hatched", hatched_at: at, ...over });
const adjudication = (store: CraftStore, id: string, itemId: string, priorityValue: number, over: Record<string, unknown> = {}) =>
  store.create("adjudication_item", id, { item_id: itemId, item_kind: "contract", decision_kind: "interface_change",
    priority: priorityValue, summary: `card ${id}`, status: "open", batch_key: "contract|interface_change", ...over });

test("the rail orders by bucket, then priority, then id", async () => {
  const f = await fixture();
  try {
    // Three states at once: something that needs the person, something running, something done.
    object(f.store, "done1", { state: "released" });
    object(f.store, "running1", { state: "hatched" });
    object(f.store, "needs1");
    adjudication(f.store, "adj1", "needs1", 90);
    object(f.store, "needs2");
    adjudication(f.store, "adj2", "needs2", 50);

    const view = f.rail.view({});
    assert.deepEqual((view.rail as Record<string, unknown>[]).map((item) => item.id), ["needs1", "needs2", "running1", "done1"]);
    assert.deepEqual(view.counts, { needs_you: 2, in_progress: 1, done: 1, total: 4 });
    // Only the needing items are marked; the plan says the rest must not compete.
    assert.deepEqual((view.rail as Record<string, unknown>[]).filter((item) => item.marked).map((item) => item.id), ["needs1", "needs2"]);

    // The centre follows the rail head when nothing is selected, so the page never opens
    // on an empty selection while something does need the person.
    assert.equal((view.focus as Record<string, unknown>).id, "needs1");
    // Selecting explicitly moves the centre without reordering the rail.
    const other = f.rail.view({ object_id: "running1" });
    assert.equal((other.focus as Record<string, unknown>).id, "running1");
    assert.deepEqual((other.rail as Record<string, unknown>[]).map((item) => item.id), ["needs1", "needs2", "running1", "done1"]);
  } finally { f.store.close(); }
});

test("a tie in priority is broken by id so the rail never reorders", async () => {
  const f = await fixture();
  try {
    object(f.store, "b");
    object(f.store, "a");
    object(f.store, "c");
    for (const id of ["a", "b", "c"]) adjudication(f.store, `adj-${id}`, id, 40);
    // Same bucket and same priority: only the id can decide, and it decides the same way
    // on every render.
    const first = f.rail.view({});
    const second = f.rail.view({});
    assert.deepEqual((first.rail as Record<string, unknown>[]).map((item) => item.id), ["a", "b", "c"]);
    assert.deepEqual((first.rail as Record<string, unknown>[]).map((item) => item.id),
      (second.rail as Record<string, unknown>[]).map((item) => item.id));
  } finally { f.store.close(); }
});

test("at most one card occupies the centre, and a same-kind group reports its effect count", async () => {
  const f = await fixture();
  try {
    object(f.store, "svc");
    // Three effects behind one card, plus a lower-priority unrelated decision.
    adjudication(f.store, "adj-a", "svc", 90);
    adjudication(f.store, "adj-b", "svc", 90);
    adjudication(f.store, "adj-c", "svc", 90);
    adjudication(f.store, "adj-other", "svc2", 10, { batch_key: "contract|deletion" });
    object(f.store, "svc2");

    const focus = f.rail.view({ object_id: "svc" }).focus as Record<string, unknown>;
    const card = focus.adjudication as Record<string, unknown>;
    // The highest-priority card is the one shown; the rest are a count, not a queue.
    assert.equal(card.id, "adj-a");
    assert.equal(card.batch_effects, 3);
    assert.deepEqual(card.batch_item_ids, ["adj-a", "adj-b", "adj-c"]);
    assert.equal(focus.waiting_adjudications, 2);

    // An object with no open adjudication shows no card at all.
    object(f.store, "quiet");
    assert.equal(f.rail.view({ object_id: "quiet" }).focus === null ? null
      : (f.rail.view({ object_id: "quiet" }).focus as Record<string, unknown>).adjudication, null);
  } finally { f.store.close(); }
});

test("an object awaiting fields needs the person even without an adjudication", async () => {
  const f = await fixture();
  try {
    // 5.3's structured completion is a "needs you" state: the object cannot proceed until
    // a named field is supplied.
    object(f.store, "blocked", { state: "awaiting_fields", pending_fields: ["target_framework"] });
    const view = f.rail.view({});
    assert.equal((view.rail as Record<string, unknown>[])[0]!.bucket, "needs_you");
    assert.deepEqual((view.rail as Record<string, unknown>[])[0]!.awaiting_fields, ["target_framework"]);
    assert.deepEqual((view.focus as Record<string, unknown>).pending_fields, ["target_framework"]);
  } finally { f.store.close(); }
});

test("work that arrived as a task also appears on the rail", async () => {
  const f = await fixture();
  try {
    // The rail answers "where are my things", not "where are my hatched things".
    f.store.create("task", "task1", { title: "Investigate the offset gap", goal: "g", status: "running", created_at: at });
    object(f.store, "hatched1");
    const ids = (f.rail.view({}).rail as Record<string, unknown>[]).map((item) => item.id).sort();
    assert.deepEqual(ids, ["hatched1", "task1"]);
    const task = (f.rail.view({}).rail as Record<string, unknown>[]).find((item) => item.id === "task1")!;
    assert.equal(task.kind, "task");
    assert.equal(task.bucket, "in_progress");
  } finally { f.store.close(); }
});

test("evidence reports the conclusion, the raw values and the transcription dependency", async () => {
  const f = await fixture();
  try {
    f.store.create("evidence_receipt", "r1", { object_id: "obj1", action_executed: "SYNC", risk_level: "R2",
      recomputable: true, l1_eligible: true, l1_reason: "machine_observed", transcription_metrics: [],
      pre_state: { values: { offset_delay: 1200 } }, post_state: { values: { offset_delay: 0 } },
      proofs: [{ type: "BINLOG", value: "mysql-bin.000142:49012" }], created_at: at });
    f.store.create("evidence_receipt", "r2", { object_id: "obj1", action_executed: "SYNC", risk_level: "R2",
      recomputable: true, l1_eligible: false, l1_reason: "human_transcription_requires_cross_check",
      transcription_metrics: ["pre_state.offset_delay"], pre_state: { values: { offset_delay: 1200 } },
      post_state: { values: { offset_delay: 0 } }, proofs: [], created_at: "2030-01-02T00:00:00Z" });
    f.store.create("effect_authorization", "a1", { effect_id: "obj1", approved_by: "u1", authorized_at: at,
      status: "authorized", risk_level: "R2", receipt_digest: `sha256:${"a".repeat(64)}` });

    const evidence = f.rail.evidence({ object_id: "obj1" });
    const summary = evidence.summary as Record<string, unknown>;
    assert.equal(summary.receipt_count, 2);
    assert.equal(summary.recomputable_count, 2);
    // The 11.5 distinction is visible at the summary level, not buried per receipt.
    assert.equal(summary.transcribed_count, 1);
    assert.equal(summary.authorization_count, 1);
    // Newest first, so the most recent conclusion is read first.
    assert.deepEqual((evidence.receipts as Record<string, unknown>[]).map((item) => item.id), ["r2", "r1"]);
    assert.deepEqual((evidence.authorizations as Record<string, unknown>[])[0]!.approved_by, "u1");

    // An object with nothing recorded reports zeroes rather than failing.
    const empty = f.rail.evidence({ object_id: "obj-none" });
    assert.equal((empty.summary as Record<string, unknown>).receipt_count, 0);
    assert.deepEqual(empty.receipts, []);
    assert.deepEqual(empty.authorizations, []);
  } finally { f.store.close(); }
});

test("the receipt detail exposes the recomputation path and what could not be compared", async () => {
  const f = await fixture();
  try {
    f.store.create("evidence_receipt", "r1", { object_id: "obj1", action_executed: "SYNC", risk_level: "R2",
      recomputable: true, l1_eligible: true, l1_reason: "machine_observed", transcription_metrics: [],
      pre_state: { values: { offset_delay: 1200, partition_count: 8 } }, post_state: { values: { offset_delay: 0, extra: 3 } },
      created_at: at });
    const detail = f.rail.receiptDetail({ receipt_id: "r1" });
    // The arithmetic a third party would redo by hand.
    assert.deepEqual(detail.steps, [{ metric: "offset_delay", pre: 1200, post: 0, delta: -1200 }]);
    // A metric seen on only one side is reported, never treated as zero.
    assert.deepEqual((detail.uncomparable as Record<string, unknown>[]).map((item) => item.metric).sort(), ["extra", "partition_count"]);
    // With an uncomparable metric the receipt is not recomputable, which is the honest
    // answer rather than the stored flag.
    assert.equal(detail.recomputable, false);
    assert.equal(detail.l1_eligible, true);
  } finally { f.store.close(); }
});

test("a metric present on both sides makes the receipt recomputable", async () => {
  const f = await fixture();
  try {
    f.store.create("evidence_receipt", "r1", { object_id: "obj1", action_executed: "SYNC", risk_level: "R0",
      recomputable: true, l1_eligible: true, l1_reason: "machine_observed", transcription_metrics: [],
      pre_state: { values: { offset_delay: 5 } }, post_state: { values: { offset_delay: 0 } }, created_at: at });
    const detail = f.rail.receiptDetail({ receipt_id: "r1" });
    assert.equal(detail.recomputable, true);
    assert.deepEqual(detail.uncomparable, []);
    assert.deepEqual(detail.steps, [{ metric: "offset_delay", pre: 5, post: 0, delta: -5 }]);
  } finally { f.store.close(); }
});

test("malformed input is refused by name", async () => {
  const f = await fixture();
  try {
    object(f.store, "obj1");
    f.store.create("evidence_receipt", "r1", { object_id: "obj1", action_executed: "SYNC", risk_level: "R0",
      recomputable: true, l1_eligible: true, transcription_metrics: [], pre_state: { values: { m: 1 } },
      post_state: { values: { m: 0 } }, created_at: at });

    assert.throws(() => f.rail.view({ object_id: "bad id!" }), /unsupported characters/);
    assert.throws(() => f.rail.view({ limit: 0 }), /between 1 and 1000/);
    assert.throws(() => f.rail.view({ limit: 1.5 }), /between 1 and 1000/);
    assert.throws(() => f.rail.view({ limit: 5_000 }), /between 1 and 1000/);
    assert.throws(() => f.rail.evidence({ object_id: "bad id!" }), /unsupported characters/);
    assert.throws(() => f.rail.receiptDetail({ receipt_id: "bad id!" }), /unsupported characters/);
    assert.throws(() => f.rail.receiptDetail({ receipt_id: "missing" }), /Unknown evidence_receipt/);

    // An empty rail reports null counts and a null focus rather than fabricating an object.
    const empty = new ObjectRailKernel(f.store);
    assert.equal(empty.view({}).focus === null || (empty.view({}).focus as Record<string, unknown>).id !== null, true);
    assert.throws(() => empty.view({ limit: 0 }), /between 1 and 1000/);
  } finally { f.store.close(); }
});

test("records written without the optional fields fall back rather than rendering undefined", async () => {
  const f = await fixture();
  try {
    // Rows reach the rail from several code paths, so every optional field has a default.
    // A missing one must render as something a person can read, never as "undefined".
    f.store.create("hatched_object", "bare", { object_kind: "migration", state: "hatched" });
    f.store.create("task", "bareTask", { status: "running" });
    f.store.create("evidence_receipt", "bareReceipt", { object_id: "bare", action_executed: "SYNC", risk_level: "R0" });
    f.store.create("effect_authorization", "bareAuth", { effect_id: "bare", approved_by: "u1", authorized_at: at,
      status: "authorized", risk_level: "R0", receipt_digest: `sha256:${"b".repeat(64)}` });

    const view = f.rail.view({});
    const bare = (view.rail as Record<string, unknown>[]).find((item) => item.id === "bare")!;
    // No intention: the id is the label rather than an empty row.
    assert.equal(bare.title, "bare");
    // `updated_at` is store-managed and always stamped, so it is never blank.
    assert.equal(typeof bare.updated_at, "string");
    assert.notEqual(bare.updated_at, "");
    // No origin on the record: it falls back to the event-originated default.
    assert.equal(bare.origin, "event");
    // No pending_fields: an empty list, not undefined.
    assert.deepEqual(bare.awaiting_fields, []);

    const task = (view.rail as Record<string, unknown>[]).find((item) => item.id === "bareTask")!;
    // No title and no goal: the id carries the row.
    assert.equal(task.title, "bareTask");

    const evidence = f.rail.evidence({ object_id: "bare" });
    const receipt = (evidence.receipts as Record<string, unknown>[])[0]!;
    assert.equal(receipt.l1_reason, null);
    assert.deepEqual(receipt.transcription_metrics, []);
    assert.deepEqual(receipt.proofs, []);
    assert.equal(typeof receipt.created_at, "string");
    // A receipt with no transcription_metrics must not count as transcribed.
    assert.equal((evidence.summary as Record<string, unknown>).transcribed_count, 0);
    // And a receipt with no pre/post state has nothing to compare.
    assert.deepEqual(f.rail.receiptDetail({ receipt_id: "bareReceipt" }).steps, []);
    assert.equal(f.rail.receiptDetail({ receipt_id: "bareReceipt" }).recomputable, false);
  } finally { f.store.close(); }
});

test("the mobile projection returns one decision and no rail", async () => {
  const f = await fixture();
  try {
    // 12: 手机上不该有「工作台」，只有「有事找你」。So nothing to decide means an explicit
    // message rather than a list.
    const empty = f.rail.mobileProjection({});
    assert.equal(empty.projection, "mobile");
    assert.equal(empty.decision, null);
    assert.equal(empty.message, "nothing_needs_you");

    // Work in progress does not reach the phone: nobody watches progress from a lock screen.
    object(f.store, "running", { state: "hatched" });
    assert.equal(f.rail.mobileProjection({}).decision, null);

    // A decision does, and there is exactly one of them however many are queued.
    object(f.store, "a");
    object(f.store, "b");
    adjudication(f.store, "adj-a", "a", 40);
    adjudication(f.store, "adj-b", "b", 90);
    const one = f.rail.mobileProjection({});
    assert.equal((one.decision as Record<string, unknown>).object_id, "b");
    assert.equal(one.waiting_on_you, 2);
    assert.equal(one.message, null);
    // The projection carries no rail at all — rendering a list on a phone is the
    // layout-scaling the plan rejects.
    assert.equal((one as Record<string, unknown>).rail, undefined);
    assert.equal(((one.decision as Record<string, unknown>).adjudication as Record<string, unknown>).id, "adj-b");

    // An object waiting on a field is actionable on the phone too, with no card.
    object(f.store, "blocked", { state: "awaiting_fields", pending_fields: ["target"] });
    f.store.save("adjudication_item", "adj-a", { ...f.store.get("adjudication_item", "adj-a"), status: "decided" });
    f.store.save("adjudication_item", "adj-b", { ...f.store.get("adjudication_item", "adj-b"), status: "decided" });
    const fieldItem = f.rail.mobileProjection({});
    assert.equal((fieldItem.decision as Record<string, unknown>).object_id, "blocked");
    assert.deepEqual((fieldItem.decision as Record<string, unknown>).pending_fields, ["target"]);
    assert.equal((fieldItem.decision as Record<string, unknown>).adjudication, null);
  } finally { f.store.close(); }
});

test("an empty store yields an empty rail with a null focus", async () => {
  const f = await fixture();
  try {
    const view = f.rail.view({});
    assert.deepEqual(view.rail, []);
    assert.deepEqual(view.counts, { needs_you: 0, in_progress: 0, done: 0, total: 0 });
    // Nothing to focus on: null, not a fabricated empty object.
    assert.equal(view.focus, null);
    // An explicit selection for an unknown object still renders, with an unknown kind.
    const ghost = f.rail.view({ object_id: "ghost" });
    assert.equal((ghost.focus as Record<string, unknown>).kind, "unknown");
    assert.equal((ghost.focus as Record<string, unknown>).title, "ghost");
    assert.deepEqual((ghost.focus as Record<string, unknown>).fields, {});
    assert.equal((ghost.focus as Record<string, unknown>).intention, null);
    assert.equal((ghost.focus as Record<string, unknown>).adjudication, null);
  } finally { f.store.close(); }
});
