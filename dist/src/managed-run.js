import { createHash } from "node:crypto";
import { CraftStore } from "./store.js";
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function ids(value, name) { if (value === undefined)
    return []; if (!Array.isArray(value))
    throw new Error(`${name} must be an array`); const result = value.map((item) => text(item, name)); if (new Set(result).size !== result.length)
    throw new Error(`${name} must be unique`); return result.sort(); }
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function payload(record) { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
/**
 * Durable, host-neutral spine for a verified loop.  It stores only immutable
 * references and digests: a Host keeps the prompt/session, Craft keeps the
 * facts required to safely observe, hand off, replay in shadow, or replan.
 */
export class ManagedRunKernel {
    store;
    constructor(store) { this.store = store; }
    create(args) {
        const loop = this.store.get("verified_work_loop", text(args.work_loop_id, "work_loop_id"));
        const run = this.store.get("task_run", String(loop.task_run_id));
        const identity = { work_loop_id: loop.id, work_loop_version: loop.version, task_run_id: run.id, task_run_version: run.version, task_id: loop.task_id, workspace_id: loop.workspace_id, initial_snapshot_id: loop.latest_snapshot_id, initial_snapshot_version: this.store.get("state_snapshot", String(loop.latest_snapshot_id)).version };
        const managedRunId = String(args.managed_run_id ?? `managed_run_${run.id}`);
        const existing = this.store.find("managed_run", managedRunId);
        const identityDigest = digest(identity);
        if (existing) {
            if (existing.identity_digest !== identityDigest)
                throw new Error("Managed Run idempotency conflict");
            return { run: existing, idempotent: true };
        }
        const created = this.store.create("managed_run", managedRunId, { ...identity, identity_digest: identityDigest, lifecycle: "active", session_count: 1, latest_handoff_id: null, latest_observation_id: null, replan_reason: null });
        this.event(created, "created", { snapshot_id: identity.initial_snapshot_id, task_run_id: run.id });
        return { run: created, idempotent: false };
    }
    observe(args) {
        const run = this.store.get("managed_run", text(args.managed_run_id, "managed_run_id"));
        const loop = this.store.get("verified_work_loop", String(run.work_loop_id));
        const state = this.store.get("task_run_state", text(args.task_run_state_id, "task_run_state_id"));
        const snapshot = this.store.get("state_snapshot", text(args.snapshot_id, "snapshot_id"));
        if (state.task_run_id !== run.task_run_id || snapshot.workspace_id !== run.workspace_id)
            throw new Error("Managed Run observation does not belong to its Task Run or Workspace");
        const receiptId = text(args.work_loop_receipt_id, "work_loop_receipt_id");
        const receipt = this.store.get("verified_work_loop_receipt", receiptId);
        if (receipt.work_loop_id !== loop.id || receipt.task_run_state_id !== state.id || receipt.snapshot_id !== snapshot.id)
            throw new Error("Managed Run requires the exact Verified Work Loop receipt");
        const status = loop.lifecycle === "needs_replan" || state.status === "needs_replan" ? "needs_replan" : state.status === "paused" ? "paused" : "active";
        const observationIdentity = { managed_run_id: run.id, task_run_state_id: state.id, task_run_state_version: state.version, snapshot_id: snapshot.id, snapshot_version: snapshot.version, work_loop_receipt_id: receipt.id, work_loop_receipt_version: receipt.version, status };
        const observationId = String(args.observation_id ?? `managed_run_observation_${run.id}_${digest(observationIdentity).slice(-16)}`);
        const existing = this.store.find("managed_run_observation", observationId);
        const observationDigest = digest(observationIdentity);
        if (existing) {
            if (existing.observation_digest !== observationDigest)
                throw new Error("Managed Run observation idempotency conflict");
            return { run, observation: existing, idempotent: true };
        }
        const observation = this.store.create("managed_run_observation", observationId, { ...observationIdentity, observation_digest: observationDigest });
        const saved = this.store.save("managed_run", String(run.id), { ...payload(run), lifecycle: status, latest_observation_id: observation.id, latest_snapshot_id: snapshot.id, latest_task_run_state_id: state.id, replan_reason: status === "needs_replan" ? String(loop.needs_replan_reason ?? "observed_input_or_workspace_drift") : null });
        this.event(saved, "observed", { observation_id: observation.id, status });
        return { run: saved, observation, idempotent: false };
    }
    handoff(args) {
        const run = this.store.get("managed_run", text(args.managed_run_id, "managed_run_id"));
        const observation = this.store.get("managed_run_observation", text(args.observation_id, "observation_id"));
        if (observation.managed_run_id !== run.id)
            throw new Error("Managed Run Handoff must use this Run's observation");
        const artifactIds = ids(args.artifact_ids, "artifact_ids");
        const evidenceIds = ids(args.evidence_ids, "evidence_ids");
        for (const id of artifactIds)
            this.store.get("artifact", id);
        for (const id of evidenceIds)
            this.store.get("evidence", id);
        const identity = { managed_run_id: run.id, observation_id: observation.id, observation_version: observation.version, reason_digest: digest(text(args.reason, "reason")), artifact_ids: artifactIds, evidence_ids: evidenceIds, resume_action: args.resume_action === undefined ? "reobserve_and_resume" : text(args.resume_action, "resume_action") };
        const handoffId = String(args.handoff_id ?? `managed_run_handoff_${run.id}_${digest(identity).slice(-16)}`);
        const existing = this.store.find("managed_run_handoff", handoffId);
        const identityDigest = digest(identity);
        if (existing) {
            if (existing.identity_digest !== identityDigest)
                throw new Error("Managed Run Handoff idempotency conflict");
            return { run, handoff: existing, idempotent: true };
        }
        const handoff = this.store.create("managed_run_handoff", handoffId, { ...identity, identity_digest: identityDigest });
        const saved = this.store.save("managed_run", String(run.id), { ...payload(run), lifecycle: "paused", latest_handoff_id: handoff.id });
        this.event(saved, "handoff", { handoff_id: handoff.id, observation_id: observation.id });
        return { run: saved, handoff, idempotent: false };
    }
    resume(args) {
        const run = this.store.get("managed_run", text(args.managed_run_id, "managed_run_id"));
        const handoff = this.store.get("managed_run_handoff", text(args.handoff_id, "handoff_id"));
        if (handoff.managed_run_id !== run.id)
            throw new Error("Managed Run Resume must use this Run's handoff");
        const observation = this.store.get("managed_run_observation", text(args.observation_id, "observation_id"));
        if (observation.managed_run_id !== run.id)
            throw new Error("Managed Run Resume must use this Run's fresh observation");
        const stale = String(observation.status) === "needs_replan";
        const lifecycle = stale ? "needs_replan" : "active";
        const saved = this.store.save("managed_run", String(run.id), { ...payload(run), lifecycle, session_count: Number(run.session_count) + 1, latest_handoff_id: handoff.id, latest_observation_id: observation.id, replan_reason: stale ? "handoff_inputs_changed" : null });
        this.event(saved, lifecycle === "active" ? "resumed" : "replan_required", { handoff_id: handoff.id, observation_id: observation.id });
        return { run: saved, resumed: lifecycle === "active", next_action: lifecycle === "active" ? "host_may_continue_from_handoff" : "prepare_fresh_work_loop" };
    }
    forkShadow(args) {
        const source = this.store.get("managed_run", text(args.managed_run_id, "managed_run_id"));
        const handoff = this.store.get("managed_run_handoff", text(args.handoff_id, "handoff_id"));
        if (handoff.managed_run_id !== source.id)
            throw new Error("Shadow fork must use the source Run handoff");
        const forkId = String(args.fork_id ?? `managed_run_shadow_${source.id}_${handoff.id}`);
        const existing = this.store.find("managed_run_shadow", forkId);
        const identity = { source_managed_run_id: source.id, source_managed_run_version: source.version, handoff_id: handoff.id, handoff_version: handoff.version, mode: "shadow_read_only", external_effects_allowed: false };
        const identityDigest = digest(identity);
        if (existing) {
            if (existing.identity_digest !== identityDigest)
                throw new Error("Managed Run Shadow idempotency conflict");
            return { fork: existing, idempotent: true };
        }
        return { fork: this.store.create("managed_run_shadow", forkId, { ...identity, identity_digest: identityDigest, lifecycle: "prepared" }), idempotent: false };
    }
    get(args) { const run = this.store.get("managed_run", text(args.managed_run_id, "managed_run_id")); return { run, observations: this.store.list("managed_run_observation", 1000, (item) => item.managed_run_id === run.id), handoffs: this.store.list("managed_run_handoff", 1000, (item) => item.managed_run_id === run.id), shadows: this.store.list("managed_run_shadow", 1000, (item) => item.source_managed_run_id === run.id), timeline: this.store.events(`managed-run:${run.id}`) }; }
    event(run, type, data) { this.store.appendEvent(`managed-run:${run.id}`, `managed_run.${type}`, data); }
}
//# sourceMappingURL=managed-run.js.map