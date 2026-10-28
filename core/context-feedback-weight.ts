import type { CraftStore, JsonObject } from "./infrastructure/store.ts";

/** Each verified "helpful" signal adds this much weight, capped. */
const POSITIVE_BONUS = 0.2;
/** Each unresolved incorrect/stale correction subtracts this much weight, capped. */
const NEGATIVE_PENALTY = 0.2;
const MAX_SIGNALS = 5;
const MIN_WEIGHT = 0.25;
const MAX_WEIGHT = 2;

export interface ContextFeedbackWeight {
  readonly weight: number;
  /** Negative-only multiplier: 1 when clean, lower while corrections are pending. */
  readonly penalty: number;
  readonly positive: number;
  readonly negative: number;
}

/**
 * Ranking weight derived from observed Context usage.
 *
 * Only `helpful` feedback that carries verified program Evidence counts as a
 * positive signal. Unresolved `incorrect`/`stale` correction tasks are a soft
 * demotion: they never change source status, but a claim or procedure that was
 * reported wrong should not keep outranking clean material while review is
 * pending. A `confirmed` correction keeps the penalty; a `dismissed` one removes it.
 */
export function contextFeedbackWeights(store: CraftStore, member: string, ids: readonly string[]): Map<string, ContextFeedbackWeight> {
  const wanted = new Set(ids);
  const result = new Map<string, ContextFeedbackWeight>();
  if (wanted.size === 0) return result;
  const positive = new Map<string, number>(), negative = new Map<string, number>();
  for (const item of store.list("context_feedback", 10_000,
    (value) => value.outcome === "helpful" && value.evidence_verified === true, false)) {
    for (const ref of Array.isArray(item.asset_refs) ? item.asset_refs as JsonObject[] : []) {
      if (ref.member === member && typeof ref.id === "string" && wanted.has(ref.id)) positive.set(ref.id, (positive.get(ref.id) ?? 0) + 1);
    }
  }
  for (const task of store.list("context_correction_task", 10_000,
    (value) => (value.status === "pending_review" || value.status === "confirmed")
      && (value.outcome === "incorrect" || value.outcome === "stale"), false)) {
    const ref = task.asset_ref as JsonObject | undefined;
    if (ref?.member === member && typeof ref.id === "string" && wanted.has(ref.id)) negative.set(ref.id, (negative.get(ref.id) ?? 0) + 1);
  }
  for (const id of wanted) {
    const positiveCount = positive.get(id) ?? 0, negativeCount = negative.get(id) ?? 0;
    const weight = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT,
      1 + POSITIVE_BONUS * Math.min(positiveCount, MAX_SIGNALS) - NEGATIVE_PENALTY * Math.min(negativeCount, MAX_SIGNALS)));
    const penalty = Math.min(1, Math.max(MIN_WEIGHT, 1 - NEGATIVE_PENALTY * Math.min(negativeCount, MAX_SIGNALS)));
    result.set(id, { weight: Number(weight.toFixed(6)), penalty: Number(penalty.toFixed(6)),
      positive: positiveCount, negative: negativeCount });
  }
  return result;
}
