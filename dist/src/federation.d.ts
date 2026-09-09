import { CraftStore, type JsonObject } from "./store.ts";
export declare class CapabilityFederationKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    propose(args: JsonObject): JsonObject;
    review(args: JsonObject): JsonObject;
    publish(args: JsonObject): JsonObject;
    subscribe(args: JsonObject): JsonObject;
    resolve(args: JsonObject): JsonObject;
    revoke(args: JsonObject): JsonObject;
}
