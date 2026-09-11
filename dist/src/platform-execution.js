import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { CraftStore } from "./store.js";
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
/** Platform matrix: portable reads, verified boundary required for every write. */
export class PlatformExecutionKernel {
    store;
    constructor(store) { this.store = store; }
    profileSave(args) {
        const profileId = text(args.profile_id, "profile_id");
        const platform = text(args.platform, "platform");
        const isolation = text(args.isolation, "isolation");
        const network = text(args.network, "network");
        if (!new Set(["none", "verified"]).has(isolation) || !new Set(["deny", "allow"]).has(network))
            throw new Error("Execution profile boundary is unsupported");
        const conformance = args.conformance_id === undefined ? null : this.store.get("platform_execution_conformance", text(args.conformance_id, "conformance_id"), args.conformance_version === undefined ? undefined : Number(args.conformance_version));
        if (conformance && (conformance.status !== "verified" || conformance.platform !== platform))
            throw new Error("Execution profile conformance is not verified for this platform");
        const item = { platform, isolation, network, verified_by: isolation === "verified" ? text(args.verified_by, "verified_by") : null, conformance: conformance ? { id: conformance.id, version: conformance.version } : null, active: args.active !== false };
        const existing = this.store.find("platform_execution_profile", profileId);
        const definitionDigest = digest(item);
        if (existing) {
            if (existing.definition_digest !== definitionDigest)
                throw new Error("Execution profile idempotency conflict");
            return { profile: existing, idempotent: true };
        }
        return { profile: this.store.create("platform_execution_profile", profileId, { ...item, definition_digest: definitionDigest }), idempotent: false };
    }
    conformanceRecord(args) {
        const platform = text(args.platform, "platform");
        const verifier = text(args.verifier, "verifier");
        const checks = args.checks;
        if (!checks || typeof checks !== "object" || Array.isArray(checks))
            throw new Error("checks must be an object");
        const required = ["network_denied", "workspace_contained", "credentials_absent", "cancel_cleanup", "resource_limits"];
        if (required.some((key) => checks[key] !== true))
            throw new Error("Platform conformance requires every execution boundary check");
        const identity = { platform, verifier, checks: required.map((key) => key) };
        const conformanceId = String(args.conformance_id ?? `platform_execution_conformance_${platform}`);
        const existing = this.store.find("platform_execution_conformance", conformanceId);
        const conformanceDigest = digest(identity);
        if (existing) {
            if (existing.conformance_digest !== conformanceDigest)
                throw new Error("Platform conformance idempotency conflict");
            return { conformance: existing, idempotent: true };
        }
        return { conformance: this.store.create("platform_execution_conformance", conformanceId, { ...identity, conformance_digest: conformanceDigest, status: "verified" }), idempotent: false };
    }
    preflight(args) {
        const effect = text(args.effect, "effect");
        const platform = text(args.platform, "platform");
        const requiresBoundary = effect !== "read_only";
        if (!requiresBoundary)
            return { allowed: true, mode: "portable_read", profile: null, receipt: { platform, effect, boundary_required: false } };
        const profile = args.profile_id === undefined ? null : this.store.get("platform_execution_profile", text(args.profile_id, "profile_id"));
        if (!profile || profile.active !== true || profile.platform !== platform || profile.isolation !== "verified" || profile.network !== "deny")
            throw new Error("Write effect requires an active verified network-denied platform boundary");
        if (profile.conformance)
            this.conformanceValidate(profile.conformance, platform);
        const identity = { profile_id: profile.id, profile_version: profile.version, platform, effect };
        const preflightId = String(args.preflight_id ?? `platform_preflight_${profile.id}_${effect}`);
        const existing = this.store.find("platform_execution_preflight", preflightId);
        const preflightDigest = digest(identity);
        if (existing) {
            if (existing.preflight_digest !== preflightDigest)
                throw new Error("Platform preflight idempotency conflict");
            return { preflight: existing, idempotent: true };
        }
        return { preflight: this.store.create("platform_execution_preflight", preflightId, { ...identity, preflight_digest: preflightDigest, allowed: true }), idempotent: false };
    }
    validate(args) {
        const preflight = this.store.get("platform_execution_preflight", text(args.preflight_id, "preflight_id"), args.version === undefined ? undefined : Number(args.version));
        const profile = this.store.get("platform_execution_profile", String(preflight.profile_id), Number(preflight.profile_version));
        const observedBoundary = JSON.stringify([preflight.allowed, profile.active, profile.isolation, profile.network, profile.platform]);
        const requiredBoundary = JSON.stringify([true, true, "verified", "deny", preflight.platform]);
        if (observedBoundary !== requiredBoundary)
            throw new Error("Platform preflight is no longer valid");
        if (profile.conformance)
            this.conformanceValidate(profile.conformance, String(preflight.platform));
        return { preflight, profile, valid: true };
    }
    probe(args) {
        const platform = args.platform === undefined ? process.platform : text(args.platform, "platform");
        if (platform !== process.platform)
            throw new Error("Platform probe must target the current local platform");
        const observed = { platform, node_version: process.version, sandbox_exec_available: existsSync("/usr/bin/sandbox-exec"), verified: false, note: "Probe is health telemetry only and never verifies an execution boundary." };
        const probeId = String(args.probe_id ?? `platform_execution_probe_${platform}`);
        const existing = this.store.find("platform_execution_probe", probeId);
        const probeDigest = digest(observed);
        if (existing) {
            if (existing.probe_digest !== probeDigest)
                throw new Error("Platform probe idempotency conflict");
            return { probe: existing, idempotent: true };
        }
        return { probe: this.store.create("platform_execution_probe", probeId, { ...observed, probe_digest: probeDigest }), idempotent: false };
    }
    probeGet(args) { return { probe: this.store.get("platform_execution_probe", text(args.probe_id, "probe_id")) }; }
    conformanceValidate(reference, platform) { const record = this.store.get("platform_execution_conformance", text(reference.id, "conformance.id"), Number(reference.version)); if (record.status !== "verified" || record.platform !== platform)
        throw new Error("Platform conformance is no longer valid"); }
}
//# sourceMappingURL=platform-execution.js.map