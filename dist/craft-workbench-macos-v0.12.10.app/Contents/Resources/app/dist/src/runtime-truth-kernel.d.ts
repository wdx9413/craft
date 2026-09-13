import type { JsonObject } from "./store.ts";
import { CraftStore } from "./store.ts";
/** Persistence facade for the versionless Runtime Truth protocol. */
export declare class RuntimeTruthKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    standardize(args: JsonObject): JsonObject;
    otlp(args: JsonObject): JsonObject;
    export(args: JsonObject): Promise<JsonObject>;
    compact(args: JsonObject): JsonObject;
    workNote(args: JsonObject): JsonObject;
}
