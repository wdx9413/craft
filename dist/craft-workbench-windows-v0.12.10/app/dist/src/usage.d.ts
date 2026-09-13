import { CraftStore, type JsonObject } from "./store.ts";
export interface UsageBucket {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    requests: number;
}
export interface UsageReport {
    from: string | null;
    to: string | null;
    totals: UsageBucket;
    daily: Record<string, UsageBucket>;
    weekly: Record<string, UsageBucket>;
    monthly: Record<string, UsageBucket>;
    yearly: Record<string, UsageBucket>;
    by_host: Record<string, UsageBucket>;
    generated_at: string;
}
export declare class UsageKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    report(args?: JsonObject): UsageReport;
}
