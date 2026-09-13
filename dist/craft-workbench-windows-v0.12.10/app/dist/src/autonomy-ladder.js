import { createHash } from "node:crypto";
import { CraftStore } from "./store.js";
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
/**
 * Separates a verified isolation boundary from a human-approved local write.
 * The latter is deliberately useful but never labelled as sandboxed or eligible
 * for unattended execution.
 */
export class AutonomyLadderKernel {
    store;
    constructor(store) { this.store = store; }
    decide(args) {
        const effect = text(args.effect, "effect");
        const unattended = args.unattended === true;
        if (!new Set(["read_only", "local_write", "external_write", "destructive"]).has(effect))
            throw new Error("Autonomy effect is unsupported");
        const workspaceId = args.workspace_id === undefined ? null : text(args.workspace_id, "workspace_id");
        if (effect === "read_only")
            return this.record(args, { effect, workspace_id: workspaceId, mode: "portable_read", approval_required: false, boundary_required: false, allowed: true, reason: "read_only_scoped" });
        if (effect === "local_write" && !unattended) {
            if (!workspaceId || args.approved !== true)
                throw new Error("Guarded local write requires an explicit Workspace and approval");
            return this.record(args, { effect, workspace_id: workspaceId, mode: "guarded_local_write", approval_required: true, boundary_required: false, allowed: true, reason: "human_approved_not_isolated" });
        }
        if (effect === "local_write")
            return this.isolated(args, effect, workspaceId, "unattended_local_write_requires_verified_boundary");
        if (effect === "external_write") {
            if (args.authorization_ref === undefined || args.reobserve_required !== true)
                throw new Error("External write requires authorization_ref and reobserve_required=true");
            return this.isolated(args, effect, workspaceId, "external_gateway_requires_verified_boundary");
        }
        if (args.authorization_ref === undefined || args.compensation_or_handoff !== true)
            throw new Error("Destructive effect requires authorization_ref and compensation_or_handoff=true");
        return this.isolated(args, effect, workspaceId, "destructive_effect_requires_verified_boundary");
    }
    get(args) { return { decision: this.store.get("autonomy_ladder_decision", text(args.decision_id, "decision_id")) }; }
    isolated(args, effect, workspaceId, reason) {
        const profileId = text(args.platform_profile_id, "platform_profile_id");
        const profile = this.store.get("platform_execution_profile", profileId);
        if (profile.active !== true || profile.isolation !== "verified" || profile.network !== "deny")
            throw new Error("Unattended or external execution requires an active verified network-denied platform boundary");
        return this.record(args, { effect, workspace_id: workspaceId, mode: effect === "local_write" ? "isolated_local_write" : "external_gateway", approval_required: effect !== "local_write", boundary_required: true, platform_profile: { id: profile.id, version: profile.version }, allowed: true, reason });
    }
    record(args, value) {
        const identity = { ...value, task_id: args.task_id === undefined ? null : text(args.task_id, "task_id"), action_digest: args.action_digest === undefined ? null : text(args.action_digest, "action_digest") };
        const decisionId = String(args.decision_id ?? `autonomy_ladder_${digest(identity).slice(-16)}`);
        const existing = this.store.find("autonomy_ladder_decision", decisionId);
        const decisionDigest = digest(identity);
        if (existing) {
            if (existing.decision_digest !== decisionDigest)
                throw new Error("Autonomy Ladder decision idempotency conflict");
            return { decision: existing, idempotent: true };
        }
        return { decision: this.store.create("autonomy_ladder_decision", decisionId, { ...identity, decision_digest: decisionDigest }), idempotent: false };
    }
}
//# sourceMappingURL=autonomy-ladder.js.map