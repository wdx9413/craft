import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compact, compactWithPromotion } from "../src/compaction.ts";
import { ContextProjectionKernel } from "../src/context-projection.ts";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { StateViewKernel } from "../src/state-view.ts";

/**
 * The validation and edge branches of the compaction policy, the durable projection, and the state
 * view.
 *
 * A policy module is mostly conditions, and a condition nobody exercises is a rule nobody has
 * checked. These are the refusals — a bad budget, an unsupported estimator, a duplicate id, a
 * session that was never written — and the small edges where a default decides the answer.
 */

const ONE = (value: string): number => Math.max(1, Math.ceil(value.length / 4));
const seg = (id: string, content = "x", weight?: number): { id: string; role: string; content: string; weight?: number } =>
  ({ id, role: "user", content, ...(weight === undefined ? {} : { weight }) });

test("v0.12.43 refuses a compaction request it cannot honour", () => {
  const segments = [seg("a")];
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => compact({ segments, max_tokens: bad }), /max_tokens must be a positive integer/u, String(bad));
  }
  for (const bad of [-0.1, 1.1, Number.NaN]) {
    assert.throws(() => compact({ segments, max_tokens: 10, tail_share: bad }), /tail_share must be between 0 and 1/u, String(bad));
  }
  assert.throws(() => compact({ segments: "no" as unknown as never[], max_tokens: 10 }), /segments must be an array/u);
  assert.throws(() => compact({ segments, max_tokens: 10, estimate: "no" as unknown as (v: string) => number }), /requires a token estimator/u);
  // Duplicate ids would make "which segment is this" ambiguous, and therefore restore ambiguous too.
  assert.throws(() => compact({ segments: [seg("a"), seg("a")], max_tokens: 10 }), /segment ids must be unique/u);
  // A cost that is not a usable number is refused rather than silently treated as free.
  assert.throws(() => compact({ segments: [{ id: "a", content: "x", tokens: Number.NaN }], max_tokens: 10 }), /invalid token cost/u);
  assert.throws(() => compact({ segments: [{ id: "a", content: "x", tokens: -1 }], max_tokens: 10 }), /invalid token cost/u);
  // Both spellings of cost are accepted: pre-computed, and estimated when absent.
  assert.equal(compact({ segments: [{ id: "a", content: "aaaa", tokens: 7 }], max_tokens: 7 }).tokens, 7);
  assert.equal(compact({ segments: [seg("a", "aaaa")], max_tokens: 7, estimate: ONE }).tokens, 1);
  // A segment with no weight is weight 1, so an unweighted set is ordered by recency alone.
  assert.deepEqual(compact({ segments: [seg("a"), seg("b")], max_tokens: 1, estimate: () => 1 }).kept, ["b"]);
  // A segment with no `content` at all costs the estimate of the empty string rather than crashing,
  // because the policy's job is the budget and `content` is one caller's choice of field.
  const contentless = compact({ segments: [{ id: "a" }, { id: "b", content: "bbbb" }] as unknown as never[], max_tokens: 30, estimate: ONE });
  assert.deepEqual(contentless.kept, ["a", "b"]);
  // Nothing to do is reported rather than treated as a failure.
  const empty = compact({ segments: [], max_tokens: 10 });
  assert.deepEqual(empty.kept, []);
  assert.equal(empty.complete, true);
  assert.equal(empty.unchanged, true);
  assert.equal(empty.summary, null);
});

test("v0.12.43 reports a promotion it cannot make instead of returning a projection without it", () => {
  const segments = [seg("big", "x".repeat(400))];
  assert.throws(() => compactWithPromotion({ segments, max_tokens: 1, estimate: ONE }, "big"), /cannot be restored within 1 tokens/u);
  // The id is checked before the budget, so a typo is reported as a typo.
  assert.throws(() => compactWithPromotion({ segments, max_tokens: 1, estimate: ONE }, ""), /does not exist/u);
});

test("v0.12.43 validates the projection and restore arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-projection-edges-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const kernel = new ContextProjectionKernel(store);
  try {
    for (const bad of [0, -1, 1.5]) {
      assert.throws(() => kernel.project({ max_tokens: bad }), /positive integer/u, String(bad));
    }
    assert.throws(() => kernel.project({ max_tokens: 10, segments: "no" }), /segments must be an array/u);
    assert.throws(() => kernel.project({ max_tokens: 10, segments: [1] }), /segment must be an object/u);
    assert.throws(() => kernel.project({ max_tokens: 10, segments: [{ role: "user", content: "x" }] }), /segment.id/u);
    assert.throws(() => kernel.project({ max_tokens: 10, segments: [{ id: "a", content: "x" }] }), /segment.role/u);
    assert.throws(() => kernel.project({ max_tokens: 10, segments: [{ id: "a", role: "user" }] }), /segment.content/u);
    assert.throws(() => kernel.project({ max_tokens: 10, session_id: "  " }), /session_id/u);
    // A restore validates its own cap, and the session path is validated before anything is read.
    assert.throws(() => kernel.restore({ segment_id: "a", max_tokens: 0 }), /positive integer/u);
    assert.throws(() => kernel.restore({}), /segment_id/u);
    // A stateless project reports no session, so a caller can tell it was not stored.
    const stateless = kernel.project({ max_tokens: 10, segments: [seg("a", "aaaa")] });
    assert.equal(stateless.session_id, undefined);
    assert.equal((stateless.segments as JsonObject[]).length, 1);
    assert.equal(stateless.original_tokens, 1);
    // A stateless restore with no cap asks "put it back where it was", which with no stored projection
    // means the segment's own cost — a distinct path from the stored one.
    const noCap = kernel.restore({ segment_id: "a", segments: [seg("a", "aaaa")] });
    assert.equal(noCap.restored_from, "arguments");
    assert.equal((noCap.segments as JsonObject[]).length, 1);
    // A stateless restore with a segment already in the projection reports that rather than promoting.
    const again = kernel.restore({ segment_id: "a", max_tokens: 10, segments: [seg("a", "aaaa")] });
    assert.equal(again.already_present, true);
    assert.equal(again.restored_from, "arguments");
    // Persisting with no segments leaves the session as it was rather than emptying it.
    kernel.project({ max_tokens: 10, segments: [seg("keep", "aaaa")], session_id: "s" });
    kernel.project({ max_tokens: 10, session_id: "s" });
    assert.equal(kernel.get({ session_id: "s" }).segment_count, 1);
    // A projection whose identity is unchanged is not rewritten, so a repeated read does not bump a
    // version and make a caller think something happened.
    const before = store.find("context_projection", "context_projection_s")!.version;
    kernel.project({ max_tokens: 10, session_id: "s" });
    assert.equal(store.find("context_projection", "context_projection_s")!.version, before);
    // A superseded session record is replaced rather than duplicated.
    kernel.project({ max_tokens: 10, segments: [seg("other", "aaaa")], session_id: "s" });
    assert.equal(store.find("context_session", "context_session_s")!.segment_count, 1);
    assert.equal(kernel.get({ session_id: "s" }).segment_count, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("v0.12.43 covers the state view's remaining rungs and edges", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-state-edges-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const kernel = new StateViewKernel(store);
  try {
    // A contract with no launch, and a launch with no loop: each fallback is a distinct answer.
    store.create("task", "t1", {});
    store.create("task_control_contract", "c1", { task_id: "t1", status: "active" });
    store.create("task_run", "r1", { contract_id: "c1", lifecycle: "active" });
    const noLaunch = kernel.get({ task_id: "t1" });
    assert.deepEqual(noLaunch.sources, ["task_control_contract", "task_run"]);
    assert.equal(noLaunch.action, "wait_for_host", "a run with no state record waits for its host");
    assert.equal(noLaunch.actor, "host");
    assert.equal(noLaunch.manifest, null);
    assert.equal(noLaunch.run?.stability_digest, null, "a missing digest is null rather than absent");

    // A contract that names a launch which was never created has no launch, exactly like one that
    // names none — the id being present is not the same as the record existing.
    store.create("task", "t1b", {});
    store.create("task_control_contract", "c1b", { task_id: "t1b", status: "active", launch_id: null });
    assert.equal(kernel.get({ task_id: "t1b" }).action, "prepare_run");
    store.create("task", "t1c", {});
    store.create("task_control_contract", "c1c", { task_id: "t1c", status: "active", launch_id: "never-created" });
    assert.equal(kernel.get({ task_id: "t1c" }).manifest, null);

    // A loop action of `none` means nobody acts, which is a different answer from "unknown".
    store.create("task", "t2", {});
    store.create("task_control_contract", "c2", { task_id: "t2", status: "active", launch_id: "l2" });
    store.create("work_launch", "l2", { task_id: "t2", status: "running" });
    store.create("task_run", "r2", { contract_id: "c2", launch_id: "l2", lifecycle: "active" });
    store.create("task_run_state", "task_run_state_r2", { status: "blocked", action: "human_handoff" });
    store.create("delivery_loop", "delivery_loop_l2", { action: "none" });
    const blocked = kernel.get({ task_id: "t2" });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.action, "none");
    assert.equal(blocked.actor, "none");

    // A loop whose latest snapshot is named but absent reports no workspace rather than an error.
    store.create("task", "t3", {});
    store.create("task_control_contract", "c3", { task_id: "t3", status: "active", launch_id: "l3" });
    store.create("work_launch", "l3", { task_id: "t3", status: "running" });
    store.create("task_run", "r3", { contract_id: "c3", launch_id: "l3", lifecycle: "active" });
    store.create("task_run_state", "task_run_state_r3", { status: "running", action: "wait_for_host" });
    store.create("delivery_loop", "delivery_loop_l3", { action: "wait_for_host", latest_snapshot_id: "missing" });
    const view = kernel.get({ task_id: "t3" });
    assert.equal(view.workspace, null);
    assert.equal(view.action, "wait_for_host");
    assert.equal(view.actor, "host");
    // An empty status falls back to `running` rather than being reported as an empty string, and the
    // loop still supplies the action — rung 4 of the precedence, not a bug: the run state's own action
    // is only reached when there is no loop.
    store.save("task_run_state", "task_run_state_r3", { status: "", action: "deliver" });
    assert.equal(kernel.get({ task_id: "t3" }).status, "running");
    assert.equal(kernel.get({ task_id: "t3" }).action, "wait_for_host");
    // Take the loop's opinion away and the run state's action is used, which is what makes the
    // fallback observable rather than incidental.
    store.save("delivery_loop", "delivery_loop_l3", { action: null, latest_snapshot_id: "missing" });
    assert.equal(kernel.get({ task_id: "t3" }).action, "deliver");
    // With no action anywhere the answer is that the host is awaited — the last fallback.
    store.save("task_run_state", "task_run_state_r3", { status: "running", action: null });
    assert.equal(kernel.get({ task_id: "t3" }).action, "wait_for_host");
    assert.equal(kernel.get({ task_id: "t3" }).actor, "host");
    // A snapshot that is explicitly not content-free is reported as such rather than assumed safe,
    // and an unstated flag is not read as a false one.
    store.create("state_snapshot", "snap3", { workspace_id: "w", snapshot_digest: "sha256:s", workspace_state_revision: 1, content_free: false });
    store.save("task_run_state", "task_run_state_r3", { status: "running", action: "wait_for_host", observed_workspace_id: "snap3" });
    assert.equal((kernel.get({ task_id: "t3" }).workspace as JsonObject).is_content_free, false);
    store.create("state_snapshot", "snap4", { workspace_id: "w" });
    store.save("task_run_state", "task_run_state_r3", { status: "running", action: "wait_for_host", observed_workspace_id: "snap4" });
    const bare = kernel.get({ task_id: "t3" }).workspace as JsonObject;
    assert.equal(bare.snapshot_digest, null);
    assert.equal(bare.workspace_state_revision, null);
    assert.equal(bare.is_content_free, true, "an unstated flag is not a false one");
    // A manifest that never recorded a digest reports null.
    store.save("work_launch", "l3", { task_id: "t3", status: "running", context_manifest_id: "manifest3" });
    store.create("context_manifest", "manifest3", {});
    assert.equal(kernel.get({ task_id: "t3" }).manifest?.manifest_digest, null);
    // The latest run for a contract decides, so a superseded run does not answer for the task.
    store.create("task_run", "r3b", { contract_id: "c3", launch_id: "l3", lifecycle: "paused" });
    assert.equal(kernel.get({ task_id: "t3" }).status, "paused");
    // A task with no contract at all is not started, whatever else exists for it.
    store.create("task", "t4", {});
    store.create("task_run", "r4", { contract_id: "absent", lifecycle: "active" });
    assert.equal(kernel.get({ task_id: "t4" }).status, "not_started");

    // Records that never recorded a lifecycle, status or workspace id report nulls and the last
    // fallbacks rather than empty strings or `undefined` — a projection has to have one shape.
    store.create("task", "t5", {});
    store.create("task_control_contract", "c5", { task_id: "t5", status: "active", launch_id: "l5" });
    store.create("work_launch", "l5", { task_id: "t5" });
    store.create("task_run", "r5", { contract_id: "c5" });
    store.create("task_run_state", "task_run_state_r5", {});
    store.create("state_snapshot", "snap5", {});
    store.save("task_run_state", "task_run_state_r5", { observed_workspace_id: "snap5" });
    const sparse = kernel.get({ task_id: "t5" });
    assert.equal(sparse.run?.lifecycle, null);
    assert.equal(sparse.status, "running", "an absent status is not a stopped task");
    assert.equal(sparse.action, "wait_for_host");
    const sparseWorkspace = sparse.workspace as JsonObject;
    assert.equal(sparseWorkspace.workspace_id, null);
    assert.equal(sparseWorkspace.snapshot_digest, null);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
