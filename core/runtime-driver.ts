import { createHash, randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { defaultHooks, runHooks, type HookOutcome, type HookSpec, type HookRun } from "./hooks.ts";
import { object, text } from "./validation.ts";
import { digestJson } from "./digest.ts";

/**
 * Effect classes the runtime driver recognises. Each `Operation` declares
 * which class it belongs to so the hook chain can make routing decisions
 * (audit-log / token-meter / receipt-check) without inspecting payloads.
 */
export type EffectClass = "read" | "write" | "execute" | "network" | "publish";
const EFFECT_CLASSES: readonly string[] = ["read", "write", "execute", "network", "publish"];

/** Narrow validation seam used by the method-level coverage suite. */
export const runtimeDriverInternalsForTest = { text, object };

function isEffectClass(value: unknown): value is EffectClass {
  return typeof value === "string" && EFFECT_CLASSES.includes(value);
}

/**
 * One durable runtime operation. Bound to a Route, an idempotency key, an
 * effect class and an explicit expiry. The four lifecycle states
 * (`pending_approval` / `executing` / `completed` / `timed_out` /
 * `crash_recovered`) cover the OpenAI Agents SDK-style pause/resume
 * contract Craft already commits to.
 */
export interface RuntimeOperation extends JsonObject {
  id: string;
  route_id: string;
  idempotency_key: string;
  effect_class: EffectClass;
  effect_scope: string;
  policy_hash: string;
  expires_at: string;
  status: "pending_approval" | "executing" | "completed" | "timed_out" | "crash_recovered";
  attempt: number;
  retry_count: number;
  pending_approval_ref: string | null;
  finished_at: string | null;
}

export interface RuntimeDriverOptions {
  /** When false, hooks still emit events but fail_closed never blocks. */
  strictHooks?: boolean;
  /** Override the default hooks; defaults to `defaultHooks()` from hooks.ts. */
  hooks?: readonly HookSpec[];
  /** Provide a clock for tests. Defaults to `Date.now`. */
  now?: () => Date;
  /** Override the persistence sink for tests. Defaults to writing `events` rows. */
  onHookEvent?: (event: JsonObject) => void;
}

/**
 * Orchestrator that ties the hook chain to the Effect dispatch surface.
 *
 * The driver is intentionally stateless beyond its configuration: callers
 * feed operations into it, the driver persists them, runs the hooks, and
 * returns the result. This keeps it composable with the existing
 * `ExternalEffectKernel` rather than wrapping it.
 */
export class RuntimeDriver {
  readonly store: CraftStore;
  readonly strictHooks: boolean;
  readonly hooks: readonly HookSpec[];
  readonly now: () => Date;
  readonly onHookEvent: (event: JsonObject) => void;

  constructor(store: CraftStore, options: RuntimeDriverOptions = {}) {
    this.store = store;
    this.strictHooks = options.strictHooks !== false;
    this.hooks = options.hooks ?? defaultHooks();
    this.now = options.now ?? (() => new Date());
    this.onHookEvent = options.onHookEvent ?? ((event) => {
      // Persist every hook outcome to the `events` stream so an operator
      // can later query `craft_hook_audit` and prove the chain actually
      // ran on the real dispatch path — not just on the manual entry.
      this.store.appendEvent("hook", event.event_type as string, event);
    });
  }

  /**
   * Validate a candidate operation and persist it. Returns the saved
   * RuntimeOperation; throws on schema violations so a misuse is reported
   * before any hook fires.
   */
  startOperation(args: JsonObject): RuntimeOperation {
    const idempotencyKey = text(args.idempotency_key, "idempotency_key");
    if (!/^[a-zA-Z0-9._:-]{8,200}$/u.test(idempotencyKey)) {
      throw new Error("idempotency_key must be stable and 8-200 safe characters");
    }
    const effectClass = args.effect_class;
    if (!isEffectClass(effectClass)) throw new Error(`effect_class must be one of ${EFFECT_CLASSES.join("|")}`);
    const routeId = text(args.route_id, "route_id");
    const effectScope = text(args.effect_scope, "effect_scope");
    const policyHash = text(args.policy_hash, "policy_hash");
    const expiresAt = text(args.expires_at, "expires_at");
    if (Number.isNaN(Date.parse(expiresAt))) throw new Error("expires_at must be an ISO-8601 datetime");
    if (Date.parse(expiresAt) <= this.now().getTime()) throw new Error("expires_at must be in the future");
    const operationId = String(args.operation_id ?? `runtime_op_${randomUUID().replaceAll("-", "")}`);
    const pendingApproval = args.pending_approval_ref === undefined ? null : text(args.pending_approval_ref, "pending_approval_ref");
    const existing = this.store.find("runtime_operation", operationId);
    if (existing) {
      // Replay-safe: same idempotency_key + same operation_id returns the
      // existing record. A different idempotency_key on the same id is a
      // conflict that the operator must investigate.
      if (existing.idempotency_key !== idempotencyKey) {
        throw new Error(`Runtime operation ${operationId} already exists with a different idempotency_key`);
      }
      return existing as RuntimeOperation;
    }
    const operation = this.store.create("runtime_operation", operationId, {
      route_id: routeId, idempotency_key: idempotencyKey, effect_class: effectClass,
      effect_scope: effectScope, policy_hash: policyHash, expires_at: expiresAt,
      status: pendingApproval ? "pending_approval" : "executing",
      attempt: 1, retry_count: 0, pending_approval_ref: pendingApproval,
      finished_at: null,
    });
    this.onHookEvent({
      event_type: "operation_started", operation_id: operation.id, route_id: routeId,
      effect_class: effectClass, idempotency_key: idempotencyKey, expires_at: expiresAt,
      strict_hooks: this.strictHooks,
    });
    return operation as RuntimeOperation;
  }

  /**
   * Run the `before_effect` hook chain against an operation. The hook
   * results and the verdict are returned so the caller can decide how to
   * react (the strict path blocks the dispatch, the lenient path records
   * the failure but proceeds).
   */
  async runBeforeEffect(operation: RuntimeOperation, payload: JsonObject): Promise<HookRun> {
    return this.runFor("before_effect", operation, payload);
  }

  /** Run the `after_receipt` hook chain. Always observational; never blocks. */
  async runAfterReceipt(operation: RuntimeOperation, payload: JsonObject): Promise<HookRun> {
    return this.runFor("after_receipt", operation, payload);
  }

  /** Run the `on_failure` hook chain. Records the failure; never blocks. */
  async runOnFailure(operation: RuntimeOperation, payload: JsonObject): Promise<HookRun> {
    return this.runFor("on_failure", operation, payload);
  }

  /**
   * Synchronously run the builtin hooks for a point. Exposed so the
   * `HookedEffectKernel` can dispatch effects without an async hop. The
   * returned shape mirrors `runHooks` so callers can inspect outcomes.
   */
  runBeforeEffectSync(operation: RuntimeOperation, payload: JsonObject): HookRun {
    const merged = object({ operation_id: operation.id, route_id: operation.route_id,
      effect_class: operation.effect_class, idempotency_key: operation.idempotency_key,
      effect_scope: operation.effect_scope, ...payload }, "before_effect payload");
    return this.runSync("before_effect", merged, operation);
  }

  runAfterReceiptSync(operation: RuntimeOperation, payload: JsonObject): HookRun {
    const merged = object({ operation_id: operation.id, route_id: operation.route_id,
      effect_class: operation.effect_class, idempotency_key: operation.idempotency_key,
      effect_scope: operation.effect_scope, ...payload }, "after_receipt payload");
    return this.runSync("after_receipt", merged, operation);
  }

  runOnFailureSync(operation: RuntimeOperation, payload: JsonObject): HookRun {
    const merged = object({ operation_id: operation.id, route_id: operation.route_id,
      effect_class: operation.effect_class, idempotency_key: operation.idempotency_key,
      effect_scope: operation.effect_scope, ...payload }, "on_failure payload");
    return this.runSync("on_failure", merged, operation);
  }

  /**
   * Evaluate a single builtin hook without going through the full chain.
   * Used by `HookedEffectKernel.start` so the synchronous dispatcher can
   * reuse the same builtin logic as the async one.
   */
  invokeBuiltinSync(hook: HookSpec, point: string, body: JsonObject): JsonObject {
    return this.invokeBuiltin(hook, point, body);
  }

  /** Persist the outcomes of a synchronous hook run to the audit trail. */
  recordHookRun(point: "before_effect" | "after_receipt" | "on_failure",
    run: HookRun, operation: RuntimeOperation): void {
    for (const outcome of run.outcomes) {
      this.onHookEvent({
        event_type: `hook_${point}`, hook_id: outcome.hook_id, point: outcome.point,
        status: outcome.status, fail_policy: outcome.fail_policy,
        detail: outcome.detail, operation_id: operation.id,
      });
    }
  }

  /**
   * Mark an operation complete and emit a single completion event so the
   * metrics aggregator has a stable signal.
   */
  completeOperation(operation: RuntimeOperation, outcome: { receipt_id: string; status: string }): RuntimeOperation {
    const saved = this.store.updateIfVersion("runtime_operation", String(operation.id), Number(operation.version), {
      ...this.payload(operation), status: outcome.status as RuntimeOperation["status"],
      finished_at: this.now().toISOString(),
    });
    this.onHookEvent({
      event_type: "operation_completed", operation_id: saved.id, route_id: saved.route_id,
      receipt_id: outcome.receipt_id, status: outcome.status,
      duration_ms: this.now().getTime() - Date.parse(String(saved.created_at)),
    });
    return saved as RuntimeOperation;
  }

  /** Mark an operation timed out and emit a timeout event. */
  timeoutOperation(operation: RuntimeOperation, reason: string): RuntimeOperation {
    const saved = this.store.updateIfVersion("runtime_operation", String(operation.id), Number(operation.version), {
      ...this.payload(operation), status: "timed_out", finished_at: this.now().toISOString(),
    });
    this.onHookEvent({
      event_type: "operation_timed_out", operation_id: saved.id, reason,
    });
    return saved as RuntimeOperation;
  }

  /**
   * Resume an operation after a crash. The driver refuses to resume if the
   * saved operation has expired; the caller must then produce a fresh
   * `startOperation` instead.
   */
  recoverOperation(operationId: string): RuntimeOperation {
    const operation = this.store.get("runtime_operation", operationId) as RuntimeOperation;
    if (Date.parse(operation.expires_at) <= this.now().getTime()) {
      throw new Error(`Runtime operation ${operationId} has expired and cannot be recovered`);
    }
    if (operation.status !== "executing" && operation.status !== "pending_approval") {
      throw new Error(`Runtime operation ${operationId} is not resumable from status ${operation.status}`);
    }
    const saved = this.store.updateIfVersion("runtime_operation", String(operation.id), Number(operation.version), {
      ...this.payload(operation), status: "crash_recovered", retry_count: Number(operation.retry_count) + 1,
    });
    this.onHookEvent({
      event_type: "operation_recovered", operation_id: saved.id, retry_count: saved.retry_count,
    });
    return saved as RuntimeOperation;
  }

  /** List the most recent hook events for the audit trail. */
  recentHookEvents(limit = 50): HookOutcome[] {
    return this.store.events("hook").slice(-limit).map((row) => {
      const payload = row.payload as JsonObject;
      return {
        hook_id: String(payload.hook_id ?? "unknown"),
        point: String(payload.point ?? row.event_type),
        status: (payload.status as HookOutcome["status"]) ?? "passed",
        fail_policy: (payload.fail_policy as HookOutcome["fail_policy"]) ?? "fail_closed",
        detail: (payload.detail as string | null) ?? null,
      } as HookOutcome;
    });
  }

  private payload(record: JsonObject): JsonObject {
    const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record;
    return rest;
  }

  private async runFor(point: "before_effect" | "after_receipt" | "on_failure",
    operation: RuntimeOperation, payload: JsonObject): Promise<HookRun> {
    const merged = object({ operation_id: operation.id, route_id: operation.route_id,
      effect_class: operation.effect_class, idempotency_key: operation.idempotency_key,
      effect_scope: operation.effect_scope, ...payload }, "hook payload");
    const run = await runHooks(this.hooks, point, merged, {
      invoke: (hook, body) => this.invokeBuiltin(hook, point, body),
    });
    this.recordHookRun(point, run, operation);
    if (run.blocked && !this.strictHooks && point === "before_effect") {
      return { outcomes: run.outcomes, blocked: false };
    }
    return run;
  }

  private runSync(point: "before_effect" | "after_receipt" | "on_failure",
    merged: JsonObject, operation: RuntimeOperation): HookRun {
    const outcomes: HookOutcome[] = [];
    let blocked = false;
    for (const hook of this.hooks) {
      if (hook.point !== point) continue;
      let outcome: HookOutcome;
      try {
        const result = this.invokeBuiltin(hook, point, merged);
        outcome = result.ok === false
          ? { hook_id: hook.id, point, status: "failed", fail_policy: hook.fail_policy, detail: String(result.detail ?? "hook reported failure") }
          : { hook_id: hook.id, point, status: "passed", fail_policy: hook.fail_policy, detail: null };
      } catch (error) {
        outcome = { hook_id: hook.id, point, status: "failed", fail_policy: hook.fail_policy,
          detail: error instanceof Error ? error.message : String(error) };
      }
      outcomes.push(outcome);
      if (outcome.status === "failed" && hook.fail_policy === "fail_closed") {
        blocked = true;
        break;
      }
    }
    const run: HookRun = { outcomes, blocked };
    this.recordHookRun(point, run, operation);
    return run;
  }

  private invokeBuiltin(hook: HookSpec, point: string, body: JsonObject): JsonObject {
    if (hook.kind !== "builtin") throw new Error(`Hook ${hook.id} is not a builtin`);
    switch (hook.target) {
      case "builtin:audit-log":
        return { ok: true, detail: digestJson({ hook: hook.id, point, op: body.operation_id, ts: this.now().toISOString() }) };
      case "builtin:token-meter":
        // The meter is observational; the metrics aggregator writes the
        // actual counters. Returning ok keeps the chain moving.
        return { ok: true, detail: "tokens:obs" };
      case "builtin:receipt-check":
        // Receipts are written by the caller; the builtin only confirms
        // the operation carried an idempotency_key, which is required.
        if (!body.idempotency_key) return { ok: false, detail: "missing idempotency_key" };
        return { ok: true, detail: `receipt:${body.idempotency_key}` };
      default:
        return { ok: false, detail: `unknown builtin hook target: ${hook.target}` };
    }
  }
}
