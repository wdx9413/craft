import { randomUUID } from "node:crypto";
import type { JsonObject } from "./infrastructure/store.ts";
import { CraftStore } from "./infrastructure/store.ts";
import { text } from "./validation.ts";
import { digestJson, payload } from "./digest.ts";


export type ReplayExecutor = (action: string, contract: JsonObject, sequence: number) => Promise<JsonObject>;

/** Revalidation-gated replay runner. It never runs a stale trace. */
export class ReplayRunnerKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  prepare(args: JsonObject): JsonObject {
    const traceId = text(args.trace_id, "trace_id");
    const trace = this.store.get("trace", traceId);
    if (!["completed", "failed", "cancelled", "blocked"].includes(String(trace.status))) throw new Error("Replay requires a terminal Trace");
    const events = this.store.list("trace_event", 10_000, (item) => item.trace_id === traceId && item.action_contract !== null)
      .sort((left, right) => Number(left.sequence) - Number(right.sequence));
    if (!events.length) throw new Error("Trace has no replayable action contracts");
    const replayId = String(args.replay_id ?? `replay_${randomUUID().replaceAll("-", "")}`);
    const identity = { trace_id: traceId, trace_version: trace.version, event_ids: events.map((event) => event.id), approval_ref: text(args.approval_ref, "approval_ref"), workspace_digest: text(args.workspace_digest, "workspace_digest") };
    const replayDigest = digestJson(identity);
    const existing = this.store.find("replay_run", replayId);
    if (existing) {
      if (existing.replay_digest !== replayDigest) throw new Error("Replay idempotency conflict");
      return { replay: existing, idempotent: true };
    }
    return { replay: this.store.create("replay_run", replayId, { ...identity, replay_digest: replayDigest, status: "prepared", completed_steps: 0, results: [] }), idempotent: false };
  }

  async execute(args: JsonObject, executor?: ReplayExecutor): Promise<JsonObject> {
    const replay = this.store.get("replay_run", text(args.replay_id, "replay_id"));
    if (replay.status === "completed") return { replay, idempotent: true };
    if (replay.status !== "prepared") throw new Error("Replay is not prepared");
    if (args.approval_ref !== undefined && text(args.approval_ref, "approval_ref") !== replay.approval_ref) throw new Error("Replay approval does not match");
    const trace = this.store.get("trace", String(replay.trace_id));
    if (Number(trace.version) !== Number(replay.trace_version)) throw new Error("Replay source Trace changed; revalidate first");
    const events = (replay.event_ids as string[]).map((id) => this.store.get("trace_event", id));
    const results: JsonObject[] = [];
    for (const event of events) {
      const result = executor ? await executor(String(event.event_kind), event.action_contract as JsonObject, Number(event.sequence)) : { mode: "dry_run", action: event.event_kind, sequence: event.sequence };
      results.push({ sequence: event.sequence, result_digest: digestJson(result) });
    }
    const saved = this.store.save("replay_run", String(replay.id), { ...payload(replay), status: "completed", completed_steps: results.length, results, finished_at: new Date().toISOString() });
    return { replay: saved, results, idempotent: false };
  }

  get(args: JsonObject): JsonObject { return { replay: this.store.get("replay_run", text(args.replay_id, "replay_id")) }; }
}
