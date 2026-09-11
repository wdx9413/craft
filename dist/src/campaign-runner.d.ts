import { CraftStore, type JsonObject } from "./store.ts";
import { EvalCampaignKernel } from "./eval-campaign.ts";
/**
 * A Host-neutral campaign driver. It may issue one pinned slot at a time, but
 * never starts a hidden Host or invents an Outcome; the Host returns a TaskRun
 * and the existing EvalCampaign verifies environment/budget before binding.
 */
export declare class CampaignRunnerKernel {
    readonly store: CraftStore;
    readonly campaigns: EvalCampaignKernel;
    constructor(store: CraftStore, campaigns: EvalCampaignKernel);
    create(args: JsonObject): JsonObject;
    claim(args: JsonObject): JsonObject;
    preview(args: JsonObject): JsonObject;
    bind(args: JsonObject): JsonObject;
    advance(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
    private slots;
}
