import { CraftStore, type JsonObject } from "./store.ts";
/** Selects only explicitly routed, evaluated candidates; otherwise returns the declared minimal baseline. */
export declare class AdaptiveHarnessKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    recommend(args: JsonObject): JsonObject;
}
