import { createHash, randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

const CONNECTOR_KINDS = new Set(["builtin", "github_skill", "volcengine_skill", "mcp_stdio", "mcp_http", "serena_mcp"]);
const ASSET_TYPES = new Set(["skill", "mcp_server", "tool", "workflow", "adapter", "validator", "grader", "eval_suite"]);
const EFFECTS = new Set(["read_only", "local_write", "external_write", "destructive"]);
const EXTERNAL_CONNECTORS = new Set(["github_skill", "volcengine_skill", "mcp_stdio", "mcp_http", "serena_mcp"]);
const SECRET_PATTERN = /(?:authorization|bearer|cookie|password|secret|token|api[_-]?key)\s*[=:]|https?:\/\/[^/\s@]+:[^/\s@]+@/iu;

function id(prefix: string): string { return `${prefix}_${randomUUID().replaceAll("-", "")}`; }
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}
function optionalText(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return text(value, name);
}
function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}
function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}
function recordPayload(record: JsonObject): JsonObject {
  const { id: _id, version: _version, created_at: _createdAt, updated_at: _updatedAt, ...payload } = record;
  return payload;
}
function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
function assertSafe(value: string, name: string): string {
  if (SECRET_PATTERN.test(value)) throw new Error(`${name} must not contain credentials or secrets`);
  return value;
}
function endpointFor(kind: string, endpoint: unknown, name: string): string {
  const result = assertSafe(optionalText(endpoint, "endpoint") ?? `craft://builtin/${name}`, "endpoint");
  if (kind === "mcp_http") {
    let url: URL;
    try { url = new URL(result); } catch { throw new Error("mcp_http endpoint must be a valid HTTPS URL"); }
    if (url.protocol !== "https:") throw new Error("mcp_http endpoint must use HTTPS");
  }
  return result;
}
function expiry(value: unknown): string {
  const result = value === undefined ? new Date(Date.now() + 300_000).toISOString() : text(value, "expires_at");
  if (!Number.isFinite(Date.parse(result))) throw new Error("expires_at must be an ISO timestamp");
  return result;
}

/**
 * Stores explicit, content-free external capability registrations. Transport
 * discovery and execution remain host responsibilities; this kernel only
 * admits metadata, pins provenance, and issues profile-bound tickets.
 */
export class CapabilityConnectorKernel {
  private readonly store: CraftStore;

  constructor(store: CraftStore) { this.store = store; }

  register(args: JsonObject): JsonObject {
    const kind = text(args.kind, "kind"); const name = text(args.name, "name");
    if (!CONNECTOR_KINDS.has(kind)) throw new Error("Unsupported capability connector kind");
    const approved = args.approved === true;
    if (EXTERNAL_CONNECTORS.has(kind) && !approved) throw new Error("External connector requires explicit user approval");
    const endpoint = endpointFor(kind, args.endpoint, name);
    const connector = this.store.create("capability_connector", String(args.connector_id ?? id("connector")), {
      kind, name, endpoint, trust: kind === "builtin" ? "verified" : "trusted", status: "active",
      approval_ref: kind === "builtin" ? "builtin" : text(args.approval_ref, "approval_ref"),
      credentials_stored: false, user_managed: kind !== "builtin", metadata_digest: digest(args.metadata ?? {}),
    });
    return { connector };
  }

  discover(args: JsonObject): JsonObject {
    const connector = this.connector(args.connector_id); this.assertActive(connector);
    const entries = array(args.assets, "assets");
    if (!entries.length || entries.length > 100) throw new Error("assets must contain between 1 and 100 entries");
    const seen = new Set<string>();
    const assets = entries.map((value, index) => this.discoverOne(connector, object(value, `assets[${index}]`), seen));
    return { connector, assets };
  }

  update(args: JsonObject): JsonObject {
    if (typeof args.active !== "boolean") throw new Error("active must be a boolean");
    const connector = this.connector(args.connector_id);
    return { connector: this.store.save("capability_connector", String(connector.id), {
      ...recordPayload(connector), status: args.active ? "active" : "disabled",
    }) };
  }

  approve(args: JsonObject): JsonObject {
    const source = this.store.get("capability_connector_asset", text(args.connector_asset_id, "connector_asset_id"));
    const connector = this.store.get("capability_connector", String(source.connector_id)); this.assertActive(connector);
    if (source.status !== "discovered") throw new Error("Connector asset is not awaiting approval");
    const approvalRef = text(args.approval_ref, "approval_ref"); const effect = String(source.effect);
    const asset = this.store.create("capability_asset", String(args.asset_id ?? id("asset")), {
      name: source.name, asset_type: source.asset_type, source_uri: `connector://${connector.id}/${source.id}`,
      source_digest: source.source_digest, effect, dependencies: [], aliases: source.aliases,
      requires_credential: source.requires_credential, cost_hint: source.cost_hint, health: "healthy",
      trust: effect === "read_only" && !source.requires_credential ? "trusted" : "untrusted",
      connector_id: connector.id, connector_version: connector.version, connector_asset_id: source.id,
      connector_asset_version: source.version, approval_ref: approvalRef,
    });
    const approved = this.store.save("capability_connector_asset", String(source.id), {
      ...recordPayload(source), status: "approved", approval_ref: approvalRef,
      capability_asset_id: asset.id, capability_asset_version: asset.version,
    });
    return { connector, connector_asset: approved, asset };
  }

  list(args: JsonObject): JsonObject {
    const limit = args.limit === undefined ? 50 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be an integer between 1 and 100");
    const connectors = this.store.list("capability_connector", limit).map((connector) => ({
      id: connector.id, version: connector.version, kind: connector.kind, name: connector.name, trust: connector.trust,
      status: connector.status, user_managed: connector.user_managed, credentials_stored: connector.credentials_stored,
    }));
    const assets = this.store.list("capability_connector_asset", 10_000)
      .filter((asset) => connectors.some((connector) => connector.id === asset.connector_id))
      .map((asset) => ({ id: asset.id, version: asset.version, connector_id: asset.connector_id, name: asset.name,
        asset_type: asset.asset_type, effect: asset.effect, status: asset.status, source_digest: asset.source_digest,
        capability_asset_id: asset.capability_asset_id ?? null }));
    return { connectors, assets };
  }

  ticketIssue(args: JsonObject): JsonObject {
    const profile = this.store.get("activation_profile", text(args.profile_id, "profile_id"));
    const source = this.store.get("capability_connector_asset", text(args.connector_asset_id, "connector_asset_id"));
    const connector = this.store.get("capability_connector", String(source.connector_id)); this.assertActive(connector);
    if (source.status !== "approved" || source.capability_asset_id === undefined) throw new Error("Connector asset is not approved");
    const asset = this.store.get("capability_asset", String(source.capability_asset_id), Number(source.capability_asset_version));
    if (!(profile.asset_ids as string[]).includes(String(asset.id))) throw new Error("Capability asset is not in the activation profile");
    if (Number((profile.asset_versions as JsonObject)[String(asset.id)]) !== Number(asset.version)) throw new Error("Activation Profile pins a different asset version");
    if (asset.trust !== "trusted" && asset.trust !== "verified") throw new Error("Capability asset is not trusted for execution");
    if (asset.health !== "healthy" || asset.requires_credential || !((profile.allowed_effects as string[]).includes(String(asset.effect)))) {
      throw new Error("Capability asset is not eligible for this Activation Profile");
    }
    if (connector.kind === "serena_mcp" && asset.effect !== "read_only") throw new Error("Serena connector only permits read-only calls");
    const expiresAt = expiry(args.expires_at); const operation = assertSafe(text(args.operation, "operation"), "operation");
    const call = this.store.create("capability_call", String(args.call_id ?? id("capability_call")), {
      profile_id: profile.id, profile_version: profile.version, asset_id: asset.id, asset_version: asset.version,
      operation, status: "issued", expires_at: expiresAt, connector_id: connector.id, connector_version: connector.version,
    });
    const ticket = this.store.create("capability_connector_ticket", String(args.ticket_id ?? id("connector_ticket")), {
      call_id: call.id, profile_id: profile.id, profile_version: profile.version, asset_id: asset.id, asset_version: asset.version,
      connector_id: connector.id, connector_version: connector.version, connector_asset_id: source.id,
      connector_asset_version: source.version, source_digest: source.source_digest, status: "issued", expires_at: expiresAt,
    });
    return { call, ticket };
  }

  ticketConsume(args: JsonObject): JsonObject {
    const ticket = this.store.get("capability_connector_ticket", text(args.ticket_id, "ticket_id"));
    const profileId = text(args.profile_id, "profile_id");
    if (ticket.profile_id !== profileId) throw new Error("Connector ticket profile does not match");
    if (ticket.status !== "issued") throw new Error("Connector ticket was already consumed");
    if (Date.parse(String(ticket.expires_at)) < Date.now()) throw new Error("Connector ticket has expired");
    const connector = this.store.get("capability_connector", String(ticket.connector_id)); this.assertActive(connector);
    const source = this.store.get("capability_connector_asset", String(ticket.connector_asset_id));
    if (source.status !== "approved" || Number(source.version) !== Number(ticket.connector_asset_version)) throw new Error("Connector asset changed after ticket issue");
    const call = this.store.get("capability_call", String(ticket.call_id));
    if (call.status !== "issued" || call.profile_id !== profileId) throw new Error("Underlying capability call is unavailable");
    const now = new Date().toISOString();
    const receipt = this.store.save("capability_call", String(call.id), { ...recordPayload(call), status: "consumed", consumed_at: now });
    const consumed = this.store.save("capability_connector_ticket", String(ticket.id), { ...recordPayload(ticket), status: "consumed", consumed_at: now });
    return { receipt, ticket: consumed };
  }

  private connector(connectorId: unknown): JsonObject { return this.store.get("capability_connector", text(connectorId, "connector_id")); }
  private assertActive(connector: JsonObject): void {
    if (connector.status !== "active" || !["trusted", "verified"].includes(String(connector.trust))) throw new Error("Capability connector is not active and trusted");
  }
  private discoverOne(connector: JsonObject, entry: JsonObject, seen: Set<string>): JsonObject {
    const name = text(entry.name, "asset name"); const assetType = text(entry.asset_type, "asset_type"); const effect = text(entry.effect, "effect");
    if (!ASSET_TYPES.has(assetType) || !EFFECTS.has(effect)) throw new Error("Connector asset type or effect is unsupported");
    if (connector.kind === "serena_mcp" && effect !== "read_only") throw new Error("Serena connector only permits read-only assets");
    const logicalId = text(entry.logical_id, "logical_id"); if (seen.has(logicalId)) throw new Error("Connector discovery logical_id must be unique"); seen.add(logicalId);
    const summary = assertSafe(optionalText(entry.summary, "summary") ?? name, "summary");
    const locator = assertSafe(optionalText(entry.source_locator, "source_locator") ?? logicalId, "source_locator");
    const aliases = entry.aliases === undefined ? [] : array(entry.aliases, "aliases").map((item) => text(item, "alias"));
    if (new Set(aliases).size !== aliases.length) throw new Error("aliases must be unique");
    const sourceDigest = text(entry.source_digest ?? digest({ logicalId, summary, locator }), "source_digest");
    return this.store.create("capability_connector_asset", String(entry.connector_asset_id ?? id("connector_asset")), {
      connector_id: connector.id, connector_version: connector.version, logical_id: logicalId, name, summary,
      source_locator: locator, source_digest: sourceDigest, asset_type: assetType, effect, aliases,
      requires_credential: entry.requires_credential === true, cost_hint: object(entry.cost_hint ?? {}, "cost_hint"),
      status: "discovered", approval_ref: null,
    });
  }
}
