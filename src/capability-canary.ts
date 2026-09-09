import { createHash, randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function number(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number { const result = Number(value); if (!Number.isFinite(result) || result < min || result > max) throw new Error(`${name} must be between ${min} and ${max}`); return result; }
function integer(value: unknown, name: string, min: number, max: number): number { const result = number(value, name, min, max); if (!Number.isInteger(result)) throw new Error(`${name} must be an integer`); return result; }
function object(value: unknown, name: string): JsonObject { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`); return value as JsonObject; }
function payload(record: JsonObject): JsonObject { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
function digest(value: string): number { return Number.parseInt(createHash("sha256").update(value).digest("hex").slice(0, 8), 16) % 10_000; }

export class CapabilityCanaryKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  start(args: JsonObject): JsonObject {
    const publication = this.store.get("contract_publication", text(args.publication_id, "publication_id")); if (publication.status !== "active") throw new Error("Canary requires an active Contract publication");
    const candidate = this.store.get("capability_asset", String(publication.asset_id), Number(publication.asset_version));
    const baseline = this.store.get("capability_asset", text(args.baseline_asset_id, "baseline_asset_id"), Number(args.baseline_asset_version));
    if (baseline.effect !== candidate.effect || baseline.asset_type !== candidate.asset_type) throw new Error("Canary assets are not comparable");
    const thresholds = object(args.thresholds, "thresholds"); for (const key of ["max_failure_rate_delta", "max_cost_ratio", "max_latency_ratio", "max_correction_rate_delta"]) number(thresholds[key], `thresholds.${key}`, 0);
    const canary = this.store.create("capability_canary", String(args.canary_id ?? `capability_canary_${randomUUID().replaceAll("-", "")}`), {
      publication_id: publication.id, baseline_asset_id: baseline.id, baseline_asset_version: baseline.version,
      candidate_asset_id: candidate.id, candidate_asset_version: candidate.version, allocation_percent: number(args.allocation_percent, "allocation_percent", 1, 50),
      min_samples_per_arm: integer(args.min_samples_per_arm, "min_samples_per_arm", 1, 10_000), thresholds, status: "running", rollback_recommended: false });
    return { canary };
  }

  route(args: JsonObject): JsonObject {
    const canary = this.store.get("capability_canary", text(args.canary_id, "canary_id")); const key = text(args.routing_key, "routing_key");
    const candidate = canary.status === "running" && digest(`${canary.id}:${key}`) < Number(canary.allocation_percent) * 100;
    return { arm: candidate ? "candidate" : "baseline", asset_id: candidate ? canary.candidate_asset_id : canary.baseline_asset_id,
      asset_version: candidate ? canary.candidate_asset_version : canary.baseline_asset_version, bucket: digest(`${canary.id}:${key}`), sticky: true };
  }

  observe(args: JsonObject): JsonObject {
    const canary = this.store.get("capability_canary", text(args.canary_id, "canary_id")); const arm = text(args.arm, "arm");
    if (!new Set(["baseline", "candidate"]).has(arm)) throw new Error("Canary arm is unsupported");
    const evidenceIds = args.evidence_ids as unknown; if (!Array.isArray(evidenceIds) || !evidenceIds.length) throw new Error("Canary observation requires Evidence");
    for (const id of evidenceIds) this.store.get("evidence", text(id, "evidence_id"));
    const outcome = text(args.outcome, "outcome"); if (!new Set(["passed", "failed"]).has(outcome)) throw new Error("Canary outcome is unsupported");
    const sampleId = text(args.sample_id, "sample_id"); const fingerprint = createHash("sha256").update(JSON.stringify({ canary_id: canary.id, arm, outcome,
      cost: args.cost, latency_ms: args.latency_ms, corrected: args.corrected === true, evidence_ids: evidenceIds })).digest("hex");
    const existing = this.store.find("capability_canary_sample", sampleId); if (existing) { if (existing.fingerprint !== fingerprint) throw new Error("Canary sample idempotency conflict"); return { sample: existing, idempotent: true }; }
    if (canary.status !== "running") throw new Error("Canary is not accepting samples");
    return { sample: this.store.create("capability_canary_sample", sampleId, { canary_id: canary.id, arm, outcome,
      cost: number(args.cost, "cost"), latency_ms: number(args.latency_ms, "latency_ms"), corrected: args.corrected === true,
      evidence_ids: evidenceIds, fingerprint }), idempotent: false };
  }

  evaluate(args: JsonObject): JsonObject {
    const canary = this.store.get("capability_canary", text(args.canary_id, "canary_id")); if (canary.status !== "running") return { canary, ready: true, idempotent: true };
    const samples = this.store.list("capability_canary_sample", 100_000, (item) => item.canary_id === canary.id);
    const aggregate = (arm: string) => { const rows = samples.filter((item) => item.arm === arm); const total = rows.length; return { total,
      failure_rate: total ? rows.filter((item) => item.outcome === "failed").length / total : null,
      mean_cost: total ? rows.reduce((sum, item) => sum + Number(item.cost), 0) / total : null,
      mean_latency_ms: total ? rows.reduce((sum, item) => sum + Number(item.latency_ms), 0) / total : null,
      correction_rate: total ? rows.filter((item) => item.corrected).length / total : null }; };
    const baseline = aggregate("baseline"); const candidate = aggregate("candidate"); const ready = baseline.total >= Number(canary.min_samples_per_arm) && candidate.total >= Number(canary.min_samples_per_arm);
    if (!ready) return { canary, ready: false, baseline, candidate };
    const thresholds = canary.thresholds as JsonObject; const checks = [
      { metric: "failure_rate", passed: Number(candidate.failure_rate) - Number(baseline.failure_rate) <= Number(thresholds.max_failure_rate_delta) },
      { metric: "cost", passed: Number(candidate.mean_cost) / Math.max(Number(baseline.mean_cost), Number.EPSILON) <= Number(thresholds.max_cost_ratio) },
      { metric: "latency", passed: Number(candidate.mean_latency_ms) / Math.max(Number(baseline.mean_latency_ms), Number.EPSILON) <= Number(thresholds.max_latency_ratio) },
      { metric: "correction_rate", passed: Number(candidate.correction_rate) - Number(baseline.correction_rate) <= Number(thresholds.max_correction_rate_delta) }];
    const regression = checks.some((check) => !check.passed); const saved = this.store.save("capability_canary", String(canary.id), { ...payload(canary),
      status: regression ? "halted" : "ready_for_promotion", rollback_recommended: regression, baseline, candidate, checks });
    return { canary: saved, ready: true, regression, rollback_recommended: regression, baseline, candidate, checks };
  }
}
