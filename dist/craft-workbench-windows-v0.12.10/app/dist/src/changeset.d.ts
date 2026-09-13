import { CraftStore, type JsonObject } from "./store.ts";
import { WorkbenchKernel } from "./workbench.ts";
export declare class ChangeSetKernel {
    readonly store: CraftStore;
    readonly workbench: WorkbenchKernel;
    constructor(store: CraftStore, workbench: WorkbenchKernel);
    create(args: JsonObject): JsonObject;
    preview(args: JsonObject): JsonObject;
    apply(args: JsonObject): JsonObject;
}
