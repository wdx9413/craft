import { CraftStore, type JsonObject } from "./store.ts";
export declare class HydrationKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    capture(args: JsonObject): JsonObject;
    inspect(args: JsonObject): JsonObject;
    claim(args: JsonObject): JsonObject;
    report(args: JsonObject): JsonObject;
    recover(args: JsonObject): JsonObject;
}
