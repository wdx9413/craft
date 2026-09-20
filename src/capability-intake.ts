import { randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { payload, stableDigest } from "./digest.ts";
import { text } from "./validation.ts";

export const CAPABILITY_INTAKE_STATES = ["discovered", "scanned", "conformance_passed", "approved", "active", "degraded", "revoked", "retired"] as const;
export type CapabilityIntakeState = typeof CAPABILITY_INTAKE_STATES[number];
const EFFECTS = new Set(["read_only", "local_write", "external_write", "destructive"]);
const SECRET = /(?:api[_-]?key|authorization|bearer|cookie|password|passwd|secret|token)\s*[:=]/iu;
function id(value: unknown): string { return value === undefined ? `capability_intake_${randomUUID().replaceAll("-", "")}` : text(value, "capability_id"); }
function state(value: unknown): CapabilityIntakeState { const result = text(value, "state") as CapabilityIntakeState; if (!CAPABILITY_INTAKE_STATES.includes(result)) throw new Error("Unsupported capability intake state"); return result; }

/** Capability metadata supply-chain gate. Discovery never implies execution. */
export class CapabilityIntakeKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  discover(args: JsonObject): JsonObject {
    const capabilityId = id(args.capability_id); const manifest = { name: text(args.name, "name"), source: text(args.source, "source"), publisher: text(args.publisher ?? "unknown", "publisher"), version: text(args.version ?? "0.0.0", "version"), content_digest: text(args.content_digest, "content_digest"), effect: text(args.effect ?? "read_only", "effect"), dependencies: Array.isArray(args.dependencies) ? args.dependencies.map((item) => text(item, "dependencies")) : [], permissions: Array.isArray(args.permissions) ? args.permissions.map((item) => text(item, "permissions")) : [], hosts: Array.isArray(args.hosts) ? args.hosts.map((item) => text(item, "hosts")) : [] };
    if (!EFFECTS.has(manifest.effect)) throw new Error("Unsupported capability effect");
    const digest = stableDigest(manifest); const existing = this.store.find("capability_intake", capabilityId);
    if (existing) { if (existing.manifest_digest !== digest) throw new Error("Capability manifest identity conflict"); return { capability: existing, idempotent: true }; }
    return { capability: this.store.create("capability_intake", capabilityId, { ...manifest, manifest_digest: digest, state: "discovered", scan: null, conformance: null, revocation: null }), idempotent: false };
  }

  scan(args: JsonObject): JsonObject {
    const capability = this.get(args); const evidence = JSON.stringify(args.evidence ?? {});
    const findings = SECRET.test(evidence) || SECRET.test(String(capability.source)) ? ["secret_like_content"] : [];
    const scan = { scanner: text(args.scanner ?? "craft-supply-chain", "scanner"), findings, verdict: findings.length ? "rejected" : "passed", evidence_digest: stableDigest(args.evidence ?? {}) };
    return { capability: this.store.save("capability_intake", String(capability.id), { ...payload(capability), state: "scanned", scan }), scan, executable: false };
  }

  conformance(args: JsonObject): JsonObject {
    const capability = this.get(args); if (state(capability.state) !== "scanned") throw new Error("Capability must be scanned before conformance");
    const checks = Array.isArray(args.checks) ? args.checks.map((item) => Boolean(item)) : [];
    if (!checks.length) throw new Error("checks must contain at least one result");
    const passed = checks.every(Boolean) && (capability.scan as JsonObject | null)?.verdict === "passed";
    const conformance = { checks, verdict: passed ? "passed" : "rejected", report_digest: stableDigest({ checks, scan: capability.scan }) };
    return { capability: this.store.save("capability_intake", String(capability.id), { ...payload(capability), state: "conformance_passed", conformance }), conformance, executable: false };
  }

  approve(args: JsonObject): JsonObject {
    const capability = this.get(args); if (state(capability.state) !== "conformance_passed" || (capability.conformance as JsonObject | null)?.verdict !== "passed") throw new Error("Capability requires passed conformance before approval");
    const approvedBy = text(args.approved_by, "approved_by");
    return { capability: this.store.save("capability_intake", String(capability.id), { ...payload(capability), state: "approved", approved_by: approvedBy, approval_digest: stableDigest({ approvedBy, conformance: capability.conformance }) }), idempotent: false };
  }

  activate(args: JsonObject): JsonObject {
    const capability = this.get(args); if (!(["approved", "degraded", "active"] as string[]).includes(String(capability.state))) throw new Error("Capability must be approved before activation");
    if (capability.state === "active") return { capability, idempotent: true };
    return { capability: this.store.save("capability_intake", String(capability.id), { ...payload(capability), state: "active", activated_at: new Date().toISOString() }), idempotent: false };
  }

  revoke(args: JsonObject): JsonObject {
    const capability = this.get(args); if (capability.state === "revoked") return { capability, idempotent: true };
    const reason = text(args.reason, "reason"); return { capability: this.store.save("capability_intake", String(capability.id), { ...payload(capability), state: "revoked", revocation: { reason_digest: stableDigest(reason), raw_reason_stored: false } }), idempotent: false };
  }

  upgradePlan(args: JsonObject): JsonObject {
    const capability = this.get(args); const nextVersion = text(args.next_version, "next_version"); const nextDigest = text(args.next_digest, "next_digest");
    return { plan: this.store.create("capability_upgrade_plan", String(args.plan_id ?? `capability_upgrade_${capability.id}_${nextVersion}`), { capability_id: capability.id, from_version: capability.version, to_version: nextVersion, from_digest: capability.content_digest, to_digest: nextDigest, stages: ["preflight", "shadow", "held_out", "signoff", "canary", "monitor", "rollback"], status: "planned" }) };
  }

  get(args: JsonObject): JsonObject { return this.store.get("capability_intake", text(args.capability_id, "capability_id")); }
  list(args: JsonObject = {}): JsonObject { const wanted = args.state === undefined ? undefined : state(args.state); return { capabilities: this.store.list("capability_intake", Number(args.limit ?? 100), (item) => wanted === undefined || item.state === wanted) }; }
}
