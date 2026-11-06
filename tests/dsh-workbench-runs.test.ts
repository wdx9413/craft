import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { DshWorkbenchRuns } from "../core/interfaces/dsh-workbench-runs.ts";

function fakeClient() {
  let resolvePrompt!: (value: unknown) => void;
  let rejectPrompt!: (error: Error) => void;
  const responses: unknown[] = [];
  const client = {
    initialize: async () => ({ protocolVersion: 1 }),
    newSession: async () => ({ sessionId: "dsh-1", configOptions: [
      { id: "model", options: [{ group: "provider", name: "Provider", options: [{ value: "provider/model", name: "Model" }] }] },
    ] }),
    resumeSession: async (id: string) => ({ sessionId: id, configOptions: [] }),
    listSessions: async () => ({ sessions: [{ sessionId: "dsh-1", cwd: "/tmp" }], nextCursor: null }),
    closeSession: async () => undefined,
    setConfigOption: async () => [],
    prompt: () => new Promise((resolve, reject) => { resolvePrompt = resolve; rejectPrompt = reject; }),
    cancel: () => { responses.push({ cancel: true }); },
    respond: (id: unknown, value: unknown) => { responses.push({ id, value }); },
    respondError: () => undefined,
    close: () => undefined,
    resolvePrompt: (value: unknown) => resolvePrompt(value),
    rejectPrompt: (error: Error) => rejectPrompt(error),
    responses,
  };
  return client;
}

test("DSH workbench runs bind links, stream updates, approve and settle", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-dsh-runs-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const fake = fakeClient();
  const runs = new DshWorkbenchRuns(store, null, fake as never);
  try {
    store.create("task", "task", { title: "DSH task", status: "active" });
    const models = await runs.models(root);
    assert.equal((models.models as unknown[]).length, 1);
    assert.equal(((await runs.nativeSessions()).threads as unknown[]).length, 1);
    const created = await runs.create({ task_id: "task", workspace: root, prompt: "hello", operation_id: "create-1",
      permission: "ask", model: "provider/model", reasoning_effort: "high" });
    const runId = String(created.run_id), link = created.link as Record<string, unknown>;
    assert.equal(link.provider, "dsh");
    assert.equal(link.model, "provider/model");
    (runs as unknown as { receive(event: unknown): void }).receive({ type: "notification", method: "session/update",
      params: { sessionId: "dsh-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } } });
    (runs as unknown as { receive(event: unknown): void }).receive({ type: "request", id: "permission-1",
      method: "session/request_permission", params: { sessionId: "dsh-1", toolCall: { toolCallId: "tool-1", title: "Write" },
        options: [{ optionId: "allow-once", kind: "allow_once", name: "Allow" }, { optionId: "reject-once", kind: "reject_once", name: "Reject" }] } });
    const pending = runs.events("task", runId, 0);
    assert.equal((pending.events as unknown[]).length, 2);
    assert.equal((pending.approvals as unknown[]).length, 1);
    runs.decide("task", runId, "permission-1", "accept");
    assert.deepEqual(fake.responses[0], { id: "permission-1", value: { outcome: { outcome: "selected", optionId: "allow-once" } } });
    runs.interrupt("task", runId);
    assert.deepEqual(fake.responses[1], { cancel: true });
    fake.resolvePrompt({ stopReason: "cancelled" });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(runs.events("task", runId, 0).state, "completed");
    assert.equal(runs.links.get("task", String(link.id)).turn_state, "idle");
    const configured = await runs.configure("task", String(link.id), "provider/model", "auto");
    assert.equal((configured.link as Record<string, unknown>).permission, "auto");
    const imported = await runs.importNative("task", "dsh-2", root, "ask");
    assert.equal((imported.link as Record<string, unknown>).provider, "dsh");
    assert.equal((runs.list("task").runs as unknown[]).length, 2);
    runs.release("task", runId);
  } finally {
    await runs.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
