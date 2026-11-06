import assert from "node:assert/strict";
import test from "node:test";

import { runSelfEvolutionRegression } from "../core/eval/self-evolution-regression.ts";

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
