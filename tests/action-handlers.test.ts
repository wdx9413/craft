import assert from "node:assert/strict";
import test from "node:test";
import { createActionHandlers } from "../core/application/actions/action-handlers.ts";
import { McpServer } from "../core/interfaces/mcp-server.ts";
import type { CraftService } from "../core/application/craft-service.ts";

test("all neutral action bindings use the supplied application and preserve caller arguments", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const target = new Proxy({}, { get: (_target, name) => {
    if (name === "trace" || name === "hookPlane") return undefined;
    return (...args: unknown[]) => { const call = { method: String(name), args }; calls.push(call); return { method: call.method }; };
  } }) as CraftService;
  const neutral = createActionHandlers(target);
  const memory = createActionHandlers(target, "memory");
  const supplied = { marker: "unchanged" };
  for (const [name, handler] of Object.entries(neutral)) {
    calls.length = 0;
    const result = await handler(supplied);
    assert.ok(calls.length > 0, name);
    assert.equal(result.method, calls.at(-1)?.method, name);
  }
  calls.length = 0;
  await neutral.craft_component_readiness_get(supplied);
  assert.deepEqual(calls[0], { method: "componentReadinessGet", args: [supplied, undefined] });
  await memory.craft_component_diagnose(supplied);
  assert.deepEqual(calls[1], { method: "componentDiagnose", args: [supplied, "memory"] });
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
  assert.ok(Object.keys(neutral).length > 900);
});

test("constructing MCP transports cannot install or replace internal action handlers", () => {
  const target = new Proxy({}, { get: (_target, name) => {
    if (name === "registerCanonicalHandlers") return () => { throw new Error("Transport attempted application mutation"); };
    if (name === "trace" || name === "hookPlane") return undefined;
    return () => ({});
  } }) as CraftService;
  const memory = new McpServer(target, "component-memory");
  const full = new McpServer(target, "full");
  assert.ok(memory.tools.length < full.tools.length);
  assert.deepEqual(Object.keys(memory.handlers), Object.keys(createActionHandlers(target, "memory")));
});
