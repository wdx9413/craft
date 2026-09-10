import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { SandboxKernel } from "./sandbox.js";
import { CraftStore } from "./store.js";
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function integer(value, name, minimum, maximum) { const result = Number(value); if (!Number.isInteger(result) || result < minimum || result > maximum)
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`); return result; }
function money(value) { if (value === undefined)
    return null; const result = Number(value); if (!Number.isFinite(result) || result <= 0 || result > 1_000)
    throw new Error("max_budget_usd must be between 0 and 1000"); return result; }
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function payload(record) { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
/** Binds a verified sandbox declaration and bounded Host resources to a launch; it does not claim to be an OS sandbox. */
export class ExecutionSafetyKernel {
    store;
    sandbox;
    constructor(store, sandbox) { this.store = store; this.sandbox = sandbox; }
    preflight(args) {
        const task = this.store.get("task", text(args.task_id, "task_id"));
        const host = text(args.host, "host");
        if (!new Set(["codex-cli", "claude-code"]).has(host))
            throw new Error("Safety preflight host is unsupported");
        const sandbox = text(args.sandbox, "sandbox");
        if (!new Set(["read-only", "workspace-write"]).has(sandbox))
            throw new Error("Safety preflight sandbox is unsupported");
        const profileId = text(args.profile_id, "profile_id");
        const profileVersion = integer(args.profile_version, "profile_version", 1, Number.MAX_SAFE_INTEGER);
        const workspace = resolve(text(args.workspace, "workspace"));
        const resources = { timeout_ms: integer(args.timeout_ms, "timeout_ms", 1_000, 3_600_000), output_limit: integer(args.output_limit, "output_limit", 4_096, 16_777_216), max_turns: host === "claude-code" ? integer(args.max_turns, "max_turns", 1, 100) : null, max_budget_usd: host === "claude-code" ? money(args.max_budget_usd) : null };
        const requirements = sandbox === "workspace-write" ? { filesystem: "workspace_overlay", network: "denied", features: ["cancel", "process_isolation", "snapshot"], limits: {} } : { filesystem: "read_only", network: "denied", features: ["cancel", "process_isolation"], limits: {} };
        const planned = this.sandbox.plan({ task_id: task.id, profile_id: profileId, profile_version: profileVersion, requirements, request_digest: `safety:${task.id}`, dry_run: true });
        if (planned.compatible !== true)
            throw new Error(`Safety preflight requirements are not satisfied: ${planned.missing.join(", ")}`);
        const profile = planned.profile;
        const identity = { task_id: task.id, host, workspace, sandbox, profile_id: profile.id, profile_version: profile.version, profile_digest: profile.capability_digest, requirements, resources };
        const preflightId = String(args.preflight_id ?? `execution_safety_preflight_${randomUUID().replaceAll("-", "")}`);
        const existing = this.store.find("execution_safety_preflight", preflightId);
        if (existing) {
            if (existing.identity_digest !== digest(identity))
                throw new Error("Safety preflight idempotency conflict");
            return { preflight: existing, profile, idempotent: true };
        }
        const preflight = this.store.create("execution_safety_preflight", preflightId, { ...identity, identity_digest: digest(identity), enforcement_boundary: "verified_profile_and_host_limits", os_sandbox_guaranteed: false, status: "passed" });
        return { preflight, profile, idempotent: false };
    }
    validate(args) {
        const preflight = this.store.get("execution_safety_preflight", text(args.preflight_id, "preflight_id"), args.version === undefined ? undefined : integer(args.version, "version", 1, Number.MAX_SAFE_INTEGER));
        if (preflight.status !== "passed")
            throw new Error("Safety preflight is not passed");
        const profile = this.store.get("sandbox_profile", String(preflight.profile_id), Number(preflight.profile_version));
        if (profile.lifecycle !== "verified" || profile.capability_digest !== preflight.profile_digest)
            throw new Error("Safety preflight profile changed or is no longer verified");
        return { preflight, profile, valid: true };
    }
    get(args) { const result = this.validate(args); const preflight = result.preflight; return { ...result, contract: preflight.resources }; }
    bind(args) { const result = this.validate(args); const preflight = result.preflight; const launch = this.store.get("work_launch", text(args.launch_id, "launch_id")); if (launch.task_id !== preflight.task_id || launch.host !== preflight.host || launch.workspace !== preflight.workspace || launch.sandbox !== preflight.sandbox)
        throw new Error("Safety preflight does not match Work Launch"); const existing = launch.safety_preflight; const binding = { preflight_id: preflight.id, preflight_version: preflight.version, identity_digest: preflight.identity_digest }; if (existing && digest(existing) !== digest(binding))
        throw new Error("Work Launch is already bound to another safety preflight"); if (existing)
        return { launch, preflight, idempotent: true }; return { launch: this.store.save("work_launch", String(launch.id), { ...payload(launch), safety_preflight: binding }), preflight, idempotent: false }; }
}
//# sourceMappingURL=execution-safety.js.map