import { CraftStore, type JsonObject } from "./store.ts";
/** Immutable links between a pinned Campaign slot and an observed Host run. */
export declare class AgentEvalLabKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    create(args: JsonObject): JsonObject;
    attach(args: JsonObject): JsonObject;
    observe(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
}
