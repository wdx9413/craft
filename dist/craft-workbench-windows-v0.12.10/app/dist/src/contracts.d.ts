import { CraftStore, type JsonObject } from "./store.ts";
export declare class ContractInferenceKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    observe(args: JsonObject): JsonObject;
    infer(args: JsonObject): JsonObject;
    review(args: JsonObject): JsonObject;
    verify(args: JsonObject): JsonObject;
    diff(args: JsonObject): JsonObject;
    publish(args: JsonObject): JsonObject;
    rollback(args: JsonObject): JsonObject;
}
