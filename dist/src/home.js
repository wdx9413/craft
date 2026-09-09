import { CraftStore } from "./store.js";
import { AttentionKernel } from "./attention.js";
function bounded(value) { const n = value === undefined ? 10 : Number(value); if (!Number.isInteger(n) || n < 1 || n > 50)
    throw new Error("limit must be an integer between 1 and 50"); return n; }
function instant(value) { const now = value === undefined ? new Date().toISOString() : String(value); if (Number.isNaN(Date.parse(now)))
    throw new Error("now must be an ISO timestamp"); return now; }
function pick(record, fields) { return Object.fromEntries(fields.filter((field) => record[field] !== undefined).map((field) => [field, record[field]])); }
function required(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
/** Read-only, UI-safe projection for the CLI home screen and future Canvas shell. */
export class HomeKernel {
    store;
    attention;
    constructor(store, attention = new AttentionKernel(store)) { this.store = store; this.attention = attention; }
    view(args = {}) {
        const now = instant(args.now);
        const limit = bounded(args.limit);
        const tasks = this.store.list("task", 10_000);
        const workspaces = this.store.list("workspace", 10_000);
        const attention = this.attention.list({ now, limit }).items;
        const runs = [
            ...this.store.list("runtime_run", 10_000).map((item) => ({ ...item, run_kind: "runtime" })),
            ...this.store.list("workflow_run", 10_000).map((item) => ({ ...item, run_kind: "workflow" })),
            ...this.store.list("orchestration_plan", 10_000).map((item) => ({ ...item, run_kind: "orchestration" })),
            ...this.store.list("host_run", 10_000).map((item) => ({ ...item, run_kind: "host" })),
        ];
        const activeRuns = runs.filter((item) => !["completed", "failed", "cancelled", "terminal"].includes(String(item.status)));
        const budgets = this.store.list("budget_account", 10_000, (item) => item.status === "active");
        const resources = budgets.map((item) => {
            const limits = item.limits;
            const used = item.used;
            const reserved = item.reserved;
            return { ...pick(item, ["id", "owner_type", "owner_id", "status"]), remaining: Object.fromEntries(Object.entries(limits).map(([key, value]) => [key, Number(value) - Number(used[key] ?? 0) - Number(reserved[key] ?? 0)])) };
        });
        const maintenance = this.store.find("maintenance_status", "local");
        return {
            generated_at: now,
            summary: { active_tasks: tasks.filter((item) => item.status === "active").length, workspaces: workspaces.length,
                attention: attention.length, active_runs: activeRuns.length, active_budgets: budgets.length,
                health: maintenance?.status ?? "not_started" },
            attention: attention.map((item) => pick(item, ["id", "audience", "priority", "reason", "action", "task_id", "source_kind", "source_id", "status", "deferred_until"])),
            work_launches: this.store.list("work_launch", limit).map((item) => ({ ...pick(item, ["id", "task_id", "host", "workspace", "sandbox", "status", "retry_of", "run_id", "acceptance_plan_id", "acceptance_trial_id", "updated_at"]),
                effective_status: item.run_id ? this.store.find("host_run", String(item.run_id))?.status ?? item.status : item.status,
                acceptance_status: item.acceptance_plan_id ? this.store.find("acceptance_assessment", `assessment_${item.acceptance_plan_id}`)?.status ?? "pending" : "not_configured" })),
            tasks: tasks.slice(0, limit).map((item) => pick(item, ["id", "title", "goal", "status", "updated_at"])),
            workspaces: workspaces.slice(0, limit).map((item) => ({ ...pick(item, ["id", "name", "root", "state_revision", "updated_at"]),
                object_count: this.store.list("work_object", 10_000, (object) => object.workspace_id === item.id).length })),
            runs: activeRuns.slice(0, limit).map((item) => pick(item, ["id", "run_kind", "task_id", "status", "current_stage", "updated_at"])),
            resources: resources.slice(0, limit),
            recent_outputs: this.store.list("artifact", limit).map((item) => pick(item, ["id", "task_id", "kind", "path", "uri", "description", "created_at"])),
            maintenance: maintenance ? pick(maintenance, ["status", "last_tick_at", "last_tick_id", "attention_count", "recovery_count", "invalidated_count"]) : null,
        };
    }
    hostRuns(args = {}) { const limit = bounded(args.limit); return { runs: this.store.list("host_run", limit).map((item) => pick(item, ["id", "host", "dispatch_id", "task_id", "owner_id", "status", "cancel_requested", "event_count", "started_at", "finished_at", "updated_at"])) }; }
    hostRun(args) { const runId = required(args.run_id, "run_id"); const after = args.after_sequence === undefined ? 0 : Number(args.after_sequence); if (!Number.isInteger(after) || after < 0)
        throw new Error("after_sequence must be a non-negative integer"); const limit = bounded(args.limit); const run = this.store.get("host_run", runId); const events = this.store.events(`host-run:${runId}`).filter((item) => Number(item.sequence) > after).slice(0, limit).map((item) => ({ ...pick(item, ["stream", "sequence", "event_type", "created_at"]), payload: pick(item.payload, ["stream", "bytes", "digest", "status", "receipt_id"]) })); return { run: pick(run, ["id", "host", "dispatch_id", "task_id", "owner_id", "status", "cancel_requested", "cancel_reason", "event_count", "receipt_id", "error_class", "started_at", "finished_at", "updated_at"]), events, next_sequence: events.length ? events.at(-1).sequence : after }; }
    task(args) {
        const taskId = required(args.task_id, "task_id");
        const task = this.store.get("task", taskId);
        const limit = bounded(args.limit);
        const trials = this.store.list("trial", 10_000, (item) => item.task_id === taskId);
        const trialIds = new Set(trials.map((item) => String(item.id)));
        const outcomes = this.store.list("outcome", 10_000, (item) => trialIds.has(String(item.trial_id)));
        const evidenceIds = new Set(outcomes.flatMap((item) => Array.isArray(item.evidence_ids) ? item.evidence_ids.map(String) : []));
        const traces = trials.flatMap((trial) => this.store.events(`trial:${trial.id}`));
        for (const event of traces) {
            const eventPayload = event.payload;
            for (const evidenceId of Array.isArray(eventPayload.evidence_ids) ? eventPayload.evidence_ids : [])
                evidenceIds.add(String(evidenceId));
        }
        const evidence = [...evidenceIds].map((id) => this.store.find("evidence", id)).filter((item) => item !== null);
        const artifactIds = new Set(evidence.flatMap((item) => item.artifact_id ? [String(item.artifact_id)] : []));
        for (const event of traces) {
            const eventPayload = event.payload;
            for (const artifactId of Array.isArray(eventPayload.artifact_ids) ? eventPayload.artifact_ids : [])
                artifactIds.add(String(artifactId));
        }
        const artifacts = [...artifactIds].map((id) => this.store.find("artifact", id)).filter((item) => item !== null);
        const runs = ["runtime_run", "workflow_run", "orchestration_plan"].flatMap((kind) => this.store.list(kind, 10_000, (item) => item.task_id === taskId).map((item) => ({ ...item, run_kind: kind })));
        return { task: pick(task, ["id", "title", "goal", "project_id", "status", "created_at", "updated_at"]),
            checkpoints: this.store.list("checkpoint", limit, (item) => item.task_id === taskId).map((item) => pick(item, ["id", "summary", "completed", "pending", "decisions", "status", "created_at"])),
            feedback: this.store.list("feedback", limit, (item) => item.task_id === taskId).map((item) => pick(item, ["id", "kind", "original", "corrected", "source", "created_at"])),
            runs: runs.slice(0, limit).map((item) => pick(item, ["id", "run_kind", "status", "current_stage", "updated_at"])),
            trials: trials.slice(0, limit).map((item) => pick(item, ["id", "subject_type", "subject_id", "subject_version", "status", "created_at"])),
            outcomes: outcomes.slice(0, limit).map((item) => pick(item, ["id", "trial_id", "verdict", "summary", "failure_type", "scores", "costs", "created_at"])),
            evidence: evidence.slice(0, limit).map((item) => pick(item, ["id", "source_type", "claim", "confidence", "artifact_id", "locator", "observed_at"])),
            artifacts: artifacts.slice(0, limit).map((item) => pick(item, ["id", "kind", "name", "uri", "media_type", "digest", "created_at"])),
            lineage: this.store.list("lineage_edge", limit, (item) => item.task_id === taskId).map((item) => pick(item, ["id", "workspace_id", "output", "inputs", "transform", "actor_type", "summary", "evidence_ids"])),
            waits: this.store.list("durable_wait", limit, (item) => item.task_id === taskId).map((item) => pick(item, ["id", "condition", "status", "resume_at", "event_key", "updated_at"])),
            attention: this.store.list("attention_item", limit, (item) => item.task_id === taskId && item.status !== "resolved").map((item) => pick(item, ["id", "audience", "priority", "reason", "action", "status"])),
            trace: traces.slice(0, limit).map((item) => pick(item, ["stream", "sequence", "event_type", "created_at"])) };
    }
}
//# sourceMappingURL=home.js.map