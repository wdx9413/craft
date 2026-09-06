import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { JsonObject } from "./store.ts";

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const SENSITIVE = /((?:authorization\s*:\s*bearer|api[_-]?key|token|password|secret|cookie)\s*[=:]?\s*)\S+/gi;
export const SIDE_EFFECTS = new Set(["read_only", "local_write", "external_write", "destructive"]);

export function resolveInputs(definitions: JsonObject[], supplied: JsonObject): JsonObject {
  const result = { ...supplied };
  for (const [index, definition] of definitions.entries()) {
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
      throw new Error(`Workflow input at index ${index} must be an object`);
    }
    const name = definition.name;
    if (typeof name !== "string" || !name) throw new Error("Each workflow input requires a non-empty name");
    if (!(name in result) && "default" in definition) result[name] = definition.default;
    if (definition.required && !(name in result)) throw new Error(`Missing required workflow input: ${name}`);
  }
  return result;
}

export function substitute(value: unknown, inputs: JsonObject): unknown {
  if (Array.isArray(value)) return value.map((item) => substitute(item, inputs));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, substitute(item, inputs)]));
  if (typeof value !== "string") return value;
  const matches = [...value.matchAll(PLACEHOLDER)];
  if (matches.length === 1 && matches[0][0] === value) {
    const name = matches[0][1];
    if (!(name in inputs)) throw new Error(`Unknown workflow input: ${name}`);
    return inputs[name];
  }
  return value.replace(PLACEHOLDER, (_whole, name: string) => {
    if (!(name in inputs)) throw new Error(`Unknown workflow input: ${name}`);
    return String(inputs[name]);
  });
}

export function safePath(root: string, child = "."): string {
  const base = realpathSync(resolve(root));
  const candidate = resolve(base, child);
  const relation = relative(base, candidate);
  if (relation.startsWith("..") || isAbsolute(relation)) throw new Error(`Workflow path escapes project root: ${child}`);
  let existing = candidate;
  while (!existsSync(existing)) {
    existing = dirname(existing);
  }
  const actual = realpathSync(existing);
  const actualRelation = relative(base, actual);
  if (actualRelation.startsWith("..") || isAbsolute(actualRelation)) {
    throw new Error(`Workflow path escapes project root through a link: ${child}`);
  }
  return candidate;
}

export function redact(value: string, secrets: string[] = []): string {
  let result = value.replace(SENSITIVE, "$1[REDACTED]");
  for (const secret of secrets) if (secret.length >= 4) result = result.replaceAll(secret, "[REDACTED]");
  return result;
}

export function normalizeSteps(input: unknown[]): JsonObject[] {
  const seen = new Set<string>();
  return input.map((original, index) => {
    if (!original || typeof original !== "object" || Array.isArray(original)) throw new Error(`Workflow step at index ${index} must be an object`);
    const step = { ...(original as JsonObject) };
    const stepId = String(step.id ?? `step_${index + 1}`);
    if (seen.has(stepId)) throw new Error(`Duplicate workflow step id: ${stepId}`);
    seen.add(stepId);
    const effect = String(step.side_effect ?? (step.type === "command" ? "local_write" : "read_only"));
    if (!SIDE_EFFECTS.has(effect)) throw new Error(`Unsupported side effect for ${stepId}: ${effect}`);
    return { ...step, id: stepId, side_effect: effect };
  });
}

export function approvedEffects(allowExecution: boolean, effects: unknown[] = []): Set<string> {
  const approved = new Set(["read_only"]);
  if (allowExecution) approved.add("local_write");
  for (const effect of effects) {
    if (!SIDE_EFFECTS.has(String(effect))) throw new Error(`Unsupported approved side effect: ${effect}`);
    approved.add(String(effect));
  }
  return approved;
}

export function runStep(step: JsonObject, root: string, runtimeEnv: NodeJS.ProcessEnv = {},
  runner: typeof spawnSync = spawnSync): JsonObject {
  const kind = String(step.type);
  if (kind === "command") {
    if (!Array.isArray(step.command) || !step.command.length || !step.command.every((part) => typeof part === "string")) {
      throw new Error("Command steps require a non-empty string array in command");
    }
    const cwd = safePath(root, String(step.cwd ?? "."));
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`Workflow command cwd does not exist: ${cwd}`);
    const configured = step.env ?? {};
    if (!configured || typeof configured !== "object" || Array.isArray(configured)) throw new Error("Command step env must be an object");
    const configuredEntries = Object.entries(configured as JsonObject);
    if (configuredEntries.some(([key]) => !key || key.includes("=") || key.includes("\0"))) {
      throw new Error("Command step env contains an invalid environment-variable name");
    }
    const env = { ...process.env, ...runtimeEnv, ...Object.fromEntries(configuredEntries.map(([k, v]) => [k, String(v)])) };
    const secrets = [...Object.entries(runtimeEnv), ...configuredEntries]
      .filter(([key, value]) => value !== undefined && /token|password|secret|key|cookie/i.test(key))
      .map(([, value]) => String(value));
    const timeoutSeconds = Number(step.timeout_seconds ?? 300);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
      throw new Error("timeout_seconds must be greater than 0");
    }
    const timeout = Math.min(timeoutSeconds, 3600) * 1000;
    const result = runner(step.command[0], step.command.slice(1), { cwd, env, encoding: "utf8", timeout,
      windowsHide: true, shell: false });
    const expected = Number(step.expected_exit_code ?? 0);
    if (!Number.isInteger(expected)) throw new Error("expected_exit_code must be an integer");
    return { passed: result.status === expected, exit_code: result.status, expected_exit_code: expected,
      stdout: redact((result.stdout ?? "").slice(-12000), secrets), stderr: redact((result.stderr ?? "").slice(-12000), secrets),
      ...(result.error ? { error: result.error.message } : {}) };
  }
  if (kind === "assertion") {
    if (step.evaluator === "file_exists") {
      let actual = true;
      try { statSync(safePath(root, String(step.path ?? ""))); } catch { actual = false; }
      const expected = Boolean(step.expected ?? true);
      return { passed: actual === expected, actual, expected };
    }
    if (step.evaluator === "json_value") {
      let value: unknown = JSON.parse(readFileSync(safePath(root, String(step.path ?? "")), "utf8"));
      for (const part of String(step.field ?? "").split(".").filter(Boolean)) {
        if (Array.isArray(value)) {
          if (!/^\d+$/.test(part)) { value = undefined; break; }
          value = value[Number(part)];
        } else if (value && typeof value === "object") value = (value as JsonObject)[part];
        else { value = undefined; break; }
      }
      return { passed: value === step.expected, actual: value, expected: step.expected };
    }
    throw new Error(`Unsupported assertion evaluator: ${step.evaluator}`);
  }
  if (kind === "coverage_gate") {
    const report = JSON.parse(readFileSync(safePath(root, String(step.report ?? "coverage-summary.json")), "utf8"));
    const total = report.total ?? report;
    const thresholds = { lines: Number(step.line_threshold ?? 100), branches: Number(step.branch_threshold ?? 100),
      functions: Number(step.function_threshold ?? 100), statements: Number(step.statement_threshold ?? 100) };
    const coverage = Object.fromEntries(Object.keys(thresholds).map((key) => [key, Number(total[key]?.pct ?? 0)]));
    if (Object.values(thresholds).some((value) => !Number.isFinite(value) || value < 0 || value > 100)) {
      throw new Error("Coverage thresholds must be finite percentages from 0 to 100");
    }
    if (Object.values(coverage).some((value) => !Number.isFinite(value) || value < 0 || value > 100)) {
      throw new Error("Coverage report contains an invalid percentage");
    }
    return { passed: Object.entries(thresholds).every(([key, threshold]) => Number(coverage[key]) >= threshold),
      coverage, thresholds };
  }
  throw new Error(`Unsupported workflow step type: ${kind}`);
}

export function executeSteps(steps: JsonObject[], root: string, approved: Set<string>,
  executor: typeof runStep = runStep): JsonObject[] {
  const results: JsonObject[] = [];
  for (const step of steps) {
    const effect = String(step.side_effect ?? "read_only");
    if (!approved.has(effect)) { results.push({ id: step.id, passed: false, error: "side_effect_not_approved", side_effect: effect }); break; }
    try {
      const result: JsonObject = { id: step.id, type: step.type, ...executor(step, root) };
      results.push(result);
      if (!result.passed && step.continue_on_failure !== true) break;
    } catch (error) {
      results.push({ id: step.id, type: step.type, passed: false,
        error: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) });
      if (step.continue_on_failure !== true) break;
    }
  }
  return results;
}
