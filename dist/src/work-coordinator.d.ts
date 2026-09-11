import { CraftStore, type JsonObject } from "./store.ts";
import { ManagedRunKernel } from "./managed-run.ts";
/** One durable coordinator per Execution Fabric. It owns no model loop: the
 * Host remains replaceable while Craft owns the safe state transitions. */
export declare class WorkCoordinatorKernel {
    readonly store: CraftStore;
    readonly managed: ManagedRunKernel;
    constructor(store: CraftStore, managed: ManagedRunKernel);
    prepare(args: JsonObject): JsonObject;
    attachHostRun(args: JsonObject): JsonObject;
    observe(args: JsonObject): JsonObject;
    handoff(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
    private event;
}
