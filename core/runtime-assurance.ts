import { createHash } from "node:crypto";
import { CampaignRunnerKernel } from "./campaign-runner.ts";
import { PlatformExecutionKernel } from "./platform-execution.ts";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { text } from "./validation.ts";
import { digestJson } from "./digest.ts";

const TERMINAL_HOST = new Set(["completed", "failed", "cancelled", "interrupted"]);
const INTERVENTIONS = new Set(["notify", "question", "steer", "approval", "pause", "resume", "timeout", "cancel", "abort", "retry", "revoke", "handoff"]);



function ids(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const result = value.map((item) => text(item, name));
  if (new Set(result).size !== result.length) throw new Error(`${name} must be unique`);
  return result.sort();
}

/**
 * The evidence seam for a real Host attempt. Callers provide one exact Task Run
 * and the current environment/budget; this module proves they still match the
 * recorded Host receipt, re-observation, Delivery, and (for writes) verified
 * platform boundary. It never executes a Host or invents an Outcome.
 */
export class RuntimeAssuranceKernel {
  readonly store: CraftStore;
  readonly platform: PlatformExecutionKernel;
  readonly campaigns: CampaignRunnerKernel;

  constructor(store: CraftStore, platform: PlatformExecutionKernel, campaigns: CampaignRunnerKernel) {
    this.store = store; this.platform = platform; this.campaigns = campaigns;
  }

  attest(args: JsonObject): JsonObject {
    const taskRun = this.store.get("task_run", text(args.task_run_id, "task_run_id"));
    const launch = this.store.get("work_launch", String(taskRun.launch_id));
    const hostRun = this.store.get("host_run", text(args.host_run_id ?? launch.run_id, "host_run_id"));
    const taskId = (taskRun.launch_identity as JsonObject).task_id;
    if (hostRun.id !== launch.run_id || hostRun.task_id !== taskId || !TERMINAL_HOST.has(String(hostRun.status))) {
      throw new Error("Runtime Assurance requires the Task Run's terminal Host receipt");
    }
    const environmentDigest = digestJson(args.environment ?? {}); const budgetDigest = digestJson(args.budget ?? {});
    if (environmentDigest !== taskRun.environment_digest || budgetDigest !== taskRun.budget_digest) {
      throw new Error("Runtime Assurance environment or budget drift requires replanning");
    }
    const contract = this.store.get("task_control_contract", String(taskRun.contract_id));
    const effect = text(args.effect ?? "read_only", "effect");
    if (!(contract.allowed_effects as string[]).includes(effect)) throw new Error("Runtime Assurance effect is not allowed by the Task Contract");
    const reobservation = this.reobservation(taskRun, launch, args);
    const boundary = effect === "read_only" ? null : this.boundary(args);
    const deliveries = this.store.list("work_delivery", 10_000, (item) => item.launch_id === launch.id)
      .sort((left, right) => Number(right.version) - Number(left.version));
    const delivery = deliveries[0] ?? null;
    const status = reobservation.status === "needs_replan" ? "needs_replan"
      : hostRun.status !== "completed" ? "rejected"
        : delivery?.status === "accepted" || (launch.acceptance_plan_id === undefined && delivery?.status === "ready_for_delivery")
          ? "verified" : "needs_review";
    const evidenceIds = ids(args.evidence_ids, "evidence_ids"); for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    const identity = {
      task_run_id: taskRun.id, task_run_version: taskRun.version, host_run_id: hostRun.id, host_run_version: hostRun.version,
      launch_id: launch.id, launch_version: launch.version, effect, environment_digest: environmentDigest, budget_digest: budgetDigest,
      reobservation, boundary, delivery_id: delivery?.id ?? null, delivery_version: delivery?.version ?? null,
      evidence_ids: evidenceIds, status,
    };
    const attestationId = String(args.attestation_id ?? `runtime_assurance_${taskRun.id}_${digestJson(identity).slice(-16)}`);
    const existing = this.store.find("runtime_assurance_attestation", attestationId); const attestationDigest = digestJson(identity);
    if (existing) { if (existing.attestation_digest !== attestationDigest) throw new Error("Runtime Assurance attestation idempotency conflict"); return { attestation: existing, idempotent: true }; }
    const attestation = this.store.create("runtime_assurance_attestation", attestationId, { ...identity, attestation_digest: attestationDigest, raw_content_stored: false });
    this.event(String(taskRun.id), "attested", { attestation_id: String(attestation.id), host_run_id: String(hostRun.id), status, effect });
    return { attestation, idempotent: false };
  }

  intervene(args: JsonObject): JsonObject {
    const taskRun = this.store.get("task_run", text(args.task_run_id, "task_run_id")); const kind = text(args.kind, "kind");
    if (!INTERVENTIONS.has(kind)) throw new Error("Runtime Assurance intervention kind is unsupported");
    const evidenceIds = ids(args.evidence_ids, "evidence_ids"); for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    const identity = { task_run_id: taskRun.id, task_run_version: taskRun.version, kind, actor: text(args.actor, "actor"),
      reason_digest: digestJson(text(args.reason, "reason")), evidence_ids: evidenceIds };
    const interventionId = String(args.intervention_id ?? `runtime_intervention_${taskRun.id}_${digestJson(identity).slice(-16)}`);
    const existing = this.store.find("runtime_intervention", interventionId); const interventionDigest = digestJson(identity);
    if (existing) { if (existing.intervention_digest !== interventionDigest) throw new Error("Runtime Assurance intervention idempotency conflict"); return { intervention: existing, idempotent: true }; }
    const intervention = this.store.create("runtime_intervention", interventionId, { ...identity, intervention_digest: interventionDigest, raw_content_stored: false });
    this.event(String(taskRun.id), "intervened", { intervention_id: String(intervention.id), kind });
    return { intervention, idempotent: false };
  }

  campaignAdvance(args: JsonObject): JsonObject {
    const runner = this.store.get("campaign_runner", text(args.runner_id, "runner_id"));
    const campaign = this.store.get("eval_campaign", String(runner.campaign_id));
    const slots = this.store.list("eval_campaign_slot", 10_000, (item) => item.campaign_id === campaign.id);
    if (slots.some((slot) => slot.status !== "bound")) throw new Error("Runtime Assurance Campaign requires every Campaign slot to be bound");
    const assuranceIds = slots.map((slot) => {
      const matches = this.store.list("runtime_assurance_attestation", 10_000,
        (item) => item.task_run_id === slot.task_run_id && item.status === "verified" && item.environment_digest === campaign.environment_digest && item.budget_digest === campaign.budget_digest)
        .sort((left, right) => Number(right.version) - Number(left.version));
      if (!matches[0]) throw new Error("Runtime Assurance Campaign requires a verified attestation for every bound Task Run");
      return String(matches[0].id);
    }).sort();
    const identity = { runner_id: runner.id, campaign_id: campaign.id, environment_digest: campaign.environment_digest, budget_digest: campaign.budget_digest, assurance_ids: assuranceIds };
    const recordId = String(args.assurance_campaign_id ?? `runtime_assurance_campaign_${runner.id}_${digestJson(identity).slice(-16)}`);
    const existing = this.store.find("runtime_assurance_campaign", recordId); const recordDigest = digestJson(identity);
    if (existing) {
      if (existing.assurance_campaign_digest !== recordDigest) throw new Error("Runtime Assurance Campaign idempotency conflict");
      return { assurance_campaign: existing, result: this.campaigns.get({ runner_id: runner.id }), idempotent: true };
    }
    const result = this.campaigns.advance({ runner_id: runner.id });
    const record = this.store.create("runtime_assurance_campaign", recordId, { ...identity, assurance_campaign_digest: recordDigest,
      status: (result.runner as JsonObject).campaign_lifecycle ?? "collecting" });
    return { assurance_campaign: record, result, idempotent: false };
  }

  get(args: JsonObject): JsonObject {
    const taskRun = this.store.get("task_run", text(args.task_run_id, "task_run_id"));
    return {
      task_run: taskRun,
      attestations: this.store.list("runtime_assurance_attestation", 10_000, (item) => item.task_run_id === taskRun.id),
      interventions: this.store.list("runtime_intervention", 10_000, (item) => item.task_run_id === taskRun.id),
      timeline: this.store.events(`runtime-assurance:${taskRun.id}`),
    };
  }

  private reobservation(taskRun: JsonObject, launch: JsonObject, args: JsonObject): JsonObject {
    if (args.work_loop_receipt_id !== undefined) {
      const receipt = this.store.get("verified_work_loop_receipt", text(args.work_loop_receipt_id, "work_loop_receipt_id"));
      const loop = this.store.get("verified_work_loop", String(receipt.work_loop_id));
      if (loop.task_run_id !== taskRun.id || receipt.task_run_state_id !== loop.latest_task_run_state_id || receipt.snapshot_id !== loop.latest_snapshot_id) {
        throw new Error("Runtime Assurance Work Loop receipt is not the current re-observation");
      }
      return { kind: "work_loop", receipt_id: receipt.id, receipt_version: receipt.version, status: receipt.status };
    }
    const observation = this.store.get("workspace_observation", text(args.workspace_observation_id, "workspace_observation_id"));
    const workspace = this.store.get("workspace", String(observation.workspace_id));
    if (workspace.root_path !== launch.workspace) throw new Error("Runtime Assurance Workspace observation is outside the Task Run workspace");
    return { kind: "workspace", observation_id: observation.id, observation_version: observation.version, status: observation.classification === "external_unattributed" ? "needs_replan" : "observed" };
  }

  private boundary(args: JsonObject): JsonObject {
    const validated = this.platform.validate({ preflight_id: text(args.preflight_id, "preflight_id") });
    const preflight = validated.preflight as JsonObject; const profile = validated.profile as JsonObject;
    return { preflight_id: preflight.id, preflight_version: preflight.version, profile_id: profile.id, profile_version: profile.version };
  }

  private event(taskRunId: string, type: string, data: JsonObject): void { this.store.appendEvent(`runtime-assurance:${taskRunId}`, `runtime_assurance.${type}`, data); }
}
