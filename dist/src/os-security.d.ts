import type { JsonObject } from "./store.ts";
import { CraftStore } from "./store.ts";
export declare class OsSecurityKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    plan(args: JsonObject): JsonObject;
    verify(args: JsonObject): JsonObject;
}
