import { randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { payload, stableDigest } from "./digest.ts";
import { text } from "./validation.ts";

export const WORKBENCH_COMMANDS = ["goal_update", "context_set", "acceptance_set", "approve", "reject", "pause", "resume", "cancel", "replan", "effect_unknown_confirm", "checkpoint_restore"] as const;
export type WorkbenchCommandName = typeof WORKBENCH_COMMANDS[number];
export type WorkbenchCommandDispatcher = (command: JsonObject) => JsonObject | Promise<JsonObject>;

function id(value: unknown): string { return value === undefined ? `command_${randomUUID().replaceAll("-", "")}` : text(value, "command_id"); }
function commandName(value: unknown): WorkbenchCommandName {
  const result = text(value, "command") as WorkbenchCommandName;
  if (!WORKBENCH_COMMANDS.includes(result)) throw new Error("Unsupported Workbench command");
  return result;
}

/** Versioned human commands. It persists only a digest and delegates effects to Craft Service. */
export class WorkbenchCommandKernel {
  readonly store: CraftStore;
  readonly dispatch?: WorkbenchCommandDispatcher;
  constructor(store: CraftStore, dispatch?: WorkbenchCommandDispatcher) { this.store = store; this.dispatch = dispatch; }

  async execute(args: JsonObject): Promise<JsonObject> {
    const commandId = id(args.command_id); const taskId = text(args.task_id, "task_id");
    const command = commandName(args.command); const actor = text(args.actor, "actor"); const decision = text(args.decision, "decision");
    const expectedVersion = Number(args.expected_version);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new Error("expected_version must be a positive integer");
    const reasonDigest = text(args.reason_digest, "reason_digest");
    const target = { task_id: taskId, command, actor, decision, expected_version: expectedVersion, reason_digest: reasonDigest };
    const existing = this.store.find("workbench_command", commandId);
    if (existing) {
      if (existing.command_digest !== stableDigest(target)) throw new Error("Workbench command idempotency conflict");
      return { command: existing, result: existing.result ?? null, idempotent: true };
    }
    const state = this.store.find("workbench_command_state", taskId);
    const currentVersion = Number(state?.version ?? 0);
    if (expectedVersion !== currentVersion + 1) throw new Error(`Workbench command version conflict: expected ${currentVersion + 1}`);
    const record = this.store.create("workbench_command", commandId, { ...target, command_digest: stableDigest(target), status: "prepared", result: null });
    let result: JsonObject = { accepted: true, command: commandName(command) };
    try { if (this.dispatch) result = await this.dispatch(record); }
    catch (error) {
      const failed = this.store.save("workbench_command", commandId, { ...payload(record), status: "failed", failure_digest: stableDigest(String(error)) });
      throw Object.assign(new Error("Workbench command dispatch failed"), { cause: error, command: failed });
    }
    const saved = this.store.save("workbench_command", commandId, { ...payload(record), status: "applied", result_digest: stableDigest(result), result });
    this.store.save("workbench_command_state", taskId, { task_id: taskId, version: expectedVersion, last_command_id: commandId });
    return { command: saved, result, idempotent: false };
  }

  get(args: JsonObject): JsonObject { return { command: this.store.get("workbench_command", text(args.command_id, "command_id")) }; }
  list(args: JsonObject = {}): JsonObject { const taskId = args.task_id === undefined ? undefined : text(args.task_id, "task_id"); return { commands: this.store.list("workbench_command", Number(args.limit ?? 100), (item) => taskId === undefined || item.task_id === taskId) }; }
}
