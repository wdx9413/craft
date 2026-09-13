/**
 * Lifecycle hook points, so safety, statistics, and evaluation do not have to be
 * hardwired into each executor. Craft never spawns a process from this module:
 * the caller injects an invoker, which keeps the policy pure and testable and
 * keeps the decision about *where* a command may run in one place.
 */
export const HOOK_POINTS = ["before_step", "after_step", "before_effect", "after_receipt", "on_failure"];
/** Built-in hook targets Craft can always satisfy without an external process. */
export const BUILTIN_HOOK_TARGETS = ["builtin:audit-log", "builtin:token-meter", "builtin:receipt-check"];
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
export function defaultHooks() {
    return defineHooks([
        { id: "audit-log", point: "before_effect", kind: "builtin", target: "builtin:audit-log" },
        { id: "token-meter", point: "before_effect", kind: "builtin", target: "builtin:token-meter" },
        { id: "receipt-check", point: "after_receipt", kind: "builtin", target: "builtin:receipt-check" },
    ]);
}
const HOOK_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const FAIL_POLICIES = ["fail_closed", "fail_open"];
const MAX_TIMEOUT_MS = 60_000;
function text(value, name) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${name} must not be empty`);
    return value.trim();
}
export function defineHook(input) {
    const id = text(input.id, "hook id");
    if (!HOOK_ID.test(id))
        throw new Error(`Unsupported hook id: ${id}`);
    const point = text(input.point, "hook point");
    if (!HOOK_POINTS.includes(point))
        throw new Error(`Unsupported hook point: ${point}`);
    const kind = text(input.kind, "hook kind");
    if (!["builtin", "command"].includes(kind))
        throw new Error(`Unsupported hook kind: ${kind}`);
    const target = text(input.target, "hook target");
    if (kind === "builtin" && !BUILTIN_HOOK_TARGETS.includes(target)) {
        throw new Error(`Unsupported builtin hook target: ${target}`);
    }
    const failPolicy = text(input.fail_policy ?? "fail_closed", "hook fail_policy");
    if (!FAIL_POLICIES.includes(failPolicy))
        throw new Error(`Unsupported hook fail policy: ${failPolicy}`);
    const timeoutMs = input.timeout_ms === undefined ? 5_000 : Number(input.timeout_ms);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
        throw new Error(`Hook timeout_ms must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
    }
    return { id, point, kind: kind, target, fail_policy: failPolicy, timeout_ms: timeoutMs };
}
/** Validate a hook list, refusing duplicate ids so one hook cannot silently replace another. */
export function defineHooks(entries) {
    if (entries === undefined || entries === null)
        return [];
    if (!Array.isArray(entries))
        throw new Error("Hooks must be an array");
    const hooks = entries.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
            throw new Error("Each hook must be an object");
        return defineHook(entry);
    });
    if (new Set(hooks.map((hook) => hook.id)).size !== hooks.length)
        throw new Error("Hooks must not repeat a hook id");
    return hooks;
}
/** Hooks for one point, in declaration order, so an audit trail reads the same way twice. */
export function planHooks(hooks, point) {
    if (!HOOK_POINTS.includes(point))
        throw new Error(`Unsupported hook point: ${point}`);
    return hooks.filter((hook) => hook.point === point);
}
/**
 * Synchronous variant of `runHooks`. Used when every hook in the chain is a
 * builtin: the built-in evaluators are pure CPU and must complete before
 * the caller dispatches its effect, so an async hop would let the caller
 * race past a fail_closed verdict. The dispatcher is expected to throw
 * when `blocked` is true.
 */
export function runHooksSync(hooks, point, payload, options) {
    const outcomes = [];
    for (const hook of planHooks(hooks, point)) {
        let outcome;
        try {
            const result = options.invoke(hook, payload);
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
            return { outcomes, blocked: true };
        }
    }
    return { outcomes, blocked: false };
}
/**
 * Run one point's hooks.
 *
 * A `fail_closed` hook that fails stops the run and sets `blocked`, which the
 * caller must treat as "do not proceed". A `fail_open` hook that fails is
 * recorded and stepped over — observation must never be able to break the work
 * it observes.
 */
export async function runHooks(hooks, point, payload, options) {
    const outcomes = [];
    for (const hook of planHooks(hooks, point)) {
        let outcome;
        try {
            const result = await options.invoke(hook, payload);
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
            return { outcomes, blocked: true };
        }
    }
    return { outcomes, blocked: false };
}
//# sourceMappingURL=hooks.js.map