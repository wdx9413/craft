import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DecisionSurfaceKernel } from "../core/decision-surface.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "craft-surface-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { store, surface: new DecisionSurfaceKernel(store) };
}

const at = "2030-01-01T00:00:00Z";

test("each decision type renders in its own shape, not as a generic form", async () => {
  const f = await fixture();
  try {
    // 9.1's table, one row at a time. The shape comes from the decision, so the same object
    // gets a different interface for a different question.
    const cases: [string, string, string][] = [
      ["either_or", "side_by_side", "comparison"],
      ["threshold", "slider", "threshold_slider"],
      ["multi_field_check", "diff", "diff_view"],
      ["release", "receipt_summary", "release_summary"],
      ["parameter_tuning", "inline_controls", "inline_tuning"],
      ["completion", "structured_form", "field_form"],
    ];
    for (const [kind, shape, renderer] of cases) {
      const composed = f.surface.compose({ object_id: "o1", decision_kind: kind, summary: "decide this" });
      assert.equal(composed.rendered, true, kind);
      const control = composed.control as Record<string, unknown>;
      assert.equal(control.shape, shape, kind);
      assert.equal(control.renderer, renderer, kind);
    }
    // Two comparisons of the same kind are distinct surfaces when the summary differs.
    const a = f.surface.compose({ object_id: "o1", decision_kind: "either_or", summary: "pick one" });
    const b = f.surface.compose({ object_id: "o1", decision_kind: "either_or", summary: "pick another" });
    assert.notEqual(a.surface_id, b.surface_id);
    assert.equal((f.surface.get({ surface_id: String(a.surface_id) }).surface as Record<string, unknown>).shape, "side_by_side");
    // Composing the identical decision again is the same surface, not a second one.
    assert.equal(a.idempotent, false);
    assert.equal(f.surface.compose({ object_id: "o1", decision_kind: "either_or", summary: "pick one" }).idempotent, true);
    // The same explicit id for a different object is a conflict: the id is a claim about
    // which surface this is.
    assert.throws(() => f.surface.compose({ object_id: "o2", decision_kind: "either_or", summary: "pick one",
      surface_id: String(a.surface_id) }), /Decision surface idempotency conflict/);
  } finally { f.store.close(); }
});

test("an unregistered decision kind is refused rather than falling back to a form", async () => {
  const f = await fixture();
  try {
    // Falling back to a generic form is the schema mapping returning through the back door,
    // and it would happen exactly for the decisions nobody thought about.
    assert.throws(() => f.surface.compose({ object_id: "o1", decision_kind: "unknown_kind", summary: "s" }),
      /decision_kind is not registered: unknown_kind/);
    assert.throws(() => f.surface.compose({ object_id: "o1", decision_kind: "Bad Kind", summary: "s" }), /unsupported characters/);
    assert.throws(() => f.surface.compose({ object_id: "o1", decision_kind: "either_or" }), /summary must not be empty/);
    // An extra kind is injected per instance, so it cannot change what another caller's
    // unknown-kind check accepts.
    const extended = new DecisionSurfaceKernel(f.store, {
      license_choice: { shape: "side_by_side", renderer: "comparison", description: "Pick a license" },
    });
    assert.equal((extended.compose({ object_id: "o1", decision_kind: "license_choice", summary: "s" }).control as Record<string, unknown>).shape,
      "side_by_side");
    assert.equal((extended.shapes().shapes as unknown[]).length, 7);
    // The base instance is unaffected.
    assert.equal((f.surface.shapes().shapes as unknown[]).length, 6);
    assert.throws(() => f.surface.compose({ object_id: "o1", decision_kind: "license_choice", summary: "s" }),
      /decision_kind is not registered/);
  } finally { f.store.close(); }
});

test("the three-second rule is a test that can refuse a card", async () => {
  const f = await fixture();
  try {
    // A control inside the budget renders.
    const small = f.surface.compose({ object_id: "o1", decision_kind: "either_or", summary: "pick",
      options: [{ id: "a", label: "keep" }, { id: "b", label: "drop" }] });
    assert.equal(small.rendered, true);
    assert.equal((small.measurement as Record<string, unknown>).scannable, true);
    assert.equal((small.measurement as Record<string, unknown>).failed_because, null);

    // Too many lines to scan: it is a deliverable file, not a control. This is the rule
    // being executable — "一眼扫完" cannot否掉一张卡片, "不滚动" can.
    const many = f.surface.compose({ object_id: "o1", decision_kind: "multi_field_check", summary: "review",
      fields: Array.from({ length: 14 }, (_, index) => ({ name: `f${index}`, label: `field ${index}`, value_kind: "text" })) });
    assert.equal(many.rendered, false);
    assert.equal(many.reason, "exceeds_scan_budget");
    assert.equal(many.is_deliverable_not_control, true);
    assert.equal(many.control, null);
    assert.equal((many.measurement as Record<string, unknown>).failed_because, "too_many_lines");

    // A comparison whose options are too wide to see at once defeats the side-by-side shape
    // even though it fits in the line budget.
    const wide = f.surface.compose({ object_id: "o1", decision_kind: "either_or", summary: "pick",
      options: [{ id: "a", label: "x".repeat(120), detail: "y".repeat(80) }, { id: "b", label: "drop" }] });
    assert.equal(wide.rendered, false);
    assert.equal((wide.measurement as Record<string, unknown>).failed_because, "options_too_wide_to_compare");

    // Even a refused card keeps its anchors: the object and its evidence are the stable frame.
    assert.equal((many.anchors as Record<string, unknown>).anchor_kinds !== undefined, true);
  } finally { f.store.close(); }
});

test("exposure is staged, and the first level caps the actions", async () => {
  const f = await fixture();
  try {
    // 9.4: level one is one conclusion and one or two actions. A release derives level two
    // because its receipt summary is itself the evidence, but its controls are still capped
    // at the level-one action budget.
    const first = f.surface.compose({ object_id: "o1", decision_kind: "release", summary: "release it",
      exposure: 1,
      actions: [{ id: "a" }, { id: "b" }, { id: "c" }].map((entry, index) => ({ ...entry, label: `action ${index}` })) });
    assert.equal(first.exposure, 1);
    assert.equal(((first.control as Record<string, unknown>).actions as unknown[]).length, 2);
    // Without an explicit level, a release opens at level two so the summary can be read.
    assert.equal(f.surface.compose({ object_id: "o1", decision_kind: "release", summary: "release it" }).exposure, 2);

    // Fields imply the in-place editing level; options imply the evidence level.
    assert.equal(f.surface.compose({ object_id: "o1", decision_kind: "completion", summary: "fill",
      fields: [{ name: "target", label: "Target", value_kind: "text" }] }).exposure, 3);
    assert.equal(f.surface.compose({ object_id: "o1", decision_kind: "either_or", summary: "pick",
      options: [{ id: "a", label: "x" }, { id: "b", label: "y" }] }).exposure, 2);
    assert.equal(f.surface.compose({ object_id: "o1", decision_kind: "release", summary: "s" }).exposure, 2);
    assert.equal(f.surface.compose({ object_id: "o1", decision_kind: "threshold", summary: "s" }).exposure, 1);

    // An explicit level is honoured, and at higher levels more actions are allowed.
    const explicit = f.surface.compose({ object_id: "o1", decision_kind: "threshold", summary: "tune", exposure: 3,
      actions: Array.from({ length: 5 }, (_, index) => ({ id: `a${index}`, label: `a${index}` })) });
    assert.equal(explicit.exposure, 3);
    assert.equal(((explicit.control as Record<string, unknown>).actions as unknown[]).length, 5);
    assert.throws(() => f.surface.compose({ object_id: "o1", decision_kind: "threshold", summary: "s", exposure: 4 }),
      /exposure must be 1, 2 or 3/);
  } finally { f.store.close(); }
});

test("anchors are fixed and generated controls are discardable", async () => {
  const f = await fixture();
  try {
    f.store.create("hatched_object", "o1", { object_kind: "migration", origin: "human", intention: "migrate",
      fields: { target: "jackson" }, pending_fields: [], state: "ready", hatched_at: at });
    f.store.create("evidence_receipt", "r1", { object_id: "o1", action_executed: "check", risk_level: "R0" });

    const composed = f.surface.compose({ object_id: "o1", decision_kind: "either_or", summary: "pick",
      options: [{ id: "a", label: "x" }, { id: "b", label: "y" }] });
    const anchors = composed.anchors as Record<string, unknown>;
    // 9.3: the frame is the object, its history, its evidence and the ledger — named so the
    // panel keeps the same shape across objects.
    assert.deepEqual(anchors.anchor_kinds, ["object", "history", "evidence", "ledger"]);
    assert.equal(anchors.evidence_count, 1);
    assert.equal((anchors.object as Record<string, unknown>).title, "migrate");

    // The surface records that it is generated while its anchors are fixed.
    const stored = f.surface.get({ surface_id: String(composed.surface_id) }).surface as Record<string, unknown>;
    assert.equal(stored.generated, true);
    assert.equal(stored.anchors_fixed, true);
    // 9.3: generated elements are used up and destroyed; anchors have no such call.
    const discarded = f.surface.discard({ surface_id: String(composed.surface_id), discarded_at: at });
    assert.equal((discarded.surface as Record<string, unknown>).generated, false);
    assert.equal((discarded.surface as Record<string, unknown>).discarded_at, at);

    // An object that does not exist still yields anchors, with a null object rather than a
    // failure: the frame is stable even before the object is created.
    const ghost = f.surface.compose({ object_id: "ghost", decision_kind: "threshold", summary: "s" });
    assert.equal((ghost.anchors as Record<string, unknown>).object, null);
    assert.equal((ghost.anchors as Record<string, unknown>).evidence_count, 0);
  } finally { f.store.close(); }
});

test("malformed input is refused by name", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.surface.compose({ object_id: "bad id!", decision_kind: "either_or", summary: "s" }), /unsupported characters/);
    assert.throws(() => f.surface.compose({ object_id: "o1", decision_kind: "either_or", summary: "s", options: "x" }),
      /options must be an array of at least two entries/);
    // One option is not a choice.
    assert.throws(() => f.surface.compose({ object_id: "o1", decision_kind: "either_or", summary: "s",
      options: [{ id: "a", label: "x" }] }), /at least two entries/);
    assert.throws(() => f.surface.compose({ object_id: "o1", decision_kind: "either_or", summary: "s",
      options: [{ id: "a", label: "x" }, { id: "bad id!", label: "y" }] }), /unsupported characters/);
    assert.throws(() => f.surface.compose({ object_id: "o1", decision_kind: "either_or", summary: "s",
      options: [{ id: "a", label: "x" }, { id: "b" }] }), /label must not be empty/);
    assert.throws(() => f.surface.compose({ object_id: "o1", decision_kind: "completion", summary: "s", fields: "x" }),
      /fields must be an array/);
    assert.throws(() => f.surface.compose({ object_id: "o1", decision_kind: "completion", summary: "s",
      fields: [{ name: "a", label: "A", value_kind: "bogus" }] }), /must be text, number, boolean or choice/);
    assert.throws(() => f.surface.compose({ object_id: "o1", decision_kind: "completion", summary: "s",
      fields: [{ name: "bad id!", label: "A", value_kind: "text" }] }), /unsupported characters/);
    assert.throws(() => f.surface.compose({ object_id: "o1", decision_kind: "threshold", summary: "s", actions: "x" }),
      /actions must be an array/);
    assert.throws(() => f.surface.compose({ object_id: "o1", decision_kind: "threshold", summary: "s",
      actions: [{ id: "a" }] }), /label must not be empty/);
    assert.throws(() => f.surface.compose({ object_id: "o1", decision_kind: "threshold", summary: "s", surface_id: "bad id!" }),
      /unsupported characters/);
    assert.throws(() => f.surface.get({ surface_id: "missing" }), /Unknown decision_surface/);
    assert.throws(() => f.surface.discard({ surface_id: "bad id!", discarded_at: at }), /unsupported characters/);
    // An explicit surface id is honoured.
    const named = f.surface.compose({ object_id: "o1", decision_kind: "threshold", summary: "s", surface_id: "surface_named" });
    assert.equal(named.surface_id, "surface_named");
  } finally { f.store.close(); }
});
