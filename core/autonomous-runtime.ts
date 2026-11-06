import { createHash, randomUUID } from "node:crypto";
import type { JsonObject } from "./infrastructure/store.ts";
import { CraftStore } from "./infrastructure/store.ts";
import { text } from "./validation.ts";
import { digestJson, payload } from "./digest.ts";

export type RuntimeTurn =
  | { kind: "action"; action: string; args?: JsonObject; tokens?: number }
  | { kind: "final"; message: string; tokens?: number };

export interface RuntimeModel {
  next(input: { goal: string; history: JsonObject[]; checkpoint: JsonObject | null }): Promise<RuntimeTurn>;
}

export type RuntimeExecutor = (action: string, args: JsonObject) => Promise<JsonObject>;

export interface RuntimeLimits { max_steps: number; max_tokens: number }

function limits(value: unknown): RuntimeLimits {
  const input = (value && typeof value === "object" && !Array.isArray(value)) ? value as JsonObject : {};
  const maxSteps = input.max_steps === undefined ? 24 : Number(input.max_steps);
  const maxTokens = input.max_tokens === undefined ? 120_000 : Number(input.max_tokens);
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 1_000) throw new Error("max_steps must be an integer between 1 and 1000");
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 10_000_000) throw new Error("max_tokens must be an integer between 1 and 10000000");
  return { max_steps: maxSteps, max_tokens: maxTokens };
}

function safeArgs(value: unknown): JsonObject {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("action args must be an object");
  const serialized = JSON.stringify(value);
  if (/(?:["']?)(?:api[_-]?key|authorization|cookie|password|secret|token)(?:["']?)\s*[:=]/iu.test(serialized)) throw new Error("action args must not contain secrets");
  return value as JsonObject;
}

export class AutonomousRuntimeKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  prepare(args: JsonObject): JsonObject {
    const taskId = text(args.task_id, "task_id");
    const goal = text(args.goal, "goal");
    const model = text(args.model, "model");
    const runId = String(args.run_id ?? `autonomous_run_${randomUUID().replaceAll("-", "")}`);
    const runLimits = limits(args.limits);
    const requestDigest = digestJson({ task_id: taskId, goal, model, limits: runLimits });
    const existing = this.store.find("autonomous_run", runId);
    if (existing) {
      if (existing.request_digest !== requestDigest) throw new Error("Autonomous run idempotency conflict");
      return { run: existing, idempotent: true };
    }
    const run = this.store.create("autonomous_run", runId, {
      task_id: taskId, goal, model, limits: runLimits, request_digest: requestDigest,
      status: "ready", steps: 0, tokens_used: 0, checkpoint_id: null, resume_count: 0,
    });
    return { run, idempotent: false };
  }

  private current(runId: string): JsonObject { return this.store.get("autonomous_run", runId); }

  checkpoint(args: JsonObject): JsonObject {
    const runId = text(args.run_id, "run_id");
    const run = this.current(runId);
    if (new Set(["completed", "failed", "cancelled"]).has(String(run.status))) throw new Error("Cannot checkpoint a terminal autonomous run");
    const state = args.state;
    if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("state must be an object");
    const serialized = JSON.stringify(state);
    if (serialized.length > 1_000_000) throw new Error("state exceeds the checkpoint limit");
    const sequence = Number(run.steps) + 1;
    const checkpointId = String(args.checkpoint_id ?? `${runId}:${sequence}`);
    const checkpoint = this.store.create("autonomous_checkpoint", checkpointId, {
      run_id: runId, sequence, reason: String(args.reason ?? "turn"), state_digest: digestJson(state), state: state as JsonObject,
    });
    const saved = this.store.save("autonomous_run", runId, { ...payload(run), checkpoint_id: checkpoint.id, status: "paused" });
    return { run: saved, checkpoint, idempotent: false };
  }

  resume(args: JsonObject): JsonObject {
    const runId = text(args.run_id, "run_id");
    const run = this.current(runId);
    if (run.status === "completed" || run.status === "cancelled") return { run, checkpoint: run.checkpoint_id ? this.store.get("autonomous_checkpoint", String(run.checkpoint_id)) : null, idempotent: true };
    const checkpointId = args.checkpoint_id === undefined ? run.checkpoint_id : text(args.checkpoint_id, "checkpoint_id");
    const checkpoint = checkpointId ? this.store.get("autonomous_checkpoint", String(checkpointId)) : null;
    if (checkpoint && checkpoint.run_id !== runId) throw new Error("Checkpoint belongs to another run");
    const saved = this.store.save("autonomous_run", runId, { ...payload(run), status: "running", resume_count: Number(run.resume_count) + 1 });
    return { run: saved, checkpoint, idempotent: false };
  }

  async run(args: JsonObject, model: RuntimeModel, executor: RuntimeExecutor): Promise<JsonObject> {
    const prepared = this.prepare(args);
    let run = prepared.run as JsonObject;
    if (run.status === "paused") run = this.resume({ run_id: run.id }).run as JsonObject;
    if (run.status === "ready") run = this.store.save("autonomous_run", String(run.id), { ...payload(run), status: "running" });
    const history = this.store.list("autonomous_turn", Number.MAX_SAFE_INTEGER, (item) => item.run_id === run.id).sort((left, right) => Number(left.sequence) - Number(right.sequence));
    let checkpoint = run.checkpoint_id ? this.store.get("autonomous_checkpoint", String(run.checkpoint_id)) : null;
    while (run.status === "running") {
      const runLimits = run.limits as RuntimeLimits;
      if (Number(run.steps) >= runLimits.max_steps || Number(run.tokens_used) >= runLimits.max_tokens) {
        run = this.store.save("autonomous_run", String(run.id), { ...payload(run), status: "failed", failure: "runtime_limit" });
        break;
      }
      const turn = await model.next({ goal: String(run.goal), history, checkpoint });
      const tokens = turn.tokens === undefined ? 0 : Number(turn.tokens);
      if (!Number.isInteger(tokens) || tokens < 0) throw new Error("turn tokens must be a non-negative integer");
      const sequence = Number(run.steps) + 1;
      if (turn.kind === "final") {
        const message = text(turn.message, "final message");
        this.store.create("autonomous_turn", `${run.id}:${sequence}`, { run_id: run.id, sequence, kind: "final", message, tokens });
        run = this.store.save("autonomous_run", String(run.id), { ...payload(run), status: "completed", steps: sequence, tokens_used: Number(run.tokens_used) + tokens, final_message: message });
        break;
      }
      const action = text(turn.action, "action");
      const actionArgs = safeArgs(turn.args);
      const outcome = await executor(action, actionArgs);
      this.store.create("autonomous_turn", `${run.id}:${sequence}`, { run_id: run.id, sequence, kind: "action", action, args_digest: digestJson(actionArgs), outcome_digest: digestJson(outcome), tokens });
      history.push(this.store.get("autonomous_turn", `${run.id}:${sequence}`));
      run = this.store.save("autonomous_run", String(run.id), { ...payload(run), status: "running", steps: sequence, tokens_used: Number(run.tokens_used) + tokens });
      const savedCheckpoint = this.checkpoint({ run_id: run.id, checkpoint_id: `${run.id}:checkpoint:${sequence}`, reason: "action", state: { sequence, action, outcome_digest: digestJson(outcome) } });
      checkpoint = savedCheckpoint.checkpoint as JsonObject;
      run = this.store.save("autonomous_run", String(run.id), { ...payload(savedCheckpoint.run as JsonObject), status: "running" });
    }
    return { run, turns: this.store.list("autonomous_turn", Number.MAX_SAFE_INTEGER, (item) => item.run_id === run.id), checkpoint };
  }

  cancel(args: JsonObject): JsonObject {
    const run = this.current(text(args.run_id, "run_id"));
    if (new Set(["completed", "failed", "cancelled"]).has(String(run.status))) return { run, idempotent: true };
    return { run: this.store.save("autonomous_run", String(run.id), { ...payload(run), status: "cancelled", cancel_reason: text(args.reason ?? "cancelled", "reason") }), idempotent: false };
  }

  get(args: JsonObject): JsonObject {
    const run = this.current(text(args.run_id, "run_id"));
    return { run, turns: this.store.list("autonomous_turn", Number.MAX_SAFE_INTEGER, (item) => item.run_id === run.id), checkpoints: this.store.list("autonomous_checkpoint", Number.MAX_SAFE_INTEGER, (item) => item.run_id === run.id) };
  }
}
