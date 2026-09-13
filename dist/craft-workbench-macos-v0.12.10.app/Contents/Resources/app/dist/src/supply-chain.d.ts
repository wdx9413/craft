import { CraftStore, type JsonObject } from "./store.ts";
export declare class SupplyChainKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    advisoryRecord(args: JsonObject): JsonObject;
    advisoryResolve(args: JsonObject): JsonObject;
    reconcile(args: JsonObject): JsonObject;
}
