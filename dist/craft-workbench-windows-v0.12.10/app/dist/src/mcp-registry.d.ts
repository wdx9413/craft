import type { JsonObject } from "./store.ts";
import { CraftStore } from "./store.ts";
export interface RegistryFetch {
    (input: string, init?: {
        method?: string;
        headers?: Record<string, string>;
    }): Promise<{
        status: number;
        json(): Promise<unknown>;
    }>;
}
export declare class McpRegistryKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    sourceRegister(args: JsonObject): JsonObject;
    serverIngest(args: JsonObject): JsonObject;
    health(args: JsonObject): JsonObject;
    revoke(args: JsonObject): JsonObject;
    /** Pull one registry page through an injected adapter; metadata is still untrusted until certification. */
    sync(args: JsonObject, fetchImpl?: RegistryFetch): Promise<JsonObject>;
}
