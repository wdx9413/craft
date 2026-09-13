import { CraftStore, type JsonObject } from "./store.ts";
import { EvalCampaignKernel } from "./eval-campaign.ts";
/**
 * Operations layer for reviewed, redacted real-world evaluation cases. It only
 * schedules pinned Campaigns; a Host must still claim and run every slot.
 */
export declare class EvaluationOperationsKernel {
    readonly store: CraftStore;
    readonly campaigns: EvalCampaignKernel;
    constructor(store: CraftStore, campaigns: EvalCampaignKernel);
    programSave(args: JsonObject): JsonObject;
    due(args: JsonObject): JsonObject;
    plan(args: JsonObject): JsonObject;
    report(args: JsonObject): JsonObject;
    private validateCases;
}
