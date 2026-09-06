import { randomUUID } from "node:crypto";
import { Catalog } from "./catalog.js";
import { CraftStore } from "./store.js";
import { approvedEffects, executeSteps, normalizeSteps, resolveInputs, substitute } from "./workflow.js";
import { dispatchNodes, normalizeNodes, planStatus, submitNode } from "./orchestration.js";
export const VERSION = "0.2.0";
const CONFIDENCE = new Set(["confirmed", "bounded", "unverified", "rejected"]);
const TASK_STATUS = new Set(["active", "paused", "completed", "cancelled"]);
function id(prefix) { return `${prefix}_${randomUUID().replaceAll("-", "")}`; }
function text(value, name) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${name} must not be empty`);
    return value.trim();
}
export class CraftService {
    store;
    catalog;
    constructor(store) { this.store = store; this.catalog = new Catalog(store); }
    info() {
        const kinds = ["source", "capability", "task", "checkpoint", "feedback", "artifact",
            "evidence", "workflow", "evaluation_suite", "evaluation_run", "evaluation_result",
            "agent_profile", "orchestration_plan", "budget", "model_provider", "agent_session"];
        return { version: VERSION, data_root: this.store.paths.root,
            counts: Object.fromEntries(kinds.map((kind) => [kind, this.store.list(kind, Number.MAX_SAFE_INTEGER).length])) };
    }
    sourceAdd(args) {
        return this.catalog.addSource(text(args.path, "path"), args.label, args.scan === undefined ? true : Boolean(args.scan));
    }
    sourceList() { return { sources: this.catalog.listSources() }; }
    sourceUpdate(args) {
        return this.catalog.updateSource(text(args.source_id, "source_id"), args.enabled, args.label);
    }
    sourceRemove(args) {
        return this.catalog.removeSource(text(args.source_id, "source_id"));
    }
    sourceScan(args) {
        return this.catalog.scan(args.source_id);
    }
    capabilitySearch(args) {
        return { capabilities: this.catalog.search(text(args.query, "query"), Number(args.limit ?? 6)) };
    }
    capabilityGet(args) {
        return this.catalog.get(text(args.asset_id, "asset_id"));
    }
    taskOpen(args) {
        if (args.task_id)
            return this.taskPack(String(args.task_id));
        const taskId = id("task");
        this.store.save("task", taskId, { title: text(args.title, "title"), goal: text(args.goal, "goal"),
            project_id: args.project_id ?? null, status: "active" });
        return this.taskPack(taskId);
    }
    taskList(args) {
        const status = args.status;
        if (status !== undefined && !TASK_STATUS.has(status))
            throw new Error(`Unsupported task status: ${status}`);
        return { tasks: this.store.list("task", Number(args.limit ?? 10), (item) => (status === undefined || item.status === status) &&
                (args.project_id === undefined || item.project_id === args.project_id)) };
    }
    taskCheckpoint(args) {
        const taskId = text(args.task_id, "task_id");
        const task = this.store.get("task", taskId);
        const status = String(args.status ?? task.status);
        if (!TASK_STATUS.has(status))
            throw new Error(`Unsupported task status: ${status}`);
        const checkpoint = this.store.save("checkpoint", id("checkpoint"), {
            task_id: taskId, summary: text(args.summary, "summary"), completed: args.completed ?? [],
            pending: args.pending ?? [], decisions: args.decisions ?? [], artifacts: args.artifacts ?? [],
            source: args.source ?? "agent_reported"
        });
        this.store.save("task", taskId, { ...task, status, latest_checkpoint_id: checkpoint.id });
        return this.taskPack(taskId);
    }
    taskPack(taskId) {
        return { task: this.store.get("task", taskId), checkpoints: this.store.list("checkpoint", 100, (item) => item.task_id === taskId), feedback: this.store.list("feedback", 100, (item) => item.task_id === taskId) };
    }
    feedbackRecord(args) {
        const scope = String(args.scope ?? "task");
        if (!new Set(["task", "project", "user"]).has(scope))
            throw new Error(`Unsupported feedback scope: ${scope}`);
        if (scope === "task" && !args.task_id)
            throw new Error("task_id is required for task feedback");
        return this.store.save("feedback", id("feedback"), { corrected: text(args.corrected, "corrected"),
            original: args.original ?? null, kind: args.kind ?? "correction", scope,
            task_id: args.task_id ?? null, applies_to: args.applies_to ?? null,
            source: args.source ?? "user_explicit" });
    }
    artifactRegister(args) {
        return this.store.save("artifact", String(args.artifact_id ?? id("artifact")), {
            kind: text(args.kind, "kind"), name: text(args.name, "name"), uri: text(args.uri, "uri"),
            media_type: args.media_type ?? null, digest: args.digest ?? null, size_bytes: args.size_bytes ?? null,
            producer_type: args.producer_type ?? null, producer_id: args.producer_id ?? null,
            metadata: args.metadata ?? {}
        });
    }
    evidenceRecord(args) {
        const confidence = String(args.confidence ?? "unverified");
        if (!CONFIDENCE.has(confidence))
            throw new Error(`Unsupported confidence: ${confidence}`);
        if (args.artifact_id)
            this.store.get("artifact", String(args.artifact_id));
        return this.store.save("evidence", String(args.evidence_id ?? id("evidence")), {
            source_type: text(args.source_type, "source_type"), claim: text(args.claim, "claim"), confidence,
            artifact_id: args.artifact_id ?? null, locator: args.locator ?? null,
            observed_at: args.observed_at ?? new Date().toISOString(), metadata: args.metadata ?? {}
        });
    }
    saveVersioned(kind, prefix, args, required) {
        for (const key of required)
            text(args[key], key);
        const recordId = String(args[`${prefix}_id`] ?? id(prefix));
        return this.store.save(kind, recordId, args);
    }
    list(kind, key, args) {
        const query = String(args.query ?? "").toLowerCase();
        return { [key]: this.store.list(kind, Number(args.limit ?? 20), (item) => !query || JSON.stringify(item).toLowerCase().includes(query)) };
    }
    get(kind, idKey, args) {
        return this.store.get(kind, text(args[idKey], idKey), args.version);
    }
    workflowPlan(args) {
        const workflow = this.get("workflow", "workflow_id", args);
        const inputs = resolveInputs((workflow.inputs ?? []), (args.inputs ?? {}));
        const steps = normalizeSteps(substitute(workflow.steps ?? [], inputs));
        const approved = approvedEffects(Boolean(args.allow_execution), (args.approved_side_effects ?? []));
        return { workflow_id: workflow.id, workflow_version: workflow.version, inputs, steps,
            approved_side_effects: [...approved], executable: steps.every((step) => approved.has(String(step.side_effect))) };
    }
    workflowRun(args) {
        const plan = this.workflowPlan(args);
        const root = text(args.project_root, "project_root");
        const results = executeSteps(plan.steps, root, new Set(plan.approved_side_effects));
        const passed = results.length === plan.steps.length && results.every((item) => item.passed);
        return this.store.save("workflow_run", id("run"), { workflow_id: plan.workflow_id,
            workflow_version: plan.workflow_version, project_root: root, inputs: plan.inputs, results,
            status: passed ? "passed" : "failed" });
    }
    orchestrationCreate(args) {
        const nodes = normalizeNodes((args.nodes ?? []));
        const max = Number(args.max_concurrency ?? 4);
        if (!Number.isInteger(max) || max < 1 || max > 32)
            throw new Error("max_concurrency must be between 1 and 32");
        return this.store.save("orchestration_plan", id("plan"), { goal: text(args.goal, "goal"),
            task_id: args.task_id ?? null, max_concurrency: max, status: "running", nodes, policy: args.policy ?? {} });
    }
    orchestrationDispatch(args) {
        const plan = this.get("orchestration_plan", "plan_id", args);
        if (plan.status !== "running")
            throw new Error(`Plan is not running: ${plan.status}`);
        const owner = text(args.claimed_by, "claimed_by");
        const capacity = Math.max(1, Math.min(Number(args.capacity ?? plan.max_concurrency), Number(plan.max_concurrency)));
        const result = dispatchNodes(plan.nodes, capacity, owner);
        const saved = this.store.save("orchestration_plan", String(plan.id), { ...plan, nodes: result.nodes,
            status: planStatus(result.nodes) });
        return { plan: saved, leases: result.leases };
    }
    orchestrationSubmit(args) {
        const plan = this.get("orchestration_plan", "plan_id", args);
        const nodes = submitNode(plan.nodes, text(args.lease_id, "lease_id"), text(args.verdict, "verdict"), String(args.provenance ?? "agent_reported"));
        return this.store.save("orchestration_plan", String(plan.id), { ...plan, nodes, status: planStatus(nodes) });
    }
}
//# sourceMappingURL=service.js.map