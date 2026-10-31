import { type JsonObject } from "../infrastructure/store.ts";
import { CodexWorkbenchSessions } from "./codex-workbench-sessions.ts";
import { detectWorkbenchClis } from "./workbench-cli-detection.ts";
import { ClaudeWorkbenchHistory } from "./claude-workbench-history.ts";
import { ClaudeNativeSessions } from "./claude-native-sessions.ts";
import { claudeWorkbenchCommands } from "./claude-workbench-commands.ts";
import { listWorkbenchDirectories, listWorkbenchFiles } from "./workbench-directories.ts";
import { claudeWorkbenchModels } from "./claude-workbench-models.ts";
import { claudeWorkbenchUsage } from "./claude-workbench-usage.ts";
import { WorkbenchMessageQueue } from "./workbench-message-queue.ts";
import { reconcileQueueItem } from "./workbench-queue-recovery.ts";
import { type ClaudeWorkbenchRuns } from "./claude-workbench-runs.ts";
import { findClaudeExecutable } from "./claude-executable.ts";
import { pickWorkbenchFiles, pickWorkbenchFolder, type WorkbenchFilesPicker, type WorkbenchFolderPicker } from "./workbench-folder-picker.ts";

const BASE = "/api/workbench/agent-sessions";
function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value;
}

/** The caller must enforce the Workbench origin, token and request size checks. */
export async function agentSessionRoute(sessions: CodexWorkbenchSessions, method: string, url: URL, body: JsonObject, claudeRuns?: ClaudeWorkbenchRuns | null, pickFolder: WorkbenchFolderPicker = pickWorkbenchFolder, pickFiles: WorkbenchFilesPicker = pickWorkbenchFiles): Promise<{ status: number; value: JsonObject }> {
  if (url.pathname === `${BASE}/projects` && method === "GET") return { status: 200, value: sessions.links.projectPage(Number(url.searchParams.get("limit") ?? 50), url.searchParams.get("cursor"), url.searchParams.get("workspace")) };
  if (url.pathname === `${BASE}/providers` && method === "GET") return { status: 200, value: await detectWorkbenchClis() };
  if (url.pathname === `${BASE}/directories` && method === "GET") return { status: 200, value: await listWorkbenchDirectories(url.searchParams.get("path")) };
  if ((url.pathname === `${BASE}/pick-reference-folder` || url.pathname === `${BASE}/pick-project-folder`) && method === "POST") {
    const workspace = body.workspace === undefined || body.workspace === null ? null : required(body.workspace, "workspace");
    return { status: 200, value: await pickFolder(workspace) };
  }
  if (url.pathname === `${BASE}/pick-reference-files` && method === "POST") {
    const workspace = body.workspace === undefined || body.workspace === null ? null : required(body.workspace, "workspace");
    return { status: 200, value: await pickFiles(workspace) };
  }
  if (url.pathname === `${BASE}/files` && method === "GET") return { status: 200, value: await listWorkbenchFiles(
    required(url.searchParams.get("workspace"), "workspace"), url.searchParams.get("query") ?? "", Number(url.searchParams.get("limit") ?? "200")) };
  if (url.pathname === `${BASE}/models` && method === "GET") return { status: 200, value: await sessions.models() };
  if (url.pathname === `${BASE}/codex-skills` && method === "GET") return { status: 200, value: await sessions.skills(required(url.searchParams.get("workspace"), "workspace")) };
  if (url.pathname === `${BASE}/claude-commands` && method === "GET") return { status: 200, value: await claudeWorkbenchCommands(url.searchParams.get("workspace")) };
  if (url.pathname === `${BASE}/codex-usage` && method === "GET") return { status: 200, value: await sessions.usage() };
  if (url.pathname === `${BASE}/codex-native` && method === "GET") return { status: 200, value: await sessions.nativeSessions(url.searchParams.get("cursor")) };
  if (url.pathname === `${BASE}/codex-native` && method === "POST") return { status: 201, value: await sessions.importNative(required(body.task_id, "task_id"), required(body.thread_id, "thread_id")) };
  if (url.pathname === `${BASE}/claude-native` && method === "GET") {
    const offset = url.searchParams.get("cursor") ?? "0";
    if (!/^(0|[1-9]\d*)$/.test(offset)) throw new Error("session offset is invalid");
    return { status: 200, value: await new ClaudeNativeSessions(sessions.links).list(Number(offset)) };
  }
  if (url.pathname === `${BASE}/claude-native` && method === "POST") return { status: 201, value: await new ClaudeNativeSessions(sessions.links).import(required(body.task_id, "task_id"), required(body.thread_id, "thread_id"), body.model ?? null, body.permission) };
  if (url.pathname === `${BASE}/claude-models` && method === "GET") return { status: 200, value: await claudeWorkbenchModels(url.searchParams.get("workspace")) };
  if (url.pathname === `${BASE}/claude-usage` && method === "GET") return { status: 200, value: await claudeWorkbenchUsage(url.searchParams.get("workspace")) };
  if (url.pathname === BASE && method === "GET") return { status: 200, value: sessions.links.list(required(url.searchParams.get("task_id"), "task_id")) };
  if (url.pathname === BASE && method === "POST") {
    if (body.provider !== "codex") throw new Error("provider is unsupported");
    if (body.permission !== "ask" && body.permission !== "read_only" && body.permission !== "auto" && body.permission !== "full") throw new Error("permission is unsupported");
    if (body.model !== undefined && body.model !== null && typeof body.model !== "string") throw new Error("model is invalid");
    return { status: 201, value: await sessions.create({ task_id: required(body.task_id, "task_id"), workspace: required(body.workspace, "workspace"), model: body.model as string | null | undefined, permission: body.permission, operation_id: required(body.operation_id, "operation_id") }) };
  }
  const match = /^\/api\/workbench\/agent-sessions\/([^/]+)(?:\/(resume|turns|steer|events|history|interrupt|approval|answer|reconcile|takeover|goal|queue|queue-dispatch|queue-steer|queue-reconcile|configuration))?$/.exec(url.pathname);
  if (!match) return { status: 404, value: { error: "Not found" } };
  const id = decodeURIComponent(match[1]);
  const action = match[2];
  if (action === "queue" && method === "GET") return { status: 200, value: { items: new WorkbenchMessageQueue(sessions.store).list(required(url.searchParams.get("task_id"), "task_id"), id) } };
  if (action === "queue" && method === "DELETE") { await sessions.store.transactionWithRetry(() => new WorkbenchMessageQueue(sessions.store).cancel(required(url.searchParams.get("task_id"), "task_id"), id, required(url.searchParams.get("item_id"), "item_id"))); return { status: 200, value: { cancelled: true } }; }
  if (action === "queue" && method === "PATCH") return { status: 200, value: { item: await sessions.store.transactionWithRetry(() => new WorkbenchMessageQueue(sessions.store).edit(required(body.task_id, "task_id"), id, required(body.item_id, "item_id"), required(body.prompt, "prompt"))) } };
  if (method === "GET" && action === "goal") return { status: 200, value: await sessions.goal(required(url.searchParams.get("task_id"), "task_id"), id) };
  if (method === "GET" && action === "takeover") return { status: 200, value: sessions.takeoverCandidate(required(url.searchParams.get("task_id"), "task_id"), id) };
  if (method === "GET" && action === "events") {
    const task = required(url.searchParams.get("task_id"), "task_id");
    const after = url.searchParams.get("after") ?? "0";
    if (!/^(0|[1-9]\d*)$/.test(after)) throw new Error("event cursor is invalid");
    return { status: 200, value: sessions.events(task, id, url.searchParams.get("generation"), Number(after)) };
  }
  if (method === "GET" && action === "history") {
    const task = required(url.searchParams.get("task_id"), "task_id");
    const link = sessions.links.get(task, id);
    if (link.provider === "claude") {
      const offset = url.searchParams.get("offset") ?? "0";
      if (!/^(0|[1-9]\d*)$/.test(offset)) throw new Error("history offset is invalid");
      return { status: 200, value: { provider: "claude", ...await new ClaudeWorkbenchHistory(sessions.links).read(task, id, Number(offset)) } };
    }
    return { status: 200, value: await sessions.history(task, id) };
  }
  if (method === "DELETE" && action === undefined) {
    sessions.unlink(required(url.searchParams.get("task_id"), "task_id"), id);
    return { status: 200, value: { unlinked: true } };
  }
  if (method !== "POST" || !action) return { status: 404, value: { error: "Not found" } };
  const task = required(body.task_id, "task_id");
  if (action === "queue-reconcile") return { status: 200, value: await reconcileQueueItem(sessions.store, task, id, required(body.item_id, "item_id"), body.expected_version, body.action) };
  if (action === "configuration") return { status: 200, value: { link: sessions.links.configure(task, id, body.model, body.permission) } };
  if (action === "queue") return { status: 201, value: { item: await sessions.store.transactionWithRetry(() => new WorkbenchMessageQueue(sessions.store).enqueue(task, id, required(body.prompt, "prompt"), body.work_mode)) } };
  if (action === "queue-steer") {
    const queue = new WorkbenchMessageQueue(sessions.store), item = await sessions.store.transactionWithRetry(() => queue.claimSteer(task, id, required(body.item_id, "item_id")));
    try {
      await sessions.steer(task, id, String(item.prompt), String(item.operation_id));
      await sessions.store.transactionWithRetry(() => queue.settle(task, id, String(item.id), true));
      return { status: 202, value: { accepted: true, prompt: item.prompt } };
    } catch (error) {
      // Keep the original failure as the cause. If settling also fails the item
      // stays claimed for the queue reconcile surface; it must not replace the
      // steering error with a settle error.
      try { await sessions.store.transactionWithRetry(() => queue.settle(task, id, String(item.id), false)); } catch { /* reconcile later */ }
      throw new Error("steering outcome may be unknown; inspect before retrying", { cause: error });
    }
  }
  if (action === "queue-dispatch") {
    const queue = new WorkbenchMessageQueue(sessions.store);
    // Re-read after acquiring the writer: another window may have claimed the
    // head while this request yielded for contention. Losing that race is empty.
    const reservation = await sessions.store.transactionWithRetry(() => {
      const link = sessions.links.get(task, id);
      if (link.last_turn_status === "failed" || link.last_turn_status === "interrupted") throw new Error("queue paused after unsuccessful turn");
      const items = queue.list(task, id), item = items[0];
      if (!item || item.state !== "queued" || link.turn_state !== "idle" || items.some(row => row.state === "dispatching" || row.state === "unknown")) return null;
      return { claimed: queue.claim(task, id, String(item.id)), link };
    });
    if (!reservation) return { status: 200, value: { empty: true } };
    const { claimed, link } = reservation;
    try {
      let result: JsonObject;
      if (link.provider === "codex") result = await sessions.send(task, id, String(claimed.prompt), String(claimed.operation_id), claimed.work_mode);
      else if (link.provider === "claude" && claudeRuns) result = claudeRuns.send({ task_id: task, link_id: id, prompt: String(claimed.prompt), operation_id: String(claimed.operation_id), executable: findClaudeExecutable(), work_mode: claimed.work_mode });
      else throw new Error("provider is unavailable");
      await sessions.store.transactionWithRetry(() => queue.settle(task, id, String(claimed.id), true));
      return { status: 202, value: { provider: link.provider, prompt: claimed.prompt, ...result } };
    } catch (error) {
      try { await sessions.store.transactionWithRetry(() => queue.settle(task, id, String(claimed.id), false)); } catch { /* reconcile later */ }
      throw new Error("queue dispatch outcome may be unknown; inspect before retrying", { cause: error });
    }
  }
  if (action === "goal") return { status: 200, value: await sessions.goal(task, id, required(body.objective, "objective")) };
  if (action === "takeover") return { status: 200, value: await sessions.takeover(task, id, body.pid, body.started, body.session_count) };
  if (action === "resume") return { status: 200, value: await sessions.resume(task, id) };
  if (action === "reconcile") return { status: 200, value: await sessions.reconcile(task, id) };
  if (action === "turns") return { status: 202, value: await sessions.send(task, id, required(body.prompt, "prompt"), required(body.operation_id, "operation_id"), body.work_mode) };
  if (action === "steer") return { status: 202, value: await sessions.steer(task, id, required(body.prompt, "prompt"), required(body.operation_id, "operation_id")) };
  if (action === "interrupt") { await sessions.interrupt(task, id); return { status: 200, value: { requested: true } }; }
  if (action === "answer") {
    if (typeof body.request_id !== "string" && typeof body.request_id !== "number") throw new Error("request_id is invalid");
    sessions.answer(task, id, body.request_id, body.answers);
    return { status: 200, value: { answered: true } };
  }
  if (action === "approval") {
    if ((typeof body.request_id !== "string" && typeof body.request_id !== "number") || (body.decision !== "accept" && body.decision !== "decline")) throw new Error("approval decision is invalid");
    sessions.decide(task, id, body.request_id, body.decision);
    return { status: 200, value: { decided: true } };
  }
  return { status: 404, value: { error: "Not found" } };
}
