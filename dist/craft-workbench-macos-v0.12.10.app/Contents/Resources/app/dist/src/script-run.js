import { randomUUID } from "node:crypto";
import { CraftStore } from "./store.js";
function id(value, name, prefix) {
    const result = value === undefined ? `${prefix}_${randomUUID().replaceAll("-", "")}` : String(value).trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(result))
        throw new Error(`${name} must contain only letters, numbers, _ or -`);
    return result;
}
function text(value, name) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${name} must not be empty`);
    return value.trim();
}
function recordPayload(record) {
    const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...payload } = record;
    return payload;
}
export class VerifiedScriptRunner {
    store;
    constructor(store) { this.store = store; }
    issue(args) {
        const proposal = this.store.get("trajectory_script_proposal", id(args.proposal_id, "proposal_id", "trajectory_script"));
        const workspace = this.store.get("workspace", id(args.workspace_id, "workspace_id", "workspace"));
        const transaction = this.store.get("workspace_transaction", id(args.transaction_id, "transaction_id", "workspace_transaction"));
        if (proposal.lifecycle !== "verified")
            throw new Error("verified script run requires a verified proposal");
        if (transaction.status !== "prepared" || transaction.workspace_id !== workspace.id)
            throw new Error("verified script run requires its workspace's prepared transaction");
        if (this.store.list("verified_script_run", 1_000, (item) => item.transaction_id === transaction.id).length) {
            throw new Error("verified script run transaction is already associated with a run");
        }
        const operations = proposal.operations;
        const run = this.store.create("verified_script_run", id(args.run_id, "run_id", "verified_script_run"), { proposal_id: proposal.id,
            proposal_version: proposal.version, workspace_id: workspace.id, transaction_id: transaction.id, status: "issued",
            operations: operations.map((operation) => ({ operation_id: operation.operation_id, kind: operation.kind, status: "awaiting_host_receipt" })) });
        return { run, host_execution: { root_path: workspace.root_path, operations } };
    }
    receipt(args) {
        const run = this.store.get("verified_script_run", id(args.run_id, "run_id", "verified_script_run"));
        if (run.status !== "issued")
            throw new Error("verified script run cannot accept more receipts");
        if (!Array.isArray(args.receipts))
            throw new Error("receipts must be an array");
        const expected = run.operations.map((operation) => String(operation.operation_id)).sort();
        const receipts = args.receipts.map((raw, index) => {
            if (!raw || typeof raw !== "object" || Array.isArray(raw))
                throw new Error(`receipts[${index}] must be an object`);
            const receipt = raw;
            const verdict = text(receipt.verdict, `receipts[${index}].verdict`);
            if (!new Set(["passed", "failed", "cancelled"]).has(verdict))
                throw new Error("verified script receipt verdict is unsupported");
            return { operation_id: id(receipt.operation_id, `receipts[${index}].operation_id`, "operation"), verdict,
                summary: text(receipt.summary, `receipts[${index}].summary`) };
        });
        if (JSON.stringify(receipts.map((receipt) => receipt.operation_id).sort()) !== JSON.stringify(expected))
            throw new Error("verified script receipts must exactly match issued operations");
        const status = receipts.every((receipt) => receipt.verdict === "passed") ? "completed" : receipts.some((receipt) => receipt.verdict === "cancelled") ? "cancelled" : "failed";
        const saved = this.store.save("verified_script_run", String(run.id), { ...recordPayload(run), status,
            host_adapter_id: text(args.host_adapter_id, "host_adapter_id"), receipts });
        return { run: saved };
    }
}
//# sourceMappingURL=script-run.js.map