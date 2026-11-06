import { WorkbenchEvaluations } from "./workbench-evaluations.ts";
import { WorkbenchQueueRunner } from "./workbench-queue-runner.ts";
import { text } from "../validation.ts";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { join } from "node:path";
import { CraftService, VERSION } from "../application/craft-service.ts";
import { runBuiltinAcceptanceTicks } from "../acceptance-worker.ts";
import { createActionHandlers } from "../application/actions/action-handlers.ts";
import { type JsonObject } from "../infrastructure/store.ts";
import { CodexWorkbenchSessions } from "./codex-workbench-sessions.ts";
import { agentSessionRoute } from "./workbench-agent-session-api.ts";
import { ClaudeWorkbenchRuns } from "./claude-workbench-runs.ts";
import { claudeRunRoute } from "./claude-workbench-api.ts";
import { DshWorkbenchRuns } from "./dsh-workbench-runs.ts";
import { dshRunRoute } from "./dsh-workbench-api.ts";
import { resolveDshLaunch } from "../dsh-executable.ts";
import { loadSettingsSync } from "../settings.ts";
import { detectAgentDesktop, registerAgentDesktopAdapter } from "./agent-desktop-adapter.ts";
import { INTERNAL_ONLY_TOOLS } from "../internal-host-driver.ts";

const MAX_BODY = 64 * 1024;
/**
 * Declaring `script-src` / `style-src` overrides `default-src` for those
 * directives, so `'self'` has to be listed explicitly. All Workbench scripts
 * are same-origin modules; the retired inline frontend is not served.
 *
 * `img-src` is spelled out for the same reason: without it the directive falls
 * back to `default-src 'self'`, which refuses the `data:` SVG chevrons Studio
 * draws inside form controls. Images cannot execute, so allowing `data:` here
 * costs no script or style protection.
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
};
export type WebRequest = { method: string; path: string; token?: string; origin?: string; body?: string };
export type WebResponse = { status: number; contentType: string; body: string };
function json(status: number, value: JsonObject): WebResponse { return { status, contentType: "application/json; charset=utf-8", body: JSON.stringify(value) }; }
function authorized(supplied: string | undefined, expected: string): boolean { if (!supplied) return false; const left = Buffer.from(supplied); const right = Buffer.from(expected); return left.length === right.length && timingSafeEqual(left, right); }
function bodyObject(body: string | undefined): JsonObject { if (!body) return {}; if (Buffer.byteLength(body) > MAX_BODY) throw new Error("Request body exceeds 64 KiB"); const value: unknown = JSON.parse(body); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request body must be a JSON object"); return value as JsonObject; }
function failure(error: unknown): WebResponse { return json(error instanceof SyntaxError ? 400 : error instanceof Error && error.message.includes("64 KiB") ? 413 : 422,
  { error: error instanceof Error ? error.message : String(error) }); }
function boundedLimit(value: string | null, fallback: number): number { if (value === null || value === "") return fallback; const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000) throw new Error("limit must be an integer between 1 and 1000"); return parsed; }
function queryValue(url: URL, key: string): string | undefined { const value = url.searchParams.get(key); return value === null ? undefined : value; }
// Extract the mod id from `/api/workbench/mods/<id>/<action>`; the prefix is 21 chars.
function modIdFromPath(path: string, action: string): string {
  const prefix = "/api/workbench/mods/";
  const suffix = `/${action}`;
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) throw new Error("malformed mod path");
  return decodeURIComponent(path.slice(prefix.length, -suffix.length));
}
// Extract the message id from `/api/workbench/messages/<id>/<action>`; prefix is 24 chars.
function messageIdFromPath(path: string, action: string): string {
  const prefix = "/api/workbench/messages/";
  const suffix = `/${action}`;
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) throw new Error("malformed message path");
  return decodeURIComponent(path.slice(prefix.length, -suffix.length));
}

const WORKBENCH_ASSETS: Readonly<Record<string, { file: string; type: string }>> = {
  "/composer-controls.js": { file: "composer-controls.js", type: "application/javascript; charset=utf-8" },
  "/workbench/composer-controls.js": { file: "composer-controls.js", type: "application/javascript; charset=utf-8" },
  "/evaluation-panel.js": { file: "evaluation-panel.js", type: "application/javascript; charset=utf-8" },
  "/workbench/evaluation-panel.js": { file: "evaluation-panel.js", type: "application/javascript; charset=utf-8" },
  "/craft-logo.svg": { file: "craft-logo.svg", type: "image/svg+xml" },
  "/workbench/craft-logo.svg": { file: "craft-logo.svg", type: "image/svg+xml" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "application/javascript; charset=utf-8" },
  "/runtime-client.js": { file: "runtime-client.js", type: "application/javascript; charset=utf-8" },
  "/workbench/runtime-client.js": { file: "runtime-client.js", type: "application/javascript; charset=utf-8" },
  "/agent-workspace.js": { file: "agent-workspace.js", type: "application/javascript; charset=utf-8" },
  "/workbench/agent-workspace.js": { file: "agent-workspace.js", type: "application/javascript; charset=utf-8" },
  "/queue-recovery.js": { file: "queue-recovery.js", type: "application/javascript; charset=utf-8" },
  "/workbench/queue-recovery.js": { file: "queue-recovery.js", type: "application/javascript; charset=utf-8" },
  "/project-shell.js": { file: "project-shell.js", type: "application/javascript; charset=utf-8" },
  "/workbench/project-shell.js": { file: "project-shell.js", type: "application/javascript; charset=utf-8" },
  "/workbench": { file: "index.html", type: "text/html; charset=utf-8" },
  "/workbench/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/workbench/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/workbench/app.js": { file: "app.js", type: "application/javascript; charset=utf-8" },
  "/latest-request.js": { file: "latest-request.js", type: "application/javascript; charset=utf-8" },
  "/project-page.js": { file: "project-page.js", type: "application/javascript; charset=utf-8" },
  "/workbench/latest-request.js": { file: "latest-request.js", type: "application/javascript; charset=utf-8" },
  "/workbench/project-page.js": { file: "project-page.js", type: "application/javascript; charset=utf-8" },
  "/asset-revisions.js": { file: "asset-revisions.js", type: "application/javascript; charset=utf-8" },
  "/workbench/asset-revisions.js": { file: "asset-revisions.js", type: "application/javascript; charset=utf-8" },
  "/context-workflows.js": { file: "context-workflows.js", type: "application/javascript; charset=utf-8" },
  "/workbench/context-workflows.js": { file: "context-workflows.js", type: "application/javascript; charset=utf-8" },
  "/resource-pages.js": { file: "resource-pages.js", type: "application/javascript; charset=utf-8" },
  "/mod-pages.js": { file: "mod-pages.js", type: "application/javascript; charset=utf-8" },
  "/workbench/mod-pages.js": { file: "mod-pages.js", type: "application/javascript; charset=utf-8" },
  "/message-dock.js": { file: "message-dock.js", type: "application/javascript; charset=utf-8" },
  "/workbench/message-dock.js": { file: "message-dock.js", type: "application/javascript; charset=utf-8" },
  "/model-setup.js": { file: "model-setup.js", type: "application/javascript; charset=utf-8" },
  "/workbench/model-setup.js": { file: "model-setup.js", type: "application/javascript; charset=utf-8" },
  "/workbench/resource-pages.js": { file: "resource-pages.js", type: "application/javascript; charset=utf-8" },
};

/**
 * Workbench modules are imported by the browser as ES modules. Registering each
 * new file twice by hand let several modules (rail-nav, mode-shell, native-tools,
 * ui, mode-pages) silently 404 in HTTP serve mode while the Tauri build read
 * them straight off disk. Derive the mapping from a strict basename instead:
 * only a single safe path segment with a known extension is ever read, so no
 * traversal or arbitrary file can be reached, and a missing file still 404s.
 */
const ASSET_TYPES: Readonly<Record<string, string>> = {
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};
function assetFor(path: string): { file: string; type: string } | null {
  const known = WORKBENCH_ASSETS[path];
  if (known) return known;
  const match = /^\/(?:workbench\/)?([A-Za-z0-9][A-Za-z0-9_.-]*\.(?:js|css|svg))$/u.exec(path);
  if (!match) return null;
  const file = match[1];
  const type = ASSET_TYPES[file.slice(file.lastIndexOf("."))];
  return { file, type };
}

/** One bridge per service: the full tool surface is built once, not per request. */
type WorkbenchDispatch = { handlers: ReturnType<typeof createActionHandlers> };
const WORKBENCH_BRIDGES = new WeakMap<CraftService, WorkbenchDispatch>();
export function workbenchBridge(service: CraftService): WorkbenchDispatch {
  const existing = WORKBENCH_BRIDGES.get(service);
  if (existing) return existing;
  const created = { handlers: createActionHandlers(service) };
  WORKBENCH_BRIDGES.set(service, created);
  return created;
}

export class WorkbenchWebApp {
  readonly evaluations: WorkbenchEvaluations | null;
  readonly service: CraftService; readonly token: string; readonly origin: string; readonly workbenchDir: string | null; readonly agentSessions: CodexWorkbenchSessions | null; readonly claudeRuns: ClaudeWorkbenchRuns | null; readonly dshRuns: DshWorkbenchRuns | null; readonly claudeExecutable: (() => string) | undefined;
  constructor(service: CraftService, token: string, origin: string, options: { evaluations?: WorkbenchEvaluations; workbenchDir?: string | null; agentSessions?: CodexWorkbenchSessions; claudeRuns?: ClaudeWorkbenchRuns; dshRuns?: DshWorkbenchRuns; claudeExecutable?: () => string } = {}) {
    this.service = service; this.token = token; this.origin = origin;
    this.evaluations = options.evaluations ?? null;
    // Presentation is owned by craft-workbench and must be mounted explicitly.
    this.workbenchDir = options.workbenchDir ?? null;
    this.agentSessions = options.agentSessions ?? null;
    this.claudeRuns = options.claudeRuns ?? null;
    this.dshRuns = options.dshRuns ?? null;
    this.claudeExecutable = options.claudeExecutable;
  }
  handle(request: WebRequest): WebResponse {
    const url = new URL(request.path, this.origin); const path = url.pathname;
    if (request.method === "GET" && path === "/") return this.#workbenchAsset("/workbench");
    if (request.method === "GET" && path === "/health") return json(200, { status: "ok", version: VERSION });
    if (request.method === "GET" && (path.startsWith("/workbench") || path in WORKBENCH_ASSETS || assetFor(path))) return this.#workbenchAsset(path);
    if (path.startsWith("/api/") && request.origin !== undefined && request.origin !== this.origin) return json(403, { error: "Cross-origin request rejected" });
    if (path.startsWith("/api/") && !authorized(request.token, this.token)) return json(401, { error: "Workbench token required" });
    try {
      if (request.method === "GET" && path === "/api/home") {
        const homeLimit = Number(url.searchParams.get("limit"));
        return json(200, this.service.homeView(Number.isInteger(homeLimit) && homeLimit >= 1 && homeLimit <= 50 ? { limit: homeLimit } : {}));
      }
      if (request.method === "GET" && path === "/api/workbench/task-board") {
        const boardLimit = Number(url.searchParams.get("limit"));
        return json(200, this.service.homeTaskBoard(Number.isInteger(boardLimit) && boardLimit >= 1 && boardLimit <= 50 ? { limit: boardLimit } : {}));
      }
      if (request.method === "GET" && path === "/api/workbench/task-active-count") return json(200, this.service.homeActiveTaskCount());
      if (request.method === "GET" && path === "/api/workbench/task-context-usage") return json(200, this.service.homeContextUsage({
        task_id: queryValue(url, "task_id") ?? "" }));
      if (request.method === "GET" && path === "/api/project-brain") return json(200, this.service.projectBrainGet({ project_id: queryValue(url, "project_id") || "local", limit: queryValue(url, "limit") }));
      if (request.method === "GET" && path === "/api/workspaces") return json(200, this.service.workspaceList({}));
      // Relation health for one indexed workspace: node/edge counts plus the
      // external-vs-internal diagnostic breakdown the workbench renders.
      if (request.method === "GET" && path === "/api/workbench/codebase/status") {
        return json(200, this.service.codebaseStatus({ workspace_id: text(queryValue(url, "workspace_id"), "workspace_id") }));
      }
      if (request.method === "POST" && path === "/api/workspaces/resolve-or-create") return json(200, this.service.workspaceResolveOrCreate(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/workspaces/backfill") return json(200, this.service.workspaceBackfill(bodyObject(request.body)));
      if (request.method === "GET" && path.startsWith("/api/workspaces/") && path.endsWith("/tasks")) return json(200, this.service.workspaceTasks({ workspace_id: decodeURIComponent(path.slice(16, -6)) }));
      if (request.method === "GET" && path === "/api/capabilities/catalog") return json(200, this.service.capabilityCatalog());
      if (path.startsWith("/api/workspaces/") && path.includes("/plugins")) {
        const rest = path.slice("/api/workspaces/".length).split("/").map((part) => decodeURIComponent(part));
        if (rest.length === 2 && rest[1] === "plugins") {
          if (request.method === "GET") return json(200, this.service.workspacePlugins({ workspace_id: rest[0] }));
          return json(404, { error: "Not found" });
        }
        if (rest.length === 4 && rest[1] === "plugins" && (rest[3] === "enable" || rest[3] === "disable")) {
          if (request.method === "POST") return json(200, this.service.workspacePluginSet({ workspace_id: rest[0], plugin_id: rest[2], status: rest[3] === "enable" ? "enabled" : "disabled" }));
        }
      }
      if (request.method === "GET" && path === "/api/approval-grants") return json(200, this.service.approvalGrantList({
        workspace_id: queryValue(url, "workspace_id"), status: queryValue(url, "status"),
      }));
      if (request.method === "POST" && path === "/api/approval-grants") return json(201, this.service.approvalGrantCreate(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/approval-grants/check") return json(200, this.service.approvalGrantCheck(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/approval-grants/sweep") return json(200, this.service.approvalGrantSweep({}));
      if (request.method === "DELETE" && path.startsWith("/api/approval-grants/")) return json(200, this.service.approvalGrantRevoke({
        grant_id: decodeURIComponent(path.slice(21)),
        revoked_by: queryValue(url, "revoked_by"), reason: queryValue(url, "reason") }));
      if (request.method === "GET" && path === "/api/executor-templates") return json(200, this.service.executorTemplateList({
        query: queryValue(url, "query"), limit: queryValue(url, "limit"),
      }));
      if (request.method === "POST" && path === "/api/executor-templates") return json(201, this.service.executorTemplateSave(bodyObject(request.body)));
      if (request.method === "GET" && path.startsWith("/api/executor-templates/")) return json(200, this.service.executorTemplateGet({ executor_template_id: decodeURIComponent(path.slice(24)) }));
      if (request.method === "GET" && path === "/api/supervisor-profiles") return json(200, this.service.supervisorProfileList({
        query: queryValue(url, "query"), limit: queryValue(url, "limit"),
      }));
      if (request.method === "POST" && path === "/api/supervisor-profiles") return json(201, this.service.supervisorProfileSave(bodyObject(request.body)));
      if (request.method === "GET" && path.startsWith("/api/supervisor-profiles/")) return json(200, this.service.supervisorProfileGet({ supervisor_profile_id: decodeURIComponent(path.slice(25)) }));
      if (path.startsWith("/api/pilot/")) {
        const segment = path.slice("/api/pilot/".length).split("/").map((part) => decodeURIComponent(part));
        if (request.method === "POST" && path === "/api/pilot/sessions") return json(201, this.service.pilotSessionOpen(bodyObject(request.body)));
        if (request.method === "GET" && segment[0] === "sessions" && segment.length === 2) return json(200, this.service.pilotSessionGet({ session_id: segment[1] }));
        if (request.method === "POST" && segment[0] === "sessions" && segment.length === 3 && segment[2] === "close") return json(200, this.service.pilotSessionClose({ session_id: segment[1] }));
        if (request.method === "POST" && segment[0] === "sessions" && segment.length === 3 && segment[2] === "turns") return json(201, this.service.pilotTurnSubmit({ ...bodyObject(request.body), session_id: segment[1] }));
        if (request.method === "POST" && segment[0] === "sessions" && segment.length === 4 && segment[2] === "turns" && segment[3] === "auto") return json(201, this.service.pilotTurnAuto({ ...bodyObject(request.body), session_id: segment[1] }));
        if (request.method === "GET" && segment[0] === "sessions" && segment.length === 3 && segment[2] === "status") return json(200, this.service.pilotSessionStatus({ session_id: segment[1] }));
        if (request.method === "POST" && segment[0] === "sessions" && segment.length === 3 && segment[2] === "reconcile") return json(200, this.service.pilotSessionReconcile({ session_id: segment[1] }));
        if (request.method === "POST" && segment[0] === "sessions" && segment.length === 3 && segment[2] === "review") return json(201, this.service.pilotReview({ ...bodyObject(request.body), session_id: segment[1] }));
        if (request.method === "POST" && segment[0] === "tasks" && segment.length === 3 && segment[2] === "route") return json(201, this.service.pilotTaskRoute({ ...bodyObject(request.body), task_id: segment[1] }));
        if (request.method === "POST" && segment[0] === "routes" && segment.length === 3 && segment[2] === "reassign") return json(200, this.service.pilotTaskReassign({ ...bodyObject(request.body), route_id: segment[1] }));
        if (request.method === "POST" && segment[0] === "routes" && segment.length === 3 && segment[2] === "start") return json(200, this.service.pilotRouteStart({ route_id: segment[1] }));
        if (request.method === "GET" && segment[0] === "sessions" && segment.length === 3 && segment[2] === "queue") return json(200, this.service.pilotQueue({ session_id: segment[1] }));
        if (request.method === "POST" && segment[0] === "sessions" && segment.length === 3 && segment[2] === "schedule") return json(200, this.service.pilotSchedule({ session_id: segment[1] }));
        if (request.method === "POST" && segment[0] === "routes" && segment.length === 3 && segment[2] === "finish") return json(200, this.service.pilotFinish({ route_id: segment[1] }));
        if (request.method === "POST" && segment[0] === "routes" && segment.length === 3 && segment[2] === "supervise") return json(200, this.service.pilotSupervise({ ...bodyObject(request.body), route_id: segment[1] }));
        return json(404, { error: "Not found" });
      }
      if (request.method === "GET" && path === "/api/workbench-experience") return json(200, this.service.workbenchExperienceQuery({ project_id: queryValue(url, "project_id"), task_id: queryValue(url, "task_id"), limit: queryValue(url, "limit") }));
      if (request.method === "GET" && path === "/api/traces") return json(200, this.service.traceQuery({ task_id: queryValue(url, "task_id"), event_kind: queryValue(url, "event_kind"), limit: queryValue(url, "limit") }));
      if (request.method === "GET" && path === "/api/long-task-checkpoints") return json(200, this.service.longTaskList({ session_id: queryValue(url, "session_id"), limit: queryValue(url, "limit") }));
      if (request.method === "GET" && path === "/api/settings") return json(200, this.service.settingsGet());
      // The object rail and its focused card (plan 8 / 15.3). One view serves the left
      // column and the centre together, because "which object needs me" and "what is that
      // object" are one question the plan answers on a single screen.
      if (request.method === "GET" && path === "/api/objects") return json(200, this.service.objectRailView({
        object_id: queryValue(url, "object_id"), limit: queryValue(url, "limit") }));
      // Receipts for one object, so the right column can show a conclusion first and the
      // raw values underneath it (plan 8 / 10.1).
      if (request.method === "GET" && path === "/api/objects/receipts") return json(200, this.service.objectReceipts({
        object_id: queryValue(url, "object_id"), receipt_id: queryValue(url, "receipt_id"),
        metric: queryValue(url, "metric") }));
      // 文档 12：两端共用同一个对象模型与同一本账，不靠缩放同一套布局。
      // 手机端只返回「有事找你」，一次一个；工作台留在桌面。
      if (request.method === "GET" && path === "/api/objects/mobile") return json(200, this.service.objectMobileProjection({
        object_id: queryValue(url, "object_id"), limit: queryValue(url, "limit") }));
      // Authorization is deliberately a separate endpoint from acknowledgement: they are
      // different acts on different subjects (plan 11.4), and merging them into one route
      // is how "I saw it" starts being recorded as "I granted it".
      if (request.method === "POST" && path === "/api/objects/authorize") return json(201, this.service.objectAuthorize(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/objects/acknowledge") return json(201, this.service.objectAcknowledge(bodyObject(request.body)));
      // L3: the one narrow entrance free expression is allowed (plan 5.3). Opening and
      // hatching are separate calls so the session can be closed by hatching rather than
      // kept alive for a second turn.
      if (request.method === "POST" && path === "/api/objects/hatch") return json(201, this.service.objectHatch(bodyObject(request.body)));
      // The structured completion exit. It takes named fields, not prose, because a prose
      // answer is prose — which is the conversation this design removes.
      if (request.method === "POST" && path === "/api/objects/request-fields") return json(200, this.service.objectRequestFields(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/objects/complete-fields") return json(200, this.service.objectCompleteFields(bodyObject(request.body)));
      // Subscriptions are authorizations, not preferences (plan 7.1): the list carries each
      // one's boundaries, and the audit is a separate read because permission without its
      // history is how a subscription stays trusted after it stopped working.
      if (request.method === "GET" && path === "/api/subscriptions") return json(200, this.service.subscriptionAuthorizationList({
        state: queryValue(url, "state"), limit: queryValue(url, "limit"),
        now: queryValue(url, "now") ?? new Date().toISOString() }));
      if (request.method === "GET" && path === "/api/subscriptions/audit") return json(200, this.service.subscriptionAudit({
        subscription_id: queryValue(url, "subscription_id") }));
      if (request.method === "GET" && path === "/api/subscriptions/check") return json(200, this.service.subscriptionCheck({
        subscription_id: queryValue(url, "subscription_id"), action: queryValue(url, "action"),
        risk_level: queryValue(url, "risk_level"), now: queryValue(url, "now") ?? new Date().toISOString() }));
      // Granting is the act that creates the authorization; every boundary is required.
      if (request.method === "POST" && path === "/api/subscriptions/authorize") return json(201, this.service.subscriptionAuthorize(bodyObject(request.body)));
      // Re-confirmation and revocation are the two human acts; both are explicit calls.
      if (request.method === "POST" && path === "/api/subscriptions/reconfirm") return json(200, this.service.subscriptionReconfirm(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/subscriptions/revoke") return json(200, this.service.subscriptionRevoke(bodyObject(request.body)));
      // Expiring is bookkeeping, never renewal: the plan forbids the subscription renewing
      // itself, not the system noticing that a deadline has passed.
      if (request.method === "POST" && path === "/api/subscriptions/sweep") return json(200, this.service.subscriptionSweep({
        now: (bodyObject(request.body).now as string | undefined) ?? new Date().toISOString() }));
      // 学习规则（「学会不再问」）：可列出、可撤销。Guard 越界只退回 L2；Invariant 证伪在决策
      // 路径内自动撤销，这里是人工撤销的入口，保证规则可被随时收回。
      if (request.method === "GET" && path === "/api/action-gate/rules") return json(200, this.service.actionGateRuleList({
        action: queryValue(url, "action"), scope_kind: queryValue(url, "scope_kind"), scope_id: queryValue(url, "scope_id") }));
      if (request.method === "GET" && path === "/api/action-gate/rules/all") return json(200, this.service.actionGateRuleListAll({
        status: queryValue(url, "status"), limit: boundedLimit(url.searchParams.get("limit"), 100) }));
      if (request.method === "POST" && path === "/api/action-gate/rules/revoke") return json(200, this.service.actionGateRuleRevoke(bodyObject(request.body)));
      // 订阅结构漂移（文档 7.2–7.4）：漂移只挂起、不撤销；这里只做读取、扫描与人工重新激活。
      if (request.method === "GET" && path === "/api/subscription-drift") return json(200, this.service.subscriptionDriftList({
        subscription_state: queryValue(url, "state") }));
      if (request.method === "GET" && path === "/api/subscription-drift/get") return json(200, this.service.subscriptionDriftGet({
        subscription_id: queryValue(url, "subscription_id") }));
      if (request.method === "POST" && path === "/api/subscription-drift/sweep") return json(200, this.service.subscriptionDriftSweep({
        now: (bodyObject(request.body).now as string | undefined) ?? new Date().toISOString() }));
      if (request.method === "POST" && path === "/api/subscription-drift/reactivate") return json(200, this.service.subscriptionDriftReactivate(bodyObject(request.body)));
      // Craft 原生工具目录：只展示与模型同一套判权/审批路径的工具声明。
      if (request.method === "GET" && path === "/api/workbench/native-tools") return json(200, {
        tools: INTERNAL_ONLY_TOOLS.map((definition) => ({ name: definition.function.name,
          description: definition.function.description, parameters: definition.function.parameters })) });
      // 上下文远端存储：本地始终权威，远端是一份可读的 Markdown 镜像（Obsidian 就是普通目录）。
      if (request.method === "GET" && path === "/api/workbench/context-storage") return json(200, this.service.contextStorageView());
      if (request.method === "POST" && path === "/api/workbench/context-storage") return json(200, this.service.contextStorageSave(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/workbench/context-storage/export") return json(201, this.service.contextStorageExport(bodyObject(request.body)));
      // 生成式裁决面（文档 9）：卡片的形态来自「这是什么决策」，不来自数据结构。
      // 未注册的决策类型会被拒绝，而不是退化成通用表单。
      if (request.method === "GET" && path === "/api/decisions/shapes") return json(200, this.service.decisionSurfaceShapes({}));
      if (request.method === "GET" && path === "/api/decisions") return json(200, this.service.decisionSurfaceCompose({
        object_id: queryValue(url, "object_id"), decision_kind: queryValue(url, "decision_kind"),
        summary: queryValue(url, "summary") ?? "decision" }));
      if (request.method === "POST" && path === "/api/decisions/compose") return json(201, this.service.decisionSurfaceCompose(bodyObject(request.body)));
      if (request.method === "GET" && path === "/api/decisions/surface") return json(200, this.service.decisionSurfaceGet({
        surface_id: queryValue(url, "surface_id") }));
      // 用完即销毁（9.3）：生成元素可弃，锚点没有这个动作，因为它从不消失。
      if (request.method === "POST" && path === "/api/decisions/discard") return json(200, this.service.decisionSurfaceDiscard({
        surface_id: bodyObject(request.body).surface_id,
        discarded_at: (bodyObject(request.body).discarded_at as string | undefined) ?? new Date().toISOString() }));
      // 能力基座（文档 13）：一种 Action 形态覆盖所有能力，广度来自基座而不是逐个适配。
      if (request.method === "GET" && path === "/api/capabilities/base") return json(200, this.service.capabilityBaseList({
        access_kind: queryValue(url, "access_kind") }));
      // 13A.7：GUI 兜底是技术债，这个数字必须可见，否则它会静默增长。
      if (request.method === "GET" && path === "/api/capabilities/debt") return json(200, this.service.capabilityBaseDebt({}));
      // The prefix "/api/capabilities/base/" is 23 characters, so the slice takes from 23.
      if (request.method === "GET" && path.startsWith("/api/capabilities/base/")) return json(200, this.service.capabilityBaseProject({
        action_id: decodeURIComponent(path.slice(23)) }));
      if (request.method === "POST" && path === "/api/capabilities/register") return json(201, this.service.capabilityBaseRegister(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/capabilities/replace-adapter") return json(200, this.service.capabilityBaseReplaceAdapter(bodyObject(request.body)));
      // 浏览器驱动（文档 13A）：核心只观察、只签契约、不驱动；驱动是 adapter 的能力。
      if (request.method === "GET" && path === "/api/driving/surface") return json(200, this.service.browserDrivingSurface({}));
      if (request.method === "POST" && path === "/api/driving/sites") return json(201, this.service.browserDrivingSiteRegister(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/driving/scripts") return json(201, this.service.browserDrivingScriptRegister(bodyObject(request.body)));
      // 13A.3：三级裁决公式；R1 不得走 L1，R3 有旁路校验也走审批链。
      if (request.method === "GET" && path === "/api/driving/adjudicate") return json(200, this.service.browserDrivingAdjudicate({
        script_id: queryValue(url, "script_id"), bypass_checker: queryValue(url, "bypass_checker") }));
      if (request.method === "POST" && path === "/api/driving/receipts") return json(201, this.service.browserDrivingRecordReceipt(bodyObject(request.body)));
      // Windows UI Automation: the server issues allowlisted requests; a local adapter executes them.
      if (request.method === "GET" && path === "/api/desktop/surface") return json(200, this.service.windowsDesktopSurface({}));
      if (request.method === "POST" && path === "/api/desktop/applications") return json(201, this.service.windowsDesktopApplicationRegister(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/desktop/controls") return json(201, this.service.windowsDesktopControlRegister(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/desktop/actions") return json(201, this.service.windowsDesktopActionRegister(bodyObject(request.body)));
      if (request.method === "GET" && path === "/api/desktop/adjudicate") return json(200, this.service.windowsDesktopAdjudicate({ action_id: queryValue(url, "action_id"), bypass_checker: queryValue(url, "bypass_checker") }));
      if (request.method === "POST" && path === "/api/desktop/prepare") return json(200, this.service.windowsDesktopPrepare(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/desktop/receipts") return json(201, this.service.windowsDesktopReceiptRecord(bodyObject(request.body)));
      // Visual/OCR is a fallback for custom-painted applications. It cannot become an unattended click path.
      if (request.method === "GET" && path === "/api/desktop/vision/surface") return json(200, this.service.windowsDesktopVisionSurface({}));
      if (request.method === "POST" && path === "/api/desktop/vision/sessions") return json(201, this.service.windowsDesktopVisionSessionBegin(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/desktop/vision/observations") return json(201, this.service.windowsDesktopVisionObservationRecord(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/desktop/vision/clicks") return json(200, this.service.windowsDesktopVisionClickPrepare(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/desktop/vision/receipts") return json(201, this.service.windowsDesktopVisionReceiptRecord(bodyObject(request.body)));
      // 文档 4.4：三分路由（能自证→L1；能枚举→L2 给选择题；否则→L3 孵化一个对象）。
      if (request.method === "GET" && path === "/api/claims/route") {
        // A query string carries everything as text, so the count is converted here rather
        // than handed to a numeric check that would reject every value it receives.
        const optionCount = queryValue(url, "option_count");
        return json(200, this.service.claimRoute({
          subject: queryValue(url, "subject") ?? "query", risk_level: queryValue(url, "risk_level") ?? "R0",
          can_self_certify: queryValue(url, "can_self_certify") === "true",
          options_enumerable: queryValue(url, "options_enumerable") === "true",
          ...(optionCount === undefined ? {} : { option_count: Number(optionCount) }),
          has_object: queryValue(url, "has_object") === "true" }));
      }
      if (request.method === "POST" && path === "/api/claims/record") return json(201, this.service.claimRecord(bodyObject(request.body)));
      // 文档 4.6：L1 占比必须与「已接入的确定性检查器数量」同时报告，否则它会变成虚荣指标。
      if (request.method === "GET" && path === "/api/claims/l1-report") return json(200, this.service.claimL1Report({}));
      // 每能力的耗时来自本机 telemetry；token 由宿主上报，未测得时为 null 而非 0。
      if (request.method === "GET" && path === "/api/workbench/costs") return json(200, this.service.capabilityCostReport({
        limit: boundedLimit(url.searchParams.get("limit"), 1000) }));
      // 经验固化草稿：候选 Procedure 在通过 shadow/held_out/signoff/canary 门槛前只是草稿。
      if (request.method === "GET" && path === "/api/workbench/experience/proposals") return json(200, this.service.workflowEvolutionProposals({
        lifecycle: queryValue(url, "lifecycle"), limit: boundedLimit(url.searchParams.get("limit"), 100) }));
      if (request.method === "GET" && path === "/api/workbench/experience/procedures") return json(200, this.service.experienceProcedureList({
        scope: queryValue(url, "scope"), limit: boundedLimit(url.searchParams.get("limit"), 100) }));
      // 只有通过全部门槛（routeable）的 Procedure 才能导出为 SKILL.md 草稿，且导出后默认禁用。
      if (request.method === "POST" && path === "/api/workbench/experience/procedures/export") return json(201, this.service.experienceProcedureSkillExport(bodyObject(request.body)));
      // 文档 11.3：账本措辞必须诚实，不得声称「不可篡改」。
      if (request.method === "GET" && path === "/api/claims/ledger-wording") return json(200, this.service.claimLedgerWording(
        queryValue(url, "claim") === undefined ? {} : { claim: queryValue(url, "claim") }));
      // 文档 5.1/5.2：对象的九字段、机器可判定的 state、以及裁决结论写回对象。
      if (request.method === "GET" && path === "/api/objects/model/completeness") return json(200, this.service.objectCompleteness({}));
      if (request.method === "GET" && path === "/api/objects/model") return json(200, this.service.objectList({
        kind: queryValue(url, "kind") }));
      if (request.method === "GET" && path.startsWith("/api/objects/model/") && path.endsWith("/state")) {
        return json(200, this.service.objectStateCheck({ object_id: decodeURIComponent(path.slice(19, -6)) }));
      }
      if (request.method === "GET" && path.startsWith("/api/objects/model/") && path.endsWith("/history")) {
        return json(200, this.service.objectHistory({ object_id: decodeURIComponent(path.slice(19, -8)) }));
      }
      if (request.method === "GET" && path.startsWith("/api/objects/model/")) {
        return json(200, this.service.objectGet({ object_id: decodeURIComponent(path.slice(19)) }));
      }
      if (request.method === "POST" && path === "/api/objects/model/kinds") return json(201, this.service.objectKindDefine(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/objects/model") return json(201, this.service.objectCreate(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/objects/model/transition") return json(200, this.service.objectTransition(bodyObject(request.body)));
      // 5.2.1：卡片短命，但它的结论必须写回对象。
      if (request.method === "POST" && path === "/api/objects/model/decision") return json(200, this.service.objectRecordDecision(bodyObject(request.body)));
      // 文档 3：唯一核心指标 HT。它必须与墙上时间同时报告，且分母固定为「对象」——
      // 只报 HT 会被「登录花 8 分钟但一次不算」这类盲区糊弄过去。
      if (request.method === "POST" && path === "/api/metrics/touchpoints") return json(201, this.service.humanTouchpointRecord(bodyObject(request.body)));
      if (request.method === "GET" && path === "/api/metrics/touchpoints") return json(200, this.service.humanTouchpointReport({}));
      if (request.method === "GET" && path.startsWith("/api/metrics/touchpoints/")) return json(200, this.service.humanTouchpointObjectReport({
        object_id: decodeURIComponent(path.slice(25)) }));
      if (request.method === "PATCH" && path === "/api/settings") return json(200, this.service.settingsUpdate(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/settings/reset") return json(200, this.service.settingsReset());
      if (request.method === "POST" && path === "/api/settings/onboarding/complete") return json(200, this.service.onboardingComplete());
      if (request.method === "POST" && path === "/api/settings/onboarding/reset") return json(200, this.service.onboardingReset());
      if (request.method === "POST" && path === "/api/settings/onboarding/bind-workspace") return json(200, this.service.onboardingBindWorkspace(bodyObject(request.body)));
      if (request.method === "GET" && path === "/api/usage") return json(200, this.service.usageReport({ from: url.searchParams.get("from") ?? undefined, to: url.searchParams.get("to") ?? undefined }));
      if (request.method === "GET" && path.startsWith("/api/managed-runs/")) return json(200, this.service.managedRunGet({ managed_run_id: decodeURIComponent(path.slice(18)) }));
      if (request.method === "GET" && path.startsWith("/api/campaign-runners/")) return json(200, this.service.campaignRunnerGet({ runner_id: decodeURIComponent(path.slice(22)) }));
      if (request.method === "GET" && path.startsWith("/api/work-coordinators/")) return json(200, this.service.workCoordinatorGet({ coordinator_id: decodeURIComponent(path.slice(23)) }));
      if (request.method === "GET" && path.startsWith("/api/agent-eval-labs/")) return json(200, this.service.agentEvalLabGet({ lab_id: decodeURIComponent(path.slice(21)) }));
      if (request.method === "GET" && path === "/api/host-runs") return json(200, this.service.homeHostRuns({}));
      if (request.method === "GET" && path === "/api/domain-kits") return json(200, this.service.domainKitInstallBuiltins());
      if (request.method === "POST" && path.startsWith("/api/domain-kits/") && path.endsWith("/apply")) return json(201, this.service.domainKitApply({ ...bodyObject(request.body), kit_id: decodeURIComponent(path.slice(17, -6)) }));
      if (request.method === "GET" && path === "/api/knowledge") return json(200, this.service.knowledgeWorkbenchView({ limit: url.searchParams.get("limit") ?? undefined }));
      if (request.method === "GET" && path.startsWith("/api/knowledge/pages/")) return json(200, this.service.wikiPageGet({ page_id: decodeURIComponent(path.slice(21)), version: url.searchParams.get("version") ?? undefined }));
      if (request.method === "POST" && path.startsWith("/api/knowledge/pages/") && path.endsWith("/refresh")) return json(200, this.service.wikiPageRefresh({ page_id: decodeURIComponent(path.slice(21, -8)) }));
      if (request.method === "POST" && path.startsWith("/api/knowledge/claims/") && path.endsWith("/review")) return json(200, this.service.knowledgeClaimReview({ ...bodyObject(request.body), claim_id: decodeURIComponent(path.slice(22, -7)) }));
      if (request.method === "GET" && path.startsWith("/api/knowledge/bundles/") && path.endsWith("/preview")) return json(200, this.service.knowledgeContextBundlePreview({ bundle_id: decodeURIComponent(path.slice(23, -8)), bundle_version: url.searchParams.get("version") ?? undefined }));
      if (request.method === "POST" && path === "/api/knowledge-work-launches") return json(201, this.service.knowledgeWorkbenchWorkLaunchPrepare(bodyObject(request.body)));
      if (request.method === "GET" && path.startsWith("/api/knowledge-work-launches/")) return json(200, this.service.workLaunchGet({ launch_id: decodeURIComponent(path.slice(29)), after_sequence: url.searchParams.get("after") ?? undefined }));
      if (request.method === "POST" && path.startsWith("/api/knowledge-work-launches/") && path.endsWith("/decide")) return json(200, this.service.knowledgeWorkbenchWorkLaunchDecide({ ...bodyObject(request.body), launch_id: decodeURIComponent(path.slice(29, -7)) }));
      if (request.method === "POST" && path.startsWith("/api/knowledge-work-launches/") && path.endsWith("/retry")) return json(201, this.service.knowledgeWorkbenchWorkLaunchRetry({ ...bodyObject(request.body), launch_id: decodeURIComponent(path.slice(29, -6)) }));
      if (request.method === "POST" && path === "/api/verified-work-loops") return json(201, this.service.verifiedWorkLoopWorkbenchPrepare(bodyObject(request.body)));
      if (request.method === "POST" && path.startsWith("/api/verified-work-loops/") && path.endsWith("/decide")) return json(200, this.service.verifiedWorkLoopDecide({ ...bodyObject(request.body), work_loop_id: decodeURIComponent(path.slice("/api/verified-work-loops/".length, -"/decide".length)) }));
      if (request.method === "POST" && path.startsWith("/api/verified-work-loops/") && path.endsWith("/resume")) return json(200, this.service.verifiedWorkLoopResume({ ...bodyObject(request.body), work_loop_id: decodeURIComponent(path.slice("/api/verified-work-loops/".length, -"/resume".length)) }));
      if (request.method === "GET" && path.startsWith("/api/verified-work-loops/")) return json(200, this.service.verifiedWorkLoopGet({ work_loop_id: decodeURIComponent(path.slice("/api/verified-work-loops/".length)) }));
      if (request.method === "GET" && path.startsWith("/api/execution-fabrics/")) return json(200, this.service.executionFabricGet({ fabric_id: decodeURIComponent(path.slice("/api/execution-fabrics/".length)) }));
      if (request.method === "GET" && path.startsWith("/api/work-launches/")) return json(200, this.service.workLaunchGet({ launch_id: decodeURIComponent(path.slice(19)), after_sequence: url.searchParams.get("after") ?? undefined }));
      if (request.method === "GET" && path === "/api/guided-work") return json(200, this.service.guidedWorkList({ limit: url.searchParams.get("limit") ?? undefined }));
      if (request.method === "POST" && path === "/api/guided-work") return json(201, this.service.guidedWorkCreate(bodyObject(request.body)));
      if (request.method === "GET" && path.startsWith("/api/guided-work/")) return json(200, this.service.guidedWorkGet({ brief_id: decodeURIComponent(path.slice(17)), version: url.searchParams.get("version") ?? undefined }));
      if (request.method === "POST" && path.startsWith("/api/guided-work/") && path.endsWith("/decide")) return json(200, this.service.guidedWorkDecide({ ...bodyObject(request.body), brief_id: decodeURIComponent(path.slice(17, -7)) }));
      if (request.method === "POST" && path.startsWith("/api/guided-work/") && path.endsWith("/launch")) return json(201, this.service.guidedWorkLaunchPrepare({ ...bodyObject(request.body), brief_id: decodeURIComponent(path.slice(17, -7)) }));
      if (request.method === "POST" && path.startsWith("/api/acceptance-plans/") && path.endsWith("/human-review")) return json(201, this.service.acceptanceHumanReview({ ...bodyObject(request.body), plan_id: decodeURIComponent(path.slice(22, -13)) }));
      if (request.method === "POST" && path.startsWith("/api/acceptance-plans/") && path.endsWith("/file-evaluation")) return json(201, this.service.acceptanceFileEvaluationPrepare({ ...bodyObject(request.body), plan_id: decodeURIComponent(path.slice(22, -16)) }));
      if (request.method === "GET" && path.startsWith("/api/host-runs/")) return json(200, this.service.homeHostRun({ run_id: decodeURIComponent(path.slice(15)), after_sequence: url.searchParams.get("after") ?? undefined, limit: 50 }));
      if (request.method === "POST" && path.startsWith("/api/host-runs/") && path.endsWith("/cancel")) return json(200, this.service.hostRunCancel({ ...bodyObject(request.body), run_id: decodeURIComponent(path.slice(15, -7)) }));
      if (request.method === "GET" && path.startsWith("/api/tasks/")) return json(200, this.service.homeTask({ task_id: decodeURIComponent(path.slice(11)) }));
      if (request.method === "POST" && path === "/api/tasks") return json(201, this.service.taskOpen(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/task-controls") return json(201, this.service.taskControlSave(bodyObject(request.body)));
      if (request.method === "GET" && path.startsWith("/api/task-controls/")) return json(200, this.service.taskControlGet({ contract_id: decodeURIComponent(path.slice(19)) }));
      if (request.method === "POST" && path.startsWith("/api/task-controls/") && path.endsWith("/refresh")) return json(200, this.service.taskControlRefresh({ contract_id: decodeURIComponent(path.slice(19, -8)) }));
      if (request.method === "POST" && path.startsWith("/api/task-controls/") && path.endsWith("/bind-launch")) return json(200, this.service.taskControlBindLaunch({ ...bodyObject(request.body), contract_id: decodeURIComponent(path.slice(19, -12)) }));
      if (request.method === "POST" && path.startsWith("/api/task-controls/") && path.endsWith("/handoff")) return json(201, this.service.taskControlHandoff({ ...bodyObject(request.body), contract_id: decodeURIComponent(path.slice(19, -8)) }));
      if (request.method === "POST" && path === "/api/task-runs") return json(201, this.service.taskRunPrepare(bodyObject(request.body)));
      if (request.method === "GET" && path.startsWith("/api/task-runs/")) return json(200, this.service.taskRunGet({ task_run_id: decodeURIComponent(path.slice(15)) }));
      if (request.method === "POST" && path.startsWith("/api/task-runs/") && path.endsWith("/refresh")) return json(200, this.service.taskRunRefresh({ ...bodyObject(request.body), task_run_id: decodeURIComponent(path.slice(15, -8)) }));
      if (request.method === "POST" && path.startsWith("/api/task-runs/") && path.endsWith("/pause")) return json(200, this.service.taskRunPause({ ...bodyObject(request.body), task_run_id: decodeURIComponent(path.slice(15, -6)) }));
      if (request.method === "POST" && path.startsWith("/api/task-runs/") && path.endsWith("/resume")) return json(200, this.service.taskRunResume({ ...bodyObject(request.body), task_run_id: decodeURIComponent(path.slice(15, -7)) }));
      if (request.method === "POST" && path.startsWith("/api/task-runs/") && path.endsWith("/cancel")) return json(200, this.service.taskRunCancel({ ...bodyObject(request.body), task_run_id: decodeURIComponent(path.slice(15, -7)) }));
      if (request.method === "POST" && path.startsWith("/api/task-runs/") && path.endsWith("/handoff")) return json(201, this.service.taskRunHandoff({ ...bodyObject(request.body), task_run_id: decodeURIComponent(path.slice(15, -8)) }));
      if (request.method === "POST" && path === "/api/inbox/refresh") return json(200, this.service.attentionRefresh(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/inbox/decide") return json(200, this.service.attentionDecide(bodyObject(request.body)));
      // Craft Workbench read/write surfaces. These are thin projections of existing
      // kernels: the shell never gains authority the CLI does not already have.
      if (request.method === "GET" && path === "/api/workbench/summary") return json(200, this.service.info());
      if (request.method === "POST" && path === "/api/workbench/context-retire") return json(200, this.service.workbenchContextRetire(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/workbench/component-assets/inspect") { const args = bodyObject(request.body); return json(200, this.service.componentAssetInspect(text(args.member, "member"), args)); }
      if (request.method === "POST" && path === "/api/workbench/component-assets/restore") { const args = bodyObject(request.body); return json(201, this.service.componentAssetRestore(text(args.member, "member"), args)); }
      if (request.method === "POST" && path === "/api/workbench/procedure-configurations") return json(201, this.service.procedureConfigurationSave(bodyObject(request.body)));
      if (request.method === "GET" && path === "/api/workbench/context-usage") return json(200, this.service.workbenchContextUsage({ scope_kind: queryValue(url, "scope_kind"), scope_id: queryValue(url, "scope_id") }));
      if (request.method === "GET" && path === "/api/workbench/workflow-designs") return json(200, this.service.workbenchWorkflowDesignList({ scope: queryValue(url, "scope") }));
      if (request.method === "POST" && path === "/api/workbench/workflow-designs") return json(201, this.service.workbenchWorkflowDesignSave(bodyObject(request.body)));
      if (request.method === "GET" && path.startsWith("/api/workbench/workflow-designs/")) return json(200, this.service.workbenchWorkflowDesignGet({ design_id: decodeURIComponent(path.slice("/api/workbench/workflow-designs/".length)), scope: queryValue(url, "scope") }));
      if (request.method === "POST" && path === "/api/workbench/workflow-designs/capture") return json(201, this.service.workbenchWorkflowDesignCapture(bodyObject(request.body)));
      if (request.method === "GET" && path === "/api/workbench/experience/overview") return json(200, this.service.workbenchExperienceOverview({ scope: queryValue(url, "scope") }));
      if (request.method === "GET" && path === "/api/workbench/experience/recall-receipts") return json(200, this.service.workbenchExperienceRecallReceipts({
        asset_id: queryValue(url, "procedure_id") ?? queryValue(url, "asset_id") ?? "",
        member: queryValue(url, "member"), limit: queryValue(url, "limit") }));
      if (request.method === "GET" && path === "/api/workbench/experience/feedback-history") return json(200, this.service.workbenchExperienceFeedbackHistory({
        asset_id: queryValue(url, "asset_id") ?? queryValue(url, "procedure_id") ?? "",
        member: queryValue(url, "member"), limit: queryValue(url, "limit") }));
      // A pending correction is what lowers an asset's weight; without a place to
      // adjudicate it, the demotion has no human action behind it.
      if (request.method === "GET" && path === "/api/workbench/context-corrections") return json(200, this.service.contextExtensionsListCorrections({
        status: queryValue(url, "status"), member: queryValue(url, "member"), limit: queryValue(url, "limit") }));
      if (request.method === "POST" && path === "/api/workbench/context-corrections/decide") return json(200, this.service.contextExtensionsDecideCorrection(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/workbench/experience/feedback") return json(201, this.service.workbenchExperienceFeedback(bodyObject(request.body)));
      if (request.method === "GET" && path === "/api/workbench/resources") return json(200, this.service.workbenchResourceView({ kind: queryValue(url, "kind"), task_id: queryValue(url, "task_id"),
        limit: queryValue(url, "limit"), include_history: queryValue(url, "history") === "1" }));
      if (request.method === "GET" && path === "/api/workbench/internal-approvals") {
        const taskId = queryValue(url, "task_id") ?? "";
        return json(200, { approvals: this.service.internalApprovalBroker.pending()
          .filter((approval) => !taskId || approval.task_id === taskId) });
      }
      if (request.method === "POST" && path.startsWith("/api/workbench/internal-approvals/")) {
        const body = bodyObject(request.body);
        if (body.decision !== "accept" && body.decision !== "decline") throw new Error("approval decision is invalid");
        return json(200, this.service.internalApprovalBroker.decide(
          decodeURIComponent(path.slice("/api/workbench/internal-approvals/".length)), body.decision));
      }
      if (request.method === "GET" && path === "/api/workbench/plugins") return json(200, {
        ...this.service.workbenchResourceCatalogView({ kind: "plugins", limit: 100 }),
        adapters: this.service.adapterManifestList({ limit: 200 }).adapters,
        agent_desktop: detectAgentDesktop(),
        dsh_host: this.service.dshPluginHost.status(),
      });
      if (request.method === "POST" && path === "/api/workbench/plugins") return json(201, this.service.workbenchPluginInstall(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/workbench/plugins/install-directory") return json(201, this.service.workbenchPluginInstallFromDirectory(bodyObject(request.body)));
      if (request.method === "GET" && path.startsWith("/api/workbench/plugins/") && path.endsWith("/pages")) {
        return json(200, this.service.workbenchPluginPages({ plugin_id: decodeURIComponent(path.slice("/api/workbench/plugins/".length, -"/pages".length)) }));
      }
      if (request.method === "GET" && path.startsWith("/api/workbench/plugins/") && path.includes("/pages/")) {
        const rest = path.slice("/api/workbench/plugins/".length);
        const splitAt = rest.indexOf("/pages/");
        return json(200, this.service.workbenchPluginPage({ plugin_id: decodeURIComponent(rest.slice(0, splitAt)), page_id: decodeURIComponent(rest.slice(splitAt + "/pages/".length)) }));
      }
      // Uninstall is a delete so it cannot be mistaken for the install verbs
      // above; the version query is the one the caller was shown.
      if (request.method === "DELETE" && path.startsWith("/api/workbench/plugins/") && !path.endsWith("/install")) {
        const pluginId = decodeURIComponent(path.slice("/api/workbench/plugins/".length));
        if (!pluginId || pluginId.includes("/")) return json(404, { error: "Not found" });
        return json(200, this.service.workbenchPluginRemove({ plugin_id: pluginId, expected_version: queryValue(url, "version") }));
      }
      if (request.method === "POST" && path === "/api/workbench/skills") return json(201, this.service.workbenchSkillSave(bodyObject(request.body)));
      // Uploaded skills are removable; a plugin's skills leave with their plugin.
      if (request.method === "DELETE" && path.startsWith("/api/workbench/skills/")) {
        const skillId = decodeURIComponent(path.slice("/api/workbench/skills/".length));
        if (!skillId || skillId.includes("/")) return json(404, { error: "Not found" });
        return json(200, this.service.workbenchSkillDelete({ skill_id: skillId }));
      }
      if (request.method === "POST" && path === "/api/workbench/memory") return json(201, this.service.workbenchMemorySave(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/workbench/memory/review") return json(200, this.service.workbenchMemoryReview(bodyObject(request.body)));
      // A conflicting memory cannot be approved until a person settles it, so the
      // workbench needs both the open list and a signed way to resolve it.
      if (request.method === "GET" && path === "/api/workbench/memory/conflicts") return json(200, this.service.workbenchMemoryConflictList({
        limit: queryValue(url, "limit") }));
      if (request.method === "POST" && path === "/api/workbench/memory/conflicts/resolve") return json(200, this.service.workbenchMemoryConflictResolve(bodyObject(request.body)));
      // Retiring a live ledger memory is a signed, version-checked human action.
      if (request.method === "POST" && path === "/api/workbench/memory/ledger/transition") return json(200, this.service.workbenchMemoryLedgerTransition(bodyObject(request.body)));
      // craft-file-dir-desc: directory <-> semantic description, bidirectional, self-evolving.
      if (request.method === "POST" && path === "/api/workbench/file-dir-desc/record") return json(201, this.service.fileDirDescRecord(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/workbench/file-dir-desc/promote") return json(200, this.service.fileDirDescPromote(bodyObject(request.body)));
      if (request.method === "GET" && path === "/api/workbench/file-dir-desc/resolve") return json(200, this.service.fileDirDescResolve({ description: queryValue(url, "description"), path: queryValue(url, "path"), limit: queryValue(url, "limit") }));
      // Mod 内核：认知约束的 draft -> approve -> active 生命周期，以及 Worker 上下文注入。
      if (request.method === "POST" && path === "/api/workbench/mods") return json(201, this.service.modCreate(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/workbench/mods/propose-from-attribution") return json(201, this.service.modProposeFromAttribution(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/workbench/mods/shadow-test") return json(200, this.service.modRecordShadowTest(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/workbench/mods/shadow-test/run") return json(200, this.service.modEvaluateShadowTest(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/workbench/mods/rollback") return json(200, this.service.modRollback(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/workbench/mods/rollback/previous") return json(200, this.service.modRollbackPrevious(bodyObject(request.body)));
      if (request.method === "POST" && path.startsWith("/api/workbench/mods/") && path.endsWith("/update")) return json(200, this.service.modUpdate({ ...bodyObject(request.body), id: modIdFromPath(path, "update") }));
      if (request.method === "POST" && path.startsWith("/api/workbench/mods/") && path.endsWith("/approve")) return json(200, this.service.modApprove({ ...bodyObject(request.body), id: modIdFromPath(path, "approve") }));
      if (request.method === "POST" && path.startsWith("/api/workbench/mods/") && path.endsWith("/enable")) return json(200, this.service.modEnable({ ...bodyObject(request.body), id: modIdFromPath(path, "enable") }));
      if (request.method === "POST" && path.startsWith("/api/workbench/mods/") && path.endsWith("/disable")) return json(200, this.service.modDisable({ ...bodyObject(request.body), id: modIdFromPath(path, "disable") }));
      if (request.method === "POST" && path.startsWith("/api/workbench/mods/") && path.endsWith("/revoke")) return json(200, this.service.modRevoke({ ...bodyObject(request.body), id: modIdFromPath(path, "revoke") }));
      if (request.method === "GET" && path === "/api/workbench/mods/list") return json(200, this.service.modList({ status: queryValue(url, "status"), applies_to: queryValue(url, "applies_to") }));
      if (request.method === "GET" && path === "/api/workbench/mods/overlay") return json(200, { overlay: this.service.modSystemOverlay({ scope_kind: queryValue(url, "scope_kind"), scope_id: queryValue(url, "scope_id"), applies_to: queryValue(url, "applies_to"),
        active_plugins: (queryValue(url, "active_plugins") ?? "").split(",").filter(Boolean) }) });
      // 消息收件箱：纯工程监听 + 0 Token 展示；智能处理只记录意图。
      if (request.method === "POST" && path === "/api/workbench/messages") return json(201, this.service.messageRecord(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/workbench/messages/ingest") return json(201, this.service.messageIngest(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/workbench/messages/process-intent") return json(200, this.service.messageProcess(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/workbench/messages/batch") return json(200, this.service.messageBatch(bodyObject(request.body)));
      if (request.method === "POST" && path.startsWith("/api/workbench/messages/") && path.endsWith("/read")) return json(200, this.service.messageMarkRead({ id: messageIdFromPath(path, "read") }));
      if (request.method === "POST" && path.startsWith("/api/workbench/messages/") && path.endsWith("/process")) return json(200, this.service.messageMarkProcessed({ id: messageIdFromPath(path, "process") }));
      if (request.method === "GET" && path === "/api/workbench/messages/list") return json(200, this.service.messageList({ unread_only: queryValue(url, "unread_only") === "true", priority: queryValue(url, "priority") }));
      // 自进化路径 C：插件发现提案（自动发现，人工批准，不写宿主配置）。
      if (request.method === "POST" && path === "/api/workbench/plugin-discovery/propose") return json(201, this.service.pluginDiscoveryPropose(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/workbench/plugin-discovery/approve") return json(200, this.service.pluginDiscoveryApprove(bodyObject(request.body)));
      if (request.method === "GET" && path === "/api/workbench/plugin-discovery/list") return json(200, this.service.pluginDiscoveryList({ status: queryValue(url, "status") }));
      if (request.method === "GET" && path === "/api/workbench/pilot/review-round") return json(200, this.service.pilotReviewRound({ session_id: queryValue(url, "session_id") }));
      if (request.method === "POST" && path === "/api/workbench/pilot/suspend-session") return json(200, this.service.pilotSuspendSession({ session_id: queryValue(url, "session_id"), reason: queryValue(url, "reason") }));
      if (request.method === "GET" && path === "/api/workbench/pilot/blocked-queue") return json(200, this.service.pilotBlockedQueue());
      if (request.method === "GET" && path === "/api/workbench/pilot/failure-observations") return json(200, this.service.pilotFailureObservations({ limit: queryValue(url, "limit") }));
      if (request.method === "POST" && path === "/api/workbench/pilot/failure-observations/attribute") return json(200, this.service.pilotFailureAttribute(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/workbench/pilot/adoption") return json(201, this.service.pilotDeliveryAdoption(bodyObject(request.body)));
      if (request.method === "GET" && path === "/api/workbench/pilot/adoption") return json(200, this.service.pilotDeliveryAdoptionGet({ task_id: queryValue(url, "task_id") }));
      if (request.method === "GET" && path === "/api/workbench/pilot/outcomes") return json(200, this.service.pilotDeliveryOutcomes({ limit: queryValue(url, "limit") }));
      if (request.method === "POST" && path === "/api/workbench/pilot/resume-session") return json(200, this.service.pilotResumeSession({ session_id: queryValue(url, "session_id") }));
      if (request.method === "POST" && path === "/api/workbench/pilot/coordinator/resolve") return json(200, this.service.pilotCoordinatorResolve(bodyObject(request.body)));
      if (request.method === "GET" && path === "/api/workbench/file-dir-desc/list") return json(200, this.service.fileDirDescList({ status: queryValue(url, "status"), host_kind: queryValue(url, "host_kind"), limit: queryValue(url, "limit") }));
      if (request.method === "POST" && path.startsWith("/api/workbench/memory/") && path.endsWith("/retire")) return json(200, this.service.workbenchMemoryRetire({ memory_id: decodeURIComponent(path.slice(22, -7)) }));
      if (request.method === "POST" && path === "/api/workbench/knowledge/claims") return json(201, this.service.workbenchKnowledgeClaimSave(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/workbench/workflows") return json(201, this.service.workbenchWorkflowSave(bodyObject(request.body)));
      if (request.method === "GET" && path === "/api/models") return json(200, this.service.modelProviderList());
      if (request.method === "GET" && path === "/api/model-profiles") return json(200, this.service.evaluationModelProfileList({ limit: boundedLimit(url.searchParams.get("limit"), 100) }));
      if (request.method === "POST" && path === "/api/model-profiles") return json(201, this.service.evaluationModelProfileSave(bodyObject(request.body)));
      if (request.method === "GET" && path.startsWith("/api/models/")) {
        const tier = url.searchParams.get("tier");
        return json(200, this.service.modelProviderGet({ provider: decodeURIComponent(path.slice(12)), ...(tier === null || tier === "" ? {} : { tier }) }));
      }
      // User-configured model management (CRUD on settings.models)
      if (request.method === "GET" && path === "/api/config/models") return json(200, this.service.modelList());
      if (request.method === "POST" && path === "/api/config/models") return json(201, this.service.modelAdd(bodyObject(request.body)));
      if (request.method === "PATCH" && path.startsWith("/api/config/models/")) return json(200, this.service.modelUpdate({ ...bodyObject(request.body), id: decodeURIComponent(path.slice("/api/config/models/".length)) }));
      if (request.method === "DELETE" && path.startsWith("/api/config/models/")) return json(200, this.service.modelDelete({ id: decodeURIComponent(path.slice("/api/config/models/".length)) }));
      if (request.method === "GET" && path === "/api/projects") return json(200, { projects: this.service.store.list("project_brain", boundedLimit(url.searchParams.get("limit"), 50)) });
      if (request.method === "POST" && path === "/api/projects") return json(201, this.service.projectBrainOpen(bodyObject(request.body)));
      if (request.method === "POST" && path.startsWith("/api/projects/") && path.endsWith("/goals")) return json(201, this.service.projectBrainGoalSave({ ...bodyObject(request.body), project_id: decodeURIComponent(path.slice(14, -6)) }));
      if (request.method === "POST" && path.startsWith("/api/projects/") && path.endsWith("/decisions")) return json(201, this.service.projectBrainDecisionSave({ ...bodyObject(request.body), project_id: decodeURIComponent(path.slice(14, -10)) }));
      if (request.method === "POST" && path.startsWith("/api/projects/") && path.endsWith("/materials")) return json(201, this.service.projectBrainMaterialBind({ ...bodyObject(request.body), project_id: decodeURIComponent(path.slice(14, -10)) }));
      if (request.method === "POST" && path.startsWith("/api/projects/") && path.endsWith("/outcomes")) return json(201, this.service.projectBrainOutcomeRecord({ ...bodyObject(request.body), project_id: decodeURIComponent(path.slice(14, -9)) }));
      if (request.method === "POST" && path.startsWith("/api/projects/") && path.endsWith("/experiences")) return json(201, this.service.projectBrainExperienceRecord({ ...bodyObject(request.body), project_id: decodeURIComponent(path.slice(14, -12)) }));
      if (request.method === "GET" && path.startsWith("/api/projects/")) return json(200, this.service.projectBrainGet({ project_id: decodeURIComponent(path.slice(14)), limit: boundedLimit(url.searchParams.get("limit"), 50) }));
      if (request.method === "GET" && path === "/api/connectors") return json(200, this.service.capabilityConnectorList({ limit: boundedLimit(url.searchParams.get("limit"), 50) }));
      if (request.method === "POST" && path === "/api/connectors") return json(201, this.service.capabilityConnectorRegister(bodyObject(request.body)));
      if (request.method === "POST" && path.startsWith("/api/connectors/") && path.endsWith("/discover")) return json(201, this.service.capabilityConnectorDiscover({ ...bodyObject(request.body), connector_id: decodeURIComponent(path.slice(16, -9)) }));
      if (request.method === "POST" && path.startsWith("/api/connectors/") && path.endsWith("/status")) return json(200, this.service.capabilityConnectorUpdate({ ...bodyObject(request.body), connector_id: decodeURIComponent(path.slice(16, -7)) }));
      if (request.method === "POST" && path.startsWith("/api/connectors/") && path.endsWith("/revoke")) return json(200, this.service.capabilityConnectorRevoke({ ...bodyObject(request.body), connector_id: decodeURIComponent(path.slice(16, -7)) }));
      if (request.method === "POST" && path.startsWith("/api/connector-assets/") && path.endsWith("/approve")) return json(200, this.service.capabilityConnectorApprove({ ...bodyObject(request.body), connector_asset_id: decodeURIComponent(path.slice(22, -8)) }));
      if (request.method === "GET" && path === "/api/sources") return json(200, this.service.sourceList());
      return json(404, { error: "Not found" });
    } catch (error) { return failure(error); }
  }

  /**
   * Studio routes that must await a kernel. They stay off `handle` so the
   * synchronous app contract every existing test relies on is unchanged.
   */
  async handleAsync(request: WebRequest): Promise<WebResponse> {
    const url = new URL(request.path, this.origin); const path = url.pathname;
    if (path === "/api/capabilities/ensure") {
      if (request.origin !== undefined && request.origin !== this.origin) return json(403, { error: "Cross-origin request rejected" });
      if (!authorized(request.token, this.token)) return json(401, { error: "Workbench token required" });
      try {
        if (request.method === "POST") return json(200, await this.service.capabilityEnsure(bodyObject(request.body)));
        return json(404, { error: "Not found" });
      } catch (error) { return failure(error); }
    }
    if (path === "/api/workbench/plugins/install" || path === "/api/workbench/dsh-plugin-tools"
      || path === "/api/workbench/dsh-plugin-call") {
      if (request.origin !== undefined && request.origin !== this.origin) return json(403, { error: "Cross-origin request rejected" });
      if (!authorized(request.token, this.token)) return json(401, { error: "Workbench token required" });
      try {
        if (request.method === "POST" && path === "/api/workbench/plugins/install") {
          const body = bodyObject(request.body);
          if (body.host !== "dsh") throw new Error("plugin host is unsupported");
          return json(201, await this.service.dshPluginHost.install(text(body.spec, "spec")));
        }
        if (request.method === "GET" && path === "/api/workbench/dsh-plugin-tools") return json(200, await this.service.dshPluginHost.listTools());
        if (request.method === "POST" && path === "/api/workbench/dsh-plugin-call") {
          const body = bodyObject(request.body);
          return json(200, await this.service.dshPluginHost.call(text(body.tool, "tool"),
            body.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments) ? body.arguments as JsonObject : {},
            body.timeout_ms === undefined ? undefined : Number(body.timeout_ms),
            body.output_limit === undefined ? undefined : Number(body.output_limit)));
        }
        return json(404, { error: "Not found" });
      } catch (error) { return failure(error); }
    }
    if (path === "/api/workbench/evaluations" || path.startsWith("/api/workbench/evaluations/")) {
      if (request.origin !== undefined && request.origin !== this.origin) return json(403, { error: "Cross-origin request rejected" });
      if (!authorized(request.token, this.token)) return json(401, { error: "Workbench token required" });
      if (!this.evaluations) return json(503, { error: "Evaluation service unavailable" });
      try {
        if (path === "/api/workbench/evaluations" && request.method === "POST") return json(202, { evaluation: await this.evaluations.submit(bodyObject(request.body)) });
        if (path === "/api/workbench/evaluations/knowledge-context" && request.method === "GET") {
          const runId = url.searchParams.get("retrieval_run_id");
          if (!runId || runId.length > 256 || /[\u0000-\u001f\u007f]/u.test(runId)) throw new Error("retrieval_run_id is invalid");
          return json(200, this.evaluations.knowledgeContext(runId));
        }
        if (path === "/api/workbench/evaluations/knowledge-assess" && request.method === "POST") {
          const body = bodyObject(request.body);
          if (typeof body.retrieval_run_id !== "string" || !body.retrieval_run_id || body.retrieval_run_id.length > 256
            || /[\u0000-\u001f\u007f]/u.test(body.retrieval_run_id) || typeof body.baseline_id !== "string" || typeof body.candidate_id !== "string"
            || !/^[a-f0-9]{64}$/u.test(body.baseline_id) || !/^[a-f0-9]{64}$/u.test(body.candidate_id)) throw new Error("Knowledge effect must identify a retrieval run and two controlled evaluations");
          return json(200, await this.evaluations.assessKnowledgeEffect(body.retrieval_run_id, body.baseline_id, body.candidate_id));
        }
        if (path === "/api/workbench/evaluations/compare" && request.method === "POST") {
          const body = bodyObject(request.body);
          if (typeof body.baseline_id !== "string" || typeof body.candidate_id !== "string" || !/^[a-f0-9]{64}$/u.test(body.baseline_id) || !/^[a-f0-9]{64}$/u.test(body.candidate_id)) throw new Error("baseline_id and candidate_id must identify controlled evaluations");
          return json(200, await this.evaluations.compare(body.baseline_id, body.candidate_id));
        }
        const match = /^\/api\/workbench\/evaluations\/([a-f0-9]{64})(?:\/(events|cancel|report))?$/.exec(path);
        if (!match) return json(404, { error: "Not found" });
        const id = match[1]!;
        if (request.method === "GET" && !match[2]) return json(200, { evaluation: this.evaluations.get(id) });
        if (request.method === "GET" && match[2] === "events") return json(200, this.evaluations.events(id));
        if (request.method === "GET" && match[2] === "report") return json(200, await this.evaluations.report(id));
        if (request.method === "POST" && match[2] === "cancel") return json(200, { evaluation: this.evaluations.cancel(id) });
        return json(404, { error: "Not found" });
      } catch (error) { if ((error as { code?: string }).code === "EVALUATION_NOT_FOUND") return json(404, { error: "Evaluation not found" }); return failure(error); }
    }

    const pilotDispatch = /^\/api\/workbench\/pilot-sessions\/([^/]+)\/dispatch$/u.exec(path);
    if (pilotDispatch) {
      if (request.method !== "POST") return json(404, { error: "Not found" });
      if (request.origin !== undefined && request.origin !== this.origin) return json(403, { error: "Cross-origin request rejected" });
      if (!authorized(request.token, this.token)) return json(401, { error: "Workbench token required" });
      const agentSessions = this.agentSessions;
      const sessionId = decodeURIComponent(pilotDispatch[1]!);
      try {
        const body = bodyObject(request.body);
        const permission = body.permission === undefined ? "ask" : String(body.permission);
        if (!new Set(["ask", "auto", "full"]).has(permission)) throw new Error("permission is unsupported");
        const model = body.model === undefined || body.model === null ? null : text(body.model, "model");
        const craftModel = body.craft_model === undefined || body.craft_model === null ? null : text(body.craft_model, "craft_model");
        const scheduled = this.service.pilotSchedule({ session_id: sessionId });
        const admitted = Array.isArray(scheduled.admitted) ? scheduled.admitted as JsonObject[] : [];
        const workers = await Promise.all(admitted.map(async (route): Promise<JsonObject> => {
          const routeId = String(route.id);
          const providerRaw = String(route.executor_template);
          const provider = providerRaw === "codex-cli" ? "codex" : providerRaw === "claude-code" ? "claude"
            : providerRaw === "craft-internal" ? "craft" : providerRaw;
          try {
            if (!new Set(["craft", "codex", "claude", "dsh"]).has(provider)) throw new Error("executor is not an installed agent provider");
            const task = this.service.store.get("task", String(route.task_id));
            const workspaceId = typeof task.workspace_id === "string" ? task.workspace_id : "";
            const workspaceRecord = workspaceId ? this.service.store.get("workspace", workspaceId) : null;
            const workspace = typeof workspaceRecord?.root_path === "string" ? workspaceRecord.root_path : "";
            if (!workspace) throw new Error("task has no workspace; choose a project before dispatch");
            const prompt = String(task.goal);
            const operationId = randomUUID();
            let linkId: string | null = null;
            if (provider === "craft") {
              const permissionMode = permission === "full" ? "full_access" : permission === "auto" ? "assisted_approval" : "human_approval";
              await this.service.taskMessageSend({ task_id: String(task.id), content: prompt,
                permission_mode: permissionMode, ...(craftModel ? { model_id: craftModel } : {}) });
              this.service.pilotWorkerBind({ route_id: routeId, provider, state: "completed" });
              return { route_id: routeId, task_id: String(task.id), provider, state: "completed", link_id: null };
            } else if (provider === "codex") {
              if (!agentSessions) throw new Error("Agent sessions are unavailable");
              const created = await agentSessionRoute(agentSessions, "POST",
                new URL("/api/workbench/agent-sessions", "http://localhost"),
                { task_id: String(task.id), workspace, provider: "codex", model, permission, operation_id: operationId },
                this.claudeRuns, undefined, undefined, this.dshRuns);
              if (created.status >= 400) throw new Error(String((created.value as JsonObject).error ?? "Codex session failed"));
              const link = created.value.link as JsonObject | undefined;
              if (!link?.id) throw new Error("Codex session creation returned no link");
              linkId = String(link.id);
              const turn = await agentSessionRoute(agentSessions, "POST",
                new URL(`/api/workbench/agent-sessions/${encodeURIComponent(linkId)}/turns`, "http://localhost"),
                { task_id: String(task.id), prompt, operation_id: `${operationId}-turn`, work_mode: "default" },
                this.claudeRuns, undefined, undefined, this.dshRuns);
              if (turn.status >= 400) throw new Error(String((turn.value as JsonObject).error ?? "Codex turn failed"));
            } else if (provider === "claude") {
              if (!this.claudeRuns) throw new Error("Claude runs are unavailable");
              const created = claudeRunRoute(this.claudeRuns, "POST", new URL("/api/workbench/claude-runs", "http://localhost"),
                { task_id: String(task.id), workspace, prompt, operation_id: operationId, permission, work_mode: "default", model },
                this.claudeExecutable);
              if (created.status >= 400) throw new Error(String((created.value as JsonObject).error ?? "Claude run failed"));
              const run = created.value.run as JsonObject | undefined;
              linkId = run && run.id !== undefined ? String(run.id) : null;
            } else {
              if (!this.dshRuns) throw new Error("DSH runs are unavailable");
              const created = await dshRunRoute(this.dshRuns, "POST", new URL("/api/workbench/dsh-runs", "http://localhost"),
                { task_id: String(task.id), workspace, prompt, operation_id: operationId, permission, model });
              if (created.status >= 400) throw new Error(String((created.value as JsonObject).error ?? "DSH run failed"));
              const link = created.value.link as JsonObject | undefined;
              linkId = link?.id ? String(link.id) : null;
            }
            this.service.pilotWorkerBind({ route_id: routeId, provider, state: "started", link_id: linkId ?? undefined });
            return { route_id: routeId, task_id: String(task.id), provider, state: "started", link_id: linkId };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.service.pilotWorkerBind({ route_id: routeId, provider, state: "failed", reason: message });
            return { route_id: routeId, task_id: String(route.task_id), provider, state: "failed", error: message };
          }
        }));
        return json(202, { scheduled, workers,
          status: this.service.pilotSessionReconcile({ session_id: sessionId }) });
      } catch (error) { return failure(error); }
    }

    if (path === "/api/workbench/claude-runs" || path.startsWith("/api/workbench/claude-runs/")) {
      if (request.origin !== undefined && request.origin !== this.origin) return json(403, { error: "Cross-origin request rejected" });
      if (!authorized(request.token, this.token)) return json(401, { error: "Workbench token required" });
      if (!this.claudeRuns) return json(503, { error: "Claude runs are unavailable" });
      try { const result = claudeRunRoute(this.claudeRuns, request.method, url, bodyObject(request.body), this.claudeExecutable); return json(result.status, result.value); }
      catch (error) { return failure(error); }
    }
    if (path === "/api/workbench/dsh-runs" || path.startsWith("/api/workbench/dsh-runs/")
      || path === "/api/workbench/dsh-native" || path === "/api/workbench/dsh-models") {
      if (request.origin !== undefined && request.origin !== this.origin) return json(403, { error: "Cross-origin request rejected" });
      if (!authorized(request.token, this.token)) return json(401, { error: "Workbench token required" });
      if (!this.dshRuns) return json(503, { error: "DSH runs are unavailable" });
      try { const result = await dshRunRoute(this.dshRuns, request.method, url, bodyObject(request.body)); return json(result.status, result.value); }
      catch (error) { return failure(error); }
    }
    if (path === "/api/workbench/agent-sessions" || path.startsWith("/api/workbench/agent-sessions/")) {
      if (request.origin !== undefined && request.origin !== this.origin) return json(403, { error: "Cross-origin request rejected" });
      if (!authorized(request.token, this.token)) return json(401, { error: "Workbench token required" });
      if (!this.agentSessions) return json(503, { error: "Agent sessions are unavailable" });
      try { const result = await agentSessionRoute(this.agentSessions, request.method, url, bodyObject(request.body), this.claudeRuns, undefined, undefined, this.dshRuns); return json(result.status, result.value); }
      catch (error) { return failure(error); }
    }
    if (request.method === "POST" && (path === "/api/sources" || path === "/api/workbench/call"
      || path === "/api/workbench/native-tools/call" || (path.startsWith("/api/tasks/") && path.endsWith("/messages")))) {
      if (request.origin !== undefined && request.origin !== this.origin) return json(403, { error: "Cross-origin request rejected" });
      if (!authorized(request.token, this.token)) return json(401, { error: "Workbench token required" });
      try {
        if (path === "/api/sources") return json(201, await this.service.sourceAdd(bodyObject(request.body)));
        if (path === "/api/workbench/native-tools/call") {
          const body = bodyObject(request.body), tool = text(body.tool, "tool");
          if (!INTERNAL_ONLY_TOOLS.some((definition) => definition.function.name === tool)) {
            return json(422, { error: `Unknown native tool: ${tool}` });
          }
          const args = body.args === undefined ? {} : body.args;
          if (!args || typeof args !== "object" || Array.isArray(args)) return json(422, { error: "tool args must be an object" });
          return json(200, await this.service.invokeNativeTool(tool, args as JsonObject));
        }
        if (path.startsWith("/api/tasks/") && path.endsWith("/messages")) {
          return json(201, await this.service.taskMessageSend({ ...bodyObject(request.body), task_id: decodeURIComponent(path.slice(11, -9)) }));
        }
        const body = bodyObject(request.body); const name = String(body.tool ?? "");
        if (!name.startsWith("craft_")) return json(422, { error: "Studio calls must address a craft_ tool" });
        const bridge = workbenchBridge(this.service);
        const handler = bridge.handlers[name];
        if (!handler) return json(422, { error: `Unknown craft tool: ${name}` });
        const args = body.args === undefined ? {} : body.args;
        if (!args || typeof args !== "object" || Array.isArray(args)) return json(422, { error: "tool args must be an object" });
        return json(200, await handler(args as JsonObject));
      } catch (error) { return failure(error); }
    }
    if (request.method === "POST" && /^\/api\/pilot\/sessions\/[^/]+\/turns\/model$/u.test(path)) {
      if (request.origin !== undefined && request.origin !== this.origin) return json(403, { error: "Cross-origin request rejected" });
      if (!authorized(request.token, this.token)) return json(401, { error: "Workbench token required" });
      try {
        const segment = path.slice("/api/pilot/".length).split("/").map((part) => decodeURIComponent(part));
        return json(201, await this.service.pilotTurnWithModel({ ...bodyObject(request.body), session_id: segment[1] }));
      } catch (error) { return failure(error); }
    }
    // 手动触发一次监听轮询（本地 / 挂载云目录）：把新消息经 messageIngest 门禁
    // （脱敏 + 归一）存入收件箱。异步因为 LocalDropAdapter 读取磁盘；0 Token。
    if (request.method === "POST" && path === "/api/workbench/messages/poll") {
      if (request.origin !== undefined && request.origin !== this.origin) return json(403, { error: "Cross-origin request rejected" });
      if (!authorized(request.token, this.token)) return json(401, { error: "Workbench token required" });
      try { return json(200, await this.service.messagePoll(bodyObject(request.body))); }
      catch (error) { return failure(error); }
    }
    return this.handle(request);
  }

  #workbenchAsset(path: string): WebResponse {
    const asset = assetFor(path);
    if (!asset || this.workbenchDir === null || !existsSync(join(this.workbenchDir, asset.file))) return json(404, { error: "Not found" });
    return { status: 200, contentType: asset.type, body: readFileSync(join(this.workbenchDir, asset.file), "utf8") };
  }
}

export class LocalWorkbenchServer {
  #evaluations: WorkbenchEvaluations | null = null;
  #queueRunner: WorkbenchQueueRunner | null = null;
  readonly workbenchDir: string | null;
  readonly service: CraftService; readonly token: string; readonly acceptanceTick: () => Promise<unknown>; readonly pilotTick: () => unknown; #server: Server | null = null; #agentSessions: CodexWorkbenchSessions | null = null; #claudeRuns: ClaudeWorkbenchRuns | null = null; #dshRuns: DshWorkbenchRuns | null = null; #acceptanceTimer: NodeJS.Timeout | null = null; #pilotTimer: NodeJS.Timeout | null = null; #acceptanceRunning = false; #pilotRunning = false;
  constructor(service: CraftService, token = randomBytes(32).toString("base64url"), options: { acceptanceTick?: () => Promise<unknown>; pilotTick?: () => unknown; workbenchDir?: string | null } = {}) { this.service = service; this.token = token; this.workbenchDir = options.workbenchDir ?? null; this.acceptanceTick = options.acceptanceTick ?? (() => runBuiltinAcceptanceTicks(this.service)); this.pilotTick = options.pilotTick ?? (() => this.service.pilotReconcileAll({ limit: 100 })); }
  async start(port = 4173): Promise<{ url: string; token: string }> {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port must be an integer between 0 and 65535");
    if (this.#server) throw new Error("Workbench server is already running");
    const agentSessions = new CodexWorkbenchSessions(this.service.store);
    const claudeRuns = new ClaudeWorkbenchRuns(this.service.store);
    const dshRuns = new DshWorkbenchRuns(this.service.store, () => resolveDshLaunch(loadSettingsSync()));
    registerAgentDesktopAdapter(this.service.store);
    const defaultPermission = loadSettingsSync().workbench.defaultPermission;
    this.service.setInternalApprovalPolicy((_action, effect) =>
      defaultPermission === "full" || (defaultPermission === "auto" && effect !== "destructive") ? "allow" : "ask");
    const evaluations = new WorkbenchEvaluations(this.service.store);
    this.#evaluations = evaluations;
    const server = createServer((request, response) => { const chunks: Buffer[] = []; let size = 0;
      request.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= MAX_BODY) chunks.push(chunk); });
      request.on("end", () => { const activePort = (server.address() as AddressInfo).port;
        const origin = `http://127.0.0.1:${activePort}`; const auth = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : undefined;
        // `handleAsync` is total: it only ever resolves or returns a JSON error,
        // so the reply is written from `then` without a failure channel.
        // NB: hand over the raw url, not `.pathname`. `handle` reads limits and
        // ids from `url.searchParams`, so stripping the query here silently
        // dropped every `?limit=` / `?project_id=` a caller sent.
        const pending = size > MAX_BODY ? Promise.resolve(json(413, { error: "Request body exceeds 64 KiB" })) : new WorkbenchWebApp(this.service, this.token, origin, { workbenchDir: this.workbenchDir, agentSessions, claudeRuns, dshRuns, evaluations }).handleAsync({ method: String(request.method),
          path: String(request.url), token: auth, origin: request.headers.origin, body: Buffer.concat(chunks).toString("utf8") });
        void pending.then((result) => {
          response.writeHead(result.status, { "content-type": result.contentType, "content-length": Buffer.byteLength(result.body), ...SECURITY_HEADERS }); response.end(result.body); }); }); });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    this.#server = server; this.#agentSessions = agentSessions; this.#claudeRuns = claudeRuns; this.#dshRuns = dshRuns;
    this.#acceptanceTimer = setInterval(() => { if (this.#acceptanceRunning) return; this.#acceptanceRunning = true; this.acceptanceTick().catch(() => undefined).finally(() => { this.#acceptanceRunning = false; }); }, 500);
    // Worker settlement cannot depend on a WebView staying open. This heartbeat
    // only observes durable session links, final reviews and experience seeds;
    // it never re-sends a turn whose effect is unknown.
    this.#pilotTimer = setInterval(() => {
      if (this.#pilotRunning) return;
      this.#pilotRunning = true;
      try { this.pilotTick(); } catch { /* a later tick observes the same facts */ }
      finally { this.#pilotRunning = false; }
    }, 2_000);
    const activePort = (server.address() as AddressInfo).port;
    this.#queueRunner = new WorkbenchQueueRunner(this.service.store,
      (task, id) => agentSessionRoute(agentSessions, "POST", new URL(`/api/workbench/agent-sessions/${encodeURIComponent(id)}/queue-dispatch`, "http://localhost"), { task_id: task }, claudeRuns, undefined, undefined, dshRuns),
      link => {
        if (link.provider === "claude") return true;
        if (link.provider === "dsh") return true;
        if (link.provider !== "codex") return false;
        try { const status = agentSessions.events(String(link.task_id), String(link.id), null, 0).status as JsonObject; return status.connected === true; } catch { return false; }
      });
    this.#queueRunner.start();
    return { url: `http://127.0.0.1:${activePort}/#token=${encodeURIComponent(this.token)}`, token: this.token };
  }
  async close(): Promise<void> { const server = this.#server; if (!server) return; this.#server = null; await this.#evaluations?.close(); this.#evaluations = null; this.#agentSessions?.close(); this.#agentSessions = null; this.#claudeRuns?.close(); this.#claudeRuns = null; await this.#dshRuns?.close(); this.#dshRuns = null; await this.#queueRunner?.close(); this.#queueRunner = null; if (this.#acceptanceTimer) clearInterval(this.#acceptanceTimer); this.#acceptanceTimer = null; if (this.#pilotTimer) clearInterval(this.#pilotTimer); this.#pilotTimer = null; await new Promise<void>((resolve) => server.close(() => resolve())); }
}
