import { CraftStore, type JsonObject } from "./store.ts";
export declare class RecoveryQueueKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    refresh(args?: JsonObject): JsonObject;
    claim(args: JsonObject): JsonObject;
    report(args: JsonObject): JsonObject;
    recoverExpired(args?: JsonObject): JsonObject;
    private candidates;
    private candidate;
}
