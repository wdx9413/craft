import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { WorkbenchMessageQueue } from "../core/interfaces/workbench-message-queue.ts";
import { reconcileQueueItem } from "../core/interfaces/workbench-queue-recovery.ts";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "craft-queue-reconcile-")));
  const store = await new CraftStore(craftPaths(root)).open();
  store.create("task", "task", {}); store.create("task", "other", {});
  const queue = new WorkbenchMessageQueue(store); let sequence = 0;
  const pending = (provider = "codex", state = "unknown") => {
    const link = queue.links.bind({ task_id: "task", provider, native_session_id: `native-${++sequence}`, workspace: root, permission: "ask" }).link as JsonObject;
    const item = queue.enqueue("task", String(link.id), "private earlier input");
    queue.edit("task", String(link.id), String(item.id), "private final input");
    queue.claim("task", String(link.id), String(item.id));
    if (state === "unknown") queue.settle("task", String(link.id), String(item.id), false);
    return { link, item: store.get("workbench_message_queue", String(item.id)) };
  };
  const marker = (link: JsonObject, item: JsonObject, kind = "workbench_agent_session_submission", update: JsonObject = {}) => {
    const digest = createHash("sha256").update(JSON.stringify(["task", link.id, item.operation_id])).digest("hex");
    const prefix = kind === "workbench_codex_steer" ? "codex_steer_" : kind === "workbench_claude_submission" ? "claude_submit_" : "agent_send_";
    return store.create(kind, prefix + digest, { task_id: "task", link_id: link.id, submission_id: item.operation_id, native_session_id: link.native_session_id, status: "accepted", ...update });
  };
  return { root, store, queue, pending, marker, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("unproven recovery is read-only and explicit discard creates a distinct content-free receipt", async () => {
  const f = await fixture(); const peer = new DatabaseSync(f.store.paths.databaseFile);
  try {
    const { link, item } = f.pending(); const id = String(item.id), linkId = String(link.id);
    const before = f.store.database.prepare("SELECT total_changes() count").get();
    peer.exec("BEGIN IMMEDIATE");
    const view = await reconcileQueueItem(f.store, "task", linkId, id, item.version, "inspect");
    assert.equal(view.outcome, "unknown"); assert.equal(view.manual_discard_allowed, true); assert.equal(view.resolved, false);
    assert.doesNotMatch(JSON.stringify(view), /private|prompt/);
    assert.deepEqual(f.store.database.prepare("SELECT total_changes() count").get(), before);
    peer.exec("ROLLBACK");
    const result = await reconcileQueueItem(f.store, "task", linkId, id, item.version, "discard");
    assert.equal(result.outcome, "discarded");
    const receipt = result.receipt as JsonObject;
    assert.equal(receipt.state, "dismissed"); assert.equal(receipt.resolution, "user_discarded_unknown");
    assert.equal(receipt.native_ack_ref, undefined); assert.equal(receipt.resolved_queue_version, item.version);
    assert.equal(f.store.database.prepare("SELECT COUNT(*) count FROM records WHERE kind='workbench_message_queue' AND id=?").get(id)!.count, 0);
    assert.doesNotMatch(JSON.stringify(receipt), /private|prompt/);
    assert.equal((await reconcileQueueItem(f.store, "task", linkId, id, item.version, "discard")).idempotent, true);
    assert.equal(f.store.list("task_message", 10).length, 0);
  } finally { peer.close(); await f.close(); }
});

test("exact Codex send, guidance and Claude native acknowledgements settle without changing native turns", async () => {
  const f = await fixture();
  try {
    for (const kind of ["workbench_agent_session_submission", "workbench_codex_steer", "workbench_claude_submission"]) {
      const { link, item } = f.pending(kind === "workbench_claude_submission" ? "claude" : "codex");
      const ack = f.marker(link, item, kind);
      const running = f.store.save("workbench_agent_session_link", String(link.id), { ...link, turn_state: "running" });
      const [a, b] = await Promise.all([reconcileQueueItem(f.store, "task", String(link.id), String(item.id), item.version, "inspect"), reconcileQueueItem(f.store, "task", String(link.id), String(item.id), item.version, "discard")]);
      for (const result of [a, b]) {
        assert.equal(result.outcome, "accepted"); assert.equal(result.session_state, "running");
        assert.deepEqual((result.receipt as JsonObject).native_ack_ref, { kind, id: ack.id, version: ack.version });
        assert.equal((result.receipt as JsonObject).resolution, "native_acknowledged");
      }
      assert.equal(a.idempotent, false); assert.equal(b.idempotent, true);
      assert.deepEqual(f.store.get("workbench_agent_session_link", String(link.id)), running);
      assert.equal(f.store.find("workbench_message_queue", String(item.id)), null);
      assert.equal(f.store.database.prepare("SELECT COUNT(*) count FROM records WHERE kind='workbench_message_queue_receipt' AND id=?").get(String(item.id))!.count, 1);
    }
  } finally { await f.close(); }
});

test("legacy, reserved and mismatched native markers never become acceptance proof", async () => {
  const f = await fixture();
  try {
    for (const update of [{ status: "starting" }, { task_id: "other" }, { link_id: "other" }, { submission_id: undefined }, { native_session_id: "other" }]) {
      const { link, item } = f.pending(); f.marker(link, item, undefined, update);
      assert.equal((await reconcileQueueItem(f.store, "task", String(link.id), String(item.id), item.version, "inspect")).outcome, "unknown");
    }
    const { link, item } = f.pending("claude"); f.marker(link, item, "workbench_claude_submission", { status: "reserved" });
    assert.equal((await reconcileQueueItem(f.store, "task", String(link.id), String(item.id), item.version, "inspect")).resolved, false);
    f.store.save("workbench_agent_session_link", String(link.id), { ...link, turn_state: "unknown" });
    assert.equal((await reconcileQueueItem(f.store, "task", String(link.id), String(item.id), item.version, "inspect")).manual_discard_allowed, false);
    await assert.rejects(reconcileQueueItem(f.store, "task", String(link.id), String(item.id), item.version, "discard"), /still unsettled/);
    assert.equal(f.store.get("workbench_message_queue", String(item.id)).prompt, "private final input");
  } finally { await f.close(); }
});

test("a local dispatch receipt is never presented as native acceptance without its exact acknowledgement", async () => {
  const f = await fixture();
  try {
    const { link, item } = f.pending("claude", "dispatching");
    f.queue.settle("task", String(link.id), String(item.id), true);
    const local = await reconcileQueueItem(f.store, "task", String(link.id), String(item.id), item.version, "inspect");
    assert.equal(local.outcome, "dispatched"); assert.equal(local.idempotent, true);
    f.marker(link, item, "workbench_claude_submission");
    assert.equal((await reconcileQueueItem(f.store, "task", String(link.id), String(item.id), item.version, "inspect")).outcome, "accepted");
  } finally { await f.close(); }
});

test("live, unidentifiable and inaccessible dispatchers fail closed while idle uncertain items remain recoverable", async () => {
  const f = await fixture(); const kill = process.kill;
  try {
    const { link, item } = f.pending("codex", "dispatching");
    assert.equal(item.dispatch_owner_pid, process.pid);
    assert.equal((await reconcileQueueItem(f.store, "task", String(link.id), String(item.id), item.version, "inspect")).manual_discard_allowed, false);
    for (const pid of [undefined, 1]) {
      const changed = f.store.save("workbench_message_queue", String(item.id), { ...item, dispatch_owner_pid: pid });
      assert.equal((await reconcileQueueItem(f.store, "task", String(link.id), String(item.id), changed.version, "inspect")).manual_discard_allowed, false);
    }
    const changed = f.store.save("workbench_message_queue", String(item.id), { ...item });
    process.kill = () => { throw Object.assign(new Error("permission denied"), { code: "EPERM" }); };
    assert.equal((await reconcileQueueItem(f.store, "task", String(link.id), String(item.id), changed.version, "inspect")).manual_discard_allowed, false);
  } finally { process.kill = kill; await f.close(); }
});

test("recovery rejects stale versions, cross-session objects, pending input and conflicting receipts", async () => {
  const f = await fixture();
  try {
    const { link, item } = f.pending(); const id = String(item.id), linkId = String(link.id);
    for (const version of [0, "1", 1.5]) await assert.rejects(reconcileQueueItem(f.store, "task", linkId, id, version, "inspect"), /positive integer/);
    await assert.rejects(reconcileQueueItem(f.store, "task", linkId, id, item.version, "retry"), /inspect or discard/);
    await assert.rejects(reconcileQueueItem(f.store, "task", linkId, id, 100, "inspect"), /changed/);
    await assert.rejects(reconcileQueueItem(f.store, "task", linkId, "missing", 1, "inspect"), /does not belong/);
    const other = f.pending();
    await assert.rejects(reconcileQueueItem(f.store, "task", String(other.link.id), id, item.version, "discard"), /does not belong/);
    const pending = f.queue.enqueue("task", linkId, "pending input");
    await assert.rejects(reconcileQueueItem(f.store, "task", linkId, String(pending.id), pending.version, "inspect"), /only an uncertain/);
    for (const receipt of [
      { task_id: "other", link_id: linkId, operation_id: id, state: "sent" },
      { task_id: "task", link_id: "other", operation_id: id, state: "sent" },
      { task_id: "task", link_id: linkId, operation_id: "other", state: "sent" },
      { task_id: "task", link_id: linkId, operation_id: id, state: "unknown" },
      { task_id: "task", link_id: linkId, operation_id: id, state: "sent" },
    ]) {
      f.store.create("workbench_message_queue_receipt", id, receipt);
      await assert.rejects(reconcileQueueItem(f.store, "task", linkId, id, item.version, "discard"), /receipt conflicts/);
      f.store.remove("workbench_message_queue_receipt", id);
    }
  } finally { await f.close(); }
});

test("a SQLite deletion failure rolls back the recovery receipt and preserves every input revision", async () => {
  const f = await fixture();
  try {
    const { link, item } = f.pending();
    const count = () => f.store.database.prepare("SELECT COUNT(*) count FROM records WHERE kind='workbench_message_queue' AND id=?").get(String(item.id))!.count;
    const versions = count();
    f.store.database.exec("CREATE TEMP TRIGGER reject_queue_delete BEFORE DELETE ON records WHEN OLD.kind='workbench_message_queue' BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END");
    await assert.rejects(reconcileQueueItem(f.store, "task", String(link.id), String(item.id), item.version, "discard"));
    assert.equal(count(), versions);
    assert.equal(f.store.get("workbench_message_queue", String(item.id)).prompt, "private final input");
    assert.equal(f.store.find("workbench_message_queue_receipt", String(item.id)), null);
    f.store.database.exec("DROP TRIGGER reject_queue_delete");
    assert.equal((await reconcileQueueItem(f.store, "task", String(link.id), String(item.id), item.version, "discard")).outcome, "discarded");
  } finally { await f.close(); }
});
