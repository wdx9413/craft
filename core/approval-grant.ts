import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { text } from "./validation.ts";
import { digestJson, payload } from "./digest.ts";

/**
 * Approval grants: a reusable, exact, time-bounded human approval.
 *
 * This is deliberately separate from `learned_approval` (the "learn not to ask"
 * streak rule). A learned rule generalizes a decision; a grant never does. It is
 * bound to one workspace, one action type, one exact parameter fingerprint, one
 * effect and one risk level, and it expires. A grant is evidence that a person
 * made a decision, not proof the action ran or that its result was accepted.
 */
export type ApprovalRisk = "R0" | "R1" | "R2" | "R3";

const RISKS = new Set<ApprovalRisk>(["R0", "R1", "R2", "R3"]);
const EFFECTS = new Set(["read_only", "local_write", "external_write", "destructive", "computer_use"]);
const MAX_REMEMBER_HOURS = 24;
const KIND = "approval_grant";

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}

function isoInstant(value: unknown, name: string): string {
  const raw = nonEmpty(value, name);
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) throw new Error(`${name} must be an ISO timestamp`);
  return new Date(parsed).toISOString();
}

export class ApprovalGrantKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  /** Create an exact approval grant. R3 is never rememberable; R2 is capped at 24 hours. */
  create(args: JsonObject, now = Date.now()): JsonObject {
    const workspaceId = nonEmpty(args.workspace_id, "workspace_id");
    this.store.get("workspace", workspaceId);
    const action = nonEmpty(args.action, "action");
    const fingerprint = nonEmpty(args.action_fingerprint, "action_fingerprint");
    const effect = nonEmpty(args.effect, "effect");
    if (!EFFECTS.has(effect)) throw new Error("approval grant effect is unsupported");
    const risk = nonEmpty(args.risk_level, "risk_level") as ApprovalRisk;
    if (!RISKS.has(risk)) throw new Error("approval grant risk_level is unsupported");
    if (risk === "R3") throw new Error("R3 actions can never be remembered");
    const policyVersion = nonEmpty(args.policy_version, "policy_version");
    const executorVersion = args.executor_template_version === undefined || args.executor_template_version === null
      ? null : nonEmpty(args.executor_template_version, "executor_template_version");
    const grantedBy = nonEmpty(args.granted_by, "granted_by");
    let expiresAt: string | null = null;
    if (args.expires_at !== undefined && args.expires_at !== null) {
      const raw = isoInstant(args.expires_at, "expires_at");
      const parsed = Date.parse(raw);
      if (parsed <= now) throw new Error("approval grant expires_at must be in the future");
      const cap = now + MAX_REMEMBER_HOURS * 60 * 60 * 1000;
      if (parsed > cap) throw new Error("approval grants may be remembered for at most 24 hours");
      expiresAt = raw;
    } else if (risk === "R2") {
      throw new Error("R2 approval grants require an explicit expires_at within 24 hours");
    }
    const identity = { workspace_id: workspaceId, action, action_fingerprint: fingerprint, effect, risk_level: risk,
      policy_version: policyVersion, executor_template_version: executorVersion, granted_by: grantedBy, expires_at: expiresAt };
    const identityDigest = digestJson(identity);
    const id = `approval_grant_${createHash("sha256").update(identityDigest).digest("hex").slice(0, 24)}`;
    const existing = this.store.find(KIND, id);
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("approval grant idempotency conflict");
      return { grant: existing, idempotent: true };
    }
    return { grant: this.store.create(KIND, id, { ...identity, identity_digest: identityDigest,
      status: "active", revoked_reason: null, execution_authority: false }), idempotent: false };
  }

  list(args: JsonObject = {}): JsonObject {
    const workspaceId = args.workspace_id === undefined ? null : nonEmpty(args.workspace_id, "workspace_id");
    const status = args.status === undefined ? null : nonEmpty(args.status, "status");
    const grants = this.store.list(KIND, 1_000, (item) =>
      (workspaceId === null || item.workspace_id === workspaceId) && (status === null || item.status === status));
    return { grants };
  }

  revoke(args: JsonObject, now = Date.now()): JsonObject {
    const grantId = nonEmpty(args.grant_id, "grant_id");
    const reason = args.reason === undefined ? "revoked_by_human" : nonEmpty(args.reason, "reason");
    // Revoking an authorization is itself a human decision: without a name on it
    // the record proves *that* it ended but not *who* ended it.
    const revokedBy = args.revoked_by === undefined ? null : nonEmpty(args.revoked_by, "revoked_by");
    return this.store.transaction(() => {
      const grant = this.store.get(KIND, grantId);
      if (grant.status !== "active") throw new Error("approval grant is not active");
      return { grant: this.store.save(KIND, grantId, { ...payload(grant), status: "revoked", revoked_reason: reason,
        revoked_at: new Date(now).toISOString(), ...(revokedBy === null ? {} : { revoked_by: revokedBy }) }) };
    });
  }

  /** Exact-match check: same workspace, action, fingerprint, effect, risk and policy, unexpired. */
  check(args: JsonObject, now = Date.now()): JsonObject {
    const workspaceId = nonEmpty(args.workspace_id, "workspace_id");
    const action = nonEmpty(args.action, "action");
    const fingerprint = nonEmpty(args.action_fingerprint, "action_fingerprint");
    const effect = nonEmpty(args.effect, "effect");
    const risk = nonEmpty(args.risk_level, "risk_level");
    const policyVersion = nonEmpty(args.policy_version, "policy_version");
    const candidates = this.store.list(KIND, 1_000, (item) => item.status === "active"
      && item.workspace_id === workspaceId && item.action === action && item.action_fingerprint === fingerprint
      && item.effect === effect && item.risk_level === risk && item.policy_version === policyVersion);
    for (const grant of candidates) {
      if (grant.expires_at === null || grant.expires_at === undefined) return { allowed: true, grant, reason: "exact_grant" };
      if (Date.parse(String(grant.expires_at)) > now) return { allowed: true, grant, reason: "exact_grant" };
    }
    return { allowed: false, grant: null, reason: candidates.length ? "expired" : "no_matching_grant" };
  }

  /** Mark active grants past their expiry as expired. Idempotent. */
  sweep(now = Date.now()): JsonObject {
    const expired = this.store.list(KIND, 1_000, (item) => item.status === "active"
      && item.expires_at !== null && item.expires_at !== undefined && Date.parse(String(item.expires_at)) <= now);
    this.store.transaction(() => {
      for (const grant of expired) this.store.save(KIND, String(grant.id), { ...payload(grant), status: "expired" });
    });
    return { expired: expired.length };
  }
}
