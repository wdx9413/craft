import { createHash } from "node:crypto";
import { CraftStore } from "./store.js";
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function payload(record) { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
function current(store, kind, id) { return store.get(kind, text(id, `${kind}_id`)); }
/**
 * A small, durable seam over one already-prepared Work Launch. It never plans
 * model work or dispatches an unapproved effect; it turns observed facts into a
 * resumable task-level state and keeps the exact launch contract auditable.
 */
export class TaskRunKernel {
    store;
    constructor(store) { this.store = store; }
    create(args) {
        const contract = current(this.store, "task_control_contract", args.contract_id);
        const launch = current(this.store, "work_launch", args.launch_id);
        if (digest([contract.status, contract.launch_id, contract.task_id]) !== digest(["active", launch.id, launch.task_id]))
            throw new Error("Task Run requires an active Task Control contract bound to the Work Launch");
        const dispatchKind = { "codex-cli": "codex_dispatch", "claude-code": "claude_dispatch" }[String(launch.host)] ?? null;
        if (!dispatchKind)
            throw new Error("Task Run host is unsupported");
        const dispatch = current(this.store, dispatchKind, launch.dispatch_id);
        const environmentDigest = digest(args.environment ?? {});
        const budgetDigest = digest(args.budget ?? {});
        const identity = { contract_id: contract.id, contract_version: contract.version, launch_id: launch.id, launch_identity: { task_id: launch.task_id, host: launch.host, dispatch_id: launch.dispatch_id, workspace: launch.workspace, sandbox: launch.sandbox, prompt_digest: launch.prompt_digest }, dispatch_id: dispatch.id, dispatch_request_digest: dispatch.request_digest, activation_profile: contract.activation_profile ?? null, budget_account: contract.budget_account ?? null, acceptance_plan_id: launch.acceptance_plan_id ?? null, environment_digest: environmentDigest, budget_digest: budgetDigest };
        const runId = String(args.task_run_id ?? `task_run_${launch.id}`);
        const existing = this.store.find("task_run", runId);
        const identityDigest = digest(identity);
        if (existing) {
            if (existing.identity_digest !== identityDigest)
                throw new Error("Task Run idempotency conflict");
            return { run: existing, idempotent: true };
        }
        const stabilityDigest = digest({ contract_status: contract.status, contract_version: contract.version, activation_profile: contract.activation_profile ?? null, budget_account: contract.budget_account ?? null, task_id: launch.task_id, workspace: launch.workspace, prompt_digest: launch.prompt_digest, environment_digest: environmentDigest, budget_digest: budgetDigest });
        return { run: this.store.create("task_run", runId, { ...identity, identity_digest: identityDigest, stability_digest: stabilityDigest, lifecycle: "active", paused_reason: null, handoff_reason: null }), idempotent: false };
    }
    refresh(args) {
        const run = current(this.store, "task_run", args.task_run_id);
        const contract = current(this.store, "task_control_contract", run.contract_id);
        const launch = current(this.store, "work_launch", run.launch_id);
        const observedEnvironment = args.environment === undefined ? String(run.environment_digest) : digest(args.environment);
        const observedBudget = args.budget === undefined ? String(run.budget_digest) : digest(args.budget);
        const observedStability = digest({ contract_status: contract.status, contract_version: contract.version, activation_profile: contract.activation_profile ?? null, budget_account: contract.budget_account ?? null, task_id: launch.task_id, workspace: launch.workspace, prompt_digest: launch.prompt_digest, environment_digest: observedEnvironment, budget_digest: observedBudget });
        const drift = observedStability !== run.stability_digest;
        const hostRun = launch.run_id ? this.store.find("host_run", String(launch.run_id)) : null;
        const loop = this.store.find("delivery_loop", `delivery_loop_${launch.id}`);
        const state = this.state(run, launch, hostRun, loop, drift);
        const identity = { task_run_id: run.id, task_run_version: run.version, lifecycle: run.lifecycle, launch_id: launch.id, launch_version: launch.version, host_run_id: hostRun?.id ?? null, host_run_version: hostRun?.version ?? null, delivery_loop_id: loop?.id ?? null, delivery_loop_version: loop?.version ?? null, observed_environment_digest: observedEnvironment, observed_budget_digest: observedBudget, drift, ...state };
        const stateId = `task_run_state_${run.id}`;
        const existing = this.store.find("task_run_state", stateId);
        const stateDigest = digest(identity);
        if (existing?.state_digest === stateDigest)
            return { state: existing, idempotent: true };
        const saved = existing ? this.store.save("task_run_state", stateId, { ...identity, state_digest: stateDigest, task_id: run.launch_identity && run.launch_identity.task_id }) : this.store.create("task_run_state", stateId, { ...identity, state_digest: stateDigest, task_id: run.launch_identity && run.launch_identity.task_id });
        return { state: saved, idempotent: false };
    }
    get(args) {
        const run = current(this.store, "task_run", args.task_run_id);
        return { run, state: this.store.find("task_run_state", `task_run_state_${run.id}`), handoffs: this.store.list("task_run_handoff", 1000, (item) => item.task_run_id === run.id) };
    }
    pause(args) {
        const run = current(this.store, "task_run", args.task_run_id);
        const reason = text(args.reason, "reason");
        if (run.lifecycle === "cancelled")
            throw new Error("Cancelled Task Run cannot be paused");
        if (run.lifecycle === "paused" && run.paused_reason === reason)
            return { run, idempotent: true };
        return { run: this.store.save("task_run", String(run.id), { ...payload(run), lifecycle: "paused", paused_reason: reason }), idempotent: false };
    }
    resume(args) {
        const run = current(this.store, "task_run", args.task_run_id);
        if (run.lifecycle === "cancelled")
            throw new Error("Cancelled Task Run cannot be resumed");
        if (run.lifecycle === "active")
            return { run, state: this.refresh({ task_run_id: run.id, environment: args.environment, budget: args.budget }).state, idempotent: true };
        const saved = this.store.save("task_run", String(run.id), { ...payload(run), lifecycle: "active", paused_reason: null });
        return { run: saved, state: this.refresh({ task_run_id: saved.id, environment: args.environment, budget: args.budget }).state, idempotent: false };
    }
    cancel(args) {
        const run = current(this.store, "task_run", args.task_run_id);
        const reason = text(args.reason, "reason");
        if (run.lifecycle === "cancelled")
            return { run, idempotent: true };
        return { run: this.store.save("task_run", String(run.id), { ...payload(run), lifecycle: "cancelled", paused_reason: null, cancelled_reason: reason }), idempotent: false };
    }
    handoff(args) {
        const run = current(this.store, "task_run", args.task_run_id);
        const reason = text(args.reason, "reason");
        const state = this.refresh({ task_run_id: run.id }).state;
        const identity = { task_run_id: run.id, task_run_version: run.version, state_id: state.id, state_version: state.version, reason, resume_action: state.action };
        const handoffId = String(args.handoff_id ?? `task_run_handoff_${run.id}_${state.version}`);
        const existing = this.store.find("task_run_handoff", handoffId);
        const identityDigest = digest(identity);
        if (existing) {
            if (existing.identity_digest !== identityDigest)
                throw new Error("Task Run handoff idempotency conflict");
            return { handoff: existing, idempotent: true };
        }
        return { handoff: this.store.create("task_run_handoff", handoffId, { ...identity, identity_digest: identityDigest }), idempotent: false };
    }
    state(run, launch, hostRun, loop, drift) {
        if (run.lifecycle === "cancelled")
            return { status: "cancelled", action: "none", actor: "none" };
        if (run.lifecycle === "paused")
            return { status: "paused", action: "resume_or_handoff", actor: "human" };
        if (drift)
            return { status: "needs_replan", action: "revalidate_inputs", actor: "human" };
        if (launch.status === "awaiting_approval")
            return { status: "awaiting_approval", action: "review_work_launch", actor: "human" };
        if (!hostRun || !["completed", "failed", "cancelled", "interrupted"].includes(String(hostRun.status)))
            return { status: "running", action: "wait_for_host", actor: "host" };
        const action = String(loop?.action ?? "wait_for_host");
        if (action === "deliver")
            return { status: "ready_for_delivery", action, actor: "human" };
        if (action === "collect_acceptance")
            return { status: "awaiting_acceptance", action, actor: "human" };
        if (action === "retry_or_handoff")
            return { status: "recovery", action, actor: "human" };
        return { status: "blocked", action: "human_handoff", actor: "human" };
    }
}
//# sourceMappingURL=task-run.js.map