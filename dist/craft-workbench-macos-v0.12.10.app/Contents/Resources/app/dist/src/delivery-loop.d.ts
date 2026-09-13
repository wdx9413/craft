import { CraftStore, type JsonObject } from "./store.ts";
import { WorkDeliveryKernel } from "./work-delivery.ts";
/** Durable, content-free next-action projection over independently observed facts. */
export declare class DeliveryLoopKernel {
    readonly store: CraftStore;
    readonly deliveries: WorkDeliveryKernel;
    constructor(store: CraftStore, deliveries: WorkDeliveryKernel);
    refresh(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
}
