import assert from "node:assert/strict";
import test from "node:test";
import { CraftOperationError } from "../core/operation-error.ts";
import { codebaseFailureDiagnostic } from "../core/application/use-cases/codebase-failure.ts";

test("Codebase import budget failures expose a safe actionable stage", () => {
  assert.deepEqual(codebaseFailureDiagnostic(new Error("TypeScript graph exceeds import budget")), {
    failure_code: "LIMIT_EXCEEDED", failure_stage: "analysis_import", failure_details: { budget: "analysis_graph" },
  });
  assert.deepEqual(codebaseFailureDiagnostic(new Error("Analysis nodes/edges exceed budget or are missing")), {
    failure_code: "LIMIT_EXCEEDED", failure_stage: "analysis_import", failure_details: { budget: "analysis_graph" },
  });
  assert.deepEqual(codebaseFailureDiagnostic(new Error("Codebase graph exceeds storage byte budget")), {
    failure_code: "LIMIT_EXCEEDED", failure_stage: "index_persist", failure_details: { budget: "storage_graph" },
  });
  assert.deepEqual(codebaseFailureDiagnostic(new Error("TypeScript checkpoint exceeds analysis budget")), {
    failure_code: "LIMIT_EXCEEDED", failure_stage: "semantic_analysis", failure_details: { budget: "analysis_graph" },
  });
});

test("Codebase failures keep typed details bounded and redact arbitrary messages", () => {
  assert.deepEqual(codebaseFailureDiagnostic(new CraftOperationError("INVALID_INPUT", "input_validation", "secret source path", {
    field: "index_depth", budget: "file_count", limit: 500, minimum: -1, maximum: Number.POSITIVE_INFINITY, member: "private/path",
    path: "/private/source.ts", credential: "hidden", unsafe: { value: "x" },
  })), {
    failure_code: "INVALID_INPUT", failure_stage: "input_validation", failure_details: { field: "index_depth", budget: "file_count", limit: 500 },
  });
  assert.deepEqual(codebaseFailureDiagnostic(new CraftOperationError("INVALID_INPUT", "../../secret", "private")), {
    failure_code: "INVALID_INPUT", failure_stage: "repository_ensure", failure_details: {},
  });
  const privateFailure = codebaseFailureDiagnostic(new Error("cannot read /private/customer/project.ts token=secret"));
  assert.deepEqual(privateFailure, { failure_code: "OPERATION_FAILED", failure_stage: "repository_ensure", failure_details: {} });
  assert(!JSON.stringify(privateFailure).includes("customer"));
  assert.deepEqual(codebaseFailureDiagnostic({ message: "private path /customer/repo" }), {
    failure_code: "OPERATION_FAILED", failure_stage: "repository_ensure", failure_details: {},
  });
});
