import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

test("v0.9.12 issues a verified script only into its prepared workspace transaction and records exact host receipts", async () => {
  const root = join(tmpdir(), `craft-script-run-${process.pid}-${Date.now()}`);
  const worktree = join(root, "worktree");
  const store = await new CraftStore(craftPaths(join(root, "craft"))).open();
  const service = new CraftService(store);
  try {
    await mkdir(join(worktree, "src"), { recursive: true }); await writeFile(join(worktree, "src", "a.txt"), "a");
    const task = service.taskOpen({ title: "Run", goal: "Run verified script" }).task as JsonObject;
    const workflow = service.workflowSave({ workflow_id: "workflow", name: "Workflow" });
    const trial = service.trialStart({ trial_id: "source", task_id: task.id, subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version });
    service.outcomeRecord({ trial_id: trial.id, verdict: "passed", summary: "passed" });
    const proposal = service.trajectoryScriptCompile({ proposal_id: "proposal", task_id: task.id, name: "Script", trial_ids: [trial.id], operations: [{ operation_id: "workflow", kind: "workflow", workflow_id: workflow.id, workflow_version: workflow.version, inputs: {} }] }).proposal as JsonObject;
    store.save("trajectory_script_proposal", String(proposal.id), { ...proposal, lifecycle: "verified", signoff_id: "test" });
    service.workspaceOpen({ workspace_id: "workspace", name: "Workspace", root_path: worktree, include_paths: ["src"] });
    const transaction = service.workspaceTransactionBegin({ transaction_id: "transaction", workspace_id: "workspace", label: "run" }).transaction as JsonObject;
    const issued = service.verifiedScriptIssue({ run_id: "run", proposal_id: proposal.id, workspace_id: "workspace", transaction_id: transaction.id }) as JsonObject;
    assert.equal((issued.run as JsonObject).status, "issued");
    assert.throws(() => service.verifiedScriptReceipt({ run_id: "run", host_adapter_id: "host", receipts: [] }), /exactly match/);
    const completed = service.verifiedScriptReceipt({ run_id: "run", host_adapter_id: "host", receipts: [{ operation_id: "workflow", verdict: "passed", summary: "done" }] }).run as JsonObject;
    assert.equal(completed.status, "completed");
    assert.throws(() => service.verifiedScriptIssue({ proposal_id: proposal.id, workspace_id: "workspace", transaction_id: transaction.id }), /already associated/);
    service.workspaceTransactionBegin({ transaction_id: "tx_cancelled", workspace_id: "workspace", label: "cancelled" });
    const cancelledIssue = service.verifiedScriptIssue({ proposal_id: proposal.id, workspace_id: "workspace", transaction_id: "tx_cancelled" }).run as JsonObject;
    assert.equal((service.verifiedScriptReceipt({ run_id: cancelledIssue.id, host_adapter_id: "host", receipts: [{ operation_id: "workflow", verdict: "cancelled", summary: "cancelled" }] }).run as JsonObject).status, "cancelled");
    service.workspaceTransactionBegin({ transaction_id: "tx_failed", workspace_id: "workspace", label: "failed" });
    const failedIssue = service.verifiedScriptIssue({ proposal_id: proposal.id, workspace_id: "workspace", transaction_id: "tx_failed" }).run as JsonObject;
    assert.equal((service.verifiedScriptReceipt({ run_id: failedIssue.id, host_adapter_id: "host", receipts: [{ operation_id: "workflow", verdict: "failed", summary: "failed" }] }).run as JsonObject).status, "failed");
    service.workspaceTransactionBegin({ transaction_id: "tx_errors", workspace_id: "workspace", label: "errors" });
    const errorIssue = service.verifiedScriptIssue({ proposal_id: proposal.id, workspace_id: "workspace", transaction_id: "tx_errors" }).run as JsonObject;
    assert.throws(() => service.verifiedScriptReceipt({ run_id: errorIssue.id, host_adapter_id: "host", receipts: "bad" }), /array/);
    assert.throws(() => service.verifiedScriptReceipt({ run_id: errorIssue.id, host_adapter_id: "host", receipts: [null] }), /object/);
    assert.throws(() => service.verifiedScriptReceipt({ run_id: errorIssue.id, host_adapter_id: "host", receipts: [{ operation_id: "workflow", verdict: "unknown", summary: "bad" }] }), /unsupported/);
    assert.throws(() => service.verifiedScriptReceipt({ run_id: errorIssue.id, host_adapter_id: " ", receipts: [{ operation_id: "workflow", verdict: "passed", summary: "done" }] }), /must not be empty/);
    service.verifiedScriptReceipt({ run_id: errorIssue.id, host_adapter_id: "host", receipts: [{ operation_id: "workflow", verdict: "passed", summary: "done" }] });
    service.workspaceTransactionBegin({ transaction_id: "tx_bad_id", workspace_id: "workspace", label: "bad id" });
    assert.throws(() => service.verifiedScriptIssue({ run_id: "bad id", proposal_id: proposal.id, workspace_id: "workspace", transaction_id: "tx_bad_id" }), /letters, numbers/);
    store.save("trajectory_script_proposal", String(proposal.id), { ...proposal, lifecycle: "draft" });
    service.workspaceTransactionBegin({ transaction_id: "tx_draft", workspace_id: "workspace", label: "draft" });
    assert.throws(() => service.verifiedScriptIssue({ proposal_id: proposal.id, workspace_id: "workspace", transaction_id: "tx_draft" }), /verified proposal/);
    store.save("trajectory_script_proposal", String(proposal.id), { ...proposal, lifecycle: "verified" });
    service.workspaceOpen({ workspace_id: "other_workspace", name: "Other", root_path: worktree, include_paths: ["src"] });
    service.workspaceTransactionBegin({ transaction_id: "tx_other", workspace_id: "other_workspace", label: "other" });
    assert.throws(() => service.verifiedScriptIssue({ proposal_id: proposal.id, workspace_id: "workspace", transaction_id: "tx_other" }), /prepared transaction/);
    const mcp = new McpServer(service);
    for (const [name, arguments_] of Object.entries({
      craft_verified_script_run_get: { run_id: "run" },
      craft_verified_script_issue: { proposal_id: proposal.id, workspace_id: "workspace", transaction_id: transaction.id },
      craft_verified_script_receipt: { run_id: "run", host_adapter_id: "host", receipts: [] },
    })) {
      const response = await mcp.handle({ id: name, method: "tools/call", params: { name, arguments: arguments_ } });
      assert(response?.result);
    }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
