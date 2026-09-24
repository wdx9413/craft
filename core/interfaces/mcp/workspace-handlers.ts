import type { McpHandlerGroup, McpHandlerService } from "./handler-types.js";

export function createWorkspaceHandlers(service: McpHandlerService): McpHandlerGroup {
  return {
    craft_workspace_open: (a) => service.workspaceOpen(a), craft_workspace_get: (a) => service.workspaceGet(a),
    craft_workspace_checkpoint: (a) => service.workspaceCheckpoint(a), craft_workspace_diff: (a) => service.workspaceDiff(a),
    craft_workspace_human_change: (a) => service.workspaceHumanChange(a), craft_workspace_restore: (a) => service.workspaceRestore(a),
    craft_work_object_put: (a) => service.workObjectPut(a), craft_work_object_list: (a) => service.workObjectList(a),
    craft_workspace_impact: (a) => service.workspaceImpact(a), craft_workspace_change_apply: (a) => service.workspaceChangeApply(a),
    craft_workspace_transaction_begin: (a) => service.workspaceTransactionBegin(a), craft_workspace_transaction_commit: (a) => service.workspaceTransactionCommit(a),
    craft_workspace_transaction_rollback: (a) => service.workspaceTransactionRollback(a),
    craft_workspace_transaction_get: (a) => service.get("workspace_transaction", "transaction_id", a),
  };
}
