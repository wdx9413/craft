import assert from "node:assert/strict";
import test from "node:test";
import { CURRENT_RELEASE_VERSION } from "./release-version.ts";
import { validateDistilledWorkflowSteps } from "../deploy/experience-learning/workflow-contract.ts";

test("read-only assertions and coverage gates normalize to executable bounded steps", () => {
  assert.deepEqual(validateDistilledWorkflowSteps([
    { type: "assertion", evaluator: "file_exists", path: "." },
    { id: "json-proof", type: "assertion", evaluator: "json_value", path: "package.json", field: "version", expected: CURRENT_RELEASE_VERSION, side_effect: "read_only" },
    { type: "coverage_gate", line_threshold: 100, branch_threshold: 95, function_threshold: 100, statement_threshold: 100 },
    { id: "coverage-proof", type: "coverage_gate", report: "coverage/custom.json", line_threshold: 0 },
  ]), [
    { id: "step_1", type: "assertion", evaluator: "file_exists", path: ".", side_effect: "read_only" },
    { id: "json-proof", type: "assertion", evaluator: "json_value", path: "package.json", expected: CURRENT_RELEASE_VERSION, field: "version", side_effect: "read_only" },
    { id: "step_3", type: "coverage_gate", report: "coverage-summary.json", line_threshold: 100, branch_threshold: 95, function_threshold: 100, statement_threshold: 100, side_effect: "read_only" },
    { id: "coverage-proof", type: "coverage_gate", report: "coverage/custom.json", line_threshold: 0, side_effect: "read_only" },
  ]);
});

test("workflow contract rejects malformed containers, missing values, and invalid identifiers", () => {
  assert.throws(() => validateDistilledWorkflowSteps(null), /steps must be an array/u);
  assert.throws(() => validateDistilledWorkflowSteps([]), /between 1 and 32/u);
  assert.throws(() => validateDistilledWorkflowSteps(Array.from({ length: 33 }, () => ({ type: "assertion" }))), /between 1 and 32/u);
  assert.throws(() => validateDistilledWorkflowSteps([null]), /must be an object/u);
  assert.throws(() => validateDistilledWorkflowSteps([{ type: "assertion", evaluator: "unknown", path: "." }]), /unsupported assertion evaluator/u);
  assert.throws(() => validateDistilledWorkflowSteps([{ type: "assertion", evaluator: "file_exists" }]), /path must be non-empty/u);
  for (const path of ["/etc/passwd", "../outside", "a/../outside", "bad\0path"]) {
    assert.throws(() => validateDistilledWorkflowSteps([{ type: "assertion", evaluator: "file_exists", path }]), /stay inside the project/u);
  }
  assert.throws(() => validateDistilledWorkflowSteps([{ type: "assertion", evaluator: "file_exists", path: ".", expected: "yes" }]), /expected must be a boolean/u);
  assert.throws(() => validateDistilledWorkflowSteps([{ type: "assertion", evaluator: "json_value", path: "a.json" }]), /expected is required/u);
  assert.throws(() => validateDistilledWorkflowSteps([{ type: "assertion", evaluator: "json_value", path: "a.json", expected: null, field: "" }]), /field must be non-empty/u);
  assert.throws(() => validateDistilledWorkflowSteps([{ type: "assertion", evaluator: "file_exists", path: ".", id: "" }]), /id must be non-empty/u);
});

test("workflow contract rejects writes, unsafe coverage report paths, thresholds, and unknown step types", () => {
  assert.throws(() => validateDistilledWorkflowSteps([{ type: "assertion", evaluator: "file_exists", path: ".", side_effect: "local_write" }]), /must be read_only/u);
  for (const report of ["/tmp/coverage.json", "../coverage.json", "reports/../coverage.json", "bad\0report"]) {
    assert.throws(() => validateDistilledWorkflowSteps([{ type: "coverage_gate", report }]), /stay inside the project/u);
  }
  for (const threshold of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => validateDistilledWorkflowSteps([{ type: "coverage_gate", branch_threshold: threshold }]), /between 0 and 100/u);
  }
  assert.throws(() => validateDistilledWorkflowSteps([{ type: "instruction", objective: "run tests" }]), /type is unsupported/u);
});
