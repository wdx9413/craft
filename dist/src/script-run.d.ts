import { CraftStore, type JsonObject } from "./store.ts";
export declare class VerifiedScriptRunner {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    issue(args: JsonObject): JsonObject;
    receipt(args: JsonObject): JsonObject;
}
