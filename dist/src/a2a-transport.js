import { createHash } from "node:crypto";
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
export class A2ATransportKernel {
    async dispatch(args, fetchImpl = fetch) {
        const endpoint = text(args.endpoint, "endpoint");
        if (!endpoint.startsWith("https://"))
            throw new Error("A2A endpoint must use HTTPS");
        const requestId = text(args.request_id, "request_id");
        const envelope = { request_id: requestId, agent: text(args.agent, "agent"), operation: text(args.operation, "operation"), input_digest: text(args.input_digest, "input_digest"), execution_authority: false, trust: "untrusted_remote" };
        const response = await fetchImpl(endpoint, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(envelope) });
        if (response.status < 200 || response.status >= 300)
            throw new Error(`A2A transport HTTP ${response.status}`);
        const body = await response.json();
        if (!body || typeof body !== "object" || Array.isArray(body))
            throw new Error("A2A response must be an object");
        const result = body;
        const remoteId = text(result.remote_id, "remote_id");
        const status = text(result.status, "status");
        if (!(new Set(["accepted", "completed", "failed"]).has(status)))
            throw new Error("A2A response status is unsupported");
        const resultDigest = result.result_digest === undefined ? null : text(result.result_digest, "result_digest");
        return { request_id: requestId, remote_id: remoteId, status, result_digest: resultDigest, response_digest: digest({ remote_id: remoteId, status, result_digest: resultDigest }), raw_content: false };
    }
}
//# sourceMappingURL=a2a-transport.js.map