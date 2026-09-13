import { CraftStore, type JsonObject } from "./store.ts";
/**
 * Operational metrics as a projection.
 *
 * Everything here is derived from records Craft already writes, so there is no
 * second bookkeeping path that could disagree with the receipts. The measure the
 * harness literature actually asks for is not "tokens spent" but **cost per
 * successful outcome**: a cheap run that fails is more expensive than a costly
 * run that passes, and per-turn token counts cannot express that.
 *
 * An empty store is reported as zero samples rather than as a perfect score.
 */
export interface MetricsBucket {
    /** Host runs observed. */
    runs: number;
    completed: number;
    failed: number;
    cancelled: number;
    interrupted: number;
    /** Completed runs over all runs, or null when there are none. */
    success_rate: number | null;
    duration_ms: number;
    /** Outcomes recorded, and how many of them passed. */
    outcomes: number;
    passed: number;
    tokens: number;
    cost_usd: number;
    /** Cost per passing outcome, or null when nothing passed yet. */
    cost_per_success: number | null;
}
export interface MetricsReport {
    totals: MetricsBucket;
    by_host: Record<string, MetricsBucket>;
    generated_at: string;
}
/** Usage objects come from whatever the host reported, so every field is optional and untrusted. */
export declare function usageTokens(usage: unknown): number;
export declare class MetricsKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    /**
     * Aggregate host runs and outcomes. Runs are grouped by host; outcomes carry no
     * host of their own, so their cost accrues to the totals only.
     */
    report(args?: JsonObject): MetricsReport;
}
