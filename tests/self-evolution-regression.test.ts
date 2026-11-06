import assert from "node:assert/strict";
import test from "node:test";

import { isKnownSelfEvolutionCase, runSelfEvolutionRegression } from "../core/eval/self-evolution-regression.ts";

/**
 * The deterministic self-evolution checks live on the Craft side (NEEDREAD §9.1):
 * craft-eval must not reverse-import Craft kernels, so these byte-decided assertions
 * over shadow gate, message listener, directory semantics, coordinator and codebase
 * analysis are reported here instead of in the generic suite.
 */
test("self-evolution regression passes all deterministic kernel checks", async () => {
  const report = await runSelfEvolutionRegression();
  const failed = report.cases.filter((entry) => entry.verdict === "failed");
  const unobserved = report.cases.filter((entry) => entry.verdict === "unobserved");
  assert.equal(report.unobserved, 0, `unobserved: ${unobserved.map((entry) => entry.id).join(", ")}`);
  assert.equal(report.failed, 0, `failed: ${failed.map((entry) => `${entry.id} (${entry.detail})`).join(", ")}`);
  assert.equal(report.passed, report.cases.length, "every registered case must pass");
  assert.equal(report.passed, 14, "the deterministic self-evolution set is 14 cases");
});

test("self-evolution regression can skip selected cases", async () => {
  const report = await runSelfEvolutionRegression({
    skip: ["self_evolution.shadow_gate_refuses_unrun_candidate"],
  });
  assert.equal(report.cases.length, 13, "one case is skipped");
  assert.equal(report.unobserved, 0);
  assert.equal(report.failed, 0);
  assert.equal(report.passed, 13);
});

test("a throwing check is reported unobserved, never as a pass", async () => {
  const report = await runSelfEvolutionRegression({
    checks: {
      "self_evolution.shadow_gate_refuses_unrun_candidate": () => {
        throw new Error("boom");
      },
    },
  });
  const target = report.cases.find((entry) => entry.id === "self_evolution.shadow_gate_refuses_unrun_candidate");
  assert.equal(target?.verdict, "unobserved");
  assert.equal(target?.detail, "boom");
  const others = report.cases.filter((entry) => entry.id !== "self_evolution.shadow_gate_refuses_unrun_candidate");
  assert.ok(others.length > 0);
  assert.ok(others.every((entry) => entry.verdict === "unobserved" && entry.detail === "no check registered"));
});

test("a check that returns failed is reported failed with its reason", async () => {
  const report = await runSelfEvolutionRegression({
    checks: { "self_evolution.shadow_gate_refuses_unrun_candidate": () => "failed" },
  });
  const target = report.cases.find((entry) => entry.id === "self_evolution.shadow_gate_refuses_unrun_candidate");
  assert.equal(target?.verdict, "failed");
  assert.equal(target?.detail, "assertion did not hold");
});

test("isKnownSelfEvolutionCase distinguishes registered ids", () => {
  assert.equal(isKnownSelfEvolutionCase("self_evolution.shadow_gate_refuses_unrun_candidate"), true);
  assert.equal(isKnownSelfEvolutionCase("self_evolution.not_real"), false);
});
