import type { JsonObject } from "./store.ts";
import { CraftStore } from "./store.ts";
export declare class MemoryConsolidationKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    remember(args: JsonObject): JsonObject;
    consolidate(args: JsonObject): JsonObject;
    resolve(args: JsonObject): JsonObject;
    search(args: JsonObject): JsonObject;
}
