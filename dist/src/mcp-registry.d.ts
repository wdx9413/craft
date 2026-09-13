import type { JsonObject } from "./store.ts";
import { CraftStore } from "./store.ts";
export declare class McpRegistryKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    sourceRegister(args: JsonObject): JsonObject;
    serverIngest(args: JsonObject): JsonObject;
    health(args: JsonObject): JsonObject;
    revoke(args: JsonObject): JsonObject;
}
