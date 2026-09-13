/**
 * Cross-model comparability.
 *
 * Craft's premise is that the mechanism should stay stable while the model
 * underneath it changes. That premise is testable, and this module is where it
 * becomes a gate: an asset is only "verified across models" when the invariants
 * it declares as core hold for every model it was tried on.
 *
 * The distinction the module exists to make: an invariant that holds everywhere
 * is a property of the mechanism, while one that holds for some models and not
 * others is a property of the model. The second kind is not a failure — it is
 * demoted to a model-sensitive hint, where it can no longer gate anything.
 */
export interface ModelTrial {
    model: string;
    asset_ref: string;
    verdict: "passed" | "failed";
    /** Invariants the trial actually observed holding. */
    observed_invariants: string[];
    tokens?: number;
}
export interface InvariantReport {
    invariant: string;
    held_by: string[];
    failed_by: string[];
    stable: boolean;
}
export interface IndependenceReport {
    models: string[];
    trials: number;
    per_invariant: InvariantReport[];
    /** Invariants that held everywhere. */
    core_stable: string[];
    /** Invariants that only held for some models, so they are hints, not gates. */
    model_sensitive: string[];
    /** Invariants no model ever satisfied. */
    unmet: string[];
    conclusion: "verified" | "inconclusive" | "rejected";
    reason: string;
}
export declare function defineTrials(entries: unknown): ModelTrial[];
/**
 * Compare trials of one subject across models.
 *
 * A single model cannot demonstrate independence, so that case returns
 * `inconclusive` rather than a pass — the honest answer is "not yet tested".
 * A subject with no declared invariant is also inconclusive, because there is
 * nothing whose stability could be established.
 */
export declare function compareAcrossModels(trials: readonly ModelTrial[], invariants: readonly string[]): IndependenceReport;
