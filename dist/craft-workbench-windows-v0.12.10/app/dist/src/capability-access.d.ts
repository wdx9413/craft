import { Catalog } from "./catalog.ts";
import { CraftStore, type JsonObject } from "./store.ts";
/**
 * Bounded capability lifecycle: local source content stays read-only context,
 * while governed assets are selected, version-pinned, and consumed through a
 * short-lived call receipt. It deliberately does not discover or execute a Host.
 */
export declare class CapabilityAccessKernel {
    private readonly store;
    private readonly catalog;
    constructor(store: CraftStore, catalog: Catalog);
    logicalActivationPlan(args: JsonObject): Promise<JsonObject>;
    logicalActivationAudit(args: JsonObject): JsonObject;
    logicalActivationResolve(args: JsonObject): Promise<JsonObject>;
    assetSave(args: JsonObject): JsonObject;
    accessPlan(args: JsonObject): JsonObject;
    callIssue(args: JsonObject): JsonObject;
    callConsume(args: JsonObject): JsonObject;
    private saveVersioned;
}
