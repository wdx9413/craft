import { CraftStore, type JsonObject } from "./store.ts";
/**
 * Protocol-neutral remote collaboration lifecycle. Craft never contacts the
 * remote endpoint here: a trusted Host/Adapter transports the sealed envelope
 * and returns the observed receipt.
 */
export declare class A2ADelegationKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    trustApprove(args: JsonObject): JsonObject;
    sessionCreate(args: JsonObject): JsonObject;
    delegationPrepare(args: JsonObject): JsonObject;
    dispatch(args: JsonObject): JsonObject;
    report(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
    private envelope;
}
