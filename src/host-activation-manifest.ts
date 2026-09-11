import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

const HOSTS = new Set(["codex-cli", "claude-code"]);
const EFFECTS = new Set(["read_only", "local_write", "external_write"]);

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}
function values(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${name} must be a non-empty array`);
  const result = value.map((item) => text(item, name));
  if (new Set(result).size !== result.length) throw new Error(`${name} must contain unique values`);
  return result;
}
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function isExpired(value: unknown): boolean { return Number.isNaN(Date.parse(String(value))) || Date.parse(String(value)) < Date.now(); }

/**
 * A content-free, Host-facing view of an Activation Profile. It proves the
 * exact assets and connector tickets a Host may receive; it neither edits a
 * Host configuration nor starts a connector or a model.
 */
export class HostActivationManifestKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  prepare(args: JsonObject): JsonObject {
    const task = this.store.get("task", text(args.task_id, "task_id"));
    const profile = this.store.get("activation_profile", text(args.profile_id, "profile_id"));
    if (args.profile_version !== undefined && Number(args.profile_version) !== Number(profile.version)) throw new Error("Activation Profile version does not match current state");
    if (profile.task_id !== task.id) throw new Error("Activation Profile does not match task");
    const host = text(args.host, "host"); if (!HOSTS.has(host)) throw new Error("Host Activation Manifest host is unsupported");
    const requested = args.asset_ids === undefined ? [...profile.asset_ids as string[]] : values(args.asset_ids, "asset_ids");
    if (requested.some((assetId) => !(profile.asset_ids as string[]).includes(assetId))) throw new Error("Host Activation Manifest asset is not in the Activation Profile");
    const tickets = args.connector_ticket_ids === undefined ? [] : values(args.connector_ticket_ids, "connector_ticket_ids");
    const ticketByAsset = new Map<string, JsonObject>();
    for (const ticketId of tickets) {
      const ticket = this.store.get("capability_connector_ticket", ticketId);
      if (ticket.profile_id !== profile.id || Number(ticket.profile_version) !== Number(profile.version) || ticket.status !== "issued" || isExpired(ticket.expires_at)) {
        throw new Error("Connector ticket is not active for this Activation Profile");
      }
      if (ticketByAsset.has(String(ticket.asset_id))) throw new Error("Connector tickets must cover each asset at most once");
      ticketByAsset.set(String(ticket.asset_id), ticket);
    }
    const assets = requested.map((assetId) => this.asset(profile, assetId, ticketByAsset));
    const identity = { task_id: task.id, profile_id: profile.id, profile_version: profile.version, host, assets };
    const manifestId = String(args.manifest_id ?? `host_activation_${digest(identity).slice(-20)}`);
    const existing = this.store.find("host_activation_manifest", manifestId); const identityDigest = digest(identity);
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Host Activation Manifest idempotency conflict");
      return { manifest: existing, idempotent: true };
    }
    return { manifest: this.store.create("host_activation_manifest", manifestId, { ...identity, identity_digest: identityDigest, status: "issued" }), idempotent: false };
  }

  validate(args: JsonObject): JsonObject {
    const manifest = this.store.get("host_activation_manifest", text(args.manifest_id, "manifest_id"));
    if (manifest.status !== "issued") throw new Error("Host Activation Manifest is not issued");
    const profile = this.store.get("activation_profile", String(manifest.profile_id));
    if (Number(profile.version) !== Number(manifest.profile_version)) throw new Error("Activation Profile changed after manifest issue");
    const assets = (manifest.assets as JsonObject[]).map((reference) => this.asset(profile, String(reference.asset_id), new Map(
      reference.connector_ticket_id ? [[String(reference.asset_id), this.store.get("capability_connector_ticket", String(reference.connector_ticket_id))]] : [],
    )));
    const expected = { task_id: manifest.task_id, profile_id: profile.id, profile_version: profile.version, host: manifest.host, assets };
    if (digest(expected) !== manifest.identity_digest) throw new Error("Host Activation Manifest facts drifted");
    return { manifest, valid: true };
  }

  consume(args: JsonObject): JsonObject {
    const manifest = this.validate(args).manifest as JsonObject;
    const callId = text(args.call_id, "call_id"); const host = text(args.host, "host");
    if (host !== manifest.host) throw new Error("Host Activation Manifest host does not match");
    const existing = this.store.find("host_activation_receipt", callId);
    const identity = { manifest_id: manifest.id, manifest_version: manifest.version, host };
    if (existing) {
      if (existing.identity_digest !== digest(identity)) throw new Error("Host Activation receipt idempotency conflict");
      return { receipt: existing, idempotent: true };
    }
    return { receipt: this.store.create("host_activation_receipt", callId, { ...identity, identity_digest: digest(identity) }), idempotent: false };
  }

  get(args: JsonObject): JsonObject {
    const manifest = this.store.get("host_activation_manifest", text(args.manifest_id, "manifest_id"));
    return { manifest, receipts: this.store.list("host_activation_receipt", 1000, (item) => item.manifest_id === manifest.id) };
  }

  private asset(profile: JsonObject, assetId: string, tickets: Map<string, JsonObject>): JsonObject {
    const versions = profile.asset_versions as JsonObject;
    const asset = this.store.get("capability_asset", assetId, Number(versions[assetId]));
    if (!EFFECTS.has(String(asset.effect)) || !(profile.allowed_effects as string[]).includes(String(asset.effect)) ||
      !["trusted", "verified"].includes(String(asset.trust)) || asset.health !== "healthy" || asset.requires_credential === true) {
      throw new Error("Capability asset is not eligible for Host activation");
    }
    const ticket = tickets.get(assetId) ?? null;
    if (asset.connector_id !== undefined) {
      if (!ticket || ticket.connector_id !== asset.connector_id || Number(ticket.asset_version) !== Number(asset.version) ||
        ticket.profile_id !== profile.id || Number(ticket.profile_version) !== Number(profile.version) || ticket.status !== "issued" || isExpired(ticket.expires_at)) {
        throw new Error("Connector capability asset requires an exact active ticket");
      }
    } else if (ticket) throw new Error("Non-connector capability asset must not have a Connector ticket");
    return { asset_id: asset.id, asset_version: asset.version, asset_type: asset.asset_type, effect: asset.effect,
      source_digest: asset.source_digest, connector_ticket_id: ticket?.id ?? null, expires_at: ticket?.expires_at ?? null };
  }
}
