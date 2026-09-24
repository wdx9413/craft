import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { McpServer } from "../core/mcp.ts";
import { CraftService } from "../core/service.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-ticket-dispatch-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  store.create("domain_kit", "ticket-kit", { name: "Ticket Dispatch", domain: "engineering", definition_digest: "kit-digest" });
  store.create("work_launch", "ticket-launch", { task_id: "task-1" });
  store.create("domain_kit_application", "ticket-kit-app", { kit_id: "ticket-kit", kit_version: 1, status: "active", launch_id: "ticket-launch" });
  store.create("experience_procedure", "ticket-procedure", { lifecycle: "routeable", routeable: true, procedure_kind: "workflow", scope: "project:demo" });
  return { root, store, service };
}

test("Ticket Dispatch is read-only, evaluates classification, and prepares no executable Forge effect", async () => {
  const f = await fixture();
  try {
    const scan = f.service.ticketDispatchScan({ ledger_id: "dispatch", repository: "acme/demo", scope: "project:demo", source_ref: "host-receipt:1",
      repository_state: { clean: true, default_branch_protected: true, ci_green: true }, issues: [
        { ticket_id: "T-1", state: "open", labels: ["bug"], dependencies: [], acceptance_defined: true, risk: "low" },
        { ticket_id: "T-2", state: "open", labels: [], dependencies: [{ ticket_id: "T-1", resolved: false }], acceptance_defined: true, risk: "low" },
        { ticket_id: "T-3", state: "open", labels: ["security"], dependencies: [], acceptance_defined: true, risk: "low" },
      ] });
    const ledger = scan.ledger as JsonObject;
    assert.equal(ledger.read_only, true);
    assert.deepEqual((ledger.entries as JsonObject[]).map((item) => item.disposition), ["ready", "blocked", "needs_human"]);
    const evaluation = f.service.ticketDispatchEvaluate({ ledger_id: ledger.id, evaluation_id: "dispatch-eval", cases: [
      { ticket_id: "T-1", expected: "ready" }, { ticket_id: "T-2", expected: "blocked" }, { ticket_id: "T-3", expected: "needs_human" },
    ] }).evaluation as JsonObject;
    assert.equal(evaluation.status, "eligible");
    const policy = f.service.forgePolicySave({ policy_id: "forge-policy", scope: "project:demo", repositories: ["acme/demo"], branches: ["main"],
      operations: ["worktree", "draft_pr"], domain_kit_id: "ticket-kit", domain_kit_version: 1 }).policy as JsonObject;
    const action = f.service.forgeActionPrepare({ forge_action_id: "prepare-worktree", action: "worktree", policy_id: policy.id, ledger_id: ledger.id,
      evaluation_id: evaluation.id, ticket_id: "T-1", branch: "main", procedure_id: "ticket-procedure", kit_application_id: "ticket-kit-app", task_id: "task-1", approval_ref: "approval:ticket-1" }).action as JsonObject;
    assert.equal(action.status, "prepared_for_adapter");
    assert.equal(action.execution_authority, false);
    assert.equal(action.adapter_dispatch, "unavailable");
    assert.throws(() => f.service.forgeActionPrepare({ action: "merge", policy_id: policy.id, ledger_id: ledger.id, evaluation_id: evaluation.id,
      ticket_id: "T-1", branch: "main", procedure_id: "ticket-procedure", kit_application_id: "ticket-kit-app", task_id: "task-1", approval_ref: "approval:ticket-1" }), /outside the active project policy/u);
    const mergePolicy = f.service.forgePolicySave({ policy_id: "merge-policy", scope: "project:demo", repositories: ["acme/demo"], branches: ["main"],
      operations: ["merge"], domain_kit_id: "ticket-kit", domain_kit_version: 1, auto_merge_enabled: false }).policy as JsonObject;
    assert.throws(() => f.service.forgeActionPrepare({ action: "merge", policy_id: mergePolicy.id, ledger_id: ledger.id, evaluation_id: evaluation.id,
      ticket_id: "T-1", branch: "main", procedure_id: "ticket-procedure", kit_application_id: "ticket-kit-app", task_id: "task-1", approval_ref: "approval:ticket-1" }), /explicitly enabled policy/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Ticket Dispatch rejects incomplete classifications and exposes only the preparation surface through MCP", async () => {
  const f = await fixture();
  try {
    const ledger = f.service.ticketDispatchScan({ repository: "acme/demo", scope: "project:demo", source_ref: "host-receipt:2",
      repository_state: { clean: true, default_branch_protected: true }, issues: [{ ticket_id: "T-4", state: "open", labels: [], dependencies: [], acceptance_defined: false }] }).ledger as JsonObject;
    const evaluation = f.service.ticketDispatchEvaluate({ ledger_id: ledger.id, cases: [{ ticket_id: "T-4", expected: "ready" }] }).evaluation as JsonObject;
    assert.equal(evaluation.status, "rejected");
    const mcp = new McpServer(f.service, "full");
    const response = await mcp.handle({ id: 1, method: "tools/call", params: { name: "craft_ticket_dispatch_scan", arguments: {
      repository: "acme/demo", scope: "project:demo", source_ref: "host-receipt:3", repository_state: { clean: true, default_branch_protected: true },
      issues: [{ ticket_id: "T-5", state: "open", labels: [], dependencies: [], acceptance_defined: true }],
    } } });
    assert.equal((response?.result as JsonObject).isError, false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
