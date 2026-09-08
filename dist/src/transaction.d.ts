import { CraftStore, type JsonObject } from "./store.ts";
import type { WorkspaceState } from "./workspace.ts";
export declare class TransactionCoordinator {
    readonly store: CraftStore;
    readonly workspace: WorkspaceState;
    constructor(store: CraftStore, workspace: WorkspaceState);
    begin(args: JsonObject): JsonObject;
    commit(args: JsonObject): JsonObject;
    rollback(args: JsonObject): JsonObject;
}
