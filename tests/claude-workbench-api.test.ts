import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { CraftService } from "../core/application/craft-service.ts";
import { WorkbenchWebApp } from "../core/interfaces/workbench-server.ts";
import { ClaudeWorkbenchAdapter } from "../core/interfaces/claude-workbench-adapter.ts";
import { ClaudeWorkbenchRuns } from "../core/interfaces/claude-workbench-runs.ts";

test("Claude HTTP routes protect task-scoped creation and live events", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-claude-api-"))); const store = await new CraftStore(craftPaths(root)).open(); store.create("task", "t", {});
  let usedExecutable = "";
  const adapter = new ClaudeWorkbenchAdapter(({ options }) => { usedExecutable = options.pathToClaudeCodeExecutable || ""; return { async *[Symbol.asyncIterator]() {
    yield { type: "system", subtype: "init", session_id: options.sessionId || options.resume, cwd: root, permissionMode: "default", model: "model" } as SDKMessage;
    yield { type: "result", subtype: "success", session_id: options.sessionId || options.resume } as SDKMessage;
  }, close() {} }; });
  const runs = new ClaudeWorkbenchRuns(store, adapter); const app = new WorkbenchWebApp(new CraftService(store), "secret", "http://localhost:4173", { claudeRuns: runs, claudeExecutable: () => join(root, "claude") });
  const base = "/api/workbench/claude-runs";
  const call = (method: string, path: string, body?: object, token = "secret", origin = "http://localhost:4173") => app.handleAsync({ method, path, token, origin, body: body && JSON.stringify(body) });
  try {
    assert.equal((await call("GET", base, undefined, "wrong")).status, 401);
    assert.equal((await call("GET", base, undefined, "secret", "https://evil.example")).status, 403);
    assert.equal((await call("POST", base, { permission: "read_only" })).status, 422);
    assert.equal((await call("GET", base)).status, 422);
    assert.equal((await call("POST", base, { permission: "ask", model: 7 })).status, 422);
    for (const body of [
      { permission: "ask", workspace: root, prompt: "hi", operation_id: "x" },
      { permission: "ask", task_id: "t", prompt: "hi", operation_id: "x" },
      { permission: "ask", task_id: "t", workspace: root, operation_id: "x" },
      { permission: "ask", task_id: "t", workspace: root, prompt: "hi", operation_id: " " },
    ]) assert.equal((await call("POST", base, body)).status, 422);
    assert.equal(store.list("workbench_claude_creation", 10).length, 0);
    assert.equal((await call("GET", `${base}/missing/unknown?task_id=t`)).status, 404);
    assert.equal((await call("PATCH", `${base}/missing/events?task_id=t`)).status, 404);
    const request = { task_id: "t", workspace: root, permission: "ask", prompt: "hello", operation_id: "once", executable: "/untrusted" };
    const response = await call("POST", base, request); assert.equal(response.status, 202);
    const id = JSON.parse(response.body).run_id;
    assert.equal(JSON.parse((await call("GET", `${base}?task_id=t`)).body).runs[0].run_id, id);
    assert.equal((await call("GET", `${base}?task_id=other`)).status, 422);
    assert.equal(store.list("workbench_claude_creation", 10).length, 1);
    assert.equal((await call("POST", base, request)).status, 422);
    for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
    const page = await call("GET", `${base}/${id}/events?task_id=t`); assert.equal(JSON.parse(page.body).state, "completed");
    const links = runs.first.links.list("t").links as Record<string, unknown>[];
    const next = { task_id: "t", link_id: links[0].id, prompt: "again", operation_id: "next" };
    assert.equal((await call("POST", `${base}/turns`, { ...next, task_id: "other" })).status, 422);
    const turn = await call("POST", `${base}/turns`, next); assert.equal(turn.status, 202);
    assert.equal((await call("POST", `${base}/turns`, next)).status, 422);
    for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(JSON.parse((await call("GET", `${base}/${JSON.parse(turn.body).run_id}/events?task_id=t`)).body).state, "completed");
    assert.equal((await call("POST", `${base}/turns`, next)).status, 422);
    assert.notEqual(usedExecutable, "/untrusted");
    assert.equal((await call("GET", `${base}/${id}/events?task_id=other`)).status, 422);
    assert.equal((await call("DELETE", `${base}/${id}?task_id=t`)).status, 200);
    assert.equal(store.list("task_message", 10).length, 0);
  } finally { runs.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Claude HTTP approval and interrupt routes enforce task and pending state", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-claude-approval-api-")));
  const store = await new CraftStore(craftPaths(root)).open(); store.create("task", "t", {}); store.create("task", "other", {});
  const runs = new ClaudeWorkbenchRuns(store); const app = new WorkbenchWebApp(new CraftService(store), "secret", "http://localhost:4173", { claudeRuns: runs });
  const call = (method: string, path: string, body?: object) => app.handleAsync({ method, path, token: "secret", origin: "http://localhost:4173", body: body && JSON.stringify(body) });
  let answer: unknown;
  try {
    const id = runs.registry.start("t", async (approvals, _emit, abort) => { answer = await approvals.canUseTool("Bash", { command: "echo test" }, { signal: abort.signal, toolUseID: "tool", requestId: "request" }); });
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    const base = `/api/workbench/claude-runs/${id}`;
    const pending = JSON.parse((await call("GET", `${base}/events?task_id=t`)).body).approvals[0];
    assert.equal((await call("GET", `${base}/events?task_id=t&after=01`)).status, 422);
    assert.equal((await call("GET", `${base}/events`)).status, 422);
    assert.equal((await call("POST", `${base}/approval`, { task_id: "t", decision: "accept" })).status, 422);
    assert.equal((await call("DELETE", `${base}?task_id=t`)).status, 422);
    assert.equal((await call("POST", `${base}/approval`, { task_id: "other", request_id: pending.id, decision: "accept" })).status, 422);
    assert.equal((await call("POST", `${base}/approval`, { task_id: "t", request_id: pending.id, decision: "invalid" })).status, 422);
    assert.equal((await call("POST", `${base}/approval`, { task_id: "t", request_id: pending.id, decision: "decline" })).status, 200);
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(answer, { behavior: "deny", message: "User declined" });
    assert.equal((await call("POST", `${base}/approval`, { task_id: "t", request_id: pending.id, decision: "decline" })).status, 422);
    assert.equal((await call("POST", `${base}/interrupt`, { task_id: "t" })).status, 422);
    assert.equal((await call("GET", `${base}/events?task_id=t&after=-1`)).status, 422);
    const active = runs.registry.start("t", async (approvals, _emit, abort) => { await approvals.canUseTool("Write", {}, { signal: abort.signal, toolUseID: "tool", requestId: "request" }); });
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal((await call("POST", `/api/workbench/claude-runs/${active}/interrupt`, { task_id: "other" })).status, 422);
    assert.equal((await call("POST", `/api/workbench/claude-runs/${active}/interrupt`, { task_id: "t" })).status, 200);
  } finally { runs.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
