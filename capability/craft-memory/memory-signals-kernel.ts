/**
 * Recall-history signals: what the Ledger's contents say about the Ledger.
 *
 * These are the **derived** half of the Memory member. The Ledger stores entries; these functions
 * answer questions about them — how much a memory's weight should decay with age and disuse,
 * whether a finished turn is worth proposing for capture, how a legacy record could be promoted,
 * how a vector ranking fuses with a keyword one, and what evidence makes "the agent did better
 * because it remembered" checkable rather than assertable.
 *
 * They were pure functions in `src/memory-wiring.ts` with a thin facade wrapper each. The
 * distinction that put them in this package rather than the core is the same one that kept the
 * read side out: these operate on **one** member's records, while `ContextResolutionKernel`
 * resolves across all three and is therefore projected by three products.
 *
 * The class is a thin delegation rather than a rewrite. A module of pure functions does not need a
 * class to be correct, but it does need one to be **provided through the registry** — and the
 * registry is what turns "these tools belong to the memory capability" from a comment into
 * something the composition can check. Wrapping also keeps the exports stable for the two callers
 * that import the functions directly (`capability/craft-eval/suite.ts` scoring, and the tests).
 */
import type { CraftStore } from "../../src/infrastructure/store.ts";
import type { JsonObject } from "../../src/infrastructure/store.ts";
import {
  hybridMemoryScores,
  memoryDecayWeight,
  memoryUsageEvidence,
  planLegacyPromotion,
  rankWithDecay,
  shouldProposeMemory,
  type VectorCandidate,
} from "./memory-signals.ts";

export class MemorySignalsKernel {
  /** Held so the kernel has the same shape as the others, and so a future signal that needs the
   *  store can be added without changing how the capability is assembled. None reads it yet. */
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  decayWeight(input: JsonObject): number { return memoryDecayWeight(input); }

  rankWithDecay(candidates: Array<{ id: string; base_score: number; decay: number }>): Array<{ id: string; score: number; base_score: number; decay: number }> {
    return rankWithDecay(candidates);
  }

  shouldPropose(input: JsonObject): JsonObject { return shouldProposeMemory(input) as unknown as JsonObject; }

  planLegacyPromotion(input: JsonObject): JsonObject { return planLegacyPromotion(input); }

  hybridScores(candidates: VectorCandidate[], options: { vectorEligible: boolean; k?: number }): Array<{ id: string; score: number; retrieval_mode: "vector+keyword" | "keyword" }> {
    return hybridMemoryScores(candidates, options);
  }

  usageEvidence(input: JsonObject): JsonObject { return memoryUsageEvidence(input); }
}
