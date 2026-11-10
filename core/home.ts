import { reviewVerificationProjection } from "./work-review-verification.ts";
import { digestJson } from "./digest.ts";
import { executionRootActive } from "./task-execution-fence.ts";
import { workAttemptBudget } from "./work-attempt-budget.ts";
import { workRetryPolicy } from "./work-retry-policy.ts";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { AttentionKernel } from "./attention.ts";
import { projectPilotRelease, type PilotTaskResult } from "./pilot-results.ts";
import { contextFeedbackWeights } from "./context-feedback-weight.ts";

function bounded(value: unknown): number { const n = value === undefined ? 10 : Number(value); if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error("limit must be an integer between 1 and 50"); return n; }
function instant(value: unknown): string { const now = value === undefined ? new Date().toISOString() : String(value); if (Number.isNaN(Date.parse(now))) throw new Error("now must be an ISO timestamp"); return now; }
function pick(record: JsonObject, fields: string[]): JsonObject { return Object.fromEntries(fields.filter((field) => record[field] !== undefined).map((field) => [field, record[field]])); }
function required(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }

/** Console task states; the labels are the only user-facing wording. */
const STATE_LABELS: Readonly<Record<string, string>> = {
  queued: "排队", running: "运行", awaiting_approval: "待批准", awaiting_input: "待输入",
  completed: "完成", failed: "失败", unknown: "未知",
};

/** Read-only, UI-safe projection for the CLI home screen and future Canvas shell. */
export class HomeKernel {
  readonly store: CraftStore; readonly attention: AttentionKernel;
  constructor(store: CraftStore, attention = new AttentionKernel(store)) { this.store = store; this.attention = attention; }

  view(args: JsonObject = {}): JsonObject {
    const now = instant(args.now); const limit = bounded(args.limit);
    const tasks = this.store.list("task", 10_000); const workspaces = this.store.list("workspace", 10_000);
    const attention = this.attention.list({ now, limit }).items as JsonObject[];
    const runs: JsonObject[] = [
      ...this.store.list("runtime_run", 10_000).map((item) => ({ ...item, run_kind: "runtime" })),
      ...this.store.list("workflow_run", 10_000).map((item) => ({ ...item, run_kind: "workflow" })),
      ...this.store.list("orchestration_plan", 10_000).map((item) => ({ ...item, run_kind: "orchestration" })),
      ...this.store.list("host_run", 10_000).map((item) => ({ ...item, run_kind: "host" })),
    ];
    const activeRuns = runs.filter((item) => !["completed", "failed", "cancelled", "terminal"].includes(String(item.status)));
    const budgets = this.store.list("budget_account", 10_000, (item) => item.status === "active");
    const resources = budgets.map((item) => { const limits = item.limits as JsonObject; const used = item.used as JsonObject; const reserved = item.reserved as JsonObject;
      return { ...pick(item, ["id", "owner_type", "owner_id", "status"]), remaining: Object.fromEntries(Object.entries(limits).map(([key, value]) =>
        [key, Number(value) - Number(used[key] ?? 0) - Number(reserved[key] ?? 0)])) }; });
    const maintenance = this.store.find("maintenance_status", "local");
    return {
      generated_at: now,
      summary: { active_tasks: tasks.filter((item) => item.status === "active").length, workspaces: workspaces.length,
        attention: attention.length, active_runs: activeRuns.length, active_budgets: budgets.length,
        active_task_controls: this.store.list("task_control_contract", 10_000, (item) => item.status === "active").length,
        active_task_runs: this.store.list("task_run", 10_000, (item) => item.lifecycle === "active").length, health: maintenance?.status ?? "not_started" },
      attention: attention.map((item) => pick(item, ["id", "audience", "priority", "reason", "action", "task_id", "source_kind", "source_id", "status", "deferred_until"])),
      work_launches: this.store.list("work_launch", limit).map((item) => { const loop = this.store.find("delivery_loop", `delivery_loop_${item.id}`); return { ...pick(item, ["id", "task_id", "host", "workspace", "sandbox", "status", "retry_of", "run_id", "acceptance_plan_id", "acceptance_trial_id", "knowledge_binding", "updated_at"]),
        effective_status: item.run_id ? this.store.find("host_run", String(item.run_id))?.status ?? item.status : item.status,
        acceptance_status: item.acceptance_plan_id ? this.store.find("acceptance_assessment", `assessment_${item.acceptance_plan_id}`)?.status ?? "pending" : "not_configured", delivery_status: loop?.delivery_status ?? "not_materialized", delivery_action: loop?.action ?? "refresh_delivery_loop" }; }),
      task_controls: this.store.list("task_control_contract", limit).map((item) => { const state = this.store.find("task_control_state", `task_control_state_${item.id}`); return { ...pick(item, ["id", "task_id", "workspace", "allowed_effects", "acceptance_required", "launch_id", "updated_at"]), status: state?.status ?? "not_refreshed", action: state?.action ?? "refresh_task_control", actor: state?.actor ?? "host" }; }),
      task_runs: this.store.list("task_run", limit).map((item) => { const state = this.store.find("task_run_state", `task_run_state_${item.id}`); return { ...pick(item, ["id", "contract_id", "launch_id", "lifecycle", "updated_at"]), status: state?.status ?? "not_refreshed", action: state?.action ?? "refresh_task_run", actor: state?.actor ?? "host" }; }),
      tasks: tasks.slice(0, limit).map((item) => pick(item, ["id", "title", "goal", "project_id", "workspace_id", "status", "updated_at"])),
      workspaces: workspaces.slice(0, limit).map((item) => ({ ...pick(item, ["id", "name", "root", "state_revision", "updated_at"]),
        root_path: item.root_path ?? null,
        workspace_kind: item.workspace_kind ?? "repository",
        object_count: this.store.list("work_object", 10_000, (object) => object.workspace_id === item.id).length })),
      runs: activeRuns.slice(0, limit).map((item) => pick(item, ["id", "run_kind", "task_id", "status", "current_stage", "updated_at"])),
      resources: resources.slice(0, limit),
      recent_outputs: this.store.list("artifact", limit).map((item) => pick(item, ["id", "task_id", "kind", "path", "uri", "description", "created_at"])),
      maintenance: maintenance ? pick(maintenance, ["status", "last_tick_at", "last_tick_id", "attention_count", "recovery_count", "invalidated_count"]) : null,
    };
  }

  hostRuns(args: JsonObject = {}): JsonObject { const limit = bounded(args.limit); return { runs: this.store.list("host_run", limit).map((item) => pick(item, ["id", "host", "dispatch_id", "task_id", "owner_id", "status", "cancel_requested", "event_count", "started_at", "finished_at", "updated_at"])) }; }

  /**
   * Console board: group tasks by the plan's seven states using authoritative
   * records (task status, work launch, control state, agent turn, durable queue,
   * failed outcomes). Idle active tasks are reported as waiting for input, not
   * silently dropped.
   */
  taskBoard(args: JsonObject = {}): JsonObject {
    const limit = bounded(args.limit);
    const tasks = this.store.list("task", 10_000).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, limit);
    const links = this.store.list("workbench_agent_session_link", 10_000);
    const launches = this.store.list("work_launch", 10_000);
    const controls = this.store.list("task_control_state", 10_000);
    const queuedMessages = this.store.list("workbench_message_queue", 10_000, (item) => item.state === "queued");
    const trialTask = new Map(this.store.list("trial", 10_000).map((item) => [String(item.id), String(item.task_id)]));
    const failedTasks = new Set(this.store.list("outcome", 10_000)
      .filter((item) => String(item.verdict) === "failed")
      .map((item) => trialTask.get(String(item.trial_id)))
      .filter((value): value is string => typeof value === "string"));
    // Release gate facts, keyed by task, so the cockpit can show where a
    // delivered task stands before it can be reused. Only tasks with an
    // evaluation run carry a gate; everything else stays "not applicable".
    const evalRuns = this.store.list("evaluation_run", 10_000, (item) => String(item.subject_type) === "task");
    const signoffs = this.store.list("signoff", 10_000, (item) => String(item.subject_type) === "pilot_delivery");
    const canaries = this.store.list("canary", 10_000);
    const publications = this.store.list("skill_publication", 10_000);
    const gateFor = (taskId: string) => {
      const run = evalRuns.find((item) => String(item.subject_id) === taskId) ?? null;
      if (!run) return null;
      const signoff = signoffs.find((item) => String(item.subject_id) === taskId) ?? null;
      const canary = canaries.find((item) => String(item.candidate_id) === taskId) ?? null;
      const publication = publications.find((item) =>
        String(item.subject_id ?? item.candidate_id ?? item.proposal_id) === taskId) ?? null;
      // A gate only exists for delivered tasks; the board does not re-prove the
      // delivery verdict here, it only projects the governance chain.
      const result = { task_id: taskId, verdict: "passed" } as PilotTaskResult;
      return projectPilotRelease(result, run, signoff, canary, publication);
    };
    const by = <T extends JsonObject>(rows: T[], taskId: string, key = "task_id") => rows.filter((row) => String(row[key]) === taskId);
    const stateFor = (task: JsonObject): { state: string; reason: string } => {
      const id = String(task.id);
      const taskLinks = by(links, id);
      if (taskLinks.some((link) => String(link.turn_state) === "unknown")) return { state: "unknown", reason: "原生会话回合结果未知，需人工核对" };
      if (by(launches, id).some((launch) => String(launch.status) === "running")
        || taskLinks.some((link) => ["starting", "running"].includes(String(link.turn_state)))) return { state: "running", reason: "正在执行" };
      if (by(launches, id).some((launch) => String(launch.status) === "awaiting_approval")
        || by(controls, id).some((state) => String(state.status) === "awaiting_approval")) return { state: "awaiting_approval", reason: "等待人工批准" };
      if (by(controls, id).some((state) => String(state.status) === "awaiting_acceptance")) return { state: "awaiting_input", reason: "等待验收或补充输入" };
      if (queuedMessages.some((item) => String(item.task_id) === id)
        || by(launches, id).some((launch) => String(launch.status) === "prepared")) return { state: "queued", reason: "已排队，等待调度" };
      if (String(task.status) === "failed" || failedTasks.has(id) || by(launches, id).some((launch) => String(launch.status) === "denied")) {
        return { state: "failed", reason: "执行失败或被拒绝" };
      }
      if (String(task.status) === "completed") return { state: "completed", reason: "任务已完成" };
      return { state: "awaiting_input", reason: "等待下一步输入" };
    };
    const buckets: Record<string, JsonObject[]> = { queued: [], running: [], awaiting_approval: [], awaiting_input: [], completed: [], failed: [], unknown: [] };
    const rows = tasks.map((task) => {
      const { state, reason } = stateFor(task);
      // Every state above has a bucket and a label, so no fallback is needed.
      const release = gateFor(String(task.id));
      const row = { ...pick(task, ["id", "title", "goal", "project_id", "workspace_id", "status", "updated_at"]),
        state, reason, state_label: STATE_LABELS[state], ...(release ? { release } : {}) };
      buckets[state]!.push(row);
      return row;
    });
    return { order: ["running", "awaiting_approval", "awaiting_input", "queued", "failed", "unknown", "completed"],
      labels: STATE_LABELS, buckets, tasks: rows };
  }

  hostRun(args: JsonObject): JsonObject { const runId = required(args.run_id, "run_id"); const after = args.after_sequence === undefined ? 0 : Number(args.after_sequence); if (!Number.isInteger(after) || after < 0) throw new Error("after_sequence must be a non-negative integer"); const limit = bounded(args.limit); const run = this.store.get("host_run", runId); const events: JsonObject[] = this.store.events(`host-run:${runId}`).filter((item) => Number(item.sequence) > after).slice(0, limit).map((item) => ({ ...pick(item, ["stream", "sequence", "event_type", "created_at"]), payload: pick(item.payload as JsonObject, ["stream", "bytes", "digest", "status", "receipt_id"]) })); return { run: pick(run, ["id", "host", "dispatch_id", "task_id", "owner_id", "status", "cancel_requested", "cancel_reason", "event_count", "receipt_id", "error_class", "started_at", "finished_at", "updated_at"]), events, next_sequence: events.length ? events.at(-1)!.sequence : after }; }

  task(args: JsonObject): JsonObject {
    const taskId = required(args.task_id, "task_id"); const task = this.store.get("task", taskId); const limit = bounded(args.limit);
    const trials = this.store.list("trial", 10_000, (item) => item.task_id === taskId); const trialIds = new Set(trials.map((item) => String(item.id)));
    const outcomes = this.store.list("outcome", 10_000, (item) => trialIds.has(String(item.trial_id)));
    const evidenceIds = new Set(outcomes.flatMap((item) => Array.isArray(item.evidence_ids) ? item.evidence_ids.map(String) : []));
    const modelDispatches = this.store.list("internal_dispatch", 10_000, item => item.task_id === taskId);
    const modelDispatchById = new Map(modelDispatches.map(item => [String(item.id), item]));
    const modelBudgetDispatch = new Map(modelDispatches.filter(item => ["completed", "failed"].includes(String(item.status)) || (item.status === "interrupted" && item.stopped_host_run_id)).map(item => [`internal_budget_${item.id}`, item]));
    const reconciliations = this.store.list("model_cost_reconciliation", limit, item => modelDispatchById.has(String(item.dispatch_id)));
    for (const item of reconciliations) evidenceIds.add(String(item.evidence_id));

    const traces = trials.flatMap((trial) => this.store.events(`trial:${trial.id}`));
    for (const event of traces) { const eventPayload = event.payload as JsonObject; for (const evidenceId of Array.isArray(eventPayload.evidence_ids) ? eventPayload.evidence_ids : []) evidenceIds.add(String(evidenceId)); }
    const evidence = [...evidenceIds].map((id) => this.store.find("evidence", id)).filter((item): item is JsonObject => item !== null);
    const artifactIds = new Set(evidence.flatMap((item) => item.artifact_id ? [String(item.artifact_id)] : []));
    for (const event of traces) { const eventPayload = event.payload as JsonObject; for (const artifactId of Array.isArray(eventPayload.artifact_ids) ? eventPayload.artifact_ids : []) artifactIds.add(String(artifactId)); }
    const artifacts = [...artifactIds].map((id) => this.store.find("artifact", id)).filter((item): item is JsonObject => item !== null);
    const runs = ["runtime_run", "workflow_run", "orchestration_plan"].flatMap((kind) => this.store.list(kind, 10_000, (item) => item.task_id === taskId).map((item) => ({ ...item, run_kind: kind })));
    const taskEvents = this.store.events(`task:${taskId}`);
    const taskRuns = this.store.list("task_run", 10_000, (item) => (item.launch_identity as JsonObject | undefined)?.task_id === taskId);
    const pendingWorkLaunches = this.store.list("work_launch", limit, (item) => item.task_id === taskId && item.status === "awaiting_approval").flatMap((launch) => {
      const run = taskRuns.find((item) => item.launch_id === launch.id);
      return run ? [{ launch_id: launch.id, launch_version: launch.version, task_id: taskId,
        task_run_id: run.id, task_run_version: run.version, status: launch.status }] : [];
    });
    const taskRunIds = new Set(taskRuns.map(item => String(item.id)));
    const handoffs = this.store.list("task_run_handoff", limit, (item) => taskRunIds.has(String(item.task_run_id)));
    const hostRuns = this.store.list("host_run", limit, (item) => item.task_id === taskId);
    const messages = this.store.list("task_message", limit, (item) => item.task_id === taskId)
      .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
    const hostEvents = hostRuns.flatMap((run) => this.store.events(`host-run:${run.id}`).map((event) => ({ run_id: run.id, ...event })));
    const activity: JsonObject[] = [...taskEvents, ...hostEvents].map((item) => item as JsonObject)
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
    // These projections deliberately stay task-scoped.  Studio uses them for a
    // historical task's Context view, so opening one task can never make
    // another task's notes or workflow runs appear by accident.
    const memories = this.store.list("memory_item", limit, (item) => item.task_id === taskId && item.status !== "superseded" && item.status !== "expired");
    const workflowRuns = this.store.list("workflow_run", limit, (item) => item.task_id === taskId);
    const workflowIds = new Set(workflowRuns.map((item) => String(item.workflow_id)).filter(Boolean));
    const workflows = [...workflowIds].map((workflowId) => this.store.find("workflow", workflowId)).filter((item): item is JsonObject => item !== null);
    const knowledge = this.store.list("knowledge_claim", limit, (item) => item.task_id === taskId || item.scope === `task:${taskId}`);
    const contextManifests = this.store.list("context_manifest", limit, (item) => item.task_id === taskId);
    return { task: pick(task, ["id", "version", "title", "goal", "project_id", "workspace_id", "model_id", "permission_mode", "status", "created_at", "updated_at"]),
      messages: messages.map((item) => pick(item, ["id", "role", "content", "model_id", "provider_model", "usage", "created_at"])),
      host_runs: hostRuns.map((item) => pick(item, ["id", "version", "host", "status", "cleanup_unconfirmed", "stopped_confirmation", "error_class", "event_count", "started_at", "finished_at", "updated_at"])),
      activity: activity.slice(0, limit).map((item) => pick(item, ["run_id", "stream", "sequence", "event_type", "created_at"])),
      checkpoints: this.store.list("checkpoint", limit, (item) => item.task_id === taskId).map((item) => pick(item, ["id", "summary", "completed", "pending", "decisions", "status", "created_at"])),
      feedback: this.store.list("feedback", limit, (item) => item.task_id === taskId).map((item) => pick(item, ["id", "kind", "original", "corrected", "source", "created_at"])),
      runs: runs.slice(0, limit).map((item) => pick(item, ["id", "run_kind", "status", "current_stage", "updated_at"])),
      trials: trials.slice(0, limit).map((item) => pick(item, ["id", "subject_type", "subject_id", "subject_version", "status", "created_at"])),
      outcomes: outcomes.slice(0, limit).map((item) => pick(item, ["id", "trial_id", "verdict", "summary", "failure_type", "scores", "costs", "created_at"])),
      evidence: evidence.slice(0, limit).map((item) => pick(item, ["id", "source_type", "claim", "confidence", "artifact_id", "locator", "observed_at"])),
      artifacts: artifacts.slice(0, limit).map((item) => pick(item, ["id", "version", "kind", "name", "uri", "media_type", "digest", "created_at"])),
      lineage: this.store.list("lineage_edge", limit, (item) => item.task_id === taskId).map((item) => pick(item, ["id", "workspace_id", "output", "inputs", "transform", "actor_type", "summary", "evidence_ids"])),
      waits: this.store.list("durable_wait", limit, (item) => item.task_id === taskId).map((item) => pick(item, ["id", "condition", "status", "resume_at", "event_key", "updated_at"])),
      task_runs: taskRuns.slice(0, limit).map((item) => ({ ...pick(item, ["id", "version", "lifecycle", "launch_id", "updated_at"]), execution_root_active: executionRootActive(this.store, this.store.get("work_launch", String(item.launch_id))), review_risk: this.store.get("work_launch", String(item.launch_id)).review_risk ?? null, review_verification: this.store.get("work_launch", String(item.launch_id)).review_verification ?? null, retry_policy: workRetryPolicy(this.store, this.store.get("work_launch", String(item.launch_id))), attempt_budget: workAttemptBudget(this.store, this.store.get("work_launch", String(item.launch_id))) })),
      pending_work_launches: pendingWorkLaunches,
      acceptance_plans: this.store.list("acceptance_plan", limit, item => item.task_id === taskId).map(plan => {
        const assessment = this.store.find("acceptance_assessment", `assessment_${plan.id}`);
        const receipts = this.store.list("acceptance_evaluation_job", limit, item => item.plan_id === plan.id && item.plan_version === plan.version && item.status === "completed").map(item => ({ job_id: item.id, receipt: item.receipt == null ? null : pick(item.receipt as JsonObject, ["check", "report_path", "source_sha256", "source_bytes", "sha256", "size_bytes"]) }));
        return { ...pick(plan, ["id", "version", "name", "launch_id"]), status: assessment && assessment.plan_version === plan.version ? assessment.status : "pending", receipts, human_criteria: ((plan.criteria ?? []) as JsonObject[]).filter(item => item.method === "human").map(item => ({ ...pick(item, ["id", "name"]), frozen_review_required: this.store.list("work_review_policy", 1, policy => policy.plan_id === plan.id && policy.criterion_id === item.id).length > 0 })) };
      }),
      model_cost_holds: this.store.list("budget_reservation", limit, item => item.status === "reserved" && modelBudgetDispatch.has(String(item.budget_id))).map(item => {
        const dispatch = modelBudgetDispatch.get(String(item.budget_id))!;
        return { dispatch_id: dispatch.id, dispatch_version: dispatch.version, model: dispatch.model, reservation_id: item.id, reservation_version: item.version, reserved_usd: (item.resources as JsonObject).usd };
      }),
      model_cost_reconciliations: reconciliations.map(item => ({ ...pick(item, ["id", "dispatch_id", "reservation_id", "actual_usd", "reserved_usd", "confirmed_overrun", "actor", "basis", "billing_reference_digest", "evidence_id", "created_at"]), billing_reference: this.store.find("evidence", String(item.evidence_id), Number(item.evidence_version))?.locator ?? null })),
      work_reviews: this.store.list("work_review_candidate", limit, item => item.task_id === taskId).map(item => {
        const verification = this.store.find("work_review_verification", `review_verification_${digestJson(item.id).slice(7)}`);
        return { ...item, report: this.store.find("work_review_report", `work_review_report_${item.id}`), verification: verification ? reviewVerificationProjection(this.store, verification) : null, verification_configuration: this.store.get("work_launch", String(item.launch_id)).review_verification ?? null };
      }),
      task_replans: this.store.list("task_replan_proposal", limit, item => item.task_id === taskId),
      execution_fence: this.store.find("task_execution_fence", `task_execution_fence_${taskId}`),
      task_assignment: this.store.find("task_assignment", `task_assignment_${taskId}`),
      task_retries: this.store.list("task_run_retry", limit, item => taskRunIds.has(String(item.task_run_id))).map(item => pick(item, ["id", "task_run_id", "new_task_run_id", "launch_id", "actor", "created_at"])),
      task_handoffs: handoffs.map((item) => pick(item, ["id", "version", "task_run_id", "task_run_version", "state_id", "state_version", "state_status", "next_actor", "resume_action", "reason", "task_ref", "assignment_ref", "launch_ref", "host_run_ref", "missing_host_run_id", "unlinked_host_run_refs", "acceptance_plan_ref", "created_at"])),
      attention: this.store.list("attention_item", limit, (item) => item.task_id === taskId && item.status !== "resolved").map((item) => pick(item, ["id", "audience", "priority", "reason", "action", "status"])),
      trace: traces.slice(0, limit).map((item) => pick(item, ["stream", "sequence", "event_type", "created_at"])),
      context: {
        memories: memories.map((item) => pick(item, ["id", "kind", "content", "source", "scope", "applies_to", "status", "valid_until", "updated_at"])),
        knowledge: knowledge.map((item) => pick(item, ["id", "kind", "content", "status", "scope", "source", "updated_at"])),
        workflows: workflows.map((item) => pick(item, ["id", "name", "description", "status", "updated_at"])),
        workflow_runs: workflowRuns.map((item) => pick(item, ["id", "workflow_id", "status", "started_at", "finished_at", "updated_at"])),
        manifests: contextManifests.map((item) => pick(item, ["id", "summary", "status", "created_at", "updated_at"]))
      } };
  }

  /**
   * What this task actually pulled into context, with the same weight the recall
   * path ranked by. Read-only: bodies stay behind their records; only refs and
   * governance numbers are exposed.
   */
  contextUsage(args: JsonObject): JsonObject {
    const taskId = required(args.task_id, "task_id");
    const workingSets = this.store.list("context_working_set_receipt", 10_000, (item) => String(item.task_id) === taskId)
      .sort((left, right) => String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")));
    const assetRefs = [...new Map(workingSets.flatMap((item) => Array.isArray(item.asset_refs) ? item.asset_refs as JsonObject[] : [])
      .filter((ref) => ref && typeof ref.id === "string" && ["memory", "knowledge", "experience"].includes(String(ref.member)))
      .map((ref) => [`${String(ref.member)}:${String(ref.id)}`, ref])).values()];
    const weights: Record<string, { weight: number; positive: number; negative: number }> = {};
    for (const member of ["memory", "knowledge", "experience"] as const) {
      const ids = assetRefs.filter((ref) => String(ref.member) === member).map((ref) => String(ref.id));
      for (const [id, value] of contextFeedbackWeights(this.store, member, ids)) weights[`${member}:${id}`] = {
        weight: value.weight, positive: value.positive, negative: value.negative };
    }
    const assets = assetRefs.map((ref) => {
      const key = `${String(ref.member)}:${String(ref.id)}`;
      const weight = weights[key];
      return { member: String(ref.member), id: String(ref.id), version: Number(ref.version ?? 1),
        recall_weight: weight?.weight ?? 1, helpful_signals: weight?.positive ?? 0, pending_corrections: weight?.negative ?? 0 };
    });
    return { task_id: taskId, working_sets: workingSets.slice(0, 10).map((item) => ({ id: item.id,
      created_at: item.created_at ?? null, source_receipt_id: item.source_receipt_id ?? null })),
      assets, counts: { working_sets: workingSets.length, assets: assets.length } };
  }
}
