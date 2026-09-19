import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defineProvider } from "../src/model-gateway.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";

/**
 * The Sub-agent Run reached from the wire.
 *
 * `src/subagent-execution.ts` proves the child loop is isolated and budgeted; this
 * proves the service actually runs it, derives the child's budget from records
 * rather than from the caller, and records the outcome on the operation. A kernel
 * with no caller is the failure mode this test exists to prevent.
 */

const spec = () => defineProvider({ provider: "demo", label: "Demo", protocol: "openai-compatible",
  base_url: "https://example.test/v1", api_key_env: "DEMO_API_KEY",
  models: { small: "demo-small", standard: "demo-std", frontier: "demo-frontier" } });

async function fixture(): Promise<{ store: CraftStore; root: string; service: CraftService }> {
  const root = await mkdtemp(join(tmpdir(), `craft-subagent-run-${process.pid}-`));
  const store = await new CraftStore(craftPaths(root)).open();
  let turn = 0;
  const transport = { complete: async () => {
    turn += 1;
    return turn === 1
      ? { text: "", model: "fake", usage: { input_tokens: 4, output_tokens: 1 },
          tool_calls: [{ id: "c1", type: "function" as const, function: { name: "capability_search", arguments: "{}" } }] }
      : { text: "diagnosis complete", model: "fake", usage: { input_tokens: 4, output_tokens: 1 } };
  } };
  const service = new CraftService(store, undefined, undefined, undefined, undefined, undefined, [],
    [spec()], transport as never);
  return { store, root, service };
}

/** One delegating parent: a task, a leased agent operation and an internal dispatch. */
function parent(service: CraftService, limits: JsonObject = {}): JsonObject {
  const task = service.taskOpen({ title: "Diagnose", goal: "Find a failure" }).task as JsonObject;
  const policy = service.runtimePolicySave({ name: "Read only", allowed_effects: ["read_only"] });
  const profile = service.expertProfileSave({ expert_id: "diagnostic", name: "Diagnostic",
    expert_type: "diagnostic_research", allowed_effects: ["read_only"],
    output_contract: ["hypotheses", "counterexamples", "evidence_ids", "confidence", "next_action"] }) as JsonObject;
  const capsule = service.contextCapsuleCreate({ task_id: task.id, profile_id: profile.id,
    artifact_ids: [], evidence_ids: [], input_boundary: "no raw payload" }) as JsonObject;
  service.runtimeRunStart({ run_id: "run", task_id: task.id, policy_id: policy.id, environment: {},
    operations: [{ operation_id: "parent", kind: "agent", effect: "read_only", objective: "coordinate" }] });
  const operation = service.expertSubagentCreate({ run_id: "run", parent_operation_id: "parent",
    expert_id: profile.id, capsule_id: capsule.id, objective: "Form one hypothesis" }) as JsonObject;
  service.hostDriver("internal")!.prepare({ task_id: String(task.id), prompt: "parent goal",
    dispatch_id: "parent-dispatch", limits });
  return operation;
}
test("the service runs a Sub-agent in its own session and records the report", async () => {
  const f = await fixture();
  try {
    const operation = parent(f.service, { max_tokens: 20_000, max_steps: 6, max_context_tokens: 4_096 });
    const result = await f.service.expertSubagentRun({ operation_id: String(operation.id),
      parent_dispatch_id: "parent-dispatch" });
    const report = result.report as JsonObject;
    assert.equal(result.refused, null);
    assert.equal(report.status, "completed");
    assert.equal(report.isolated_session, true);
    assert.equal(report.execution_authority, false);
    assert.equal(report.final_message, "diagnosis complete");
    assert.equal(report.depth, 1);
    // The child ran its own loop with its own session key, under the parent's task.
    assert.equal(f.store.find("internal_session", String(report.session_id)) !== null, true);
    assert.equal((f.store.get("internal_dispatch", String(report.dispatch_id)) as JsonObject).task_id,
      f.store.get("runtime_run", "run")!.task_id);
    // Half of the parent's declared budget, and the operation now carries the report.
    const childLimits = (f.store.get("internal_dispatch", String(report.dispatch_id)) as JsonObject).limits as JsonObject;
    assert.equal(childLimits.max_tokens, 10_000);
    assert.equal(childLimits.max_steps, 6);
    const saved = result.operation as JsonObject;
    assert.equal(saved.status, "completed");
    assert.equal(saved.execution_authority, false);
    assert.equal(saved.subagent_report_digest, report.receipt_digest);
    assert.match(String(saved.subagent_report_digest), /^sha256:/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a parent with no budget left is refused rather than funded anyway", async () => {
  const f = await fixture();
  try {
    const operation = parent(f.service, { max_tokens: 2_048, max_steps: 4 });
    // A receipt showing the parent has already spent its ceiling: the child's share
    // is derived from that receipt, so nothing is left to delegate with.
    f.store.create("internal_receipt", "receipt_parent-dispatch", { dispatch_id: "parent-dispatch",
      status: "completed", loop: { steps: 3, tokens_used: 2_048 } });
    const refused = await f.service.expertSubagentRun({ operation_id: String(operation.id),
      parent_dispatch_id: "parent-dispatch" });
    assert.equal(refused.refused, "insufficient_parent_budget");
    assert.equal(refused.report, null);
    // Refusal leaves the operation untouched, so it can be retried by a funded parent.
    assert.equal((refused.operation as JsonObject).status, "pending");
    assert.equal(Boolean(f.store.find("internal_dispatch", `subagent_${String(operation.id)}`)), false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("only an agent operation can be run as a Sub-agent", async () => {
  const f = await fixture();
  try {
    const task = f.service.taskOpen({ title: "Diagnose", goal: "Find a failure" }).task as JsonObject;
    const policy = f.service.runtimePolicySave({ name: "Read only", allowed_effects: ["read_only"] });
    f.service.runtimeRunStart({ run_id: "run", task_id: task.id, policy_id: policy.id, environment: {},
      operations: [{ operation_id: "workflow-op", kind: "workflow", effect: "read_only", objective: "not an agent" }] });
    await assert.rejects(() => f.service.expertSubagentRun({ operation_id: "workflow-op",
      parent_dispatch_id: "parent-dispatch" }), /Only an agent operation/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a Sub-agent Run is declared over MCP and never inherits write authority", async () => {
  const f = await fixture();
  try {
    const operation = parent(f.service, { max_tokens: 20_000 });
    const { McpServer } = await import("../src/mcp.ts");
    const server = new McpServer(f.service, "full");
    const listed = ((await server.handle({ id: 1, method: "tools/list" }))?.result as JsonObject)
      .tools as JsonObject[];
    assert.ok(listed.some((tool) => tool.name === "craft_expert_subagent_run"));
    const response = await server.handle({ id: 2, method: "tools/call", params: { name: "craft_expert_subagent_run",
      arguments: { operation_id: String(operation.id), parent_dispatch_id: "parent-dispatch" } } });
    assert.equal((response?.result as JsonObject).isError, false);
    // The operation is where the authority claim lives, and it stays false.
    assert.equal((f.store.get("runtime_operation", String(operation.id)) as JsonObject).execution_authority, false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
