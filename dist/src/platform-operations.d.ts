import type { JsonObject } from "./store.ts";
import { CraftStore } from "./store.ts";
export declare class PlatformOperationsKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    memberSave(args: JsonObject): JsonObject;
    authorize(args: JsonObject): JsonObject;
    observe(args: JsonObject): JsonObject;
    exportObservations(args: JsonObject): JsonObject;
}
