import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-task-board-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  return { root, store, service: new CraftService(store) };
}

function task(store: CraftStore, id: string, status = "active") {
  return store.create("task", id, { title: id, goal: "g", status });
}

test("the console board groups tasks into the seven plan states from real records", async () => {
  const f = await fixture();
  try {
    task(f.store, "idle");                                                    // no signal → awaiting_input
    task(f.store, "completed", "completed");
    task(f.store, "failed");
    f.store.create("trial", "trial-failed", { task_id: "failed" });
    f.store.create("outcome", "outcome-failed", { trial_id: "trial-failed", verdict: "failed" });
    task(f.store, "running");
    f.store.create("work_launch", "launch-running", { task_id: "running", status: "running" });
    task(f.store, "approval");
    f.store.create("task_control_state", "control-approval", { task_id: "approval", status: "awaiting_approval" });
    task(f.store, "queued");
    f.store.create("workbench_message_queue", "msg-queued", { task_id: "queued", state: "queued", prompt: "later" });
    task(f.store, "unknown");
    f.store.create("workbench_agent_session_link", "link-unknown", { task_id: "unknown", turn_state: "unknown" });

    const board = f.service.homeTaskBoard({ limit: 50 }) as JsonObject;
    const buckets = board.buckets as Record<string, JsonObject[]>;
    assert.deepEqual((buckets.running as JsonObject[]).map((item) => item.id), ["running"]);
    assert.deepEqual((buckets.awaiting_approval as JsonObject[]).map((item) => item.id), ["approval"]);
    assert.deepEqual((buckets.queued as JsonObject[]).map((item) => item.id), ["queued"]);
    assert.deepEqual((buckets.unknown as JsonObject[]).map((item) => item.id), ["unknown"]);
    assert.deepEqual((buckets.completed as JsonObject[]).map((item) => item.id), ["completed"]);
    assert.deepEqual((buckets.failed as JsonObject[]).map((item) => item.id), ["failed"]);
    assert.ok((buckets.awaiting_input as JsonObject[]).some((item) => item.id === "idle"));
    // Each row names its state and a human reason.
    const idle = (board.tasks as JsonObject[]).find((item) => item.id === "idle")!;
    assert.equal(idle.state_label, "待输入");
    assert.match(String(idle.reason), /等待/);
    assert.deepEqual(board.order, ["running", "awaiting_approval", "awaiting_input", "queued", "failed", "unknown", "completed"]);
    assert.equal((board.labels as JsonObject).running, "运行");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("the board respects the limit and rejects an out-of-range one", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 3; i += 1) task(f.store, `t${i}`);
    const board = f.service.homeTaskBoard({ limit: 2 }) as JsonObject;
    assert.equal((board.tasks as JsonObject[]).length, 2);
    assert.throws(() => f.service.homeTaskBoard({ limit: 0 }), /limit/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("the board derives running, awaiting, queued and failed from each authoritative signal", async () => {
  const f = await fixture();
  try {
    // A starting native turn counts as running.
    task(f.store, "starting");
    f.store.create("workbench_agent_session_link", "link-starting", { task_id: "starting", turn_state: "starting" });
    // A launch awaiting approval with no control state still awaits approval.
    task(f.store, "launch-approval");
    f.store.create("work_launch", "launch-approval-1", { task_id: "launch-approval", status: "awaiting_approval" });
    // A control state awaiting acceptance is waiting for input.
    task(f.store, "accept");
    f.store.create("task_control_state", "control-accept", { task_id: "accept", status: "awaiting_acceptance" });
    // A prepared launch is queued.
    task(f.store, "prepared");
    f.store.create("work_launch", "launch-prepared", { task_id: "prepared", status: "prepared" });
    // A denied launch is failed.
    task(f.store, "denied");
    f.store.create("work_launch", "launch-denied", { task_id: "denied", status: "denied" });

    const board = f.service.homeTaskBoard({ limit: 50 }) as JsonObject;
    const buckets = board.buckets as Record<string, JsonObject[]>;
    const ids = (state: string) => (buckets[state] as JsonObject[]).map((item) => item.id);
    assert.deepEqual(ids("running"), ["starting"]);
    assert.deepEqual(ids("awaiting_approval"), ["launch-approval"]);
    assert.deepEqual(ids("awaiting_input"), ["accept"]);
    assert.deepEqual(ids("queued"), ["prepared"]);
    assert.deepEqual(ids("failed"), ["denied"]);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
test("the board projects a release gate for delivered tasks and omits it for ordinary ones", async () => {
  const f = await fixture();
  try {
    task(f.store, "delivered", "completed");
    task(f.store, "plain");
    f.store.create("evaluation_run", "run-1", { subject_type: "task", subject_id: "delivered", split: "held_out", verdict: "passed" });
    f.store.create("signoff", "signoff-1", { subject_type: "pilot_delivery", subject_id: "delivered", evaluation_run_id: "run-1", decision: "passed" });
    f.store.create("canary", "canary-1", { candidate_id: "delivered", status: "passed" });
    f.store.create("skill_publication", "publication-1", { subject_id: "delivered", status: "published" });

    const board = f.service.homeTaskBoard({ limit: 50 }) as JsonObject;
    const rows = board.tasks as JsonObject[];
    const delivered = rows.find((item) => item.id === "delivered")!;
    const plain = rows.find((item) => item.id === "plain")!;
    assert.equal((delivered.release as JsonObject).status, "released");
    assert.equal((delivered.release as JsonObject).evaluation_run_id, "run-1");
    assert.equal((delivered.release as JsonObject).signoff_id, "signoff-1");
    assert.equal((delivered.release as JsonObject).canary_id, "canary-1");
    assert.equal(plain.release, undefined);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
test("context usage projection lists the assets a task pulled with their recall weights", async () => {
  const f = await fixture();
  try {
    task(f.store, "task-ctx", "completed");
    f.store.create("context_working_set_receipt", "ws-1", {
      task_id: "task-ctx", session_id: null, turn_id: null,
      scope: { kind: "project", id: "demo" },
      asset_refs: [
        { member: "experience", id: "proc-1", version: 1 },
        { member: "knowledge", id: "claim-1", version: 1 },
        { member: "codebase", id: "code.ts", version: 1 },
      ],
    });
    f.store.create("evidence", "ev-ctx", { source_type: "program", confidence: "confirmed", claim: "验收通过", locator: "report.md",
      metadata: { context_receipt_id: "ws-1", verdict: "passed" } });
    f.store.create("context_feedback", "fb-helpful", { receipt_id: "ws-1", outcome: "helpful", evidence_verified: true,
      usage_stage: "used", evidence_ids: ["ev-ctx"], verified_evidence_refs: [{ id: "ev-ctx", version: 1 }],
      asset_refs: [{ member: "experience", id: "proc-1", version: 1 }], created_at: "2026-11-05T10:00:00Z" });
    const usage = f.service.homeContextUsage({ task_id: "task-ctx" }) as JsonObject;
    assert.equal(usage.task_id, "task-ctx");
    const assets = usage.assets as JsonObject[];
    assert.equal(assets.length, 2); // codebase is governance-scoped, not a ranked member here
    const experience = assets.find((item) => item.member === "experience")!;
    assert.equal(experience.id, "proc-1");
    assert.equal(experience.recall_weight, 1.2);
    assert.equal(experience.helpful_signals, 1);
    const knowledge = assets.find((item) => item.member === "knowledge")!;
    assert.equal(knowledge.recall_weight, 1);
    assert.equal((usage.working_sets as JsonObject[])[0]!.id, "ws-1");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

