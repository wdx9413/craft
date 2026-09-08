import { randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";
import type { WorkspaceState } from "./workspace.ts";

function id(value: unknown, name: string, prefix: string): string {
  const result = value === undefined ? `${prefix}_${randomUUID().replaceAll("-", "")}` : String(value).trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new Error(`${name} must contain only letters, numbers, _ or -`);
  return result;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}

function recordPayload(record: JsonObject): JsonObject {
  const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...payload } = record;
  return payload;
}

export class TransactionCoordinator {
  readonly store: CraftStore;
  readonly workspace: WorkspaceState;
  constructor(store: CraftStore, workspace: WorkspaceState) { this.store = store; this.workspace = workspace; }

  begin(args: JsonObject): JsonObject {
    if (String(args.effect ?? "local_write") !== "local_write") throw new Error("workspace transactions support local_write only");
    const transactionId = id(args.transaction_id, "transaction_id", "workspace_transaction");
    const workspaceId = id(args.workspace_id, "workspace_id", "workspace");
    this.store.get("workspace", workspaceId);
    const checkpoint = this.workspace.checkpoint({ workspace_id: workspaceId, checkpoint_id: `${transactionId}_baseline`,
      label: `transaction baseline: ${text(args.label, "label")}` }).checkpoint as JsonObject;
    const transaction = this.store.create("workspace_transaction", transactionId, { workspace_id: workspaceId,
      effect: "local_write", status: "prepared", baseline_checkpoint_id: checkpoint.id, committed_checkpoint_id: null,
      label: text(args.label, "label"), compensation: "restore_baseline_checkpoint" });
    return { transaction, baseline_checkpoint: checkpoint };
  }

  commit(args: JsonObject): JsonObject {
    const transaction = this.store.get("workspace_transaction", id(args.transaction_id, "transaction_id", "workspace_transaction"));
    const checkpointId = id(args.checkpoint_id, "checkpoint_id", "workspace_checkpoint");
    if (transaction.status === "committed") {
      if (transaction.committed_checkpoint_id === checkpointId) return { transaction };
      throw new Error("workspace transaction is already committed with another checkpoint");
    }
    if (transaction.status !== "prepared") throw new Error(`workspace transaction cannot commit from ${transaction.status}`);
    const checkpoint = this.store.get("workspace_checkpoint", checkpointId);
    if (checkpoint.workspace_id !== transaction.workspace_id) throw new Error("workspace checkpoint does not belong to transaction workspace");
    const saved = this.store.save("workspace_transaction", String(transaction.id), { ...recordPayload(transaction), status: "committed",
      committed_checkpoint_id: checkpoint.id });
    return { transaction: saved, checkpoint };
  }

  rollback(args: JsonObject): JsonObject {
    if (args.approved !== true) throw new Error("workspace transaction rollback requires approved=true");
    const transaction = this.store.get("workspace_transaction", id(args.transaction_id, "transaction_id", "workspace_transaction"));
    if (!new Set(["prepared", "committed"]).has(String(transaction.status))) throw new Error(`workspace transaction cannot roll back from ${transaction.status}`);
    const restored = this.workspace.restore({ workspace_id: transaction.workspace_id,
      checkpoint_id: transaction.baseline_checkpoint_id, approved: true });
    const saved = this.store.save("workspace_transaction", String(transaction.id), { ...recordPayload(transaction), status: "rolled_back",
      rollback_checkpoint_id: transaction.baseline_checkpoint_id });
    return { transaction: saved, restored };
  }
}
