import type { JsonObject } from "./store.ts";
import { CraftStore } from "./store.ts";
export declare class OrgSyncKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    prepare(args: JsonObject): JsonObject;
    apply(args: JsonObject): JsonObject;
}
