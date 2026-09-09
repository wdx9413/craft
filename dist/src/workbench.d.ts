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
    contextProfileSave(args: JsonObject): JsonObject;
    contextProfileAssemble(args: JsonObject): JsonObject;
    contextAssemble(args: JsonObject): JsonObject;
    taskGraphCreate(args: JsonObject): JsonObject;
    taskGraphAdvance(args: JsonObject): JsonObject;
}
