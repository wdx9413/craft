import { randomUUID } from "node:crypto";
import type { CraftStore, JsonObject } from "../../infrastructure/store.ts";
import { object, text } from "../../validation.ts";
import { contextFeedbackEvidenceCurrent, contextFeedbackWeight, contextFeedbackWeights } from "../../context-feedback-weight.ts";

export const DESIGN_QUESTIONS = [
  ["example", "最近一次，你怎样完成这件重复工作？"],
  ["trigger", "什么情况触发？重复触发怎样识别？"],
  ["inputs", "输入来自哪里？缺失或重复时怎样处理？"],
  ["steps", "具体步骤是什么？哪些判断必须由人决定？"],
  ["outputs", "交付物给谁、放在哪里？怎样验证内容正确？"],
  ["limits", "允许做什么？时间、费用和重试上限是多少？"],
  ["failure", "失败或结果未知时怎样停止、对账和交接？哪些操作可恢复或补偿？"],
  ["samples", "分别写出正常、空值、重复、失败样例及预期结果。"],
] as const;

/**
 * Roll a chronological feedback timeline up by day: the counted signals that
 * day and the weight it ended on. Pure, so it can be tested without owning
 * store-managed timestamps.
 */
export function rollupFeedbackByDay(events: readonly JsonObject[]): JsonObject[] {
  const daily: JsonObject[] = [];
  for (const event of events) {
    const at = typeof event.at === "string" ? event.at : "";
    const day = at.length >= 10 ? at.slice(0, 10) : "unknown";
    let bucket = daily[daily.length - 1];
    if (!bucket || bucket.day !== day) {
      bucket = { day, positive: 0, negative: 0, events: 0, end_weight: event.weight_after };
      daily.push(bucket);
    }
    bucket.events = Number(bucket.events) + 1;
    if (event.counted) {
      if (event.source === "feedback") bucket.positive = Number(bucket.positive) + 1;
      else bucket.negative = Number(bucket.negative) + 1;
    }
    bucket.end_weight = event.weight_after;
  }
  return daily;
}

/** Human design is persistent but never an execution or Experience authority. */
export class WorkflowDesignWorkbench {
  readonly store: CraftStore;
  /** Optional Experience ledger: capture seeds an observation without granting authority. */
  readonly experienceLedger?: { observe(args: JsonObject): JsonObject };
  constructor(store: CraftStore, experienceLedger?: { observe(args: JsonObject): JsonObject }) {
    this.store = store; this.experienceLedger = experienceLedger;
  }
  save(args: JsonObject): JsonObject {
    const scope = text(args.scope, "scope"), name = text(args.name, "name");
    const answers = object(args.answers, "answers");
    const allowed = new Set<string>(DESIGN_QUESTIONS.map(([key]) => key));
    for (const [key, value] of Object.entries(answers)) {
      if (!allowed.has(key) || typeof value !== "string" || value.length > 8000) throw new Error("Invalid design answer");
    }
    if (!/^(project|user|task|workspace):.+$/u.test(scope) || name.length > 200) throw new Error("Explicit design scope and bounded name required");
    if (/(?:api[_-]?key|password|secret|authorization|cookie|token)["']?\s*[:=]\s*[^\s]{6,}/iu.test(JSON.stringify({ name, answers }))) throw new Error("Design must not contain credentials");
    const id = args.design_id === undefined ? `workflow_design_${randomUUID()}` : text(args.design_id, "design_id");
    return this.store.transaction(() => {
      const current = this.store.find("workflow_design", id);
      if (current && (current.scope !== scope || args.expected_version !== current.version)) throw new Error("Design scope or version conflict; reload before saving");
      if (!current && args.expected_version !== undefined) throw new Error("Design no longer exists");
      const value = { name, scope, answers, author: "user", lifecycle: "draft", execution_authorized: false, routeable: false };
      const design = current ? this.store.save("workflow_design", id, value) : this.store.create("workflow_design", id, value);
      return this.describe(design);
    });
  }
  get(args: JsonObject): JsonObject {
    const design = this.store.get("workflow_design", text(args.design_id, "design_id"));
    if (design.scope !== text(args.scope, "scope")) throw new Error("Design scope mismatch");
    return this.describe(design);
  }
  list(args: JsonObject): JsonObject {
    const scope = text(args.scope, "scope");
    const designs = this.store.list("workflow_design", 101, item => item.scope === scope);
    return { question_catalog: DESIGN_QUESTIONS.map(([key, question]) => ({ key, question })), designs: designs.slice(0, 100).map(item => this.describe(item)), truncated: designs.length > 100 };
  }
  private describe(design: JsonObject): JsonObject {
    const answers = design.answers as Record<string, string>;
    const questions = DESIGN_QUESTIONS.filter(([key]) => !answers[key]?.trim()).map(([key, question]) => ({ key, question }));
    const markdown = [`# ${design.name}`, `范围：${design.scope}`, `版本：${design.version}；设计草稿，尚未执行或验证。`,
      ...DESIGN_QUESTIONS.map(([key, question]) => `## ${question}\n\n${answers[key]?.trim() || "待确认"}`),
      "## 交接\n\n先核对样例、未决问题和权限，再接入现有工作流实现与验收。此规格不是已验证经验，不授予执行权限。"].join("\n\n");
    return { design, questions, next_question: questions[0] ?? null, status: questions.length ? "needs_input" : "ready_for_review", markdown,
      execution_authorized: false, acceptance_status: "not_evaluated" };
  }

  /**
   * Capture a completed delivery as an experience seed.
   *
   * Reads the task's real receipts (outcomes → evidence) to prefill a workflow
   * design draft and records an experience observation when possible. Capture is
   * evidence-derived but never grants execution or routing authority.
   */
  capture(args: JsonObject): JsonObject {
    const taskId = text(args.task_id, "task_id");
    const task = this.store.get("task", taskId);
    const scenarioKey = text(args.scenario_key, "scenario_key").replace(/\s+/gu, "_").slice(0, 80);
    const trials = this.store.list("trial", 10_000, (item) => item.task_id === taskId);
    const outcomes = this.store.list("outcome", 10_000, (item) => trials.some((trial) => String(trial.id) === String(item.trial_id)));
    // Pull the real verification and decision signals so the precipitate is more
    // than a thin summary: how it was accepted, what needed human judgement, and
    // the original goal. These are read-only; nothing here grants authority.
    const acceptanceAssessments = this.store.list("acceptance_assessment", 100, (item) => item.task_id === taskId);
    const attentionItems = this.store.list("attention_item", 100, (item) => item.task_id === taskId);
    const decisionSignals = attentionItems
      .filter((item) => ["open", "deferred", "resolved"].includes(String(item.status)))
      .map((item) => String(item.reason ?? item.action ?? item.id));
    const goal = typeof task.goal === "string" && task.goal.trim() ? task.goal.trim() : (typeof task.title === "string" ? task.title : "");

    const evidenceIds = [...new Set(outcomes.flatMap((item) => Array.isArray(item.evidence_ids) ? item.evidence_ids.map(String) : []))]
      .filter((id) => this.store.find("evidence", id) !== null).sort();
    if (!evidenceIds.length) throw new Error("capture requires at least one Evidence bound to a completed Outcome; record the delivery evidence first");
    const verdicts = [...new Set(outcomes.map((item) => String(item.verdict)))];
    const summary = outcomes.map((item) => String(item.summary ?? "")).filter(Boolean).join("\n");
    const artifacts = [...new Set(outcomes.flatMap((item) => Array.isArray(item.evidence_ids) ? item.evidence_ids.map(String) : []))]
      .map((id) => this.store.find("evidence", id)!)
      .map((evidence) => String(evidence.locator ?? evidence.artifact_id ?? evidence.id));
    const kind = verdicts.includes("failed") ? "correction" : "success";
    const verifiedBy = [...new Set(acceptanceAssessments.map((item) => String(item.status)))]
      .filter((status) => status && status !== "null");
    const answers: Record<string, string> = {
      example: args.example?.toString().slice(0, 8000)
        || summary || `任务 ${String(task.title)} 的真实交付记录（判定：${verdicts.join("、")}）。`,
      trigger: args.trigger?.toString().slice(0, 8000) || (goal ? `目标「${goal.slice(0, 80)}」再次出现时需要复用这次做法。` : `任务 ${String(task.id)} 完成后需要复用这次做法时。`),
      inputs: args.inputs?.toString().slice(0, 8000) || `来自任务 ${String(task.id)} 的证据：${artifacts.slice(0, 5).join("；")}`,
      steps: args.steps?.toString().slice(0, 8000)
        || (verifiedBy.length ? `按原任务权限与预算执行；验收状态：${verifiedBy.join("、")}。先核对证据再逐步确认。` : "由真实交付记录整理；先核对证据再逐步确认。"),
      outputs: args.outputs?.toString().slice(0, 8000) || (artifacts.length ? `交付物 ${artifacts.slice(0, 5).join("；")}。` : "按原任务目标交付；以证据与验收记录为准。"),
      limits: args.limits?.toString().slice(0, 8000) || "按原任务权限与预算执行；超限需要人工确认。",
      failure: args.failure?.toString().slice(0, 8000)
        || (decisionSignals.length ? `需人工判断的节点：${decisionSignals.slice(0, 4).join("；")}。失败或结果未知时停止并核对，不自动重试同一提交。`
          : "失败或结果未知时停止并核对，不自动重试同一提交。"),
      samples: args.samples?.toString().slice(0, 8000) || (goal ? `正常：达成「${goal.slice(0, 60)}」；失败：结果与验收记录不一致时停止并人工核对。` : "暂无补充样例。"),
    };
    const scope = typeof args.scope === "string" && args.scope.trim() ? args.scope.trim()
      : typeof task.workspace_id === "string" && task.workspace_id ? `workspace:${task.workspace_id}` : `task:${taskId}`;
    // The ledger reads scope from scope_kind/scope_id. A workspace-bound task
    // uses the workspace kind so the observation is visible to that workspace's
    // context; otherwise it stays scoped to the task itself.
    const scopeKind = typeof task.workspace_id === "string" && task.workspace_id ? "workspace" : "task";
    const scopeId = scopeKind === "workspace" ? String(task.workspace_id) : taskId;
    const described = this.save({ ...args, scope, name: text(args.name, "name"), answers }) as JsonObject;
    const design = described.design as JsonObject;
    let observation: JsonObject | null = null;
    let observation_error: string | null = null;
    if (this.experienceLedger) {
      try {
        observation = this.experienceLedger.observe({
          source_ref: { kind: "outcome", id: String(outcomes[0]!.id), version: Number(outcomes[0]!.version) },
          kind, scenario_key: scenarioKey, finding: `${String(task.title)}: ${answers.example}`.slice(0, 2000),
          evidence_ids: evidenceIds, scope_kind: scopeKind, scope_id: scopeId,
        }).observation as JsonObject;
      } catch (error) { observation_error = (error as Error).message; }
    } else {
      observation_error = "experience ledger unavailable; design draft saved without an observation";
    }
    return { design, observation, observation_error, evidence_ids: evidenceIds, verdicts, kind };
  }

  /**
   * One scoped view of the whole experience pipeline: drafts, observations
   * (diagnostic), patterns (diagnostic) and procedures (routeable only when
   * promoted). Nothing here is mutable or execution-authoritative.
   */
  overview(args: JsonObject): JsonObject {
    const scope = text(args.scope, "scope");
    const splitAt = scope.indexOf(":");
    const scopeKind = splitAt > 0 ? scope.slice(0, splitAt) : "";
    const scopeId = splitAt > 0 ? scope.slice(splitAt + 1) : "";
    // Records store scope in two shapes: a string for designs/procedures and
    // { kind, id } for ledger records. Match both without guessing.
    const matches = (record: JsonObject): boolean => {
      const value = record.scope;
      if (typeof value === "string") return value === scope;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return String((value as JsonObject).kind) === scopeKind && String((value as JsonObject).id) === scopeId;
      }
      return false;
    };
    const drafts = this.store.list("workflow_design", 100, (item) => item.scope === scope).map((item) => this.describe(item));
    const observations = this.store.list("experience_observation", 100, matches)
      .map((item) => ({ id: item.id, kind: item.kind, scenario_key: item.scenario_key, source: item.source, evidence_ids: item.evidence_ids, status: item.status, diagnostic_only: true, created_at: item.created_at }));
    const patterns = this.store.list("experience_pattern", 100, matches)
      .map((item) => ({ id: item.id, pattern_kind: item.pattern_kind ?? item.kind, failure_type: item.failure_type ?? null, summary: item.summary ?? null, diagnostic_only: true, status: item.status, created_at: item.created_at }));
    const procedureRecords = this.store.list("experience_procedure", 100, matches);
    // Surface the recall-feedback weight so "a procedure that proved useful rises,
    // and one under a pending correction dips" is visible instead of only ranking
    // silently. Weights come from the same function the recall path ranks with.
    const feedback = contextFeedbackWeights(this.store, "experience", procedureRecords.map((item) => String(item.id)));
    const procedures = procedureRecords.map((item) => {
      const weight = feedback.get(String(item.id));
      return { id: item.id, procedure_kind: item.procedure_kind ?? "workflow", lifecycle: item.lifecycle,
        routeable: item.routeable === true, scope: item.scope, created_at: item.created_at,
        recall_weight: weight?.weight ?? 1, recall_penalty: weight?.penalty ?? 1,
        helpful_signals: weight?.positive ?? 0, pending_corrections: weight?.negative ?? 0 };
    });
    return { scope, drafts, observations, patterns, procedures,
      counts: { drafts: drafts.length, observations: observations.length, patterns: patterns.length, procedures: procedures.length } };
  }

  /**
   * Latest recall receipts that actually pulled this asset into context, so the
   * workbench can prefill feedback and audit reuse for every context member
   * (experience, knowledge, memory) without a second implementation.
   * Reads contributions.references only; bodies and privileged receipts never
   * enter the projection.
   */
  recallReceipts(args: JsonObject): JsonObject {
    const assetId = text(args.procedure_id ?? args.asset_id, "asset_id");
    const member = text(args.member ?? "experience", "member");
    if (!["experience", "knowledge", "memory"].includes(member)) throw new Error("Unsupported context member");
    const limit = (() => { const n = args.limit === undefined ? 5 : Number(args.limit); if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error("limit must be an integer between 1 and 50"); return n; })();
    const receipts = this.store.list("context_resolution_receipt", 10_000, (item) =>
      (Array.isArray(item.contributions) ? item.contributions as JsonObject[] : []).some((part) =>
        String(part.member) === member && (Array.isArray(part.references) ? part.references as JsonObject[] : [])
          .some((ref) => String(ref.id) === assetId)))
      .sort((left, right) => String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")))
      .slice(0, limit);
    // The audit trail is only complete when each recall shows how it was judged:
    // an unrated recall is not evidence, and a helpful one is what raises weight.
    const feedbacks = this.store.list("context_feedback", 10_000, (item) => String(item.receipt_id) !== "");
    const rows = receipts.map((item) => {
      const related = feedbacks.filter((feedback) => String(feedback.receipt_id) === String(item.id) &&
        (Array.isArray(feedback.asset_refs) ? feedback.asset_refs as JsonObject[] : [])
          .some((ref) => String(ref.member) === member && String(ref.id) === assetId));
      return { id: item.id, created_at: item.created_at ?? null, scope: item.scope ?? null,
        feedback: related.map((entry) => ({ id: entry.id, outcome: entry.outcome,
          usage_stage: entry.usage_stage ?? null, turn_outcome: entry.turn_outcome ?? null,
          evidence_verified: entry.evidence_verified === true, created_at: entry.created_at ?? null })) };
    });
    return { member, asset_id: assetId, receipts: rows };
  }

  /**
   * Chronological feedback for one asset with the running weight after each
   * counted event. This is the visible "it gets better with use" curve: a
   * helpful receipt with current program evidence raises it, a pending or
   * confirmed correction lowers it, and a dismissed correction is shown but not
   * counted. The formula is the exact one recall ranks with.
   */
  feedbackHistory(args: JsonObject): JsonObject {
    const assetId = text(args.asset_id ?? args.procedure_id, "asset_id");
    const member = text(args.member ?? "experience", "member");
    if (!["experience", "knowledge", "memory"].includes(member)) throw new Error("Unsupported context member");
    const limit = (() => { const n = args.limit === undefined ? 50 : Number(args.limit); if (!Number.isInteger(n) || n < 1 || n > 200) throw new Error("limit must be an integer between 1 and 200"); return n; })();
    const refMatches = (ref: unknown): boolean => {
      const value = ref as JsonObject | undefined;
      return Boolean(value) && String(value!.member) === member && String(value!.id) === assetId;
    };
    const events: JsonObject[] = [];
    for (const feedback of this.store.list("context_feedback", 10_000,
      (item) => Array.isArray(item.asset_refs) && (item.asset_refs as JsonObject[]).some(refMatches), false)) {
      events.push({ kind: String(feedback.outcome ?? "unknown"), source: "feedback",
        counted: String(feedback.outcome) === "helpful" && contextFeedbackEvidenceCurrent(this.store, feedback),
        at: String(feedback.created_at ?? ""), usage_stage: feedback.usage_stage ?? null,
        turn_outcome: feedback.turn_outcome ?? null, evidence_verified: feedback.evidence_verified === true });
    }
    for (const task of this.store.list("context_correction_task", 10_000,
      (item) => (item.outcome === "incorrect" || item.outcome === "stale") && refMatches(item.asset_ref), false)) {
      const status = String(task.status);
      events.push({ kind: String(task.outcome), source: "correction",
        counted: status === "pending_review" || status === "confirmed",
        at: String(task.created_at ?? task.resolved_at ?? ""), status,
        // Who settled it, when and why: a demotion on the curve must be traceable
        // to a human decision, not just a status flip.
        ...(task.decided_by === undefined ? {} : { decided_by: String(task.decided_by) }),
        ...(task.resolution_reason === undefined ? {} : { resolution_reason: String(task.resolution_reason) }),
        ...(task.resolved_at === undefined ? {} : { resolved_at: String(task.resolved_at) }) });
    }
    const ordered = events.map((event, index) => ({ event, index }))
      .sort((left, right) => String(left.event.at).localeCompare(String(right.event.at)) || left.index - right.index)
      .map((entry) => entry.event);
    let positive = 0, negative = 0;
    const timeline = ordered.map((event) => {
      if (event.counted) { if (event.source === "feedback") positive += 1; else negative += 1; }
      return { ...event, weight_after: contextFeedbackWeight(positive, negative) };
    });
    const daily = rollupFeedbackByDay(timeline as JsonObject[]);
    return { member, asset_id: assetId,
      current_weight: contextFeedbackWeight(positive, negative),
      counts: { positive, negative, dismissed: ordered.filter((event) => event.source === "correction" && !event.counted).length, events: timeline.length },
      points: (timeline as JsonObject[]).map((event) => ({ at: event.at, weight: event.weight_after })),
      daily,
      timeline: timeline.slice(-limit) };
  }
}
