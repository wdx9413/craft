import { createHash, randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { text } from "./validation.ts";
import { digestJson, payload } from "./digest.ts";

function now(value: unknown): string { const result = value === undefined ? new Date().toISOString() : text(value, "now"); if (Number.isNaN(Date.parse(result))) throw new Error("now must be an ISO timestamp"); return result; }

/** Durable wait/release/wake/revalidate protocol. It never attempts to reattach a dead Host process. */
export class LongTaskWorkerKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  suspend(args: JsonObject): JsonObject {
    const session = this.store.get("work_session", text(args.session_id, "session_id")); const taskRun = args.task_run_id === undefined ? null : this.store.get("task_run", text(args.task_run_id, "task_run_id"));
    if (taskRun && taskRun.contract_id && taskRun.launch_id && this.store.get("work_launch", String(taskRun.launch_id)).task_id !== session.task_id) throw new Error("Task Run does not belong to the session");
    const checkpointId = String(args.checkpoint_id ?? `long_task_${randomUUID().replaceAll("-", "")}`); const waitCondition = text(args.wait_condition, "wait_condition"); const resumeAction = text(args.resume_action ?? "revalidate_and_resume", "resume_action"); const state = { session_id: session.id, session_version: session.version, task_run_id: taskRun?.id ?? null, task_run_version: taskRun?.version ?? null, host_run_id: args.host_run_id ?? null, wait_condition: waitCondition, resume_action: resumeAction, context_digest: session.context_digest, state_digest: digestJson({ session: session.id, session_version: session.version, task_run: taskRun?.id ?? null, task_run_version: taskRun?.version ?? null, wait_condition: waitCondition, resume_action: resumeAction }) };
    const existing = this.store.find("long_task_checkpoint", checkpointId); if (existing) { if (existing.state_digest !== state.state_digest) throw new Error("Long Task checkpoint idempotency conflict"); return { checkpoint: existing, idempotent: true }; }
    const expiresAt = args.expires_at === undefined ? null : now(args.expires_at);
    const checkpoint = this.store.create("long_task_checkpoint", checkpointId, { ...state, status: "waiting", released: true, wake_signal_digest: null, expires_at: expiresAt, created_at_input: now(args.now), last_revalidated_at: null, failure: null });
    return { checkpoint, idempotent: false, host_released: true };
  }

  wake(args: JsonObject): JsonObject {
    const checkpoint = this.store.get("long_task_checkpoint", text(args.checkpoint_id, "checkpoint_id")); if (!["waiting", "wake_requested"].includes(String(checkpoint.status))) throw new Error("Long Task checkpoint is not waiting");
    const signal = text(args.signal, "signal"); const saved = this.store.save("long_task_checkpoint", String(checkpoint.id), { ...payload(checkpoint), status: "wake_requested", wake_signal_digest: digestJson(signal), wake_reason: args.reason === undefined ? null : text(args.reason, "reason"), woken_at: now(args.now) }); return { checkpoint: saved, idempotent: false };
  }

  resume(args: JsonObject): JsonObject {
    const checkpoint = this.store.get("long_task_checkpoint", text(args.checkpoint_id, "checkpoint_id")); if (!["wake_requested", "waiting"].includes(String(checkpoint.status))) throw new Error("Long Task checkpoint cannot resume from its current state");
    const session = this.store.find("work_session", String(checkpoint.session_id)); const issues: JsonObject[] = []; if (!session) issues.push({ component: "work_session", issue: "missing" }); else if (Number(session.version) < Number(checkpoint.session_version)) issues.push({ component: "work_session", issue: "version_regressed" }); else if (session.context_digest !== checkpoint.context_digest) issues.push({ component: "work_session", issue: "context_changed" });
    const status = issues.length ? "needs_replan" : "ready"; const saved = this.store.save("long_task_checkpoint", String(checkpoint.id), { ...payload(checkpoint), status, last_revalidated_at: now(args.now), failure: issues.length ? issues : null, resume_mode: issues.length ? "replan" : "fresh_host_dispatch" }); return { checkpoint: saved, ready: !issues.length, issues, resume: issues.length ? null : { mode: "fresh_host_dispatch", task_run_id: checkpoint.task_run_id, session_id: checkpoint.session_id } };
  }

  get(args: JsonObject): JsonObject { return { checkpoint: this.store.get("long_task_checkpoint", text(args.checkpoint_id, "checkpoint_id")) }; }

  list(args: JsonObject = {}): JsonObject { const limit = args.limit === undefined ? 50 : Number(args.limit); if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("limit must be an integer between 1 and 500"); return { checkpoints: this.store.list("long_task_checkpoint", limit, (item) => args.session_id === undefined || item.session_id === args.session_id) }; }

  /** One bounded background-worker tick for expiry and externally woken checkpoints. */
  tick(args: JsonObject = {}): JsonObject {
    const at = now(args.now); const due = this.store.list("long_task_checkpoint", 500, (item) => ["waiting", "wake_requested"].includes(String(item.status)) && (item.expires_at === null || item.expires_at === undefined || Date.parse(String(item.expires_at)) <= Date.parse(at)));
    const processed: JsonObject[] = [];
    for (const checkpoint of due) {
      if (checkpoint.status === "waiting") processed.push(this.store.save("long_task_checkpoint", String(checkpoint.id), { ...payload(checkpoint), status: "needs_replan", failure: [{ component: "wait", issue: "expired" }], last_revalidated_at: at, resume_mode: "replan" }));
      else processed.push(this.resume({ checkpoint_id: checkpoint.id, now: at }).checkpoint as JsonObject);
    }
    return { at, processed, count: processed.length, content_free: true };
  }
}
