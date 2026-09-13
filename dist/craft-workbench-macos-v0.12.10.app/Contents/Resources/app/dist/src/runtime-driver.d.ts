import { CraftStore, type JsonObject } from "./store.ts";
import { type HookOutcome, type HookSpec, type HookRun } from "./hooks.ts";
/**
 * Effect classes the runtime driver recognises. Each `Operation` declares
 * which class it belongs to so the hook chain can make routing decisions
 * (audit-log / token-meter / receipt-check) without inspecting payloads.
 */
export type EffectClass = "read" | "write" | "execute" | "network" | "publish";
declare function text(value: unknown, name: string): string;
declare function object(value: unknown, name: string): JsonObject;
/** Narrow validation seam used by the method-level coverage suite. */
export declare const runtimeDriverInternalsForTest: {
    text: typeof text;
    object: typeof object;
};
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
export declare class RuntimeDriver {
    readonly store: CraftStore;
    readonly strictHooks: boolean;
    readonly hooks: readonly HookSpec[];
    readonly now: () => Date;
    readonly onHookEvent: (event: JsonObject) => void;
    constructor(store: CraftStore, options?: RuntimeDriverOptions);
    /**
     * Validate a candidate operation and persist it. Returns the saved
     * RuntimeOperation; throws on schema violations so a misuse is reported
     * before any hook fires.
     */
    startOperation(args: JsonObject): RuntimeOperation;
    /**
     * Run the `before_effect` hook chain against an operation. The hook
     * results and the verdict are returned so the caller can decide how to
     * react (the strict path blocks the dispatch, the lenient path records
     * the failure but proceeds).
     */
    runBeforeEffect(operation: RuntimeOperation, payload: JsonObject): Promise<HookRun>;
    /** Run the `after_receipt` hook chain. Always observational; never blocks. */
    runAfterReceipt(operation: RuntimeOperation, payload: JsonObject): Promise<HookRun>;
    /** Run the `on_failure` hook chain. Records the failure; never blocks. */
    runOnFailure(operation: RuntimeOperation, payload: JsonObject): Promise<HookRun>;
    /**
     * Synchronously run the builtin hooks for a point. Exposed so the
     * `HookedEffectKernel` can dispatch effects without an async hop. The
     * returned shape mirrors `runHooks` so callers can inspect outcomes.
     */
    runBeforeEffectSync(operation: RuntimeOperation, payload: JsonObject): HookRun;
    runAfterReceiptSync(operation: RuntimeOperation, payload: JsonObject): HookRun;
    runOnFailureSync(operation: RuntimeOperation, payload: JsonObject): HookRun;
    /**
     * Evaluate a single builtin hook without going through the full chain.
     * Used by `HookedEffectKernel.start` so the synchronous dispatcher can
     * reuse the same builtin logic as the async one.
     */
    invokeBuiltinSync(hook: HookSpec, point: string, body: JsonObject): JsonObject;
    /** Persist the outcomes of a synchronous hook run to the audit trail. */
    recordHookRun(point: "before_effect" | "after_receipt" | "on_failure", run: HookRun, operation: RuntimeOperation): void;
    /**
     * Mark an operation complete and emit a single completion event so the
     * metrics aggregator has a stable signal.
     */
    completeOperation(operation: RuntimeOperation, outcome: {
        receipt_id: string;
        status: string;
    }): RuntimeOperation;
    /** Mark an operation timed out and emit a timeout event. */
    timeoutOperation(operation: RuntimeOperation, reason: string): RuntimeOperation;
    /**
     * Resume an operation after a crash. The driver refuses to resume if the
     * saved operation has expired; the caller must then produce a fresh
     * `startOperation` instead.
     */
    recoverOperation(operationId: string): RuntimeOperation;
    /** List the most recent hook events for the audit trail. */
    recentHookEvents(limit?: number): HookOutcome[];
    private payload;
    private runFor;
    private runSync;
    private invokeBuiltin;
}
export {};
