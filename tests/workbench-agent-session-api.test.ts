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
import { DatabaseSync } from "node:sqlite";
import { WorkbenchMessageQueue } from "../core/interfaces/workbench-message-queue.ts";
import { agentSessionRoute } from "../core/interfaces/workbench-agent-session-api.ts";

test("two waiting windows treat a competing queue claim as empty rather than an unknown send", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-queue-windows-")));
  const store = await new CraftStore(craftPaths(root)).open();
  const sessions = new CodexWorkbenchSessions(store);
  const peer = new DatabaseSync(store.paths.databaseFile);
  let release: ReturnType<typeof setTimeout> | undefined;
  try {
    store.create("task", "task", {});
    const queue = new WorkbenchMessageQueue(store);
    const link = queue.links.bind({ task_id: "task", provider: "codex", native_session_id: "native", workspace: root, permission: "ask" }).link as Record<string, unknown>;
    const item = queue.enqueue("task", String(link.id), "one queued input");
    let submissions = 0;
    sessions.send = async () => { submissions++; return { link: {}, turn_id: "turn" }; };
    peer.exec("BEGIN IMMEDIATE");
    release = setTimeout(() => peer.exec("ROLLBACK"), 60);
    const url = new URL(`http://localhost/api/workbench/agent-sessions/${link.id}/queue-dispatch`);
    const results = await Promise.allSettled([agentSessionRoute(sessions, "POST", url, { task_id: "task" }), agentSessionRoute(sessions, "POST", url, { task_id: "task" })]);
    assert.equal(results.every(result => result.status === "fulfilled"), true, "a normal competing claim must not report a transport failure");
    const responses = results.map(result => { assert.equal(result.status, "fulfilled"); return result.value; });
    assert.deepEqual(responses.map(result => result.status).sort(), [200, 202]);
    assert.equal(responses.find(result => result.status === 200)!.value.empty, true);
    assert.equal(submissions, 1);
    assert.equal(store.find("workbench_message_queue", String(item.id)), null);
    assert.equal(store.list("workbench_message_queue_receipt", 10).length, 1);
  } finally { clearTimeout(release); peer.close(); sessions.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("atomic queue dispatch stays paused for failed, active and uncertain turns", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-queue-paused-")));
  const store = await new CraftStore(craftPaths(root)).open();
  const sessions = new CodexWorkbenchSessions(store);
  try {
    store.create("task", "task", {});
    const queue = new WorkbenchMessageQueue(store);
    const link = queue.links.bind({ task_id: "task", provider: "codex", native_session_id: "native", workspace: root, permission: "ask" }).link as Record<string, unknown>;
    const id = String(link.id), first = queue.enqueue("task", id, "first"), second = queue.enqueue("task", id, "second");
    const dispatch = () => agentSessionRoute(sessions, "POST", new URL(`http://localhost/api/workbench/agent-sessions/${id}/queue-dispatch`), { task_id: "task" });
    sessions.send = async () => assert.fail("a paused queue must not send");
    const change = (values: Record<string, unknown>) => store.save("workbench_agent_session_link", id, { ...store.get("workbench_agent_session_link", id), ...values });
    for (const status of ["failed", "interrupted"]) {
      change({ last_turn_status: status }); await assert.rejects(dispatch(), /paused after unsuccessful/);
    }
    change({ last_turn_status: "completed", turn_state: "running" });
    assert.equal((await dispatch()).value.empty, true);
    queue.claimSteer("task", id, String(second.id));
    change({ turn_state: "idle" });
    assert.equal((await dispatch()).value.empty, true);
    queue.settle("task", id, String(second.id), false);
    assert.equal((await dispatch()).value.empty, true);
    assert.equal(queue.list("task", id)[0].id, first.id);
    assert.equal(queue.list("task", id)[0].state, "queued");
    assert.equal(queue.list("task", id)[1].state, "unknown");
  } finally { sessions.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

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
    const picked = await agentSessionRoute(sessions, "POST", new URL(`http://localhost${base}/pick-reference-folder`), { workspace: root }, undefined, async initial => {
      assert.equal(initial, root); return { path: root };
    });
    assert.deepEqual(picked, { status: 200, value: { path: root } });
    const pickedWithoutWorkspace = await agentSessionRoute(sessions, "POST", new URL(`http://localhost${base}/pick-reference-folder`), {}, undefined, async initial => {
      assert.equal(initial, null); return { cancelled: true };
    });
    assert.deepEqual(pickedWithoutWorkspace, { status: 200, value: { cancelled: true } });
    const pickedProject = await agentSessionRoute(sessions, "POST", new URL(`http://localhost${base}/pick-project-folder`), { workspace: root }, undefined, async initial => {
      assert.equal(initial, root); return { path: root };
    });
    assert.deepEqual(pickedProject, { status: 200, value: { path: root } });
    await assert.rejects(agentSessionRoute(sessions, "POST", new URL(`http://localhost${base}/pick-reference-folder`), { workspace: 9 }), /workspace is required/u);
    assert.equal((await app().handleAsync({ method: "GET", path: base, token: "secret", origin: "https://example.com" })).status, 403);
    assert.equal((await new WorkbenchWebApp(service, "secret", origin).handleAsync({ method: "GET", path: base, token: "secret" })).status, 503);
    assert.equal((await call("POST", base, { provider: "claude" })).status, 422);
    assert.equal((await call("POST", base, { provider: "codex", permission: "other" })).status, 422);
    assert.equal((await call("POST", base, { provider: "codex", permission: "ask", model: 9 })).status, 422);
    assert.equal((await call("GET", base)).status, 422);
    assert.equal((await app().handleAsync({ method: "GET", path: `${base}/projects` })).status, 401);
    assert.equal((await call("GET", `${base}/projects?limit=0`)).status, 422);
    assert.ok(Array.isArray(JSON.parse((await call("GET", `${base}/projects?limit=1`)).body).links));
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
    const recovering = JSON.parse((await call("POST", `${base}/${id}/queue`, { task_id: "task", prompt: "acknowledged before receipt failure" })).body).item;
    const create = store.create; let failReceipt = true;
    store.create = function(kind, recordId, payload) { if (kind === "workbench_message_queue_receipt" && failReceipt) { failReceipt = false; throw new Error("receipt publication failed"); } return create.call(this, kind, recordId, payload); };
    try { assert.equal((await call("POST", `${base}/${id}/queue-dispatch`, { task_id: "task" })).status, 422); }
    finally { store.create = create; }
    const uncertain = store.get("workbench_message_queue", recovering.id);
    assert.equal(uncertain.state, "unknown");
    const recoverPath = `${base}/${id}/queue-reconcile`;
    assert.equal((await app().handleAsync({ method: "POST", path: recoverPath, body: "{}" })).status, 401);
    assert.equal((await call("POST", recoverPath, { task_id: "other", item_id: recovering.id, expected_version: uncertain.version, action: "inspect" })).status, 422);
    assert.equal(JSON.parse((await call("POST", recoverPath, { task_id: "task", item_id: recovering.id, expected_version: uncertain.version, action: "inspect" })).body).outcome, "accepted");
    assert.equal(store.find("workbench_message_queue", recovering.id), null);
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
