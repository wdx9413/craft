import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

const PROVIDER_KINDS = new Set(["oidc_workload_identity", "short_lived_broker"]);
const EFFECTS = new Set(["read_only", "external_write", "destructive"]);

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}
function strings(value: unknown, name: string, minimum = 0): string[] {
  if (!Array.isArray(value) || value.length < minimum) throw new Error(`${name} must contain at least ${minimum} values`);
  const values = value.map((item) => text(item, name));
  if (new Set(values).size !== values.length) throw new Error(`${name} must contain unique values`);
  return values.sort();
}
function instant(value: unknown, name: string): number {
  const result = value === undefined ? Date.now() : Date.parse(text(value, name));
  if (Number.isNaN(result)) throw new Error(`${name} must be an ISO timestamp`);
  return result;
}
function integer(value: unknown, name: string, fallback: number, minimum: number, maximum: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return result;
}
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function payload(record: JsonObject): JsonObject {
  const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record;
  return rest;
}
function confirmedEvidence(store: CraftStore, ids: string[]): void {
  for (const id of ids) if (store.get("evidence", id).confidence !== "confirmed") throw new Error("Enterprise boundary verification requires confirmed Evidence");
}

/**
 * Declarative enterprise edge. It stores no credentials and never calls a
 * provider; a deployment-specific broker consumes the short-lived lease.
 */
export class EnterpriseAccessKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  providerRegister(args: JsonObject): JsonObject {
    const kind = text(args.kind, "kind"); if (!PROVIDER_KINDS.has(kind)) throw new Error("Enterprise identity provider kind is unsupported");
    const issuer = new URL(text(args.issuer, "issuer")); if (issuer.protocol !== "https:" || issuer.username || issuer.password) throw new Error("Enterprise issuer must be an HTTPS URL without credentials");
    const definition = { kind, issuer: issuer.toString(), audience: text(args.audience, "audience"), broker_ref: text(args.broker_ref, "broker_ref"), organization_ref: text(args.organization_ref, "organization_ref") };
    const providerId = text(args.provider_id, "provider_id"); const existing = this.store.find("enterprise_identity_provider", providerId); const definitionDigest = digest(definition);
    if (existing) { if (existing.definition_digest !== definitionDigest) throw new Error("Enterprise identity provider idempotency conflict"); return { provider: existing, idempotent: true }; }
    return { provider: this.store.create("enterprise_identity_provider", providerId, { ...definition, definition_digest: definitionDigest, lifecycle: "declared", raw_credential_stored: false }), idempotent: false };
  }

  providerVerify(args: JsonObject): JsonObject {
    const provider = this.store.get("enterprise_identity_provider", text(args.provider_id, "provider_id"));
    if (provider.lifecycle === "verified") return { provider, idempotent: true };
    if (provider.lifecycle !== "declared") throw new Error("Enterprise identity provider cannot be verified from its current lifecycle");
    const evidenceIds = strings(args.evidence_ids, "evidence_ids", 1); confirmedEvidence(this.store, evidenceIds);
    const claims = strings(args.observed_claims, "observed_claims", 4); const required = ["short_lived_credentials", "token_exchange", "audit_subject", "revocation"];
    if (required.some((claim) => !claims.includes(claim))) throw new Error("Enterprise identity provider verification is missing a required boundary claim");
    const ttl = integer(args.max_ttl_seconds, "max_ttl_seconds", 900, 60, 3_600);
    return { provider: this.store.save("enterprise_identity_provider", String(provider.id), { ...payload(provider), lifecycle: "verified", evidence_ids: evidenceIds, observed_claims: claims, max_ttl_seconds: ttl, verified_by: text(args.verified_by, "verified_by") }), idempotent: false };
  }

  principalBind(args: JsonObject): JsonObject {
    const provider = this.verifiedProvider(text(args.provider_id, "provider_id")); const task = this.store.get("task", text(args.task_id, "task_id"));
    const subjectDigest = text(args.subject_digest, "subject_digest"); if (!/^sha256:[a-f0-9]{64}$/u.test(subjectDigest)) throw new Error("subject_digest must be SHA-256; raw subject identifiers are not stored");
    const now = instant(args.now, "now"); const ttl = integer(args.ttl_seconds, "ttl_seconds", Math.min(900, Number(provider.max_ttl_seconds)), 60, Number(provider.max_ttl_seconds));
    const identity = { provider_id: provider.id, provider_version: provider.version, task_id: task.id, subject_digest: subjectDigest, roles: strings(args.roles, "roles", 1), organization_ref: provider.organization_ref };
    const principalId = text(args.principal_id, "principal_id"); const existing = this.store.find("enterprise_principal", principalId); const identityDigest = digest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Enterprise principal idempotency conflict"); return { principal: existing, idempotent: true }; }
    return { principal: this.store.create("enterprise_principal", principalId, { ...identity, identity_digest: identityDigest, status: "active", bound_at: new Date(now).toISOString(), expires_at: new Date(now + ttl * 1_000).toISOString() }), idempotent: false };
  }

  adapterBind(args: JsonObject): JsonObject {
    const provider = this.verifiedProvider(text(args.provider_id, "provider_id")); const publication = this.store.get("contract_publication", text(args.contract_publication_id, "contract_publication_id"));
    if (publication.status !== "active") throw new Error("Enterprise Adapter requires an active Contract Publication");
    const asset = this.store.get("capability_asset", String(publication.asset_id), Number(publication.asset_version));
    if (asset.trust !== "verified" || asset.health !== "healthy") throw new Error("Enterprise Adapter requires a verified healthy Capability Asset");
    const effects = strings(args.allowed_effects, "allowed_effects", 1); if (effects.some((effect) => !EFFECTS.has(effect))) throw new Error("Enterprise Adapter effect is unsupported");
    if (!effects.includes(String(asset.effect))) throw new Error("Enterprise Adapter cannot widen its published Contract effect");
    const definition = { provider_id: provider.id, provider_version: provider.version, contract_publication_id: publication.id, contract_publication_version: publication.version,
      asset_id: asset.id, asset_version: asset.version, allowed_effects: effects, target_host: text(args.target_host, "target_host") };
    const bindingId = text(args.binding_id, "binding_id"); const existing = this.store.find("enterprise_adapter_binding", bindingId); const definitionDigest = digest(definition);
    if (existing) { if (existing.definition_digest !== definitionDigest) throw new Error("Enterprise Adapter binding idempotency conflict"); return { binding: existing, idempotent: true }; }
    return { binding: this.store.create("enterprise_adapter_binding", bindingId, { ...definition, definition_digest: definitionDigest, lifecycle: "active", raw_credential_stored: false }), idempotent: false };
  }

  ticketIssue(args: JsonObject): JsonObject {
    const binding = this.store.get("enterprise_adapter_binding", text(args.binding_id, "binding_id")); if (binding.lifecycle !== "active") throw new Error("Enterprise Adapter binding is not active");
    const principal = this.store.get("enterprise_principal", text(args.principal_id, "principal_id")); const task = this.store.get("task", text(args.task_id, "task_id")); const now = instant(args.now, "now");
    if (principal.status !== "active" || principal.task_id !== task.id || now >= Date.parse(String(principal.expires_at))) throw new Error("Enterprise principal is inactive, expired, or belongs to another task");
    const lease = this.store.get("credential_lease", text(args.credential_lease_id, "credential_lease_id"));
    if (lease.status !== "active" || lease.task_id !== task.id || now >= Date.parse(String(lease.expires_at))) throw new Error("Enterprise Access requires an active same-task short-lived credential lease");
    const effect = text(args.effect, "effect"); if (!(binding.allowed_effects as string[]).includes(effect)) throw new Error("Enterprise ticket effect is not allowed by its Adapter binding");
    const approvalRef = args.approval_ref === undefined ? null : text(args.approval_ref, "approval_ref"); const consumptionId = args.autonomy_consumption_id === undefined ? null : text(args.autonomy_consumption_id, "autonomy_consumption_id");
    if (effect !== "read_only") {
      if (!approvalRef || !consumptionId) throw new Error("Enterprise write access requires approval and consumed autonomy authorization");
      const consumption = this.store.get("autonomy_consumption", consumptionId); if (consumption.task_id !== task.id || !["external_write", "destructive"].includes(String(consumption.action))) throw new Error("Enterprise autonomy consumption is not valid for this task or write effect");
    }
    const expires = Math.min(Date.parse(String(principal.expires_at)), Date.parse(String(lease.expires_at)));
    const identity = { binding_id: binding.id, binding_version: binding.version, principal_id: principal.id, principal_version: principal.version, task_id: task.id,
      credential_lease_id: lease.id, effect, request_digest: text(args.request_digest, "request_digest"), approval_ref: approvalRef, autonomy_consumption_id: consumptionId, expires_at: new Date(expires).toISOString() };
    const ticketId = text(args.ticket_id, "ticket_id"); const existing = this.store.find("enterprise_access_ticket", ticketId); const ticketDigest = digest(identity);
    if (existing) { if (existing.ticket_digest !== ticketDigest) throw new Error("Enterprise Access ticket idempotency conflict"); return { ticket: existing, idempotent: true }; }
    return { ticket: this.store.create("enterprise_access_ticket", ticketId, { ...identity, ticket_digest: ticketDigest, status: "issued", broker_instruction: { credential_lease_id: lease.id, target_host: binding.target_host } }), idempotent: false };
  }

  ticketConsume(args: JsonObject): JsonObject {
    const ticket = this.store.get("enterprise_access_ticket", text(args.ticket_id, "ticket_id")); const now = instant(args.now, "now");
    if (ticket.status === "consumed") return { ticket, idempotent: true };
    if (ticket.status !== "issued" || now >= Date.parse(String(ticket.expires_at))) throw new Error("Enterprise Access ticket is expired or no longer active");
    if (text(args.request_digest, "request_digest") !== ticket.request_digest) throw new Error("Enterprise Access ticket request digest mismatch");
    return { ticket: this.store.save("enterprise_access_ticket", String(ticket.id), { ...payload(ticket), status: "consumed", consumed_at: new Date(now).toISOString(), consumer_ref: text(args.consumer_ref, "consumer_ref") }), idempotent: false };
  }

  get(args: JsonObject): JsonObject { return { ticket: this.store.get("enterprise_access_ticket", text(args.ticket_id, "ticket_id")) }; }

  private verifiedProvider(id: string): JsonObject {
    const provider = this.store.get("enterprise_identity_provider", id);
    if (provider.lifecycle !== "verified") throw new Error("Enterprise identity provider is not verified");
    return provider;
  }
}
