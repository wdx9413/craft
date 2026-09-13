import { CraftStore, type JsonObject } from "./store.ts";
/** Durable, content-light projection of one user's continuous project. */
export declare class ProjectBrainKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    open(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
    snapshot(args: JsonObject): JsonObject;
    goalSave(args: JsonObject): JsonObject;
    decisionSave(args: JsonObject): JsonObject;
    materialBind(args: JsonObject): JsonObject;
    outcomeRecord(args: JsonObject): JsonObject;
    experienceRecord(args: JsonObject): JsonObject;
    refresh(args: JsonObject): JsonObject;
    private require;
}
