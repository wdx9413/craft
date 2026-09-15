import { createHash, randomBytes } from "node:crypto";
import type { JsonObject } from "./store.ts";
import { CraftStore } from "./store.ts";

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}

function instant(value: unknown, name: string): number {
  const result = Date.parse(text(value, name));
  if (!Number.isFinite(result)) throw new Error(`${name} must be an ISO timestamp`);
  return result;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function sha256(value: string): string { return digest(value); }

function payload(record: JsonObject): JsonObject {
  const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record;
  return rest;
}

function uniqueStrings(value: unknown, name: string, minimum = 0): string[] {
  if (!Array.isArray(value) || value.length < minimum) throw new Error(`${name} must contain at least ${minimum} values`);
  const values = value.map((item) => text(item, name));
  if (new Set(values).size !== values.length) throw new Error(`${name} must contain unique values`);
  return values.sort();
}

function opaqueHandle(): string { return randomBytes(32).toString("base64url"); }

/**
 * Durable authorization binding for a remotely reachable Craft task.
 *
 * The clear-text handle is intentionally returned only from `bind`; records
 * retain its digest.  Every remote get/result/cancel/stream request crosses
 * this one seam, so an endpoint cannot widen a principal or tenant by merely
 * knowing a task id.
 */
export class RemoteRuntimeKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  tenantRegister(args: JsonObject): JsonObject {
    const tenantId = text(args.tenant_id, "tenant_id");
    const identity = {
      tenant_id: tenantId,
      data_space_id: text(args.data_space_id, "data_space_id"),
      key_envelope_ref: text(args.key_envelope_ref, "key_envelope_ref"),
      retention_policy_ref: text(args.retention_policy_ref, "retention_policy_ref"),
      deletion_policy_ref: text(args.deletion_policy_ref, "deletion_policy_ref"),
    };
    const identityDigest = digest(identity); const existing = this.store.find("remote_tenant", tenantId);
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Remote tenant idempotency conflict");
      return { tenant: existing, idempotent: true };
    }
    return { tenant: this.store.create("remote_tenant", tenantId, { ...identity, identity_digest: identityDigest, status: "active", raw_key_stored: false }), idempotent: false };
  }

  bind(args: JsonObject): JsonObject {
    const tenant = this.activeTenant(text(args.tenant_id, "tenant_id"));
    const task = this.store.get("task", text(args.task_id, "task_id"));
    const scopes = uniqueStrings(args.scopes, "scopes", 1);
    const expiresAt = text(args.expires_at, "expires_at"); const expires = instant(expiresAt, "expires_at");
    const now = args.now === undefined ? Date.now() : instant(args.now, "now");
    if (expires <= now) throw new Error("Remote task binding must not already be expired");
    const identity = {
      task_id: task.id, task_version: task.version, tenant_id: tenant.id, tenant_version: tenant.version,
      principal_digest: this.sha256Ref(args.principal_digest, "principal_digest"),
      access_receipt_digest: this.sha256Ref(args.access_receipt_digest, "access_receipt_digest"),
      audience: text(args.audience, "audience"), scopes, expires_at: new Date(expires).toISOString(),
    };
    const bindingId = String(args.binding_id ?? `remote_task_${randomBytes(12).toString("hex")}`);
    const existing = this.store.find("remote_task_binding", bindingId); const bindingDigest = digest(identity);
    if (existing) {
      if (existing.binding_digest !== bindingDigest) throw new Error("Remote task binding idempotency conflict");
      return { binding: existing, handle: null, idempotent: true };
    }
    const handle = opaqueHandle();
    const binding = this.store.create("remote_task_binding", bindingId, {
      ...identity, binding_digest: bindingDigest, handle_digest: sha256(handle), status: "active", issued_at: new Date(now).toISOString(),
      raw_handle_stored: false, authorized_operations: ["get", "result", "cancel", "stream"],
    });
    return { binding, handle, idempotent: false, handle_returned_once: true };
  }

  authorize(args: JsonObject): JsonObject {
    const binding = this.store.get("remote_task_binding", text(args.binding_id, "binding_id"));
    const operation = text(args.operation, "operation");
    if (!(binding.authorized_operations as string[]).includes(operation)) throw new Error("Remote task operation is unsupported");
    const now = args.now === undefined ? Date.now() : instant(args.now, "now");
    if (binding.status !== "active" || now >= Date.parse(String(binding.expires_at))) throw new Error("Remote task binding is inactive or expired");
    this.activeTenant(String(binding.tenant_id), Number(binding.tenant_version));
    if (sha256(text(args.handle, "handle")) !== binding.handle_digest) throw new Error("Remote task handle does not match");
    if (text(args.tenant_id, "tenant_id") !== binding.tenant_id) throw new Error("Remote task tenant does not match");
    if (this.sha256Ref(args.principal_digest, "principal_digest") !== binding.principal_digest) throw new Error("Remote task principal does not match");
    if (this.sha256Ref(args.access_receipt_digest, "access_receipt_digest") !== binding.access_receipt_digest) throw new Error("Remote task authorization receipt does not match");
    if (text(args.audience, "audience") !== binding.audience) throw new Error("Remote task audience does not match");
    const scopes = uniqueStrings(args.scopes, "scopes", 1);
    if ((binding.scopes as string[]).some((scope) => !scopes.includes(scope))) throw new Error("Remote task scope is insufficient");
    const receiptId = String(args.receipt_id ?? `remote_task_access_${binding.id}_${operation}_${randomBytes(8).toString("hex")}`);
    const identity = { binding_id: binding.id, binding_version: binding.version, operation, at: new Date(now).toISOString(), principal_digest: binding.principal_digest, tenant_id: binding.tenant_id };
    const existing = this.store.find("remote_task_access_receipt", receiptId);
    if (existing) {
      if (existing.access_digest !== digest(identity)) throw new Error("Remote task access receipt idempotency conflict");
      return { binding, receipt: existing, idempotent: true };
    }
    const receipt = this.store.create("remote_task_access_receipt", receiptId, { ...identity, access_digest: digest(identity), raw_handle_stored: false });
    return { binding, receipt, idempotent: false };
  }

  revoke(args: JsonObject): JsonObject {
    const binding = this.store.get("remote_task_binding", text(args.binding_id, "binding_id"));
    if (binding.status === "revoked") return { binding, idempotent: true };
    if (binding.status !== "active") throw new Error("Only an active remote task binding can be revoked");
    const saved = this.store.save("remote_task_binding", String(binding.id), { ...payload(binding), status: "revoked", revoked_at: args.now === undefined ? new Date().toISOString() : new Date(instant(args.now, "now")).toISOString(), revocation_reason: text(args.reason, "reason") });
    return { binding: saved, idempotent: false };
  }

  get(args: JsonObject): JsonObject {
    const binding = this.store.get("remote_task_binding", text(args.binding_id, "binding_id"));
    return { binding, receipts: this.store.list("remote_task_access_receipt", 10_000, (item) => item.binding_id === binding.id) };
  }

  private activeTenant(id: string, version?: number): JsonObject {
    const tenant = this.store.get("remote_tenant", id, version);
    if (tenant.status !== "active") throw new Error("Remote tenant is not active");
    return tenant;
  }

  private sha256Ref(value: unknown, name: string): string {
    const result = text(value, name);
    if (!/^sha256:[a-f0-9]{64}$/u.test(result)) throw new Error(`${name} must be a SHA-256 digest`);
    return result;
  }
}
