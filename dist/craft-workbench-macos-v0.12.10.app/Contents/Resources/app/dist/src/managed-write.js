import { createHash } from "node:crypto";
import { CraftStore } from "./store.js";
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function payload(record) { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
/**
 * Adds a bounded, user-approved recovery seam to a Fabric local-write Run.
 * It protects only declared workspace files; it never claims an external API
 * or arbitrary Host side effect can be rolled back.
 */
export class ManagedWriteKernel {
    store;
    transactions;
    workspace;
    constructor(store, transactions, workspace) { this.store = store; this.transactions = transactions; this.workspace = workspace; }
    prepare(args) {
        const fabric = this.store.get("execution_fabric", text(args.fabric_id, "fabric_id"));
        const launch = this.launch(fabric);
        if (launch.sandbox !== "workspace-write")
            throw new Error("Managed write requires a workspace-write Fabric");
        const existing = this.store.find("managed_write_guard", String(fabric.id));
        const identity = { fabric_id: fabric.id, work_loop_id: fabric.work_loop_id, launch_id: launch.id, workspace_id: this.workspaceId(fabric), workspace_scope: this.scope(fabric) };
        const identityDigest = digest(identity);
        if (existing) {
            if (existing.identity_digest !== identityDigest)
                throw new Error("Managed write idempotency conflict");
            return { guard: existing, transaction: this.store.get("workspace_transaction", String(existing.transaction_id)), idempotent: true };
        }
        const transaction = this.transactions.begin({ transaction_id: `managed_write_transaction_${fabric.id}`, workspace_id: identity.workspace_id, label: `Fabric ${fabric.id}` }).transaction;
        const guard = this.store.create("managed_write_guard", String(fabric.id), { ...identity, identity_digest: identityDigest, transaction_id: transaction.id, transaction_version: transaction.version, status: "prepared", run_id: null, committed_checkpoint_id: null, rollback_reason: null });
        return { guard, transaction, idempotent: false };
    }
    start(args) {
        const guard = this.store.get("managed_write_guard", text(args.fabric_id, "fabric_id"));
        const runId = text(args.run_id, "run_id");
        this.assertRun(guard, runId);
        if (guard.status === "running" && guard.run_id === runId)
            return { guard, idempotent: true };
        if (guard.status !== "prepared")
            throw new Error("Managed write is not prepared");
        return { guard: this.store.save("managed_write_guard", String(guard.id), { ...payload(guard), status: "running", run_id: runId }), idempotent: false };
    }
    settleForRun(run) {
        const guard = this.store.list("managed_write_guard", 10_000, (item) => item.run_id === run.id)[0];
        if (!guard)
            return null;
        if (!new Set(["completed", "failed", "cancelled", "interrupted"]).has(String(run.status)))
            throw new Error("Managed write settlement requires terminal Host receipt");
        const existing = this.store.find("managed_write_settlement", `managed_write_settlement_${guard.id}_${run.id}`);
        if (existing)
            return { guard: this.store.get("managed_write_guard", String(guard.id)), settlement: existing, idempotent: true };
        const committed = run.status === "completed";
        const checkpoint = committed ? this.workspace.checkpoint({ workspace_id: guard.workspace_id, checkpoint_id: `managed_write_commit_${guard.id}_${run.id}`, label: `Fabric ${guard.id} completed`, artifact_ids: [], evidence_ids: [] }).checkpoint : null;
        const transaction = committed ? this.transactions.commit({ transaction_id: guard.transaction_id, checkpoint_id: checkpoint.id }).transaction : this.store.get("workspace_transaction", String(guard.transaction_id));
        const saved = this.store.save("managed_write_guard", String(guard.id), { ...payload(guard), status: committed ? "committed" : "rollback_pending", committed_checkpoint_id: checkpoint?.id ?? null, host_status: run.status });
        const identity = { guard_id: guard.id, guard_version: saved.version, run_id: run.id, run_version: run.version, transaction_id: transaction.id, checkpoint_id: checkpoint?.id ?? null, status: saved.status };
        const settlement = this.store.create("managed_write_settlement", `managed_write_settlement_${guard.id}_${run.id}`, { ...identity, settlement_digest: digest(identity) });
        return { guard: saved, transaction, settlement, idempotent: false };
    }
    rollback(args) {
        if (args.approved !== true)
            throw new Error("Managed write rollback requires approved=true");
        const guard = this.store.get("managed_write_guard", text(args.fabric_id, "fabric_id"));
        text(args.actor, "actor");
        if (!new Set(["committed", "rollback_pending"]).has(String(guard.status)))
            throw new Error(`Managed write cannot roll back from ${guard.status}`);
        const restored = this.transactions.rollback({ transaction_id: guard.transaction_id, approved: true });
        const saved = this.store.save("managed_write_guard", String(guard.id), { ...payload(guard), status: "rolled_back", rollback_reason: "human_approved_workspace_restore" });
        return { guard: saved, restored };
    }
    get(args) {
        const guard = this.store.get("managed_write_guard", text(args.fabric_id, "fabric_id"));
        return { guard, transaction: this.store.get("workspace_transaction", String(guard.transaction_id)), settlements: this.store.list("managed_write_settlement", 1000, (item) => item.guard_id === guard.id) };
    }
    workspaceId(fabric) { return String(this.store.get("verified_work_loop", String(fabric.work_loop_id)).workspace_id); }
    scope(fabric) { return [...this.store.get("workspace", this.workspaceId(fabric)).include_paths].sort(); }
    launch(fabric) { const loop = this.store.get("verified_work_loop", String(fabric.work_loop_id)); const run = this.store.get("task_run", String(loop.task_run_id)); return this.store.get("work_launch", String(run.launch_id)); }
    assertRun(guard, runId) { const run = this.store.get("host_run", runId); const fabric = this.store.get("execution_fabric", String(guard.fabric_id)); const launch = this.launch(fabric); if (run.host !== launch.host || run.dispatch_id !== launch.dispatch_id)
        throw new Error("Managed write Host Run does not match Fabric"); }
}
//# sourceMappingURL=managed-write.js.map