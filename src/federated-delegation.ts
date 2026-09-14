import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

const TERMINAL = new Set(["completed", "failed", "cancelled", "indeterminate", "revoked"]);
const REMOTE_STATES = new Set(["accepted", "working", "completed", "failed", "cancelled", "indeterminate"]);

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}
function strings(value: unknown, name: string, minimum = 0): string[] {
  if (!Array.isArray(value) || value.length < minimum) throw new Error(`${name} must contain at least ${minimum} values`);
  const result = value.map((item) => text(item, name));
  if (new Set(result).size !== result.length) throw new Error(`${name} must contain unique values`);
  return result.sort();
}
function instant(value: unknown, name: string): number {
  const result = value === undefined ? Date.now() : Date.parse(text(value, name));
  if (Number.isNaN(result)) throw new Error(`${name} must be an ISO timestamp`);
  return result;
}
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function payload(record: JsonObject): JsonObject {
  const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record;
  return rest;
}
function confirmedEvidence(store: CraftStore, ids: string[]): void {
  for (const id of ids) if (store.get("evidence", id).confidence !== "confirmed") throw new Error("Federated delegation requires confirmed Evidence");
}
function taskId(run: JsonObject): string {
  const launch = run.launch_identity;
  if (!launch || typeof launch !== "object" || Array.isArray(launch)) throw new Error("Task Run has no launch identity");
  return text((launch as JsonObject).task_id, "Task Run task_id");
}

/**
 * One deep, protocol-neutral control module for an optional remote Agent.
 * It issues the only consumable authority and accepts only content-free,
 * environment-bound remote receipts. A Host/Adapter owns HTTP, callbacks and
 * credentials; this module owns the durable authorization facts.
 */
export class FederatedDelegationKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  healthRecord(args: JsonObject): JsonObject {
    const card = this.store.get("a2a_agent_card", text(args.card_id, "card_id"));
    const status = text(args.status, "status");
    if (!new Set(["healthy", "degraded", "unhealthy"]).has(status)) throw new Error("Remote Agent health status is unsupported");
    if (text(args.card_digest, "card_digest") !== card.card_digest) throw new Error("Remote Agent health does not match the current Agent Card");
    const evidenceIds = strings(args.evidence_ids, "evidence_ids", 1); confirmedEvidence(this.store, evidenceIds);
    const id = String(args.health_id ?? `federated_agent_health_${card.id}`);
    const value = { card_id: card.id, card_version: card.version, card_digest: card.card_digest, status, evidence_ids: evidenceIds, observed_by: text(args.observed_by, "observed_by"), health_digest: digest({ card_id: card.id, card_version: card.version, card_digest: card.card_digest, status, evidence_ids: evidenceIds }) };
    const existing = this.store.find("federated_agent_health", id);
    if (existing?.health_digest === value.health_digest) return { health: existing, idempotent: true };
    return { health: existing ? this.store.save("federated_agent_health", id, { ...value }) : this.store.create("federated_agent_health", id, value), idempotent: false };
  }

  issue(args: JsonObject): JsonObject {
    const delegation = this.store.get("a2a_delegation", text(args.delegation_id, "delegation_id"));
    if (delegation.status !== "prepared" && delegation.status !== "issued") throw new Error("Federated Grant requires a prepared or issued delegation");
    const session = this.store.get("a2a_collaboration_session", String(delegation.session_id));
    if (session.lifecycle !== "active") throw new Error("Federated Grant session is not active");
    const trust = this.store.get("a2a_agent_trust", String(session.trust_id));
    const card = this.store.get("a2a_agent_card", String(trust.card_id), Number(trust.card_version));
    const currentCard = this.store.get("a2a_agent_card", String(trust.card_id));
    if (trust.status !== "active" || card.card_digest !== trust.card_digest || currentCard.version !== card.version || currentCard.card_digest !== card.card_digest) throw new Error("Federated Grant trust is stale or revoked");
    this.healthy(card);
    const run = this.store.get("task_run", text(args.parent_task_run_id, "parent_task_run_id"));
    if (taskId(run) !== session.task_id) throw new Error("Federated Grant parent Task Run belongs to another task");
    const capabilityIds = strings(args.capability_ids ?? [], "capability_ids");
    const advertised = Array.isArray(card.skills) ? card.skills.map((item) => String(item)) : [];
    if (capabilityIds.some((id) => !advertised.includes(id))) throw new Error("Federated Grant capability is not advertised by the Agent Card");
    const artifactIds = strings(args.artifact_ids ?? delegation.artifact_ids, "artifact_ids");
    const delegatedArtifacts = strings(delegation.artifact_ids ?? [], "delegation artifact_ids");
    if (JSON.stringify(artifactIds) !== JSON.stringify(delegatedArtifacts)) throw new Error("Federated Grant cannot widen delegation Artifact scope");
    const artifacts = artifactIds.map((id) => this.store.get("artifact", id));
    const identity = { delegation_id: delegation.id, delegation_digest: delegation.delegation_digest, session_id: session.id, session_digest: session.session_digest, trust_id: trust.id, trust_version: trust.version, card_id: card.id, card_version: card.version, card_digest: card.card_digest, parent_task_run_id: run.id, parent_task_run_version: run.version, parent_operation_ref: text(args.parent_operation_ref, "parent_operation_ref"), audience: text(args.audience, "audience"), capability_ids: capabilityIds, artifact_ids: artifactIds, effect: "read_only", expires_at: delegation.expires_at };
    const grantId = text(args.grant_id, "grant_id"); const grantDigest = digest(identity); const existing = this.store.find("federated_delegation_grant", grantId);
    if (existing) { if (existing.grant_digest !== grantDigest) throw new Error("Federated Grant idempotency conflict"); return { grant: existing, artifact_grants: this.artifactGrants(String(existing.id)), idempotent: true }; }
    const grant = this.store.create("federated_delegation_grant", grantId, { ...identity, grant_digest: grantDigest, status: "active", raw_context_stored: false, issued_by: text(args.issued_by, "issued_by") });
    const artifactGrants = artifacts.map((artifact) => this.store.create("federated_artifact_grant", `${grant.id}:${artifact.id}`, { grant_id: grant.id, artifact_id: artifact.id, artifact_version: artifact.version, artifact_digest: digest({ id: artifact.id, version: artifact.version, uri: artifact.uri ?? null }), effect: "read_only", expires_at: grant.expires_at, status: "active", raw_content_stored: false }));
    return { grant, artifact_grants: artifactGrants, idempotent: false };
  }

  consume(args: JsonObject): JsonObject {
    const grant = this.store.get("federated_delegation_grant", text(args.grant_id, "grant_id")); const now = instant(args.now, "now");
    if (grant.status === "consumed") return { grant, artifact_grants: this.artifactGrants(String(grant.id)), idempotent: true };
    if (grant.status !== "active" || now >= Date.parse(String(grant.expires_at))) throw new Error("Federated Grant is expired or inactive");
    if (text(args.audience, "audience") !== grant.audience) throw new Error("Federated Grant audience does not match");
    const card = this.store.get("a2a_agent_card", String(grant.card_id), Number(grant.card_version));
    const currentCard = this.store.get("a2a_agent_card", String(grant.card_id));
    if (card.card_digest !== grant.card_digest || currentCard.version !== card.version || currentCard.card_digest !== card.card_digest) throw new Error("Federated Grant Agent Card drifted"); this.healthy(card);
    const saved = this.store.save("federated_delegation_grant", String(grant.id), { ...payload(grant), status: "consumed", consumed_at: new Date(now).toISOString(), consumer_ref: text(args.consumer_ref, "consumer_ref") });
    return { grant: saved, artifact_grants: this.artifactGrants(String(saved.id)), idempotent: false };
  }

  receiptRecord(args: JsonObject): JsonObject {
    const grant = this.store.get("federated_delegation_grant", text(args.grant_id, "grant_id"));
    const delegation = this.store.get("a2a_delegation", String(grant.delegation_id));
    const run = this.store.get("task_run", String(grant.parent_task_run_id), Number(grant.parent_task_run_version));
    if (text(args.environment_digest, "environment_digest") !== run.environment_digest || text(args.effect, "effect") !== "read_only") throw new Error("Remote receipt environment or effect does not match the Grant");
    const state = text(args.state, "state"); if (!REMOTE_STATES.has(state)) throw new Error("Remote receipt state is unsupported");
    const evidenceIds = strings(args.evidence_ids, "evidence_ids", 1); confirmedEvidence(this.store, evidenceIds);
    const artifactGrantIds = strings(args.artifact_grant_ids ?? [], "artifact_grant_ids"); const expected = this.artifactGrants(String(grant.id)).map((item) => String(item.id)).sort();
    if (JSON.stringify(artifactGrantIds) !== JSON.stringify(expected)) throw new Error("Remote receipt Artifact grants do not match the Grant");
    const identity = { grant_id: grant.id, grant_digest: grant.grant_digest, delegation_id: delegation.id, state, environment_digest: run.environment_digest, effect: "read_only", artifact_grant_ids: artifactGrantIds, evidence_ids: evidenceIds, result_digest: text(args.result_digest, "result_digest") };
    const receiptId = text(args.receipt_id, "receipt_id"); const receiptDigest = digest(identity); const existing = this.store.find("federated_remote_receipt", receiptId);
    if (existing) { if (existing.receipt_digest !== receiptDigest) throw new Error("Federated remote receipt idempotency conflict"); return { receipt: existing, grant, idempotent: true }; }
    if (grant.status !== "consumed") throw new Error("Remote receipt requires a consumed Federated Grant");
    if (delegation.status !== "issued") throw new Error("Remote receipt requires an issued A2A delegation");
    const receipt = this.store.create("federated_remote_receipt", receiptId, { ...identity, receipt_digest: receiptDigest, raw_result_stored: false });
    const saved = TERMINAL.has(state) ? this.store.save("federated_delegation_grant", String(grant.id), { ...payload(grant), status: state, terminal_receipt_id: receipt.id }) : grant;
    return { receipt, grant: saved, idempotent: false };
  }

  revoke(args: JsonObject): JsonObject {
    const grant = this.store.get("federated_delegation_grant", text(args.grant_id, "grant_id"));
    if (grant.status === "revoked") return { grant, artifact_grants: this.artifactGrants(String(grant.id)), idempotent: true };
    if (TERMINAL.has(String(grant.status))) throw new Error("Terminal Federated Grant cannot be revoked");
    const evidenceIds = strings(args.evidence_ids, "evidence_ids", 1); confirmedEvidence(this.store, evidenceIds);
    const saved = this.store.save("federated_delegation_grant", String(grant.id), { ...payload(grant), status: "revoked", revocation_reason: text(args.reason, "reason"), revocation_evidence_ids: evidenceIds });
    const artifactGrants = this.artifactGrants(String(grant.id)).map((artifact) => artifact.status === "revoked" ? artifact : this.store.save("federated_artifact_grant", String(artifact.id), { ...payload(artifact), status: "revoked" }));
    return { grant: saved, artifact_grants: artifactGrants, idempotent: false };
  }

  reconcile(args: JsonObject): JsonObject {
    const grant = this.store.get("federated_delegation_grant", text(args.grant_id, "grant_id")); const now = instant(args.now, "now");
    if (TERMINAL.has(String(grant.status))) return { grant, incident: null, idempotent: true };
    if (now < Date.parse(String(grant.expires_at))) return { grant, incident: null, idempotent: true };
    const incidentId = `federated_remote_incident_${grant.id}`; const existing = this.store.find("federated_remote_incident", incidentId);
    const incident = existing ?? this.store.create("federated_remote_incident", incidentId, { grant_id: grant.id, state: "indeterminate", detected_at: new Date(now).toISOString(), required_next_action: "adapter_poll_or_human_review", raw_remote_content_stored: false });
    const saved = this.store.save("federated_delegation_grant", String(grant.id), { ...payload(grant), status: "indeterminate", incident_id: incident.id });
    return { grant: saved, incident, idempotent: false };
  }

  get(args: JsonObject): JsonObject {
    const grant = this.store.get("federated_delegation_grant", text(args.grant_id, "grant_id"));
    return { grant, artifact_grants: this.artifactGrants(String(grant.id)), receipts: this.store.list("federated_remote_receipt", 1000, (item) => item.grant_id === grant.id), incident: this.store.find("federated_remote_incident", `federated_remote_incident_${grant.id}`) };
  }

  private artifactGrants(grantId: string): JsonObject[] {
    // CraftStore already orders the latest immutable records by update time and id.
    return this.store.list("federated_artifact_grant", 1000, (item) => item.grant_id === grantId);
  }
  private healthy(card: JsonObject): void {
    const health = this.store.find("federated_agent_health", `federated_agent_health_${card.id}`);
    if (!health || health.status !== "healthy" || health.card_version !== card.version || health.card_digest !== card.card_digest) throw new Error("Remote Agent health is missing, stale, or unhealthy");
  }
}
