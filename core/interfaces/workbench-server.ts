import { text } from "../validation.ts";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CraftService, VERSION } from "../application/craft-service.ts";
import { runBuiltinAcceptanceTicks } from "../acceptance-worker.ts";
import { createActionHandlers } from "../application/actions/action-handlers.ts";
import { type JsonObject } from "../infrastructure/store.ts";

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

/**
 * The Studio is a Codex-style HTML app that lives beside the packaged runtime
 * rather than inside the bundle, so it stays editable without a rebuild. Walk
 * up from this module (src/ in development, dist/src/ after a build) and use
 * the first directory that actually holds the app.
 */
export function locateWorkbench(start?: string): string | null {
  let directory = start ?? dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = join(directory, "workbench");
    if (existsSync(join(candidate, "index.html"))) return candidate;
    directory = dirname(directory);
  }
  return null;
}

const WORKBENCH_ASSETS: Readonly<Record<string, { file: string; type: string }>> = {
  "/entry.css": { file: "entry.css", type: "text/css; charset=utf-8" },
  "/workbench/entry.css": { file: "entry.css", type: "text/css; charset=utf-8" },
  "/entry-shell.js": { file: "entry-shell.js", type: "application/javascript; charset=utf-8" },
  "/workbench/entry-shell.js": { file: "entry-shell.js", type: "application/javascript; charset=utf-8" },
  "/entry-session.js": { file: "entry-session.js", type: "application/javascript; charset=utf-8" },
  "/workbench/entry-session.js": { file: "entry-session.js", type: "application/javascript; charset=utf-8" },
  "/entry-view.js": { file: "entry-view.js", type: "application/javascript; charset=utf-8" },
  "/workbench/entry-view.js": { file: "entry-view.js", type: "application/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "application/javascript; charset=utf-8" },
  "/runtime-client.js": { file: "runtime-client.js", type: "application/javascript; charset=utf-8" },
  "/workbench/runtime-client.js": { file: "runtime-client.js", type: "application/javascript; charset=utf-8" },
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
  "/model-setup.js": { file: "model-setup.js", type: "application/javascript; charset=utf-8" },
  "/workbench/model-setup.js": { file: "model-setup.js", type: "application/javascript; charset=utf-8" },
  "/workbench/resource-pages.js": { file: "resource-pages.js", type: "application/javascript; charset=utf-8" },
};

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
  readonly service: CraftService; readonly token: string; readonly origin: string; readonly workbenchDir: string | null;
  constructor(service: CraftService, token: string, origin: string, options: { workbenchDir?: string | null } = {}) {
    this.service = service; this.token = token; this.origin = origin;
    this.workbenchDir = options.workbenchDir === undefined ? locateWorkbench() : options.workbenchDir;
  }
  handle(request: WebRequest): WebResponse {
    const url = new URL(request.path, this.origin); const path = url.pathname;
    if (request.method === "GET" && path === "/") return this.#workbenchAsset("/workbench");
    if (request.method === "GET" && path === "/health") return json(200, { status: "ok", version: VERSION });
    if (request.method === "GET" && (path.startsWith("/workbench") || path in WORKBENCH_ASSETS)) return this.#workbenchAsset(path);
    if (path.startsWith("/api/") && request.origin !== undefined && request.origin !== this.origin) return json(403, { error: "Cross-origin request rejected" });
    if (path.startsWith("/api/") && !authorized(request.token, this.token)) return json(401, { error: "Workbench token required" });
    try {
      if (request.method === "GET" && path === "/api/home") {
        const homeLimit = Number(url.searchParams.get("limit"));
        return json(200, this.service.homeView(Number.isInteger(homeLimit) && homeLimit >= 1 && homeLimit <= 50 ? { limit: homeLimit } : {}));
      }
      if (request.method === "GET" && path === "/api/project-brain") return json(200, this.service.projectBrainGet({ project_id: queryValue(url, "project_id") || "local", limit: queryValue(url, "limit") }));
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
        state: queryValue(url, "state"), now: queryValue(url, "now") ?? new Date().toISOString() }));
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
      if (request.method === "GET" && path === "/api/workbench/resources") return json(200, this.service.workbenchResourceView({ kind: queryValue(url, "kind"), task_id: queryValue(url, "task_id"), limit: queryValue(url, "limit") }));
      if (request.method === "POST" && path === "/api/workbench/plugins") return json(201, this.service.workbenchPluginInstall(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/workbench/skills") return json(201, this.service.workbenchSkillSave(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/workbench/memory") return json(201, this.service.workbenchMemorySave(bodyObject(request.body)));
      if (request.method === "POST" && path === "/api/workbench/memory/review") return json(200, this.service.workbenchMemoryReview(bodyObject(request.body)));
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
    const path = new URL(request.path, this.origin).pathname;
    if (request.method === "POST" && (path === "/api/sources" || path === "/api/workbench/call" || (path.startsWith("/api/tasks/") && path.endsWith("/messages")))) {
      if (request.origin !== undefined && request.origin !== this.origin) return json(403, { error: "Cross-origin request rejected" });
      if (!authorized(request.token, this.token)) return json(401, { error: "Workbench token required" });
      try {
        if (path === "/api/sources") return json(201, await this.service.sourceAdd(bodyObject(request.body)));
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
    return this.handle(request);
  }

  #workbenchAsset(path: string): WebResponse {
    const asset = WORKBENCH_ASSETS[path];
    if (!asset || this.workbenchDir === null) return json(404, { error: "Not found" });
    return { status: 200, contentType: asset.type, body: readFileSync(join(this.workbenchDir, asset.file), "utf8") };
  }
}

export class LocalWorkbenchServer {
  readonly service: CraftService; readonly token: string; readonly acceptanceTick: () => Promise<unknown>; #server: Server | null = null; #acceptanceTimer: NodeJS.Timeout | null = null; #acceptanceRunning = false;
  constructor(service: CraftService, token = randomBytes(32).toString("base64url"), options: { acceptanceTick?: () => Promise<unknown> } = {}) { this.service = service; this.token = token; this.acceptanceTick = options.acceptanceTick ?? (() => runBuiltinAcceptanceTicks(this.service)); }
  async start(port = 4173): Promise<{ url: string; token: string }> {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port must be an integer between 0 and 65535");
    if (this.#server) throw new Error("Workbench server is already running");
    const server = createServer((request, response) => { const chunks: Buffer[] = []; let size = 0;
      request.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= MAX_BODY) chunks.push(chunk); });
      request.on("end", () => { const activePort = (server.address() as AddressInfo).port;
        const origin = `http://127.0.0.1:${activePort}`; const auth = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : undefined;
        // `handleAsync` is total: it only ever resolves or returns a JSON error,
        // so the reply is written from `then` without a failure channel.
        // NB: hand over the raw url, not `.pathname`. `handle` reads limits and
        // ids from `url.searchParams`, so stripping the query here silently
        // dropped every `?limit=` / `?project_id=` a caller sent.
        const pending = size > MAX_BODY ? Promise.resolve(json(413, { error: "Request body exceeds 64 KiB" })) : new WorkbenchWebApp(this.service, this.token, origin).handleAsync({ method: String(request.method),
          path: String(request.url), token: auth, origin: request.headers.origin, body: Buffer.concat(chunks).toString("utf8") });
        void pending.then((result) => {
          response.writeHead(result.status, { "content-type": result.contentType, "content-length": Buffer.byteLength(result.body), ...SECURITY_HEADERS }); response.end(result.body); }); }); });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    this.#server = server; this.#acceptanceTimer = setInterval(() => { if (this.#acceptanceRunning) return; this.#acceptanceRunning = true; this.acceptanceTick().catch(() => undefined).finally(() => { this.#acceptanceRunning = false; }); }, 500); const activePort = (server.address() as AddressInfo).port;
    return { url: `http://127.0.0.1:${activePort}/#token=${encodeURIComponent(this.token)}`, token: this.token };
  }
  async close(): Promise<void> { const server = this.#server; if (!server) return; this.#server = null; if (this.#acceptanceTimer) clearInterval(this.#acceptanceTimer); this.#acceptanceTimer = null; await new Promise<void>((resolve) => server.close(() => resolve())); }
}
