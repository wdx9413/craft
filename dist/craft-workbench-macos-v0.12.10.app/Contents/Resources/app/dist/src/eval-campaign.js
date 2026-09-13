import { createHash } from "node:crypto";
import { CraftStore } from "./store.js";
import { TaskBenchmarkKernel } from "./task-benchmark.js";
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function positive(value, name) { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 2 || parsed > 20)
    throw new Error(`${name} must be an integer between 2 and 20`); return parsed; }
function payload(record) { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
/** Plans Case × Harness × Trial slots. Hosts bind observed runs; this kernel never starts hidden model work. */
export class EvalCampaignKernel {
    store;
    benchmarks;
    constructor(store, benchmarks) { this.store = store; this.benchmarks = benchmarks; }
    create(args) {
        const caseIds = Array.isArray(args.case_ids) ? args.case_ids.map((item) => text(item, "case_ids")) : [];
        if (!caseIds.length || new Set(caseIds).size !== caseIds.length)
            throw new Error("case_ids must be a unique non-empty array");
        const cases = caseIds.map((caseId) => this.store.get("delivery_evaluation_case", caseId));
        if (cases.some((item) => item.partition !== "held_out" || item.sanitized !== true))
            throw new Error("Eval Campaign requires sanitized held_out Cases");
        const trials = positive(args.trials_per_case, "trials_per_case");
        const environment = digest(args.environment ?? {});
        const budget = digest(args.budget ?? {});
        const acceptance = text(args.acceptance_ref, "acceptance_ref");
        const identity = { case_ids: caseIds, case_versions: cases.map((item) => ({ id: item.id, version: item.version })), baseline_harness: text(args.baseline_harness, "baseline_harness"), candidate_harness: text(args.candidate_harness, "candidate_harness"), trials_per_case: trials, environment_digest: environment, budget_digest: budget, acceptance_ref: acceptance };
        const campaignId = String(args.campaign_id ?? `eval_campaign_${digest(identity).slice(-16)}`);
        const existing = this.store.find("eval_campaign", campaignId);
        const identityDigest = digest(identity);
        if (existing) {
            if (existing.identity_digest !== identityDigest)
                throw new Error("Eval Campaign idempotency conflict");
            return { campaign: existing, slots: this.slots(String(existing.id)), idempotent: true };
        }
        const campaign = this.store.create("eval_campaign", campaignId, { ...identity, identity_digest: identityDigest, lifecycle: "collecting", publication_allowed: false });
        const slots = cases.flatMap((item) => Array.from({ length: trials }, (_, index) => ["baseline", "candidate"].map((arm) => this.store.create("eval_campaign_slot", `eval_slot_${campaign.id}_${item.id}_${index + 1}_${arm}`, { campaign_id: campaign.id, case_id: item.id, case_version: item.version, trial: index + 1, arm, harness: arm === "baseline" ? identity.baseline_harness : identity.candidate_harness, task_run_id: null, status: "pending" })))).flat();
        return { campaign, slots, idempotent: false };
    }
    bind(args) {
        const slot = this.store.get("eval_campaign_slot", text(args.slot_id, "slot_id"));
        const campaign = this.store.get("eval_campaign", String(slot.campaign_id));
        const run = this.store.get("task_run", text(args.task_run_id, "task_run_id"));
        if (slot.status === "bound" && slot.task_run_id === run.id)
            return { slot, idempotent: true };
        if (slot.status !== "pending")
            throw new Error("Eval Campaign Slot is already bound");
        if (run.environment_digest !== campaign.environment_digest || run.budget_digest !== campaign.budget_digest)
            throw new Error("Eval Campaign Run does not meet the campaign environment or budget");
        return { slot: this.store.save("eval_campaign_slot", String(slot.id), { ...payload(slot), task_run_id: run.id, task_run_version: run.version, status: "bound" }), idempotent: false };
    }
    advance(args) {
        const campaign = this.store.get("eval_campaign", text(args.campaign_id, "campaign_id"));
        const slots = this.slots(String(campaign.id));
        if (slots.some((slot) => slot.status !== "bound"))
            return { campaign, status: "collecting", benchmarks: [], evaluation: null };
        const pairs = new Map();
        for (const slot of slots) {
            const key = `${slot.case_id}:${slot.trial}`;
            pairs.set(key, [...(pairs.get(key) ?? []), slot]);
        }
        const benchmarks = [...pairs.entries()].map(([key, pair]) => { const baseline = pair.find((slot) => slot.arm === "baseline"); const candidate = pair.find((slot) => slot.arm === "candidate"); if (!baseline || !candidate)
            throw new Error("Eval Campaign pair is incomplete"); const benchmark = this.benchmarks.create({ benchmark_id: `eval_campaign_benchmark_${campaign.id}_${key.replace(':', '_')}`, case_id: baseline.case_id, baseline_task_run_id: baseline.task_run_id, candidate_task_run_id: candidate.task_run_id }).benchmark; return this.benchmarks.evaluate({ benchmark_id: benchmark.id }).benchmark; });
        if (benchmarks.some((item) => item.status === "awaiting_delivery"))
            return { campaign, status: "awaiting_delivery", benchmarks, evaluation: null };
        if (benchmarks.some((item) => item.status !== "ready_for_aggregate"))
            return { campaign: this.store.save("eval_campaign", String(campaign.id), { ...payload(campaign), lifecycle: "inconclusive" }), status: "inconclusive", benchmarks, evaluation: null };
        const evaluation = this.benchmarks.aggregate({ benchmark_ids: benchmarks.map((item) => item.id), run_id: `eval_campaign_run_${campaign.id}`, min_trials: campaign.trials_per_case }).evaluation;
        const lifecycle = evaluation.status === "eligible_for_signoff" ? "eligible" : evaluation.status === "rejected" ? "rejected" : "inconclusive";
        return { campaign: this.store.save("eval_campaign", String(campaign.id), { ...payload(campaign), lifecycle, evaluation_run_id: evaluation.id, evaluation_run_version: evaluation.version }), status: lifecycle, benchmarks, evaluation };
    }
    get(args) { const campaign = this.store.get("eval_campaign", text(args.campaign_id, "campaign_id")); return { campaign, slots: this.slots(String(campaign.id)) }; }
    slots(campaignId) { return this.store.list("eval_campaign_slot", 10_000, (item) => item.campaign_id === campaignId); }
}
//# sourceMappingURL=eval-campaign.js.map