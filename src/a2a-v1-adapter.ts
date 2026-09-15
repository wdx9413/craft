import { createHash, randomUUID } from "node:crypto";
import type { JsonObject } from "./store.ts";
import { CraftStore } from "./store.ts";

export interface A2AV1Fetch { (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; json(): Promise<unknown> }>; }

function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function payload(record: JsonObject): JsonObject { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
function endpoint(value: unknown): string { const url = new URL(text(value, "endpoint")); if (url.protocol !== "https:" || url.username || url.password) throw new Error("A2A v1 endpoint must be an HTTPS URL without credentials"); return url.toString().replace(/\/$/u, ""); }
function object(value: unknown, name: string): JsonObject { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`); return value as JsonObject; }
function taskState(remote: JsonObject): string {
  const status = remote.status;
  return text(status && typeof status === "object" && !Array.isArray(status) ? (status as JsonObject).state : status, "A2A v1 task state");
}

/**
 * Optional protocol Adapter for A2A v1 JSON-RPC.  It only carries the
 * already-consumed Craft delegation grant and content-free digests; identity,
 * Artifact authorization and quality gates remain owned by existing kernels.
 */
export class A2AV1AdapterKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  async discover(args: JsonObject, fetchImpl: A2AV1Fetch = fetch as unknown as A2AV1Fetch): Promise<JsonObject> {
    const base = endpoint(args.endpoint); const cardUrl = `${base}/.well-known/agent-card.json`;
    const response = await fetchImpl(cardUrl, { method: "GET", headers: { accept: "application/json" } }); if (response.status < 200 || response.status >= 300) throw new Error(`A2A Agent Card HTTP ${response.status}`);
    const card = object(await response.json(), "A2A Agent Card"); const version = text(card.protocolVersion, "A2A Agent Card protocolVersion"); if (!version.startsWith("1.")) throw new Error("A2A Agent Card is not v1 compatible");
    const declaredUrl = endpoint(card.url); const identity = { endpoint: base, card_url: declaredUrl, protocol_version: version, card_digest: digest(card) };
    const observationId = String(args.observation_id ?? `a2a_v1_card_${digest(identity).slice(-24)}`); const existing = this.store.find("a2a_v1_card_observation", observationId); const observationDigest = digest(identity);
    if (existing) { if (existing.observation_digest !== observationDigest) throw new Error("A2A v1 card observation idempotency conflict"); return { observation: existing, idempotent: true }; }
    return { observation: this.store.create("a2a_v1_card_observation", observationId, { ...identity, observation_digest: observationDigest, verified_transport: true, raw_card_stored: false }), idempotent: false };
  }

  async submit(args: JsonObject, fetchImpl: A2AV1Fetch = fetch as unknown as A2AV1Fetch): Promise<JsonObject> {
    const grant = this.store.get("federated_delegation_grant", text(args.grant_id, "grant_id")); if (grant.status !== "consumed") throw new Error("A2A v1 task requires a consumed Federated Delegation Grant");
    if (grant.effect !== "read_only") throw new Error("A2A v1 task requires a read-only Federated Delegation Grant");
    const card = this.store.get("a2a_v1_card_observation", text(args.card_observation_id, "card_observation_id")); const requestId = text(args.request_id, "request_id");
    const identity = { grant_id: grant.id, grant_digest: grant.grant_digest, card_observation_id: card.id, card_observation_version: card.version, request_id: requestId, input_digest: text(args.input_digest, "input_digest") };
    const taskId = String(args.task_id ?? `a2a_v1_task_${randomUUID().replaceAll("-", "")}`); const existing = this.store.find("a2a_v1_task", taskId); const taskDigest = digest(identity);
    if (existing) { if (existing.task_digest !== taskDigest) throw new Error("A2A v1 task idempotency conflict"); return { task: existing, idempotent: true }; }
    const body = { jsonrpc: "2.0", id: requestId, method: "message/send", params: { message: { role: "user", parts: [{ type: "data", data: { craft_grant_digest: grant.grant_digest, input_digest: identity.input_digest, raw_context_included: false } }] } } };
    const response = await fetchImpl(String(card.card_url), { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "idempotency-key": requestId }, body: JSON.stringify(body) }); if (response.status < 200 || response.status >= 300) throw new Error(`A2A v1 message/send HTTP ${response.status}`);
    const result = object(await response.json(), "A2A v1 response"); if (result.error) throw new Error("A2A v1 remote returned an error"); const remote = object(result.result, "A2A v1 result"); const remoteTaskId = text(remote.id, "A2A v1 task id"); const status = taskState(remote);
    if (!new Set(["submitted", "working", "input-required", "completed", "failed", "canceled", "rejected"]).has(status)) throw new Error("A2A v1 task state is unsupported");
    const task = this.store.create("a2a_v1_task", taskId, { ...identity, task_digest: taskDigest, endpoint: card.card_url, remote_task_id: remoteTaskId, status, response_digest: digest(remote), raw_remote_content_stored: false });
    return { task, idempotent: false };
  }

  async taskGet(args: JsonObject, fetchImpl: A2AV1Fetch = fetch as unknown as A2AV1Fetch): Promise<JsonObject> {
    const task = this.store.get("a2a_v1_task", text(args.task_id, "task_id")); if (["completed", "failed", "canceled", "rejected"].includes(String(task.status))) return { task, idempotent: true };
    const requestId = text(args.request_id, "request_id"); const body = { jsonrpc: "2.0", id: requestId, method: "tasks/get", params: { id: task.remote_task_id } };
    const response = await fetchImpl(String(task.endpoint), { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "idempotency-key": requestId }, body: JSON.stringify(body) }); if (response.status < 200 || response.status >= 300) throw new Error(`A2A v1 tasks/get HTTP ${response.status}`);
    const result = object(await response.json(), "A2A v1 response"); if (result.error) throw new Error("A2A v1 remote returned an error"); const remote = object(result.result, "A2A v1 result"); const status = taskState(remote);
    if (!new Set(["submitted", "working", "input-required", "completed", "failed", "canceled", "rejected"]).has(status)) throw new Error("A2A v1 task state is unsupported");
    const saved = this.store.save("a2a_v1_task", String(task.id), { ...payload(task), status, response_digest: digest(remote), last_polled_at: new Date().toISOString() });
    return { task: saved, idempotent: false };
  }

  async cancel(args: JsonObject, fetchImpl: A2AV1Fetch = fetch as unknown as A2AV1Fetch): Promise<JsonObject> {
    const task = this.store.get("a2a_v1_task", text(args.task_id, "task_id")); const requestId = text(args.request_id, "request_id");
    const body = { jsonrpc: "2.0", id: requestId, method: "tasks/cancel", params: { id: task.remote_task_id, reason_digest: text(args.reason_digest, "reason_digest") } };
    const response = await fetchImpl(String(task.endpoint), { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "idempotency-key": requestId }, body: JSON.stringify(body) }); if (response.status < 200 || response.status >= 300) throw new Error(`A2A v1 tasks/cancel HTTP ${response.status}`);
    const result = object(await response.json(), "A2A v1 response"); if (result.error) throw new Error("A2A v1 remote returned an error"); const remote = object(result.result, "A2A v1 result"); const status = taskState(remote);
    const saved = this.store.save("a2a_v1_task", String(task.id), { ...payload(task), status, response_digest: digest(remote), cancel_requested_at: new Date().toISOString() });
    return { task: saved, idempotent: false };
  }
}
