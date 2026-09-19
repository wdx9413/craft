import { randomUUID } from "node:crypto";
import { canonicalJson, stableDigest } from "./digest.ts";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { object, text } from "./validation.ts";

export type IntentRoute = "simple" | "governed" | "clarification";
export type CoverageMetric = "methods" | "functions" | "lines" | "statements" | "branches" | "all";

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((item) => text(item, name));
}

function inferMetric(goal: string, requested: unknown): CoverageMetric | null {
  if (requested !== undefined) {
    const metric = text(requested, "metric").toLowerCase() as CoverageMetric;
    if (!["methods", "functions", "lines", "statements", "branches", "all"].includes(metric)) throw new Error("metric is unsupported");
    return metric;
  }
  if (/(?:方法|函数|method|function)/iu.test(goal)) return "methods";
  if (/(?:行|line)/iu.test(goal)) return "lines";
  if (/(?:分支|branch)/iu.test(goal)) return "branches";
  return null;
}

function inferThreshold(goal: string, requested: unknown): number {
  const value = requested === undefined ? goal.match(/(?:^|\s)(\d{1,3})(?:\s*%)?/u)?.[1] : requested;
  const threshold = Number(value ?? 100);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) throw new Error("threshold must be between 0 and 100");
  return threshold;
}

function inferScope(goal: string, requested: unknown): "changed" | "workspace" | "specified" {
  if (requested !== undefined) {
    const scope = text(requested, "scope").toLowerCase();
    if (!["changed", "workspace", "specified"].includes(scope)) throw new Error("scope is unsupported");
    return scope as "changed" | "workspace" | "specified";
  }
  return /(?:增量|变更|diff|incremental|changed)/iu.test(goal) ? "changed" : "workspace";
}

function inferTaskType(goal: string): string {
  if (/(?:覆盖率|coverage)/iu.test(goal)) return "coverage_verification";
  if (/(?:测试|test)/iu.test(goal)) return "test_verification";
  if (/(?:研究|research|分析|analy[sz]e)/iu.test(goal)) return "research";
  if (/(?:写|生成|create|write|build|制作)/iu.test(goal)) return "creation";
  return "governed_work";
}

function clarification(metric: CoverageMetric | null, scope: string, goal: string): JsonObject[] {
  const questions: JsonObject[] = [];
  if (/(?:覆盖率|coverage)/iu.test(goal) && metric === null) questions.push({ id: "coverage_metric", question: "覆盖率按方法、行、分支还是全部指标验收？", required: true, options: ["methods", "lines", "branches", "all"] });
  if (scope === "specified") questions.push({ id: "coverage_scope", question: "请提供要验收的具体文件或方法范围。", required: true });
  return questions;
}

export class IntentCompilerKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  compile(args: JsonObject): JsonObject {
    const goal = text(args.goal, "goal");
    const metric = inferMetric(goal, args.metric);
    const scope = inferScope(goal, args.scope);
    const threshold = inferThreshold(goal, args.threshold);
    const questions = clarification(metric, scope, goal);
    const route: IntentRoute = questions.length ? "clarification" : (args.require_governance === true || goal.length > 24 || /(?:please|请|帮我|实现|完成|修复|build|run|test|测试|覆盖率|研究|生成|写)/iu.test(goal)) ? "governed" : "simple";
    const materials = args.materials === undefined ? [] : [...(Array.isArray(args.materials) ? args.materials : [args.materials]).map((value) => text(value, "materials"))];
    const nonGoals = args.non_goals === undefined ? [] : [...(Array.isArray(args.non_goals) ? args.non_goals : [args.non_goals]).map((value) => text(value, "non_goals"))];
    const allowedEffects = args.allowed_effects === undefined ? ["read_only"] : [...(Array.isArray(args.allowed_effects) ? args.allowed_effects : [args.allowed_effects]).map((value) => text(value, "allowed_effects"))];
    const acceptance = args.acceptance === undefined ? null : object(args.acceptance, "acceptance");
    const contract = {
      goal, task_type: inferTaskType(goal), route, scope, metric, threshold,
      unit: metric === "methods" ? "method" : metric === "functions" ? "function" : metric,
      workspace: args.workspace === undefined ? null : text(args.workspace, "workspace"),
      baseline: args.baseline === undefined ? "git-merge-base" : text(args.baseline, "baseline"),
      test_command: args.test_command === undefined ? null : text(args.test_command, "test_command"),
      changed_paths: args.changed_paths === undefined ? [] : strings(args.changed_paths, "changed_paths"),
      materials, non_goals: nonGoals, acceptance, allowed_effects: allowedEffects,
      host: args.host === undefined ? null : text(args.host, "host"),
      model: args.model === undefined ? null : text(args.model, "model"),
      budget: args.budget === undefined ? null : object(args.budget, "budget"),
      clarifications: questions,
      acceptance_required: route !== "simple",
      compiler_version: "0.12.8",
    } as JsonObject;
    const intentId = String(args.intent_id ?? `intent_${randomUUID().replaceAll("-", "")}`);
    const requestDigest = stableDigest(contract);
    const existing = this.store.find("task_intent", intentId);
    if (existing) {
      if (existing.request_digest !== requestDigest) throw new Error("Task intent idempotency conflict");
      return { intent: existing, idempotent: true };
    }
    const intent = this.store.create("task_intent", intentId, { ...contract, request_digest: requestDigest, status: questions.length ? "needs_clarification" : "ready" });
    return { intent, idempotent: false };
  }

  acceptanceCompile(args: JsonObject): JsonObject {
    const intent = this.store.get("task_intent", text(args.intent_id, "intent_id"));
    if (intent.route === "clarification") throw new Error("Task intent requires clarification before acceptance compilation");
    if (!intent.acceptance_required) throw new Error("Simple intents do not require an acceptance contract");
    const isCoverage = intent.task_type === "coverage_verification";
    const metric = intent.metric === null ? null : text(intent.metric, "intent metric");
    const criterion = isCoverage ? {
      id: "coverage", name: `${String(intent.scope) === "changed" ? "Incremental" : "Workspace"} ${String(metric)} coverage`, method: "program", evaluator: "coverage_report",
      scope: intent.scope, metric, threshold: intent.threshold, unit: intent.unit, command: intent.test_command, changed_paths: intent.changed_paths,
      evidence: ["test_receipt", "coverage_report", "git_scope"],
    } : intent.acceptance ?? {
      id: "goal", name: "User-defined goal completion", method: "human", evaluator: "human_confirmation", goal: intent.goal,
      materials: intent.materials, non_goals: intent.non_goals, evidence: ["host_receipt", "artifact", "human_confirmation"],
    };
    const definition = { intent_id: intent.id, intent_version: intent.version, criteria: [criterion], definition_digest: stableDigest({ intent_id: intent.id, intent_version: intent.version, criterion }) };
    const contractId = String(args.acceptance_id ?? `acceptance_${intent.id}`);
    const existing = this.store.find("acceptance_contract", contractId);
    if (existing) {
      if (existing.definition_digest !== definition.definition_digest) throw new Error("Acceptance contract idempotency conflict");
      return { acceptance: existing, idempotent: true };
    }
    return { acceptance: this.store.create("acceptance_contract", contractId, { ...definition, status: "active" }), idempotent: false };
  }

  get(args: JsonObject): JsonObject { return { intent: this.store.get("task_intent", text(args.intent_id, "intent_id")) }; }
  acceptanceGet(args: JsonObject): JsonObject { return { acceptance: this.store.get("acceptance_contract", text(args.acceptance_id, "acceptance_id")) }; }
}