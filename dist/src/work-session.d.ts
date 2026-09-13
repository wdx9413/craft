import { CraftStore, type JsonObject } from "./store.ts";
import { ProjectBrainKernel } from "./project-brain.ts";
/** Binds Project Brain, knowledge, capability, workflow, model, Host and acceptance into one resumable session. */
export declare class WorkSessionKernel {
    readonly store: CraftStore;
    readonly brain: ProjectBrainKernel;
    constructor(store: CraftStore, brain?: ProjectBrainKernel);
    prepare(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
    refresh(args: JsonObject): JsonObject;
    bindLaunch(args: JsonObject): JsonObject;
    complete(args: JsonObject): JsonObject;
}
