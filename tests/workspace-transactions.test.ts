import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

test("workspace transactions use an exact baseline and approved rollback", async () => {
  const root = join(tmpdir(), `craft-transaction-${process.pid}-${Date.now()}`);
  const worktree = join(root, "worktree");
  const store = await new CraftStore(craftPaths(join(root, "craft"))).open();
  const service = new CraftService(store);
  try {
    await mkdir(join(worktree, "src"), { recursive: true });
    await writeFile(join(worktree, "src", "state.txt"), "before", "utf8");
    service.workspaceOpen({ workspace_id: "workspace", name: "Workspace", root_path: worktree, include_paths: ["src"] });
    const prepared = service.workspaceTransactionBegin({ transaction_id: "transaction", workspace_id: "workspace", label: "change state" }).transaction as JsonObject;
    assert.equal(prepared.status, "prepared");
    await writeFile(join(worktree, "src", "state.txt"), "after", "utf8");
    const after = service.workspaceCheckpoint({ workspace_id: "workspace", checkpoint_id: "after", label: "after" }).checkpoint as JsonObject;
    const committed = service.workspaceTransactionCommit({ transaction_id: "transaction", checkpoint_id: after.id }).transaction as JsonObject;
    assert.equal(committed.status, "committed");
    assert.equal((service.workspaceTransactionCommit({ transaction_id: "transaction", checkpoint_id: after.id }).transaction as JsonObject).status, "committed");
    assert.throws(() => service.workspaceTransactionCommit({ transaction_id: "transaction", checkpoint_id: "other" }), /already committed/);
    assert.throws(() => service.workspaceTransactionRollback({ transaction_id: "transaction" }), /approved/);
    const rolledBack = service.workspaceTransactionRollback({ transaction_id: "transaction", approved: true }).transaction as JsonObject;
    assert.equal(rolledBack.status, "rolled_back");
    assert.equal(await readFile(join(worktree, "src", "state.txt"), "utf8"), "before");
    assert.throws(() => service.workspaceTransactionCommit({ transaction_id: "transaction", checkpoint_id: after.id }), /cannot commit/);
    assert.throws(() => service.workspaceTransactionBegin({ workspace_id: "workspace", label: "read", effect: "read_only" }), /local_write/);
    assert.throws(() => service.workspaceTransactionBegin({ transaction_id: "bad id", workspace_id: "workspace", label: "bad" }), /letters, numbers/);
    assert.throws(() => service.workspaceTransactionBegin({ workspace_id: "workspace", label: " " }), /must not be empty/);
    assert.throws(() => service.workspaceTransactionRollback({ transaction_id: "transaction", approved: true }), /cannot roll back/);
    service.workspaceOpen({ workspace_id: "foreign_workspace", name: "Foreign", root_path: worktree, include_paths: ["src"] });
    service.workspaceTransactionBegin({ transaction_id: "foreign", workspace_id: "foreign_workspace", label: "foreign" });
    assert.throws(() => service.workspaceTransactionCommit({ transaction_id: "foreign", checkpoint_id: after.id }), /does not belong/);
    const mcp = new McpServer(service);
    const begin = await mcp.handle({ id: 1, method: "tools/call", params: { name: "craft_workspace_transaction_begin", arguments: {
      transaction_id: "mcp_transaction", workspace_id: "workspace", label: "mcp change",
    } } });
    assert.equal((begin?.result as JsonObject).isError, false);
    const mcpCheckpoint = service.workspaceCheckpoint({ workspace_id: "workspace", checkpoint_id: "mcp_after", label: "mcp after" }).checkpoint as JsonObject;
    for (const [name, arguments_] of Object.entries({
      craft_workspace_transaction_commit: { transaction_id: "mcp_transaction", checkpoint_id: mcpCheckpoint.id },
      craft_workspace_transaction_get: { transaction_id: "mcp_transaction" },
      craft_workspace_transaction_rollback: { transaction_id: "mcp_transaction", approved: true },
    })) {
      const response = await mcp.handle({ id: name, method: "tools/call", params: { name, arguments: arguments_ } });
      assert.equal((response?.result as JsonObject).isError, false, name);
    }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("v0.9.11 compiles only passed trajectories into a static script proposal and requires an exact Signoff", async () => {
  const root = join(tmpdir(), `craft-trajectory-${process.pid}-${Date.now()}`);
  const store = await new CraftStore(craftPaths(join(root, "craft"))).open();
  const service = new CraftService(store);
  try {
    const task = service.taskOpen({ title: "Compile", goal: "Create a repeatable script" }).task as JsonObject;
    const workflow = service.workflowSave({ workflow_id: "workflow", name: "Workflow" });
    const source = service.trialStart({ trial_id: "source", task_id: task.id, subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version });
    service.outcomeRecord({ trial_id: source.id, verdict: "passed", summary: "passed" });
    const proposal = service.trajectoryScriptCompile({ proposal_id: "script", task_id: task.id, name: "Repeat workflow", trial_ids: [source.id],
      operations: [{ operation_id: "run", kind: "workflow", workflow_id: workflow.id, workflow_version: workflow.version, inputs: {} }] }).proposal as JsonObject;
    assert.equal(proposal.lifecycle, "draft");
    assert.match(String(proposal.typescript), /CraftScriptOperation/);
    assert.throws(() => service.trajectoryScriptCompile({ task_id: task.id, name: "Bad", trial_ids: [source.id], operations: [{ operation_id: "run", kind: "shell" }] }), /unsupported/);
    assert.throws(() => service.trajectoryScriptCompile({ proposal_id: "bad id", task_id: task.id, name: "Bad id", trial_ids: [source.id], operations: [{ operation_id: "run", kind: "workflow", workflow_id: workflow.id }] }), /letters, numbers/);
    const incomplete = service.trialStart({ trial_id: "incomplete", task_id: task.id, subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version });
    assert.throws(() => service.trajectoryScriptCompile({ task_id: task.id, name: "Incomplete", trial_ids: [incomplete.id], operations: [{ operation_id: "run", kind: "workflow", workflow_id: workflow.id }] }), /passed Outcome/);
    const otherTask = service.taskOpen({ title: "Other", goal: "Other" }).task as JsonObject;
    const foreignTrial = service.trialStart({ trial_id: "foreign", task_id: otherTask.id, subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version });
    service.outcomeRecord({ trial_id: foreignTrial.id, verdict: "passed", summary: "passed" });
    assert.throws(() => service.trajectoryScriptCompile({ task_id: task.id, name: "Foreign", trial_ids: [foreignTrial.id], operations: [{ operation_id: "run", kind: "workflow", workflow_id: workflow.id }] }), /same task/);
    assert.throws(() => service.trajectoryScriptCompile({ task_id: task.id, name: "Empty", trial_ids: [], operations: [] }), /trial_ids/);
    assert.throws(() => service.trajectoryScriptCompile({ task_id: task.id, name: "Duplicate", trial_ids: [source.id, source.id], operations: [] }), /unique/);
    assert.throws(() => service.trajectoryScriptCompile({ task_id: task.id, name: " ", trial_ids: [source.id], operations: [{ operation_id: "run", kind: "workflow", workflow_id: workflow.id }] }), /must not be empty/);
    assert.throws(() => service.trajectoryScriptCompile({ task_id: task.id, name: "token=redacted", trial_ids: [source.id], operations: [{ operation_id: "run", kind: "workflow", workflow_id: workflow.id }] }), /sensitive/);
    assert.throws(() => service.trajectoryScriptCompile({ task_id: task.id, name: "Invalid", trial_ids: [source.id], operations: [] }), /operations/);
    assert.throws(() => service.trajectoryScriptCompile({ task_id: task.id, name: "Invalid", trial_ids: [source.id], operations: [null] }), /object/);
    assert.throws(() => service.trajectoryScriptCompile({ task_id: task.id, name: "Version", trial_ids: [source.id], operations: [{ operation_id: "run", kind: "workflow", workflow_id: workflow.id, workflow_version: 0 }] }), /positive integer/);
    assert.throws(() => service.trajectoryScriptCompile({ task_id: task.id, name: "Duplicate ops", trial_ids: [source.id], operations: [
      { operation_id: "same", kind: "checkpoint", label: "one" }, { operation_id: "same", kind: "checkpoint", label: "two" },
    ] }), /unique/);
    const checkpointProposal = service.trajectoryScriptCompile({ task_id: task.id, name: "Checkpoint", trial_ids: [source.id], operations: [{ operation_id: "checkpoint", kind: "checkpoint", label: "before" }] }).proposal as JsonObject;
    assert.equal(checkpointProposal.operations instanceof Array, true);
    service.trajectoryScriptCompile({ task_id: task.id, name: "Default version", trial_ids: [source.id], operations: [{ operation_id: "default", kind: "workflow", workflow_id: workflow.id }] });

    const heldOutTrial = service.trialStart({ trial_id: "held", task_id: task.id, case_id: "case", subject_type: "trajectory_script_proposal", subject_id: proposal.id, subject_version: proposal.version });
    service.outcomeRecord({ trial_id: heldOutTrial.id, verdict: "passed", summary: "passed" });
    const suite = service.evaluationSuiteSave({ suite_id: "suite", name: "Suite", cases: [{ case_id: "case", split: "held_out" }] });
    const evaluation = service.evaluationRunRecord({ suite_id: suite.id, suite_version: suite.version, split: "held_out", subject_type: "trajectory_script_proposal", subject_id: proposal.id, subject_version: proposal.version, trial_ids: [heldOutTrial.id] });
    const grader = service.graderSave({ grader_id: "grader", name: "Program", grader_type: "program" });
    const grade = service.gradeRecord({ trial_id: heldOutTrial.id, grader_id: grader.id, grader_version: grader.version, verdict: "passed", summary: "passed" });
    const policy = service.signoffPolicySave({ policy_id: "policy", name: "Policy", requirements: [{ grader_type: "program" }] });
    const signoff = service.signoffEvaluate({ signoff_id: "signoff", policy_id: policy.id, policy_version: policy.version, evaluation_run_id: evaluation.id, grade_ids: [grade.id] });
    store.create("signoff", "wrong_signoff", { decision: "passed", subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version });
    assert.throws(() => service.trajectoryScriptAuthorize({ proposal_id: proposal.id, signoff_id: "wrong_signoff" }), /exact passed/);
    const mcp = new McpServer(service);
    const compiled = await mcp.handle({ id: 1, method: "tools/call", params: { name: "craft_trajectory_script_compile", arguments: {
      proposal_id: "mcp_script", task_id: task.id, name: "Mcp workflow", trial_ids: [source.id],
      operations: [{ operation_id: "mcp_run", kind: "workflow", workflow_id: workflow.id, workflow_version: workflow.version, inputs: {} }],
    } } });
    assert.equal((compiled?.result as JsonObject).isError, false);
    for (const [name, arguments_] of Object.entries({
      craft_trajectory_script_get: { proposal_id: proposal.id }, craft_trajectory_script_list: {},
      craft_trajectory_script_authorize: { proposal_id: proposal.id, signoff_id: signoff.id },
    })) {
      const response = await mcp.handle({ id: name, method: "tools/call", params: { name, arguments: arguments_ } });
      assert.equal((response?.result as JsonObject).isError, false, name);
    }
    assert.equal((service.get("trajectory_script_proposal", "proposal_id", { proposal_id: proposal.id }) as JsonObject).lifecycle, "verified");
    assert.throws(() => service.trajectoryScriptAuthorize({ proposal_id: proposal.id, signoff_id: signoff.id }), /not a draft/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
