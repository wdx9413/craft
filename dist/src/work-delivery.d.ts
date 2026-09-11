import { CraftStore, type JsonObject } from "./store.ts";
/** Read-only closure over an exact Host receipt and independent acceptance state. */
export declare class WorkDeliveryKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    observe(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
}
