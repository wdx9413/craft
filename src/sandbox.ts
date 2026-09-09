import { createHash, randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

const BACKENDS = new Set(["local_process", "container", "remote"]);
const FILESYSTEM = new Set(["none", "read_only", "workspace_overlay"]);
const NETWORK = new Set(["denied", "allowlist", "unrestricted"]);
const FEATURES = new Set(["process_isolation", "credential_broker", "snapshot", "cancel"]);

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}
function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}
function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const result = value.map((item) => text(item, name));
  if (new Set(result).size !== result.length) throw new Error(`${name} must contain unique values`);
  return result;
}
function positiveLimits(value: unknown, name: string): JsonObject {
  const limits = object(value, name);
  for (const [key, amount] of Object.entries(limits)) {
    if (!/^[a-z][a-z0-9_]*$/u.test(key) || typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
      throw new Error(`${name} must contain positive finite numeric limits with stable names`);
    }
  }
  return limits;
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function payload(record: JsonObject): JsonObject {
  const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest;
}

function normalizeCapabilities(value: unknown): JsonObject {
  const input = object(value, "capabilities"); const filesystem = text(input.filesystem, "capabilities.filesystem");
  const network = text(input.network, "capabilities.network");
  if (!FILESYSTEM.has(filesystem) || !NETWORK.has(network)) throw new Error("Sandbox filesystem or network mode is unsupported");
  const features = strings(input.features ?? [], "capabilities.features").sort();
  if (features.some((feature) => !FEATURES.has(feature))) throw new Error("Sandbox capability feature is unsupported");
  const networkAllowlist = strings(input.network_allowlist ?? [], "capabilities.network_allowlist").sort();
  if ((network === "allowlist") !== (networkAllowlist.length > 0)) throw new Error("Network allowlist is required only for allowlist mode");
  return { filesystem, network, network_allowlist: networkAllowlist, features,
    limits: positiveLimits(input.limits ?? {}, "capabilities.limits") };
}

export class SandboxKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  profileSave(args: JsonObject): JsonObject {
    const profileId = args.profile_id === undefined ? `sandbox_${randomUUID().replaceAll("-", "")}` : text(args.profile_id, "profile_id");
    const backend = text(args.backend, "backend"); if (!BACKENDS.has(backend)) throw new Error("Sandbox backend is unsupported");
    const capabilities = normalizeCapabilities(args.capabilities);
    return this.store.save("sandbox_profile", profileId, { name: text(args.name, "name"), backend,
      adapter_id: text(args.adapter_id, "adapter_id"), capabilities, capability_digest: digest(capabilities),
      lifecycle: "declared", evidence_ids: [] });
  }

  profileVerify(args: JsonObject): JsonObject {
    const version = Number(args.profile_version);
    if (!Number.isInteger(version) || version < 1) throw new Error("profile_version must be a positive integer");
    const profile = this.store.get("sandbox_profile", text(args.profile_id, "profile_id"), version);
    if (profile.lifecycle !== "declared") throw new Error("Only a declared Sandbox Profile can be verified");
    const observed = normalizeCapabilities(args.observed_capabilities);
    const evidenceIds = strings(args.evidence_ids, "evidence_ids");
    if (!evidenceIds.length) throw new Error("Sandbox verification requires evidence_ids");
    for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    const matches = digest(observed) === profile.capability_digest;
    const assessment = this.store.create("sandbox_assessment", String(args.assessment_id ?? `sandbox_assessment_${randomUUID().replaceAll("-", "")}`), {
      profile_id: profile.id, profile_version: profile.version, verifier: text(args.verifier, "verifier"),
      observed_capabilities: observed, evidence_ids: evidenceIds, status: matches ? "passed" : "failed" });
    if (!matches) return { profile, assessment, verified: false };
    const verified = this.store.updateIfVersion("sandbox_profile", String(profile.id), Number(profile.version), {
      ...payload(profile), lifecycle: "verified", evidence_ids: evidenceIds, assessment_id: assessment.id });
    return { profile: verified, assessment, verified: true };
  }

  plan(args: JsonObject): JsonObject {
    this.store.get("task", text(args.task_id, "task_id"));
    if (args.profile_version !== undefined && (!Number.isInteger(Number(args.profile_version)) || Number(args.profile_version) < 1)) {
      throw new Error("profile_version must be a positive integer");
    }
    const profile = this.store.get("sandbox_profile", text(args.profile_id, "profile_id"),
      args.profile_version === undefined ? undefined : Number(args.profile_version));
    if (profile.lifecycle !== "verified") throw new Error("Sandbox execution requires a verified profile version");
    const requirements = object(args.requirements, "requirements"); const capabilities = profile.capabilities as JsonObject;
    const requiredFilesystem = text(requirements.filesystem, "requirements.filesystem");
    const requiredNetwork = text(requirements.network, "requirements.network");
    if (!FILESYSTEM.has(requiredFilesystem) || !NETWORK.has(requiredNetwork)) throw new Error("Sandbox requirement mode is unsupported");
    const requiredFeatures = strings(requirements.features ?? [], "requirements.features");
    if (requiredFeatures.some((feature) => !FEATURES.has(feature))) throw new Error("Sandbox requirement feature is unsupported");
    const requiredLimits = positiveLimits(requirements.limits ?? {}, "requirements.limits");
    const missing = [
      ...(capabilities.filesystem === requiredFilesystem ? [] : [`filesystem:${requiredFilesystem}`]),
      ...(capabilities.network === requiredNetwork ? [] : [`network:${requiredNetwork}`]),
      ...requiredFeatures.filter((feature) => !(capabilities.features as string[]).includes(feature)).map((feature) => `feature:${feature}`),
      ...Object.entries(requiredLimits).filter(([name, amount]) => Number((capabilities.limits as JsonObject)[name] ?? 0) < Number(amount)).map(([name]) => `limit:${name}`),
    ];
    if (missing.length) return { compatible: false, profile, missing, ticket: null };
    if (args.dry_run === true) return { compatible: true, profile, missing: [], ticket: null, dry_run: true };
    const requestDigest = text(args.request_digest, "request_digest");
    const ticket = this.store.create("sandbox_ticket", String(args.ticket_id ?? `sandbox_ticket_${randomUUID().replaceAll("-", "")}`), {
      task_id: text(args.task_id, "task_id"), profile_id: profile.id, profile_version: profile.version,
      profile_digest: profile.capability_digest, requirements, request_digest: requestDigest, status: "issued" });
    return { compatible: true, profile, missing: [], ticket };
  }

  receipt(args: JsonObject): JsonObject {
    const ticket = this.store.get("sandbox_ticket", text(args.ticket_id, "ticket_id"));
    const receiptId = text(args.receipt_id, "receipt_id"); const existing = this.store.find("sandbox_receipt", receiptId);
    const fingerprint = digest({ ticket_id: ticket.id, adapter_id: args.adapter_id, profile_version: args.profile_version,
      status: args.status, observed_capabilities: args.observed_capabilities, evidence_ids: args.evidence_ids });
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) throw new Error("Sandbox receipt idempotency conflict");
      return { receipt: existing, idempotent: true };
    }
    if (ticket.status !== "issued") throw new Error("Sandbox ticket is not active");
    const profile = this.store.get("sandbox_profile", String(ticket.profile_id), Number(ticket.profile_version));
    if (text(args.adapter_id, "adapter_id") !== profile.adapter_id || Number(args.profile_version) !== Number(profile.version)) {
      throw new Error("Sandbox receipt adapter or profile version does not match the ticket");
    }
    const status = text(args.status, "status"); if (!new Set(["passed", "failed", "cancelled", "timed_out"]).has(status)) throw new Error("Sandbox receipt status is unsupported");
    const observed = normalizeCapabilities(args.observed_capabilities); const boundaryMatches = digest(observed) === ticket.profile_digest;
    if (status === "passed" && !boundaryMatches) throw new Error("A passed Sandbox receipt must prove the exact profile boundaries");
    const evidenceIds = strings(args.evidence_ids, "evidence_ids");
    if (!evidenceIds.length) throw new Error("Sandbox receipt requires evidence_ids");
    for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    const receipt = this.store.create("sandbox_receipt", receiptId, { ticket_id: ticket.id, task_id: ticket.task_id,
      adapter_id: profile.adapter_id, profile_id: profile.id, profile_version: profile.version, status,
      boundary_matches: boundaryMatches, observed_capabilities: observed, evidence_ids: evidenceIds,
      request_fingerprint: fingerprint, request_digest: ticket.request_digest });
    this.store.updateIfVersion("sandbox_ticket", String(ticket.id), Number(ticket.version), { ...payload(ticket), status: "completed", receipt_id: receipt.id });
    return { receipt, idempotent: false };
  }
}
