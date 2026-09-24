import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { text } from "./validation.ts";
import { payload, stableDigest } from "./digest.ts";

/**
 * Authorization: the difference between "I saw this" and "I authorized this".
 *
 * Section 11.4 separates two acts that a single approval button tends to collapse. An audit
 * log records what happened; it does not record who let it happen. `attention.ts` already
 * stores `decided_by` and `decided_at`, but it records that a person *acknowledged a card* —
 * which is a fact about their attention, not a grant of permission for a side effect. Losing
 * the distinction produces the failure the plan cares about: an article of consent that was
 * never actually given, because the person read a summary and clicked.
 *
 * So this kernel keeps two records with different subjects:
 *
 *  - **acknowledge** is about a *card*. "I have seen this." It authorizes nothing, and after
 *    it the underlying effect still has no authorization.
 *  - **authorize** is about an *effect*. "I authorize this specific side effect to occur."
 *    It binds four facts — who, when, which effect, and *against which receipt digest* — and
 *    anything that later executes that effect re-derives the digest and refuses on mismatch.
 *
 * The binding is the whole point, and it is copied deliberately from `egress_authorization`
 * (`craft-service.ts:2073`), where an authorized request digest is recomputed before
 * execution and a mismatch is an error rather than a warning. An authorization that is not
 * checked against the thing being authorized is a signature on a blank page: it stays valid
 * while the payload underneath it changes.
 *
 * The threshold matters too. Below R2 the plan lets an action proceed silently or on a
 * lighter interaction, so requiring an authorization record there would be friction with no
 * safety return. At R2 and above the effect is irreversible or externally visible, and the
 * absence of an authorization is treated as a refusal rather than as permission by default.
 */

export type RiskLevel = "R0" | "R1" | "R2" | "R3";

/** Levels that require an explicit authorization before the effect may proceed. */
const AUTHORIZATION_REQUIRED: ReadonlySet<string> = new Set(["R2", "R3"]);
const RISK_LEVELS: ReadonlySet<string> = new Set(["R0", "R1", "R2", "R3"]);

const NAME = /^[a-zA-Z0-9_.:-]{1,200}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

function identifier(value: unknown, name: string): string {
  const result = text(value, name);
  if (!NAME.test(result)) throw new Error(`${name} contains unsupported characters`);
  return result;
}
function instant(value: unknown, name: string): string {
  const result = text(value, name);
  if (Number.isNaN(Date.parse(result))) throw new Error(`${name} must be an ISO timestamp`);
  return result;
}
function digest(value: unknown, name: string): string {
  const result = text(value, name);
  if (!DIGEST.test(result)) throw new Error(`${name} must be a sha256 digest`);
  return result;
}
function riskLevel(value: unknown): RiskLevel {
  const result = text(value, "risk_level");
  if (!RISK_LEVELS.has(result)) throw new Error("risk_level must be R0, R1, R2 or R3");
  return result as RiskLevel;
}

/**
 * The digest of the effect being authorized.
 *
 * Callers may supply the effect's own descriptor and let this kernel derive the digest, or
 * supply a digest they computed elsewhere. Deriving it here is preferred, because a digest
 * the caller both computes and verifies is not a check — the same circularity the action
 * gate avoids by computing recomputability itself.
 */
export function effectDigest(descriptor: unknown): string {
  if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new Error("effect must be an object");
  }
  return stableDigest(descriptor);
}

export class AuthorizationKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  /**
   * Record that a person saw a card. This authorizes nothing.
   *
   * Kept deliberately separate from `authorize` so that a later question — "who let this
   * happen" — cannot be answered with a row that only meant "who looked at it". The record
   * names its subject as a card so the two are never confused in a query.
   */
  acknowledge(args: JsonObject): JsonObject {
    const cardId = identifier(args.card_id, "card_id");
    const subject = "card";
    const identity = { subject, card_id: cardId, actor: identifier(args.actor, "actor") };
    const identityDigest = stableDigest(identity);
    const ackId = args.acknowledgement_id === undefined
      ? `acknowledgement_${identityDigest.slice("sha256:".length, "sha256:".length + 24)}`
      : identifier(args.acknowledgement_id, "acknowledgement_id");
    const existing = this.store.find("acknowledgement", ackId);
    if (existing) return { acknowledgement: existing, idempotent: true };
    return { acknowledgement: this.store.create("acknowledgement", ackId, { ...identity,
      acknowledged_at: instant(args.acknowledged_at, "acknowledged_at"),
      // Stated on the record rather than left to documentation, so a reader of the audit
      // trail cannot mistake this row for permission.
      authorizes_effect: false, identity_digest: identityDigest }), idempotent: false };
  }

  /**
   * Authorize one specific effect.
   *
   * All four binding facts are required and none is inferred. An approver taken from
   * context, or a digest filled in from the effect, would be a record of what the system
   * assumed rather than of what a person did.
   */
  authorize(args: JsonObject): JsonObject {
    const effectId = identifier(args.effect_id, "effect_id");
    const actor = identifier(args.actor, "actor");
    const authorizedAt = instant(args.authorized_at, "authorized_at");
    const boundDigest = args.receipt_digest === undefined
      ? effectDigest(args.effect)
      : digest(args.receipt_digest, "receipt_digest");
    const level = riskLevel(args.risk_level);
    const identityDigest = stableDigest({ effect_id: effectId, actor, receipt_digest: boundDigest, risk_level: level });
    const authorizationId = args.authorization_id === undefined
      ? `authorization_${identityDigest.slice("sha256:".length, "sha256:".length + 24)}`
      : identifier(args.authorization_id, "authorization_id");
    const existing = this.store.find("effect_authorization", authorizationId);
    if (existing) {
      // The same id with different content is a conflict. Overwriting would let a second
      // authorization silently replace the digest the first one was checked against.
      if (existing.identity_digest !== identityDigest) throw new Error("Effect authorization idempotency conflict");
      return { authorization: existing, idempotent: true };
    }
    return { authorization: this.store.create("effect_authorization", authorizationId, {
      effect_id: effectId, effect_kind: identifier(args.effect_kind, "effect_kind"),
      receipt_digest: boundDigest, risk_level: level, approved_by: actor, authorized_at: authorizedAt,
      // A reason is required above R1: at R2 and R3 the authorization is the artifact a
      // later review reads, and "because I clicked" is not a reviewable answer.
      decision_reason: text(args.decision_reason, "decision_reason"),
      status: "authorized", consumed_at: null, identity_digest: identityDigest,
      authorizes_effect: true, content_stored: false }), idempotent: false };
  }

  /**
   * Ask whether one effect may proceed.
   *
   * Returns `false` with a reason rather than throwing, because "not authorized yet" is the
   * normal state before a person approves, not an error. The three refusals are kept
   * distinct because they call for different responses: no record means ask someone, a
   * digest mismatch means the thing changed and must be shown again, and a consumed
   * authorization means it already happened.
   */
  check(args: JsonObject): JsonObject {
    const effectId = identifier(args.effect_id, "effect_id");
    const level = riskLevel(args.risk_level);
    const records = this.store.list("effect_authorization", 1_000, (item) => item.effect_id === effectId);
    if (!AUTHORIZATION_REQUIRED.has(level)) {
      return { authorized: true, effect_id: effectId, risk_level: level, reason: "below_authorization_threshold",
        required: false, authorization: null, authorized_by: null, authorized_at: null };
    }
    if (!records.length) {
      return { authorized: false, effect_id: effectId, risk_level: level, reason: "no_authorization_recorded",
        required: true, authorization: null, authorized_by: null, authorized_at: null };
    }
    const candidates = args.effect === undefined
      ? records
      : records.filter((item) => item.receipt_digest === effectDigest(args.effect));
    if (!candidates.length) {
      // An authorization exists but for different content. This is the case the binding
      // exists to catch: the person approved an earlier version of this effect.
      return { authorized: false, effect_id: effectId, risk_level: level, reason: "receipt_digest_mismatch",
        required: true, authorization: null, authorized_by: null, authorized_at: null };
    }
    const live = candidates.filter((item) => item.status === "authorized");
    if (!live.length) {
      return { authorized: false, effect_id: effectId, risk_level: level, reason: "authorization_already_consumed",
        required: true, authorization: null, authorized_by: null, authorized_at: null };
    }
    // The most recent live authorization wins when several exist, so a re-authorization
    // after a change supersedes the earlier one without deleting the audit trail.
    const chosen = live.sort((left, right) => String(right.authorized_at).localeCompare(String(left.authorized_at)))[0]!;
    return { authorized: true, effect_id: effectId, risk_level: level, reason: "authorized", required: true,
      authorization: chosen, authorized_by: chosen.approved_by, authorized_at: chosen.authorized_at };
  }

  /**
   * Mark an authorization as used.
   *
   * Consumption is recorded once and is idempotent, and a second consumption for a
   * different execution is refused: an authorization covers one effect occurrence, so
   * reusing it would let one signature stand behind an unbounded number of actions.
   */
  consume(args: JsonObject): JsonObject {
    const authorization = this.store.get("effect_authorization", identifier(args.authorization_id, "authorization_id"));
    const executionId = identifier(args.execution_id, "execution_id");
    if (authorization.status === "consumed") {
      if (authorization.execution_id !== executionId) {
        throw new Error("Effect authorization is already consumed by a different execution");
      }
      return { authorization, idempotent: true };
    }
    return { authorization: this.store.save("effect_authorization", String(authorization.id), { ...payload(authorization),
      status: "consumed", execution_id: executionId, consumed_at: instant(args.consumed_at, "consumed_at") }), idempotent: false };
  }

  /** Revoke an authorization that has not been consumed. */
  revoke(args: JsonObject): JsonObject {
    const authorization = this.store.get("effect_authorization", identifier(args.authorization_id, "authorization_id"));
    if (authorization.status === "consumed") throw new Error("A consumed authorization cannot be revoked");
    if (authorization.status === "revoked") return { authorization, revoked: false };
    return { authorization: this.store.save("effect_authorization", String(authorization.id), { ...payload(authorization),
      status: "revoked", revoked_by: identifier(args.revoked_by, "revoked_by"),
      revoked_at: instant(args.revoked_at, "revoked_at"),
      revocation_reason: text(args.revocation_reason, "revocation_reason") }), revoked: true };
  }

  get(args: JsonObject): JsonObject {
    return { authorization: this.store.get("effect_authorization", identifier(args.authorization_id, "authorization_id")) };
  }

  /** The authorization trail for one effect, newest first. */
  list(args: JsonObject): JsonObject {
    const effectId = identifier(args.effect_id, "effect_id");
    return { authorizations: this.store.list("effect_authorization", 1_000, (item) => item.effect_id === effectId)
      .sort((left, right) => String(right.authorized_at).localeCompare(String(left.authorized_at))) };
  }

  /**
   * Answer "who authorized this effect" for a review.
   *
   * Reports the acknowledgements separately and explicitly, so an audit cannot present "a
   * person saw the card" as though it were "a person authorized the effect" — which is the
   * single confusion section 11.4 exists to prevent.
   */
  trail(args: JsonObject): JsonObject {
    const effectId = identifier(args.effect_id, "effect_id");
    const authorizations = this.store.list("effect_authorization", 1_000, (item) => item.effect_id === effectId);
    const acknowledgements = args.card_id === undefined
      ? []
      : this.store.list("acknowledgement", 1_000, (item) => item.card_id === args.card_id);
    return { effect_id: effectId, authorizations,
      acknowledgements,
      // The count is what a reviewer reads first, and a non-zero acknowledgement count with
      // zero authorizations is the exact shape of "read but not authorized".
      authorization_count: authorizations.length,
      acknowledgement_count: acknowledgements.length,
      acknowledged_but_not_authorized: acknowledgements.length > 0 && authorizations.length === 0 };
  }
}
