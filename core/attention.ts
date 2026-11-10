import { executionRootActive } from "./task-execution-fence.ts";
import { workAttemptBudget } from "./work-attempt-budget.ts";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { text } from "./validation.ts";
import { payload } from "./digest.ts";
import { attentionDecisionBrief } from "./attention-decision-brief.ts";


function instant(value: unknown, name: string): number { const parsed = value === undefined ? Date.now() : Date.parse(text(value, name)); if (Number.isNaN(parsed)) throw new Error(`${name} must be an ISO timestamp`); return parsed; }
function boundedLimit(value: unknown): number { const parsed = value === undefined ? 100 : Number(value); if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) throw new Error("limit must be an integer between 1 and 1000"); return parsed; }

type Candidate = { id: string; source_kind: string; source_id: string; source_version: number; source_status: string; task_id: string | null;
  audience: "human" | "agent" | "operator"; priority: number; reason: string; action: string; details: JsonObject };

/** A derived, non-authoritative projection of work that currently deserves attention. */
export class AttentionKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }
  refresh(args: JsonObject = {}): JsonObject {
    const now = instant(args.now, "now"); const allCandidates = this.candidates();
    const candidates = allCandidates.slice(0, boundedLimit(args.limit));
    const active = new Set(allCandidates.map((item) => item.id));
    const cards = candidates.map((candidate) => {
      const current = this.store.find("attention_item", candidate.id);
      if (!current) return this.store.create("attention_item", candidate.id, { ...candidate, status: "open", deferred_until: null });
      const unchanged = current.source_version === candidate.source_version && current.source_status === candidate.source_status;
      const deferred = current.status === "deferred" && Date.parse(String(current.deferred_until)) > now;
      if (unchanged && (current.status === "open" || current.status === "acknowledged" || deferred)) return current;
      return this.store.save("attention_item", candidate.id, { ...candidate, status: "open", deferred_until: null });
    });
    for (const current of this.store.list("attention_item", 10_000, (item) => ["open", "deferred", "acknowledged"].includes(String(item.status)))) {
      if (!active.has(String(current.id))) this.store.save("attention_item", String(current.id), { ...payload(current), status: "resolved",
        resolved_at: new Date(now).toISOString(), resolution: "source_no_longer_actionable" });
    }
    return { cards, count: cards.length, open_count: cards.filter((item) => item.status === "open").length, refreshed_at: new Date(now).toISOString() };
  }
  list(args: JsonObject = {}): JsonObject {
    const now = instant(args.now, "now"); const audience = args.audience === undefined ? null : text(args.audience, "audience");
    if (audience !== null && !["human", "agent", "operator"].includes(audience)) throw new Error("audience is unsupported");
    const items = this.store.list("attention_item", 10_000, (item) => (item.status === "open" ||
      (item.status === "deferred" && Date.parse(String(item.deferred_until)) <= now)) && (audience === null || item.audience === audience))
      .sort((left, right) => Number(right.priority) - Number(left.priority) || String(left.id).localeCompare(String(right.id)))
      .slice(0, boundedLimit(args.limit))
      // Derived read model: NEEDREAD §2 requires trigger, evidence, options,
      // impact, recommendation and uncertainty on each card. It is computed
      // from the current card so a refreshed source cannot leave a stale brief.
      .map((item) => ({ ...item, decision_brief: attentionDecisionBrief(item) as unknown as JsonObject }));
    return { items, count: items.length, as_of: new Date(now).toISOString() };
  }
  decide(args: JsonObject): JsonObject {
    const item = this.store.get("attention_item", text(args.item_id, "item_id"));
    if (!["open", "deferred"].includes(String(item.status))) throw new Error("Attention item is not actionable");
    if (typeof item.source_kind === "string" && typeof item.source_id === "string") {
      const source = this.store.find(String(item.source_kind), String(item.source_id));
      if (!source || Number(source.version) !== Number(item.source_version) || String(source.status) !== String(item.source_status)) {
        throw new Error("Attention source changed; refresh and confirm the current action");
      }
    }
    const decision = text(args.decision, "decision"); if (!new Set(["acknowledge", "defer"]).has(decision)) throw new Error("Attention decision is unsupported");
    const now = instant(args.now, "now"); let deferredUntil: string | null = null;
    if (decision === "defer") { const until = instant(args.deferred_until, "deferred_until"); if (until <= now) throw new Error("deferred_until must be later than now"); deferredUntil = new Date(until).toISOString(); }
    return { item: this.store.updateIfVersion("attention_item", String(item.id), Number(item.version), { ...payload(item),
      status: decision === "defer" ? "deferred" : "acknowledged", deferred_until: deferredUntil, decided_by: text(args.decided_by, "decided_by"),
      decision_reason: args.reason === undefined ? null : text(args.reason, "reason"), decided_at: new Date(now).toISOString() }) };
  }

  /**
   * Batch decisions are one user action but not one authorization: every card
   * is validated against its own source version and produces its own receipt.
   * A failure on one card never rolls back the others, and each result names
   * the exact card it belongs to.
   */
  decideBatch(args: JsonObject): JsonObject {
    const decision = text(args.decision, "decision");
    if (!new Set(["acknowledge", "defer"]).has(decision)) throw new Error("Attention decision is unsupported");
    const ids = args.item_ids;
    if (!Array.isArray(ids) || !ids.length) throw new Error("item_ids must be a non-empty array");
    if (ids.length > 50) throw new Error("at most 50 attention cards can be decided at once");
    const results: JsonObject[] = [];
    for (const raw of new Set(ids.map((item) => String(item)))) {
      try {
        const outcome = this.decide({ ...args, item_id: raw, decision });
        results.push({ item_id: raw, ok: true, item: outcome.item });
      } catch (error) {
        results.push({ item_id: raw, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { decision, results,
      succeeded: results.filter((item) => item.ok === true).length,
      failed: results.filter((item) => item.ok !== true).length };
  }
  private candidates(): Candidate[] {
    const result: Candidate[] = [];
    const add = (source: JsonObject, sourceKind: string, audience: Candidate["audience"], priority: number, reason: string, action: string, details: JsonObject) =>
      result.push({ id: `attention:${sourceKind}:${source.id}:${action}`, source_kind: sourceKind, source_id: String(source.id), source_version: Number(source.version),
        source_status: String(source.status), task_id: source.task_id === undefined ? null : String(source.task_id), audience, priority, reason, action, details });
    for (const item of this.store.list("recovery_item", 10_000, (entry) => entry.status === "open")) add(item, "recovery_item", "agent", Number(item.priority), "Recovery work is ready", String(item.action), { subject_kind: item.subject_kind, subject_id: item.subject_id });
    for (const request of this.store.list("autonomy_request", 10_000, (item) => item.status === "pending_approval")) add(request, "autonomy_request", "human", 95, "An action requires approval", "review_authorization", { action: request.action, target: request.target });
    for (const launch of this.store.list("work_launch", 10_000, (item) => item.status === "awaiting_approval")) add(launch, "work_launch", "human", 95, "A workspace-write launch requires approval", "review_work_launch", { host: launch.host, workspace: launch.workspace, sandbox: launch.sandbox });
    for (const launch of this.store.list("work_launch", 10_000, (item) => Boolean(item.acceptance_plan_id) && Boolean(item.run_id) && this.store.find("host_run", String(item.run_id))?.status === "completed" && !this.store.find("outcome", `outcome_${item.acceptance_trial_id}`))) add(launch, "work_launch", "human", 85, "Completed execution still requires business acceptance", "complete_acceptance", { plan_id: launch.acceptance_plan_id, host: launch.host, workspace: launch.workspace });
    for (const state of this.store.list("task_control_state", 10_000, (item) => item.actor === "human" && ["awaiting_approval", "awaiting_acceptance", "recovery", "blocked"].includes(String(item.status)) && (!item.launch_id || executionRootActive(this.store, this.store.get("work_launch", String(item.launch_id)))))) add(state, "task_control_state", "human", state.status === "blocked" ? 98 : state.status === "recovery" ? 92 : 88, "A controlled task needs an explicit next decision", String(state.action), { contract_id: state.contract_id, launch_id: state.launch_id, delivery_loop_id: state.delivery_loop_id });
    for (const state of this.store.list("task_run_state", 10_000, item => item.status === "rework_limit")) {
      if (!executionRootActive(this.store, this.store.get("work_launch", String(state.launch_id)))) continue;
      const run = this.store.find("task_run", String(state.task_run_id));
      const loop = this.store.find("delivery_loop", String(state.delivery_loop_id));
      if (run?.lifecycle === "active" && run.version === state.task_run_version && loop?.version === state.delivery_loop_version) add(state, "task_run_state", "human", 98, "Rework reached its three-retry limit; new evidence and replanning are required", "replan_with_evidence", { task_run_id: state.task_run_id, launch_id: state.launch_id });
    }
    for (const launch of this.store.list("work_launch", 10_000, item => Boolean(item.attempt_budget))) {
      if (!executionRootActive(this.store, launch)) continue;
      if (this.store.list("task_run", 1, item => item.launch_id === launch.id && item.lifecycle === "cancelled").length) continue;
      const run = launch.run_id ? this.store.find("host_run", String(launch.run_id)) : null;
      const loop = this.store.find("delivery_loop", `delivery_loop_${launch.id}`);
      if ((run && !["failed", "cancelled", "interrupted"].includes(String(run.status)) && loop?.action !== "retry_or_handoff") || this.store.list("work_launch", 1, item => item.retry_of === launch.id).length) continue;
      if (workAttemptBudget(this.store, launch)?.exhausted) add(launch, "work_launch", "human", 98, "这条尝试链的总时间或美元预算已耗尽", "replan_with_evidence", { launch_id: launch.id, budget: workAttemptBudget(this.store, launch) });
    }
    for (const job of this.store.list("acceptance_evaluation_job", 10_000, (item) => item.status === "exhausted")) add(job, "acceptance_evaluation_job", "operator", 90, "A domain acceptance evaluator exhausted its attempts", "inspect_acceptance_evaluator", { plan_id: job.plan_id, criterion_id: job.criterion_id, evaluator_id: job.evaluator_id, adapter_id: job.adapter_id });
    for (const component of this.store.list("maintenance_component", 10_000, (item) => ["degraded", "open"].includes(String(item.status)))) add(component, "maintenance_component", "operator", component.status === "open" ? 100 : 80, "A maintenance component is unhealthy", "inspect_maintenance", { next_retry_at: component.next_retry_at, failure_fingerprint: component.last_failure_fingerprint });
    for (const candidate of this.store.list("speculative_candidate", 10_000, (item) => item.status === "ready")) add(candidate, "speculative_candidate", "human", 60, "A read-only speculative result is ready", "review_speculative_candidate", { expires_at: candidate.expires_at });
    return result.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  }
}
