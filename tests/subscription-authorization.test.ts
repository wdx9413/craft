import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { SubscriptionAuthorizationKernel } from "../core/subscription-authorization.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "craft-subauth-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { store, subs: new SubscriptionAuthorizationKernel(store) };
}

const grant = (subs: SubscriptionAuthorizationKernel, over: Record<string, unknown> = {}) => subs.authorize({
  subscription_id: "sub1", trigger: { topic: "cdc.orders" }, allowed_actions: ["reconcile_offset"],
  max_risk_level: "R1", granted_at: "2030-01-01T00:00:00Z", expires_at: "2030-02-01T00:00:00Z",
  granted_by: "u1", ...over });

test("a subscription declares its trigger, scope, ceiling and expiry", async () => {
  const f = await fixture();
  try {
    const record = (grant(f.subs).authorization) as Record<string, unknown>;
    assert.deepEqual(record.trigger, { topic: "cdc.orders" });
    assert.deepEqual(record.allowed_actions, ["reconcile_offset"]);
    assert.equal(record.max_risk_level, "R1");
    assert.equal(record.expires_at, "2030-02-01T00:00:00Z");
    assert.equal(record.granted_by, "u1");
    assert.equal(record.state, "active");
    // It starts with no history, so "has this ever fired" is answerable from the record.
    assert.equal(record.dispatches, 0);
    assert.equal(record.failures, 0);
    assert.equal(record.confirmations, 0);
    assert.equal(record.content_stored, false);

    // Re-granting identical terms is idempotent; different terms are a conflict, because
    // silently replacing them would swap the boundaries a dispatch was checked against.
    assert.equal(grant(f.subs).idempotent, true);
    assert.throws(() => grant(f.subs, { max_risk_level: "R3" }), /Subscription authorization conflict/);
  } finally { f.store.close(); }
});

test("every declared boundary is mandatory, and an open scope is refused", async () => {
  const f = await fixture();
  try {
    // 7.1 rule 2: missing any boundary leaves the authorization unbounded.
    assert.throws(() => grant(f.subs, { trigger: {} }), /trigger must declare the condition/);
    assert.throws(() => grant(f.subs, { allowed_actions: [] }), /must be a non-empty array; a subscription with no action scope authorizes everything/);
    assert.throws(() => grant(f.subs, { allowed_actions: "not-an-array" }), /must be a non-empty array/);
    assert.throws(() => grant(f.subs, { allowed_actions: ["a", "a"] }), /must contain unique values/);
    assert.throws(() => grant(f.subs, { allowed_actions: ["bad action!"] }), /unsupported characters/);
    assert.throws(() => grant(f.subs, { max_risk_level: "R9" }), /must be R0, R1, R2 or R3/);
    assert.throws(() => grant(f.subs, { granted_by: "bad id!" }), /unsupported characters/);
    assert.throws(() => grant(f.subs, { granted_at: "nope" }), /must be an ISO timestamp/);
    // Omitting the expiry must fail closed rather than defaulting to "forever".
    assert.throws(() => grant(f.subs, { expires_at: undefined }), /expires_at must not be empty/);
    // An expiry at or before the grant is no lifetime at all.
    assert.throws(() => grant(f.subs, { expires_at: "2029-12-31T00:00:00Z" }), /must be later than granted_at/);
    assert.throws(() => grant(f.subs, { expires_at: "2030-01-01T00:00:00Z" }), /must be later than granted_at/);
  } finally { f.store.close(); }
});

test("a subscription permits only its scope and only up to its risk ceiling", async () => {
  const f = await fixture();
  try {
    grant(f.subs);
    const allowed = f.subs.check({ subscription_id: "sub1", action: "reconcile_offset", risk_level: "R1",
      now: "2030-01-10T00:00:00Z" });
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.reason, "authorized");
    assert.equal(allowed.reauthorization_required, false);
    // Permitting the start is not permitting the skip: the gate still runs downstream.
    assert.equal(allowed.action_gate_still_applies, true);

    // Inside the ceiling.
    assert.equal(f.subs.check({ subscription_id: "sub1", action: "reconcile_offset", risk_level: "R0",
      now: "2030-01-10T00:00:00Z" }).allowed, true);
    // 7.1 rule 5: an action outside the declared scope is not covered.
    const outOfScope = f.subs.check({ subscription_id: "sub1", action: "drop_table", risk_level: "R0",
      now: "2030-01-10T00:00:00Z" });
    assert.equal(outOfScope.allowed, false);
    assert.equal(outOfScope.reason, "action_outside_subscription_scope");
    // 7.1 rule 5: above the declared ceiling is refused even though the action is in scope.
    const tooRisky = f.subs.check({ subscription_id: "sub1", action: "reconcile_offset", risk_level: "R2",
      now: "2030-01-10T00:00:00Z" });
    assert.equal(tooRisky.allowed, false);
    assert.equal(tooRisky.reason, "risk_above_subscription_ceiling");
    assert.equal(tooRisky.max_risk_level, "R1");
  } finally { f.store.close(); }
});

test("expiry stops a subscription, and the state is recorded on first detection", async () => {
  const f = await fixture();
  try {
    grant(f.subs);
    // Evaluated against the clock, so a subscription cannot keep working merely because
    // nobody swept it.
    const lapsed = f.subs.check({ subscription_id: "sub1", action: "reconcile_offset", risk_level: "R0",
      now: "2030-02-01T00:00:00Z" });
    assert.equal(lapsed.allowed, false);
    assert.equal(lapsed.reason, "subscription_expired");
    assert.equal(lapsed.reauthorization_required, true);
    // The expiry is now visible in the record rather than only recomputed by readers.
    const stored = f.subs.get({ subscription_id: "sub1" }).authorization as Record<string, unknown>;
    assert.equal(stored.state, "expired");
    assert.equal(stored.expired_at, "2030-02-01T00:00:00Z");
    // A second check reports expiry without rewriting the record.
    assert.equal(f.subs.check({ subscription_id: "sub1", action: "reconcile_offset", risk_level: "R0",
      now: "2030-02-02T00:00:00Z" }).reason, "subscription_expired");
  } finally { f.store.close(); }
});

test("expiry requires re-confirmation and never renews itself", async () => {
  const f = await fixture();
  try {
    grant(f.subs);
    f.subs.check({ subscription_id: "sub1", action: "reconcile_offset", risk_level: "R0", now: "2030-02-01T00:00:00Z" });
    // Re-confirmation is a person's act with a new deadline; the gap is preserved so a
    // review can see how long the subscription was lapsed.
    const again = f.subs.reconfirm({ subscription_id: "sub1", reconfirmed_at: "2030-02-05T00:00:00Z",
      expires_at: "2030-03-05T00:00:00Z", reconfirmed_by: "u2" });
    const record = again.authorization as Record<string, unknown>;
    assert.equal(record.state, "active");
    assert.equal(record.expires_at, "2030-03-05T00:00:00Z");
    assert.equal(record.confirmations, 1);
    assert.equal(record.previous_expires_at, "2030-02-01T00:00:00Z");
    assert.equal(record.expired_at, null);
    assert.equal(f.subs.check({ subscription_id: "sub1", action: "reconcile_offset", risk_level: "R0",
      now: "2030-02-06T00:00:00Z" }).allowed, true);

    assert.throws(() => f.subs.reconfirm({ subscription_id: "sub1", reconfirmed_at: "2030-02-05T00:00:00Z",
      expires_at: "2030-02-01T00:00:00Z", reconfirmed_by: "u2" }), /must be later than reconfirmed_at/);
  } finally { f.store.close(); }
});

test("the audit reports dispatches, failures and refusals separately", async () => {
  const f = await fixture();
  try {
    grant(f.subs);
    f.subs.recordDispatch({ subscription_id: "sub1", outcome: "dispatched", action: "reconcile_offset",
      risk_level: "R1", at: "2030-01-05T00:00:00Z" });
    f.subs.recordDispatch({ subscription_id: "sub1", outcome: "failed", action: "reconcile_offset",
      risk_level: "R1", at: "2030-01-06T00:00:00Z" });
    // A refusal is history but not a dispatch: counting it as one would make the
    // subscription look busier than the work it actually caused.
    f.subs.recordDispatch({ subscription_id: "sub1", outcome: "refused", action: "drop_table", risk_level: "R3",
      at: "2030-01-07T00:00:00Z", reason: "action_outside_subscription_scope" });

    const audit = f.subs.audit({ subscription_id: "sub1" });
    const summary = audit.summary as Record<string, unknown>;
    assert.equal(summary.dispatches, 1);
    assert.equal(summary.failures, 1);
    assert.equal(summary.refusals, 1);
    assert.equal(summary.total_recorded, 3);
    assert.equal(summary.never_reconfirmed, true);
    // Newest first, so the most recent outcome is what a reader sees.
    assert.equal(summary.last_outcome, "refused");
    assert.equal((audit.refusals as unknown[]).length, 1);
    assert.equal((audit.failure_history as unknown[]).length, 1);
    assert.deepEqual((audit.refusals as Record<string, unknown>[])[0].action, "drop_table");

    assert.throws(() => f.subs.recordDispatch({ subscription_id: "sub1", outcome: "maybe", action: "a",
      risk_level: "R0", at: "2030-01-05T00:00:00Z" }), /outcome is unsupported/);

    // A subscription with no history reports zeroes and a null last outcome.
    grant(f.subs, { subscription_id: "sub2" });
    const quiet = f.subs.audit({ subscription_id: "sub2" }).summary as Record<string, unknown>;
    assert.equal(quiet.total_recorded, 0);
    assert.equal(quiet.last_outcome, null);
  } finally { f.store.close(); }
});

test("revocation is explicit, terminal, and blocks re-confirmation", async () => {
  const f = await fixture();
  try {
    grant(f.subs);
    const revoked = f.subs.revoke({ subscription_id: "sub1", revoked_by: "u1",
      revoked_at: "2030-01-15T00:00:00Z", revocation_reason: "no longer needed" });
    assert.equal(revoked.revoked, true);
    assert.equal((revoked.authorization as Record<string, unknown>).state, "revoked");
    // Revoking twice is a no-op rather than an error.
    assert.equal(f.subs.revoke({ subscription_id: "sub1", revoked_by: "u1", revoked_at: "2030-01-16T00:00:00Z",
      revocation_reason: "again" }).revoked, false);

    const check = f.subs.check({ subscription_id: "sub1", action: "reconcile_offset", risk_level: "R0",
      now: "2030-01-16T00:00:00Z" });
    assert.equal(check.allowed, false);
    assert.equal(check.reason, "subscription_revoked");
    assert.throws(() => f.subs.reconfirm({ subscription_id: "sub1", reconfirmed_at: "2030-01-16T00:00:00Z",
      expires_at: "2030-03-01T00:00:00Z", reconfirmed_by: "u1" }), /revoked subscription cannot be reconfirmed/);

    // A suspended subscription is a distinct state with its own reason, because the two
    // need different responses: one means look at the upstream, the other means it is gone.
    f.store.save("subscription_authorization", "sub1",
      { ...(f.subs.get({ subscription_id: "sub1" }).authorization as Record<string, unknown>), state: "suspended" });
    const suspended = f.subs.check({ subscription_id: "sub1", action: "reconcile_offset", risk_level: "R0",
      now: "2030-01-16T00:00:00Z" });
    assert.equal(suspended.allowed, false);
    assert.equal(suspended.reason, "subscription_suspended");
  } finally { f.store.close(); }
});

test("the sweep expires lapsed subscriptions without renewing any", async () => {
  const f = await fixture();
  try {
    grant(f.subs, { subscription_id: "lapsed", expires_at: "2030-02-01T00:00:00Z" });
    grant(f.subs, { subscription_id: "live", expires_at: "2030-06-01T00:00:00Z" });
    const swept = f.subs.sweep({ now: "2030-03-01T00:00:00Z" });
    assert.deepEqual(swept.expired, ["lapsed"]);
    assert.equal(swept.count, 1);
    // Noticing a deadline passed is bookkeeping; extending it would be a decision, so the
    // sweep only ever moves a subscription toward expiry.
    assert.equal((f.subs.get({ subscription_id: "live" }).authorization as { state: string }).state, "active");
    assert.equal((f.subs.get({ subscription_id: "lapsed" }).authorization as { state: string }).state, "expired");
    // Sweeping again changes nothing.
    assert.deepEqual(f.subs.sweep({ now: "2030-03-02T00:00:00Z" }).expired, []);
  } finally { f.store.close(); }
});

test("listing marks a lapsed subscription as expired even before a sweep", async () => {
  const f = await fixture();
  try {
    grant(f.subs, { subscription_id: "lapsed", expires_at: "2030-02-01T00:00:00Z" });
    grant(f.subs, { subscription_id: "live", expires_at: "2030-06-01T00:00:00Z" });
    const listed = f.subs.list({ now: "2030-03-01T00:00:00Z" });
    const byId = new Map((listed.subscriptions as Record<string, unknown>[]).map((item) => [item.id, item]));
    // Without this a listing would show a lapsed subscription as active just because no
    // sweep had run yet.
    assert.equal(byId.get("lapsed")!.expired, true);
    assert.equal(byId.get("live")!.expired, false);
    // Without a clock the flag is honestly unknown rather than guessed.
    assert.equal((f.subs.list({}).subscriptions as Record<string, unknown>[])[0]!.expired, null);
    assert.equal((f.subs.list({ state: "active" }).subscriptions as unknown[]).length, 2);
    assert.deepEqual(f.subs.list({ state: "revoked" }).subscriptions, []);
    assert.throws(() => f.subs.list({ state: "bogus" }), /state is unsupported/);
    assert.throws(() => f.subs.list({ now: "nope" }), /must be an ISO timestamp/);
  } finally { f.store.close(); }
});

test("malformed input is refused by name on every path", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.subs.get({ subscription_id: "missing" }), /Unknown subscription_authorization/);
    assert.throws(() => f.subs.check({ subscription_id: "missing", action: "a", risk_level: "R0", now: "2030-01-01T00:00:00Z" }),
      /Unknown subscription_authorization/);
    assert.throws(() => f.subs.revoke({ subscription_id: "missing", revoked_by: "u", revoked_at: "2030-01-01T00:00:00Z",
      revocation_reason: "r" }), /Unknown subscription_authorization/);
    assert.throws(() => f.subs.reconfirm({ subscription_id: "missing", reconfirmed_at: "2030-01-01T00:00:00Z",
      expires_at: "2030-02-01T00:00:00Z", reconfirmed_by: "u" }), /Unknown subscription_authorization/);
    assert.throws(() => f.subs.audit({ subscription_id: "missing" }), /Unknown subscription_authorization/);
    assert.throws(() => f.subs.sweep({ now: "nope" }), /must be an ISO timestamp/);

    grant(f.subs);
    assert.throws(() => f.subs.check({ subscription_id: "sub1", action: "bad action!", risk_level: "R0",
      now: "2030-01-10T00:00:00Z" }), /unsupported characters/);
    assert.throws(() => f.subs.check({ subscription_id: "sub1", action: "a", risk_level: "R9",
      now: "2030-01-10T00:00:00Z" }), /must be R0, R1, R2 or R3/);
    assert.throws(() => f.subs.check({ subscription_id: "sub1", action: "a", risk_level: "R0", now: "nope" }),
      /must be an ISO timestamp/);
    assert.throws(() => f.subs.recordDispatch({ subscription_id: "sub1", outcome: "dispatched", action: "bad action!",
      risk_level: "R0", at: "2030-01-05T00:00:00Z" }), /unsupported characters/);
    assert.throws(() => f.subs.recordDispatch({ subscription_id: "sub1", outcome: "dispatched", action: "a",
      risk_level: "R9", at: "2030-01-05T00:00:00Z" }), /must be R0, R1, R2 or R3/);
    assert.throws(() => f.subs.recordDispatch({ subscription_id: "sub1", outcome: "dispatched", action: "a",
      risk_level: "R0", at: "nope" }), /must be an ISO timestamp/);
    assert.throws(() => f.subs.revoke({ subscription_id: "sub1", revoked_by: "bad id!",
      revoked_at: "2030-01-01T00:00:00Z", revocation_reason: "r" }), /unsupported characters/);
    assert.throws(() => f.subs.revoke({ subscription_id: "sub1", revoked_by: "u",
      revoked_at: "2030-01-01T00:00:00Z" }), /revocation_reason must not be empty/);
    assert.throws(() => f.subs.reconfirm({ subscription_id: "sub1", reconfirmed_at: "nope",
      expires_at: "2030-02-01T00:00:00Z", reconfirmed_by: "u" }), /must be an ISO timestamp/);
  } finally { f.store.close(); }
});
