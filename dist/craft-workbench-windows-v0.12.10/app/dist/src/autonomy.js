import { createHash, randomUUID } from "node:crypto";
import { CraftStore } from "./store.js";
const ACTIONS = new Set(["read", "draft", "sandbox_write", "external_write", "communication", "computer_use", "destructive", "financial"]);
const LEVELS = new Set(["automatic", "notify_only", "human_approval", "multi_sig"]);
const HIGH_RISK = new Set(["destructive", "financial"]);
function text(value, name) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${name} must not be empty`);
    return value.trim();
}
function object(value, name) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${name} must be an object`);
    return value;
}
function integer(value, name, fallback, min, max) {
    const result = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(result) || result < min || result > max)
        throw new Error(`${name} must be an integer between ${min} and ${max}`);
    return result;
}
function instant(value, name) {
    const result = value === undefined ? Date.now() : Date.parse(text(value, name));
    if (Number.isNaN(result))
        throw new Error(`${name} must be an ISO timestamp`);
    return result;
}
function payload(record) {
    const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record;
    return rest;
}
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
export class AutonomyKernel {
    store;
    constructor(store) { this.store = store; }
    policySave(args) {
        const policyId = text(args.policy_id, "policy_id");
        const task = this.store.get("task", text(args.task_id, "task_id"));
        const supplied = object(args.rules, "rules");
        const rules = {};
        for (const [action, value] of Object.entries(supplied)) {
            if (!ACTIONS.has(action))
                throw new Error(`Unsupported autonomy action: ${action}`);
            const rule = object(value, `rules.${action}`);
            const level = text(rule.level, `rules.${action}.level`);
            if (!LEVELS.has(level))
                throw new Error(`Unsupported autonomy level: ${level}`);
            if (HIGH_RISK.has(action) && new Set(["automatic", "notify_only"]).has(level))
                throw new Error(`${action} cannot bypass explicit approval`);
            const quorum = level === "multi_sig" ? integer(rule.quorum, `rules.${action}.quorum`, 2, 2, 20) : 1;
            rules[action] = { level, quorum };
        }
        if (!Object.keys(rules).length)
            throw new Error("Autonomy policy requires at least one rule");
        const status = String(args.status ?? "active");
        if (!new Set(["active", "paused"]).has(status))
            throw new Error("Autonomy policy status is unsupported");
        const next = { task_id: task.id, name: text(args.name, "name"), rules,
            default_ttl_seconds: integer(args.default_ttl_seconds, "default_ttl_seconds", 900, 60, 86400), status };
        const existing = this.store.find("autonomy_policy", policyId);
        if (!existing)
            return { policy: this.store.create("autonomy_policy", policyId, next) };
        if (Number(args.expected_version) !== Number(existing.version))
            throw new Error("Autonomy policy version conflict");
        return { policy: this.store.save("autonomy_policy", policyId, next) };
    }
    request(args) {
        const policy = this.store.get("autonomy_policy", text(args.policy_id, "policy_id"), integer(args.policy_version, "policy_version", 0, 1, Number.MAX_SAFE_INTEGER));
        if (policy.status !== "active")
            throw new Error("Autonomy policy is not active");
        const taskId = text(args.task_id, "task_id");
        if (taskId !== policy.task_id)
            throw new Error("Autonomy request belongs to another task");
        const action = text(args.action, "action");
        const rule = policy.rules[action];
        if (!rule)
            throw new Error("Autonomy action is not declared by the policy");
        const requestDigest = text(args.request_digest, "request_digest");
        if (!/^sha256:[a-f0-9]{64}$/u.test(requestDigest))
            throw new Error("request_digest must be sha256 hex");
        const target = text(args.target, "target");
        const now = instant(args.now, "now");
        const ttl = integer(args.ttl_seconds, "ttl_seconds", Number(policy.default_ttl_seconds), 60, 86400);
        const identity = { policy_id: policy.id, policy_version: policy.version, task_id: taskId, action, target, request_digest: requestDigest };
        const requestId = String(args.request_id ?? `authorization_${randomUUID().replaceAll("-", "")}`);
        const requestFingerprint = digest(identity);
        const existing = this.store.find("autonomy_request", requestId);
        if (existing) {
            if (existing.request_fingerprint !== requestFingerprint)
                throw new Error("Autonomy request idempotency conflict");
            return { request: existing, idempotent: true };
        }
        const level = String(rule.level);
        const status = new Set(["automatic", "notify_only"]).has(level) ? "authorized" : "pending_approval";
        const request = this.store.create("autonomy_request", requestId, { ...identity, request_fingerprint: requestFingerprint,
            level, quorum: rule.quorum, status, requested_by: text(args.requested_by, "requested_by"), approvals: [],
            notification_required: level === "notify_only", created_at_control: new Date(now).toISOString(), expires_at: new Date(now + ttl * 1000).toISOString() });
        return { request, idempotent: false };
    }
    decide(args) {
        const request = this.store.get("autonomy_request", text(args.request_id, "request_id"));
        if (request.status !== "pending_approval")
            throw new Error("Autonomy request is not awaiting approval");
        const now = instant(args.now, "now");
        if (now > Date.parse(String(request.expires_at)))
            throw new Error("Autonomy request expired");
        const actor = text(args.actor, "actor");
        const decision = text(args.decision, "decision");
        if (!new Set(["approve", "deny"]).has(decision))
            throw new Error("Autonomy decision is unsupported");
        const approvalRef = text(args.approval_ref, "approval_ref");
        const approvals = request.approvals;
        if (approvals.some((item) => item.actor === actor))
            throw new Error("Approver has already decided");
        const next = [...approvals, { actor, decision, approval_ref: approvalRef, decided_at: new Date(now).toISOString() }];
        const approved = next.filter((item) => item.decision === "approve").length;
        const status = decision === "deny" ? "denied" : approved >= Number(request.quorum) ? "authorized" : "pending_approval";
        return { request: this.store.save("autonomy_request", String(request.id), { ...payload(request), approvals: next, status }) };
    }
    consumptionPlan(args) {
        const request = this.store.get("autonomy_request", text(args.request_id, "request_id"));
        const now = instant(args.now, "now");
        const consumptionId = `autonomy_use_${request.id}`;
        const existing = this.store.find("autonomy_consumption", consumptionId);
        if (existing) {
            if (existing.idempotency_key !== args.idempotency_key)
                throw new Error("Autonomy consumption idempotency conflict");
            return { request, existing, entries: [] };
        }
        if (request.status !== "authorized")
            throw new Error("Autonomy request is not authorized");
        if (now > Date.parse(String(request.expires_at)))
            throw new Error("Autonomy authorization expired");
        for (const field of ["task_id", "action", "target", "request_digest"])
            if (args[field] !== request[field])
                throw new Error(`Autonomy ${field} mismatch`);
        const notificationRef = request.notification_required ? text(args.notification_ref, "notification_ref") : null;
        const idempotencyKey = text(args.idempotency_key, "idempotency_key");
        return { request, existing: null, entries: [
                { kind: "autonomy_consumption", id: consumptionId, version: 1, payload: { request_id: request.id, task_id: request.task_id,
                        action: request.action, target: request.target, request_digest: request.request_digest, idempotency_key: idempotencyKey,
                        notification_ref: notificationRef, consumed_at: new Date(now).toISOString() } },
                { kind: "autonomy_request", id: String(request.id), version: Number(request.version) + 1, payload: { ...payload(request), status: "consumed", consumption_id: consumptionId } },
            ] };
    }
    consume(args) {
        const plan = this.consumptionPlan(args);
        if (plan.existing)
            return { request: plan.request, consumption: plan.existing, idempotent: true };
        const [consumption, saved] = this.store.saveBatch(plan.entries);
        return { request: saved, consumption, idempotent: false };
    }
}
//# sourceMappingURL=autonomy.js.map