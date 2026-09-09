import { CraftStore, type JsonObject } from "./store.ts";
export declare class WorkbenchKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    objectPut(args: JsonObject): JsonObject;
    impact(args: JsonObject): JsonObject;
    changeApply(args: JsonObject): JsonObject;
    objectList(args: JsonObject): JsonObject;
    remember(args: JsonObject): JsonObject;
    memoryTransition(args: JsonObject): JsonObject;
    contextAssemble(args: JsonObject): JsonObject;
}
