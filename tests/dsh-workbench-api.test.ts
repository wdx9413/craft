import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { DshWorkbenchRuns } from "../core/interfaces/dsh-workbench-runs.ts";
import { dshRunRoute } from "../core/interfaces/dsh-workbench-api.ts";

function fakeClient() {
  let resolvePrompt!: (value: unknown) => void;
  const responses: unknown[] = [];
  return {
    initialize: async () => ({ protocolVersion: 1 }),
    newSession: async () => ({ sessionId: "route-session", configOptions: [{ id: "model", options: [{ name: "P", options: [{ value: "p/m", name: "M" }] }] }] }),
    resumeSession: async (id: string) => ({ sessionId: id, configOptions: [] }),
    listSessions: async () => ({ sessions: [{ sessionId: "route-session", cwd: "/tmp" }], nextCursor: "next" }),
    closeSession: async () => undefined,
    setConfigOption: async () => [],
    prompt: () => new Promise(resolve => { resolvePrompt = resolve; }),
    cancel: () => { responses.push({ cancel: true }); },
    respond: (id: unknown, value: unknown) => { responses.push({ id, value }); },
    respondError: () => undefined,
    close: () => undefined,
    resolvePrompt: (value: unknown) => resolvePrompt(value),
    responses,
  };
}

test("DSH Workbench routes expose models, native sessions, runs, approvals and release", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-dsh-api-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const fake = fakeClient();
  const runs = new DshWorkbenchRuns(store, null, fake as never);
  try {
    store.create("task", "task", { title: "Task", status: "active" });
    const models = await dshRunRoute(runs, "GET", new URL(`http://localhost/api/workbench/dsh-models?workspace=${encodeURIComponent(root)}`), {});
    assert.equal(models.status, 200);
    assert.equal((models.value.models as unknown[]).length, 1);
    const native = await dshRunRoute(runs, "GET", new URL("http://localhost/api/workbench/dsh-native"), {});
    assert.equal(native.status, 200);
    assert.equal((native.value.threads as unknown[]).length, 1);
    const created = await dshRunRoute(runs, "POST", new URL("http://localhost/api/workbench/dsh-runs"), {
      task_id: "task", workspace: root, prompt: "hello", operation_id: "op-1", permission: "ask", model: "p/m",
    });
    assert.equal(created.status, 202);
    const runId = String(created.value.run_id);
    const listed = await dshRunRoute(runs, "GET", new URL("http://localhost/api/workbench/dsh-runs?task_id=task"), {});
    assert.equal((listed.value.runs as unknown[]).length, 1);
    const events = await dshRunRoute(runs, "GET", new URL(`http://localhost/api/workbench/dsh-runs/${runId}/events?task_id=task&after=0`), {});
    assert.equal(events.status, 200);
    const interrupted = await dshRunRoute(runs, "POST", new URL(`http://localhost/api/workbench/dsh-runs/${runId}/interrupt`), { task_id: "task" });
    assert.equal(interrupted.status, 200);
    fake.resolvePrompt({ stopReason: "cancelled" });
    await new Promise(resolve => setTimeout(resolve, 10));
    const released = await dshRunRoute(runs, "DELETE", new URL(`http://localhost/api/workbench/dsh-runs/${runId}?task_id=task`), {});
    assert.equal(released.status, 200);
    const imported = await dshRunRoute(runs, "POST", new URL("http://localhost/api/workbench/dsh-native"), {
      task_id: "task", thread_id: "route-session-2", workspace: root, permission: "ask",
    });
    assert.equal(imported.status, 201);
  } finally {
    await runs.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
