import { CraftStore, type JsonObject } from "./store.ts";
/** Comparable, content-free evaluation bridge for completed Work Deliveries. */
export declare class DeliveryEvaluationKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    caseSave(args: JsonObject): JsonObject;
    compare(args: JsonObject): JsonObject;
}
