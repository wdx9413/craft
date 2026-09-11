import { CraftStore, type JsonObject } from "./store.ts";
/** A single durable facade over existing launch, receipt, acceptance and state facts. */
export declare class VerifiedWorkLoopKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    create(args: JsonObject): JsonObject;
    advance(args: JsonObject): JsonObject;
    decide(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
}
