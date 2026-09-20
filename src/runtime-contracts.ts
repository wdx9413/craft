import { createHash } from "node:crypto";
import type { JsonObject } from "./infrastructure/store.ts";

export const INTERACTION_MODES = ["turn", "goal", "plan", "execute", "verify", "learn"] as const;
export type InteractionMode = typeof INTERACTION_MODES[number];

export interface TargetDefinition {
  readonly subject: string;
  readonly scope?: string;
  readonly desired_state?: string;
}

export interface StepDefinition {
  readonly id: string;
  readonly description: string;
  readonly action?: string;
  readonly preconditions?: readonly string[];
  readonly failure_action?: "retry" | "pause" | "replan" | "abort";
}

export interface PlanDefinition {
  readonly steps: readonly StepDefinition[];
  readonly strategy?: string;
}

export interface AcceptDefinition {
  readonly criteria: readonly string[];
  readonly observer?: string;
  readonly artifact_refs?: readonly string[];
}

export interface TaskSemantics {
  readonly goal: string;
  readonly mode: InteractionMode;
  readonly target?: TargetDefinition;
  readonly plan?: PlanDefinition;
  readonly accept?: AcceptDefinition;
}

export interface EnvironmentDefinition {
  readonly sandbox: string;
  readonly runtime: string;
  readonly network?: "deny" | "allow" | "restricted";
}

export interface HarnessDefinition {
  readonly context: readonly ("history" | "knowledge" | "memory" | "experience" | "state")[];
  readonly tools: readonly string[];
  readonly permission: JsonObject;
  readonly environment: EnvironmentDefinition;
}

export function digestContract(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

export function normalizeTaskSemantics(input: JsonObject): TaskSemantics {
  const mode = String(input.mode ?? "goal") as InteractionMode;
  if (!INTERACTION_MODES.includes(mode)) throw new Error(`Unsupported interaction mode: ${mode}`);
  const goal = nonEmpty(input.goal, "goal");
  if (mode === "turn") return { goal, mode };
  const rawTarget = input.target as JsonObject | undefined;
  const target = rawTarget ? {
    subject: nonEmpty(rawTarget.subject, "target.subject"),
    ...(rawTarget.scope === undefined ? {} : { scope: nonEmpty(rawTarget.scope, "target.scope") }),
    ...(rawTarget.desired_state === undefined ? {} : { desired_state: nonEmpty(rawTarget.desired_state, "target.desired_state") }),
  } : undefined;
  const rawPlan = input.plan as JsonObject | undefined;
  const steps = Array.isArray(rawPlan?.steps) ? rawPlan.steps.map((item, index) => {
    const step = item as JsonObject;
    return {
      id: nonEmpty(step.id ?? `step_${index + 1}`, `plan.steps[${index}].id`),
      description: nonEmpty(step.description, `plan.steps[${index}].description`),
      ...(step.action === undefined ? {} : { action: nonEmpty(step.action, `plan.steps[${index}].action`) }),
      ...(Array.isArray(step.preconditions) ? { preconditions: step.preconditions.map((value) => nonEmpty(value, "step.precondition")) } : {}),
      failure_action: ["retry", "pause", "replan", "abort"].includes(String(step.failure_action)) ? String(step.failure_action) as StepDefinition["failure_action"] : "pause",
    };
  }) : [];
  const plan = rawPlan || steps.length ? { steps, ...(rawPlan?.strategy === undefined ? {} : { strategy: nonEmpty(rawPlan.strategy, "plan.strategy") }) } : undefined;
  const rawAccept = (input.accept ?? input.acceptance) as JsonObject | undefined;
  const criteria = Array.isArray(rawAccept?.criteria) ? rawAccept.criteria.map((value) => {
    if (typeof value === "string") return nonEmpty(value, "accept.criteria");
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const item = value as JsonObject;
      return nonEmpty(item.id ?? item.name ?? item.description, "accept.criteria");
    }
    throw new Error("accept.criteria must be a string or criterion object");
  }) : [];
  const accept = rawAccept || criteria.length ? {
    criteria,
    ...(rawAccept?.observer === undefined ? {} : { observer: nonEmpty(rawAccept.observer, "accept.observer") }),
    ...(Array.isArray(rawAccept?.artifact_refs) ? { artifact_refs: rawAccept.artifact_refs.map((value) => nonEmpty(value, "accept.artifact_ref")) } : {}),
  } : undefined;
  if (["execute", "verify"].includes(mode) && !accept) throw new Error(`${mode} mode requires accept criteria`);
  return { goal, mode, ...(target ? { target } : {}), ...(plan ? { plan } : {}), ...(accept ? { accept } : {}) };
}

export function validateHarness(input: JsonObject): HarnessDefinition {
  const environment = input.environment as JsonObject;
  if (!environment) throw new Error("harness.environment is required");
  const context = Array.isArray(input.context) ? input.context.map(String) : [];
  const allowed = new Set(["history", "knowledge", "memory", "experience", "state"]);
  if (context.some((value) => !allowed.has(value))) throw new Error("harness.context contains an unsupported member");
  return {
    context: context as HarnessDefinition["context"],
    tools: Array.isArray(input.tools) ? input.tools.map((value) => nonEmpty(value, "harness.tools")) : [],
    permission: (input.permission as JsonObject | undefined) ?? {},
    environment: { sandbox: nonEmpty(environment.sandbox, "environment.sandbox"), runtime: nonEmpty(environment.runtime, "environment.runtime"), ...(environment.network === undefined ? {} : { network: String(environment.network) as EnvironmentDefinition["network"] }) },
  };
}
