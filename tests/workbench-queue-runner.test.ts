import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { WorkbenchMessageQueue } from "../core/interfaces/workbench-message-queue.ts";
import { WorkbenchQueueRunner } from "../core/interfaces/workbench-queue-runner.ts";

test("server queue dispatch continues without a page and serializes overlapping scans", async () => {
  const root = await mkdtemp(join(tmpdir(), "queue-runner-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    store.create("task", "task", {});
    const queue = new WorkbenchMessageQueue(store);
    const link = queue.links.bind({ task_id: "task", provider: "claude", native_session_id: "thread", workspace: root, permission: "ask" }).link as Record<string, unknown>;
    const id = String(link.id);
    const first = queue.enqueue("task", id, "sensitive earlier draft");
    queue.edit("task", id, String(first.id), "first"); queue.enqueue("task", id, "second");
    const sent: string[] = [];
    const runner = new WorkbenchQueueRunner(store, async (task, linkId) => {
      const item = queue.list(task, linkId)[0];
      queue.claim(task, linkId, String(item.id)); sent.push(String(item.prompt));
      await new Promise(resolve => setTimeout(resolve, 10));
      queue.settle(task, linkId, String(item.id), true);
    });
    await Promise.all([runner.tick(), runner.tick()]);
    assert.deepEqual(sent, ["first"]);
    await runner.tick(); assert.deepEqual(sent, ["first", "second"]);
    assert.equal(store.database.prepare("SELECT COUNT(*) count FROM records WHERE kind='workbench_message_queue'").get()!.count, 0);
    const receipts = store.list("workbench_message_queue_receipt", 10);
    assert.equal(receipts.length, 2);
    assert.equal(receipts.every(row => !Object.hasOwn(row, "prompt")), true);
    runner.start(); runner.start(); await runner.close(); await runner.tick();
    assert.deepEqual(sent, ["first", "second"]);

    queue.enqueue("task", id, "blocked");
    const unavailable = new WorkbenchQueueRunner(store, async () => { assert.fail("unavailable session dispatched"); }, () => false);
    await unavailable.tick(); await unavailable.close();
    const unknown = new WorkbenchQueueRunner(store, async (task, linkId) => {
      const item = queue.list(task, linkId)[0]; queue.claim(task, linkId, String(item.id));
      queue.settle(task, linkId, String(item.id), false); throw new Error("unknown transport result");
    });
    await unknown.tick(); await unknown.tick(); await unknown.close();
    assert.equal(queue.list("task", id)[0].state, "unknown");
    assert.equal(queue.list("task", id)[0].prompt, "blocked");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("blocked backlog cannot starve a ready session behind the first thousand queued messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "queue-fairness-"));
  const store = await new CraftStore(craftPaths(root)).open();
  let runner: WorkbenchQueueRunner | undefined;
  try {
    const queue = new WorkbenchMessageQueue(store);
    store.create("task", "task", {});
    const ready = queue.links.bind({ task_id: "task", provider: "claude", native_session_id: "ready", workspace: root, permission: "ask" }).link as Record<string, unknown>;
    queue.enqueue("task", String(ready.id), "ready work");
    store.transaction(() => {
      for (let i = 0; i < 11; i++) {
        const link = queue.links.bind({ task_id: "task", provider: "claude", native_session_id: `blocked-${i}`, workspace: root, permission: "ask" }).link as Record<string, unknown>;
        for (let n = 0; n < 100; n++) queue.enqueue("task", String(link.id), "blocked work");
        store.save("workbench_agent_session_link", String(link.id), { ...link, turn_state: "running" });
      }
    });
    const sent: string[] = [];
    runner = new WorkbenchQueueRunner(store, async (task, id) => {
      sent.push(id); const item = queue.list(task, id)[0];
      queue.claim(task, id, String(item.id)); queue.settle(task, id, String(item.id), true);
    });
    await runner.tick();
    assert.deepEqual(sent, [String(ready.id)]);
    assert.equal(queue.list("task", String(ready.id)).length, 0);
  } finally { await runner?.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("session pages advance and wrap so disconnected sessions cannot monopolize every scan", async () => {
  const root = await mkdtemp(join(tmpdir(), "queue-session-pages-"));
  const store = await new CraftStore(craftPaths(root)).open();
  let runner: WorkbenchQueueRunner | undefined;
  try {
    const queue = new WorkbenchMessageQueue(store);
    store.create("task", "task", {});
    store.transaction(() => {
      for (let i = 0; i < 101; i++) {
        const link = queue.links.bind({ task_id: "task", provider: "claude", native_session_id: `thread-${i}`, workspace: root, permission: "ask" }).link as Record<string, unknown>;
        queue.enqueue("task", String(link.id), "pending");
      }
    });
    const observed: string[] = [];
    runner = new WorkbenchQueueRunner(store, async () => assert.fail("disconnected session dispatched"), link => { observed.push(String(link.id)); return false; });
    await runner.tick(); assert.equal(observed.length, 100);
    await runner.tick(); assert.equal(observed.length, 101); assert.equal(new Set(observed).size, 101);
    await runner.tick(); assert.equal(observed.length, 201);
    assert.equal(new Set(observed.slice(101)).size, 100);
  } finally { await runner?.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("timer dispatch closes by waiting for the current send and leaving the rest pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "queue-close-"));
  const store = await new CraftStore(craftPaths(root)).open();
  let runner: WorkbenchQueueRunner | undefined;
  let release!: () => void, started!: () => void;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const beginning = new Promise<void>(resolve => { started = resolve; });
  try {
    const queue = new WorkbenchMessageQueue(store);
    store.create("task", "task", {});
    for (let i = 0; i < 2; i++) {
      const link = queue.links.bind({ task_id: "task", provider: "claude", native_session_id: `thread-${i}`, workspace: root, permission: "ask" }).link as Record<string, unknown>;
      queue.enqueue("task", String(link.id), "pending");
    }
    let sent = 0;
    runner = new WorkbenchQueueRunner(store, async (task, id) => {
      const item = queue.list(task, id)[0]; queue.claim(task, id, String(item.id)); sent++; started();
      await gate; queue.settle(task, id, String(item.id), true);
    });
    runner.start(); runner.start();
    await Promise.race([beginning, new Promise<void>((_, reject) => { deadline = setTimeout(() => reject(new Error("queue timer did not dispatch")), 5000); })]);
    let closed = false;
    const closing = runner.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
    release(); await closing; await runner.tick(); runner.start();
    assert.equal(sent, 1);
    assert.equal(store.list("workbench_message_queue", 10).length, 1);
    assert.equal(store.list("workbench_message_queue_receipt", 10).length, 1);
  } finally { clearTimeout(deadline); release(); await runner?.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("retirement batches, missing links and transient scan failures do not lose queued work", async () => {
  const root = await mkdtemp(join(tmpdir(), "queue-scan-recovery-"));
  const store = await new CraftStore(craftPaths(root)).open();
  let runner: WorkbenchQueueRunner | undefined;
  const originalRead = store.readSnapshot;
  try {
    const queue = new WorkbenchMessageQueue(store);
    store.create("task", "a", {}); store.create("task", "z", {});
    const link = queue.links.bind({ task_id: "a", provider: "claude", native_session_id: "ready", workspace: root, permission: "ask" }).link as Record<string, unknown>;
    const pending = queue.enqueue("a", String(link.id), "pending");
    store.create("workbench_message_queue", "orphan", { task_id: "a", link_id: "missing", sequence: 1, state: "queued" });
    store.create("workbench_message_queue", "mismatched-task", { task_id: "z", link_id: link.id, sequence: 1, state: "queued" });
    for (let i = 0; i < 26; i++) store.create("workbench_message_queue", `old-${i}`, { task_id: "a", link_id: link.id, operation_id: `old-${i}`, sequence: i, state: "sent", prompt: "obsolete retained input" });
    let submissions = 0;
    runner = new WorkbenchQueueRunner(store, async () => { submissions++; });
    store.readSnapshot = () => { throw new Error("temporary scan failure"); };
    await runner.tick(); assert.equal(submissions, 0);
    store.readSnapshot = originalRead;
    await runner.tick(); assert.equal(submissions, 1);
    assert.equal(store.list("workbench_message_queue_receipt", 100).length, 26);
    assert.equal(store.get("workbench_message_queue", String(pending.id)).state, "queued");
    // Failed and interrupted turns stay paused even while the link is idle.
    for (const status of ["failed", "interrupted"]) {
      store.save("workbench_agent_session_link", String(link.id), { ...store.get("workbench_agent_session_link", String(link.id)), last_turn_status: status });
      await runner.tick(); assert.equal(submissions, 1);
    }
  } finally { store.readSnapshot = originalRead; await runner?.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});
