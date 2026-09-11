import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function deliveryRate(value: JsonObject | null): number { return value && ["accepted", "ready_for_delivery"].includes(String(value.status)) ? 1 : 0; }

/** Builds a content-free, repeatable Campaign report from immutable observed deliveries. */
export class EvalCampaignReportKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  report(args: JsonObject): JsonObject {
    const campaign = this.store.get("eval_campaign", text(args.campaign_id, "campaign_id"));
    const slots = this.store.list("eval_campaign_slot", 10_000, (item) => item.campaign_id === campaign.id);
    const pairs = new Map<string, JsonObject[]>();
    for (const slot of slots) pairs.set(`${slot.case_id}:${slot.trial}`, [...(pairs.get(`${slot.case_id}:${slot.trial}`) ?? []), slot]);
    const samples = [...pairs.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, pair]) => this.sample(key, pair));
    const ready = samples.filter((item) => item.status === "observed");
    const aggregate = { pairs: ready.length, baseline_delivery_rate: mean(ready.map((item) => Number(item.baseline_delivery_rate))), candidate_delivery_rate: mean(ready.map((item) => Number(item.candidate_delivery_rate))), improvement_rate: ratio(ready, (item) => item.verdict === "improved"), regression_rate: ratio(ready, (item) => item.verdict === "regressed") };
    const identity = { campaign_id: campaign.id, campaign_version: campaign.version, samples: samples.map((item) => ({ key: item.key, baseline_delivery_id: item.baseline_delivery_id, baseline_delivery_version: item.baseline_delivery_version, candidate_delivery_id: item.candidate_delivery_id, candidate_delivery_version: item.candidate_delivery_version, status: item.status })) };
    const reportId = String(args.report_id ?? `eval_campaign_report_${digest(identity).slice(-16)}`); const existing = this.store.find("eval_campaign_report", reportId); const reportDigest = digest(identity);
    if (existing) { if (existing.report_digest !== reportDigest) throw new Error("Eval Campaign report idempotency conflict"); return { report: existing, idempotent: true }; }
    return { report: this.store.create("eval_campaign_report", reportId, { ...identity, report_digest: reportDigest, lifecycle: ready.length === samples.length && samples.length > 0 ? "observed" : "collecting", aggregate, samples, business_quality_claim: false }), idempotent: false };
  }

  private sample(key: string, pair: JsonObject[]): JsonObject {
    const baseline = pair.find((item) => item.arm === "baseline"); const candidate = pair.find((item) => item.arm === "candidate");
    if (!baseline || !candidate) throw new Error("Eval Campaign report pair is incomplete");
    const baselineDelivery = this.delivery(baseline); const candidateDelivery = this.delivery(candidate);
    if (!baselineDelivery || !candidateDelivery) return { key, status: "awaiting_delivery", baseline_delivery_id: baselineDelivery?.id ?? null, baseline_delivery_version: baselineDelivery?.version ?? null, candidate_delivery_id: candidateDelivery?.id ?? null, candidate_delivery_version: candidateDelivery?.version ?? null };
    const left = deliveryRate(baselineDelivery); const right = deliveryRate(candidateDelivery);
    return { key, status: "observed", baseline_delivery_id: baselineDelivery.id, baseline_delivery_version: baselineDelivery.version, candidate_delivery_id: candidateDelivery.id, candidate_delivery_version: candidateDelivery.version, baseline_delivery_rate: left, candidate_delivery_rate: right, verdict: right > left ? "improved" : right < left ? "regressed" : "equal" };
  }

  private delivery(slot: JsonObject): JsonObject | null { if (!slot.task_run_id) return null; const run = this.store.get("task_run", String(slot.task_run_id)); return this.store.list("work_delivery", 10_000, (item) => item.launch_id === run.launch_id).at(-1) ?? null; }
}

function mean(values: number[]): number { return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0; }
function ratio<T>(values: T[], predicate: (value: T) => boolean): number { return values.length ? values.filter(predicate).length / values.length : 0; }
