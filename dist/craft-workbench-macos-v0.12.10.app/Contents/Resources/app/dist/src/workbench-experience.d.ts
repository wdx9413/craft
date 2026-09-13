import { CraftStore, type JsonObject } from "./store.ts";
/** Read-only Workbench projection: timeline, outcome, evidence, versions and the next safe action. */
export declare class WorkbenchExperienceKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    query(args?: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
    replayPlan(args: JsonObject): JsonObject;
    review(args: JsonObject): JsonObject;
    private ref;
}
