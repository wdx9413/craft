import { createHash, randomUUID } from "node:crypto";
import { CraftStore } from "./store.js";
function text(value, name) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${name} must not be empty`);
    return value.trim();
}
function list(value, name) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value))
        throw new Error(`${name} must be an array`);
    const values = value.map((item) => text(item, name));
    if (new Set(values).size !== values.length)
        throw new Error(`${name} must contain unique values`);
    return values;
}
function object(value, name) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${name} must be an object`);
    return value;
}
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function payload(record) {
    const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record;
    return rest;
}
const EFFECTS = new Set(["read_only", "local_write", "external_write", "destructive"]);
/** v0.12.12's single-agent vertical slice: action authorization is separate from model intent. */
export class VerifiedAutonomousWorkKernel {
    store;
    constructor(store) { this.store = store; }
    prepare(args) {
        const workId = String(args.work_id ?? `verified_work_${randomUUID().replaceAll("-", "")}`);
        const identity = { task_id: text(args.task_id, "task_id"), context_manifest_id: text(args.context_manifest_id, "context_manifest_id"), host: text(args.host, "host"), model: args.model === undefined ? null : text(args.model, "model"), effect: text(args.effect ?? "read_only", "effect"), workspace_digest: text(args.workspace_digest, "workspace_digest"), action_digest: text(args.action_digest, "action_digest"), acceptance_ref: text(args.acceptance_ref, "acceptance_ref"), budget: args.budget === undefined ? {} : object(args.budget, "budget") };
        if (!EFFECTS.has(identity.effect))
            throw new Error("Unsupported verified work effect");
        const workDigest = digest(identity);
        const existing = this.store.find("verified_work", workId);
        if (existing) {
            if (existing.work_digest !== workDigest)
                throw new Error("Verified Work idempotency conflict");
            return { work: existing, idempotent: true };
        }
        return { work: this.store.create("verified_work", workId, { ...identity, work_digest: workDigest, status: "prepared", phase: "prepared", action_count: 0 }), idempotent: false };
    }
    authorize(args) {
        const work = this.store.get("verified_work", text(args.work_id, "work_id"));
        if (!["prepared", "needs_replan", "paused"].includes(String(work.status)))
            throw new Error("Verified Work is not awaiting authorization");
        const effect = String(work.effect);
        if (effect !== "read_only" && args.approved !== true)
            throw new Error("Write effects require explicit approval");
        const authorization = text(args.authorization_ref ?? "local-read", "authorization_ref");
        if (effect !== "read_only" && args.platform_profile_id === undefined)
            throw new Error("Write effects require a verified platform profile");
        const saved = this.store.save("verified_work", String(work.id), { ...payload(work), status: "authorized", phase: "authorized", authorization_ref: authorization, platform_profile_id: args.platform_profile_id ?? null, approved_by: args.approved_by ?? null });
        return { work: saved, idempotent: false };
    }
    recordAction(args) {
        const work = this.store.get("verified_work", text(args.work_id, "work_id"));
        if (work.status !== "authorized" && work.status !== "running")
            throw new Error("Verified Work is not authorized");
        const action = object(args.action_contract, "action_contract");
        const key = text(args.idempotency_key, "idempotency_key");
        const receiptId = `verified_action_${work.id}_${key}`;
        const existing = this.store.find("verified_action_receipt", receiptId);
        if (existing)
            return { receipt: existing, work, idempotent: true };
        const receipt = this.store.create("verified_action_receipt", receiptId, { work_id: work.id, idempotency_key: key, action_contract: action, input_digest: text(args.input_digest, "input_digest"), result_digest: text(args.result_digest, "result_digest"), status: "observed", reobserved: args.reobserved === true, effect: work.effect });
        const saved = this.store.save("verified_work", String(work.id), { ...payload(work), status: "running", phase: "action_observed", action_count: Number(work.action_count ?? 0) + 1, last_receipt_id: receipt.id });
        return { receipt, work: saved, idempotent: false };
    }
    reobserve(args) {
        const work = this.store.get("verified_work", text(args.work_id, "work_id"));
        const observed = text(args.observed_digest, "observed_digest");
        const expected = text(args.expected_digest ?? work.workspace_digest, "expected_digest");
        const drifted = observed !== expected;
        const status = drifted ? "needs_replan" : "observed";
        const saved = this.store.save("verified_work", String(work.id), { ...payload(work), status, phase: drifted ? "drift_detected" : "reobserved", observed_digest: observed, reobserve_count: Number(work.reobserve_count ?? 0) + 1 });
        return { work: saved, drifted, status };
    }
    deliver(args) {
        const work = this.store.get("verified_work", text(args.work_id, "work_id"));
        if (work.status !== "observed")
            throw new Error("Delivery requires a re-observed work state");
        const verdict = text(args.acceptance_verdict, "acceptance_verdict");
        const artifactIds = list(args.artifact_ids, "artifact_ids");
        const evidenceIds = list(args.evidence_ids, "evidence_ids");
        if (verdict !== "passed") {
            const blocked = this.store.save("verified_work", String(work.id), { ...payload(work), status: "blocked", phase: "acceptance_failed", acceptance_verdict: verdict });
            return { work: blocked, delivered: false };
        }
        if (!artifactIds.length || !evidenceIds.length)
            throw new Error("Passed delivery requires artifacts and evidence");
        const delivery = this.store.create("verified_delivery", `verified_delivery_${work.id}`, { work_id: work.id, acceptance_verdict: verdict, artifact_ids: artifactIds, evidence_ids: evidenceIds, delivery_digest: digest({ work_id: work.id, verdict, artifactIds, evidenceIds }) });
        const saved = this.store.save("verified_work", String(work.id), { ...payload(work), status: "delivered", phase: "delivered", delivery_id: delivery.id, acceptance_verdict: verdict });
        return { work: saved, delivery, delivered: true };
    }
    resume(args) {
        const work = this.store.get("verified_work", text(args.work_id, "work_id"));
        if (!["paused", "needs_replan", "interrupted"].includes(String(work.status)))
            throw new Error("Only paused or interrupted work can resume");
        const contextDigest = text(args.context_digest, "context_digest");
        const observedDigest = text(args.observed_digest, "observed_digest");
        if (contextDigest !== text(args.expected_context_digest ?? contextDigest, "expected_context_digest"))
            throw new Error("Resume context changed; replan required");
        const saved = this.store.save("verified_work", String(work.id), { ...payload(work), status: "authorized", phase: "resumed", context_digest: contextDigest, observed_digest: observedDigest, resume_count: Number(work.resume_count ?? 0) + 1 });
        return { work: saved, resumed: true };
    }
    handoff(args) {
        const work = this.store.get("verified_work", text(args.work_id, "work_id"));
        if (!["authorized", "running", "paused", "needs_replan"].includes(String(work.status)))
            throw new Error("Work is not handoffable");
        const targetHost = text(args.target_host, "target_host");
        const handoffId = String(args.handoff_id ?? `verified_handoff_${randomUUID().replaceAll("-", "")}`);
        const identity = { work_id: work.id, target_host: targetHost, context_manifest_id: work.context_manifest_id, action_count: work.action_count, allowed_effect: work.effect, resume_digest: digest({ work_id: work.id, targetHost, action_count: work.action_count }) };
        const existing = this.store.find("verified_handoff", handoffId);
        if (existing)
            return { handoff: existing, idempotent: true };
        const handoff = this.store.create("verified_handoff", handoffId, { ...identity, status: "ready" });
        const saved = this.store.save("verified_work", String(work.id), { ...payload(work), status: "paused", phase: "handoff", handoff_id: handoff.id });
        return { handoff, work: saved, idempotent: false };
    }
    get(args) { return { work: this.store.get("verified_work", text(args.work_id, "work_id")) }; }
}
/** Platform claims are admitted only after verifier-attributed conformance. */
export class SandboxConformanceKernel {
    store;
    constructor(store) { this.store = store; }
    save(args) {
        const id = String(args.profile_id ?? `sandbox_conformance_${text(args.platform, "platform")}`);
        const platform = text(args.platform, "platform");
        const checks = object(args.checks, "checks");
        const record = { platform, isolation: text(args.isolation, "isolation"), network: text(args.network, "network"), checks, verifier: text(args.verifier, "verifier"), status: args.status === undefined ? "unverified" : text(args.status, "status"), capabilities: list(args.capabilities, "capabilities") };
        const existing = this.store.find("sandbox_conformance", id);
        return { profile: existing ? this.store.save("sandbox_conformance", id, { ...payload(existing), ...record }) : this.store.create("sandbox_conformance", id, record), idempotent: false };
    }
    admit(args) {
        const effect = text(args.effect, "effect");
        if (!EFFECTS.has(effect))
            throw new Error("Unsupported effect");
        if (effect === "read_only")
            return { allowed: true, reason: "portable_read_only", profile: null };
        const profile = this.store.get("sandbox_conformance", text(args.profile_id, "profile_id"));
        const allowed = profile.status === "verified" && profile.isolation === "verified" && profile.network === "deny" && profile.capabilities.includes(effect);
        if (!allowed)
            throw new Error("Platform conformance does not admit this effect");
        return { allowed: true, reason: "verified_platform_boundary", profile };
    }
    get(args) { return { profile: this.store.get("sandbox_conformance", text(args.profile_id, "profile_id")) }; }
}
/** Content-free Trace Explorer projection for user-facing diagnostics. */
export class TraceExplorerKernel {
    store;
    constructor(store) { this.store = store; }
    query(args = {}) {
        const limit = args.limit === undefined ? 100 : Number(args.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 10_000)
            throw new Error("limit must be between 1 and 10000");
        const traces = this.store.list("trace", limit, (item) => (args.task_id === undefined || item.task_id === args.task_id) && (args.status === undefined || item.status === args.status));
        const rows = traces.map((trace) => ({ trace, events: this.store.list("trace_event", 10_000, (event) => event.trace_id === trace.id).map((event) => ({ id: event.id, sequence: event.sequence, event_kind: event.event_kind, source: event.source, trust: event.trust, usage: event.usage ?? null, data_digest: digest(event.data ?? {}) })) }));
        return { traces: rows, count: rows.length };
    }
}
//# sourceMappingURL=v01212-verified-work.js.map