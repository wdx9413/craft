import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }

/** Platform matrix: portable reads, verified boundary required for every write. */
export class PlatformExecutionKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }
  profileSave(args: JsonObject): JsonObject {
    const profileId = text(args.profile_id, "profile_id"); const platform = text(args.platform, "platform"); const isolation = text(args.isolation, "isolation"); const network = text(args.network, "network");
    if (!new Set(["none", "verified"]).has(isolation) || !new Set(["deny", "allow"]).has(network)) throw new Error("Execution profile boundary is unsupported");
    const item = { platform, isolation, network, verified_by: isolation === "verified" ? text(args.verified_by, "verified_by") : null, active: args.active !== false }; const existing = this.store.find("platform_execution_profile", profileId); const definitionDigest = digest(item);
    if (existing) { if (existing.definition_digest !== definitionDigest) throw new Error("Execution profile idempotency conflict"); return { profile: existing, idempotent: true }; }
    return { profile: this.store.create("platform_execution_profile", profileId, { ...item, definition_digest: definitionDigest }), idempotent: false };
  }
  preflight(args: JsonObject): JsonObject {
    const effect = text(args.effect, "effect"); const platform = text(args.platform, "platform"); const requiresBoundary = effect !== "read_only";
    if (!requiresBoundary) return { allowed: true, mode: "portable_read", profile: null, receipt: { platform, effect, boundary_required: false } };
    const profile = args.profile_id === undefined ? null : this.store.get("platform_execution_profile", text(args.profile_id, "profile_id"));
    if (!profile || profile.active !== true || profile.platform !== platform || profile.isolation !== "verified" || profile.network !== "deny") throw new Error("Write effect requires an active verified network-denied platform boundary");
    const identity = { profile_id: profile.id, profile_version: profile.version, platform, effect }; const preflightId = String(args.preflight_id ?? `platform_preflight_${profile.id}_${effect}`); const existing = this.store.find("platform_execution_preflight", preflightId); const preflightDigest = digest(identity);
    if (existing) { if (existing.preflight_digest !== preflightDigest) throw new Error("Platform preflight idempotency conflict"); return { preflight: existing, idempotent: true }; }
    return { preflight: this.store.create("platform_execution_preflight", preflightId, { ...identity, preflight_digest: preflightDigest, allowed: true }), idempotent: false };
  }
}
