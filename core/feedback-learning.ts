import { randomUUID } from "node:crypto";
import type { JsonObject } from "./infrastructure/store.ts";
import { CraftStore } from "./infrastructure/store.ts";
import { text } from "./validation.ts";
import { digestJson, payload } from "./digest.ts";


/** Records user corrections as bounded learning signals with project scope. */
export class FeedbackLearningKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  record(args: JsonObject): JsonObject {
    const signalId = String(args.signal_id ?? `feedback_signal_${randomUUID().replaceAll("-", "")}`); const scope = String(args.scope ?? "project");
    if (!["task", "project", "global"].includes(scope)) throw new Error("Unsupported feedback scope");
    const identity = { scope, project_id: args.project_id === undefined ? null : text(args.project_id, "project_id"), task_id: args.task_id === undefined ? null : text(args.task_id, "task_id"), outcome_id: args.outcome_id === undefined ? null : text(args.outcome_id, "outcome_id"), action: text(args.action, "action"), diff_digest: text(args.diff_digest, "diff_digest"), reason_digest: digestJson(text(args.reason, "reason")), accepted: args.accepted === true };
    const existing = this.store.find("feedback_signal", signalId);
    if (existing) { if (existing.identity_digest !== digestJson(identity)) throw new Error("Feedback signal idempotency conflict"); return { signal: existing, idempotent: true }; }
    return { signal: this.store.create("feedback_signal", signalId, { ...identity, identity_digest: digestJson(identity), status: "active" }), idempotent: false };
  }

  resolve(args: JsonObject): JsonObject {
    const signal = this.store.get("feedback_signal", text(args.signal_id, "signal_id")); const reusable = signal.scope === "global" || signal.scope === "project" && args.project_id !== undefined && signal.project_id === args.project_id;
    const status = args.stale === true ? "stale" : reusable ? "reusable" : "project_only";
    const saved = status === "stale" && signal.status !== "stale" ? this.store.save("feedback_signal", String(signal.id), { ...payload(signal), status }) : signal;
    return { signal: saved, status, reusable };
  }
}
