import { createHash, randomUUID } from "node:crypto";
import { CraftStore } from "./store.js";
import { defaultHooks, runHooks } from "./hooks.js";
const EFFECT_CLASSES = ["read", "write", "execute", "network", "publish"];
function text(value, name) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${name} must not be empty`);
    return value.trim();
}
function object(value, name) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${name} must be an object`);
    return value;
}
/** Narrow validation seam used by the method-level coverage suite. */
export const runtimeDriverInternalsForTest = { text, object };
function isEffectClass(value) {
    return typeof value === "string" && EFFECT_CLASSES.includes(value);
}
function digest(value) {
    return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
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
    store;
    strictHooks;
    hooks;
    now;
    onHookEvent;
    constructor(store, options = {}) {
        this.store = store;
        this.strictHooks = options.strictHooks !== false;
        this.hooks = options.hooks ?? defaultHooks();
        this.now = options.now ?? (() => new Date());
        this.onHookEvent = options.onHookEvent ?? ((event) => {
            // Persist every hook outcome to the `events` stream so an operator
            // can later query `craft_hook_audit` and prove the chain actually
            // ran on the real dispatch path — not just on the manual entry.
            this.store.appendEvent("hook", event.event_type, event);
        });
    }
    /**
     * Validate a candidate operation and persist it. Returns the saved
     * RuntimeOperation; throws on schema violations so a misuse is reported
     * before any hook fires.
     */
    startOperation(args) {
        const idempotencyKey = text(args.idempotency_key, "idempotency_key");
        if (!/^[a-zA-Z0-9._:-]{8,200}$/u.test(idempotencyKey)) {
            throw new Error("idempotency_key must be stable and 8-200 safe characters");
        }
        const effectClass = args.effect_class;
        if (!isEffectClass(effectClass))
            throw new Error(`effect_class must be one of ${EFFECT_CLASSES.join("|")}`);
        const routeId = text(args.route_id, "route_id");
        const effectScope = text(args.effect_scope, "effect_scope");
        const policyHash = text(args.policy_hash, "policy_hash");
        const expiresAt = text(args.expires_at, "expires_at");
        if (Number.isNaN(Date.parse(expiresAt)))
            throw new Error("expires_at must be an ISO-8601 datetime");
        if (Date.parse(expiresAt) <= this.now().getTime())
            throw new Error("expires_at must be in the future");
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
            return existing;
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
        return operation;
    }
    /**
     * Run the `before_effect` hook chain against an operation. The hook
     * results and the verdict are returned so the caller can decide how to
     * react (the strict path blocks the dispatch, the lenient path records
     * the failure but proceeds).
     */
    async runBeforeEffect(operation, payload) {
        return this.runFor("before_effect", operation, payload);
    }
    /** Run the `after_receipt` hook chain. Always observational; never blocks. */
    async runAfterReceipt(operation, payload) {
        return this.runFor("after_receipt", operation, payload);
    }
    /** Run the `on_failure` hook chain. Records the failure; never blocks. */
    async runOnFailure(operation, payload) {
        return this.runFor("on_failure", operation, payload);
    }
    /**
     * Synchronously run the builtin hooks for a point. Exposed so the
     * `HookedEffectKernel` can dispatch effects without an async hop. The
     * returned shape mirrors `runHooks` so callers can inspect outcomes.
     */
    runBeforeEffectSync(operation, payload) {
        const merged = object({ operation_id: operation.id, route_id: operation.route_id,
            effect_class: operation.effect_class, idempotency_key: operation.idempotency_key,
            effect_scope: operation.effect_scope, ...payload }, "before_effect payload");
        return this.runSync("before_effect", merged, operation);
    }
    runAfterReceiptSync(operation, payload) {
        const merged = object({ operation_id: operation.id, route_id: operation.route_id,
            effect_class: operation.effect_class, idempotency_key: operation.idempotency_key,
            effect_scope: operation.effect_scope, ...payload }, "after_receipt payload");
        return this.runSync("after_receipt", merged, operation);
    }
    runOnFailureSync(operation, payload) {
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
    invokeBuiltinSync(hook, point, body) {
        return this.invokeBuiltin(hook, point, body);
    }
    /** Persist the outcomes of a synchronous hook run to the audit trail. */
    recordHookRun(point, run, operation) {
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
    completeOperation(operation, outcome) {
        const saved = this.store.updateIfVersion("runtime_operation", String(operation.id), Number(operation.version), {
            ...this.payload(operation), status: outcome.status,
            finished_at: this.now().toISOString(),
        });
        this.onHookEvent({
            event_type: "operation_completed", operation_id: saved.id, route_id: saved.route_id,
            receipt_id: outcome.receipt_id, status: outcome.status,
            duration_ms: this.now().getTime() - Date.parse(String(saved.created_at)),
        });
        return saved;
    }
    /** Mark an operation timed out and emit a timeout event. */
    timeoutOperation(operation, reason) {
        const saved = this.store.updateIfVersion("runtime_operation", String(operation.id), Number(operation.version), {
            ...this.payload(operation), status: "timed_out", finished_at: this.now().toISOString(),
        });
        this.onHookEvent({
            event_type: "operation_timed_out", operation_id: saved.id, reason,
        });
        return saved;
    }
    /**
     * Resume an operation after a crash. The driver refuses to resume if the
     * saved operation has expired; the caller must then produce a fresh
     * `startOperation` instead.
     */
    recoverOperation(operationId) {
        const operation = this.store.get("runtime_operation", operationId);
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
        return saved;
    }
    /** List the most recent hook events for the audit trail. */
    recentHookEvents(limit = 50) {
        return this.store.events("hook").slice(-limit).map((row) => {
            const payload = row.payload;
            return {
                hook_id: String(payload.hook_id ?? "unknown"),
                point: String(payload.point ?? row.event_type),
                status: payload.status ?? "passed",
                fail_policy: payload.fail_policy ?? "fail_closed",
                detail: payload.detail ?? null,
            };
        });
    }
    payload(record) {
        const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record;
        return rest;
    }
    async runFor(point, operation, payload) {
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
    runSync(point, merged, operation) {
        const outcomes = [];
        let blocked = false;
        for (const hook of this.hooks) {
            if (hook.point !== point)
                continue;
            let outcome;
            try {
                const result = this.invokeBuiltin(hook, point, merged);
                outcome = result.ok === false
                    ? { hook_id: hook.id, point, status: "failed", fail_policy: hook.fail_policy, detail: String(result.detail ?? "hook reported failure") }
                    : { hook_id: hook.id, point, status: "passed", fail_policy: hook.fail_policy, detail: null };
            }
            catch (error) {
                outcome = { hook_id: hook.id, point, status: "failed", fail_policy: hook.fail_policy,
                    detail: error instanceof Error ? error.message : String(error) };
            }
            outcomes.push(outcome);
            if (outcome.status === "failed" && hook.fail_policy === "fail_closed") {
                blocked = true;
                break;
            }
        }
        const run = { outcomes, blocked };
        this.recordHookRun(point, run, operation);
        return run;
    }
    invokeBuiltin(hook, point, body) {
        if (hook.kind !== "builtin")
            throw new Error(`Hook ${hook.id} is not a builtin`);
        switch (hook.target) {
            case "builtin:audit-log":
                return { ok: true, detail: digest({ hook: hook.id, point, op: body.operation_id, ts: this.now().toISOString() }) };
            case "builtin:token-meter":
                // The meter is observational; the metrics aggregator writes the
                // actual counters. Returning ok keeps the chain moving.
                return { ok: true, detail: "tokens:obs" };
            case "builtin:receipt-check":
                // Receipts are written by the caller; the builtin only confirms
                // the operation carried an idempotency_key, which is required.
                if (!body.idempotency_key)
                    return { ok: false, detail: "missing idempotency_key" };
                return { ok: true, detail: `receipt:${body.idempotency_key}` };
            default:
                return { ok: false, detail: `unknown builtin hook target: ${hook.target}` };
        }
    }
}
//# sourceMappingURL=runtime-driver.js.map