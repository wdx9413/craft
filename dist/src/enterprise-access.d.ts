import { CraftStore, type JsonObject } from "./store.ts";
/**
 * Declarative enterprise edge. It stores no credentials and never calls a
 * provider; a deployment-specific broker consumes the short-lived lease.
 */
export declare class EnterpriseAccessKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    providerRegister(args: JsonObject): JsonObject;
    providerVerify(args: JsonObject): JsonObject;
    principalBind(args: JsonObject): JsonObject;
    adapterBind(args: JsonObject): JsonObject;
    ticketIssue(args: JsonObject): JsonObject;
    ticketConsume(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
    private verifiedProvider;
}
