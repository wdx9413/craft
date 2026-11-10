import type { JsonObject } from "../infrastructure/store.ts";
import { DshWorkbenchRuns } from "./dsh-workbench-runs.ts";

const RUNS = "/api/workbench/dsh-runs";
const NATIVE = "/api/workbench/dsh-native";
const MODELS = "/api/workbench/dsh-models";

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

/** Workbench origin, token and body bounds are enforced by the caller. */
export async function dshRunRoute(runs: DshWorkbenchRuns, method: string, url: URL, body: JsonObject): Promise<{ status: number; value: JsonObject }> {
  if (url.pathname === MODELS && method === "GET") {
    return { status: 200, value: await runs.models(required(url.searchParams.get("workspace"), "workspace")) };
  }
  if (url.pathname === NATIVE && method === "GET") {
    return { status: 200, value: await runs.nativeSessions(url.searchParams.get("cursor"),
      url.searchParams.get("workspace")) };
  }
  if (url.pathname === NATIVE && method === "POST") {
    return { status: 201, value: await runs.importNative(
      required(body.task_id, "task_id"),
      required(body.thread_id, "thread_id"),
      required(body.workspace, "workspace"),
      body.permission ?? "ask",
    ) };
  }
  if (url.pathname === RUNS && method === "GET") {
    return { status: 200, value: runs.list(required(url.searchParams.get("task_id"), "task_id")) };
  }
  if (url.pathname === RUNS && method === "POST") {
    return { status: 202, value: await runs.create({
      task_id: required(body.task_id, "task_id"),
      workspace: required(body.workspace, "workspace"),
      prompt: required(body.prompt, "prompt"),
      operation_id: required(body.operation_id, "operation_id"),
      permission: body.permission as "ask" | "read_only" | "auto" | "full",
      model: typeof body.model === "string" ? body.model : null,
      reasoning_effort: typeof body.reasoning_effort === "string" ? body.reasoning_effort : null,
    }) };
  }
  if (url.pathname === `${RUNS}/turns` && method === "POST") {
    return { status: 202, value: await runs.send({
      task_id: required(body.task_id, "task_id"),
      link_id: required(body.link_id, "link_id"),
      prompt: required(body.prompt, "prompt"),
      operation_id: required(body.operation_id, "operation_id"),
      work_mode: body.work_mode,
    }) };
  }
  const match = /^\/api\/workbench\/dsh-runs\/([^/]+)(?:\/(events|approval|interrupt))?$/.exec(url.pathname);
  if (!match) return { status: 404, value: { error: "Not found" } };
  const id = decodeURIComponent(match[1]);
  const action = match[2];
  if (method === "GET" && action === "events") {
    const after = url.searchParams.get("after") ?? "0";
    if (!/^(0|[1-9]\d*)$/.test(after)) throw new Error("event cursor is invalid");
    return { status: 200, value: runs.events(required(url.searchParams.get("task_id"), "task_id"), id, Number(after)) };
  }
  if (method === "DELETE" && !action) {
    runs.release(required(url.searchParams.get("task_id"), "task_id"), id);
    return { status: 200, value: { released: true } };
  }
  if (method === "POST" && action === "interrupt") {
    runs.interrupt(required(body.task_id, "task_id"), id);
    return { status: 200, value: { requested: true } };
  }
  if (method === "POST" && action === "approval") {
    if (body.decision !== "accept" && body.decision !== "decline") throw new Error("approval decision is invalid");
    runs.decide(required(body.task_id, "task_id"), id, required(body.request_id, "request_id"), body.decision);
    return { status: 200, value: { decided: true } };
  }
  return { status: 404, value: { error: "Not found" } };
}

