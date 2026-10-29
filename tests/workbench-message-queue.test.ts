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
