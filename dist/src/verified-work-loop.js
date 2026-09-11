import { createHash } from "node:crypto";
import { CraftStore } from "./store.js";
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function payload(record) { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
/** A single durable facade over existing launch, receipt, acceptance and state facts. */
export class VerifiedWorkLoopKernel {
    store;
    constructor(store) { this.store = store; }
    create(args) {
        const task = this.store.get("task", text(args.task_id, "task_id"));
        const contract = this.store.get("task_control_contract", text(args.contract_id, "contract_id"));
        const run = this.store.get("task_run", text(args.task_run_id, "task_run_id"));
        const snapshot = this.store.get("state_snapshot", text(args.snapshot_id, "snapshot_id"));
        if (contract.task_id !== task.id || run.contract_id !== contract.id)
            throw new Error("Verified Work Loop facts are not bound to one Task");
        const identity = { task_id: task.id, contract_id: contract.id, contract_version: contract.version, task_run_id: run.id, task_run_version: run.version, workspace_id: snapshot.workspace_id, initial_snapshot_id: snapshot.id, initial_snapshot_digest: snapshot.snapshot_digest };
        const loopId = String(args.work_loop_id ?? `work_loop_${run.id}`);
        const existing = this.store.find("verified_work_loop", loopId);
        const identityDigest = digest(identity);
        if (existing) {
            if (existing.identity_digest !== identityDigest)
                throw new Error("Verified Work Loop idempotency conflict");
            return { loop: existing, idempotent: true };
        }
        return { loop: this.store.create("verified_work_loop", loopId, { ...identity, identity_digest: identityDigest, lifecycle: "active", latest_snapshot_id: snapshot.id, latest_task_run_state_id: null, needs_replan_reason: null }), idempotent: false };
    }
    advance(args) {
        const loop = this.store.get("verified_work_loop", text(args.work_loop_id, "work_loop_id"));
        const state = this.store.get("task_run_state", text(args.task_run_state_id, "task_run_state_id"));
        const snapshot = this.store.get("state_snapshot", text(args.snapshot_id, "snapshot_id"));
        if (state.task_run_id !== loop.task_run_id || snapshot.workspace_id !== loop.workspace_id)
            throw new Error("Verified Work Loop observation does not belong to this Run");
        const previous = this.store.get("state_snapshot", String(loop.latest_snapshot_id));
        const changed = previous.snapshot_digest !== snapshot.snapshot_digest || previous.workspace_state_revision !== snapshot.workspace_state_revision;
        const hostTerminal = ["ready_for_delivery", "awaiting_acceptance", "recovery", "blocked"].includes(String(state.status));
        const status = loop.lifecycle === "needs_replan" || (changed && !hostTerminal) || state.status === "needs_replan" ? "needs_replan" : state.status;
        const reason = status === "needs_replan" ? (changed ? "workspace_changed_without_terminal_receipt" : "task_run_drift") : null;
        const saved = this.store.save("verified_work_loop", String(loop.id), { ...payload(loop), latest_snapshot_id: snapshot.id, latest_task_run_state_id: state.id, lifecycle: status === "needs_replan" ? "needs_replan" : loop.lifecycle, needs_replan_reason: reason });
        const receiptId = String(args.receipt_id ?? `work_loop_receipt_${saved.id}_${snapshot.version}_${state.version}`);
        const identity = { work_loop_id: saved.id, work_loop_version: saved.version, task_run_state_id: state.id, task_run_state_version: state.version, snapshot_id: snapshot.id, snapshot_version: snapshot.version, status, reason };
        const receipt = this.store.find("verified_work_loop_receipt", receiptId) ?? this.store.create("verified_work_loop_receipt", receiptId, { ...identity, receipt_digest: digest(identity) });
        return { loop: saved, state: { status, action: status === "needs_replan" ? "replan" : state.action, actor: status === "needs_replan" ? "human" : state.actor }, receipt };
    }
    decide(args) {
        const loop = this.store.get("verified_work_loop", text(args.work_loop_id, "work_loop_id"));
        const decision = text(args.decision, "decision");
        if (!["approve", "replan", "accept", "reject", "human_change"].includes(decision))
            throw new Error("Verified Work Loop decision is unsupported");
        // A retried human decision must remain idempotent even though the first
        // attempt may itself advance the Loop version.
        const identity = { work_loop_id: loop.id, decision, actor: text(args.actor, "actor"), summary_digest: digest(text(args.summary, "summary")) };
        const decisionId = String(args.decision_id ?? `work_loop_decision_${loop.id}_${digest(identity).slice(-16)}`);
        const existing = this.store.find("verified_work_loop_decision", decisionId);
        const decisionDigest = digest(identity);
        if (existing) {
            if (existing.decision_digest !== decisionDigest)
                throw new Error("Verified Work Loop decision idempotency conflict");
            return { decision: existing, idempotent: true };
        }
        const saved = this.store.create("verified_work_loop_decision", decisionId, { ...identity, work_loop_version: loop.version, decision_digest: decisionDigest });
        if (["human_change", "replan", "reject"].includes(decision))
            this.store.save("verified_work_loop", String(loop.id), { ...payload(loop), lifecycle: "needs_replan", needs_replan_reason: decision });
        return { decision: saved, idempotent: false };
    }
    get(args) { const loop = this.store.get("verified_work_loop", text(args.work_loop_id, "work_loop_id")); return { loop, receipts: this.store.list("verified_work_loop_receipt", 1000, (item) => item.work_loop_id === loop.id), decisions: this.store.list("verified_work_loop_decision", 1000, (item) => item.work_loop_id === loop.id) }; }
}
//# sourceMappingURL=verified-work-loop.js.map