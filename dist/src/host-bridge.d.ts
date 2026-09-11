import { CraftStore, type JsonObject } from "./store.ts";
/**
 * Binds an already-prepared Execution Fabric to one actual Host invocation.
 * It deliberately stores only references and prompt digests. Host execution,
 * authorization and state observation remain in their specialised kernels.
 */
export declare class HostBridgeKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    prepare(args: JsonObject): JsonObject;
    start(args: JsonObject): JsonObject;
    finish(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
}
