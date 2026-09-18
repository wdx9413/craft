import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

const REQUIRED_CHECKS = ["workspace_boundary", "network_boundary", "credential_boundary", "process_cleanup", "resource_limits", "cancel_observed"] as const;
function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }

/** Unified, content-free proof projection over local execution adapters. */
export class RuntimeProofKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  manifest(args: JsonObject): JsonObject {
    const runtimeId = text(args.runtime_id, "runtime_id");
    const definition = { runtime_id: runtimeId, platform: text(args.platform, "platform"), adapter_id: text(args.adapter_id, "adapter_id"), workspace_digest: text(args.workspace_digest, "workspace_digest"), network: text(args.network ?? "deny", "network"), credential_mode: text(args.credential_mode ?? "broker_required", "credential_mode"), process_mode: text(args.process_mode ?? "bounded", "process_mode"), resources_digest: digest(args.resources ?? {}) };
    const manifestId = String(args.manifest_id ?? `runtime_manifest_${runtimeId}`);
    const existing = this.store.find("runtime_manifest", manifestId);
    if (existing) { if (existing.definition_digest !== digest(definition)) throw new Error("Runtime manifest idempotency conflict"); return { manifest: existing, idempotent: true }; }
    return { manifest: this.store.create("runtime_manifest", manifestId, { ...definition, definition_digest: digest(definition), status: "declared" }), idempotent: false };
  }

  probe(args: JsonObject): JsonObject {
    const manifest = this.store.get("runtime_manifest", text(args.manifest_id, "manifest_id"));
    const checks = args.checks as JsonObject | undefined;
    const observed = { manifest_id: manifest.id, environment_digest: text(args.environment_digest, "environment_digest"), checks: checks ?? {} };
    const probeId = String(args.probe_id ?? `runtime_probe_${manifest.id}`);
    const existing = this.store.find("runtime_probe", probeId);
    if (existing) { if (existing.observation_digest !== digest(observed)) throw new Error("Runtime probe idempotency conflict"); return { probe: existing, idempotent: true }; }
    return { probe: this.store.create("runtime_probe", probeId, { ...observed, observed_at: new Date().toISOString(), observation_digest: digest(observed) }), idempotent: false };
  }

  conformance(args: JsonObject): JsonObject {
    const manifest = this.store.get("runtime_manifest", text(args.manifest_id, "manifest_id"));
    const checks = (args.checks ?? {}) as JsonObject;
    const failed = REQUIRED_CHECKS.filter((key) => checks[key] !== true);
    const platform = String(manifest.platform);
    const status = failed.length || (platform === "win32" && manifest.adapter_id === "none") ? "blocked" : "verified";
    const record = { manifest_id: manifest.id, platform, checks: Object.fromEntries(REQUIRED_CHECKS.map((key) => [key, checks[key] === true])), failed, status, verifier: text(args.verifier, "verifier"), conformance_digest: digest({ manifest_id: manifest.id, checks, verifier: args.verifier }) };
    const id = String(args.conformance_id ?? `runtime_conformance_${manifest.id}`);
    const existing = this.store.find("runtime_conformance", id);
    if (existing) { if (existing.conformance_digest !== record.conformance_digest) throw new Error("Runtime conformance idempotency conflict"); return { conformance: existing, idempotent: true }; }
    return { conformance: this.store.create("runtime_conformance", id, record), idempotent: false };
  }

  attest(args: JsonObject): JsonObject {
    const conformance = this.store.get("runtime_conformance", text(args.conformance_id, "conformance_id"));
    if (conformance.status !== "verified") throw new Error("Runtime conformance is not verified");
    const runId = text(args.run_id, "run_id");
    const identity = { run_id: runId, conformance_id: conformance.id, environment_digest: text(args.environment_digest, "environment_digest"), profile_version: text(args.profile_version, "profile_version"), expires_at: text(args.expires_at, "expires_at") };
    const id = String(args.attestation_id ?? `runtime_attestation_${runId}`);
    const existing = this.store.find("runtime_attestation", id);
    if (existing) { if (existing.attestation_digest !== digest(identity)) throw new Error("Runtime attestation idempotency conflict"); return { attestation: existing, idempotent: true }; }
    return { attestation: this.store.create("runtime_attestation", id, { ...identity, attestation_digest: digest(identity), evidence_ids: Array.isArray(args.evidence_ids) ? args.evidence_ids : [] }), idempotent: false };
  }

  rehydrate(args: JsonObject): JsonObject {
    const checkpoint = text(args.checkpoint_id, "checkpoint_id");
    const expected = text(args.expected_environment_digest, "expected_environment_digest");
    const current = text(args.current_environment_digest, "current_environment_digest");
    const status = expected === current ? "ready" : "needs_replan";
    return { checkpoint_id: checkpoint, status, rehydrate_digest: digest({ checkpoint, expected, current }) };
  }
}
