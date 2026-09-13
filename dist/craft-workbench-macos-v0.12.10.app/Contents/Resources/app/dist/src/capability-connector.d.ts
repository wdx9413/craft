import { CraftStore, type JsonObject } from "./store.ts";
/**
 * Stores explicit, content-free external capability registrations. Transport
 * discovery and execution remain host responsibilities; this kernel only
 * admits metadata, pins provenance, and issues profile-bound tickets.
 */
export declare class CapabilityConnectorKernel {
    private readonly store;
    constructor(store: CraftStore);
    register(args: JsonObject): JsonObject;
    discover(args: JsonObject): JsonObject;
    update(args: JsonObject): JsonObject;
    approve(args: JsonObject): JsonObject;
    list(args: JsonObject): JsonObject;
    ticketIssue(args: JsonObject): JsonObject;
    ticketConsume(args: JsonObject): JsonObject;
    private connector;
    private assertActive;
    private discoverOne;
}
