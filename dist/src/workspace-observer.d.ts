import { CraftStore, type JsonObject } from "./store.ts";
import { StateWorkspaceKernel } from "./state-workspace.ts";
/** Poll-based, content-free workspace observer. It never guesses whether an
 * uncorrelated edit was made by a person or a model. */
export declare class WorkspaceObserverKernel {
    readonly store: CraftStore;
    readonly states: StateWorkspaceKernel;
    constructor(store: CraftStore, states: StateWorkspaceKernel);
    observe(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
}
