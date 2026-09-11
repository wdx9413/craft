import { CraftStore, type JsonObject } from "./store.ts";
/**
 * A content-free, Host-facing view of an Activation Profile. It proves the
 * exact assets and connector tickets a Host may receive; it neither edits a
 * Host configuration nor starts a connector or a model.
 */
export declare class HostActivationManifestKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    prepare(args: JsonObject): JsonObject;
    validate(args: JsonObject): JsonObject;
    consume(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
    private asset;
}
