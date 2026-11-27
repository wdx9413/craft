import assert from "node:assert/strict";
import test from "node:test";
import { createActionHandlers } from "../core/application/actions/action-handlers.ts";
import { McpServer } from "../core/interfaces/mcp-server.ts";
import type { CraftService } from "../core/application/craft-service.ts";
import { PROJECT_EVOLUTION_TOOL_NAMES } from "../core/mcp/evolution-tools.ts";

test("all neutral action bindings use the supplied application and preserve caller arguments", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const target = new Proxy({}, { get: (_target, name) => {
    if (name === "trace" || name === "hookPlane") return undefined;
    // Handlers that read the store directly need a store-shaped object.
    if (name === "store") return {
      list: () => [], count: () => 0, find: () => null,
      paths: { root: process.cwd(), databaseDir: process.cwd(), dataRoot: process.cwd(), configDir: process.cwd() },
    };
    if (name === "memoryGovernance") return new Proxy({}, { get: (_kernel, method) => (...args: unknown[]) => { const call = { method: `memoryGovernance.${String(method)}`, args }; calls.push(call); return { method: call.method }; } });
    return (...args: unknown[]) => { const call = { method: String(name), args }; calls.push(call); return { method: call.method }; };
  } }) as CraftService;
  const neutral = createActionHandlers(target);
  const memory = createActionHandlers(target, "memory");
  const supplied = { marker: "unchanged" };
  // These bindings read the store directly instead of delegating to a service
  // method, so "the service was called" is not the property under test for them.
  const STORE_DIRECT = new Set(["craft_capability_iteration_plan", "craft_context_usage_statusline", "craft_lsp_readiness"]);
  for (const [name, handler] of Object.entries(neutral)) {
    calls.length = 0;
    const args = name === "craft_memory_governance" ? { action: "tasks" } : supplied;
    if (PROJECT_EVOLUTION_TOOL_NAMES.has(name)) {
      assert.throws(() => handler(args), /active Host project binding/u, name);
      assert.equal(calls.length, 0, name);
      continue;
    }
    const result = await handler(args);
    if (STORE_DIRECT.has(name)) { assert.equal(typeof result, "object", name); continue; }
    assert.ok(calls.length > 0, name);
    assert.equal(result.method, calls.at(-1)?.method, name);
  }
  calls.length = 0;
  await neutral.craft_component_readiness_get(supplied);
  assert.deepEqual(calls[0], { method: "componentReadinessGet", args: [supplied, undefined] });
  await neutral.craft_experience_learning_evaluation_dispatch_next({ worker_id: "worker-1" });
  assert.deepEqual(calls[1], { method: "experienceLearningEvaluationDispatchNext", args: [{ worker_id: "worker-1" }] });
  await neutral.craft_experience_learning_work_item_get({ work_item_id: "work-item-1" });
  assert.deepEqual(calls[2], { method: "experienceLearningWorkItemGet", args: [{ work_item_id: "work-item-1" }] });
  await neutral.craft_experience_learning_work_item_evaluation_contract_bind({ work_item_id: "work-item-1", expected_version: 1,
    evaluation_contract_ref: { kind: "evaluation_contract", id: "contract-1", version: 1, digest: `sha256:${"a".repeat(64)}` } });
  assert.deepEqual(calls[3]?.method, "experienceLearningWorkItemEvaluationContractBind");
  await neutral.craft_experience_learning_work_item_block({ work_item_id: "work-item-1", worker_id: "worker-1",
    lease_token: "lease-1", reason: "evaluation_adapter_unavailable" });
  assert.deepEqual(calls[4], { method: "experienceLearningWorkItemBlock", args: [
    { work_item_id: "work-item-1", worker_id: "worker-1", lease_token: "lease-1", reason: "evaluation_adapter_unavailable" },
  ] });
  await neutral.craft_experience_learning_work_item_resume({ work_item_id: "work-item-1", expected_version: 2 });
  assert.deepEqual(calls[5], { method: "experienceLearningWorkItemResume", args: [{ work_item_id: "work-item-1", expected_version: 2 }] });
  await memory.craft_component_diagnose(supplied);
  assert.deepEqual(calls[6], { method: "componentDiagnose", args: [supplied, "memory"] });
  calls.length = 0;
  await neutral.craft_memory_governance({ action: "topics" });
  await neutral.craft_memory_governance({ action: "confirm" });
  assert.deepEqual(calls.map((call) => call.method), ["memoryGovernance.topicSuggestions", "memoryGovernance.confirm"]);
  assert.deepEqual(await memory.craft_memory_maintenance_run({}), { skipped: true, reason: "scope_unavailable" });
  await memory.craft_memory_maintenance_run({ scope_kind: "project", scope_id: "demo" });
  assert.throws(() => neutral.craft_memory_governance({ action: "unsupported" }), /Unsupported Memory governance action/);
  for (const name of ["craft_context_resolution_resolve", "craft_context_resolution_feedback", "craft_decision_context_gate_open"]) {
    for (const args of [supplied, { ...supplied, members: ["memory"] }]) {
      calls.length = 0;
      await memory[name](args);
      assert.deepEqual(calls[0].args, [{ ...supplied, members: ["memory"] }]);
    }
    for (const members of ["memory", [], ["knowledge"], ["memory", "knowledge"]]) {
      calls.length = 0;
      assert.throws(() => memory[name]({ ...supplied, members }), /mounted component/);
      assert.equal(calls.length, 0, "invalid member selection must never reach the application");
    }
  }
  for (const [name, method] of [
    ["craft_context_doctor", "contextReadinessDoctor"], ["craft_capability_iteration_gaps", "contextCapabilityIterationGaps"],
  ]) {
    calls.length = 0;
    await neutral[name](supplied);
    assert.deepEqual(calls, [{ method, args: [supplied] }]);
  }
  assert.ok(Object.keys(neutral).length > 900);
});

test("constructing MCP transports cannot install or replace internal action handlers", () => {
  const target = new Proxy({}, { get: (_target, name) => {
    if (name === "registerCanonicalHandlers") return () => { throw new Error("Transport attempted application mutation"); };
    if (name === "trace" || name === "hookPlane") return undefined;
    if (name === "store") return { paths: { runtimeDir: "/tmp" } };
    return () => ({});
  } }) as CraftService;
  const memory = new McpServer(target, "component-memory");
  const full = new McpServer(target, "full");
  assert.ok(memory.tools.length < full.tools.length);
  assert.deepEqual(Object.keys(memory.handlers), Object.keys(createActionHandlers(target, "memory")));
});
