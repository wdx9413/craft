import { ExternalEffectKernel } from "./effects.js";
/**
 * Wrap an `ExternalEffectKernel` so that every dispatch and receipt runs
 * through a `RuntimeDriver`. This is the seam that lets safety, statistics
 * and evaluation live in hooks without rewiring every caller of the
 * underlying kernel.
 *
 * The wrapper preserves the existing kernel's contract:
 *
 * - `prepare` / `start` / `report` / `resolve` / `reconcile*` / `compensate*`
 *   delegate to the inner kernel;
 * - `start` runs the `before_effect` hook chain synchronously (the
 *   built-ins are CPU-only) and refuses to dispatch when a `fail_closed`
 *   hook blocks;
 * - `report` runs `after_receipt` and marks the runtime operation complete;
 * - any thrown error from the inner kernel triggers `on_failure` and the
 *   exception is re-thrown unchanged.
 */
export class HookedEffectKernel {
    kernel;
    runtime;
    constructor(kernel, runtime) {
        this.kernel = kernel;
        this.runtime = runtime;
    }
    prepare(args) {
        return this.kernel.prepare(args);
    }
    /**
     * Dispatch an external effect. Creates a `runtime_operation` first so
     * the hook chain has a stable id to audit against.
     */
    start(args) {
        const operation = this.allocateOperation(args);
        const hookPayload = { effect_id: args.effect_id, action: args.action, target: args.target };
        const verdict = this.runtime.runBeforeEffectSync(operation, hookPayload);
        if (verdict.blocked && this.runtime.strictHooks) {
            throw new Error(`Runtime hook chain blocked dispatch of effect ${String(args.effect_id)}`);
        }
        try {
            const result = this.kernel.start(args);
            this.runtime.completeOperation(operation, {
                receipt_id: String(args.effect_id),
                status: "completed",
            });
            return result;
        }
        catch (error) {
            this.runtime.runOnFailureSync(operation, { error: errorMessage(error) });
            throw error;
        }
    }
    report(args) {
        const operationId = String(args.operation_id ?? args.effect_id);
        const operation = this.lookupOperation(operationId);
        try {
            const result = this.kernel.report(args);
            this.runtime.runAfterReceiptSync(operation, {
                receipt_id: String(args.receipt_id), status: String(args.status),
            });
            return result;
        }
        catch (error) {
            this.runtime.runOnFailureSync(operation, { error: errorMessage(error) });
            throw error;
        }
    }
    resolve(args) { return this.kernel.resolve(args); }
    reconcileIssue(args) { return this.kernel.reconcileIssue(args); }
    reconcileReport(args) { return this.kernel.reconcileReport(args); }
    reconcileFail(args) { return this.kernel.reconcileFail(args); }
    compensateIssue(args) { return this.kernel.compensateIssue(args); }
    compensateFromExecution(args) { return this.kernel.compensateFromExecution(args); }
    compensateCancel(args) { return this.kernel.compensateCancel(args); }
    compensateReport(args) { return this.kernel.compensateReport(args); }
    sagaCreate(args) { return this.kernel.sagaCreate(args); }
    sagaGet(args) { return this.kernel.sagaGet(args); }
    allocateOperation(args) {
        return this.runtime.startOperation({
            route_id: String(args.route_id ?? args.task_id ?? "unrouted"),
            idempotency_key: String(args.idempotency_key ?? String(args.effect_id ?? "missing-key")),
            effect_class: String(args.effect_class ?? "execute"),
            effect_scope: String(args.effect_scope ?? String(args.target ?? "unknown")),
            policy_hash: String(args.policy_hash ?? "unhashed"),
            expires_at: String(args.expires_at ?? new Date(Date.now() + 5 * 60_000).toISOString()),
            operation_id: String(args.operation_id ?? args.effect_id),
        });
    }
    lookupOperation(operationId) {
        try {
            const found = this.runtime.store.find("runtime_operation", operationId);
            return found ?? this.syntheticOperation(operationId);
        }
        catch {
            return this.syntheticOperation(operationId);
        }
    }
    syntheticOperation(operationId) {
        return {
            id: operationId, route_id: "synthetic", idempotency_key: `synthetic:${operationId}`,
            effect_class: "execute", effect_scope: "synthetic", policy_hash: "synthetic",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            status: "executing", attempt: 1, retry_count: 0,
            pending_approval_ref: null, finished_at: null,
        };
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=hooked-effect-kernel.js.map