import { createHash } from "node:crypto";
export const DEFAULT_LOOP_LIMITS = { max_steps: 30, max_tokens: 200_000,
    max_wall_clock_ms: 30 * 60_000, no_progress_limit: 5 };
function integer(value, name, fallback, minimum, maximum) {
    const result = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(result) || result < minimum || result > maximum) {
        throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return result;
}
export function defineLoopLimits(input = {}) {
    return {
        max_steps: integer(input.max_steps, "max_steps", DEFAULT_LOOP_LIMITS.max_steps, 1, 1_000),
        max_tokens: integer(input.max_tokens, "max_tokens", DEFAULT_LOOP_LIMITS.max_tokens, 1, 10_000_000),
        max_wall_clock_ms: integer(input.max_wall_clock_ms, "max_wall_clock_ms", DEFAULT_LOOP_LIMITS.max_wall_clock_ms, 1_000, 24 * 3_600_000),
        no_progress_limit: integer(input.no_progress_limit, "no_progress_limit", DEFAULT_LOOP_LIMITS.no_progress_limit, 1, 100),
    };
}
export function beginLoop(now) {
    return { status: "running", steps: 0, tokens_used: 0, started_at: now, progress_digest: null,
        stalled_steps: 0, last_action: null, last_action_digest: null, halt_reason: null, verdict: null };
}
/** Stable identity for one action, so calling the same tool with the same arguments twice is visible as a loop. */
export function actionDigest(action, args = {}) {
    return `sha256:${createHash("sha256").update(JSON.stringify({ action, args })).digest("hex")}`;
}
/** Remaining budget as a band, so the caller can compress, downgrade or fuse instead of only failing at zero. */
export function budgetBand(state, limits) {
    const remaining = limits.max_tokens - state.tokens_used;
    const ratio = remaining / limits.max_tokens;
    if (ratio > 0.5)
        return "green";
    if (ratio > 0.2)
        return "yellow";
    if (ratio > 0.05)
        return "red";
    return "fuse";
}
/**
 * Fold one externally observed step into the loop state.
 *
 * Halt reasons are ordered by how cheap they are to detect, and a step that
 * exceeds a ceiling is never counted as progress. The caller is expected to stop
 * immediately when `halted` is true; the reason is returned so the receipt can
 * say which ceiling fired rather than "something went wrong".
 */
export function observeStep(state, limits, step) {
    if (state.status !== "running")
        return { state, halted: true, halt_reason: state.halt_reason, band: budgetBand(state, limits) };
    const tokens = step.tokens === undefined ? 0 : step.tokens;
    if (!Number.isInteger(tokens) || tokens < 0)
        throw new Error("step tokens must be a non-negative integer");
    const steps = state.steps + 1;
    const tokensUsed = state.tokens_used + tokens;
    const digest2 = step.args === undefined ? actionDigest(step.action) : actionDigest(step.action, step.args);
    const unchanged = state.progress_digest !== null && state.progress_digest === step.progress_digest;
    const stalled = unchanged ? state.stalled_steps + 1 : 0;
    const next = { ...state, steps, tokens_used: tokensUsed, progress_digest: step.progress_digest,
        stalled_steps: stalled, last_action: step.action, last_action_digest: digest2 };
    let reason = null;
    const elapsed = step.now - state.started_at;
    if (elapsed > limits.max_wall_clock_ms)
        reason = "wall_clock";
    else if (tokensUsed > limits.max_tokens)
        reason = "token_limit";
    else if (steps > limits.max_steps)
        reason = "step_limit";
    else if (stalled >= limits.no_progress_limit)
        reason = "no_progress";
    else if (state.last_action_digest !== null && state.last_action_digest === digest2)
        reason = "repeated_action";
    else if (budgetBand(next, limits) === "fuse")
        reason = "budget_fuse";
    if (reason)
        return { state: { ...next, status: "halted", halt_reason: reason }, halted: true, halt_reason: reason, band: budgetBand(next, limits) };
    return { state: next, halted: false, halt_reason: null, band: budgetBand(next, limits) };
}
/**
 * Close the loop with the caller's verdict. A verdict is mandatory and comes from
 * the completion path, never from the model's own claim, so "the model said it
 * finished" can never become a terminal state on its own.
 */
export function completeLoop(state, verdict) {
    if (state.status !== "running")
        throw new Error(`Loop is already ${state.status}`);
    const text = verdict.trim();
    if (!text)
        throw new Error("A loop verdict must not be empty");
    return { ...state, status: "completed", verdict: text };
}
export function failLoop(state, verdict) {
    if (state.status !== "running")
        throw new Error(`Loop is already ${state.status}`);
    const text = verdict.trim();
    if (!text)
        throw new Error("A loop verdict must not be empty");
    return { ...state, status: "failed", verdict: text };
}
/** Compact, content-free projection for a receipt. */
export function loopSummary(state, limits) {
    return { status: state.status, steps: state.steps, tokens_used: state.tokens_used,
        budget: { max_steps: limits.max_steps, max_tokens: limits.max_tokens, max_wall_clock_ms: limits.max_wall_clock_ms },
        band: budgetBand(state, limits), progress_digest: state.progress_digest, stalled_steps: state.stalled_steps,
        last_action: state.last_action, halt_reason: state.halt_reason, verdict: state.verdict };
}
//# sourceMappingURL=agent-loop.js.map