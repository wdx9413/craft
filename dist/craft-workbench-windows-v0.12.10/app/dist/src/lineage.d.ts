import { CraftStore, type JsonObject } from "./store.ts";
export declare class LineageKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    private reference;
    record(args: JsonObject): JsonObject;
    trace(args: JsonObject): JsonObject;
    verify(args: JsonObject): JsonObject;
}
