import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AuthorizationKernel, effectDigest } from "../core/authorization.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "craft-authz-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { store, authz: new AuthorizationKernel(store) };
}

const at = "2030-01-01T00:00:00Z";
const effect = { target: "node/eval-3", action: "restart" };

test("acknowledging a card authorizes nothing", async () => {
  const f = await fixture();
  try {
    // This is the distinction 11.4 exists for: seeing a card is a fact about attention, and
    // the effect behind it still has no authorization afterwards.
    const ack = f.authz.acknowledge({ card_id: "card-1", actor: "u1", acknowledged_at: at });
    assert.equal((ack.acknowledgement as Record<string, unknown>).authorizes_effect, false);
    assert.equal((ack.acknowledgement as Record<string, unknown>).subject, "card");

    const check = f.authz.check({ effect_id: "eff-1", risk_level: "R2", effect });
    assert.equal(check.authorized, false);
    assert.equal(check.reason, "no_authorization_recorded");

    // The trail reports the two counts separately so a review cannot read one as the other.
    const trail = f.authz.trail({ effect_id: "eff-1", card_id: "card-1" });
    assert.equal(trail.authorization_count, 0);
    assert.equal(trail.acknowledgement_count, 1);
    assert.equal(trail.acknowledged_but_not_authorized, true);

    // Acknowledging the same card by the same actor is idempotent.
    assert.equal(f.authz.acknowledge({ card_id: "card-1", actor: "u1", acknowledged_at: at }).idempotent, true);
    // A different actor is a different acknowledgement.
    assert.equal(f.authz.acknowledge({ card_id: "card-1", actor: "u2", acknowledged_at: at }).idempotent, false);
    // An explicit id is honoured.
    const explicit = f.authz.acknowledge({ acknowledgement_id: "ack_explicit", card_id: "card-9", actor: "u1", acknowledged_at: at });
    assert.equal((explicit.acknowledgement as Record<string, unknown>).id, "ack_explicit");
  } finally { f.store.close(); }
});

test("an authorization binds who, when, which effect, and which receipt digest", async () => {
  const f = await fixture();
  try {
    const authorized = f.authz.authorize({ effect_id: "eff-1", effect_kind: "node_restart", actor: "u1",
      authorized_at: at, effect, risk_level: "R2", decision_reason: "window approved by on-call" });
    const record = authorized.authorization as Record<string, unknown>;
    assert.equal(record.approved_by, "u1");
    assert.equal(record.authorized_at, at);
    assert.equal(record.effect_id, "eff-1");
    assert.equal(record.receipt_digest, effectDigest(effect));
    assert.equal(record.status, "authorized");
    assert.equal(record.authorizes_effect, true);
    assert.equal(record.content_stored, false);

    // The four facts are all retrievable, which is what makes the decision independently
    // verifiable after the fact.
    const check = f.authz.check({ effect_id: "eff-1", risk_level: "R2", effect });
    assert.equal(check.authorized, true);
    assert.equal(check.authorized_by, "u1");
    assert.equal(check.authorized_at, at);
    assert.equal(check.required, true);

    // A digest supplied directly is accepted and used verbatim.
    const supplied = f.authz.authorize({ effect_id: "eff-2", effect_kind: "node_restart", actor: "u2", authorized_at: at,
      receipt_digest: `sha256:${"a".repeat(64)}`, risk_level: "R3", decision_reason: "change ticket CHG-1" });
    assert.equal((supplied.authorization as Record<string, unknown>).receipt_digest, `sha256:${"a".repeat(64)}`);
  } finally { f.store.close(); }
});

test("a changed effect is refused even though an authorization exists", async () => {
  const f = await fixture();
  try {
    f.authz.authorize({ effect_id: "eff-1", effect_kind: "node_restart", actor: "u1", authorized_at: at,
      effect, risk_level: "R2", decision_reason: "approved" });
    // The person approved "restart eval-3"; the effect now says "restart eval-9". Without the
    // digest binding this would proceed on the strength of a signature for something else.
    const changed = f.authz.check({ effect_id: "eff-1", risk_level: "R2", effect: { target: "node/eval-9", action: "restart" } });
    assert.equal(changed.authorized, false);
    assert.equal(changed.reason, "receipt_digest_mismatch");

    // The unchanged effect still passes, so the refusal is about content, not a broken record.
    assert.equal(f.authz.check({ effect_id: "eff-1", risk_level: "R2", effect }).authorized, true);
    // Omitting the effect skips the digest comparison and reports the recorded authorization.
    assert.equal(f.authz.check({ effect_id: "eff-1", risk_level: "R2" }).authorized, true);
  } finally { f.store.close(); }
});

test("levels below R2 do not require an authorization record", async () => {
  const f = await fixture();
  try {
    // R0/R1 are reversible or not yet externally visible, so demanding a record there is
    // friction without a safety return.
    for (const level of ["R0", "R1"] as const) {
      const check = f.authz.check({ effect_id: `eff-${level}`, risk_level: level, effect });
      assert.equal(check.authorized, true);
      assert.equal(check.reason, "below_authorization_threshold");
      assert.equal(check.required, false);
      assert.equal(check.authorization, null);
    }
    // R2 and R3 fail closed with no record.
    for (const level of ["R2", "R3"] as const) {
      const check = f.authz.check({ effect_id: `eff-${level}`, risk_level: level, effect });
      assert.equal(check.authorized, false);
      assert.equal(check.required, true);
    }
  } finally { f.store.close(); }
});

test("an authorization covers one occurrence, and a consumed one does not authorize again", async () => {
  const f = await fixture();
  try {
    const record = f.authz.authorize({ effect_id: "eff-1", effect_kind: "node_restart", actor: "u1", authorized_at: at,
      effect, risk_level: "R2", decision_reason: "approved" }).authorization as Record<string, unknown>;
    const id = String(record.id);

    const consumed = f.authz.consume({ authorization_id: id, execution_id: "exec-1", consumed_at: "2030-01-01T00:05:00Z" });
    assert.equal((consumed.authorization as Record<string, unknown>).status, "consumed");
    assert.equal(consumed.idempotent, false);
    // Replaying the same execution is idempotent; a different execution is refused, because
    // one signature must not stand behind two actions.
    assert.equal(f.authz.consume({ authorization_id: id, execution_id: "exec-1", consumed_at: "2030-01-01T00:06:00Z" }).idempotent, true);
    assert.throws(() => f.authz.consume({ authorization_id: id, execution_id: "exec-2", consumed_at: at }),
      /already consumed by a different execution/);

    const after = f.authz.check({ effect_id: "eff-1", risk_level: "R2", effect });
    assert.equal(after.authorized, false);
    assert.equal(after.reason, "authorization_already_consumed");
  } finally { f.store.close(); }
});

test("a revoked authorization stops authorizing, and a re-authorization supersedes an older one", async () => {
  const f = await fixture();
  try {
    const first = f.authz.authorize({ effect_id: "eff-1", effect_kind: "node_restart", actor: "u1", authorized_at: "2030-01-01T00:00:00Z",
      effect, risk_level: "R2", decision_reason: "approved" }).authorization as Record<string, unknown>;
    const revoked = f.authz.revoke({ authorization_id: String(first.id), revoked_by: "u2",
      revoked_at: "2030-01-01T00:01:00Z", revocation_reason: "window closed" });
    assert.equal(revoked.revoked, true);
    assert.equal((revoked.authorization as Record<string, unknown>).status, "revoked");
    // Revoking twice is a no-op rather than an error.
    assert.equal(f.authz.revoke({ authorization_id: String(first.id), revoked_by: "u2",
      revoked_at: at, revocation_reason: "again" }).revoked, false);
    assert.equal(f.authz.check({ effect_id: "eff-1", risk_level: "R2", effect }).reason, "authorization_already_consumed");

    // A later authorization wins, so a re-approval does not require deleting history.
    f.authz.authorize({ effect_id: "eff-1", effect_kind: "node_restart", actor: "u3", authorized_at: "2030-01-01T00:02:00Z",
      effect, risk_level: "R2", decision_reason: "re-approved" });
    const check = f.authz.check({ effect_id: "eff-1", risk_level: "R2", effect });
    assert.equal(check.authorized, true);
    assert.equal(check.authorized_by, "u3");

    // Two live authorizations at once: the newest is the one reported, regardless of the
    // order the store returns them in.
    f.authz.authorize({ effect_id: "eff-1", effect_kind: "node_restart", actor: "u4", authorized_at: "2030-01-01T00:07:00Z",
      effect, risk_level: "R2", decision_reason: "approved again" });
    const newest = f.authz.check({ effect_id: "eff-1", risk_level: "R2", effect });
    assert.equal(newest.authorized_by, "u4");
    assert.equal(newest.authorized_at, "2030-01-01T00:07:00Z");

    // A consumed authorization cannot be revoked.
    const live = f.authz.check({ effect_id: "eff-1", risk_level: "R2", effect }).authorization as Record<string, unknown>;
    f.authz.consume({ authorization_id: String(live.id), execution_id: "exec-9", consumed_at: at });
    assert.throws(() => f.authz.revoke({ authorization_id: String(live.id), revoked_by: "u1",
      revoked_at: at, revocation_reason: "too late" }), /cannot be revoked/);
  } finally { f.store.close(); }
});

test("the authorization trail is retrievable and idempotency conflicts are refused", async () => {
  const f = await fixture();
  try {
    const first = f.authz.authorize({ effect_id: "eff-1", effect_kind: "node_restart", actor: "u1", authorized_at: at,
      effect, risk_level: "R2", decision_reason: "approved" });
    // Repeating the identical authorization is idempotent.
    assert.equal(f.authz.authorize({ effect_id: "eff-1", effect_kind: "node_restart", actor: "u1", authorized_at: at,
      effect, risk_level: "R2", decision_reason: "approved" }).idempotent, true);
    // The same id with different content is a conflict: overwriting would swap the digest the
    // original was checked against.
    assert.throws(() => f.authz.authorize({ authorization_id: String((first.authorization as Record<string, unknown>).id),
      effect_id: "eff-1", effect_kind: "node_restart", actor: "u9", authorized_at: at, effect, risk_level: "R3",
      decision_reason: "different" }), /idempotency conflict/);

    f.authz.authorize({ effect_id: "eff-1", effect_kind: "node_restart", actor: "u2", authorized_at: "2030-01-01T00:09:00Z",
      effect, risk_level: "R2", decision_reason: "second" });
    const list = f.authz.list({ effect_id: "eff-1" });
    assert.equal((list.authorizations as unknown[]).length, 2);
    // Newest first, so the most recent decision is the first thing a reviewer reads.
    assert.equal((list.authorizations as Record<string, unknown>[])[0].approved_by, "u2");
    assert.equal((f.authz.get({ authorization_id: String((first.authorization as Record<string, unknown>).id) }).authorization as Record<string, unknown>).approved_by, "u1");
    // A trail with no card still reports zero acknowledgements rather than omitting the field.
    const trail = f.authz.trail({ effect_id: "eff-1" });
    assert.equal(trail.acknowledgement_count, 0);
    assert.equal(trail.acknowledged_but_not_authorized, false);
  } finally { f.store.close(); }
});

test("malformed input is refused by name on every path", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.authz.acknowledge({ card_id: "bad id!", actor: "u1", acknowledged_at: at }), /unsupported characters/);
    assert.throws(() => f.authz.acknowledge({ card_id: "c", actor: "u1", acknowledged_at: "nope" }), /must be an ISO timestamp/);
    assert.throws(() => f.authz.acknowledge({ card_id: "c", acknowledged_at: at }), /actor must not be empty/);
    assert.throws(() => f.authz.acknowledge({ acknowledgement_id: "bad id!", card_id: "c", actor: "u1", acknowledged_at: at }),
      /unsupported characters/);

    // Every binding fact is required: an inferred approver or digest would record an
    // assumption rather than a decision.
    assert.throws(() => f.authz.authorize({ effect_kind: "k", actor: "u1", authorized_at: at, effect, risk_level: "R2",
      decision_reason: "r" }), /effect_id must not be empty/);
    assert.throws(() => f.authz.authorize({ effect_id: "e", effect_kind: "k", authorized_at: at, effect, risk_level: "R2",
      decision_reason: "r" }), /actor must not be empty/);
    assert.throws(() => f.authz.authorize({ effect_id: "e", effect_kind: "k", actor: "u1", effect, risk_level: "R2",
      decision_reason: "r" }), /authorized_at must not be empty/);
    assert.throws(() => f.authz.authorize({ effect_id: "e", effect_kind: "k", actor: "u1", authorized_at: at,
      risk_level: "R2", decision_reason: "r" }), /effect must be an object/);
    assert.throws(() => f.authz.authorize({ effect_id: "e", effect_kind: "k", actor: "u1", authorized_at: at,
      effect, risk_level: "R2" }), /decision_reason must not be empty/);
    assert.throws(() => f.authz.authorize({ effect_id: "e", effect_kind: "k", actor: "u1", authorized_at: at,
      effect, risk_level: "R9", decision_reason: "r" }), /risk_level must be R0, R1, R2 or R3/);
    assert.throws(() => f.authz.authorize({ effect_id: "e", effect_kind: "k", actor: "u1", authorized_at: at,
      receipt_digest: "not-a-digest", risk_level: "R2", decision_reason: "r" }), /must be a sha256 digest/);
    assert.throws(() => f.authz.authorize({ effect_id: "e", effect_kind: "bad kind!", actor: "u1", authorized_at: at,
      effect, risk_level: "R2", decision_reason: "r" }), /unsupported characters/);
    assert.throws(() => effectDigest([1, 2]), /effect must be an object/);
    assert.throws(() => effectDigest("nope"), /effect must be an object/);

    assert.throws(() => f.authz.check({ effect_id: "e", risk_level: "R9" }), /risk_level must be R0/);
    assert.throws(() => f.authz.check({ risk_level: "R2" }), /effect_id must not be empty/);
    assert.throws(() => f.authz.get({ authorization_id: "missing" }), /Unknown effect_authorization/);
    assert.throws(() => f.authz.consume({ authorization_id: "missing", execution_id: "x", consumed_at: at }), /Unknown effect_authorization/);
    assert.throws(() => f.authz.revoke({ authorization_id: "missing", revoked_by: "u", revoked_at: at, revocation_reason: "r" }),
      /Unknown effect_authorization/);
    assert.throws(() => f.authz.list({ effect_id: "bad id!" }), /unsupported characters/);
    assert.throws(() => f.authz.trail({ effect_id: "bad id!" }), /unsupported characters/);

    const record = f.authz.authorize({ effect_id: "eff-x", effect_kind: "k", actor: "u1", authorized_at: at, effect,
      risk_level: "R2", decision_reason: "r" }).authorization as Record<string, unknown>;
    assert.throws(() => f.authz.consume({ authorization_id: String(record.id), execution_id: "exec", consumed_at: "nope" }),
      /must be an ISO timestamp/);
    assert.throws(() => f.authz.revoke({ authorization_id: String(record.id), revoked_by: "u1", revoked_at: at }),
      /revocation_reason must not be empty/);
    assert.throws(() => f.authz.revoke({ authorization_id: String(record.id), revoked_by: "bad id!", revoked_at: at,
      revocation_reason: "r" }), /unsupported characters/);
  } finally { f.store.close(); }
});
