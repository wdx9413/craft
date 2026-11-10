import { createHash } from "node:crypto";
import type { CraftStore, JsonObject } from "../../infrastructure/store.ts";

/** The only durable task entrypoint. A conversational turn intentionally has no Run. */
export type InteractionMode = "turn" | "goal" | "plan" | "execute" | "verify" | "learn";

export type WorkControlPorts = Readonly<{
  prepare(args: JsonObject): JsonObject;
  advance(args: JsonObject): JsonObject;
  decide(args: JsonObject): JsonObject;
  resume(args: JsonObject): JsonObject;
  get(args: JsonObject): JsonObject;
}>;

const MODES = new Set<InteractionMode>(["turn", "goal", "plan", "execute", "verify", "learn"]);

function modeOf(value: unknown): InteractionMode {
  // Existing verified-loop callers predate InteractionMode and supplied no
  // explicit mode. Preserve their clarification-first semantics; only an
  // explicit execute mode requires a complete Accept contract.
  const mode = value === undefined ? "goal" : value;
  if (typeof mode !== "string" || !MODES.has(mode as InteractionMode)) {
    throw new Error("interaction_mode must be turn, goal, plan, execute, verify, or learn");
  }
  return mode as InteractionMode;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);
}

/**
 * WorkControl is deliberately small: it owns the public task protocol while
 * ports retain the existing launch, observation and acceptance implementations.
 * This prevents a second state machine from appearing during the extraction of
 * CraftService into coordinators.
 */
export class WorkControl {
  readonly store: CraftStore;
  readonly ports: WorkControlPorts;
  constructor(store: CraftStore, ports: WorkControlPorts) { this.store = store; this.ports = ports; }

  prepare(args: JsonObject): JsonObject {
    const mode = modeOf(args.interaction_mode ?? args.mode);
    if (mode === "turn") {
      return {
        interaction_mode: "turn", durable: false, status: "ready",
        protocol: ["context", "capability", "permission", "environment"],
        reason: "ordinary conversational turns do not create a Task, Run, Receipt, or Outcome",
      };
    }
    const prepared = this.ports.prepare({ ...args, mode, defer_host_start: mode === "plan" ? true : args.defer_host_start });
    return { interaction_mode: mode, durable: true, ...prepared };
  }

  advance(args: JsonObject): JsonObject {
    const advanced = this.ports.advance({ ...args, no_progress_limit: args.no_progress_limit ?? 2 });
    const loop = advanced.loop as JsonObject | undefined;
    const state = advanced.state as JsonObject | undefined;
    if (loop && state?.status === "needs_replan") {
      const reason = String(state.reason ?? loop.needs_replan_reason ?? "state_drift");
      const handoffId = `work_control_handoff_${loop.id}_${digest({ reason, state: loop.latest_task_run_state_id, snapshot: loop.latest_snapshot_id })}`;
      const handoff = this.store.find("work_control_handoff", handoffId) ?? this.store.create("work_control_handoff", handoffId, {
        work_loop_id: loop.id, task_id: loop.task_id, task_run_id: loop.task_run_id, reason,
        action: "checkpoint_and_replan", status: "open",
      });
      return { ...advanced, handoff };
    }
    return advanced;
  }

  decide(args: JsonObject): JsonObject { return this.ports.decide(args); }

  resume(args: JsonObject): JsonObject {
    const current = this.ports.get(args);
    const loop = current.loop as JsonObject;
    if (loop.lifecycle === "needs_replan") {
      return { status: "needs_replan", action: "prepare", reason: loop.needs_replan_reason, work_loop: loop };
    }
    const observed = this.advance(args);
    if ((observed.state as JsonObject | undefined)?.status === "needs_replan") return observed;
    return { ...this.ports.resume(args), revalidated: true };
  }

  get(args: JsonObject): JsonObject { return this.ports.get(args); }
}
