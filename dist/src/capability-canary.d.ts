import { CraftStore, type JsonObject } from "./store.ts";
export declare class CapabilityCanaryKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    start(args: JsonObject): JsonObject;
    route(args: JsonObject): JsonObject;
    observe(args: JsonObject): JsonObject;
    evaluate(args: JsonObject): JsonObject;
}
