import { createHash } from "node:crypto";
import type { JsonObject } from "./infrastructure/store.ts";
import { text } from "./validation.ts";
import { digestJson } from "./digest.ts";

/**
 * The execution body for a Sub-agent Run.
 *
 * A Sub-agent existed previously only as a *record*: `expert_subagent_create`
 * wrote a pending `runtime_operation` and `expert_subagent_report` accepted a
 * report that an external host had to produce. Craft therefore owned the
 * governance half of delegation (budget, parent funding, limits, receipts) and
 * was missing the half that does the work -- a child model loop with its own
 * context window. That is the mechanism the literature agrees on for containing
 * context rot, so having only the shell meant the capability was claimed and not
 * delivered.
 *
 * Three properties are enforced here rather than trusted to a caller:
 *
 *  1. **Isolation is structural.** The child runs as its own dispatch, so it gets
 *     its own session key and therefore its own message list. It cannot read or
 *     corrupt the parent's transcript, and the parent receives only the bounded
 *     report.
 *  2. **Authority is read-only.** A sub-agent may observe and reason, never write
 *     on the parent's behalf. A delegating parent that wants effects applies them
 *     itself, after reading the report.
 *  3. **Cost is parent-funded and shallow.** Depth is capped (default 1: a child
 *     may not spawn a child) and the child's budget is a bounded slice of what the
 *     parent has left, so a runaway branch cannot outspend its owner.
 */

export interface SubagentLimits {
  depth: number;
  max_depth: number;
  budget_tokens: number;
  max_steps: number;
  max_context_tokens: number;
}

export interface SubagentPlan {
  accepted: boolean;
  reason: string;
  limits: SubagentLimits;
}

export interface SubagentReport extends JsonObject {
  objective: string;
  status: "completed" | "failed";
  depth: number;
  session_id: string;
  dispatch_id: string;
  steps: number;
  tokens_used: number;
  final_message: string | null;
  failure: string | null;
  receipt_digest: string | null;
  isolated_session: true;
  execution_authority: false;
}



function bounded(value: unknown, name: string, fallback: number, minimum: number, maximum: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return result;
}



/** The share of a parent's remaining budget a single child may claim. */
const DEFAULT_SHARE = 0.5;
const MINIMUM_CHILD_TOKENS = 512;

/**
 * Decide whether a Sub-agent may run, and with what budget.
 *
 * Refusals are named rather than flattened into one error, because "why was this
 * delegation refused" is the question a governance review actually asks.
 */
export function planSubagentExecution(input: JsonObject): SubagentPlan {
  const parentDepth = bounded(input.parent_depth, "parent_depth", 0, 0, 32);
  const maxDepth = bounded(input.max_depth, "max_depth", 1, 1, 32);
  const depth = parentDepth + 1;
  const remaining = bounded(input.parent_remaining_tokens, "parent_remaining_tokens", 0, 0, 10_000_000);
  const parentSteps = bounded(input.parent_max_steps, "parent_max_steps", 30, 1, 1_000);
  const parentContext = bounded(input.parent_max_context_tokens, "parent_max_context_tokens", 32_000, 256, 10_000_000);
  const share = input.budget_share === undefined ? DEFAULT_SHARE : Number(input.budget_share);
  if (!(share > 0 && share <= 1)) throw new Error("budget_share must be greater than 0 and at most 1");
  const effect = input.effect === undefined ? "read_only" : text(input.effect, "effect");

  const limits: SubagentLimits = { depth, max_depth: maxDepth, budget_tokens: 0,
    max_steps: Math.max(1, Math.min(parentSteps, bounded(input.max_steps, "max_steps", 8, 1, 1_000))),
    max_context_tokens: Math.min(parentContext,
      bounded(input.max_context_tokens, "max_context_tokens", parentContext, 256, 10_000_000)) };

  if (effect !== "read_only") return { accepted: false, reason: "subagent_must_be_read_only", limits };
  if (depth > maxDepth) return { accepted: false, reason: "subagent_depth_exhausted", limits };
  const budget = Math.floor(remaining * share);
  if (budget < MINIMUM_CHILD_TOKENS) return { accepted: false, reason: "insufficient_parent_budget", limits };
  limits.budget_tokens = Math.min(budget, remaining);
  return { accepted: true, reason: "accepted", limits };
}
export interface SubagentExecutionInput {
  operation_id: string;
  task_id: string;
  objective: string;
  plan: SubagentPlan;
  /** Prepare one child dispatch. Wired to the internal host by the service. */
  prepare: (args: JsonObject) => JsonObject;
  /** Execute that dispatch. Wired to the internal host by the service. */
  execute: (args: JsonObject) => Promise<JsonObject>;
}

/**
 * Run the child loop and return the bounded report the parent may read.
 *
 * The child is a normal internal dispatch, so it inherits every guarantee the
 * loop already has (receipt, trace, circuit breakers) and adds exactly two: a
 * distinct session and a smaller budget ceiling.
 */
export async function executeSubagent(input: SubagentExecutionInput): Promise<SubagentReport> {
  if (!input.plan.accepted) throw new Error(`Sub-agent Run refused: ${input.plan.reason}`);
  const objective = text(input.objective, "objective");
  const dispatchId = `subagent_${input.operation_id}`;
  const prepared = input.prepare({ task_id: text(input.task_id, "task_id"), prompt: objective, dispatch_id: dispatchId,
    limits: { max_tokens: input.plan.limits.budget_tokens,
      max_context_tokens: input.plan.limits.max_context_tokens,
      max_steps: input.plan.limits.max_steps } });
  const dispatch = (prepared.dispatch ?? {}) as JsonObject;
  const id = String(dispatch.id ?? dispatchId);
  const executed = await input.execute({ dispatch_id: id, prompt: objective });
  const receipt = (executed.receipt ?? {}) as JsonObject;
  const loop = (receipt.loop ?? {}) as JsonObject;
  // `== null` covers both an absent and an explicit null field in one branch, so
  // the "no value" path is exercised rather than merely present.
  const summary = (value: unknown): string | null => (value == null ? null : String(value));
  return {
    objective,
    status: receipt.status === "completed" ? "completed" : "failed",
    depth: input.plan.limits.depth,
    // The child's own session key: this is what makes the report the *only* thing
    // the parent can see of the child's reasoning.
    session_id: `session_${id}`,
    dispatch_id: id,
    steps: Number(loop.steps ?? 0),
    tokens_used: Number(loop.tokens_used ?? 0),
    final_message: summary(receipt.final_message),
    failure: summary(receipt.failure),
    receipt_digest: Object.keys(receipt).length ? digestJson(receipt) : null,
    isolated_session: true,
    execution_authority: false,
  };
}
