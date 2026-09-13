import { CraftStore, type JsonObject } from "./store.ts";
/** Durable wait/release/wake/revalidate protocol. It never attempts to reattach a dead Host process. */
export declare class LongTaskWorkerKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    suspend(args: JsonObject): JsonObject;
    wake(args: JsonObject): JsonObject;
    resume(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
    list(args?: JsonObject): JsonObject;
    /** One bounded background-worker tick for expiry and externally woken checkpoints. */
    tick(args?: JsonObject): JsonObject;
}
