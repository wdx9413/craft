import { CraftStore, type JsonObject } from "./store.ts";
import { DeliveryLoopKernel } from "./delivery-loop.ts";
/** Version-pinned task boundary that projects all launch facts into one safe next action. */
export declare class TaskControlKernel {
    readonly store: CraftStore;
    readonly delivery: DeliveryLoopKernel;
    constructor(store: CraftStore, delivery: DeliveryLoopKernel);
    save(args: JsonObject): JsonObject;
    bindLaunch(args: JsonObject): JsonObject;
    refresh(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
    handoff(args: JsonObject): JsonObject;
}
