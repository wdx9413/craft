import assert from "node:assert/strict";
import test from "node:test";
import { isEvaluationNonProductionPath } from "../scripts/eval/codebase-evaluation-source-policy.ts";

test("evaluation excludes test files and non-production source roots from call graph goldens", () => {
  for (const path of ["tests/auth_test.go", "scripts/check.ts", "plugins/example.ts", "logic/apply_center_test.go",
    "src/auth.spec.ts", "logic/test_auth.go"]) assert.equal(isEvaluationNonProductionPath(path), true, path);
  for (const path of ["logic/auth.go", "src/latest.ts", "contest/handler.go", "logic/testing_service.go", ""]) {
    assert.equal(isEvaluationNonProductionPath(path), false, path);
  }
});
