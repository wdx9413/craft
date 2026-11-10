import assert from "node:assert/strict";
import test from "node:test";
import { GRAPH_BUDGET } from "../capability/craft-codebase/graph-budget.ts";

test("semantic graph budgets are one frozen, bounded source of truth", () => {
  assert.equal(Object.isFrozen(GRAPH_BUDGET), true);
  assert.deepEqual(GRAPH_BUDGET, {
    maxNodes: 120_000,
    maxEdges: 500_000,
    maxImportBytes: 128 * 1024 * 1024,
    maxGraphBytes: 192 * 1024 * 1024,
  });
  assert.ok(GRAPH_BUDGET.maxGraphBytes >= GRAPH_BUDGET.maxImportBytes);
});
