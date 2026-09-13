import { CraftStore, type JsonObject } from "./store.ts";
export declare class HubSyncKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    sourceRegister(args: JsonObject): JsonObject;
    ingest(args: JsonObject): JsonObject;
    search(args: JsonObject): JsonObject;
    sourceDisable(args: JsonObject): JsonObject;
}
