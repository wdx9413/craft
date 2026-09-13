import { createHash, randomUUID } from "node:crypto";
import { CraftStore } from "./store.js";
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function payload(record) { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function httpsUrl(value) { const url = text(value, "endpoint"); if (!url.startsWith("https://"))
    throw new Error("Remote endpoint must use HTTPS"); return url; }
export class RemoteInteropKernel {
    store;
    constructor(store) { this.store = store; }
    prepare(args) {
        const endpoint = httpsUrl(args.endpoint);
        const agent = text(args.agent, "agent");
        const operation = text(args.operation, "operation");
        const taskId = text(args.task_id, "task_id");
        const requestId = String(args.request_id ?? `remote_request_${randomUUID().replaceAll("-", "")}`);
        const requestDigest = digest({ endpoint, agent, operation, task_id: taskId, input_digest: text(args.input_digest, "input_digest") });
        const existing = this.store.find("remote_request", requestId);
        if (existing) {
            if (existing.request_digest !== requestDigest)
                throw new Error("Remote request idempotency conflict");
            return { request: existing, idempotent: true };
        }
        return { request: this.store.create("remote_request", requestId, { endpoint, agent, operation, task_id: taskId, input_digest: text(args.input_digest, "input_digest"), request_digest: requestDigest, status: "prepared", remote_id: null, result_digest: null }), idempotent: false };
    }
    async dispatch(args, transport) {
        const request = this.store.get("remote_request", text(args.request_id, "request_id"));
        if (request.status === "completed" || request.status === "failed")
            return { request, idempotent: true };
        if (request.status !== "prepared" && request.status !== "accepted")
            throw new Error("Remote request is not dispatchable");
        const envelope = { request_id: request.id, agent: request.agent, operation: request.operation, task_id: request.task_id, input_digest: request.input_digest, trust: "untrusted_remote", execution_authority: false };
        const result = await transport.dispatch(String(request.endpoint), envelope);
        if (!result.remote_id || !new Set(["accepted", "completed", "failed"]).has(result.status))
            throw new Error("Remote transport returned an invalid result");
        const saved = this.store.save("remote_request", String(request.id), { ...payload(request), status: result.status, remote_id: result.remote_id, result_digest: result.result_digest ?? null, dispatched_at: new Date().toISOString() });
        return { request: saved, receipt: this.store.create("remote_receipt", `receipt_${request.id}`, { request_id: request.id, remote_id: result.remote_id, status: result.status, result_digest: result.result_digest ?? null, envelope_digest: digest(envelope) }), idempotent: false };
    }
    report(args) {
        const request = this.store.get("remote_request", text(args.request_id, "request_id"));
        const status = text(args.status, "status");
        if (!(new Set(["completed", "failed", "cancelled"]).has(status)))
            throw new Error("Unsupported remote report status");
        const resultDigest = args.result_digest === undefined ? null : text(args.result_digest, "result_digest");
        if (request.status === status && request.result_digest === resultDigest)
            return { request, idempotent: true };
        if (request.status === "completed" || request.status === "failed")
            throw new Error("Remote request is already terminal");
        return { request: this.store.save("remote_request", String(request.id), { ...payload(request), status, result_digest: resultDigest, reported_at: new Date().toISOString() }), idempotent: false };
    }
    get(args) { const request = this.store.get("remote_request", text(args.request_id, "request_id")); return { request, receipts: this.store.list("remote_receipt", 100, (item) => item.request_id === request.id) }; }
}
//# sourceMappingURL=remote-interop.js.map