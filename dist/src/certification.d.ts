import { CraftStore, type JsonObject } from "./store.ts";
export declare class CapabilityCertificationKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    assess(args: JsonObject): JsonObject;
    promote(args: JsonObject): JsonObject;
}
