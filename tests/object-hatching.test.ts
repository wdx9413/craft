import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { ObjectHatchingKernel } from "../core/object-hatching.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "craft-hatch-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { store, hatch: new ObjectHatchingKernel(store) };
}

const at = "2030-01-01T00:00:00Z";
const open = (kernel: ObjectHatchingKernel, session = "s1") => kernel.openSession({ session_id: session, opened_at: at });
const hatch = (kernel: ObjectHatchingKernel, overrides: Record<string, unknown> = {}) =>
  kernel.hatch({ session_id: "s1", intention: "Evaluate migrating the serialization library to Jackson",
    object_kind: "migration", hatched_at: at, ...overrides });

test("free expression produces exactly one object and closes the session", async () => {
  const f = await fixture();
  try {
    const session = open(f.hatch);
    // The session records that it permits zero conversation turns, so the limit is a
    // property of the session rather than a UI convention.
    assert.equal((session.session as Record<string, unknown>).conversation_turns_allowed, 0);
    assert.equal((session.session as Record<string, unknown>).hatch_limit, 1);

    const first = hatch(f.hatch);
    // The object is human-originated, which is what distinguishes it from one an event
    // produced and what a later evidence question will depend on.
    assert.equal((first.object as Record<string, unknown>).origin, "human");
    assert.equal((first.object as Record<string, unknown>).state, "hatched");
    assert.equal(first.session_closed, true);
    assert.equal((f.hatch.getSession({ session_id: "s1" }).session as Record<string, unknown>).status, "closed");

    // A second hatch on the same session is refused: there is no "continue".
    assert.throws(() => hatch(f.hatch), /free expression produces one object and closes/);
    assert.throws(() => f.hatch.hatch({ session_id: "s1", intention: "and also do this", object_kind: "migration", hatched_at: at }),
      /free expression produces one object and closes/);
  } finally { f.store.close(); }
});

test("the object id is derived from the intention, so expressing it twice is one object", async () => {
  const f = await fixture();
  try {
    open(f.hatch, "s1");
    const first = hatch(f.hatch).object as Record<string, unknown>;
    open(f.hatch, "s2");
    // Casing and whitespace are normalized, so the same intention in different clothes
    // derives the same id and the store refuses the duplicate rather than leaving the user
    // with two near-identical objects.
    assert.throws(() => f.hatch.hatch({ session_id: "s2",
      intention: "  evaluate   MIGRATING the serialization library to jackson ",
      object_kind: "migration", hatched_at: at }), /already exists/);
    // The first object is untouched by the refused second hatch.
    assert.equal((f.hatch.getObject({ object_id: String(first.id) }).object as Record<string, unknown>).id, first.id);
  } finally { f.store.close(); }
});

test("a duplicate intention is refused rather than creating a second object", async () => {
  const f = await fixture();
  try {
    open(f.hatch, "s1");
    hatch(f.hatch);
    open(f.hatch, "s2");
    // Same intention, same kind: the derived id collides, so the store refuses the create
    // instead of leaving the user with two objects for one intention.
    assert.throws(() => f.hatch.hatch({ session_id: "s2", intention: "Evaluate migrating the serialization library to Jackson",
      object_kind: "migration", hatched_at: at }), /already exists/);
    // A different intention in the same kind is a different object.
    open(f.hatch, "s3");
    const other = f.hatch.hatch({ session_id: "s3", intention: "Evaluate migrating the cache layer to Redis",
      object_kind: "migration", hatched_at: at });
    assert.notEqual((other.object as Record<string, unknown>).id, "migration_x");
    // An explicit id is honoured when the caller has one.
    open(f.hatch, "s4");
    const explicit = f.hatch.hatch({ session_id: "s4", intention: "Explicit object", object_kind: "migration",
      object_id: "migration_explicit", hatched_at: at });
    assert.equal((explicit.object as Record<string, unknown>).id, "migration_explicit");
  } finally { f.store.close(); }
});

test("missing information is gathered as named fields, never by returning to free expression", async () => {
  const f = await fixture();
  try {
    open(f.hatch);
    const object = hatch(f.hatch).object as Record<string, unknown>;
    const objectId = String(object.id);

    const requested = f.hatch.requestFields({ object_id: objectId, fields: ["target_framework", "rollback_plan"] });
    assert.deepEqual(requested.requested_fields, ["rollback_plan", "target_framework"]);
    assert.equal((requested.object as Record<string, unknown>).state, "awaiting_fields");

    // A field nobody asked for is refused: accepting it would make this a free-form channel
    // by another name, which is the chat door reopening.
    assert.throws(() => f.hatch.complete({ object_id: objectId, values: { unrelated_note: "hello" } }),
      /field\(s\) that were not requested: unrelated_note/);
    // Asking for a field twice would raise the same card repeatedly.
    assert.throws(() => f.hatch.requestFields({ object_id: objectId, fields: ["target_framework"] }), /already requested/);

    // A partial answer is accepted and leaves the rest pending.
    const partial = f.hatch.complete({ object_id: objectId, values: { target_framework: "jackson" } });
    assert.deepEqual(partial.remaining_fields, ["rollback_plan"]);
    assert.equal((partial.object as Record<string, unknown>).state, "awaiting_fields");

    // Supplying the last field makes the object ready.
    const done = f.hatch.complete({ object_id: objectId, values: { rollback_plan: "keep fastjson behind a flag" } });
    assert.deepEqual(done.remaining_fields, []);
    assert.equal((done.object as Record<string, unknown>).state, "ready");
    assert.deepEqual((done.object as Record<string, unknown>).fields,
      { rollback_plan: "keep fastjson behind a flag", target_framework: "jackson" });

    // Once filled, a field cannot be requested again.
    assert.throws(() => f.hatch.requestFields({ object_id: objectId, fields: ["target_framework"] }), /already filled/);
    // With nothing pending, completion is refused rather than silently doing nothing.
    assert.throws(() => f.hatch.complete({ object_id: objectId, values: { anything: 1 } }), /no pending field request/);
  } finally { f.store.close(); }
});

test("the intention is kept verbatim, and listing filters by kind and origin", async () => {
  const f = await fixture();
  try {
    open(f.hatch, "s1");
    // The id is normalized, and the stored intention keeps the wording but not the
    // surrounding whitespace: `text()` trims, so the object reads as the sentence the
    // person wrote rather than with the padding their input happened to carry.
    const object = hatch(f.hatch, { intention: "  Evaluate migrating the serialization library to Jackson  " }).object as Record<string, unknown>;
    assert.equal(object.intention, "Evaluate migrating the serialization library to Jackson");
    assert.deepEqual(object.fields, {});
    assert.deepEqual(object.pending_fields, []);

    open(f.hatch, "s2");
    f.hatch.hatch({ session_id: "s2", intention: "Another migration", object_kind: "refactor", hatched_at: at });
    assert.equal((f.hatch.list({}).objects as unknown[]).length, 2);
    assert.equal((f.hatch.list({ object_kind: "migration" }).objects as unknown[]).length, 1);
    assert.equal((f.hatch.list({ origin: "human" }).objects as unknown[]).length, 2);
    // No object is event-originated yet, and the filter says so rather than returning all.
    assert.deepEqual(f.hatch.list({ origin: "event" }).objects, []);
    assert.equal((f.hatch.getObject({ object_id: String(object.id) }).object as Record<string, unknown>).id, object.id);
  } finally { f.store.close(); }
});

test("malformed input is refused by name", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.hatch.openSession({ session_id: "bad id!", opened_at: at }), /unsupported characters/);
    assert.throws(() => f.hatch.openSession({ session_id: "s", opened_at: "nope" }), /must be an ISO timestamp/);
    // Opening the same session twice is idempotent, not an error.
    open(f.hatch, "s1");
    assert.equal((open(f.hatch, "s1").session as Record<string, unknown>).id, "s1");

    assert.throws(() => f.hatch.hatch({ session_id: "missing", intention: "x y z", object_kind: "k", hatched_at: at }),
      /Unknown hatch_session/);
    assert.throws(() => hatch(f.hatch, { intention: "ab" }), /must describe what to work on/);
    assert.throws(() => hatch(f.hatch, { object_kind: "Bad Kind" }), /not a valid kind/);
    assert.throws(() => hatch(f.hatch, { object_id: "bad id!" }), /unsupported characters/);
    assert.throws(() => hatch(f.hatch, { hatched_at: "nope" }), /must be an ISO timestamp/);
    assert.throws(() => f.hatch.getObject({ object_id: "missing" }), /Unknown hatched_object/);
    assert.throws(() => f.hatch.getSession({ session_id: "missing" }), /Unknown hatch_session/);

    const object = hatch(f.hatch).object as Record<string, unknown>;
    const objectId = String(object.id);
    assert.throws(() => f.hatch.requestFields({ object_id: objectId, fields: [] }), /non-empty array/);
    assert.throws(() => f.hatch.requestFields({ object_id: objectId, fields: ["Bad Field"] }), /not a valid field name/);
    assert.throws(() => f.hatch.requestFields({ object_id: objectId, fields: ["a", "a"] }), /unique values/);
    f.hatch.requestFields({ object_id: objectId, fields: ["a", "b"] });
    assert.throws(() => f.hatch.complete({ object_id: objectId, values: [] }), /values must be an object/);
    assert.throws(() => f.hatch.complete({ object_id: objectId, values: {} }), /at least one requested field/);
    assert.throws(() => f.hatch.complete({ object_id: objectId, values: { a: { nested: true } } }), /must be a string, number or boolean/);
    assert.throws(() => f.hatch.complete({ object_id: objectId, values: { a: Number.NaN } }), /finite number/);
    assert.throws(() => f.hatch.list({ origin: "robot" }), /origin must be human or event/);
    assert.throws(() => f.hatch.list({ object_kind: "Bad Kind" }), /not a valid kind/);
  } finally { f.store.close(); }
});
