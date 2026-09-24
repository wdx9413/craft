import assert from "node:assert/strict";
import test from "node:test";
import { classifyComplexity, createBudgetState, estimatePromptTokens, estimateTokens, remainingTokens, routeModel, spendTokens, truncateToBudget } from "../core/token-budget.ts";

test("estimateTokens never returns zero and handles CJK", () => {
  assert.equal(estimateTokens(""), 1);
  assert.ok(estimateTokens("hello world") >= 1);
  const cjk = estimateTokens("确定性工作流");
  assert.ok(cjk >= 6);
  assert.throws(() => estimateTokens(123 as never), /string/);
});

test("estimatePromptTokens sums an array", () => {
  assert.equal(estimatePromptTokens(["a", "b"]), estimateTokens("a") + estimateTokens("b"));
  assert.throws(() => estimatePromptTokens("x" as never), /array/);
});

test("createBudgetState validates inputs", () => {
  const s = createBudgetState(1000, 100);
  assert.equal(s.limit, 1000);
  assert.equal(s.reserve, 100);
  assert.throws(() => createBudgetState(0), /positive/);
  assert.throws(() => createBudgetState(100, 100), /below the limit/);
  assert.throws(() => createBudgetState(100, -1), /non-negative/);
});

test("spendTokens reports exceeded without throwing", () => {
  const s = createBudgetState(100);
  const r1 = spendTokens(s, 50);
  assert.equal(r1.exceeded, false);
  assert.equal(r1.remaining, 50);
  const r2 = spendTokens(r1.state, 60);
  assert.equal(r2.exceeded, true);
  assert.equal(r2.remaining, -10);
  assert.throws(() => spendTokens(s, -1), /non-negative/);
});

test("truncateToBudget caps oversized text", () => {
  const big = "x".repeat(10_000);
  const t1 = truncateToBudget(big, 100_000);
  assert.equal(t1.truncated, false);
  const t2 = truncateToBudget(big, 10);
  assert.equal(t2.truncated, true);
  assert.ok(t2.text.endsWith("…[truncated]"));
  assert.throws(() => truncateToBudget("x", 0), /positive/);
  assert.throws(() => truncateToBudget(123 as never, 10), /string/);
});

test("classifyComplexity returns deterministic tiers", () => {
  assert.equal(classifyComplexity({ steps: 1, distinct_paths: 0, context_chars: 100, requires_external_write: false, requires_multi_step_reasoning: false }), "small");
  assert.equal(classifyComplexity({ steps: 5, distinct_paths: 0, context_chars: 100, requires_external_write: false, requires_multi_step_reasoning: false }), "standard");
  assert.equal(classifyComplexity({ steps: 15, distinct_paths: 0, context_chars: 100, requires_external_write: false, requires_multi_step_reasoning: false }), "frontier");
  assert.equal(classifyComplexity({ steps: 1, distinct_paths: 0, context_chars: 100, requires_external_write: true, requires_multi_step_reasoning: false }), "frontier");
  assert.equal(classifyComplexity({ steps: 1, distinct_paths: 0, context_chars: 100, requires_external_write: false, requires_multi_step_reasoning: true }), "frontier");
  assert.equal(classifyComplexity({ steps: 1, distinct_paths: 12, context_chars: 100, requires_external_write: false, requires_multi_step_reasoning: false }), "frontier");
  assert.equal(classifyComplexity({ steps: 1, distinct_paths: 3, context_chars: 100, requires_external_write: false, requires_multi_step_reasoning: false }), "standard");
  assert.equal(classifyComplexity({ steps: 1, distinct_paths: 0, context_chars: 25_000, requires_external_write: false, requires_multi_step_reasoning: false }), "standard");
  assert.throws(() => classifyComplexity({ steps: -1, distinct_paths: 0, context_chars: 0, requires_external_write: false, requires_multi_step_reasoning: false }), /non-negative/);
});

test("remainingTokens reflects the current balance", () => {
  const s = createBudgetState(100, 10);
  assert.equal(remainingTokens(s), 90);
  assert.equal(remainingTokens(spendTokens(s, 50).state), 40);
});

test("routeModel picks the requested tier or walks down", () => {
  const r1 = routeModel({ host: "x", models: { frontier: "gpt-4", standard: "gpt-3.5", small: "gpt-3" }, tier: "frontier" });
  assert.equal(r1.tier, "frontier");
  assert.equal(r1.downgraded, false);
  const r2 = routeModel({ host: "x", models: { standard: "gpt-3.5" }, tier: "frontier" });
  assert.equal(r2.tier, "standard");
  assert.equal(r2.downgraded, true);
  const r3 = routeModel({ host: "x", models: {}, tier: "standard" });
  assert.equal(r3.model, null);
  assert.equal(r3.reason, "host_default:x");
  assert.throws(() => routeModel({ host: "x", models: {}, tier: "unknown" as never }), /Unsupported/);
  // empty string model falls through to next tier
  const r4 = routeModel({ host: "x", models: { frontier: "", standard: "gpt-3.5" }, tier: "frontier" });
  assert.equal(r4.tier, "standard");
  assert.equal(r4.downgraded, true);
  assert.throws(() => routeModel({ host: 123 as never, models: {}, tier: "standard" }), /must not be empty/);
  assert.throws(() => routeModel({ host: "   ", models: {}, tier: "standard" }), /must not be empty/);
});
