import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { CraftService } from "../core/application/craft-service.ts";
import { LocalWorkbenchServer, WorkbenchWebApp } from "../core/interfaces/workbench-server.ts";
import { CodexWorkbenchSessions } from "../core/interfaces/codex-workbench-sessions.ts";
import { type CodexServerEvent } from "../core/interfaces/codex-app-server-client.ts";

test("agent session API enforces authentication, task ownership and shared native lifecycle", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-agent-api-")));
  const store = await new CraftStore(craftPaths(root)).open();
  store.create("task", "task", {}); store.create("task", "other", {});
  let emit!: (event: CodexServerEvent) => void; const decisions: unknown[] = []; let closed = false;
  const sessions = new CodexWorkbenchSessions(store, callback => {
    emit = callback;
    return {
      initialize: async () => ({}), close: () => { closed = true; callback({ type: "closed", error: "closed" }); },
      respond: (id, result) => { decisions.push({ id, result }); },
      request: async (method, params) => method === "thread/start" || method === "thread/resume"
        ? { thread: { id: "native", ephemeral: false }, cwd: root, model: "model", sandbox: { type: params.sandbox === "workspace-write" ? "workspaceWrite" : "readOnly" }, approvalPolicy: params.approvalPolicy, approvalsReviewer: params.approvalsReviewer }
        : method === "turn/start" ? { turn: { id: "turn" } } : method === "thread/read" ? { thread: { id: "native", turns: [{ items: [{ type: "agentMessage", text: "native history" }] }] } }
        : method === "model/list" ? { data: [{ model: "model", displayName: "Model", isDefault: true }, { model: "hidden", hidden: true }], nextCursor: null } : {},
    };
  });
  const service = new CraftService(store); const origin = "http://localhost:4173";
  const app = () => new WorkbenchWebApp(service, "secret", origin, { agentSessions: sessions });
  const base = "/api/workbench/agent-sessions";
  const call = (method: string, path: string, body?: object) => app().handleAsync({ method, path, token: "secret", origin, body: body && JSON.stringify(body) });
  try {
    assert.equal((await app().handleAsync({ method: "GET", path: base })).status, 401);
    assert.equal((await app().handleAsync({ method: "GET", path: `${base}/directories` })).status, 401);
    assert.equal((await app().handleAsync({ method: "GET", path: `${base}/directories`, token: "secret", origin: "https://example.com" })).status, 403);
    assert.equal(JSON.parse((await call("GET", `${base}/directories?path=${encodeURIComponent(root)}`)).body).path, root);
    assert.equal((await app().handleAsync({ method: "GET", path: base, token: "secret", origin: "https://example.com" })).status, 403);
    assert.equal((await new WorkbenchWebApp(service, "secret", origin).handleAsync({ method: "GET", path: base, token: "secret" })).status, 503);
    assert.equal((await call("POST", base, { provider: "claude" })).status, 422);
    assert.equal((await call("POST", base, { provider: "codex", permission: "other" })).status, 422);
    assert.equal((await call("POST", base, { provider: "codex", permission: "ask", model: 9 })).status, 422);
    assert.equal((await call("GET", base)).status, 422);
    assert.equal((await call("GET", `${base}/bad/path`)).status, 404);
    assert.equal(JSON.parse((await call("GET", `${base}/providers`)).body).providers.length, 2);
    assert.deepEqual(JSON.parse((await call("GET", `${base}/models`)).body), { models: [{ id: "model", name: "Model", is_default: true }], truncated: false });
    const created = await call("POST", base, { provider: "codex", task_id: "task", workspace: root, model: "model", permission: "ask", operation_id: "create" });
    assert.equal(created.status, 201); const id = JSON.parse(created.body).link.id;
    assert.equal(JSON.parse((await call("GET", `${base}?task_id=task`)).body).links.length, 1);
    assert.equal((await call("POST", `${base}/${id}/resume`, { task_id: "task" })).status, 200);
    const queued = await call("POST", `${base}/${id}/queue`, { task_id: "task", prompt: "queued work" });
    assert.equal(queued.status, 201); const queuedId = JSON.parse(queued.body).item.id;
    assert.equal((await call("PATCH", `${base}/${id}/queue`, { task_id: "task", item_id: queuedId, prompt: "edited work" })).status, 200);
    assert.equal(JSON.parse((await call("GET", `${base}/${id}/queue?task_id=task`)).body).items[0].prompt, "edited work");
    assert.equal(JSON.parse((await call("GET", `${base}/${id}/queue?task_id=task`)).body).items.length, 1);
    assert.equal((await call("GET", `${base}/${id}/queue?task_id=other`)).status, 422);
    assert.equal((await call("DELETE", `${base}/${id}/queue?task_id=task&item_id=${queuedId}`)).status, 200);
    assert.equal(JSON.parse((await call("POST", `${base}/${id}/queue-dispatch`, { task_id: "task" })).body).empty, true);
    await call("POST", `${base}/${id}/queue`, { task_id: "task", prompt: "next queued task" });
    assert.equal((await call("POST", `${base}/${id}/queue-dispatch`, { task_id: "task" })).status, 202);
    assert.equal(JSON.parse((await call("GET", `${base}/${id}/queue?task_id=task`)).body).items.length, 0);
    emit({ type: "notification", method: "turn/completed", params: { threadId: "native", turn: { id: "turn", status: "completed" } } });
    assert.equal((await call("GET", `${base}/${id}/history?task_id=other`)).status, 422);
    assert.equal(JSON.parse((await call("GET", `${base}/${id}/history?task_id=task`)).body).thread.turns[0].items[0].text, "native history");
    assert.equal((await call("GET", `${base}/${id}/events?task_id=task&after=invalid`)).status, 422);
    assert.equal((await call("GET", `${base}/${id}`)).status, 404);
    assert.equal((await call("POST", `${base}/${id}/events`, { task_id: "task" })).status, 404);
    assert.equal((await call("POST", `${base}/${id}/resume`, { task_id: "other" })).status, 422);
    assert.equal((await call("POST", `${base}/${id}/turns`, { task_id: "task", prompt: "hello private", operation_id: "send" })).status, 202);
    const steerItem = JSON.parse((await call("POST", `${base}/${id}/queue`, { task_id: "task", prompt: "change direction" })).body).item;
    assert.equal((await call("POST", `${base}/${id}/queue-steer`, { task_id: "other", item_id: steerItem.id })).status, 422);
    assert.equal((await call("POST", `${base}/${id}/queue-steer`, { task_id: "task", item_id: steerItem.id })).status, 202);
    assert.equal((await call("POST", `${base}/${id}/queue-steer`, { task_id: "task", item_id: steerItem.id })).status, 422);
    assert.equal((await call("POST", `${base}/${id}/turns`, { task_id: "task", prompt: "hello private", operation_id: "send" })).status, 422);
    emit({ type: "request", id: 2, method: "item/commandExecution/requestApproval", params: { threadId: "native", turnId: "turn", command: "echo ok" } });
    assert.equal((await call("GET", `${base}/${id}/events?task_id=other`)).status, 422);
    const events = JSON.parse((await call("GET", `${base}/${id}/events?task_id=task`)).body);
    assert.equal(events.approvals.length, 1);
    assert.equal((await call("POST", `${base}/${id}/approval`, { task_id: "other", request_id: 2, decision: "accept" })).status, 422);
    assert.equal((await call("POST", `${base}/${id}/approval`, { task_id: "task", request_id: 2, decision: "skip" })).status, 422);
    assert.equal((await call("POST", `${base}/${id}/approval`, { task_id: "task", request_id: 2, decision: "decline" })).status, 200);
    assert.deepEqual(decisions, [{ id: 2, result: { decision: "decline" } }]);
    assert.equal((await call("DELETE", `${base}/${id}?task_id=task`)).status, 422);
    assert.equal((await call("POST", `${base}/${id}/interrupt`, { task_id: "task" })).status, 200);
    emit({ type: "notification", method: "turn/completed", params: { threadId: "native", turn: { id: "turn", status: "interrupted" } } });
    assert.equal((await call("DELETE", `${base}/${id}?task_id=task`)).status, 200);
    assert.equal(closed, true); assert.equal(store.list("task_message", 100).length, 0);
  } finally { sessions.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("local HTTP server exposes the session list and supports restart", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-agent-http-")));
  const store = await new CraftStore(craftPaths(root)).open(); store.create("task", "task", {});
  const server = new LocalWorkbenchServer(new CraftService(store), "secret");
  try {
    for (let i = 0; i < 2; i++) {
      const started = await server.start(0);
      const url = new URL("/api/workbench/agent-sessions?task_id=task", started.url);
      const result = await fetch(url, { headers: { authorization: "Bearer secret" } });
      assert.equal(result.status, 200); assert.deepEqual((await result.json() as { links: unknown[] }).links, []);
      await server.close();
    }
  } finally { await server.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
