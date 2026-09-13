import { createHash, randomUUID } from "node:crypto";
import type { JsonObject } from "./store.ts";
import { CraftStore } from "./store.ts";
function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function https(value: unknown, name: string): string { const result = text(value, name); if (!result.startsWith("https://")) throw new Error(`${name} must use HTTPS`); return result; }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
const TRUST = new Set(["official", "private", "community"]); const HEALTH = new Set(["healthy", "degraded", "unhealthy", "revoked"]);
export interface RegistryFetch { (input: string, init?: { method?: string; headers?: Record<string, string> }): Promise<{ status: number; json(): Promise<unknown> }> }
export class McpRegistryKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }
  sourceRegister(args: JsonObject): JsonObject {
    const sourceId = String(args.source_id ?? `mcp_registry_source_${randomUUID().replaceAll("-", "")}`); const endpoint = https(args.endpoint, "endpoint"); const trust = text(args.trust ?? "community", "trust"); if (!TRUST.has(trust)) throw new Error("Unsupported registry trust");
    const identity = { endpoint, trust, key_digest: args.key_digest ?? null }; const identityDigest = digest(identity); const existing = this.store.find("mcp_registry_source", sourceId); if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("MCP Registry source conflict"); return { source: existing, idempotent: true }; }
    return { source: this.store.create("mcp_registry_source", sourceId, { ...identity, identity_digest: identityDigest, enabled: true }), idempotent: false };
  }
  serverIngest(args: JsonObject): JsonObject {
    const source = this.store.get("mcp_registry_source", text(args.source_id, "source_id")); if (source.enabled !== true) throw new Error("MCP Registry source is disabled"); const name = text(args.name, "name"); const version = text(args.version, "version"); const endpoint = https(args.endpoint, "endpoint"); const digestValue = text(args.digest, "digest");
    const serverId = String(args.server_id ?? `mcp_registry_server_${digest({ source_id: source.id, name, version, digest: digestValue }).slice(-24)}`); const record = { source_id: source.id, name, version, endpoint, digest: digestValue, capabilities: args.capabilities ?? [], status: "active" }; const existing = this.store.find("mcp_registry_server", serverId); if (existing) { if (existing.digest !== digestValue) throw new Error("MCP Registry server digest drift"); return { server: existing, idempotent: true }; }
    return { server: this.store.create("mcp_registry_server", serverId, record), idempotent: false };
  }
  health(args: JsonObject): JsonObject { const server = this.store.get("mcp_registry_server", text(args.server_id, "server_id")); const status = text(args.status ?? "healthy", "status"); if (!HEALTH.has(status)) throw new Error("Unsupported MCP Registry health status"); const healthId = String(args.health_id ?? `mcp_registry_health_${server.id}`); const existing = this.store.find("mcp_registry_health", healthId); const result = { server_id: server.id, status, checked_at: args.checked_at ?? new Date().toISOString(), evidence_digest: args.evidence_digest ?? null }; if (existing) return { health: existing, idempotent: true }; return { health: this.store.create("mcp_registry_health", healthId, result), idempotent: false }; }
  revoke(args: JsonObject): JsonObject { const server = this.store.get("mcp_registry_server", text(args.server_id, "server_id")); const updated = this.store.save("mcp_registry_server", String(server.id), { ...server, status: "revoked", revoke_reason: text(args.reason, "reason") }); return { server: updated, idempotent: server.status === "revoked" }; }

  /** Pull one registry page through an injected adapter; metadata is still untrusted until certification. */
  async sync(args: JsonObject, fetchImpl: RegistryFetch = fetch as unknown as RegistryFetch): Promise<JsonObject> {
    const source = this.store.get("mcp_registry_source", text(args.source_id, "source_id")); if (source.enabled !== true) throw new Error("MCP Registry source is disabled");
    const endpoint = https(args.list_url ?? source.endpoint, "list_url"); const response = await fetchImpl(endpoint, { method: "GET", headers: { accept: "application/json" } });
    if (response.status < 200 || response.status >= 300) throw new Error(`MCP Registry sync HTTP ${response.status}`);
    const body = await response.json(); const entries: unknown[] | null = Array.isArray(body) ? body : body && typeof body === "object" && Array.isArray((body as JsonObject).servers) ? (body as JsonObject).servers as unknown[] : null;
    if (!entries) throw new Error("MCP Registry response must contain a servers array");
    const servers: JsonObject[] = []; for (const entry of entries) { if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("MCP Registry server entry must be an object"); servers.push(this.serverIngest({ source_id: source.id, ...(entry as JsonObject) }).server as JsonObject); }
    return { source_id: source.id, endpoint, count: servers.length, servers, response_digest: digest(body) };
  }
}
