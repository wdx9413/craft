import { stableDigest } from "../../common/craft-common-base/src/digest.ts";
import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";

export const AUTOMATIC_SIGNOFF_POLICY = "craft:auto-signoff:all-prior-gates-passed.v1";
const STAGES = ["shadow", "held_out", "signoff", "canary"] as const;
export type EvaluationStage = typeof STAGES[number];

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}
function text(value: unknown, name: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} must be non-empty and at most ${max} characters`);
  return value.trim();
}

export interface EvaluationCase extends JsonObject { case_id: string; project_root: string; inputs: JsonObject }
export interface EvaluationCaseSet extends JsonObject { case_set_ref: string; cases: EvaluationCase[]; independent_of_training?: true }
export interface ScenarioEvaluation extends JsonObject {
  schema: "craft.experience-evaluation.v1";
  signoff_policy_ref: typeof AUTOMATIC_SIGNOFF_POLICY;
  stages: Record<Exclude<EvaluationStage, "signoff">, EvaluationCaseSet>;
}

function caseSet(value: unknown, name: string, heldOut = false): EvaluationCaseSet {
  const source = object(value, name), cases = source.cases;
  if (!Array.isArray(cases) || cases.length < 1 || cases.length > 32) throw new Error(`${name}.cases must contain between 1 and 32 values`);
  const checked = cases.map((raw, index) => {
    const item = object(raw, `${name}.cases[${index}]`);
    const inputs = object(item.inputs ?? {}, `${name}.cases[${index}].inputs`);
    if (Object.keys(inputs).length > 32) throw new Error(`${name}.cases[${index}].inputs may contain at most 32 values`);
    for (const [key, input] of Object.entries(inputs)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key) || !["string", "number", "boolean"].includes(typeof input)) throw new Error(`${name}.cases[${index}].inputs contains an unsupported value`);
      if (typeof input === "string" && (input.length > 500 || /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*\S{8,}/iu.test(input))) throw new Error(`${name}.cases[${index}].inputs contains unsafe text`);
    }
    return { case_id: text(item.case_id, `${name}.cases[${index}].case_id`, 96),
      project_root: text(item.project_root, `${name}.cases[${index}].project_root`, 2_000), inputs };
  });
  if (new Set(checked.map(item => item.case_id)).size !== checked.length) throw new Error(`${name}.cases case_id values must be unique`);
  const expected = stableDigest(checked);
  if (text(source.case_set_ref, `${name}.case_set_ref`) !== expected) throw new Error(`${name}.case_set_ref must pin the exact case set digest`);
  if (heldOut && source.independent_of_training !== true) throw new Error(`${name}.independent_of_training must be true`);
  return { case_set_ref: expected, cases: checked, ...(heldOut ? { independent_of_training: true } : {}) };
}

/** Validate the project-owned, data-root-local execution contract before a dispatch can run. */
export function validateScenarioEvaluation(value: unknown): ScenarioEvaluation {
  const source = object(value, "evaluation");
  if (source.schema !== "craft.experience-evaluation.v1") throw new Error("evaluation.schema is unsupported");
  if (source.signoff_policy_ref !== AUTOMATIC_SIGNOFF_POLICY) throw new Error("evaluation.signoff_policy_ref is unsupported");
  const stages = object(source.stages, "evaluation.stages");
  const shadow = caseSet(stages.shadow, "evaluation.stages.shadow");
  const heldOut = caseSet(stages.held_out, "evaluation.stages.held_out", true);
  const canary = caseSet(stages.canary, "evaluation.stages.canary");
  if (shadow.case_set_ref === heldOut.case_set_ref || canary.case_set_ref === heldOut.case_set_ref) throw new Error("held-out cases must use an independent case set");
  return { schema: "craft.experience-evaluation.v1", signoff_policy_ref: AUTOMATIC_SIGNOFF_POLICY,
    stages: { shadow, held_out: heldOut, canary } };
}

export function validateReadOnlyEvaluationSteps(value: unknown): JsonObject[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new Error("candidate steps must contain between 1 and 32 values");
  const ids = new Set<string>();
  return value.map((raw, index) => {
    const step = object(raw, `candidate steps[${index}]`), id = text(step.id, `candidate steps[${index}].id`, 96);
    if (ids.has(id)) throw new Error("candidate step ids must be unique"); ids.add(id);
    if (step.side_effect !== "read_only") throw new Error(`candidate steps[${index}] must be read_only`);
    if (step.type === "assertion") {
      if (step.evaluator !== "file_exists" && step.evaluator !== "json_value") throw new Error(`candidate steps[${index}] evaluator is unsupported`);
      const path = text(step.path, `candidate steps[${index}].path`);
      if (path.startsWith("/") || path.includes("\\") || path.split("/").includes("..") || path.includes("\0")) throw new Error(`candidate steps[${index}].path must stay inside the project`);
      if (step.evaluator === "json_value" && !("expected" in step)) throw new Error(`candidate steps[${index}].expected is required`);
      if (step.evaluator === "file_exists" && step.expected !== undefined && typeof step.expected !== "boolean") throw new Error(`candidate steps[${index}].expected must be a boolean`);
      return step;
    }
    if (step.type === "coverage_gate") {
      const report = step.report === undefined ? "coverage-summary.json" : text(step.report, `candidate steps[${index}].report`);
      if (report.startsWith("/") || report.includes("\\") || report.split("/").includes("..") || report.includes("\0")) throw new Error(`candidate steps[${index}].report must stay inside the project`);
      for (const field of ["line_threshold", "branch_threshold", "function_threshold", "statement_threshold"]) {
        if (step[field] !== undefined && (!Number.isFinite(step[field]) || Number(step[field]) < 0 || Number(step[field]) > 100)) throw new Error(`candidate steps[${index}].${field} must be between 0 and 100`);
      }
      return step;
    }
    throw new Error(`candidate steps[${index}].type is unsupported`);
  });
}
