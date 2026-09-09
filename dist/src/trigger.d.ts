import { CraftStore, type JsonObject } from "./store.ts";
export declare class TriggerKernel {
    readonly store: CraftStore;
    readonly env: NodeJS.ProcessEnv;
    constructor(store: CraftStore, env?: NodeJS.ProcessEnv);
    subscriptionSave(args: JsonObject): JsonObject;
    webhookIngest(args: JsonObject): JsonObject;
}
