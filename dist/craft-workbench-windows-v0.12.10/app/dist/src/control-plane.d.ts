import { CraftStore, type JsonObject } from "./store.ts";
export declare class ControlPlaneKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    budgetOpen(args: JsonObject): JsonObject;
    budgetReserve(args: JsonObject): JsonObject;
    budgetSettle(args: JsonObject): JsonObject;
    budgetClose(args: JsonObject): JsonObject;
    waitCreate(args: JsonObject): JsonObject;
    waitResume(args: JsonObject): JsonObject;
    fallbackSave(args: JsonObject): JsonObject;
    fallbackEvaluate(args: JsonObject): JsonObject;
}
