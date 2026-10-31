import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { WorkbenchMessageQueue } from "../core/interfaces/workbench-message-queue.ts";
import { WorkbenchQueueRunner } from "../core/interfaces/workbench-queue-runner.ts";
import { reconcileQueueItem } from "../core/interfaces/workbench-queue-recovery.ts";

test("a killed dispatcher leaves a durable claim that restart never replays", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "craft-queue-crash-")));
  let store = await new CraftStore(craftPaths(root)).open();
  let runner: WorkbenchQueueRunner | undefined;
  const children: ReturnType<typeof spawn>[] = [];
  try {
    store.create("task", "task", {});
    let queue = new WorkbenchMessageQueue(store);
    const link = queue.links.bind({ task_id: "task", provider: "claude", native_session_id: "interrupted", workspace: root, permission: "ask" }).link as Record<string, unknown>;
    const id = String(link.id);
    const first = queue.enqueue("task", id, "may have reached native CLI");
    const second = queue.enqueue("task", id, "wait for reconciliation");
    const worker = spawn(process.execPath, ["--input-type=module", "-e", `
      import { CraftStore } from ${JSON.stringify(new URL("../core/infrastructure/store.ts", import.meta.url).href)};
      import { craftPaths } from ${JSON.stringify(new URL("../core/infrastructure/paths.ts", import.meta.url).href)};
      import { WorkbenchMessageQueue } from ${JSON.stringify(new URL("../core/interfaces/workbench-message-queue.ts", import.meta.url).href)};
      const store = await new CraftStore(craftPaths(process.argv[1])).open();
      new WorkbenchMessageQueue(store).claim('task',process.argv[2],process.argv[3]);
      process.stdout.write('claimed');
      setInterval(() => {}, 1000);
    `, root, id, String(first.id)], { stdio: ["ignore", "pipe", "ignore"] });
    children.push(worker);
    const exit = once(worker, "exit");
    const ready = await Promise.race([once(worker.stdout!, "data"), exit.then(() => { throw new Error("dispatcher exited before committing claim"); })]);
    assert.equal(String(ready[0]), "claimed");
    const claimed = store.get("workbench_message_queue", String(first.id));
    assert.equal(claimed.dispatch_owner_pid, worker.pid);
    assert.equal((await reconcileQueueItem(store, "task", id, String(first.id), claimed.version, "inspect")).manual_discard_allowed, false);
    worker.kill("SIGKILL");
    assert.equal((await exit)[1], "SIGKILL");
    store.close(); store = await new CraftStore(craftPaths(root)).open(); queue = new WorkbenchMessageQueue(store);
    assert.deepEqual(queue.list("task", id).map(row => [row.id, row.state]), [[first.id, "dispatching"], [second.id, "queued"]]);
    assert.throws(() => queue.claim("task", id, String(first.id)), /not safe/);
    assert.throws(() => queue.claim("task", id, String(second.id)), /blocked/);
    // A different session remains serviceable; the uncertain one is isolated.
    const other = queue.links.bind({ task_id: "task", provider: "claude", native_session_id: "ready", workspace: root, permission: "ask" }).link as Record<string, unknown>;
    const accepted = queue.enqueue("task", String(other.id), "independent work");
    const sent: string[] = [];
    runner = new WorkbenchQueueRunner(store, async (task, linkId) => {
      const item = queue.list(task, linkId)[0];
      if (item.state !== "queued") return;
      queue.claim(task, linkId, String(item.id)); sent.push(String(item.id)); queue.settle(task, linkId, String(item.id), true);
    });
    for (let i = 0; i < 4; i++) await runner.tick();
    assert.deepEqual(sent, [String(accepted.id)]);
    assert.equal(store.get("workbench_message_queue", String(first.id)).prompt, "may have reached native CLI");
    assert.equal(store.get("workbench_message_queue_receipt", String(accepted.id)).state, "sent");
    assert.equal(store.find("workbench_message_queue", String(accepted.id)), null);
    await runner.close(); runner = undefined;
    store.close(); store = await new CraftStore(craftPaths(root)).open();
    assert.equal(store.find("workbench_message_queue", String(accepted.id)), null);
    assert.equal(store.get("workbench_message_queue", String(first.id)).state, "dispatching");
    assert.equal(store.list("task_message", 10).length, 0);
    assert.equal((await reconcileQueueItem(store, "task", id, String(first.id), claimed.version, "inspect")).manual_discard_allowed, true);
    assert.equal((await reconcileQueueItem(store, "task", id, String(first.id), claimed.version, "discard")).outcome, "discarded");
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill("SIGKILL"); await exit; }
    await runner?.close(); store.close(); await rm(root, { recursive: true, force: true });
  }
});
