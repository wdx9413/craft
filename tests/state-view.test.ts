import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { StateViewKernel } from "../src/state-view.ts";
import { CraftService } from "../src/service.ts";
import { McpServer } from "../src/mcp.ts";

/**
 * The unified `state` view, and the precedence that is its whole content.
 *
 * A task can have a run, a run state, a launch, a delivery loop, a manifest and a workspace snapshot
 * at once, and they can disagree. Without an order, "what is the state" has as many answers as there
 * are records — which is why the member was hard to reason about. Each test below pins one rung of
 * that order, because a view whose precedence is untested is a view that will be re-derived
 * differently by the next reader.
 */

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-state-view-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store, kernel: new StateViewKernel(store) };
}
async function close(f: { store: CraftStore; root: string }) {
  f.store.close();
  await rm(f.root, { recursive: true, force: true });
}

/** A task with a contract and a run; every later record is added by the test that needs it. */
function scaffold(store: CraftStore, runLifecycle = "active", suffix = ""): { task: string; launch: string; run: string } {
  const task = `task${suffix}`;
  store.create("task", task, { title: "T", goal: "G" });
  store.create("task_control_contract", `contract${suffix}`, { task_id: task, status: "active", launch_id: `launch${suffix}` });
  store.create("work_launch", `launch${suffix}`, { task_id: task, status: "running" });
  store.create("task_run", `run${suffix}`, { contract_id: `contract${suffix}`, launch_id: `launch${suffix}`, lifecycle: runLifecycle, stability_digest: "sha256:stable" });
  return { task, launch: `launch${suffix}`, run: `run${suffix}` };
}
const stateOf = (store: CraftStore, overrides: JsonObject = {}, suffix = ""): void => {
  store.create("task_run_state", `task_run_state_run${suffix}`, { status: "running", action: "wait_for_host", ...overrides });
};

test("v0.12.43 reports a task that has not started rather than an empty view", async () => {
  const f = await fixture();
  try {
    const view = f.kernel.get({});
    assert.equal(view.task_id, null);
    assert.equal(view.status, "not_started");
    assert.equal(view.action, "prepare_run");
    assert.equal(view.actor, "human");
    // A missing record is `null`, not a default: "there is no run" and "there is a run in an unknown
    // state" are different answers and only one of them is a problem.
    assert.equal(f.kernel.get({ task_id: "absent" }).run, null);
    assert.deepEqual(f.kernel.get({ task_id: "absent" }).sources, []);
    assert.throws(() => f.kernel.get({ task_id: "   " }), /task_id must not be empty/u);
  } finally { await close(f); }
});

test("v0.12.43 names the records it read, so the basis is visible", async () => {
  const f = await fixture();
  try {
    scaffold(f.store);
    stateOf(f.store);
    f.store.create("delivery_loop", "delivery_loop_launch", { action: "deliver" });
    f.store.create("state_snapshot", "snap", { workspace_id: "w", snapshot_digest: "sha256:s", workspace_state_revision: 3, content_free: true });
    f.store.create("context_manifest", "manifest", { manifest_digest: "sha256:m" });
    f.store.save("work_launch", "launch", { task_id: "task", status: "running", context_manifest_id: "manifest" });

    const view = f.kernel.get({ task_id: "task" });
    assert.deepEqual(view.sources, ["task_control_contract", "task_run", "task_run_state", "work_launch", "delivery_loop", "context_manifest"]);
    // The projections carry digests and flags, never business content.
    assert.deepEqual(view.run, { id: "run", version: 1, lifecycle: "active", stability_digest: "sha256:stable" });
    assert.deepEqual(view.manifest, { id: "manifest", version: 1, manifest_digest: "sha256:m" });
    // The loop's action decides when nothing above it has an opinion.
    assert.equal(view.status, "running");
    assert.equal(view.action, "deliver");
    assert.equal(view.actor, "human");
  } finally { await close(f); }
});

test("v0.12.43 lets a stopped run override a loop that still has work queued", async () => {
  const f = await fixture();
  try {
    // Rung 1 of the precedence. A cancelled run is not "working" because a delivery loop still has an
    // action in it, and reporting the loop's action would invite the caller to carry on.
    for (const [index, [lifecycle, status, action, actor]] of ([
      ["cancelled", "cancelled", "none", "none"],
      ["paused", "paused", "resume_or_handoff", "human"],
    ] as const).entries()) {
      const ids = scaffold(f.store, lifecycle, String(index));
      stateOf(f.store, {}, String(index));
      f.store.create("delivery_loop", `delivery_loop_launch${index}`, { action: "deliver" });
      const view = f.kernel.get({ task_id: ids.task });
      assert.equal(view.status, status, lifecycle);
      assert.equal(view.action, action);
      assert.equal(view.actor, actor);
    }
  } finally { await close(f); }
});

test("v0.12.43 reports drift before anything downstream of it", async () => {
  const f = await fixture();
  try {
    // Rung 2. `needs_replan` means the pinned inputs changed, so every downstream reading is about a
    // plan that no longer applies — including an approval that was pending under the old one.
    scaffold(f.store);
    stateOf(f.store, { status: "needs_replan", action: "wait_for_host" });
    f.store.create("delivery_loop", "delivery_loop_launch", { action: "deliver" });
    f.store.save("work_launch", "launch", { task_id: "task", status: "awaiting_approval" });
    const view = f.kernel.get({ task_id: "task" });
    assert.equal(view.status, "needs_replan");
    assert.equal(view.action, "revalidate_inputs");
    assert.equal(view.actor, "human");
  } finally { await close(f); }
});

test("v0.12.43 reports a pending approval as a human decision, not as the loop's action", async () => {
  const f = await fixture();
  try {
    // Rung 3, and the reason it outranks the loop: an approval is a human decision, and surfacing
    // `deliver` instead would invite the caller to skip it.
    scaffold(f.store);
    stateOf(f.store);
    f.store.create("delivery_loop", "delivery_loop_launch", { action: "deliver" });
    f.store.save("work_launch", "launch", { task_id: "task", status: "awaiting_approval" });
    assert.equal(f.kernel.get({ task_id: "task" }).action, "review_work_launch");
    assert.equal(f.kernel.get({ task_id: "task" }).actor, "human");
    // The run state can say it too, and either alone is enough.
    f.store.save("work_launch", "launch", { task_id: "task", status: "running" });
    f.store.save("task_run_state", "task_run_state_run", { status: "awaiting_approval", action: "review_work_launch" });
    assert.equal(f.kernel.get({ task_id: "task" }).action, "review_work_launch");
  } finally { await close(f); }
});

test("v0.12.43 falls back to the run state when there is no loop, and reports who acts", async () => {
  const f = await fixture();
  try {
    scaffold(f.store);
    // A run with no state record is running and waiting for its host, which is a different answer
    // from "blocked" and the honest one.
    assert.equal(f.kernel.get({ task_id: "task" }).status, "running");
    assert.equal(f.kernel.get({ task_id: "task" }).action, "wait_for_host");
    assert.equal(f.kernel.get({ task_id: "task" }).actor, "host");
    // With a state record but no loop, its own action is used.
    stateOf(f.store, { status: "ready_for_delivery", action: "collect_acceptance" });
    const view = f.kernel.get({ task_id: "task" });
    assert.equal(view.status, "ready_for_delivery");
    assert.equal(view.action, "collect_acceptance");
    assert.equal(view.actor, "human");
    // The workspace projection prefers a snapshot the run state names, and falls back to the loop's.
    f.store.save("task_run_state", "task_run_state_run", { status: "running", action: "wait_for_host", observed_workspace_id: "snap" });
    f.store.create("state_snapshot", "snap", { workspace_id: "w", snapshot_digest: "sha256:s", workspace_state_revision: 1 });
    const withWorkspace = f.kernel.get({ task_id: "task" });
    assert.ok(withWorkspace.sources.includes("state_snapshot"));
    assert.equal((withWorkspace.workspace as JsonObject).snapshot_digest, "sha256:s");
    assert.equal((withWorkspace.workspace as JsonObject).is_content_free, true);
  } finally { await close(f); }
});

test("v0.12.43 serves the view read-only through the facade and MCP", async () => {
  const f = await fixture();
  try {
    scaffold(f.store);
    stateOf(f.store, { status: "awaiting_acceptance", action: "collect_acceptance" });
    const service = new CraftService(f.store);
    assert.equal(service.stateViewGet({ task_id: "task" }).status, "awaiting_acceptance");
    const server = new McpServer(service, "full");
    const response = await server.handle({ id: 1, method: "tools/call", params: { name: "craft_state_view_get", arguments: { task_id: "task" } } });
    const result = response!.result as { isError: boolean; structuredContent: JsonObject };
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.status, "awaiting_acceptance");
    assert.equal(result.structuredContent.task_id, "task");
    // Nothing was written by reading: the view is derived, so there is no second source of truth.
    assert.equal(f.store.count("state_snapshot"), 0);
    assert.equal(f.store.list("task_run_state", 10).length, 1);
  } finally { await close(f); }
});
