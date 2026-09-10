import { createHash, randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function object(value: unknown, name: string): JsonObject { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`); return value as JsonObject; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : []; }

/** Read-only A2A Agent Card catalog. Cards are untrusted metadata, never execution authority. */
export class A2ADiscoveryKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }
  async discover(args: JsonObject): Promise<JsonObject> {
    const supplied = new URL(text(args.url, "url")); if (supplied.protocol !== "https:") throw new Error("A2A discovery requires an HTTPS URL"); const url = supplied.pathname.endsWith("agent-card.json") ? supplied : new URL("/.well-known/agent-card.json", supplied);
    const response = await fetch(url, { method: "GET", headers: { accept: "application/json" }, redirect: "error" }); if (!response.ok) throw new Error(`A2A Agent Card discovery failed: HTTP ${response.status}`); const card = object(await response.json(), "A2A Agent Card"); const name = text(card.name, "A2A Agent Card.name"); const endpoint = new URL(text(card.url, "A2A Agent Card.url")); if (endpoint.protocol !== "https:") throw new Error("A2A Agent Card endpoint must use HTTPS"); const raw = JSON.stringify(card); if (/(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]/iu.test(raw)) throw new Error("A2A Agent Card contains sensitive assignments");
    const identity = { discovery_url: url.toString(), name, endpoint: endpoint.toString(), protocol_version: typeof card.protocolVersion === "string" ? card.protocolVersion : null, skills: strings(card.skills).length ? strings(card.skills) : Array.isArray(card.skills) ? (card.skills as unknown[]).map((skill) => object(skill, "A2A Agent Card.skill")).map((skill) => text(skill.id, "A2A Agent Card.skill.id")) : [], card_digest: digest(card) }; const cardId = String(args.card_id ?? `a2a_agent_card_${randomUUID().replaceAll("-", "")}`); const existing = this.store.find("a2a_agent_card", cardId); if (existing) { if (existing.identity_digest !== digest(identity)) throw new Error("A2A Agent Card idempotency conflict or drift"); return { card: existing, idempotent: true }; }
    const record = this.store.create("a2a_agent_card", cardId, { ...identity, identity_digest: digest(identity), discovered_at: new Date().toISOString(), trusted: false, execution_authority: false, status: "discovered" }); return { card: record, idempotent: false };
  }
  get(args: JsonObject): JsonObject { return { card: this.store.get("a2a_agent_card", text(args.card_id, "card_id")) }; }
  list(args: JsonObject): JsonObject { return { cards: this.store.list("a2a_agent_card", Number(args.limit ?? 100)) }; }
}
