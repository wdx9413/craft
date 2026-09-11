import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

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
function integer(value: unknown, name: string, fallback: number, minimum: number, maximum: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return result;
}
function instant(value: unknown, name: string): number {
  const result = value === undefined ? Date.now() : Date.parse(text(value, name));
  if (Number.isNaN(result)) throw new Error(`${name} must be an ISO timestamp`);
  return result;
}
function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function payload(record: JsonObject): JsonObject {
  const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record;
  return rest;
}
function confirmedEvidence(store: CraftStore, ids: string[]): void {
  for (const id of ids) if (store.get("evidence", id).confidence !== "confirmed") throw new Error("A2A trust requires confirmed Evidence");
}

/**
 * Protocol-neutral remote collaboration lifecycle. Craft never contacts the
 * remote endpoint here: a trusted Host/Adapter transports the sealed envelope
 * and returns the observed receipt.
 */
export class A2ADelegationKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  trustApprove(args: JsonObject): JsonObject {
    const card = this.store.get("a2a_agent_card", text(args.card_id, "card_id")); const provider = this.store.get("enterprise_identity_provider", text(args.provider_id, "provider_id"));
    if (provider.lifecycle !== "verified") throw new Error("A2A trust requires a verified enterprise identity provider");
    const evidenceIds = strings(args.evidence_ids, "evidence_ids", 1); confirmedEvidence(this.store, evidenceIds);
    const allowedEffects = strings(args.allowed_effects, "allowed_effects", 1); if (allowedEffects.some((effect) => effect !== "read_only")) throw new Error("A2A trust is read-only until a separately certified remote effect adapter exists");
    const definition = { card_id: card.id, card_version: card.version, card_digest: card.card_digest, provider_id: provider.id, provider_version: provider.version, allowed_effects: allowedEffects, evidence_ids: evidenceIds };
    const trustId = text(args.trust_id, "trust_id"); const existing = this.store.find("a2a_agent_trust", trustId); const definitionDigest = digest(definition);
    if (existing) { if (existing.definition_digest !== definitionDigest) throw new Error("A2A Agent trust idempotency conflict"); return { trust: existing, idempotent: true }; }
    return { trust: this.store.create("a2a_agent_trust", trustId, { ...definition, definition_digest: definitionDigest, status: "active", explicit_approval_ref: text(args.approval_ref, "approval_ref") }), idempotent: false };
  }

  sessionCreate(args: JsonObject): JsonObject {
    const task = this.store.get("task", text(args.task_id, "task_id")); const trust = this.store.get("a2a_agent_trust", text(args.trust_id, "trust_id"));
    if (trust.status !== "active") throw new Error("A2A Agent trust is not active");
    const evaluation = this.store.get("delivery_evaluation_run", text(args.evaluation_run_id, "evaluation_run_id"));
    if (evaluation.status !== "eligible_for_signoff") throw new Error("A2A collaboration requires an eligible single-Agent evaluation baseline");
    const evidenceId = text(args.justification_evidence_id, "justification_evidence_id"); confirmedEvidence(this.store, [evidenceId]);
    const budget = object(args.budget, "budget"); const sessionIdentity = { task_id: task.id, trust_id: trust.id, trust_version: trust.version,
      evaluation_run_id: evaluation.id, evaluation_run_version: evaluation.version, justification_evidence_id: evidenceId, budget_digest: digest(budget), max_delegations: integer(args.max_delegations, "max_delegations", 5, 1, 5) };
    const sessionId = text(args.session_id, "session_id"); const existing = this.store.find("a2a_collaboration_session", sessionId); const sessionDigest = digest(sessionIdentity);
    if (existing) { if (existing.session_digest !== sessionDigest) throw new Error("A2A collaboration session idempotency conflict"); return { session: existing, idempotent: true }; }
    return { session: this.store.create("a2a_collaboration_session", sessionId, { ...sessionIdentity, session_digest: sessionDigest, budget, lifecycle: "active", delegated_count: 0, raw_context_stored: false }), idempotent: false };
  }

  delegationPrepare(args: JsonObject): JsonObject {
    const session = this.store.get("a2a_collaboration_session", text(args.session_id, "session_id")); if (session.lifecycle !== "active") throw new Error("A2A collaboration session is not active");
    const artifactIds = strings(args.artifact_ids ?? [], "artifact_ids", 0); const evidenceIds = strings(args.evidence_ids, "evidence_ids", 1);
    for (const id of artifactIds) this.store.get("artifact", id); confirmedEvidence(this.store, evidenceIds);
    const expiresAt = new Date(instant(args.now, "now") + integer(args.ttl_seconds, "ttl_seconds", 900, 60, 3_600) * 1_000).toISOString();
    // delegated_count advances after the first preparation.  Its record version
    // is operational state, not delegation intent, so retries bind to the
    // immutable session definition digest instead.
    const identity = { session_id: session.id, session_digest: session.session_digest, objective_digest: digest(text(args.objective, "objective")), artifact_ids: artifactIds, evidence_ids: evidenceIds, effect: "read_only", expires_at: expiresAt };
    const { expires_at: _expiresAt, ...intent } = identity;
    const delegationId = text(args.delegation_id, "delegation_id"); const existing = this.store.find("a2a_delegation", delegationId); const delegationDigest = digest(intent);
    if (existing) { if (existing.delegation_digest !== delegationDigest) throw new Error("A2A delegation idempotency conflict"); return { delegation: existing, idempotent: true }; }
    if (Number(session.delegated_count) >= Number(session.max_delegations)) throw new Error("A2A collaboration session reached its delegation limit");
    const delegation = this.store.create("a2a_delegation", delegationId, { ...identity, delegation_digest: delegationDigest, status: "prepared", transport_receipt_id: null, result_receipt_id: null });
    const updated = this.store.save("a2a_collaboration_session", String(session.id), { ...payload(session), delegated_count: Number(session.delegated_count) + 1 });
    return { session: updated, delegation, idempotent: false };
  }

  dispatch(args: JsonObject): JsonObject {
    const delegation = this.store.get("a2a_delegation", text(args.delegation_id, "delegation_id")); const now = instant(args.now, "now");
    if (delegation.status === "issued" || delegation.status === "completed") return { delegation, envelope: this.envelope(delegation), idempotent: true };
    if (delegation.status !== "prepared" || now >= Date.parse(String(delegation.expires_at))) throw new Error("A2A delegation is expired or not dispatchable");
    const receipt = this.store.get("evidence", text(args.transport_evidence_id, "transport_evidence_id")); if (receipt.confidence !== "confirmed") throw new Error("A2A transport dispatch requires confirmed Evidence");
    const issued = this.store.save("a2a_delegation", String(delegation.id), { ...payload(delegation), status: "issued", transport_receipt_id: receipt.id, issued_at: new Date(now).toISOString(), dispatched_by: text(args.dispatched_by, "dispatched_by") });
    return { delegation: issued, envelope: this.envelope(issued), idempotent: false };
  }

  report(args: JsonObject): JsonObject {
    const delegation = this.store.get("a2a_delegation", text(args.delegation_id, "delegation_id")); const verdict = text(args.verdict, "verdict");
    if (!new Set(["passed", "failed", "cancelled"]).has(verdict)) throw new Error("A2A delegation verdict is unsupported");
    if (delegation.status === "completed") {
      const receipt = this.store.get("a2a_delegation_receipt", String(delegation.result_receipt_id));
      if (args.receipt_id !== undefined && text(args.receipt_id, "receipt_id") !== receipt.id) throw new Error("A2A completed delegation receipt does not match");
      return { delegation, receipt, idempotent: true };
    }
    if (delegation.status !== "issued") throw new Error("A2A delegation has not been issued");
    const evidenceIds = strings(args.evidence_ids, "evidence_ids", 1); confirmedEvidence(this.store, evidenceIds);
    const result = object(args.result, "result"); if (Object.keys(result).some((key) => /(?:secret|token|cookie|password|authorization)/iu.test(key))) throw new Error("A2A result must not contain credential fields");
    const receiptIdentity = { delegation_id: delegation.id, verdict, evidence_ids: evidenceIds, result_digest: digest(result) };
    const receiptId = text(args.receipt_id, "receipt_id"); const receiptDigest = digest(receiptIdentity);
    const receipt = this.store.create("a2a_delegation_receipt", receiptId, { ...receiptIdentity, receipt_digest: receiptDigest, raw_result_stored: false });
    const completed = this.store.save("a2a_delegation", String(delegation.id), { ...payload(delegation), status: "completed", result_receipt_id: receipt.id, verdict, completed_at: new Date().toISOString() });
    return { delegation: completed, receipt, idempotent: false };
  }

  get(args: JsonObject): JsonObject {
    const delegation = this.store.get("a2a_delegation", text(args.delegation_id, "delegation_id"));
    return { delegation, receipt: delegation.result_receipt_id ? this.store.get("a2a_delegation_receipt", String(delegation.result_receipt_id)) : null };
  }

  private envelope(delegation: JsonObject): JsonObject {
    return { protocol: "a2a-governed-envelope/v1", delegation_id: delegation.id, effect: "read_only", objective_digest: delegation.objective_digest,
      artifact_ids: delegation.artifact_ids, evidence_ids: delegation.evidence_ids, expires_at: delegation.expires_at, raw_context_included: false };
  }
}
