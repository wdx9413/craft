import { CraftStore, type JsonObject } from "./store.ts";
/** A user-readable goal/material/decision state; it never starts a Host itself. */
export declare class GuidedWorkKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    create(args: JsonObject): JsonObject;
    decide(args: JsonObject): JsonObject;
    bindLaunch(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
}
