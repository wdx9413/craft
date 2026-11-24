import type { JsonObject } from "./infrastructure/store.ts";

const REQUIRED_TEXT = ["host", "task_id", "turn_id", "context_receipt_id", "session_id", "host_evidence_id", "verification_ref"] as const;
const OPTIONAL_TEXT = ["project_root"] as const;
const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/iu;

/** Keep only the terminal learning fields that can be checked against the stored Context receipt. */
export function normalizeLearningEvaluationBinding(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("learning_binding must be an object");
  const input = value as Record<string, unknown>;
  const result: JsonObject = {};
  for (const key of REQUIRED_TEXT) {
    const item = input[key];
    if (typeof item !== "string" || !item.trim() || item.trim().length > 256 || /[\r\n\0]/u.test(item) || SECRET.test(item)) {
      throw new Error(`learning_binding.${key} must be a bounded non-empty string`);
    }
    result[key] = item.trim();
  }
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(String(result.host))) throw new Error("learning_binding.host is invalid");
  for (const key of OPTIONAL_TEXT) {
    const item = input[key];
    if (item === undefined) continue;
    if (typeof item !== "string" || !item.trim() || item.trim().length > 1024 || /[\r\n\0]/u.test(item) || SECRET.test(item)) {
      throw new Error(`learning_binding.${key} must be a bounded non-empty string`);
    }
    result[key] = item.trim();
  }
  if (input.observed_paths !== undefined) {
    if (!Array.isArray(input.observed_paths) || input.observed_paths.length > 64
      || input.observed_paths.some(path => typeof path !== "string" || !path.trim() || path.trim().length > 512 || /[\r\n\0]/u.test(path)
        || SECRET.test(path))) {
      throw new Error("learning_binding.observed_paths must contain at most 64 bounded paths");
    }
    result.observed_paths = [...new Set((input.observed_paths as string[]).map(path => path.trim()))];
  }
  if (input.scenario_context !== undefined) {
    const context = input.scenario_context;
    if (!context || typeof context !== "object" || Array.isArray(context)) throw new Error("learning_binding.scenario_context must be an object");
    const fields = context as Record<string, unknown>;
    for (const key of ["task_goal", "effect_summary"] as const) {
      const item = fields[key];
      if (typeof item !== "string" || !item.trim() || item.trim().length > 320 || /[\r\n\0]/u.test(item) || SECRET.test(item)) {
        throw new Error(`learning_binding.scenario_context.${key} must be bounded text`);
      }
    }
    if (fields.sanitized !== true || fields.content_stored !== false) throw new Error("learning_binding.scenario_context must be sanitized and content-free");
    result.scenario_context = { task_goal: (fields.task_goal as string).trim(), effect_summary: (fields.effect_summary as string).trim(), sanitized: true, content_stored: false };
  }
  return result;
}

/** True only for a recomputed, complete report with every expected case recorded and passed. */
export function isCompletePassingControlledReport(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  return report.status === "complete" && Number.isSafeInteger(report.expected) && Number(report.expected) > 0
    && report.recorded === report.expected && report.passed === report.expected
    && ["failed", "inconclusive", "invalid", "missing", "not_applicable"].every(key => report[key] === undefined || report[key] === 0)
    && Array.isArray(report.results) && report.results.length === report.expected
    && report.results.every(result => !!result && typeof result === "object" && !Array.isArray(result)
      && (result as Record<string, unknown>).verdict === "passed");
}
