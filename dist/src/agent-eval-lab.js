import { createHash } from "node:crypto";
import { CraftStore } from "./store.js";
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function taskId(run) {
    const fromLaunch = run.launch_identity && typeof run.launch_identity === "object" && !Array.isArray(run.launch_identity) ? run.launch_identity.task_id : undefined;
    return text(run.task_id ?? fromLaunch, "Task Run task_id");
}
/** Immutable links between a pinned Campaign slot and an observed Host run. */
export class AgentEvalLabKernel {
    store;
    constructor(store) { this.store = store; }
    create(args) {
        const runner = this.store.get("campaign_runner", text(args.runner_id, "runner_id"));
        const campaign = this.store.get("eval_campaign", String(runner.campaign_id));
        const identity = { runner_id: runner.id, runner_version: runner.version, campaign_id: campaign.id, campaign_version: campaign.version, environment_digest: campaign.environment_digest, budget_digest: campaign.budget_digest };
        const labId = String(args.lab_id ?? `agent_eval_lab_${runner.id}`);
        const existing = this.store.find("agent_eval_lab", labId);
        const identityDigest = digest(identity);
        if (existing) {
            if (existing.identity_digest !== identityDigest)
                throw new Error("Agent Eval Lab idempotency conflict");
            return { lab: existing, idempotent: true };
        }
        return { lab: this.store.create("agent_eval_lab", labId, { ...identity, identity_digest: identityDigest, lifecycle: "ready", attempt_ids: [] }), idempotent: false };
    }
    attach(args) {
        const lab = this.store.get("agent_eval_lab", text(args.lab_id, "lab_id"));
        const dispatch = this.store.get("campaign_runner_dispatch", text(args.dispatch_id, "dispatch_id"));
        const taskRun = this.store.get("task_run", text(args.task_run_id, "task_run_id"));
        const hostRun = this.store.get("host_run", text(args.host_run_id, "host_run_id"));
        const coordinator = this.store.get("work_coordinator", text(args.coordinator_id, "coordinator_id"));
        if (dispatch.runner_id !== lab.runner_id || taskRun.environment_digest !== lab.environment_digest || taskRun.budget_digest !== lab.budget_digest)
            throw new Error("Agent Eval attempt is not comparable to its Lab");
        if (coordinator.active_host_run_id !== hostRun.id || hostRun.task_id !== taskId(taskRun))
            throw new Error("Agent Eval attempt requires the exact coordinated Host Run");
        const identity = {
            lab_id: lab.id,
            lab_identity_digest: lab.identity_digest,
            dispatch_id: dispatch.id,
            dispatch_version: dispatch.version,
            slot_id: dispatch.slot_id,
            task_run_id: taskRun.id,
            task_run_version: taskRun.version,
            host_run_id: hostRun.id,
            coordinator_id: coordinator.id,
            coordinator_identity_digest: coordinator.identity_digest,
        };
        const attemptId = String(args.attempt_id ?? `agent_eval_attempt_${dispatch.id}`);
        const existing = this.store.find("agent_eval_attempt", attemptId);
        const identityDigest = digest(identity);
        if (existing) {
            if (existing.identity_digest !== identityDigest)
                throw new Error("Agent Eval attempt idempotency conflict");
            return { lab, attempt: existing, idempotent: true };
        }
        const attempt = this.store.create("agent_eval_attempt", attemptId, { ...identity, identity_digest: identityDigest, lifecycle: "running" });
        const saved = this.store.save("agent_eval_lab", String(lab.id), { ...lab, lifecycle: "collecting", attempt_ids: [...new Set([...lab.attempt_ids, String(attempt.id)])].sort() });
        return { lab: saved, attempt, idempotent: false };
    }
    observe(args) {
        const attempt = this.store.get("agent_eval_attempt", text(args.attempt_id, "attempt_id"));
        const coordinator = this.store.get("work_coordinator", String(attempt.coordinator_id));
        const run = this.store.get("host_run", String(attempt.host_run_id));
        if (coordinator.latest_observation_id !== text(args.observation_id, "observation_id"))
            throw new Error("Agent Eval outcome requires the Coordinator's latest observation");
        const observation = this.store.get("managed_run_observation", String(coordinator.latest_observation_id));
        const terminal = ["needs_replan", "paused", "observed"].includes(String(coordinator.lifecycle));
        if (!terminal || !["completed", "failed", "cancelled", "interrupted"].includes(String(run.status)))
            throw new Error("Agent Eval attempt requires a terminal Host Run and re-observation");
        const lifecycle = observation.status === "needs_replan" ? "inconclusive" : "observed";
        const saved = this.store.save("agent_eval_attempt", String(attempt.id), { ...attempt, lifecycle, observation_id: observation.id, observation_version: observation.version, host_status: run.status });
        return { attempt: saved, eligible_for_campaign: lifecycle === "observed" };
    }
    get(args) { const lab = this.store.get("agent_eval_lab", text(args.lab_id, "lab_id")); return { lab, attempts: this.store.list("agent_eval_attempt", 10_000, (item) => item.lab_id === lab.id) }; }
}
//# sourceMappingURL=agent-eval-lab.js.map