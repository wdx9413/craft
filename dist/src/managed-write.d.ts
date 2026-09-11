import { CraftStore, type JsonObject } from "./store.ts";
import type { TransactionCoordinator } from "./transaction.ts";
import type { WorkspaceState } from "./workspace.ts";
/**
 * Adds a bounded, user-approved recovery seam to a Fabric local-write Run.
 * It protects only declared workspace files; it never claims an external API
 * or arbitrary Host side effect can be rolled back.
 */
export declare class ManagedWriteKernel {
    readonly store: CraftStore;
    readonly transactions: TransactionCoordinator;
    readonly workspace: WorkspaceState;
    constructor(store: CraftStore, transactions: TransactionCoordinator, workspace: WorkspaceState);
    prepare(args: JsonObject): JsonObject;
    start(args: JsonObject): JsonObject;
    settleForRun(run: JsonObject): JsonObject | null;
    rollback(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
    private workspaceId;
    private scope;
    private launch;
    private assertRun;
}
