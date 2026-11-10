import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { ObjectModelKernel } from "../core/object-model.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "craft-objmodel-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const objects = new ObjectModelKernel(store);
  objects.defineKind({ kind: "migration", initial_state: "hatched",
    states: { hatched: { target_framework: ["fastjson", "jackson"] },
      ready: { target_framework: ["fastjson", "jackson"], rollback_plan: ["flag", "none"] } },
    allowed_actions: ["request_field", "release", "abandon"] });
  return { store, objects };
}

const at = "2030-01-01T00:00:00Z";

test("a kind declares its state domains, and an unknown state is refused", async () => {
  const f = await fixture();
  try {
    // Redefining a kind would reinterpret existing objects' states underneath them.
    assert.throws(() => f.objects.defineKind({ kind: "migration", initial_state: "hatched",
      states: { hatched: { a: ["x"] } } }), /already defined; changing it would reinterpret existing objects/);
    assert.throws(() => f.objects.defineKind({ kind: "k2", initial_state: "nope", states: { hatched: { a: ["x"] } } }),
      /initial_state must be one of the declared states/);
    // An unknown domain cannot be checked, so an empty value list is refused.
    assert.throws(() => f.objects.defineKind({ kind: "k3", initial_state: "s", states: { s: { a: [] } } }),
      /must list its allowed values; an unknown domain cannot be checked/);
    assert.throws(() => f.objects.defineKind({ kind: "k4", initial_state: "s", states: { s: {} } }),
      /must declare the fields it requires/);
    assert.throws(() => f.objects.defineKind({ kind: "bad kind!", initial_state: "s", states: { s: { a: ["x"] } } }),
      /not a valid kind/);
    assert.throws(() => f.objects.defineKind({ kind: "k5", initial_state: "Bad State", states: { s: { a: ["x"] } } }),
      /initial_state is not a machine-checkable state name/);
    assert.throws(() => f.objects.defineKind({ kind: "k6", initial_state: "s", states: { s: { "Bad Field": ["x"] } } }),
      /is not a valid field name/);
    // No states at all means nothing to be in.
    assert.throws(() => f.objects.defineKind({ kind: "k7", initial_state: "s", states: {} }),
      /states must declare at least one state/);
    // A non-array field list is refused by name rather than iterated.
    assert.throws(() => f.objects.defineKind({ kind: "k8", initial_state: "s", states: { s: { a: "x" } } }),
      /must list its allowed values/);
    assert.throws(() => f.objects.defineKind({ kind: "k9", initial_state: "s", states: { s: { a: ["x"] } },
      allowed_actions: "release" }), /allowed_actions must be an array/);
  } finally { f.store.close(); }
});

test("an object carries all nine fields of 5.1 from birth", async () => {
  const f = await fixture();
  try {
    const created = (f.objects.create({ id: "o1", kind: "migration", origin: "human", created_at: at }).object) as Record<string, unknown>;
    // 5.1's list, present immediately: a field that appears only after something happens makes
    // the layout's shape depend on history.
    for (const field of ["id", "kind", "state", "history", "evidence", "pending", "actions", "subscriptions", "origin"]) {
      assert.ok(field in created, `missing ${field}`);
    }
    assert.equal(created.state, "hatched");
    assert.equal(created.origin, "human");
    assert.equal(created.state_revision, 0);
    assert.deepEqual(created.history, []);
    // The creation is on the object's own stream, so the field and the stream agree.
    const events = f.objects.historyOf({ object_id: "o1" }).events as Record<string, unknown>[];
    assert.equal(events.length, 1);
    assert.equal(events[0]!.event_type, "object_created");

    assert.throws(() => f.objects.create({ id: "o1", kind: "migration", origin: "human", created_at: at }),
      /already exists/);
    assert.throws(() => f.objects.create({ id: "o2", kind: "migration", origin: "robot", created_at: at }),
      /origin must be event or human/);
    assert.throws(() => f.objects.create({ id: "o2", kind: "missing", origin: "human", created_at: at }),
      /Unknown object_kind_definition/);
    // A state the kind did not declare cannot be started in.
    assert.throws(() => f.objects.create({ id: "o2", kind: "migration", origin: "human", state: "invented", created_at: at }),
      /state is not declared for this kind/);
  } finally { f.store.close(); }
});

test("the state test is a predicate: fields present and every domain known", async () => {
  const f = await fixture();
  try {
    f.objects.create({ id: "o1", kind: "migration", origin: "human", created_at: at });
    // `hatched` declares only target_framework, so with no values the state is unmeasurable.
    const empty = f.objects.checkState({ object_id: "o1" });
    assert.equal(empty.measurable, false);
    assert.equal(empty.reason, "state_not_measurable");
    assert.deepEqual(empty.missing_fields, ["target_framework"]);
    assert.deepEqual((empty.declared_domains as Record<string, string[]>).target_framework, ["fastjson", "jackson"]);
    // 5.1 forbids unmeasurable descriptions, and the kernel says so rather than pretending.
    assert.equal(empty.rejects_unmeasurable_descriptions, true);

    // With a value inside its domain the state becomes measurable.
    f.store.save("craft_object", "o1", { ...(f.store.get("craft_object", "o1")),
      declared_fields: { target_framework: "jackson" } });
    const ok = f.objects.checkState({ object_id: "o1" });
    assert.equal(ok.measurable, true);
    assert.equal(ok.reason, "measurable");
    assert.deepEqual(ok.missing_fields, []);
    assert.deepEqual(ok.out_of_domain, []);

    // A declared kind with an undeclared state is a third case again, reported separately.
    f.store.save("craft_object", "o1", { ...(f.store.get("craft_object", "o1")), state: "invented" });
    const undeclared = f.objects.checkState({ object_id: "o1" });
    assert.equal(undeclared.measurable, false);
    assert.equal(undeclared.reason, "state_not_declared");
    f.store.save("craft_object", "o1", { ...(f.store.get("craft_object", "o1")), state: "hatched" });

    // A value outside the declared domain is reported with the domain, not just rejected.
    f.store.save("craft_object", "o1", { ...(f.store.get("craft_object", "o1")),
      declared_fields: { target_framework: "gson" } });
    const bad = f.objects.checkState({ object_id: "o1" });
    assert.equal(bad.measurable, false);
    assert.deepEqual(bad.out_of_domain, [{ field: "target_framework", value: "gson", allowed: ["fastjson", "jackson"] }]);

    // An object whose kind has no definition, and whose state is not declared, has nothing to
    // check against — reported as unmeasurable rather than assumed fine.
    f.store.create("craft_object", "orphan", { id: "orphan", kind: "undefined_kind", state: "somewhere",
      origin: "human", history: [], evidence: [], pending: [], subscriptions: [], state_revision: 0 });
    const orphan = f.objects.checkState({ object_id: "orphan" });
    // Nothing to check against is not the same as passing: no declared kind means no domain.
    assert.equal(orphan.measurable, false);
    assert.equal(orphan.reason, "kind_not_defined");
    assert.deepEqual(orphan.declared_domains, {});
    // With no declared state there are no declared actions either.
    assert.deepEqual((f.objects.get({ object_id: "orphan" }).object as Record<string, unknown>).actions, []);
    // An object written by a path that never set `history` reports an empty list rather than
    // undefined, so the history view has the same shape for every object.
    f.store.create("craft_object", "nohistory", { id: "nohistory", kind: "undefined_kind", state: "somewhere",
      origin: "event" });
    assert.deepEqual(f.objects.historyOf({ object_id: "nohistory" }).history, []);
    assert.deepEqual(f.objects.historyOf({ object_id: "orphan" }).history, []);
  } finally { f.store.close(); }
});

test("a transition records who acted, when, and on what basis", async () => {
  const f = await fixture();
  try {
    f.objects.create({ id: "o1", kind: "migration", origin: "human", created_at: at });
    const moved = f.objects.transition({ object_id: "o1", state: "ready", actor: "u1",
      basis: "target confirmed as jackson", at: "2030-01-02T00:00:00Z" });
    const object = moved.object as Record<string, unknown>;
    assert.equal(object.state, "ready");
    assert.equal(object.state_revision, 1);
    const entry = (object.history as Record<string, unknown>[])[0]!;
    // 5.1: 谁在何时据什么改的 — all three, with the basis digested rather than stored verbatim.
    assert.equal(entry.actor, "u1");
    assert.equal(entry.at, "2030-01-02T00:00:00Z");
    assert.equal(entry.from_state, "hatched");
    assert.equal(typeof entry.basis_digest, "string");
    assert.equal(entry.basis, undefined);

    // The revision guard stops two writers acting on the same reading.
    assert.throws(() => f.objects.transition({ object_id: "o1", state: "hatched", actor: "u2",
      basis: "stale", at, expected_revision: 0 }), /Concurrent object state update; refresh before writing/);
    assert.throws(() => f.objects.transition({ object_id: "o1", state: "invented", actor: "u1", basis: "b", at }),
      /state is not declared for this kind/);
    assert.throws(() => f.objects.transition({ object_id: "o1", state: "ready", actor: "u1", basis: "b", at,
      expected_revision: -1 }), /expected_revision must be a non-negative integer/);

    // History accumulates rather than replacing the previous entry.
    f.objects.transition({ object_id: "o1", state: "hatched", actor: "u2", basis: "rolled back", at: "2030-01-03T00:00:00Z" });
    const history = f.objects.get({ object_id: "o1" }).object as Record<string, unknown>;
    assert.equal((history.history as unknown[]).length, 2);
    // The stream carries the full record, which is what makes it auditable.
    assert.equal((f.objects.historyOf({ object_id: "o1" }).events as unknown[]).length, 3);
  } finally { f.store.close(); }
});

test("a card's conclusion is written back to the object it was about", async () => {
  const f = await fixture();
  try {
    f.objects.create({ id: "o1", kind: "migration", origin: "human", pending: ["card-1"], created_at: at });
    const decided = f.objects.recordDecision({ object_id: "o1", card_id: "card-1", conclusion: "approved",
      actor: "u1", at: "2030-01-04T00:00:00Z", basis: "reviewed the prepared state" });
    const object = decided.object as Record<string, unknown>;
    const entry = (object.history as Record<string, unknown>[]).at(-1)!;
    // 5.2.1: the card is short-lived, so the object records the decision and the card's id —
    // not a pointer that would dangle once the card is destroyed.
    assert.equal(entry.kind, "decision");
    assert.equal(entry.card_id, "card-1");
    assert.equal(entry.conclusion, "approved");
    assert.equal(entry.actor, "u1");
    assert.equal(typeof entry.basis_digest, "string");
    // The decision settles the pending item.
    assert.deepEqual(object.pending, []);
    assert.equal((f.objects.historyOf({ object_id: "o1" }).events as Record<string, unknown>[]).at(-1)!.event_type,
      "object_decision_recorded");

    assert.throws(() => f.objects.recordDecision({ object_id: "o1", card_id: "c", conclusion: "maybe",
      actor: "u1", at, basis: "b" }), /conclusion must be approved or rejected/);
    assert.throws(() => f.objects.recordDecision({ object_id: "o1", card_id: "bad id!", conclusion: "approved",
      actor: "u1", at, basis: "b" }), /unsupported characters/);
    assert.throws(() => f.objects.get({ object_id: "missing" }), /Unknown craft_object/);
    assert.throws(() => f.objects.checkState({ object_id: "missing" }), /Unknown craft_object/);
  } finally { f.store.close(); }
});

test("actions are derived from kind, state and permission, and completeness is countable", async () => {
  const f = await fixture();
  try {
    f.objects.create({ id: "o1", kind: "migration", origin: "human", created_at: at });
    // 5.1 says actions follow from kind + state + permission, so they are derived, not stored.
    const derived = f.objects.get({ object_id: "o1" }).object as Record<string, unknown>;
    assert.deepEqual(derived.actions, ["request_field", "release", "abandon"]);
    // With granted permissions the set narrows to what the caller may do.
    f.store.save("craft_object", "o1", { ...(f.store.get("craft_object", "o1")), granted_permissions: ["release"] });
    assert.deepEqual((f.objects.get({ object_id: "o1" }).object as Record<string, unknown>).actions,
      ["release"]);

    // An object whose state was never declared offers no actions, matching checkState's
    // fail-closed reading rather than guessing.
    f.store.save("craft_object", "o1", { ...(f.store.get("craft_object", "o1")), state: "undeclared" });
    assert.deepEqual((f.objects.get({ object_id: "o1" }).object as Record<string, unknown>).actions, []);

    assert.equal((f.objects.list({}).objects as unknown[]).length, 1);
    assert.equal((f.objects.list({ kind: "migration" }).objects as unknown[]).length, 1);
    assert.deepEqual(f.objects.list({ kind: "other" }).objects, []);

    // Completeness turns a missing field into a number rather than a recollection.
    const report = f.objects.completeness({});
    assert.equal(report.total, 1);
    assert.equal(report.complete, 1);
    assert.equal((report.missing_by_field as Record<string, number>).history, 0);
    assert.deepEqual(f.objects.completeness({}) !== undefined, true);
  } finally { f.store.close(); }
});
