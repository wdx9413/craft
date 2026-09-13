import { createHash } from "node:crypto";
import type { JsonObject } from "./store.ts";
import { CraftStore } from "./store.ts";

export type CapabilityLifecycle = "draft" | "installed" | "active" | "disabled" | "retired";

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}
function payload(record: JsonObject): JsonObject {
  const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record;
  return rest;
}
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function state(value: unknown): CapabilityLifecycle {
  const normalized = String(value ?? "draft") as CapabilityLifecycle;
  if (!(new Set<CapabilityLifecycle>(["draft", "installed", "active", "disabled", "retired"])).has(normalized)) throw new Error("Unsupported capability lifecycle");
  return normalized;
}

export class CapabilityLifecycleKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  register(args: JsonObject): JsonObject {
    const capabilityId = text(args.capability_id, "capability_id");
    const name = text(args.name, "name");
    const source = text(args.source, "source");
    const version = text(args.source_version ?? "0.0.0", "source_version");
    const effect = text(args.effect ?? "read_only", "effect");
    const manifest = { capability_id: capabilityId, name, source, source_version: version, effect, dependencies: args.dependencies ?? [], permissions: args.permissions ?? [] };
    const manifestDigest = digest(manifest);
    const existing = this.store.find("capability_lifecycle", capabilityId);
    if (existing) {
      if (existing.manifest_digest !== manifestDigest) throw new Error("Capability identity already exists with different manifest");
      return { capability: existing, idempotent: true };
    }
    return { capability: this.store.create("capability_lifecycle", capabilityId, { ...manifest, lifecycle: "draft", manifest_digest: manifestDigest, installed_at: null, activated_at: null, disabled_reason: null }), idempotent: false };
  }

  install(args: JsonObject): JsonObject {
    const capability = this.store.get("capability_lifecycle", text(args.capability_id, "capability_id"));
    const current = state(capability.lifecycle);
    if (current === "retired") throw new Error("Retired capability cannot be installed");
    if (current === "active" || current === "installed") return { capability, idempotent: true };
    return { capability: this.store.save("capability_lifecycle", String(capability.id), { ...payload(capability), lifecycle: "installed", installed_at: new Date().toISOString() }), idempotent: false };
  }

  activate(args: JsonObject): JsonObject {
    const capability = this.store.get("capability_lifecycle", text(args.capability_id, "capability_id"));
    const current = state(capability.lifecycle);
    if (current === "retired") throw new Error("Retired capability cannot be activated");
    if (current === "disabled") throw new Error("Disabled capability must be installed before activation");
    if (current === "draft") throw new Error("Capability must be installed before activation");
    return { capability: this.store.save("capability_lifecycle", String(capability.id), { ...payload(capability), lifecycle: "active", activated_at: new Date().toISOString(), disabled_reason: null }), idempotent: current === "active" };
  }

  disable(args: JsonObject): JsonObject {
    const capability = this.store.get("capability_lifecycle", text(args.capability_id, "capability_id"));
    if (state(capability.lifecycle) === "retired") return { capability, idempotent: true };
    return { capability: this.store.save("capability_lifecycle", String(capability.id), { ...payload(capability), lifecycle: "disabled", disabled_reason: text(args.reason ?? "disabled", "reason") }), idempotent: capability.lifecycle === "disabled" };
  }

  upgrade(args: JsonObject): JsonObject {
    const capability = this.store.get("capability_lifecycle", text(args.capability_id, "capability_id"));
    if (state(capability.lifecycle) === "retired") throw new Error("Retired capability cannot be upgraded");
    const version = text(args.source_version, "source_version");
    const sourceDigest = text(args.source_digest, "source_digest");
    if (version === capability.source_version && sourceDigest === capability.source_digest) return { capability, idempotent: true };
    const next = { ...payload(capability), source_version: version, source_digest: sourceDigest, lifecycle: "installed", manifest_digest: digest({ ...payload(capability), source_version: version, source_digest: sourceDigest }), previous_version: capability.source_version };
    return { capability: this.store.save("capability_lifecycle", String(capability.id), next), idempotent: false };
  }

  retire(args: JsonObject): JsonObject {
    const capability = this.store.get("capability_lifecycle", text(args.capability_id, "capability_id"));
    if (state(capability.lifecycle) === "retired") return { capability, idempotent: true };
    return { capability: this.store.save("capability_lifecycle", String(capability.id), { ...payload(capability), lifecycle: "retired", retired_reason: text(args.reason ?? "retired", "reason") }), idempotent: false };
  }

  resolve(args: JsonObject): JsonObject {
    const name = text(args.name, "name");
    const candidates = this.store.list("capability_lifecycle", 10_000, (item) => item.name === name && item.lifecycle === "active");
    return { name, candidates, selected: candidates.length === 1 ? candidates[0] : null, ambiguous: candidates.length > 1 };
  }

  list(): JsonObject { return { capabilities: this.store.list("capability_lifecycle", 10_000) }; }
}
