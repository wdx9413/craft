import type { JsonObject } from "../../core/infrastructure/store.ts";

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}
function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}
function string(value: unknown, name: string, max = 2_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} must be non-empty and at most ${max} characters`);
  return value.trim();
}
function readOnlyPath(value: unknown, name: string): string {
  const path = string(value, name, 500);
  if (path.startsWith("/") || path.split(/[\\/]/u).includes("..") || path.includes("\0")) throw new Error(`${name} must stay inside the project`);
  return path;
}

/** Accept only executable, read-only Craft Workflow steps from a model proposal. */
export function validateDistilledWorkflowSteps(value: unknown): JsonObject[] {
  const steps = array(value, "steps");
  if (!steps.length || steps.length > 32) throw new Error("steps must contain between 1 and 32 values");
  return steps.map((raw, index) => {
    const step = object(raw, `steps[${index}]`);
    if (step.side_effect !== undefined && step.side_effect !== "read_only") throw new Error(`steps[${index}] must be read_only`);
    if (step.type === "assertion") {
      if (step.evaluator !== "file_exists" && step.evaluator !== "json_value") throw new Error(`steps[${index}] has an unsupported assertion evaluator`);
      const path = readOnlyPath(step.path, `steps[${index}].path`);
      if (step.evaluator === "file_exists" && step.expected !== undefined && typeof step.expected !== "boolean") throw new Error(`steps[${index}].expected must be a boolean`);
      if (step.evaluator === "json_value" && !("expected" in step)) throw new Error(`steps[${index}].expected is required`);
      if (step.field !== undefined) string(step.field, `steps[${index}].field`, 500);
      return { id: string(step.id ?? `step_${index + 1}`, `steps[${index}].id`, 96), type: "assertion", evaluator: step.evaluator, path,
        ...(step.expected === undefined ? {} : { expected: step.expected }), ...(step.field === undefined ? {} : { field: step.field }), side_effect: "read_only" };
    }
    if (step.type === "coverage_gate") {
      const report = step.report === undefined ? "coverage-summary.json" : readOnlyPath(step.report, `steps[${index}].report`);
      for (const field of ["line_threshold", "branch_threshold", "function_threshold", "statement_threshold"]) {
        const threshold = step[field];
        if (threshold !== undefined && (!Number.isFinite(threshold) || Number(threshold) < 0 || Number(threshold) > 100)) throw new Error(`steps[${index}].${field} must be between 0 and 100`);
      }
      return { id: string(step.id ?? `step_${index + 1}`, `steps[${index}].id`, 96), type: "coverage_gate", report,
        ...Object.fromEntries(["line_threshold", "branch_threshold", "function_threshold", "statement_threshold"].filter(field => step[field] !== undefined).map(field => [field, step[field]])), side_effect: "read_only" };
    }
    throw new Error(`steps[${index}] type is unsupported for automatic distillation`);
  });
}
