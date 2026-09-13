import type { JsonObject } from "./store.ts";
/**
 * Lifecycle hook points, so safety, statistics, and evaluation do not have to be
 * hardwired into each executor. Craft never spawns a process from this module:
 * the caller injects an invoker, which keeps the policy pure and testable and
 * keeps the decision about *where* a command may run in one place.
 */
export declare const HOOK_POINTS: readonly string[];
/** Built-in hook targets Craft can always satisfy without an external process. */
export declare const BUILTIN_HOOK_TARGETS: readonly string[];
/**
 * The gates Craft declares by default.
 *
 * Three obligations must hold for every governed action: it is recorded, it is
 * measured, and it is checked against its own receipt. Declaring them once here
 * means the set has a single owner and can be reported on, instead of being
 * re-derived at each call site.
 *
 * Built-ins resolve to `{ ok: true }` under the service's own invoker, so
 * mounting them changes nothing about an existing launch — but a deployment that
 * installs a `fail_closed` command hook at the same point now has one place to
 * put it.
 */
export declare function defaultHooks(): HookSpec[];
export type HookFailPolicy = "fail_closed" | "fail_open";
export interface HookSpec {
    id: string;
    point: string;
    kind: "builtin" | "command";
    target: string;
    fail_policy: HookFailPolicy;
    timeout_ms: number;
}
export interface HookOutcome {
    hook_id: string;
    point: string;
    status: "passed" | "failed" | "skipped";
    fail_policy: HookFailPolicy;
    detail: string | null;
}
export interface HookRun {
    outcomes: HookOutcome[];
    blocked: boolean;
}
export declare function defineHook(input: JsonObject): HookSpec;
/** Validate a hook list, refusing duplicate ids so one hook cannot silently replace another. */
export declare function defineHooks(entries: unknown): HookSpec[];
/** Hooks for one point, in declaration order, so an audit trail reads the same way twice. */
export declare function planHooks(hooks: readonly HookSpec[], point: string): HookSpec[];
/**
 * Synchronous variant of `runHooks`. Used when every hook in the chain is a
 * builtin: the built-in evaluators are pure CPU and must complete before
 * the caller dispatches its effect, so an async hop would let the caller
 * race past a fail_closed verdict. The dispatcher is expected to throw
 * when `blocked` is true.
 */
export declare function runHooksSync(hooks: readonly HookSpec[], point: string, payload: JsonObject, options: {
    invoke: (hook: HookSpec, payload: JsonObject) => JsonObject;
}): HookRun;
/**
 * Run one point's hooks.
 *
 * A `fail_closed` hook that fails stops the run and sets `blocked`, which the
 * caller must treat as "do not proceed". A `fail_open` hook that fails is
 * recorded and stepped over — observation must never be able to break the work
 * it observes.
 */
export declare function runHooks(hooks: readonly HookSpec[], point: string, payload: JsonObject, options: {
    invoke: (hook: HookSpec, payload: JsonObject) => JsonObject | Promise<JsonObject>;
}): Promise<HookRun>;
