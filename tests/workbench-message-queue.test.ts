import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { WorkbenchMessageQueue } from "../core/interfaces/workbench-message-queue.ts";

test("durable queue is ordered, task scoped and never reclaims an uncertain submission", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-queue-")));
  let store = await new CraftStore(craftPaths(root)).open();
  try {
    store.create("task", "task", {}); store.create("task", "other", {});
    let queue = new WorkbenchMessageQueue(store);
    const link = queue.links.bind({ task_id: "task", provider: "codex", native_session_id: "thread", workspace: root, permission: "ask" }).link as Record<string, unknown>;
    const id = String(link.id), a = queue.enqueue("task", id, "first"), b = queue.enqueue("task", id, "second", "plan");
    const second = queue.links.bind({ task_id: "other", provider: "claude", native_session_id: "second", workspace: root, permission: "ask" }).link as Record<string, unknown>;
    const page = queue.links.projectPage(1);
    assert.equal((page.links as unknown[]).length, 1);
    assert.ok(page.next_cursor);
    const next = queue.links.projectPage(1, String(page.next_cursor));
    assert.equal(next.next_cursor, null);
    assert.deepEqual(new Set([...(page.links as Record<string, unknown>[]), ...(next.links as Record<string, unknown>[])].map(row => row.id)), new Set([id, second.id]));
    assert.deepEqual(queue.links.projectPage(50, null, "/missing").links, []);
    assert.throws(() => queue.links.projectPage(0), /limit/);
    assert.throws(() => queue.links.projectPage(50, "!"), /cursor/);
    assert.throws(() => queue.links.projectPage(50, Buffer.from("{}").toString("base64url")), /cursor/);
    assert.equal(b.work_mode, "plan"); assert.throws(() => queue.enqueue("task", id, "bad", "other"), /mode/);
    assert.deepEqual(queue.list("task", id).map(item => item.id), [a.id, b.id]);
    assert.throws(() => queue.edit("task", id, String(a.id), " "), /invalid/);
    assert.equal(queue.edit("task", id, String(a.id), "updated").prompt, "updated");
    assert.throws(() => queue.claim("task", id, String(b.id)), /blocked/);
    assert.throws(() => queue.list("other", id), /does not belong/);
    queue.claim("task", id, String(a.id));
    assert.throws(() => queue.edit("task", id, String(a.id), "late"), /not pending/);
    assert.throws(() => queue.cancel("task", id, String(a.id)), /not pending/);
    store.close(); store = await new CraftStore(craftPaths(root)).open(); queue = new WorkbenchMessageQueue(store);
    assert.equal(queue.list("task", id)[1].work_mode, "plan");
    assert.throws(() => queue.claim("task", id, String(a.id)), /not safe/);
    queue.settle("task", id, String(a.id), false);
    assert.throws(() => queue.claim("task", id, String(b.id)), /blocked/);
    queue.cancel("task", id, String(b.id)); assert.equal(queue.list("task", id).length, 1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("confirmed queue retirement rolls back if its content-free receipt cannot be recorded", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-queue-atomic-")));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    store.create("task", "task", {});
    const queue = new WorkbenchMessageQueue(store);
    const link = queue.links.bind({ task_id: "task", provider: "codex", native_session_id: "thread", workspace: root, permission: "ask" }).link as Record<string, unknown>;
    const id = String(link.id), item = queue.enqueue("task", id, "draft");
    queue.edit("task", id, String(item.id), "final input");
    queue.claim("task", id, String(item.id));
    store.create("workbench_message_queue_receipt", String(item.id), { state: "sent" });
    assert.throws(() => queue.settle("task", id, String(item.id), true));
    assert.equal(queue.list("task", id)[0].state, "dispatching");
    assert.equal(queue.list("task", id)[0].prompt, "final input");
    assert.equal(store.database.prepare("SELECT COUNT(*) count FROM records WHERE kind='workbench_message_queue' AND id=?").get(String(item.id))!.count, 3);
    store.remove("workbench_message_queue_receipt", String(item.id));
    const legacy = queue.enqueue("task", id, "legacy input");
    store.save("workbench_message_queue", String(legacy.id), { ...legacy, prompt: "", state: "sent" });
    assert.equal(queue.retireLegacySent(), 1);
    assert.equal(queue.retireLegacySent(), 0);
    assert.equal(store.find("workbench_message_queue", String(legacy.id)), null);
    assert.throws(() => queue.retireLegacySent(0), /limit/);
    const receipt = queue.settle("task", id, String(item.id), true);
    assert.equal(receipt.state, "sent"); assert.equal(Object.hasOwn(receipt, "prompt"), false);
    assert.equal(store.find("workbench_message_queue", String(item.id)), null);
    assert.equal(store.database.prepare("SELECT COUNT(*) count FROM records WHERE kind='workbench_message_queue' AND id=?").get(String(item.id))!.count, 0);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
