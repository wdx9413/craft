import { CraftStore, type JsonObject } from "./store.ts";
import { type HostProfile } from "./host-registry.ts";
/**
 * A content-free, Host-facing view of an Activation Profile. It proves the
 * exact assets and connector tickets a Host may receive; it neither edits a
 * Host configuration nor starts a connector or a model.
 */
export declare class HostActivationManifestKernel {
    readonly store: CraftStore;
    readonly hosts: Set<string>;
    constructor(store: CraftStore, hostProfiles?: readonly HostProfile[]);
    prepare(args: JsonObject): JsonObject;
    validate(args: JsonObject): JsonObject;
    consume(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
    private asset;
}
