import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/application/craft-service.ts";
import { LocalWorkbenchServer, WorkbenchWebApp } from "../core/interfaces/workbench-server.ts";
import { WorkbenchMessageQueue } from "../core/interfaces/workbench-message-queue.ts";

test("both Workbench mount paths serve the queue recovery module through the existing static contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-recovery-surface-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const service = new CraftService(store);
    await writeFile(join(root, "queue-recovery.js"), "export const recovery = true;\n");
    const mounted = new WorkbenchWebApp(service, "test-token", "http://localhost", { workbenchDir: root });
    const headless = new WorkbenchWebApp(service, "test-token", "http://localhost");
    for (const path of ["/queue-recovery.js", "/workbench/queue-recovery.js"]) {
      const response = mounted.handle({ method: "GET", path });
      assert.equal(response.status, 200); assert.match(response.body, /export const recovery/);
      assert.equal(headless.handle({ method: "GET", path }).status, 404);
    }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("real HTTP recovery enforces token, origin and version before removing an uncertain input", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-http-recovery-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const server = new LocalWorkbenchServer(new CraftService(store), "test-token");
  try {
    store.create("task", "task", {});
    const queue = new WorkbenchMessageQueue(store);
    const link = queue.links.bind({ task_id: "task", provider: "codex", native_session_id: "http-native", workspace: root, permission: "ask" }).link as Record<string, unknown>;
    const pending = queue.enqueue("task", String(link.id), "private HTTP input");
    queue.claim("task", String(link.id), String(pending.id)); queue.settle("task", String(link.id), String(pending.id), false);
    const item = store.get("workbench_message_queue", String(pending.id));
    const { url } = await server.start(0), origin = new URL(url).origin;
    const target = new URL(`/api/workbench/agent-sessions/${link.id}/queue-reconcile`, url);
    const body = { task_id: "task", item_id: item.id, expected_version: item.version, action: "inspect" };
    const headers = { authorization: "Bearer test-token", origin, "content-type": "application/json" };
    assert.equal((await fetch(target, { method: "POST", body: JSON.stringify(body) })).status, 401);
    assert.equal((await fetch(target, { method: "POST", headers: { ...headers, origin: "https://example.invalid" }, body: JSON.stringify(body) })).status, 403);
    const inspect = await fetch(target, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(inspect.status, 200); assert.equal((await inspect.json() as Record<string, unknown>).outcome, "unknown");
    assert.equal((await fetch(target, { method: "POST", headers, body: JSON.stringify({ ...body, action: "discard", expected_version: 1 }) })).status, 422);
    const removed = await fetch(target, { method: "POST", headers, body: JSON.stringify({ ...body, action: "discard" }) });
    assert.equal(removed.status, 200); assert.equal((await removed.json() as Record<string, unknown>).outcome, "discarded");
    assert.equal(store.find("workbench_message_queue", String(item.id)), null);
    assert.equal(store.list("task_message", 10).length, 0);
  } finally { await server.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});
