import type { JsonObject } from "./store.ts";
/**
 * Circuit breakers for a self-hosted loop.
 *
 * The evidence that makes this module necessary rather than defensive: agents
 * almost never report that they are stuck (measured at ~5% of runs), so a loop
 * cannot wait to be told it is looping. It has to be detected from the outside,
 * using facts the loop does not control. Every guard here is therefore an
 * explicit ceiling owned by Craft, not a prompt instruction the model could
 * reinterpret.
 */
export interface LoopLimits {
    max_steps: number;
    max_tokens: number;
    max_wall_clock_ms: number;
    /** Consecutive steps with an unchanged progress digest before the loop halts. */
    no_progress_limit: number;
}
export type BudgetBand = "green" | "yellow" | "red" | "fuse";
export type LoopStatus = "running" | "completed" | "failed" | "halted";
export type HaltReason = "step_limit" | "token_limit" | "wall_clock" | "no_progress" | "repeated_action" | "budget_fuse";
export interface LoopState {
    status: LoopStatus;
    steps: number;
    tokens_used: number;
    started_at: number;
    progress_digest: string | null;
    stalled_steps: number;
    last_action: string | null;
    last_action_digest: string | null;
    halt_reason: HaltReason | null;
    verdict: string | null;
}
export interface StepObservation {
    /** A digest of the externally observed world, not of the model's own summary. */
    progress_digest: string;
    action: string;
    args?: JsonObject;
    tokens?: number;
    now: number;
}
export declare const DEFAULT_LOOP_LIMITS: LoopLimits;
export declare function defineLoopLimits(input?: JsonObject): LoopLimits;
export declare function beginLoop(now: number): LoopState;
/** Stable identity for one action, so calling the same tool with the same arguments twice is visible as a loop. */
export declare function actionDigest(action: string, args?: JsonObject): string;
/** Remaining budget as a band, so the caller can compress, downgrade or fuse instead of only failing at zero. */
export declare function budgetBand(state: LoopState, limits: LoopLimits): BudgetBand;
/**
 * Fold one externally observed step into the loop state.
 *
 * Halt reasons are ordered by how cheap they are to detect, and a step that
 * exceeds a ceiling is never counted as progress. The caller is expected to stop
 * immediately when `halted` is true; the reason is returned so the receipt can
 * say which ceiling fired rather than "something went wrong".
 */
export declare function observeStep(state: LoopState, limits: LoopLimits, step: StepObservation): {
    state: LoopState;
    halted: boolean;
    halt_reason: HaltReason | null;
    band: BudgetBand;
};
/**
 * Close the loop with the caller's verdict. A verdict is mandatory and comes from
 * the completion path, never from the model's own claim, so "the model said it
 * finished" can never become a terminal state on its own.
 */
export declare function completeLoop(state: LoopState, verdict: string): LoopState;
export declare function failLoop(state: LoopState, verdict: string): LoopState;
/** Compact, content-free projection for a receipt. */
export declare function loopSummary(state: LoopState, limits: LoopLimits): JsonObject;
