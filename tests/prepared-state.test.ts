import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { MISMATCH_RECOVERY, PreparedStateKernel } from "../core/prepared-state.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "craft-prepared-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { store, prepared: new PreparedStateKernel(store) };
}

const payload = { node_id: "eval-3", action: "restart", confirm: "yes" };
const page = "portal://eval3/node/eval-3";
/** A liveness assertion is required, so every fixture carries one. */
const assertions = [
  { name: "session_alive", kind: "liveness", observed: "authenticated" },
  { name: "confirm_step", kind: "content", observed: "visible" },
];

const prepare = (prepared: PreparedStateKernel, overrides: Record<string, unknown> = {}) =>
  prepared.prepare({ prepared_id: "p1", page_identity: page, submit_payload: payload, assertions, ...overrides })
    .prepared_state as Record<string, unknown>;

const release = (prepared: PreparedStateKernel, overrides: Record<string, unknown> = {}) =>
  prepared.release({ prepared_id: "p1", release_id: "r1", approved_by: "u1", released_at: "2030-01-01T00:01:00Z",
    page_identity: page, submit_payload: payload, observed: assertions, ...overrides });

test("a prepared state digests the payload, page identity and assertions together", async () => {
  const f = await fixture();
  try {
    const first = prepare(f.prepared);
    assert.equal(first.status, "prepared");
    assert.equal(first.content_stored, false);
    // A different payload is a different prepared state, which is the point: the digest
    // is about what would be submitted, not about the page alone.
    const other = prepare(f.prepared, { prepared_id: "p2", submit_payload: { ...payload, confirm: "no" } });
    assert.notEqual(other.prepared_state_digest, first.prepared_state_digest);
    // So is a different page, or a different assertion value.
    assert.notEqual(prepare(f.prepared, { prepared_id: "p3", page_identity: "portal://other" }).prepared_state_digest, first.prepared_state_digest);
    assert.notEqual(prepare(f.prepared, { prepared_id: "p4",
      assertions: [{ name: "session_alive", kind: "liveness", observed: "expired" }, assertions[1]] }).prepared_state_digest,
      first.prepared_state_digest);

    // Re-preparing the identical state is idempotent; the same id with different content is
    // a conflict rather than a silent overwrite.
    assert.equal(f.prepared.prepare({ prepared_id: "p1", page_identity: page, submit_payload: payload, assertions }).idempotent, true);
    assert.throws(() => f.prepared.prepare({ prepared_id: "p1", page_identity: page,
      submit_payload: { ...payload, confirm: "no" }, assertions }), /idempotency conflict/);
    assert.equal((f.prepared.get({ prepared_id: "p1" }).prepared_state as Record<string, unknown>).status, "prepared");
  } finally { f.store.close(); }
});

test("a matching release proceeds and binds the approval to the digest it verified", async () => {
  const f = await fixture();
  try {
    const prepared = prepare(f.prepared);
    const released = release(f.prepared);
    assert.equal(released.released, true);
    const record = released.release as Record<string, unknown>;
    // The binding is what answers "which state did the person approve" after the fact.
    assert.equal(record.bound_digest, prepared.prepared_state_digest);
    assert.equal(record.approved_by, "u1");
    assert.equal(record.content_stored, false);
    assert.equal((released.prepared_state as Record<string, unknown>).status, "released");

    // Releasing the same id again is idempotent, not a second approval.
    const again = release(f.prepared);
    assert.equal(again.idempotent, true);
    assert.equal((again.release as Record<string, unknown>).id, record.id);
    // The same release id against a different prepared state is a conflict.
    prepare(f.prepared, { prepared_id: "p2" });
    assert.throws(() => f.prepared.release({ prepared_id: "p2", release_id: "r1", approved_by: "u1",
      released_at: "2030-01-01T00:01:00Z", page_identity: page, submit_payload: payload, observed: assertions }),
      /idempotency conflict/);
  } finally { f.store.close(); }
});

test("an expired session is reported as such, and its recovery is re-authentication not re-prepare", async () => {
  const f = await fixture();
  try {
    prepare(f.prepared);
    // This is the case 13A.3.3 exists for: the token is the non-deterministic node an
    // over-eager cleanup would have filtered out, and its expiry is exactly what matters.
    const refused = release(f.prepared, { observed: [{ name: "session_alive", kind: "liveness", observed: "expired" }, assertions[1]] });
    assert.equal(refused.released, false);
    assert.equal(refused.reason, "liveness_failed");
    assert.equal(refused.recovery, "re_authenticate");
    // Re-presenting the same page would show the same dead state, so this is not
    // "re_prepare" like the other mismatches.
    assert.notEqual(MISMATCH_RECOVERY.liveness_failed, MISMATCH_RECOVERY.payload_changed);
    // A refusal does not consume the prepared state.
    assert.equal((f.prepared.get({ prepared_id: "p1" }).prepared_state as Record<string, unknown>).status, "prepared");
  } finally { f.store.close(); }
});

test("a changed payload is caught even when every assertion still holds", async () => {
  const f = await fixture();
  try {
    prepare(f.prepared);
    // The form silently reset and the page looks identical. Without digesting the payload
    // this release would submit values the person never saw.
    const refused = release(f.prepared, { submit_payload: { ...payload, node_id: "eval-9" } });
    assert.equal(refused.released, false);
    assert.equal(refused.reason, "payload_changed");
    assert.equal(refused.recovery, "re_prepare");
    assert.notEqual(refused.current_digest, refused.prepared_state_digest);
  } finally { f.store.close(); }
});

test("a changed page identity or content assertion is caught, and liveness wins when both moved", async () => {
  const f = await fixture();
  try {
    prepare(f.prepared);
    // Redirected to a similar-looking page.
    assert.equal(release(f.prepared, { page_identity: "portal://eval3/login" }).reason, "page_identity_changed");
    // The confirm step moved.
    assert.equal(release(f.prepared, { observed: [assertions[0], { name: "confirm_step", kind: "content", observed: "hidden" }] }).reason,
      "assertion_changed");
    // Both an expired session and a moved step: the session is the honest reason, because
    // it invalidates the other observation rather than being one of two equal problems.
    const both = release(f.prepared, { observed: [{ name: "session_alive", kind: "liveness", observed: "expired" },
      { name: "confirm_step", kind: "content", observed: "hidden" }] });
    assert.equal(both.reason, "liveness_failed");
  } finally { f.store.close(); }
});

test("an assertion the release cannot re-state fails closed rather than being assumed", async () => {
  const f = await fixture();
  try {
    prepare(f.prepared);
    // Omitting an assertion is a failure, not a pass: what cannot be checked may not be
    // assumed (13A.3.3 rule 2).
    const dropped = release(f.prepared, { observed: [assertions[0]] });
    assert.equal(dropped.released, false);
    assert.equal(dropped.reason, "assertion_changed");
    assert.deepEqual(dropped.missing_assertions, ["confirm_step"]);

    // An assertion the prepare never declared is equally a mismatch.
    const extra = release(f.prepared, { observed: [...assertions, { name: "extra", kind: "content", observed: "x" }] });
    assert.equal(extra.released, false);
    assert.deepEqual(extra.unexpected_assertions, ["extra"]);
  } finally { f.store.close(); }
});

test("a liveness assertion is mandatory, and malformed input is refused by name", async () => {
  const f = await fixture();
  try {
    // Without a liveness assertion an expired session is indistinguishable from success,
    // so the state cannot be prepared at all.
    assert.throws(() => f.prepared.prepare({ prepared_id: "p1", page_identity: page, submit_payload: payload,
      assertions: [{ name: "confirm_step", kind: "content", observed: "visible" }] }), /at least one liveness assertion/);
    assert.throws(() => f.prepared.prepare({ prepared_id: "p1", page_identity: page, submit_payload: payload }),
      /assertions are required/);
    assert.throws(() => f.prepared.prepare({ prepared_id: "p1", page_identity: page, submit_payload: payload, assertions: [] }),
      /non-empty array/);

    assert.throws(() => f.prepared.prepare({ prepared_id: "bad id!", page_identity: page, submit_payload: payload, assertions }),
      /unsupported characters/);
    assert.throws(() => f.prepared.prepare({ prepared_id: "p", page_identity: page, submit_payload: {}, assertions }),
      /at least one field/);
    assert.throws(() => f.prepared.prepare({ prepared_id: "p", page_identity: page, submit_payload: { "bad key": 1 }, assertions }),
      /not a valid field name/);
    assert.throws(() => f.prepared.prepare({ prepared_id: "p", page_identity: page, submit_payload: { a: {} }, assertions }),
      /must be a string, number or boolean/);
    assert.throws(() => f.prepared.prepare({ prepared_id: "p", page_identity: page, submit_payload: { a: Number.NaN }, assertions }),
      /finite number/);
    assert.throws(() => f.prepared.prepare({ prepared_id: "p", page_identity: page, submit_payload: payload,
      assertions: [{ name: "a", kind: "bogus", observed: 1 }, assertions[0]] }), /must be liveness, identity or content/);
    assert.throws(() => f.prepared.prepare({ prepared_id: "p", page_identity: page, submit_payload: payload,
      assertions: [{ name: "Bad Name", kind: "content", observed: 1 }, assertions[0]] }), /not a valid assertion name/);
    assert.throws(() => f.prepared.prepare({ prepared_id: "p", page_identity: page, submit_payload: payload,
      assertions: [assertions[0], assertions[0]] }), /duplicate name/);
    assert.throws(() => f.prepared.get({ prepared_id: "missing" }), /Unknown prepared_state/);
    // `approved_by` is read on the release path, so a missing one is refused there.
    prepare(f.prepared, { prepared_id: "p9" });
    assert.throws(() => f.prepared.release({ prepared_id: "p9", release_id: "r9", released_at: "2030-01-01T00:01:00Z",
      page_identity: page, submit_payload: payload, observed: assertions }), /approved_by must not be empty/);
    // A page identity must look like a location, not a bare id.
    assert.throws(() => f.prepared.prepare({ prepared_id: "p10", page_identity: "not-a-location",
      submit_payload: payload, assertions }), /scheme-qualified location/);
  } finally { f.store.close(); }
});
