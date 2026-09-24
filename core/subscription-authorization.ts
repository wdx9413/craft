import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { object, text } from "./validation.ts";
import { payload, stableDigest } from "./digest.ts";

/**
 * Subscription as authorization: the record that makes a long-lived power accountable.
 *
 * Section 7 opens with the distinction that shapes this kernel. Approving an action is
 * clear and one-off — "I approved this". Subscribing is different: from then on events act
 * while the person is absent. That is not a bigger button, it is a different kind of
 * commitment, and the plan is blunt about the risk it creates: a long-lived blank cheque.
 *
 * Five requirements follow (7.1), and each closes a specific way the blank cheque gets
 * cashed without anyone noticing:
 *
 *  1. **Every subscription is an explicit, time-boxed, revocable authorization.** Not a
 *     preference with a delete button — a record with a lifetime.
 *  2. **It declares its trigger, its allowed action scope, its maximum risk level and its
 *     expiry.** Missing any one of these means the authorization has no boundary, and an
 *     authorization without a boundary is indistinguishable from a general permission.
 *  3. **Its history is checkable** — how often it fired, what happened, what failed. A
 *     subscription you cannot audit is one you will not notice going wrong.
 *  4. **Expiry requires re-confirmation; it never renews itself.** A subscription that
 *     renews on its own never comes up for review, which is how a temporary authorization
 *     outlives the situation that justified it.
 *  5. **A subscription does not exempt the risk gate.** It says "this class of event may
 *     start work"; it does not say "this work may skip adjudication". The two are separate
 *     and the second is checked here on every dispatch.
 *
 * The division of labour with `subscription-drift` is deliberate. That kernel answers "has
 * the upstream structure moved", which is about the world changing. This one answers "is
 * this authorization still valid and does it cover this action", which is about the grant
 * itself. Merging them would make a drifted subscription and an expired one the same state,
 * and they need different responses: drift means look at the new shape, expiry means decide
 * whether you still want this at all.
 */

export type SubscriptionState = "active" | "suspended" | "expired" | "revoked";

const STATE_ORDER: Readonly<Record<string, number>> = { R0: 0, R1: 1, R2: 2, R3: 3 };
const RISK_LEVELS = new Set(["R0", "R1", "R2", "R3"]);

function identifier(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^[a-zA-Z0-9_.:\-]{1,200}$/u.test(result)) throw new Error(`${name} contains unsupported characters`);
  return result;
}
function instant(value: unknown, name: string): string {
  const result = text(value, name);
  if (Number.isNaN(Date.parse(result))) throw new Error(`${name} must be an ISO timestamp`);
  return result;
}
function riskLevel(value: unknown, name: string): string {
  const result = text(value, name);
  if (!RISK_LEVELS.has(result)) throw new Error(`${name} must be R0, R1, R2 or R3`);
  return result;
}
/** A scope is a set of action names; an empty set is not a scope, it is an open door. */
function actionScope(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.length) {
    throw new Error(`${name} must be a non-empty array; a subscription with no action scope authorizes everything`);
  }
  const actions = value.map((entry, index) => identifier(entry, `${name}[${index}]`));
  if (new Set(actions).size !== actions.length) throw new Error(`${name} must contain unique values`);
  return [...actions].sort();
}

export class SubscriptionAuthorizationKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  /**
   * Grant a subscription.
   *
   * Every boundary is required up front. A default expiry would be a policy decision made
   * by whoever wrote the default rather than by the person granting the power, and defaults
   * for "how long may this run unattended" are exactly the decision that should not be
   * made implicitly.
   */
  authorize(args: JsonObject): JsonObject {
    const subscriptionId = identifier(args.subscription_id, "subscription_id");
    const trigger = object(args.trigger, "trigger");
    // The trigger must say something. An empty object is a subscription to everything.
    if (!Object.keys(trigger).length) throw new Error("trigger must declare the condition that fires this subscription");
    const scope = actionScope(args.allowed_actions, "allowed_actions");
    const maxRisk = riskLevel(args.max_risk_level, "max_risk_level");
    const grantedAt = instant(args.granted_at, "granted_at");
    // An expiry is required, and it must be in the future. `instant` throws on a missing or
    // unparseable value, so this fails closed: a subscription cannot be created without a
    // deadline by omitting one.
    const expiresAt = instant(args.expires_at, "expires_at");
    if (Date.parse(expiresAt) <= Date.parse(grantedAt)) {
      throw new Error("expires_at must be later than granted_at; a subscription must have a lifetime");
    }
    const grantedBy = identifier(args.granted_by, "granted_by");
    const identityDigest = stableDigest({ subscription_id: subscriptionId, trigger, allowed_actions: scope,
      max_risk_level: maxRisk, expires_at: expiresAt, granted_by: grantedBy });
    const existing = this.store.find("subscription_authorization", subscriptionId);
    if (existing) {
      // Re-granting the same terms is idempotent; changing them is a new authorization and
      // must not silently replace the digest an earlier dispatch was checked against.
      if (existing.identity_digest !== identityDigest) {
        throw new Error("Subscription authorization conflict; revoke or re-confirm with the same terms");
      }
      return { authorization: existing, idempotent: true };
    }
    return { authorization: this.store.create("subscription_authorization", subscriptionId, {
      subscription_id: subscriptionId, trigger, allowed_actions: scope, max_risk_level: maxRisk,
      granted_by: grantedBy, granted_at: grantedAt, expires_at: expiresAt,
      state: "active", revoked_by: null, revoked_at: null, revocation_reason: null,
      reconfirmed_at: null, confirmations: 0, dispatches: 0, failures: 0, last_dispatch_at: null,
      identity_digest: identityDigest, content_stored: false }), idempotent: false };
  }

  /**
   * Whether this subscription may start work for an event.
   *
   * Returns a decision with a reason rather than throwing, because "expired" and "out of
   * scope" are normal answers the caller must display, not errors. The checks are ordered
   * so the most specific truth is reported: a revoked subscription is revoked even if it
   * also happens to be expired.
   */
  check(args: JsonObject): JsonObject {
    const subscription = this.store.get("subscription_authorization", identifier(args.subscription_id, "subscription_id"));
    const now = instant(args.now, "now");
    const nowMs = Date.parse(now);
    const action = identifier(args.action, "action");
    const risk = riskLevel(args.risk_level, "risk_level");
    const base = { subscription_id: String(subscription.id), action, risk_level: risk,
      allowed_actions: subscription.allowed_actions, max_risk_level: subscription.max_risk_level,
      expires_at: subscription.expires_at };

    if (subscription.state === "revoked") return { ...base, allowed: false, reason: "subscription_revoked", reauthorization_required: true };
    if (subscription.state === "suspended") return { ...base, allowed: false, reason: "subscription_suspended", reauthorization_required: true };
    // Expiry is evaluated against the clock rather than only the stored state, so a
    // subscription cannot keep working merely because nobody swept it.
    if (nowMs >= Date.parse(String(subscription.expires_at))) {
      // The state is recorded on first detection so the expiry is visible in listings
      // instead of being recomputed by every reader.
      if (subscription.state === "active") {
        this.store.save("subscription_authorization", String(subscription.id),
          { ...payload(subscription), state: "expired", expired_at: now });
      }
      return { ...base, allowed: false, reason: "subscription_expired", reauthorization_required: true };
    }
    if (!(subscription.allowed_actions as string[]).includes(action)) {
      // 7.1 rule 5 in its first half: the subscription covers a stated scope, and an action
      // outside it is not authorized by this record no matter how similar it looks.
      return { ...base, allowed: false, reason: "action_outside_subscription_scope", reauthorization_required: true };
    }
    if (STATE_ORDER[risk]! > STATE_ORDER[String(subscription.max_risk_level)]!) {
      // 7.1 rule 5 in its second half: the subscription caps the risk it may initiate. The
      // action gate still runs on the resulting work; this only refuses to *start* work the
      // subscription was never allowed to reach.
      return { ...base, allowed: false, reason: "risk_above_subscription_ceiling", reauthorization_required: true };
    }
    return { ...base, allowed: true, reason: "authorized", reauthorization_required: false,
      // The caller is reminded that permission to start is not permission to skip the gate.
      action_gate_still_applies: true };
  }

  /**
   * Re-confirm a subscription before or after expiry (7.1 rule 4).
   *
   * This is a person's act, not a sweep: the caller supplies a new expiry and a confirmer.
   * The count is kept so a subscription that has been waved through repeatedly is visible
   * as such — a number nobody looks at is not a control, but a number that exists can be.
   */
  reconfirm(args: JsonObject): JsonObject {
    const subscription = this.store.get("subscription_authorization", identifier(args.subscription_id, "subscription_id"));
    if (subscription.state === "revoked") throw new Error("A revoked subscription cannot be reconfirmed");
    const at = instant(args.reconfirmed_at, "reconfirmed_at");
    const expiresAt = instant(args.expires_at, "expires_at");
    if (Date.parse(expiresAt) <= Date.parse(at)) throw new Error("expires_at must be later than reconfirmed_at");
    return { authorization: this.store.save("subscription_authorization", String(subscription.id), {
      ...payload(subscription), state: "active", expires_at: expiresAt,
      reconfirmed_at: at, reconfirmed_by: identifier(args.reconfirmed_by, "reconfirmed_by"),
      confirmations: Number(subscription.confirmations) + 1,
      // The previous expiry is kept so the review can see how long the gap was, which is
      // the fact that tells you whether this subscription is actually being watched.
      previous_expires_at: subscription.expires_at, expired_at: null }) };
  }

  /**
   * Record one dispatch outcome.
   *
   * Failures are counted separately from dispatches because 7.1 rule 3 asks for both, and a
   * subscription that fires constantly while failing constantly is the shape that needs
   * attention.
   */
  recordDispatch(args: JsonObject): JsonObject {
    const subscription = this.store.get("subscription_authorization", identifier(args.subscription_id, "subscription_id"));
    const outcome = text(args.outcome, "outcome");
    if (!new Set(["dispatched", "failed", "refused"]).has(outcome)) throw new Error("outcome is unsupported");
    const at = instant(args.at, "at");
    this.store.create("subscription_dispatch", `${subscription.id}_${String(subscription.dispatches)}_${at}`,
      { subscription_id: String(subscription.id), outcome, action: identifier(args.action, "action"),
        risk_level: riskLevel(args.risk_level, "risk_level"), at,
        reason: args.reason === undefined ? null : text(args.reason, "reason") });
    return { authorization: this.store.save("subscription_authorization", String(subscription.id), {
      ...payload(subscription),
      // A refused dispatch is history but not a successful dispatch: counting it as one
      // would make a subscription look busier than the work it actually caused.
      dispatches: Number(subscription.dispatches) + (outcome === "dispatched" ? 1 : 0),
      failures: Number(subscription.failures) + (outcome === "failed" ? 1 : 0),
      last_dispatch_at: outcome === "dispatched" ? at : subscription.last_dispatch_at }) };
  }

  /** Revoke (7.1 rule 1: every subscription is revocable, explicitly). */
  revoke(args: JsonObject): JsonObject {
    const subscription = this.store.get("subscription_authorization", identifier(args.subscription_id, "subscription_id"));
    if (subscription.state === "revoked") return { authorization: subscription, revoked: false };
    return { authorization: this.store.save("subscription_authorization", String(subscription.id), {
      ...payload(subscription), state: "revoked", revoked_by: identifier(args.revoked_by, "revoked_by"),
      revoked_at: instant(args.revoked_at, "revoked_at"),
      revocation_reason: text(args.revocation_reason, "revocation_reason") }), revoked: true };
  }

  /**
   * The audit view (7.1 rule 3): what it may do, and what it has actually done.
   *
   * Returned as one object because the two halves are only meaningful together — a
   * permission without its history is how a subscription stays trusted after it has
   * stopped working.
   */
  audit(args: JsonObject): JsonObject {
    const subscription = this.store.get("subscription_authorization", identifier(args.subscription_id, "subscription_id"));
    const dispatches = this.store.list("subscription_dispatch", 1_000, (item) => item.subscription_id === String(subscription.id))
      .sort((left, right) => String(right.at).localeCompare(String(left.at)));
    const failures = dispatches.filter((item) => item.outcome === "failed");
    return { subscription, dispatches,
      summary: { dispatches: Number(subscription.dispatches), failures: Number(subscription.failures),
        refusals: dispatches.filter((item) => item.outcome === "refused").length,
        confirmations: Number(subscription.confirmations), total_recorded: dispatches.length,
        // Surfaced because a subscription that has never been re-confirmed is the one most
        // likely to be running past the situation that justified it.
        never_reconfirmed: Number(subscription.confirmations) === 0,
        last_outcome: dispatches.length ? String(dispatches[0]!.outcome) : null },
      refusals: dispatches.filter((item) => item.outcome === "refused").map((item) => ({ action: item.action,
        risk_level: item.risk_level, reason: item.reason, at: item.at })),
      failure_history: failures.map((item) => ({ action: item.action, risk_level: item.risk_level, at: item.at })) };
  }

  get(args: JsonObject): JsonObject {
    return { authorization: this.store.get("subscription_authorization", identifier(args.subscription_id, "subscription_id")) };
  }

  list(args: JsonObject = {}): JsonObject {
    const state = args.state === undefined ? null : text(args.state, "state");
    if (state !== null && !new Set<SubscriptionState>(["active", "suspended", "expired", "revoked"]).has(state as SubscriptionState)) {
      throw new Error("state is unsupported");
    }
    const now = args.now === undefined ? null : instant(args.now, "now");
    return { subscriptions: this.store.list("subscription_authorization", 1_000, (item) => state === null || item.state === state)
      // Expiry is reported per row so a listing cannot show a lapsed subscription as active
      // just because nothing has swept it yet.
      .map((item) => ({ ...item, expired: now === null ? null : Date.parse(now) >= Date.parse(String(item.expires_at)) })) };
  }

  /**
   * Move lapsed subscriptions into the expired state without a human.
   *
   * The plan forbids auto-renewal, not auto-expiry: noticing that a deadline passed is
   * bookkeeping, while extending it would be a decision.
   */
  sweep(args: JsonObject): JsonObject {
    const now = instant(args.now, "now");
    const nowMs = Date.parse(now);
    const expired: string[] = [];
    for (const subscription of this.store.list("subscription_authorization", 10_000, (item) => item.state === "active")) {
      if (nowMs < Date.parse(String(subscription.expires_at))) continue;
      this.store.save("subscription_authorization", String(subscription.id),
        { ...payload(subscription), state: "expired", expired_at: now });
      expired.push(String(subscription.id));
    }
    return { expired: expired.sort(), count: expired.length };
  }
}
