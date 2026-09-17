import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

const STATES = new Set(["prepared", "awaiting_approval", "running", "paused", "awaiting_acceptance", "ready_for_delivery", "completed", "failed", "cancelled", "needs_replan", "blocked"]);
function text(v: unknown, name: string): string { if (typeof v !== "string" || !v.trim()) throw new Error(`${name} must not be empty`); return v.trim(); }
function digest(v: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(v)).digest("hex")}`; }

/** Append-only task state events plus a replayable latest projection. */
export class TaskStateKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }
  transition(args: JsonObject): JsonObject {
    const taskId = text(args.task_id, "task_id"); const state = text(args.state, "state"); if (!STATES.has(state)) throw new Error("task state is unsupported");
    const current = this.store.find("task_state_projection", taskId); const expected = args.expected_revision === undefined ? Number(current?.state_revision ?? 0) : Number(args.expected_revision); if (!Number.isInteger(expected) || expected < 0) throw new Error("expected_revision must be a non-negative integer");
    if (Number(current?.state_revision ?? 0) !== expected) throw new Error("Concurrent task state update; refresh before writing");
    const actor = text(args.actor ?? "system", "actor"); const reason = text(args.reason ?? "state transition", "reason"); const evidenceIds = Array.isArray(args.evidence_ids) ? (args.evidence_ids as unknown[]).map((x) => text(x, "evidence_ids")) : [];
    evidenceIds.forEach((e) => this.store.get("evidence", e)); const revision = expected + 1; const event = this.store.appendEvent(`task:${taskId}`, "task_state_changed", { task_id: taskId, state, state_revision: revision, actor, reason_digest: digest(reason), evidence_ids: evidenceIds });
    const projection = this.store.save("task_state_projection", taskId, { task_id: taskId, state, state_revision: revision, last_event_sequence: event.sequence, actor, reason_digest: digest(reason), evidence_ids: evidenceIds });
    return { event, projection };
  }
  get(args: JsonObject): JsonObject { const taskId = text(args.task_id, "task_id"); return { projection: this.store.find("task_state_projection", taskId), events: this.store.events(`task:${taskId}`) }; }
  replay(args: JsonObject): JsonObject { const taskId = text(args.task_id, "task_id"); let state = "prepared"; let revision = 0; for (const event of this.store.events(`task:${taskId}`)) { const p = event.payload as JsonObject; state = String(p.state); revision = Number(p.state_revision); } return { task_id: taskId, state, state_revision: revision, event_count: this.store.events(`task:${taskId}`).length }; }
}
