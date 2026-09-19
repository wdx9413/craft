import { randomUUID } from "node:crypto";
import type { JsonObject } from "./infrastructure/store.ts";
import { CraftStore } from "./infrastructure/store.ts";
import { text } from "./validation.ts";
import { payload } from "./digest.ts";


/** Provider price snapshots and actual usage attribution. */
export class CostLedgerKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  priceSave(args: JsonObject): JsonObject {
    const provider = text(args.provider, "provider"); const model = text(args.model, "model"); const input = Number(args.input_per_million); const output = Number(args.output_per_million);
    if (![input, output].every((value) => Number.isFinite(value) && value >= 0)) throw new Error("prices must be non-negative finite numbers");
    const id = String(args.price_id ?? `price_${provider}_${model}`); const record = { provider, model, input_per_million: input, output_per_million: output, effective_at: args.effective_at === undefined ? new Date().toISOString() : text(args.effective_at, "effective_at") };
    const existing = this.store.find("provider_price", id); return { price: existing ? this.store.save("provider_price", id, { ...payload(existing), ...record }) : this.store.create("provider_price", id, record), idempotent: false };
  }

  usageRecord(args: JsonObject): JsonObject {
    const provider = text(args.provider, "provider"); const model = text(args.model, "model"); const input = Number(args.input_tokens ?? 0); const output = Number(args.output_tokens ?? 0);
    if (![input, output].every((value) => Number.isInteger(value) && value >= 0)) throw new Error("token counts must be non-negative integers");
    const price = this.store.list("provider_price", 1000, (item) => item.provider === provider && item.model === model)[0]; if (!price) throw new Error("No provider price snapshot");
    const costUsd = input * Number(price.input_per_million) / 1_000_000 + output * Number(price.output_per_million) / 1_000_000;
    const id = String(args.usage_id ?? `usage_${randomUUID().replaceAll("-", "")}`); return { usage: this.store.create("usage_ledger", id, { provider, model, project_id: args.project_id ?? null, task_id: args.task_id ?? null, input_tokens: input, output_tokens: output, cost_usd: costUsd, price_id: price.id }), idempotent: false };
  }

  report(args: JsonObject = {}): JsonObject { const projectId = args.project_id === undefined ? null : text(args.project_id, "project_id"); const entries = this.store.list("usage_ledger", 10_000, (item) => projectId === null || item.project_id === projectId); return { entries, total_cost_usd: entries.reduce((sum, item) => sum + Number(item.cost_usd ?? 0), 0), total_input_tokens: entries.reduce((sum, item) => sum + Number(item.input_tokens ?? 0), 0), total_output_tokens: entries.reduce((sum, item) => sum + Number(item.output_tokens ?? 0), 0) }; }
}
