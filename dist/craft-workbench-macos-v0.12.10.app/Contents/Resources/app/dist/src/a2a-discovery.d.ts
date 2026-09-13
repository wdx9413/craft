import { CraftStore, type JsonObject } from "./store.ts";
/** Read-only A2A Agent Card catalog. Cards are untrusted metadata, never execution authority. */
export declare class A2ADiscoveryKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    discover(args: JsonObject): Promise<JsonObject>;
    get(args: JsonObject): JsonObject;
    list(args: JsonObject): JsonObject;
}
