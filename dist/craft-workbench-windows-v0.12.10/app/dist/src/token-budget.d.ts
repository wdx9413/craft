/**
 * Deterministic token accounting and model routing.
 *
 * Nothing here calls a model or a tokenizer. Craft needs an *estimate* it can
 * reproduce on any platform, because the point is to decide before spending:
 * which tier runs a task, and when a loop must stop. A budget that overshoots
 * reports the overshoot instead of throwing, so the caller always gets a number
 * to reason about.
 */
export type ModelTier = "small" | "standard" | "frontier";
export interface BudgetState {
    limit: number;
    reserve: number;
    used: number;
}
export interface ComplexitySignals {
    steps: number;
    distinct_paths: number;
    context_chars: number;
    requires_external_write: boolean;
    requires_multi_step_reasoning: boolean;
}
export interface RoutingRequest {
    host: string;
    models: Partial<Record<ModelTier, string>>;
    tier: ModelTier;
}
export interface RoutingDecision {
    tier: ModelTier;
    model: string | null;
    downgraded: boolean;
    reason: string;
}
/**
 * A platform-independent approximation: one token per CJK character and roughly
 * four characters per token otherwise. It is deliberately conservative and never
 * returns zero, so an empty string still costs something to reason about.
 */
export declare function estimateTokens(value: string): number;
export declare function estimatePromptTokens(texts: readonly string[]): number;
export declare function createBudgetState(limit: number, reserve?: number): BudgetState;
export declare function remainingTokens(state: BudgetState): number;
/**
 * Charge the budget. Overspending is reported, never thrown: the caller needs
 * the measurement in order to stop the loop, and an exception would lose it.
 */
export declare function spendTokens(state: BudgetState, amount: number): {
    state: BudgetState;
    exceeded: boolean;
    remaining: number;
};
/** Cap one payload — a tool result, a log tail, a file read — before it reaches a model. */
export declare function truncateToBudget(value: string, maxTokens: number): {
    text: string;
    truncated: boolean;
    estimated_tokens: number;
};
/** Classify a task from structural signals only. The same signals always give the same tier. */
export declare function classifyComplexity(signals: ComplexitySignals): ModelTier;
/**
 * Pick a model for a tier. The search walks *down* from the requested tier and
 * never up, so a missing model degrades to something cheaper instead of
 * silently promoting the task to a costlier one. `model: null` means "let the
 * host use its own default", which is also the outcome when nothing is declared.
 */
export declare function routeModel(request: RoutingRequest): RoutingDecision;
