import { createHash } from "node:crypto";
import { stableDigest } from "./digest.ts";
import type { JsonObject } from "./infrastructure/store.ts";

/**
 * Deterministic Pilot orchestration helpers.
 *
 * The Pilot product surface is a projection over ordinary Tasks and Routes.
 * Mainer, Router and Reviewer therefore stay pure and model-free: they can
 * reject malformed work, choose a configured executor and expose a hard-gated
 * review, but they never create a second Task store or grant execution.
 */
export const PILOT_EXECUTORS = ["craft", "codex", "claude", "dsh", "agent-desktop"] as const;
export const PILOT_MAX_TASKS = 8;

export interface PilotExecutorChoice {
  executor_template: string;
  reason: string;
  confidence: number;
}

export interface PilotReviewCheck {
  id: string;
  ok: boolean;
  level: "block" | "needs_human" | "warn";
  detail: string;
}

export interface PilotReview {
  verdict: "pass" | "needs_human" | "block";
  checks: PilotReviewCheck[];
}

/** Read the optional Worker observation attached to a Pilot route. */
export function routeWorker(route: JsonObject): JsonObject | null {
  const value = route.worker;
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}

function knownExecutor(value: string): boolean {
  return (PILOT_EXECUTORS as readonly string[]).includes(value);
}

function normalizedGoal(value: string): string {
  return value.replace(/\r\n?/gu, "\n").replace(/[ \t]+/gu, " ").trim();
}

function titleOf(goal: string): string {
  const firstLine = goal.split("\n")[0].replace(/^#{1,6}\s+/u, "").replace(/^[-*]\s+/u, "").trim();
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

function stripListMarker(value: string): string {
  return value.replace(/^\s*(?:\d+[.)、]|[-*])\s+/u, "").trim();
}

function listSections(lines: string[]): string[] {
  const sections: string[] = [];
  let current = "";
  for (const line of lines) {
    if (/^\s*(?:\d+[.)、]|[-*])\s+/u.test(line)) {
      if (current) sections.push(current);
      current = stripListMarker(line);
    } else if (current && line.trim()) {
      current += `\n${line.trim()}`;
    }
  }
  if (current) sections.push(current);
  return sections;
}

/**
 * Mainer: split one intent without asking a model.
 *
 * A numbered/bulleted list is treated as an explicit task list. Otherwise a
 * blank line is the boundary. Unknown shape is still one task rather than an
 * invented decomposition.
 */
export function splitPilotInput(input: string, options: {
  preferred_executor?: string | null;
  available_executors?: readonly string[];
} = {}): JsonObject[] {
  const value = nonEmpty(input, "input");
  if (value.length > 32_000) throw new Error("pilot input is too large");
  const lines = value.split(/\r?\n/u);
  const listLines = lines.filter((line) => /^\s*(?:\d+[.)、]|[-*])\s+/u.test(line));
  const rawParts = listLines.length >= 2
    ? listSections(lines)
    : value.split(/\n\s*\n/u).map((part) => part.trim()).filter(Boolean);
  if (rawParts.length > PILOT_MAX_TASKS) throw new Error(`pilot input may contain at most ${PILOT_MAX_TASKS} tasks`);

  const seen = new Set<string>();
  const tasks: JsonObject[] = [];
  for (const raw of rawParts) {
    const goal = normalizedGoal(raw);
    if (!goal || seen.has(goal)) continue;
    seen.add(goal);
    const chosen = choosePilotExecutor(undefined, options.preferred_executor,
      options.available_executors === undefined ? [] : options.available_executors);
    tasks.push({ title: titleOf(goal), goal, ...chosen });
  }
  return tasks;
}

/**
 * Router: explicit user choice wins; otherwise a configured preference wins;
 * finally Craft's internal executor is the safe deterministic fallback.
 */
export function choosePilotExecutor(requested: unknown, preferred: unknown, available: readonly string[] = []): PilotExecutorChoice {
  const requestedValue = requested === undefined || requested === null ? "" : nonEmpty(requested, "executor_template");
  if (requestedValue) {
    if (!knownExecutor(requestedValue)) throw new Error("executor_template is unsupported");
    return { executor_template: requestedValue, reason: "你为本次工作显式选择了执行器", confidence: 1 };
  }
  const preference = preferred === undefined || preferred === null ? "" : String(preferred).trim();
  const usable = available.filter(knownExecutor);
  if (preference && knownExecutor(preference) && (!usable.length || usable.includes(preference))) {
    return { executor_template: preference, reason: "沿用本机已配置的默认执行器", confidence: 0.9 };
  }
  const first = usable[0];
  if (first) return { executor_template: first, reason: "按本机可用执行器顺序选择", confidence: 0.75 };
  return { executor_template: "craft", reason: "没有可用外部执行器时使用 Craft 内置执行器", confidence: 0.6 };
}

/** Reviewer: hard rules only. No model advice enters this decision. */
export function reviewPilotPlan(tasks: JsonObject[], routes: JsonObject[], attention: JsonObject[] = []): PilotReview {
  const checks: PilotReviewCheck[] = [];
  checks.push({
    id: "task_count",
    ok: tasks.length > 0 && tasks.length <= PILOT_MAX_TASKS,
    level: "block",
    detail: `本次整理出 ${tasks.length} 个任务；允许 1-${PILOT_MAX_TASKS} 个`,
  });
  const complete = tasks.every((task) => typeof task.id === "string" && task.id.length > 0 &&
    typeof task.title === "string" && task.title.trim().length > 0 &&
    typeof task.goal === "string" && task.goal.trim().length > 0);
  checks.push({ id: "task_contract", ok: complete, level: "block", detail: complete ? "每个任务都有稳定的 id、标题和目标" : "存在缺少 id、标题或目标的任务" });

  const taskIds = new Set(tasks.map((task) => String(task.id)));
  const routed = new Set(routes.map((route) => String(route.task_id)));
  const missing = tasks.filter((task) => !routed.has(String(task.id))).map((task) => String(task.id));
  checks.push({
    id: "route_coverage",
    ok: missing.length === 0,
    level: "needs_human",
    detail: missing.length ? `仍有 ${missing.length} 个任务没有执行路由` : "每个任务都已有执行路由",
  });
  const badRoutes = routes.filter((route) => !taskIds.has(String(route.task_id)) ||
    typeof route.executor_template !== "string" || !route.executor_template.trim());
  checks.push({
    id: "route_integrity",
    ok: badRoutes.length === 0,
    level: "block",
    detail: badRoutes.length ? "存在指向其他任务或缺少执行器的路由" : "所有路由都绑定当前任务且声明执行器",
  });

  const goals = tasks.map((task) => normalizedGoal(String(task.goal ?? ""))).filter(Boolean);
  const duplicates = goals.length - new Set(goals).size;
  checks.push({ id: "duplicate_goal", ok: duplicates === 0, level: "warn", detail: duplicates ? `发现 ${duplicates} 个重复目标` : "目标已去重" });

  const unbound = tasks.filter((task) => !task.workspace_id && !task.workspace);
  checks.push({
    id: "workspace_binding",
    ok: unbound.length === 0,
    level: "warn",
    detail: unbound.length ? `${unbound.length} 个任务未绑定工作区，执行前应确认目录` : "所有任务都绑定了工作区",
  });

  const failedRoutes = routes.filter((route) => route.queue_state === "finished" && routeWorker(route)?.state === "failed");
  checks.push({
    id: "worker_terminal",
    ok: failedRoutes.length === 0,
    level: "needs_human",
    detail: failedRoutes.length ? `${failedRoutes.length} 个 Worker 已终态失败，需要人工核对` : "Worker 没有终态失败",
  });

  const taskAttention = attention.filter((item) => item.status === "open" || item.status === "deferred");
  checks.push({
    id: "open_attention",
    ok: taskAttention.length === 0,
    level: "needs_human",
    detail: taskAttention.length ? `仍有 ${taskAttention.length} 项需要人工决定` : "当前没有未处理的审批或阻塞",
  });

  const blocked = checks.some((check) => !check.ok && check.level === "block");
  const human = checks.some((check) => !check.ok && check.level === "needs_human");
  return { verdict: blocked ? "block" : human ? "needs_human" : "pass", checks };
}

/** One stable identity for a Pilot turn or review, derived from its facts. */
export function pilotRecordId(prefix: string, value: JsonObject): string {
  return `${prefix}_${createHash("sha256").update(stableDigest(value)).digest("hex").slice(0, 20)}`;
}

export function pilotStage(tasks: JsonObject[], routes: JsonObject[], reviews: JsonObject[]): string {
  if (routes.some((route) => route.queue_state === "blocked" || routeWorker(route)?.state === "failed")) {
    return "needs_attention";
  }
  if (routes.some((route) => route.queue_state === "running")) return "working";
  if (reviews.length) return "reviewed";
  if (routes.length) return "routed";
  if (tasks.length) return "mained";
  return "captured";
}

export function pilotStatusProjection(args: {
  session: JsonObject;
  turns: JsonObject[];
  routes: JsonObject[];
  tasks: JsonObject[];
  reviews: JsonObject[];
  attention: JsonObject[];
  results?: JsonObject[];
}): JsonObject {
  const running = args.routes.filter((route) => route.queue_state === "running").length;
  const queued = args.routes.filter((route) => route.queue_state === "queued").length;
  const finished = args.routes.filter((route) => route.queue_state === "finished").length;
  const blocked = args.routes.filter((route) => route.queue_state === "blocked").length;
  const attention = args.attention.filter((item) => item.status === "open" || item.status === "deferred").length;
  const results = args.results ?? [];
  const failed = args.routes.filter((route) => route.queue_state === "finished" &&
    routeWorker(route)?.state === "failed").length;
  return {
    stage: pilotStage(args.tasks, args.routes, args.reviews),
    counts: { tasks: args.tasks.length, running, queued, finished, blocked, failed,
      attention },
    latest_review: args.reviews[args.reviews.length - 1] ?? null,
    result_facts: {
      passed: results.filter((item) => item.verdict === "passed").length,
      awaiting_verification: results.filter((item) => item.verdict === "awaiting_verification").length,
      needs_attention: results.filter((item) => item.verdict === "needs_attention").length,
    },
  };
}

export interface PilotWorkerReconcileResult {
  state: "completed" | "failed";
  reason: string | null;
}

/**
 * Map one observed native session-link turn back onto a Pilot route.
 *
 * This is deliberately a pure observation: a running, starting or still
 * unconfirmed turn is returned as no change. Only durable provider state may
 * settle a route, and the caller remains responsible for releasing its slot.
 */
export function reconcilePilotWorker(route: JsonObject, link: JsonObject | null): PilotWorkerReconcileResult | null {
  const worker = routeWorker(route);
  if (!worker || worker.state !== "started" || route.queue_state !== "running" || !link) return null;
  if (String(link.provider ?? "") !== String(worker.provider ?? "")) return null;
  if (String(link.task_id ?? "") !== String(route.task_id ?? "")) return null;
  if (link.turn_state === "unknown") return { state: "failed", reason: "原生会话回合状态未确认，请先核对" };
  if (link.turn_state !== "idle") return null;
  const status = String(link.last_turn_status ?? "");
  if (status === "completed") return { state: "completed", reason: null };
  if (status === "failed" || status === "interrupted") return { state: "failed", reason: `原生回合 ${status}` };
  return null;
}
