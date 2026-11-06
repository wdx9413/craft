import type { JsonObject } from "./infrastructure/store.ts";
import type { PilotReviewCheck } from "./pilot-orchestrator.ts";

/**
 * Read-only Pilot result projection.
 *
 * Pilot does not own a second result ledger. It borrows the task's real
 * messages, outcomes, evidence, artifacts, acceptance assessments, attention
 * items and work-launch facts, then hides the long detail behind one summary.
 */
export interface PilotTaskResult extends JsonObject {
  task_id: string;
  route_id: string | null;
  headline: string;
  verdict: "working" | "awaiting_verification" | "passed" | "needs_attention";
  summary: string;
  artifacts: JsonObject[];
  evidence: JsonObject[];
  acceptance: JsonObject[];
  attention: JsonObject[];
  latest_message: string | null;
  provenance: "worker_observation" | "task_outcome" | "task_message" | "none";
  release: PilotReleaseProjection;
}

export interface PilotReleaseProjection {
  status: "not_applicable" | "pending_evaluation" | "signoff_ready" | "canary_ready" | "released" | "blocked";
  reason: string;
  evaluation_run_id: string | null;
  signoff_id: string | null;
  canary_id: string | null;
  publication_allowed: boolean;
}

function ref(item: JsonObject, fields: string[]): JsonObject {
  return Object.fromEntries(fields.filter((field) => item[field] !== undefined)
    .map((field) => [field, item[field]]));
}

function short(value: unknown, limit = 240): string {
  const text = String(value ?? "").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function ordered<T extends JsonObject>(rows: T[], limit: number): T[] {
  return [...rows].sort((left, right) => String(right.created_at ?? right.updated_at ?? "")
    .localeCompare(String(left.created_at ?? left.updated_at ?? "")) ||
    String(right.id ?? "").localeCompare(String(left.id ?? ""))).slice(0, limit);
}

export function projectPilotTaskResult(task: JsonObject, route: JsonObject, view: JsonObject,
  run: JsonObject | null = null, signoff: JsonObject | null = null, canary: JsonObject | null = null,
  publication: JsonObject | null = null): PilotTaskResult {
  const messages = Array.isArray(view.messages) ? view.messages as JsonObject[] : [];
  const outcomes = Array.isArray(view.outcomes) ? view.outcomes as JsonObject[] : [];
  const evidence = Array.isArray(view.evidence) ? view.evidence as JsonObject[] : [];
  const artifacts = Array.isArray(view.artifacts) ? view.artifacts as JsonObject[] : [];
  const attention = Array.isArray(view.attention) ? view.attention as JsonObject[] : [];
  const checks = Array.isArray(view.acceptance_checks) ? view.acceptance_checks as JsonObject[] : [];
  const assessments = Array.isArray(view.acceptance_assessments) ? view.acceptance_assessments as JsonObject[] : [];
  const launches = Array.isArray(view.work_launches) ? view.work_launches as JsonObject[] : [];
  const latestAssistant = [...messages].reverse().find((item) => String(item.role) === "assistant");
  const latestOutcome = ordered(outcomes, 1)[0] ?? null;
  const worker = route.worker && typeof route.worker === "object" && !Array.isArray(route.worker)
    ? route.worker as JsonObject : null;
  const workerState = String(worker?.state ?? "");
  const terminal = ["completed", "failed"].includes(workerState) || ["finished", "blocked"].includes(String(route.queue_state ?? ""));
  const artifactRefs = ordered(artifacts, 5).map((item) => ref(item,
    ["id", "kind", "name", "uri", "media_type", "digest", "created_at"]));
  const evidenceRefs = ordered(evidence, 5).map((item) => ref(item,
    ["id", "source_type", "claim", "confidence", "artifact_id", "locator", "observed_at"]));
  const acceptanceRefs = [
    ...ordered(checks, 5).map((item) => ({ kind: "check", ...ref(item,
      ["id", "criterion_id", "evaluator_type", "result", "summary", "created_at"]) })),
    ...ordered(assessments, 3).map((item) => ({ kind: "assessment", ...ref(item,
      ["id", "status", "checked", "total", "missing", "failed", "blocked", "created_at"]) })),
    ...ordered(launches, 3).map((item) => ({ kind: "work_launch", ...ref(item,
      ["id", "host", "status", "effective_status", "acceptance_status", "delivery_status", "updated_at"]) })),
  ];
  const attentionRefs = ordered(attention.filter((item) => ["open", "deferred"].includes(String(item.status))), 5)
    .map((item) => ref(item, ["id", "audience", "priority", "reason", "action", "status"]));
  const outcomeVerdict = String(latestOutcome?.verdict ?? "");
  const failedAssessment = assessments.some((item) => ["failed", "blocked"].includes(String(item.status)));
  const failedWorker = workerState === "failed" || String(route.queue_state) === "blocked";
  const passed = outcomeVerdict === "passed" && !failedAssessment && !failedWorker && !attentionRefs.length;
  const provenance: PilotTaskResult["provenance"] = latestOutcome ? "task_outcome" :
    worker?.state === "completed" || worker?.state === "failed" ? "worker_observation" :
      latestAssistant ? "task_message" : "none";
  const hasBasis = artifactRefs.length > 0 || evidenceRefs.length > 0 || acceptanceRefs.length > 0 || Boolean(latestAssistant);
  const needsAttention = failedWorker || failedAssessment || outcomeVerdict === "failed" ||
    outcomeVerdict === "blocked" || attentionRefs.length > 0 || (terminal && !hasBasis);
  const awaitingVerification = !passed && !needsAttention && terminal;
  const verdict: PilotTaskResult["verdict"] = passed ? "passed" : needsAttention ? "needs_attention" :
    awaitingVerification ? "awaiting_verification" : "working";
  const summary = short(latestOutcome?.summary ?? worker?.reason ?? latestAssistant?.content ??
    (artifactRefs.length ? `已登记 ${artifactRefs.length} 个产物引用` : "等待可核验结果"));
  const resultDraft: PilotTaskResult = {
    task_id: String(task.id), route_id: route.id === undefined ? null : String(route.id),
    headline: passed ? "已交付" : needsAttention ? "需要你核对" : awaitingVerification ? "待验收" : "执行中",
    verdict, summary, artifacts: artifactRefs, evidence: evidenceRefs, acceptance: acceptanceRefs,
    attention: attentionRefs, latest_message: latestAssistant ? short(latestAssistant.content, 600) : null,
    provenance, release: { status: "not_applicable", reason: "", evaluation_run_id: null, signoff_id: null,
      canary_id: null, publication_allowed: false },
  };
  resultDraft.release = projectPilotRelease(resultDraft, run, signoff, canary, publication);
  return resultDraft;
}

/** Final Reviewer gates over the task's observable result, never over model prose. */
export function reviewPilotResults(results: PilotTaskResult[]): PilotReviewCheck[] {
  const failed = results.filter((item) => item.verdict === "needs_attention");
  const awaiting = results.filter((item) => item.verdict === "awaiting_verification");
  const withoutBasis = results.filter((item) => item.provenance === "none" && !item.artifacts.length &&
    !item.evidence.length && !item.acceptance.length && !item.latest_message);
  const withoutAcceptance = results.filter((item) => item.verdict === "passed" && !item.acceptance.length);
  return [
    { id: "result_terminal", ok: failed.length === 0 && awaiting.length === 0, level: "needs_human",
      detail: failed.length ? `${failed.length} 个任务的结果需要人工核对` :
        awaiting.length ? `${awaiting.length} 个任务等待独立验收` : "所有结果都已有可用终态" },
    { id: "result_basis", ok: withoutBasis.length === 0, level: "needs_human",
      detail: withoutBasis.length ? `${withoutBasis.length} 个任务缺少可核验结果依据` : "所有结果都有可核验依据" },
    { id: "result_acceptance", ok: withoutAcceptance.length === 0, level: "warn",
      detail: withoutAcceptance.length ? `${withoutAcceptance.length} 个已交付任务没有独立验收记录` : "已交付任务都有验收记录" },
  ];
}

/**
 * Release is never implied by a passing task result. A passed task only becomes
 * release-eligible after an exact held-out evaluation and a deterministic
 * Signoff; Canary and publication remain explicit, governed next actions.
 */
export function projectPilotRelease(result: PilotTaskResult, run: JsonObject | null, signoff: JsonObject | null,
  canary: JsonObject | null, publication: JsonObject | null): PilotReleaseProjection {
  if (result.verdict !== "passed") {
    return { status: "not_applicable", reason: "任务尚未交付；发布门禁不适用", evaluation_run_id: null,
      signoff_id: null, canary_id: null, publication_allowed: false };
  }
  if (!run) {
    return { status: "pending_evaluation", reason: "需要对该交付物建立 held-out Evaluation Run",
      evaluation_run_id: null, signoff_id: null, canary_id: null, publication_allowed: false };
  }
  if (String(run.subject_id ?? "") !== result.task_id || String(run.verdict ?? "") !== "passed" ||
      String(run.split ?? "") !== "held_out") {
    return { status: "blocked", reason: "现有 Evaluation Run 与任务/判定/分区不一致",
      evaluation_run_id: String(run.id), signoff_id: null, canary_id: null, publication_allowed: false };
  }
  if (!signoff) {
    return { status: "signoff_ready", reason: "评估通过，等待确定性 Signoff",
      evaluation_run_id: String(run.id), signoff_id: null, canary_id: null, publication_allowed: false };
  }
  // IDs are opaque strings (e.g. "run-1"); compare them as strings, never as
  // numbers, otherwise Number() collapses every non-numeric id to NaN and the
  // equality degenerates to NaN !== NaN (always true -> always blocked).
  if (String(signoff.subject_type ?? "") !== "pilot_delivery" || String(signoff.subject_id ?? "") !== result.task_id ||
      String(signoff.evaluation_run_id ?? "") !== String(run.id) || String(signoff.decision ?? "") !== "passed") {
    return { status: "blocked", reason: "Signoff 与任务或评估不一致",
      evaluation_run_id: String(run.id), signoff_id: String(signoff.id), canary_id: null,
      publication_allowed: false };
  }
  if (!canary) {
    return { status: "canary_ready", reason: "Signoff 通过，可授权 Canary",
      evaluation_run_id: String(run.id), signoff_id: String(signoff.id), canary_id: null,
      publication_allowed: false };
  }
  if (String(canary.candidate_id ?? "") !== result.task_id) {
    return { status: "blocked", reason: "Canary 与任务不一致", evaluation_run_id: String(run.id),
      signoff_id: String(signoff.id), canary_id: String(canary.id), publication_allowed: false };
  }
  if (String(canary.status ?? "") !== "passed") {
    return { status: String(canary.status) === "rolled_back" ? "blocked" : "canary_ready",
      reason: String(canary.status) === "rolled_back" ? "Canary 回归，需回滚候选" : "Canary 运行中",
      evaluation_run_id: String(run.id), signoff_id: String(signoff.id), canary_id: String(canary.id),
      publication_allowed: false };
  }
  if (!publication) {
    return { status: "canary_ready", reason: "Canary 通过，等待发布授权",
      evaluation_run_id: String(run.id), signoff_id: String(signoff.id), canary_id: String(canary.id),
      publication_allowed: false };
  }
  return { status: String(publication.status) === "published" ? "released" : "blocked",
    reason: String(publication.status) === "published" ? "已发布" : "发布记录未通过",
    evaluation_run_id: String(run.id), signoff_id: String(signoff.id), canary_id: String(canary.id),
    publication_allowed: false };
}
