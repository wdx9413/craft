import { CraftStore, type JsonObject } from "./store.ts";
/** A bounded, read-only projection for the Workbench knowledge screen. */
export declare class KnowledgeWorkbenchKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    view(args?: JsonObject): JsonObject;
}
