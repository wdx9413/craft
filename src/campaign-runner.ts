import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";
import { EvalCampaignKernel } from "./eval-campaign.ts";

function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function payload(record: JsonObject): JsonObject { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }

/**
 * A Host-neutral campaign driver. It may issue one pinned slot at a time, but
 * never starts a hidden Host or invents an Outcome; the Host returns a TaskRun
 * and the existing EvalCampaign verifies environment/budget before binding.
 */
export class CampaignRunnerKernel {
  readonly store: CraftStore; readonly campaigns: EvalCampaignKernel;
  constructor(store: CraftStore, campaigns: EvalCampaignKernel) { this.store = store; this.campaigns = campaigns; }

  create(args: JsonObject): JsonObject {
    const campaign = this.store.get("eval_campaign", text(args.campaign_id, "campaign_id"));
    const identity = { campaign_id: campaign.id, campaign_version: campaign.version, environment_digest: campaign.environment_digest, budget_digest: campaign.budget_digest, evaluator_ref: text(args.evaluator_ref, "evaluator_ref"), mode: "host_bound" };
    const runnerId = String(args.runner_id ?? `campaign_runner_${campaign.id}`); const existing = this.store.find("campaign_runner", runnerId); const identityDigest = digest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Campaign Runner idempotency conflict"); return { runner: existing, idempotent: true }; }
    return { runner: this.store.create("campaign_runner", runnerId, { ...identity, identity_digest: identityDigest, lifecycle: "ready", issued_slot_ids: [], bound_slot_ids: [] }), idempotent: false };
  }

  claim(args: JsonObject): JsonObject {
    const runner = this.store.get("campaign_runner", text(args.runner_id, "runner_id")); if (runner.lifecycle === "completed") throw new Error("Campaign Runner is completed");
    const slots = this.slots(runner); const issued = new Set(runner.issued_slot_ids as string[]); const next = slots.find((slot) => slot.status === "pending" && !issued.has(String(slot.id)));
    if (!next) return { runner, dispatch: null, next_action: "advance_campaign" };
    const identity = { runner_id: runner.id, runner_version: runner.version, slot_id: next.id, slot_version: next.version, case_id: next.case_id, case_version: next.case_version, arm: next.arm, harness: next.harness, environment_digest: runner.environment_digest, budget_digest: runner.budget_digest, evaluator_ref: runner.evaluator_ref };
    const dispatchId = String(args.dispatch_id ?? `campaign_dispatch_${runner.id}_${next.id}`); const dispatchDigest = digest(identity);
    const dispatch = this.store.create("campaign_runner_dispatch", dispatchId, { ...identity, dispatch_digest: dispatchDigest, status: "issued" });
    const saved = this.store.save("campaign_runner", String(runner.id), { ...payload(runner), lifecycle: "collecting", issued_slot_ids: [...issued, String(next.id)].sort() });
    this.store.appendEvent(`campaign-runner:${saved.id}`, "campaign_runner.claimed", { dispatch_id: dispatch.id, slot_id: next.id });
    return { runner: saved, dispatch, next_action: "prepare_bound_task_run" };
  }

  bind(args: JsonObject): JsonObject {
    const dispatch = this.store.get("campaign_runner_dispatch", text(args.dispatch_id, "dispatch_id")); const runner = this.store.get("campaign_runner", String(dispatch.runner_id)); const taskRunId = text(args.task_run_id, "task_run_id");
    if (dispatch.status === "bound" && dispatch.task_run_id === taskRunId) return { runner, dispatch, slot: this.store.get("eval_campaign_slot", String(dispatch.slot_id)), idempotent: true };
    if (dispatch.status !== "issued") throw new Error("Campaign Runner dispatch is not issuable");
    const bound = this.campaigns.bind({ slot_id: dispatch.slot_id, task_run_id: taskRunId }); const slot = bound.slot as JsonObject;
    const savedDispatch = this.store.save("campaign_runner_dispatch", String(dispatch.id), { ...payload(dispatch), status: "bound", task_run_id: taskRunId, task_run_version: this.store.get("task_run", taskRunId).version });
    const boundIds = [...new Set([...(runner.bound_slot_ids as string[]), String(slot.id)])].sort(); const saved = this.store.save("campaign_runner", String(runner.id), { ...payload(runner), bound_slot_ids: boundIds });
    this.store.appendEvent(`campaign-runner:${saved.id}`, "campaign_runner.bound", { dispatch_id: savedDispatch.id, slot_id: slot.id, task_run_id: taskRunId });
    return { runner: saved, dispatch: savedDispatch, slot, idempotent: false };
  }

  advance(args: JsonObject): JsonObject {
    const runner = this.store.get("campaign_runner", text(args.runner_id, "runner_id")); const campaign = this.store.get("eval_campaign", String(runner.campaign_id)); const result = this.campaigns.advance({ campaign_id: campaign.id }); const status = String(result.status);
    const lifecycle = ["eligible", "rejected", "inconclusive"].includes(status) ? "completed" : "collecting"; const saved = this.store.save("campaign_runner", String(runner.id), { ...payload(runner), lifecycle, campaign_lifecycle: status, evaluation_run_id: (result.evaluation as JsonObject | null)?.id ?? null });
    this.store.appendEvent(`campaign-runner:${saved.id}`, "campaign_runner.advanced", { campaign_id: campaign.id, status });
    return { runner: saved, campaign: result };
  }

  get(args: JsonObject): JsonObject { const runner = this.store.get("campaign_runner", text(args.runner_id, "runner_id")); return { runner, campaign: this.campaigns.get({ campaign_id: runner.campaign_id }), dispatches: this.store.list("campaign_runner_dispatch", 10_000, (item) => item.runner_id === runner.id), timeline: this.store.events(`campaign-runner:${runner.id}`) }; }
  private slots(runner: JsonObject): JsonObject[] { return this.store.list("eval_campaign_slot", 10_000, (item) => item.campaign_id === runner.campaign_id).sort((left, right) => String(left.id).localeCompare(String(right.id))); }
}
