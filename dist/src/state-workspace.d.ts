import { CraftStore, type JsonObject } from "./store.ts";
/**
 * Produces content-free observations of a declared Workspace. Adapters differ
 * only in their selection policy; the immutable snapshot receipt is uniform.
 */
export declare class StateWorkspaceKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    observe(args: JsonObject): JsonObject;
    compare(args: JsonObject): JsonObject;
}
