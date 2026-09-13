import type { JsonObject } from "./store.ts";
import { CraftStore } from "./store.ts";
export interface RemoteTransport {
    dispatch(endpoint: string, envelope: JsonObject): Promise<{
        remote_id: string;
        status: "accepted" | "completed" | "failed";
        result_digest?: string;
    }>;
}
export declare class RemoteInteropKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    prepare(args: JsonObject): JsonObject;
    dispatch(args: JsonObject, transport: RemoteTransport): Promise<JsonObject>;
    report(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
}
