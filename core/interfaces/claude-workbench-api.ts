import type { JsonObject } from "../infrastructure/store.ts";
import { ClaudeWorkbenchRuns } from "./claude-workbench-runs.ts";
import { findClaudeExecutable } from "./claude-executable.ts";

const BASE = "/api/workbench/claude-runs";
function required(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`); return value; }

/** Authentication, origin checks and body bounds are the server's responsibility. */
export function claudeRunRoute(runs: ClaudeWorkbenchRuns, method: string, url: URL, body: JsonObject, executable: () => string = findClaudeExecutable): { status: number; value: JsonObject } {
  if (url.pathname === BASE && method === "GET") {
    const task = required(url.searchParams.get("task_id"), "task_id");
    runs.first.store.get("task", task);
    return { status: 200, value: { runs: runs.registry.list(task) } };
  }
  if (url.pathname === `${BASE}/turns` && method === "POST") return { status: 202, value: runs.send({ task_id: required(body.task_id, "task_id"), link_id: required(body.link_id, "link_id"), prompt: required(body.prompt, "prompt"), operation_id: required(body.operation_id, "operation_id"), work_mode: body.work_mode, executable: executable() }) };
  if (url.pathname === BASE && method === "POST") {
    if (body.permission !== "ask" && body.permission !== "auto" && body.permission !== "full") throw new Error("Claude permission is unsupported");
    if (body.model !== undefined && body.model !== null && typeof body.model !== "string") throw new Error("model is invalid");
    return { status: 202, value: runs.create({ task_id: required(body.task_id, "task_id"), workspace: required(body.workspace, "workspace"), prompt: required(body.prompt, "prompt"), operation_id: required(body.operation_id, "operation_id"), permission: body.permission, work_mode: body.work_mode, model: body.model as string | null | undefined, executable: executable() }) };
  }
  const match = /^\/api\/workbench\/claude-runs\/([^/]+)(?:\/(events|approval|interrupt))?$/.exec(url.pathname);
  if (!match) return { status: 404, value: { error: "Not found" } };
  const id = decodeURIComponent(match[1]), action = match[2];
  if (method === "GET" && action === "events") {
    const after = url.searchParams.get("after") ?? "0";
    if (!/^(0|[1-9]\d*)$/.test(after)) throw new Error("event cursor is invalid");
    return { status: 200, value: runs.registry.events(required(url.searchParams.get("task_id"), "task_id"), id, Number(after)) };
  }
  if (method === "DELETE" && !action) { runs.registry.release(required(url.searchParams.get("task_id"), "task_id"), id); return { status: 200, value: { released: true } }; }
  if (method === "POST" && action === "interrupt") { runs.registry.interrupt(required(body.task_id, "task_id"), id); return { status: 200, value: { requested: true } }; }
  if (method === "POST" && action === "approval") {
    if (body.decision !== "accept" && body.decision !== "decline") throw new Error("approval decision is invalid");
    runs.registry.decide(required(body.task_id, "task_id"), id, required(body.request_id, "request_id"), body.decision, body.answers);
    return { status: 200, value: { decided: true } };
  }
  return { status: 404, value: { error: "Not found" } };
}
