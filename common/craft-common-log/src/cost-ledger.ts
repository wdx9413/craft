import { randomUUID } from "node:crypto";
import type { JsonObject } from "../../craft-common-store-local/src/store.ts";
import { CraftStore } from "../../craft-common-store-local/src/store.ts";
import { text } from "../../craft-common-base/src/validation.ts";
import { payload, stableDigest } from "../../craft-common-base/src/digest.ts";

const REPORT_LIMIT = 10_000;
const METRICS = ["cost_usd", "input_tokens", "output_tokens"] as const;
function priceRates(record: JsonObject): { input: number; output: number } {
  const input = record.input_per_million; const output = record.output_per_million;
  if (![input, output].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) throw new Error("prices must be non-negative finite numbers");
  return { input: Number(input), output: Number(output) };
}
function metricTotal(entries: JsonObject[], key: typeof METRICS[number]): number | null {
  if (!entries.length) return null;
  let total = 0;
  for (const entry of entries) {
    const value = entry[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (key !== "cost_usd" && !Number.isSafeInteger(value))) return null;
    total += value;
    if (!Number.isFinite(total) || (key !== "cost_usd" && !Number.isSafeInteger(total))) return null;
  }
  return total;
}

/** Provider price snapshots and actual usage attribution. */
export class CostLedgerKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  priceSave(args: JsonObject): JsonObject {
    const provider = text(args.provider, "provider"); const model = text(args.model, "model"); const { input, output } = priceRates(args);
    const id = String(args.price_id ?? `price_${provider}_${model}`); const record = { provider, model, input_per_million: input, output_per_million: output, effective_at: args.effective_at === undefined ? new Date().toISOString() : text(args.effective_at, "effective_at") };
    const existing = this.store.find("provider_price", id); return { price: existing ? this.store.save("provider_price", id, { ...payload(existing), ...record }) : this.store.create("provider_price", id, record), idempotent: false };
  }

  usageRecord(args: JsonObject): JsonObject {
    const provider = text(args.provider, "provider"); const model = text(args.model, "model"); const input = args.input_tokens; const output = args.output_tokens;
    // Missing usage is unknown, not a zero-cost execution.
    if (![input, output].every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) throw new Error("token counts must be explicit non-negative safe integers");
    const price = this.store.list("provider_price", 1000, (item) => item.provider === provider && item.model === model)[0]; if (!price) throw new Error("No provider price snapshot");
    const rates = priceRates(price);
    const costUsd = (Number(input) / 1_000_000) * rates.input + (Number(output) / 1_000_000) * rates.output;
    if (!Number.isFinite(costUsd)) throw new Error("calculated cost must be finite");
    const id = String(args.usage_id ?? `usage_${randomUUID().replaceAll("-", "")}`);
    return { usage: this.store.create("usage_ledger", id, { provider, model, project_id: args.project_id ?? null, task_id: args.task_id ?? null,
      input_tokens: input, output_tokens: output, cost_usd: costUsd, price_id: price.id,
      price_version: price.version, price_digest: stableDigest(payload(price)) }), idempotent: false };
  }

  report(args: JsonObject = {}): JsonObject {
    const projectId = args.project_id === undefined ? null : text(args.project_id, "project_id");
    const selected = this.store.list("usage_ledger", REPORT_LIMIT + 1, (item) => projectId === null || item.project_id === projectId);
    const truncated = selected.length > REPORT_LIMIT; const entries = selected.slice(0, REPORT_LIMIT);
    // A bounded display is not a complete total. Preserve unknown metrics and
    // historical records instead of silently substituting zeros or partial sums.
    const totals = Object.fromEntries(METRICS.map((key) => [key, truncated ? null : metricTotal(entries, key)]));
    return { entries, truncated, unavailable_metrics: METRICS.filter((key) => totals[key] === null),
      total_cost_usd: totals.cost_usd, total_input_tokens: totals.input_tokens, total_output_tokens: totals.output_tokens };
  }
}
