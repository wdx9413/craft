import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { object, text } from "./validation.ts";
import { payload, stableDigest } from "./digest.ts";

/**
 * Subscription drift: keeping a long-lived authorization from becoming a blank cheque.
 *
 * Section 7 of the plan makes subscribing an authorization, not a convenience: once a
 * subscription exists, events act on the user's behalf while they are not present. Two
 * things can then go wrong, and they are easy to confuse because both look like "the
 * upstream changed":
 *
 *  1. **The structure moved** (7.2/7.3). The schema a subscription was written against is
 *     no longer the schema it will receive, so the authorization no longer covers what it
 *     will be used for. The subscription must stop and ask.
 *  2. **An event arrived twice** (7.4). The same event instance must not be acted on
 *     twice; that is a deduplication question with no bearing on authorization.
 *
 * Treating these as one thing produces the two failures section 7.4 names. Hashing an
 * event instance into the *fingerprint* makes every offset advance look like structural
 * drift, so the subscription suspends on its first event and never recovers. Using a
 * structural digest as the *dedup key* makes distinct events collapse into one, so real
 * events are dropped as duplicates.
 *
 * The boundary between them is therefore enforced by shape rather than by comment:
 * `structure` accepts only declared structural fields, and `event` accepts only declared
 * instance fields. A caller cannot pass an offset into the first or a schema digest into
 * the second, because the field is not accepted there.
 *
 * Drift suspends; it never revokes (7.4). Revocation is a human act (7.1) — the system's
 * job is to stop and ask, not to decide the authorization is gone.
 */

/** Fields that describe the upstream's *shape*. Values here change only when the structure does. */
const STRUCTURE_FIELDS = new Set(["cluster_id", "topic_name", "schema_digest", "partition_key_name", "payload_format"]);

/**
 * Fields that identify one *event instance*.
 *
 * `offset` is accepted only as a fallback for `event_id`, and the two are mutually
 * exclusive: an event that carries both must be identified by its id, because an offset
 * can be reused after a topic is recreated while an id cannot.
 */
const EVENT_FIELDS = new Set(["cluster_id", "topic_name", "event_id", "offset"]);

const DEFAULT_DORMANT_DAYS = 30;
const MAX_FIELD_LENGTH = 512;

export type SubscriptionState = "active" | "suspended" | "dormant";

function scalar(value: unknown, name: string): string {
  const result = text(value, name);
  if (result.length > MAX_FIELD_LENGTH) throw new Error(`${name} exceeds ${MAX_FIELD_LENGTH} characters`);
  return result;
}

function identifier(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^[a-zA-Z0-9_.:-]{1,200}$/u.test(result)) throw new Error(`${name} contains unsupported characters`);
  return result;
}

/**
 * Reduce an input object to the declared fields for one role.
 *
 * Returns the subset plus the names that were rejected, so a caller that passes the wrong
 * kind of value gets told which one rather than having it silently ignored — silently
 * ignoring an offset in a structure fingerprint is exactly the bug being prevented.
 */
function pick(value: unknown, name: string, allowed: ReadonlySet<string>): { fields: Record<string, string>; rejected: string[] } {
  const raw = object(value, name);
  const fields: Record<string, string> = {};
  const rejected: string[] = [];
  for (const [key, field] of Object.entries(raw)) {
    if (!allowed.has(key)) { rejected.push(key); continue; }
    fields[key] = scalar(field, `${name}.${key}`);
  }
  if (!Object.keys(fields).length) throw new Error(`${name} must declare at least one field`);
  return { fields, rejected };
}

/** The structural fields, rejecting anything that belongs to an event instance. */
export function structureFields(value: unknown, name = "structure"): Record<string, string> {
  const picked = pick(value, name, STRUCTURE_FIELDS);
  if (picked.rejected.length) {
    throw new Error(`${name} accepts only structural fields; rejected: ${picked.rejected.sort().join(", ")}`);
  }
  return picked.fields;
}

/**
 * The instance fields, rejecting anything structural.
 *
 * `event_id` and `offset` are mutually exclusive by design: if both are present the
 * caller has to say which one identifies the event, because accepting either would let the
 * same event produce two different keys depending on the call site.
 */
export function eventFields(value: unknown, name = "event"): Record<string, string> {
  const picked = pick(value, name, EVENT_FIELDS);
  if (picked.rejected.length) {
    throw new Error(`${name} accepts only event instance fields; rejected: ${picked.rejected.sort().join(", ")}`);
  }
  if (picked.fields.event_id !== undefined && picked.fields.offset !== undefined) {
    throw new Error(`${name} must identify the event by event_id or offset, not both`);
  }
  return picked.fields;
}

/** The upstream fingerprint: a digest over the structural fields only. */
export function upstreamFingerprint(value: unknown, name = "structure"): string {
  return stableDigest(structureFields(value, name));
}

/**
 * The dedup key: a digest over the instance fields only.
 *
 * Falls back to `offset` when no `event_id` is supplied, as section 7.4 specifies.
 */
export function dedupKey(value: unknown, name = "event"): string {
  return stableDigest(eventFields(value, name));
}

export class SubscriptionDriftKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  /**
   * Register the structure a subscription was authorized against.
   *
   * Both the fingerprint and the dedup key are stored, and they are stored separately.
   * Storing one derived value would lose the distinction the rest of this kernel needs.
   */
  register(args: JsonObject): JsonObject {
    const subscriptionId = identifier(args.subscription_id, "subscription_id");
    const structure = structureFields(args.structure);
    const fingerprint = stableDigest(structure);
    const now = text(args.now, "now");
    if (Number.isNaN(Date.parse(now))) throw new Error("now must be an ISO timestamp");
    const dormantDays = args.dormant_after_days === undefined ? DEFAULT_DORMANT_DAYS : Number(args.dormant_after_days);
    if (!Number.isInteger(dormantDays) || dormantDays < 1 || dormantDays > 365) throw new Error("dormant_after_days must be an integer between 1 and 365");
    const existing = this.store.find("subscription_drift", subscriptionId);
    const record = { subscription_id: subscriptionId, structure, upstream_fingerprint: fingerprint,
      dormant_after_days: dormantDays, state: "active", suspended_reason: null, last_event_at: null,
      events_seen: existing === null ? 0 : Number(existing.events_seen), registered_at: now };
    if (existing === null) return { subscription: this.store.create("subscription_drift", subscriptionId, record) };
    return { subscription: this.store.save("subscription_drift", subscriptionId, record) };
  }

  /**
   * Compare the current upstream structure against the authorized one (7.3).
   *
   * A difference suspends the subscription and records which fields moved. It does not
   * revoke: the plan is explicit that only a person revokes, and a system that revokes on
   * its own would silently cancel an authorization the user still wants.
   */
  checkDrift(args: JsonObject): JsonObject {
    const subscription = this.#subscription(identifier(args.subscription_id, "subscription_id"));
    const structure = structureFields(args.structure);
    const fingerprint = stableDigest(structure);
    const authorized = subscription.structure as Record<string, string>;
    const changed = [...new Set([...Object.keys(authorized), ...Object.keys(structure)])]
      .filter((field) => authorized[field] !== structure[field]).sort();
    if (fingerprint === String(subscription.upstream_fingerprint)) {
      return { subscription, drifted: false, changed_fields: [] };
    }
    // Suspension is recorded once and is idempotent: checking twice must not produce two
    // different states, and must not overwrite the reason the first check found.
    if (subscription.state === "active") {
      const suspended = this.store.save("subscription_drift", String(subscription.id), { ...payload(subscription),
        state: "suspended", suspended_reason: "upstream_structure_drift", changed_fields: changed });
      return { subscription: suspended, drifted: true, changed_fields: changed };
    }
    return { subscription, drifted: true, changed_fields: changed };
  }

  /**
   * Re-authorize a suspended subscription against a new structure.
   *
   * This is the human step section 7.4 describes as "stop and ask": the caller has
   * confirmed the new shape is acceptable, so the fingerprint is replaced and the
   * subscription resumes. A dormant subscription is resumed the same way — the difference
   * is only why it stopped.
   */
  reactivate(args: JsonObject): JsonObject {
    const subscription = this.#subscription(identifier(args.subscription_id, "subscription_id"));
    if (subscription.state === "active") return { subscription, reactivated: false };
    const structure = structureFields(args.structure);
    const now = text(args.now, "now");
    if (Number.isNaN(Date.parse(now))) throw new Error("now must be an ISO timestamp");
    const resumed = this.store.save("subscription_drift", String(subscription.id), { ...payload(subscription),
      structure, upstream_fingerprint: stableDigest(structure), state: "active", suspended_reason: null,
      changed_fields: [], reactivated_at: now });
    return { subscription: resumed, reactivated: true };
  }

  /**
   * Decide what to do with one incoming event.
   *
   * Drift is checked first: while the structure is in question the event must not be
   * dispatched, whatever its dedup status. Duplicates are then dropped without changing
   * the subscription's state, because a repeated event is not a reason to stop asking.
   */
  ingest(args: JsonObject): JsonObject {
    const subscription = this.#subscription(identifier(args.subscription_id, "subscription_id"));
    const key = dedupKey(args.event);
    const now = text(args.now, "now");
    const parsed = Date.parse(now);
    if (Number.isNaN(parsed)) throw new Error("now must be an ISO timestamp");

    if (subscription.state === "suspended") {
      return { subscription, dispatched: false, reason: "suspended_upstream_structure_drift", dedup_key: key, duplicate: false };
    }
    if (subscription.state === "dormant") {
      // Dormant is not self-clearing: the plan requires a person to re-activate it.
      return { subscription, dispatched: false, reason: "dormant_requires_reactivation", dedup_key: key, duplicate: false };
    }

    const seen = this.store.list("subscription_event", 10_000, (item) => item.subscription_id === subscription.id);
    if (seen.some((item) => item.dedup_key === key)) {
      // A duplicate is reported as such and changes nothing else: it is not an error, and
      // it must not reset the decay clock, or a repeated event would keep a stale
      // subscription alive forever.
      return { subscription, dispatched: false, reason: "duplicate_event", dedup_key: key, duplicate: true };
    }

    const event = this.store.create("subscription_event", `${subscription.id}_${key.slice(-24)}`, {
      subscription_id: subscription.id, dedup_key: key, observed_at: now });
    const updated = this.store.save("subscription_drift", String(subscription.id), { ...payload(subscription),
      last_event_at: now, events_seen: Number(subscription.events_seen) + 1 });
    return { subscription: updated, dispatched: true, reason: "dispatched", dedup_key: key, duplicate: false, event };
  }

  /**
   * Move subscriptions that have not fired for `dormant_after_days` into dormancy (7.2).
   *
   * Dormancy is the second half of the drift problem: a subscription whose upstream never
   * changed can still be stale because nobody has needed it for a month, and re-activating
   * it is a cheap confirmation that it is still wanted.
   */
  sweep(args: JsonObject): JsonObject {
    const now = text(args.now, "now");
    const at = Date.parse(now);
    if (Number.isNaN(at)) throw new Error("now must be an ISO timestamp");
    const dormant: string[] = [];
    for (const subscription of this.store.list("subscription_drift", 10_000, (item) => item.state === "active")) {
      // A subscription that has never fired ages from registration, not from "now": using
      // a null last_event_at as "just now" would keep a never-used subscription active
      // forever, which is the case dormancy most needs to catch.
      const since = Date.parse(String(subscription.last_event_at ?? subscription.registered_at));
      const ageDays = (at - since) / 86_400_000;
      if (ageDays < Number(subscription.dormant_after_days)) continue;
      this.store.save("subscription_drift", String(subscription.id), { ...payload(subscription),
        state: "dormant", suspended_reason: "no_activity_within_window", dormant_since: now });
      dormant.push(String(subscription.id));
    }
    return { dormant: dormant.sort(), count: dormant.length };
  }

  get(args: JsonObject): JsonObject {
    return { subscription: this.store.get("subscription_drift", identifier(args.subscription_id, "subscription_id")) };
  }

  list(args: JsonObject): JsonObject {
    // Named `subscription_state` rather than `state` because the tool-schema type lists are
    // global by parameter name, and `state` is already declared an object for tools that
    // pass a state record. Reusing the name would publish this string parameter as an object.
    const state = args.subscription_state === undefined ? null : text(args.subscription_state, "subscription_state");
    if (state !== null && !new Set<SubscriptionState>(["active", "suspended", "dormant"]).has(state as SubscriptionState)) {
      throw new Error("subscription_state is unsupported");
    }
    return { subscriptions: this.store.list("subscription_drift", 1_000, (item) => state === null || item.state === state) };
  }

  #subscription(subscriptionId: string): JsonObject {
    return this.store.get("subscription_drift", subscriptionId);
  }
}
