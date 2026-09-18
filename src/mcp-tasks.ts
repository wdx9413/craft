import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

const STATES = new Set(["working", "input_required", "completed", "failed", "cancelled", "expired"]);
const TERMINAL = new Set(["completed", "failed", "cancelled", "expired"]);

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}
function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
function payload(record: JsonObject): JsonObject {
  const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record;
  return rest;
}
function ownerOf(record: JsonObject, owner: unknown): void {
  const expected = record.owner === null ? null : text(record.owner, "owner");
  const actual = owner === undefined || owner === null ? null : text(owner, "owner");
  if (expected !== actual) throw new Error("MCP Task is not visible to this owner");
}

/** Durable, owner-scoped MCP Tasks projection. It never stores request/result bodies. */
export class McpTaskKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  create(args: JsonObject): JsonObject {
    const requestId = text(args.request_id, "request_id");
    const operation = text(args.operation, "operation");
    const inputDigest = text(args.input_digest ?? digest(args.input ?? null), "input_digest");
    const owner = args.owner === undefined || args.owner === null ? null : text(args.owner, "owner");
    const ttl = args.ttl_seconds === undefined ? 86_400 : Number(args.ttl_seconds);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 2_592_000) throw new Error("ttl_seconds must be an integer between 1 and 2592000");
    const pollInterval = args.poll_interval_ms === undefined ? 1_000 : Number(args.poll_interval_ms);
    if (!Number.isInteger(pollInterval) || pollInterval < 100 || pollInterval > 86_400_000) throw new Error("poll_interval_ms must be an integer between 100 and 86400000");
    const taskId = args.task_id === undefined ? `mcp_task_${digest({ requestId, operation, inputDigest }).slice(-20)}` : text(args.task_id, "task_id");
    const now = new Date().toISOString();
    const existing = this.store.find("mcp_task", taskId);
    if (existing) {
      ownerOf(existing, owner);
      if (existing.request_id !== requestId || existing.operation !== operation || existing.input_digest !== inputDigest) throw new Error("MCP Task idempotency conflict");
      return { task: existing, idempotent: true };
    }
    const task = this.store.create("mcp_task", taskId, {
      request_id: requestId, operation, input_digest: inputDigest, owner,
      status: "working", created_at_mcp: now, expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
      poll_interval_ms: pollInterval, updates: [],
    });
    return { task, idempotent: false };
  }

  get(args: JsonObject): JsonObject {
    const task = this.store.get("mcp_task", text(args.task_id, "task_id"));
    ownerOf(task, args.owner);
    return { task: this.expireOne(task) };
  }

  update(args: JsonObject): JsonObject {
    const task = this.store.get("mcp_task", text(args.task_id, "task_id"));
    ownerOf(task, args.owner);
    const current = this.expireOne(task);
    if (TERMINAL.has(String(current.status))) return { task: current, idempotent: true };
    const next = text(args.status ?? current.status, "status");
    if (!STATES.has(next)) throw new Error(`Unsupported MCP Task status: ${next}`);
    const updates = current.updates as unknown[];
    const update = { status: next, input_digest: args.input_digest === undefined ? current.input_digest : text(args.input_digest, "input_digest"), result_digest: args.result_digest === undefined ? current.result_digest ?? null : text(args.result_digest, "result_digest"), error_code: args.error_code === undefined ? current.error_code ?? null : text(args.error_code, "error_code"), at: new Date().toISOString() };
    return { task: this.store.updateIfVersion("mcp_task", String(current.id), Number(current.version), { ...payload(current), ...update, updates: [...updates, { status: next, at: update.at }] }), idempotent: false };
  }

  cancel(args: JsonObject): JsonObject {
    return this.update({ ...args, status: "cancelled", error_code: args.reason ?? "cancelled" });
  }

  expire(args: JsonObject = {}): JsonObject {
    const now = args.now === undefined ? Date.now() : Date.parse(text(args.now, "now"));
    if (!Number.isFinite(now)) throw new Error("now must be an ISO timestamp");
    const expired = this.store.list("mcp_task", 10_000).filter((task) => !TERMINAL.has(String(task.status)) && Date.parse(String(task.expires_at)) <= now);
    for (const task of expired) this.store.updateIfVersion("mcp_task", String(task.id), Number(task.version), { ...payload(task), status: "expired", updates: [...(task.updates as unknown[]), { status: "expired", at: new Date(now).toISOString() }] });
    return { count: expired.length };
  }

  private expireOne(task: JsonObject): JsonObject {
    if (TERMINAL.has(String(task.status)) || Date.parse(String(task.expires_at)) > Date.now()) return task;
    return this.store.updateIfVersion("mcp_task", String(task.id), Number(task.version), { ...payload(task), status: "expired", updates: [...(task.updates as unknown[]), { status: "expired", at: new Date().toISOString() }] });
  }
}
