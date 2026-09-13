import { CraftStore, type JsonObject } from "./store.ts";
import { AttentionKernel } from "./attention.ts";
/** Read-only, UI-safe projection for the CLI home screen and future Canvas shell. */
export declare class HomeKernel {
    readonly store: CraftStore;
    readonly attention: AttentionKernel;
    constructor(store: CraftStore, attention?: AttentionKernel);
    view(args?: JsonObject): JsonObject;
    hostRuns(args?: JsonObject): JsonObject;
    hostRun(args: JsonObject): JsonObject;
    task(args: JsonObject): JsonObject;
}
