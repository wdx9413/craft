import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { dedupKey, eventFields, structureFields, SubscriptionDriftKernel, upstreamFingerprint } from "../core/subscription-drift.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "craft-drift-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { store, drift: new SubscriptionDriftKernel(store) };
}

const structure = { cluster_id: "eval3", topic_name: "cdc.orders", schema_digest: "sha256:abc" };
const event = { cluster_id: "eval3", topic_name: "cdc.orders", event_id: "evt-1" };
const now = "2030-01-01T00:00:00Z";

test("the fingerprint covers structure and the dedup key covers the event instance", async () => {
  // The whole point of section 7.4: advancing an offset must not change the fingerprint,
  // and a structural change must not change the dedup key for a given event.
  const a = upstreamFingerprint(structure);
  const b = upstreamFingerprint({ ...structure, schema_digest: "sha256:def" });
  assert.notEqual(a, b, "a structural change must move the fingerprint");
  // An offset is not a structural field, so it cannot be smuggled into the fingerprint.
  assert.throws(() => upstreamFingerprint({ ...structure, offset: "49012" }), /accepts only structural fields; rejected: offset/);
  assert.throws(() => upstreamFingerprint({ ...structure, last_processed_timestamp: "2030-01-01T00:00:00Z" }),
    /rejected: last_processed_timestamp/);

  const key = dedupKey(event);
  assert.notEqual(key, dedupKey({ ...event, event_id: "evt-2" }));
  // A schema digest belongs to the structure, so it cannot be part of an event identity.
  assert.throws(() => dedupKey({ ...event, schema_digest: "sha256:abc" }), /accepts only event instance fields; rejected: schema_digest/);
  // `offset` is accepted only as the fallback identity.
  assert.equal(dedupKey({ cluster_id: "eval3", topic_name: "cdc.orders", offset: "49012" }),
    dedupKey({ cluster_id: "eval3", topic_name: "cdc.orders", offset: "49012" }));
  assert.throws(() => dedupKey({ ...event, offset: "49012" }), /by event_id or offset, not both/);

  // Field subsets still work and are validated.
  assert.deepEqual(structureFields(structure), structure);
  assert.deepEqual(eventFields(event), event);
  assert.throws(() => structureFields({}), /at least one field/);
  assert.throws(() => structureFields({ cluster_id: 7 }), /cluster_id must not be empty/);
  assert.throws(() => structureFields({ cluster_id: "x".repeat(600) }), /exceeds 512 characters/);
});

test("a structural change suspends the subscription, and drift is idempotent", async () => {
  const f = await fixture();
  try {
    const registered = f.drift.register({ subscription_id: "sub1", structure, now });
    assert.equal((registered.subscription as Record<string, unknown>).state, "active");

    const clean = f.drift.checkDrift({ subscription_id: "sub1", structure });
    assert.equal(clean.drifted, false);
    assert.deepEqual(clean.changed_fields, []);

    // The schema moved. Suspension records which fields moved so the operator can see why.
    const drifted = f.drift.checkDrift({ subscription_id: "sub1", structure: { ...structure, schema_digest: "sha256:def" } });
    assert.equal(drifted.drifted, true);
    assert.deepEqual(drifted.changed_fields, ["schema_digest"]);
    assert.equal((drifted.subscription as Record<string, unknown>).state, "suspended");
    assert.equal((drifted.subscription as Record<string, unknown>).suspended_reason, "upstream_structure_drift");

    // Checking again keeps the first reason rather than rewriting it, and does not revoke:
    // only a person revokes (7.1).
    const again = f.drift.checkDrift({ subscription_id: "sub1", structure: { ...structure, schema_digest: "sha256:xyz" } });
    assert.equal((again.subscription as Record<string, unknown>).state, "suspended");
    assert.equal((again.subscription as Record<string, unknown>).suspended_reason, "upstream_structure_drift");

    // Suspension does not rewrite the authorized structure, so a later check compares
    // against the original: only the newly added field differs from what was authorized.
    const added = f.drift.checkDrift({ subscription_id: "sub1", structure: { ...structure, payload_format: "avro" } });
    assert.deepEqual(added.changed_fields, ["payload_format"]);
    assert.equal((added.subscription as Record<string, unknown>).state, "suspended");
  } finally { f.store.close(); }
});

test("a suspended subscription does not dispatch, and reactivation resumes it", async () => {
  const f = await fixture();
  try {
    f.drift.register({ subscription_id: "sub1", structure, now });
    assert.equal(f.drift.ingest({ subscription_id: "sub1", event, now }).dispatched, true);

    f.drift.checkDrift({ subscription_id: "sub1", structure: { ...structure, schema_digest: "sha256:def" } });
    const blocked = f.drift.ingest({ subscription_id: "sub1", event: { ...event, event_id: "evt-2" }, now });
    assert.equal(blocked.dispatched, false);
    assert.equal(blocked.reason, "suspended_upstream_structure_drift");

    // A person confirms the new shape; the subscription resumes and dispatches again.
    const resumed = f.drift.reactivate({ subscription_id: "sub1", structure: { ...structure, schema_digest: "sha256:def" }, now });
    assert.equal(resumed.reactivated, true);
    assert.equal((resumed.subscription as Record<string, unknown>).state, "active");
    assert.equal(f.drift.ingest({ subscription_id: "sub1", event: { ...event, event_id: "evt-3" }, now }).dispatched, true);

    // Reactivating an active subscription is a no-op, not an error.
    assert.equal(f.drift.reactivate({ subscription_id: "sub1", structure, now }).reactivated, false);

    // The timestamp is validated on the resume path too: a dormant or suspended
    // subscription must not be resumed with an unparseable clock reading.
    f.drift.register({ subscription_id: "sub3", structure, now, dormant_after_days: 1 });
    f.drift.sweep({ now: "2030-03-01T00:00:00Z" });
    assert.throws(() => f.drift.reactivate({ subscription_id: "sub3", structure, now: "not-a-date" }), /must be an ISO timestamp/);
  } finally { f.store.close(); }
});

test("a repeated event is deduplicated without suspending or resetting the decay clock", async () => {
  const f = await fixture();
  try {
    f.drift.register({ subscription_id: "sub1", structure, now, dormant_after_days: 30 });
    const first = f.drift.ingest({ subscription_id: "sub1", event, now });
    assert.equal(first.dispatched, true);
    assert.equal(first.duplicate, false);

    const repeat = f.drift.ingest({ subscription_id: "sub1", event, now: "2030-02-01T00:00:00Z" });
    assert.equal(repeat.dispatched, false);
    assert.equal(repeat.duplicate, true);
    assert.equal(repeat.reason, "duplicate_event");
    // A duplicate is not drift, so it must not suspend anything.
    assert.equal((repeat.subscription as Record<string, unknown>).state, "active");
    // And it must not count as activity, or a repeated event would keep a stale
    // subscription alive forever.
    assert.equal(Number((repeat.subscription as Record<string, unknown>).events_seen), 1);

    // A different event in the same subscription does dispatch.
    assert.equal(f.drift.ingest({ subscription_id: "sub1", event: { ...event, event_id: "evt-2" }, now }).dispatched, true);
  } finally { f.store.close(); }
});

test("a subscription with no activity becomes dormant and needs a person to resume", async () => {
  const f = await fixture();
  try {
    f.drift.register({ subscription_id: "idle", structure, now, dormant_after_days: 30 });
    f.drift.register({ subscription_id: "busy", structure, now, dormant_after_days: 30 });
    f.drift.ingest({ subscription_id: "busy", event, now: "2030-01-25T00:00:00Z" });

    const swept = f.drift.sweep({ now: "2030-02-20T00:00:00Z" });
    assert.deepEqual(swept.dormant, ["idle"]);
    assert.equal(swept.count, 1);
    // The busy one fired 26 days ago, inside its window.
    assert.equal((f.drift.get({ subscription_id: "busy" }).subscription as Record<string, unknown>).state, "active");

    // Dormant is not self-clearing: it must be reactivated by a person.
    const blocked = f.drift.ingest({ subscription_id: "idle", event, now: "2030-02-21T00:00:00Z" });
    assert.equal(blocked.dispatched, false);
    assert.equal(blocked.reason, "dormant_requires_reactivation");
    const resumed = f.drift.reactivate({ subscription_id: "idle", structure, now: "2030-02-21T00:00:00Z" });
    assert.equal(resumed.reactivated, true);
    assert.equal(f.drift.ingest({ subscription_id: "idle", event, now: "2030-02-21T00:00:00Z" }).dispatched, true);

    // A subscription that never fired ages from registration, so a never-used one is
    // caught rather than staying active forever.
    f.drift.register({ subscription_id: "never", structure, now, dormant_after_days: 1 });
    assert.deepEqual(f.drift.sweep({ now: "2030-01-03T00:00:00Z" }).dormant, ["never"]);
  } finally { f.store.close(); }
});

test("registration is versioned, listing filters by state, and malformed input is refused by name", async () => {
  const f = await fixture();
  try {
    f.drift.register({ subscription_id: "sub1", structure, now });
    // Re-registering replaces the authorized structure and clears any suspension.
    f.drift.checkDrift({ subscription_id: "sub1", structure: { ...structure, schema_digest: "sha256:def" } });
    const re = f.drift.register({ subscription_id: "sub1", structure: { ...structure, schema_digest: "sha256:def" }, now });
    assert.equal((re.subscription as Record<string, unknown>).state, "active");

    f.drift.register({ subscription_id: "sub2", structure, now, dormant_after_days: 5 });
    assert.equal((f.drift.list({}).subscriptions as unknown[]).length, 2);
    assert.equal((f.drift.list({ subscription_state: "active" }).subscriptions as unknown[]).length, 2);
    assert.deepEqual(f.drift.list({ subscription_state: "suspended" }).subscriptions, []);
    assert.throws(() => f.drift.list({ subscription_state: "bogus" }), /subscription_state is unsupported/);

    assert.throws(() => f.drift.register({ subscription_id: "bad id!", structure, now }), /unsupported characters/);
    assert.throws(() => f.drift.register({ subscription_id: "s", structure, now: "not-a-date" }), /must be an ISO timestamp/);
    assert.throws(() => f.drift.register({ subscription_id: "s", structure, now, dormant_after_days: 0 }), /between 1 and 365/);
    assert.throws(() => f.drift.register({ subscription_id: "s", structure, now, dormant_after_days: 1.5 }), /between 1 and 365/);
    assert.throws(() => f.drift.get({ subscription_id: "missing" }), /Unknown subscription_drift/);
    assert.throws(() => f.drift.checkDrift({ subscription_id: "missing", structure }), /Unknown subscription_drift/);
    assert.throws(() => f.drift.ingest({ subscription_id: "sub1", event, now: "nope" }), /must be an ISO timestamp/);
    assert.throws(() => f.drift.sweep({ now: "nope" }), /must be an ISO timestamp/);
    assert.throws(() => f.drift.reactivate({ subscription_id: "missing", structure, now }), /Unknown subscription_drift/);
  } finally { f.store.close(); }
});
