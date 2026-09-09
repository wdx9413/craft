import { CraftStore, type JsonObject } from "./store.ts";
export declare class SpeculativeKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    policySave(args: JsonObject): JsonObject;
    enqueue(args: JsonObject): JsonObject;
    claim(args: JsonObject): JsonObject;
    submit(args: JsonObject): JsonObject;
    decide(args: JsonObject): JsonObject;
    expire(args: JsonObject): JsonObject;
}
