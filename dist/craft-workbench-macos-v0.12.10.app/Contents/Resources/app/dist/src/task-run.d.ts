import { CraftStore, type JsonObject } from "./store.ts";
/**
 * A small, durable seam over one already-prepared Work Launch. It never plans
 * model work or dispatches an unapproved effect; it turns observed facts into a
 * resumable task-level state and keeps the exact launch contract auditable.
 */
export declare class TaskRunKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    create(args: JsonObject): JsonObject;
    refresh(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
    pause(args: JsonObject): JsonObject;
    resume(args: JsonObject): JsonObject;
    cancel(args: JsonObject): JsonObject;
    handoff(args: JsonObject): JsonObject;
    private state;
}
