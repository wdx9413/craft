import { randomUUID } from "node:crypto";
import { CraftStore } from "./store.js";
function text(value, name) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${name} must not be empty`);
    return value.trim();
}
function positiveInteger(value, name, fallback, maximum) {
    const result = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(result) || result < 1 || result > maximum)
        throw new Error(`${name} must be an integer between 1 and ${maximum}`);
    return result;
}
function stringArray(value, name) {
    if (!Array.isArray(value) || !value.length)
        throw new Error(`${name} must be a non-empty array`);
    const result = value.map((item) => text(item, name));
    if (new Set(result).size !== result.length)
        throw new Error(`${name} must contain unique values`);
    return result;
}
function payload(record) {
    const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record;
    return rest;
}
function instant(value, name) {
    const result = value === undefined ? Date.now() : Date.parse(text(value, name));
    if (Number.isNaN(result))
        throw new Error(`${name} must be an ISO timestamp`);
    return result;
}
export class RecoveryQueueKernel {
    store;
    constructor(store) { this.store = store; }
    refresh(args = {}) {
        const now = instant(args.now, "now");
        const limit = positiveInteger(args.limit, "limit", 100, 1000);
        this.recoverExpired({ now: new Date(now).toISOString(), limit });
        const candidates = this.candidates(now).slice(0, limit);
        const active = new Set(candidates.map((item) => item.id));
        const items = candidates.map((candidate) => {
            const existing = this.store.find("recovery_item", candidate.id);
            if (!existing)
                return this.store.create("recovery_item", candidate.id, { ...candidate, status: "open", lease: null });
            const unchanged = existing.subject_version === candidate.subject_version && existing.subject_status === candidate.subject_status;
            if (unchanged)
                return existing;
            return this.store.save("recovery_item", candidate.id, { ...candidate, status: "open", lease: null });
        });
        for (const existing of this.store.list("recovery_item", 10_000, (item) => item.status === "open")) {
            if (!active.has(String(existing.id)))
                this.store.save("recovery_item", String(existing.id), {
                    ...payload(existing), status: "superseded", superseded_at: new Date(now).toISOString()
                });
        }
        return { items, count: items.length, refreshed_at: new Date(now).toISOString() };
    }
    claim(args) {
        const now = instant(args.now, "now");
        this.recoverExpired({ now: new Date(now).toISOString(), limit: 1000 });
        const actions = stringArray(args.actions, "actions");
        const workerId = text(args.worker_id, "worker_id");
        const leaseSeconds = positiveInteger(args.lease_seconds, "lease_seconds", 300, 3600);
        const item = this.store.list("recovery_item", 10_000, (entry) => entry.status === "open" && actions.includes(String(entry.action)))
            .sort((left, right) => Number(right.priority) - Number(left.priority) || String(left.id).localeCompare(String(right.id)))[0];
        if (!item)
            return { item: null };
        const token = randomUUID();
        const leased = this.store.updateIfVersion("recovery_item", String(item.id), Number(item.version), {
            ...payload(item), status: "leased", lease: { token, worker_id: workerId, leased_at: new Date(now).toISOString(),
                expires_at: new Date(now + leaseSeconds * 1000).toISOString() }
        });
        return { item: leased, lease_token: token };
    }
    report(args) {
        const item = this.store.get("recovery_item", text(args.item_id, "item_id"));
        if (item.status !== "leased")
            throw new Error("Recovery item is not leased");
        const lease = item.lease;
        const now = instant(args.now, "now");
        if (text(args.lease_token, "lease_token") !== lease.token || now >= Date.parse(String(lease.expires_at))) {
            throw new Error("Recovery lease is invalid or expired");
        }
        const outcome = text(args.outcome, "outcome");
        if (!new Set(["completed", "failed", "deferred"]).has(outcome))
            throw new Error("Unsupported recovery outcome");
        const evidenceIds = outcome === "deferred" && args.evidence_ids === undefined ? [] : stringArray(args.evidence_ids, "evidence_ids");
        for (const evidenceId of evidenceIds)
            this.store.get("evidence", evidenceId);
        const current = this.candidates(now).find((candidate) => candidate.id === item.id);
        const stale = Boolean(current && (current.subject_version !== item.subject_version || current.subject_status !== item.subject_status));
        if (outcome === "completed" && current && !stale)
            throw new Error("Recovery source is still actionable");
        const status = stale ? "stale" : outcome;
        const updated = this.store.updateIfVersion("recovery_item", String(item.id), Number(item.version), {
            ...payload(item), status, lease: null, outcome, evidence_ids: evidenceIds,
            summary: text(args.summary, "summary"), reported_at: new Date(now).toISOString()
        });
        return { item: updated, stale };
    }
    recoverExpired(args = {}) {
        const now = instant(args.now, "now");
        const limit = positiveInteger(args.limit, "limit", 100, 1000);
        let recovered = 0;
        for (const item of this.store.list("recovery_item", 10_000, (entry) => entry.status === "leased").slice(0, limit)) {
            const lease = item.lease;
            if (now >= Date.parse(String(lease.expires_at))) {
                this.store.updateIfVersion("recovery_item", String(item.id), Number(item.version), {
                    ...payload(item), status: "open", lease: null, recovered_at: new Date(now).toISOString()
                });
                recovered += 1;
            }
        }
        return { recovered };
    }
    candidates(now) {
        const candidates = [];
        for (const wait of this.store.list("durable_wait", 10_000, (item) => item.status === "waiting")) {
            if (wait.condition === "time" && Date.parse(String(wait.resume_at)) <= now)
                candidates.push(this.candidate(wait, "durable_wait", "resume_due_wait", 90, {}));
            else if (wait.condition === "approval")
                candidates.push(this.candidate(wait, "durable_wait", "request_approval", 70, { approval_scope: wait.approval_scope }));
        }
        for (const effect of this.store.list("external_effect", 10_000)) {
            if (effect.status === "indeterminate")
                candidates.push(this.candidate(effect, "external_effect", "reconcile_effect", 100, { provider: effect.provider, target: effect.target }));
            else if (effect.status === "compensation_indeterminate")
                candidates.push(this.candidate(effect, "external_effect", "resolve_compensation", 100, { compensation_id: effect.compensation_id }));
        }
        for (const saga of this.store.list("effect_saga", 10_000)) {
            const effects = saga.effect_ids.map((id) => this.store.get("external_effect", id));
            const failed = effects.some((effect) => ["failed", "indeterminate", "compensation_failed", "compensation_indeterminate"].includes(String(effect.status)));
            const compensatable = failed ? effects.filter((effect) => effect.status === "succeeded" && effect.compensation).reverse()[0] : undefined;
            if (compensatable)
                candidates.push(this.candidate(saga, "effect_saga", "execute_compensation", 95, { effect_id: compensatable.id }));
        }
        for (const certification of this.store.list("capability_certification", 10_000, (item) => item.status === "invalidated")) {
            candidates.push(this.candidate(certification, "capability_certification", "recertify_capability", 85, { asset_id: certification.asset_id, materialization_id: certification.materialization_id,
                reason: certification.invalidation_reason, advisory_id: certification.advisory_id }));
        }
        return candidates.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
    }
    candidate(subject, kind, action, priority, details) {
        return { id: `recovery:${kind}:${subject.id}:${action}`, task_id: String(subject.task_id), action, priority,
            subject_kind: kind, subject_id: String(subject.id), subject_version: Number(subject.version),
            subject_status: String(subject.status), details };
    }
}
//# sourceMappingURL=recovery.js.map