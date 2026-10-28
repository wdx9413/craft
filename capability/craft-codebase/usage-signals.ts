import type { CraftStore, JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { stableDigest } from "../../common/craft-common-base/src/digest.ts";

const USAGE_KIND = "codebase_symbol_usage";
const OUTCOMES = new Set(["read", "passed", "failed"]);

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function day(value: unknown): string {
  const now = value === undefined ? new Date() : new Date(String(value));
  if (Number.isNaN(now.valueOf())) throw new Error("now must be a valid timestamp");
  return now.toISOString().slice(0, 10);
}

/** Net outcome weight per symbol: read +0.5, passed +1, failed -1. */
export function codebaseUsageWeights(store: CraftStore, indexId: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const item of store.list(USAGE_KIND, 10_000, (value) => value.index_id === indexId, false)) {
    const symbolId = typeof item.symbol_id === "string" ? item.symbol_id : "";
    if (!symbolId) continue;
    const delta = item.outcome === "passed" ? 1 : item.outcome === "failed" ? -1 : item.outcome === "read" ? 0.5 : 0;
    if (delta) result.set(symbolId, (result.get(symbolId) ?? 0) + delta * Number(item.count ?? 1));
  }
  return result;
}

/** Record one observed use of a codebase symbol. One row per index/symbol/outcome/day keeps growth bounded. */
export function recordCodebaseSymbolUsage(store: CraftStore, args: JsonObject): JsonObject {
  const indexId = text(args.index_id, "index_id");
  const symbolId = text(args.symbol_id, "symbol_id");
  const outcome = args.outcome === undefined ? "read" : text(args.outcome, "outcome");
  if (!OUTCOMES.has(outcome)) throw new Error("outcome must be read, passed or failed");
  const capturedDay = day(args.now);
  const id = `codebase_symbol_usage_${stableDigest({ index_id: indexId, symbol_id: symbolId, outcome, day: capturedDay }).slice(-24)}`;
  const existing = store.find(USAGE_KIND, id, undefined, false);
  if (existing) return { usage: store.save(USAGE_KIND, id, { ...existing, count: Number(existing.count ?? 1) + 1 }), idempotent: false };
  return { usage: store.create(USAGE_KIND, id, { index_id: indexId, symbol_id: symbolId, outcome, day: capturedDay,
    count: 1, content_free: true }), idempotent: false };
}
