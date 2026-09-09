import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim();
}
function id(value: unknown, name: string): string {
  const result = text(value, name); if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(result)) throw new Error(`${name} is invalid`); return result;
}
function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`); return value as JsonObject;
}
function integer(value: unknown, name: string, fallback: number, min: number, max: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${name} must be an integer between ${min} and ${max}`); return result;
}
function fields(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new Error("allowed_fields must be an array with at most 32 fields");
  const result = value.map((item) => text(item, "allowed_field"));
  if (new Set(result).size !== result.length || result.some((field) => !/^[a-zA-Z0-9_-]{1,128}$/u.test(field) ||
    /(?:api[_-]?key|authorization|cookie|password|secret|token)/iu.test(field))) throw new Error("allowed_fields contains duplicate, invalid, or sensitive fields");
  return result;
}
function scalar(value: unknown, name: string): string | number | boolean | null {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string" && value.length <= 2048) return value;
  throw new Error(`${name} must be a bounded scalar`);
}
function instant(value: unknown, name: string): number {
  const result = value === undefined ? Date.now() : Date.parse(text(value, name));
  if (Number.isNaN(result)) throw new Error(`${name} must be an ISO timestamp`); return result;
}

export class TriggerKernel {
  readonly store: CraftStore; readonly env: NodeJS.ProcessEnv;
  constructor(store: CraftStore, env: NodeJS.ProcessEnv = process.env) { this.store = store; this.env = env; }

  subscriptionSave(args: JsonObject): JsonObject {
    const subscriptionId = id(args.subscription_id, "subscription_id"); const task = this.store.get("task", text(args.task_id, "task_id"));
    const handle = this.store.get("credential_handle", text(args.handle_id, "handle_id"));
    if (handle.status !== "active") throw new Error("Webhook credential handle is not active");
    const filters = object(args.filters ?? {}, "filters");
    for (const [key, value] of Object.entries(filters)) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(key) || /(?:api[_-]?key|authorization|cookie|password|secret|token)/iu.test(key)) {
        throw new Error("filters contains an invalid or sensitive field");
      }
      scalar(value, `filters.${key}`);
    }
    const allowedFields = fields(args.allowed_fields); const budget = args.budget_id === undefined ? null
      : this.store.get("budget_account", text(args.budget_id, "budget_id"));
    if (budget && budget.status !== "active") throw new Error("Trigger budget must be active");
    const resources = object(args.per_event_resources ?? {}, "per_event_resources");
    for (const [key, value] of Object.entries(resources)) if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`per_event_resources.${key} must be a non-negative finite number`);
    }
    const next = { task_id: task.id, name: text(args.name, "name"), event_key: text(args.event_key, "event_key"),
      handle_id: handle.id, filters, allowed_fields: allowedFields, max_age_seconds: integer(args.max_age_seconds, "max_age_seconds", 300, 30, 3600),
      throttle_seconds: integer(args.throttle_seconds, "throttle_seconds", 0, 0, 3600), budget_id: budget?.id ?? null,
      per_event_resources: resources, status: args.status === undefined ? "active" : text(args.status, "status") };
    if (!new Set(["active", "paused"]).has(next.status)) throw new Error("Trigger subscription status is unsupported");
    const existing = this.store.find("trigger_subscription", subscriptionId);
    if (!existing) return { subscription: this.store.create("trigger_subscription", subscriptionId, next) };
    if (Number(args.expected_version) !== Number(existing.version)) throw new Error("Trigger subscription version conflict");
    return { subscription: this.store.save("trigger_subscription", subscriptionId, next) };
  }

  webhookIngest(args: JsonObject): JsonObject {
    const subscription = this.store.get("trigger_subscription", text(args.subscription_id, "subscription_id"));
    if (subscription.status !== "active") throw new Error("Trigger subscription is not active");
    const eventId = id(args.event_id, "event_id"); const rawBody = text(args.raw_body, "raw_body");
    if (Buffer.byteLength(rawBody) > 1024 * 1024) throw new Error("Webhook body exceeds 1 MiB");
    const timestamp = text(args.timestamp, "timestamp"); const signedAt = Date.parse(timestamp); const now = instant(args.now, "now");
    if (Number.isNaN(signedAt) || Math.abs(now - signedAt) > Number(subscription.max_age_seconds) * 1000) throw new Error("Webhook timestamp is invalid or outside the replay window");
    const handle = this.store.get("credential_handle", String(subscription.handle_id)); const secretRef = String(handle.secret_ref ?? "");
    const variable = secretRef.startsWith("env:") ? secretRef.slice(4) : ""; const secret = variable ? this.env[variable] : undefined;
    if (!secret) throw new Error("Webhook signing secret is unavailable");
    const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
    const supplied = text(args.signature, "signature").replace(/^sha256=/u, "");
    if (!/^[a-f0-9]{64}$/u.test(supplied) || !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) throw new Error("Webhook signature is invalid");
    const bodyDigest = `sha256:${createHash("sha256").update(rawBody).digest("hex")}`; const recordId = `${subscription.id}_${eventId}`;
    const existing = this.store.find("trigger_event", recordId);
    if (existing) {
      if (existing.body_digest !== bodyDigest || existing.timestamp !== timestamp) throw new Error("Webhook event idempotency conflict");
      return { trigger_event: existing, dispatch: existing.dispatch, idempotent: true };
    }
    let parsed: JsonObject;
    try { parsed = object(JSON.parse(rawBody), "webhook body"); } catch { throw new Error("Webhook body must be a JSON object"); }
    if (Object.entries(subscription.filters as JsonObject).some(([key, value]) => parsed[key] !== value)) {
      const ignored = this.store.create("trigger_event", recordId, { subscription_id: subscription.id, event_id: eventId,
        timestamp, body_digest: bodyDigest, status: "ignored", reason: "filter_mismatch", dispatch: null });
      return { trigger_event: ignored, dispatch: null, idempotent: false };
    }
    const last = this.store.list("trigger_event", 10_000, (item) => item.subscription_id === subscription.id &&
      new Set(["accepted", "delivered", "awaiting_budget"]).has(String(item.status)))
      .sort((left, right) => String(right.accepted_at).localeCompare(String(left.accepted_at)))[0];
    if (last && now - Date.parse(String(last.accepted_at)) < Number(subscription.throttle_seconds) * 1000) {
      const throttled = this.store.create("trigger_event", recordId, { subscription_id: subscription.id, event_id: eventId,
        timestamp, body_digest: bodyDigest, status: "throttled", reason: "minimum_interval", dispatch: null });
      return { trigger_event: throttled, dispatch: null, idempotent: false };
    }
    const projected = Object.fromEntries((subscription.allowed_fields as string[]).filter((field) => Object.hasOwn(parsed, field))
      .map((field) => [field, scalar(parsed[field], `payload.${field}`)]));
    const dispatch = { kind: "external_event", task_id: subscription.task_id, event_key: subscription.event_key,
      payload: projected, trust: "untrusted_data", execution_authority: false };
    const accepted = this.store.create("trigger_event", recordId, { subscription_id: subscription.id, event_id: eventId,
      timestamp, body_digest: bodyDigest, status: "accepted", accepted_at: new Date(now).toISOString(), dispatch,
      raw_body_stored: false, budget_id: subscription.budget_id, per_event_resources: subscription.per_event_resources });
    return { trigger_event: accepted, dispatch, idempotent: false };
  }
}
