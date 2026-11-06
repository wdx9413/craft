import { randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { payload, stableDigest } from "./digest.ts";
import { text } from "./validation.ts";

/**
 * The one durable fact shared by a Host, a Sandbox and an Evaluator.
 *
 * This module deliberately does not contain a prompt, a cookie, a token or a
 * business response.  It records references and digests only.  The external
 * Host remains responsible for doing the work; the module is responsible for
 * making completion, uncertainty and reconciliation explicit.
 */
export const RUNTIME_ATTEMPT_STATUSES = [
  "prepared", "dispatched", "receipt_pending", "observing", "effect_unknown",
  "reconcile_required", "accepted", "failed", "blocked", "cancelled", "needs_replan",
] as const;
export type RuntimeAttemptStatus = typeof RUNTIME_ATTEMPT_STATUSES[number];
export type EffectClass = "read_only" | "local_write" | "external_write" | "destructive";
export type EffectResolution = "confirmed_success" | "confirmed_failure" | "still_unknown";

const EFFECTS = new Set<EffectClass>(["read_only", "local_write", "external_write", "destructive"]);
const SECRET = /(?:api[_-]?key|authorization|bearer|cookie|password|passwd|secret|token)\s*[:=]/iu;
const TERMINAL = new Set<RuntimeAttemptStatus>(["accepted", "failed", "blocked", "cancelled"]);

function id(value: unknown, name: string, prefix: string): string {
  const result = value === undefined || value === null ? `${prefix}_${randomUUID().replaceAll("-", "")}` : text(value, name);
  if (!/^[a-zA-Z0-9_-]+$/u.test(result)) throw new Error(`${name} must contain only letters, numbers, _ or -`);
  return result;
}

function effect(value: unknown): EffectClass {
  const result = text(value ?? "read_only", "effect") as EffectClass;
  if (!EFFECTS.has(result)) throw new Error("Unsupported runtime effect");
  return result;
}

function safeDigest(value: unknown, name: string): string {
  const result = text(value, name);
  if (SECRET.test(result)) throw new Error(`${name} must not contain credentials or secrets`);
  return result;
}

function status(value: unknown): RuntimeAttemptStatus {
  const result = text(value, "status") as RuntimeAttemptStatus;
  if (!RUNTIME_ATTEMPT_STATUSES.includes(result)) throw new Error("Unsupported runtime attempt status");
  return result;
}

function requireTransition(current: RuntimeAttemptStatus, allowed: readonly RuntimeAttemptStatus[], action: string): void {
  if (!allowed.includes(current)) throw new Error(`Runtime attempt cannot ${action} from ${current}`);
}

/** Durable runtime facts and recovery decisions. It is a kernel, not a Host runner. */
export class RuntimeExecutionAttemptKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  prepare(args: JsonObject): JsonObject {
    const attemptId = id(args.attempt_id, "attempt_id", "attempt");
    const identity = {
      task_id: text(args.task_id, "task_id"), work_loop_id: text(args.work_loop_id, "work_loop_id"),
      run_id: text(args.run_id, "run_id"), attempt_id: attemptId, host_id: text(args.host_id, "host_id"),
      environment_digest: safeDigest(args.environment_digest, "environment_digest"), effect_class: effect(args.effect_class),
      idempotency_key: safeDigest(args.idempotency_key, "idempotency_key"),
    };
    const duplicate = this.store.list("runtime_execution_attempt", 10_000,
      (item) => item.idempotency_key === identity.idempotency_key);
    if (duplicate.length && duplicate[0]!.id !== attemptId) throw new Error("idempotency_key is already bound to another runtime attempt");
    const existing = this.store.find("runtime_execution_attempt", attemptId);
    const identityDigest = stableDigest(identity);
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Runtime attempt idempotency conflict");
      return { attempt: existing, idempotent: true };
    }
    return { attempt: this.store.create("runtime_execution_attempt", attemptId, {
      ...identity, identity_digest: identityDigest, status: "prepared", receipt_id: null,
      observation_id: null, outcome_id: null, recovery_required: false,
    }), idempotent: false };
  }

  dispatch(args: JsonObject): JsonObject { return this.move(args, "dispatched", ["prepared"], { dispatch_ref: safeDigest(args.dispatch_ref ?? "dispatch", "dispatch_ref") }); }

  receiptPending(args: JsonObject): JsonObject {
    const receiptId = id(args.receipt_id, "receipt_id", "receipt");
    return this.move(args, "receipt_pending", ["dispatched"], { receipt_id: receiptId });
  }

  recordReceipt(args: JsonObject): JsonObject {
    const attempt = this.read(args); const current = status(attempt.status);
    requireTransition(current, ["receipt_pending", "dispatched", "observing", "effect_unknown", "reconcile_required", "failed"], "record receipt");
    const receiptId = id(args.receipt_id ?? attempt.receipt_id, "receipt_id", "receipt");
    const receiptPayload = {
      task_id: attempt.task_id, work_loop_id: attempt.work_loop_id, run_id: attempt.run_id,
      attempt_id: attempt.id, host_id: attempt.host_id, environment_digest: attempt.environment_digest,
      effect_class: attempt.effect_class, idempotency_key: attempt.idempotency_key,
      result_digest: safeDigest(args.result_digest ?? "result", "result_digest"), raw_content: false,
    };
    const existing = this.store.find("runtime_receipt", receiptId);
    if (existing) {
      if (existing.attempt_id !== attempt.id || existing.result_digest !== receiptPayload.result_digest) throw new Error("Receipt idempotency conflict");
      return { receipt: existing, attempt, idempotent: true };
    }
    const receipt = this.store.create("runtime_receipt", receiptId, receiptPayload);
    const saved = this.store.save("runtime_execution_attempt", String(attempt.id), { ...payload(attempt), receipt_id: receipt.id, status: current === "receipt_pending" ? "observing" : current });
    return { receipt, attempt: saved, idempotent: false };
  }

  observe(args: JsonObject): JsonObject {
    const attempt = this.read(args);
    requireTransition(status(attempt.status), ["receipt_pending", "dispatched", "observing", "reconcile_required"], "observe");
    const observationId = id(args.observation_id, "observation_id", "observation");
    const observedStatus = text(args.observed_status ?? "observed", "observed_status");
    if (!["observed", "failed", "unknown"].includes(observedStatus)) throw new Error("Unsupported observed_status");
    const observation = this.store.find("runtime_observation", observationId) ?? this.store.create("runtime_observation", observationId, {
      task_id: attempt.task_id, run_id: attempt.run_id, attempt_id: attempt.id, host_id: attempt.host_id,
      observed_status: observedStatus, evidence_digest: safeDigest(args.evidence_digest ?? "evidence", "evidence_digest"), raw_content: false,
    });
    if (observation.attempt_id !== attempt.id) throw new Error("Observation does not belong to the runtime attempt");
    const next: RuntimeAttemptStatus = observedStatus === "unknown" ? "effect_unknown" : observedStatus === "failed" ? "failed" : "observing";
    const saved = this.store.save("runtime_execution_attempt", String(attempt.id), { ...payload(attempt), status: next, observation_id: observation.id, recovery_required: next === "effect_unknown" });
    return { attempt: saved, observation, idempotent: attempt.observation_id === observation.id && attempt.status === next };
  }

  resolveEffect(args: JsonObject): JsonObject {
    const attempt = this.read(args); const current = status(attempt.status);
    requireTransition(current, ["effect_unknown", "reconcile_required", "observing", "failed"], "resolve effect");
    const resolution = text(args.resolution, "resolution") as EffectResolution;
    if (!["confirmed_success", "confirmed_failure", "still_unknown"].includes(resolution)) throw new Error("Unsupported effect resolution");
    const receiptId = args.receipt_id === undefined ? attempt.receipt_id : id(args.receipt_id, "receipt_id", "receipt");
    if (receiptId !== null && receiptId !== undefined) {
      const receipt = this.store.find("runtime_receipt", String(receiptId));
      if (receipt && (receipt.attempt_id !== attempt.id || receipt.task_id !== attempt.task_id || receipt.run_id !== attempt.run_id)) throw new Error("Receipt does not belong to the runtime attempt");
    }
    const next: RuntimeAttemptStatus = resolution === "confirmed_success" ? "accepted" : resolution === "confirmed_failure" ? "failed" : "reconcile_required";
    const saved = this.store.save("runtime_execution_attempt", String(attempt.id), { ...payload(attempt), status: next, receipt_id: receiptId ?? null, recovery_required: next === "reconcile_required", resolution });
    return { attempt: saved, idempotent: current === next && attempt.resolution === resolution };
  }

  recover(args: JsonObject): JsonObject {
    const attempt = this.read(args); const current = status(attempt.status);
    requireTransition(current, ["effect_unknown", "receipt_pending", "reconcile_required", "observing"], "recover");
    // Recovery never dispatches again. It asks a Host/adapter to reconcile the
    // existing idempotency key and records that fact for the next observation.
    const saved = this.store.save("runtime_execution_attempt", String(attempt.id), { ...payload(attempt), status: "reconcile_required", recovery_required: true, recovery_reason_digest: safeDigest(args.reason ?? "recovery", "reason") });
    return { attempt: saved, replay_allowed: false, decision: "reconcile_existing_effect" };
  }

  cancel(args: JsonObject): JsonObject {
    const attempt = this.read(args); const current = status(attempt.status);
    if (TERMINAL.has(current)) return { attempt, idempotent: true };
    const saved = this.store.save("runtime_execution_attempt", String(attempt.id), { ...payload(attempt), status: "cancelled", cancel_reason_digest: safeDigest(args.reason ?? "cancelled", "reason") });
    return { attempt: saved, idempotent: false };
  }

  get(args: JsonObject): JsonObject { return { attempt: this.read(args) }; }

  private read(args: JsonObject): JsonObject { return this.store.get("runtime_execution_attempt", text(args.attempt_id, "attempt_id")); }

  private move(args: JsonObject, next: RuntimeAttemptStatus, allowed: readonly RuntimeAttemptStatus[], fields: JsonObject): JsonObject {
    const attempt = this.read(args); const current = status(attempt.status);
    if (current === next) return { attempt, idempotent: true };
    requireTransition(current, allowed, next);
    return { attempt: this.store.save("runtime_execution_attempt", String(attempt.id), { ...payload(attempt), ...fields, status: next }), idempotent: false };
  }
}
