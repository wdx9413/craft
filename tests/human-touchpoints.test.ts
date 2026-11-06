import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { HumanTouchpointKernel } from "../core/human-touchpoints.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "craft-ht-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { store, ht: new HumanTouchpointKernel(store) };
}

test("only decisions, inputs and hand-carried data count, and clicks do not exist here", async () => {
  const f = await fixture();
  try {
    const first = f.ht.record({ object_id: "o1", kind: "decision", label: "放行裁决", at: "2030-01-01T00:00:00Z" });
    f.ht.record({ object_id: "o1", kind: "input", label: "初始意图", at: "2030-01-01T00:01:00Z" });
    // 3.3's correction: carrying a number across systems is an information transfer, so it
    // counts — "人类沦为剪贴板总线" is exactly what the metric must not hide.
    const carried = f.ht.record({ object_id: "o1", kind: "data_transfer", label: "抄位点", at: "2030-01-01T00:02:00Z" });
    assert.equal((carried.touchpoint as Record<string, unknown>).manual_data, true);
    assert.equal((first.touchpoint as Record<string, unknown>).manual_data, false);

    // Repeating the same touchpoint is idempotent, so the denominator cannot be inflated.
    assert.equal(f.ht.record({ object_id: "o1", kind: "decision", label: "放行裁决", at: "2030-01-01T00:00:00Z" }).idempotent, true);

    assert.throws(() => f.ht.record({ object_id: "o1", kind: "click", label: "x", at: "2030-01-01T00:00:00Z" }),
      /kind must be decision, input or data_transfer/);
    assert.throws(() => f.ht.record({ object_id: "bad id!", kind: "decision", label: "x", at: "2030-01-01T00:00:00Z" }),
      /unsupported characters/);
    assert.throws(() => f.ht.record({ object_id: "o1", kind: "decision", label: "x", at: "nope" }),
      /must be an ISO timestamp/);
  } finally { f.store.close(); }
});

test("the denominator is the object, and the three paths separate", async () => {
  const f = await fixture();
  try {
    // 手工 ≈ 6：the plan's own baseline.
    const manual = ["decision", "input", "data_transfer", "decision", "input", "data_transfer"];
    manual.forEach((kind, index) => f.ht.record({ object_id: "manual_obj", kind, label: kind,
      at: new Date(Date.parse("2030-01-01T00:00:00Z") + index * 1000).toISOString() }));
    // 半自动 ≈ 2：intent + release.
    f.ht.record({ object_id: "semi_obj", kind: "input", label: "意图", at: "2030-01-02T00:00:00Z" });
    f.ht.record({ object_id: "semi_obj", kind: "decision", label: "放行", at: "2030-01-02T00:05:00Z" });
    // 全自动 ≈ 0：an event-driven object with no touchpoints at all. There is nothing to
    // record, so the report classifies it without any rows existing.
    // The report separates the paths, which is 3.3's validity test for the metric.
    const report = f.ht.report({});
    assert.equal(report.objects_measured, 2, "auto_obj has no rows, so it is not counted");
    const byPath = report.by_path as Record<string, number>;
    assert.equal(byPath.manual, 1);
    assert.equal(byPath.semi_automatic, 1);

    // The plan's own baseline: manual ≈ 6 with two hand-carried transfers.
    const one = f.ht.objectReport({ object_id: "manual_obj" });
    assert.equal(one.total, 6);
    assert.equal(one.path, "manual");
    assert.equal(one.data_transfers, 2);
    // 3.3: HT down is not reliability up — the caveat rides on the payload.
    assert.equal(one.lower_ht_is_not_higher_reliability, true);

    // 半自动 ≈ 2：intent + release.
    const semi = f.ht.objectReport({ object_id: "semi_obj" });
    assert.equal(semi.total, 2);
    assert.equal(semi.path, "semi_automatic");
  } finally { f.store.close(); }
});

test("HT never travels without the wall-clock", async () => {
  const f = await fixture();
  try {
    // 3.3: logging into a portal costs zero HT but eight minutes. HT alone would call that
    // progress, so the clock is mandatory in the same payload.
    f.ht.record({ object_id: "o1", kind: "decision", label: "a", at: "2030-01-01T00:00:00Z" });
    f.ht.record({ object_id: "o1", kind: "decision", label: "b", at: "2030-01-01T00:08:00Z" });
    const report = f.ht.report({});
    const row = (report.per_object as Record<string, unknown>[])[0]!;
    assert.equal(row.total, 2);
    assert.equal(row.wall_clock_ms, 8 * 60 * 1000);
    assert.equal(row.first_touchpoint, "2030-01-01T00:00:00.000Z");
    assert.equal(row.last_touchpoint, "2030-01-01T00:08:00.000Z");
    assert.equal(report.ht_requires_wall_clock, true);
    assert.equal(report.l1_ratio_requires_checker_count, true);
    // The checker count rides along for the same reason 4.6 pairs it with the L1 ratio.
    assert.equal(report.deterministic_checkers, 0);
    assert.equal(report.note, "report_ht_and_wall_clock_together");

    // Nothing measured reports null separability rather than a confident zero. A fresh store
    // is used because this is about the empty state, not about o1's rows.
    const freshRoot = await mkdtemp(path.join(tmpdir(), "craft-ht-empty-"));
    const freshStore = await new CraftStore(craftPaths(freshRoot)).open();
    try {
      const empty = new HumanTouchpointKernel(freshStore).report({});
      assert.equal(empty.objects_measured, 0);
      assert.equal(empty.path_separable, null);
      assert.equal(empty.note, "nothing_measured_yet");
    } finally { freshStore.close(); }
  } finally { f.store.close(); }
});

test("transcription exposure is read from the receipts, not asserted", async () => {
  const f = await fixture();
  try {
    // 11.5: the semi-automatic path moves the error from arithmetic to transcription, so the
    // HT report must surface whether this object's evidence rests on hand-carried values.
    f.store.create("evidence_receipt", "r1", { object_id: "o1", action_executed: "SYNC", risk_level: "R2",
      recomputable: true, l1_eligible: false, l1_reason: "human_transcription_requires_cross_check",
      transcription_metrics: ["pre_state.offset_delay"] });
    f.store.create("evidence_receipt", "r2", { object_id: "o1", action_executed: "SYNC", risk_level: "R2",
      recomputable: true, l1_eligible: true, l1_reason: "machine_observed", transcription_metrics: [] });

    const one = f.ht.objectReport({ object_id: "o1" });
    assert.deepEqual(one.transcription_exposure, { receipts_with_transcription: 1, receipts_total: 2 });

    // A receipt written without the field at all — an older record, or one from a path that
    // predates 11.5 — is read as "no transcription" rather than crashing the report.
    f.store.create("evidence_receipt", "r3", { object_id: "o1", action_executed: "SYNC", risk_level: "R0" });
    assert.deepEqual(f.ht.objectReport({ object_id: "o1" }).transcription_exposure,
      { receipts_with_transcription: 1, receipts_total: 3 });

    // An object with no receipts reports zeros, not undefined.
    assert.deepEqual(f.ht.objectReport({ object_id: "none" }).transcription_exposure,
      { receipts_with_transcription: 0, receipts_total: 0 });
    assert.throws(() => f.ht.objectReport({ object_id: "bad id!" }), /unsupported characters/);
  } finally { f.store.close(); }
});

test("an explicit touchpoint id is honoured, and the report pairs with the checker count", async () => {
  const f = await fixture();
  try {
    const named = f.ht.record({ touchpoint_id: "ht_named", object_id: "o1", kind: "decision",
      label: "explicit", at: "2030-01-01T00:00:00Z" });
    assert.equal((named.touchpoint as Record<string, unknown>).id, "ht_named");
    // Reusing the same explicit id is idempotent rather than a duplicate row.
    assert.equal(f.ht.record({ touchpoint_id: "ht_named", object_id: "o1", kind: "decision",
      label: "explicit", at: "2030-01-01T00:00:00Z" }).idempotent, true);

    // The checker count in the report reflects what is attached (4.6's pairing discipline).
    f.store.create("capability_action", "checker_a", { access_kind: "api_mcp" });
    f.store.create("capability_action", "script_c", { access_kind: "gui_automation" });
    assert.equal(f.ht.report({}).deterministic_checkers, 1);
    assert.equal(f.ht.report({}).ht_requires_wall_clock, true);
  } finally { f.store.close(); }
});
