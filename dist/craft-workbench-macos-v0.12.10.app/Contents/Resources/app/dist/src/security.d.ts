import { CraftStore, type JsonObject } from "./store.ts";
export declare class SecurityBrokerKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    handleRegister(args: JsonObject): JsonObject;
    leaseIssue(args: JsonObject): JsonObject;
    egressAuthorize(args: JsonObject): JsonObject;
    leaseRevoke(args: JsonObject): JsonObject;
    contentRegister(args: JsonObject): JsonObject;
    extractionRecord(args: JsonObject): JsonObject;
    projectionRelease(args: JsonObject): JsonObject;
    projectionExplain(args: JsonObject): JsonObject;
}
