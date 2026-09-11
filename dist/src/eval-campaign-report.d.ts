import { CraftStore, type JsonObject } from "./store.ts";
/** Builds a content-free, repeatable Campaign report from immutable observed deliveries. */
export declare class EvalCampaignReportKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    report(args: JsonObject): JsonObject;
    private sample;
    private delivery;
}
