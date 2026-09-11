import { CraftStore, type JsonObject } from "./store.ts";
/**
 * Immutable join records for Craft's one public work path. The kernel has no
 * scheduler: service code obtains observed Work Loop facts first, then records
 * their relationship to the exact Host activation manifest.
 */
export declare class ExecutionFabricKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    create(args: JsonObject): JsonObject;
    advance(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
}
