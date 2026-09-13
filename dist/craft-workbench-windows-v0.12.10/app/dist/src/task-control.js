import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { CraftStore } from "./store.js";
import { DeliveryLoopKernel } from "./delivery-loop.js";
const EFFECTS = new Set(["read_only", "local_write", "external_write"]);
const HANDOFF_REASONS = new Set(["operator_handoff", "approval_wait", "environment_block", "user_pause", "recovery"]);
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function values(value) {
    const result = value === undefined ? ["read_only"] : Array.isArray(value) ? value.map((item) => text(item, "allowed_effects")) : (() => { throw new Error("allowed_effects must be an array"); })();
    if (!result.length || new Set(result).size !== result.length || result.some((item) => !EFFECTS.has(item)))
        throw new Error("allowed_effects is unsupported");
    return result;
}
function payload(record) { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
function ref(store, kind, idValue, versionValue) {
    if (idValue === undefined && versionValue === undefined)
        return null;
    if (idValue === undefined)
        throw new Error(`${kind}_id is required when ${kind}_version is set`);
    const item = store.get(kind, text(idValue, `${kind}_id`));
    if (versionValue !== undefined && Number(versionValue) !== Number(item.version))
        throw new Error(`${kind} version does not match current state`);
    return item;
}
function launchEffect(launch) { return launch.sandbox === "read-only" ? "read_only" : launch.sandbox === "workspace-write" ? "local_write" : "unsupported"; }
function controlState(launch, run, loop) {
    if (!launch)
        return { status: "prepared", action: "prepare_work_launch", actor: "human_or_host" };
    if (launch.status === "awaiting_approval")
        return { status: "awaiting_approval", action: "review_work_launch", actor: "human" };
    if (launch.status === "denied")
        return { status: "blocked", action: "revise_contract_or_open_new_launch", actor: "human" };
    if (!run || !["completed", "failed", "cancelled", "interrupted"].includes(String(run.status)))
        return { status: "running", action: "wait_for_host", actor: "host" };
    const action = String(loop?.action ?? "wait_for_host");
    if (action === "deliver")
        return { status: "ready_for_delivery", action, actor: "human" };
    if (action === "collect_acceptance")
        return { status: "awaiting_acceptance", action, actor: "human" };
    if (action === "retry_or_handoff")
        return { status: "recovery", action, actor: "human" };
    if (action === "human_handoff")
        return { status: "blocked", action, actor: "human" };
    return { status: "running", action: "wait_for_host", actor: "host" };
}
/** Version-pinned task boundary that projects all launch facts into one safe next action. */
export class TaskControlKernel {
    store;
    delivery;
    constructor(store, delivery) { this.store = store; this.delivery = delivery; }
    save(args) {
        const task = this.store.get("task", text(args.task_id, "task_id"));
        const allowedEffects = values(args.allowed_effects);
        const workspace = resolve(text(args.workspace, "workspace"));
        const profile = ref(this.store, "activation_profile", args.activation_profile_id, args.activation_profile_version);
        const budget = ref(this.store, "budget_account", args.budget_account_id, args.budget_account_version);
        if (profile && profile.task_id !== task.id)
            throw new Error("Activation profile does not match task");
        if (profile && Array.isArray(profile.allowed_effects) && profile.allowed_effects.some((item) => !allowedEffects.includes(String(item))))
            throw new Error("Activation profile effect exceeds task contract");
        if (budget && budget.owner_id !== task.id)
            throw new Error("Budget account does not match task");
        const identity = { task_id: task.id, workspace, allowed_effects: allowedEffects, acceptance_required: args.acceptance_required === true,
            activation_profile: profile ? { id: profile.id, version: profile.version } : null, budget_account: budget ? { id: budget.id, version: budget.version } : null };
        const contractId = String(args.contract_id ?? `task_control_${task.id}`);
        const existing = this.store.find("task_control_contract", contractId);
        const identityDigest = digest(identity);
        if (existing) {
            if (existing.identity_digest !== identityDigest)
                throw new Error("Task control contract idempotency conflict");
            return { contract: existing, idempotent: true };
        }
        return { contract: this.store.create("task_control_contract", contractId, { ...identity, identity_digest: identityDigest, launch_id: null, launch_version: null, status: "active" }), idempotent: false };
    }
    bindLaunch(args) {
        const contract = this.store.get("task_control_contract", text(args.contract_id, "contract_id"));
        const launch = this.store.get("work_launch", text(args.launch_id, "launch_id"));
        if (contract.status !== "active" || launch.task_id !== contract.task_id)
            throw new Error("Work Launch does not match active task control contract");
        if (resolve(String(launch.workspace)) !== contract.workspace)
            throw new Error("Work Launch workspace does not match task control contract");
        if (!contract.allowed_effects.includes(launchEffect(launch)))
            throw new Error("Work Launch effect is not allowed by task control contract");
        if (contract.acceptance_required === true && !launch.acceptance_plan_id)
            throw new Error("Task control contract requires an acceptance plan");
        if (contract.launch_id !== null) {
            if (contract.launch_id !== launch.id)
                throw new Error("Task control contract is already bound to another Work Launch");
            return { contract, state: this.refresh({ contract_id: contract.id }).state, idempotent: true };
        }
        const updated = this.store.save("task_control_contract", String(contract.id), { ...payload(contract), launch_id: launch.id, launch_version: launch.version, bound_at: new Date().toISOString() });
        return { contract: updated, state: this.refresh({ contract_id: updated.id }).state, idempotent: false };
    }
    refresh(args) {
        const contract = this.store.get("task_control_contract", text(args.contract_id, "contract_id"));
        const launch = contract.launch_id ? this.store.get("work_launch", String(contract.launch_id)) : null;
        const run = launch?.run_id ? this.store.find("host_run", String(launch.run_id)) : null;
        const loop = launch ? this.delivery.refresh({ launch_id: launch.id }).loop : null;
        const guidance = controlState(launch, run, loop);
        const identity = { contract_id: contract.id, contract_version: contract.version,
            launch_id: launch?.id ?? null, launch_version: launch?.version ?? null, run_id: run?.id ?? null, run_version: run?.version ?? null,
            delivery_loop_id: loop?.id ?? null, delivery_loop_version: loop?.version ?? null, ...guidance };
        const stateId = `task_control_state_${contract.id}`;
        const current = this.store.find("task_control_state", stateId);
        const stateDigest = digest(identity);
        if (current?.state_digest === stateDigest)
            return { state: current, loop, idempotent: true };
        const state = current ? this.store.save("task_control_state", stateId, { ...identity, state_digest: stateDigest, task_id: contract.task_id }) : this.store.create("task_control_state", stateId, { ...identity, state_digest: stateDigest, task_id: contract.task_id });
        return { state, loop, idempotent: false };
    }
    get(args) {
        const contract = this.store.get("task_control_contract", text(args.contract_id, "contract_id"));
        const state = this.store.find("task_control_state", `task_control_state_${contract.id}`);
        const loop = contract.launch_id ? this.store.find("delivery_loop", `delivery_loop_${contract.launch_id}`) : null;
        const handoffs = this.store.list("task_control_handoff", 1000, (item) => item.contract_id === contract.id);
        return { contract, state, delivery_loop: loop, handoffs };
    }
    handoff(args) {
        const contract = this.store.get("task_control_contract", text(args.contract_id, "contract_id"));
        const reason = text(args.reason, "reason");
        if (!HANDOFF_REASONS.has(reason))
            throw new Error("Task control handoff reason is unsupported");
        const state = this.refresh({ contract_id: contract.id }).state;
        const handoffId = String(args.handoff_id ?? `task_control_handoff_${contract.id}_${state.version}`);
        const identity = { contract_id: contract.id, contract_version: contract.version, state_id: state.id, state_version: state.version, reason, task_id: contract.task_id,
            launch_id: state.launch_id, resume_action: state.action, status: "open" };
        const existing = this.store.find("task_control_handoff", handoffId);
        const identityDigest = digest(identity);
        if (existing) {
            if (existing.identity_digest !== identityDigest)
                throw new Error("Task control handoff idempotency conflict");
            return { handoff: existing, idempotent: true };
        }
        return { handoff: this.store.create("task_control_handoff", handoffId, { ...identity, identity_digest: identityDigest }), idempotent: false };
    }
}
//# sourceMappingURL=task-control.js.map