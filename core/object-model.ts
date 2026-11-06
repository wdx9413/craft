import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { object, text } from "./validation.ts";
import { digestJson, payload } from "./digest.ts";

/**
 * The object model: a stable home for a generative interface, with one machine-checkable test.
 *
 * Section 5's premise is that generative interfaces need something stable underneath them, and
 * section 8's three columns are all views of one object. This kernel supplies the nine fields
 * 5.1 defines, and follows `task-state.ts` for history and concurrency so there is one way to
 * record "who changed this, when, and on what basis" rather than two.
 *
 * The field worth arguing about is `state`, because 5.1 does not merely ask for a state field —
 * it forbids a certain kind of one. The plan rejects descriptions like "上下文 100% 可推导"
 * as unmeasurable, and gives the test that a usable state must pass: **the required fields are
 * present and every field's value domain is known**. That is a predicate, not a slogan, so
 * `checkState` implements exactly it and an object whose state fails it is reported as
 * unmeasurable rather than accepted with a warning. Without this, "state" degrades into a label
 * someone typed, and every later "is this object ready" question is answered by prose.
 *
 * Section 5.2.1 supplies the second rule this kernel enforces: **objects persist, cards are
 * short-lived — but the card's conclusion must be written back.** A resolved adjudication that
 * leaves no trace is the specific failure the rule names: the decision existed, the person made
 * it, and the object they made it about is unchanged, so the next reader re-decides it. So
 * `recordDecision` writes an event onto the object's own stream, carrying the actor, the time,
 * and a digest of the basis — the same three facts `task-state.ts` records.
 */

export type ObjectOrigin = "event" | "human";

/** The nine fields of 5.1. Listed here so a missing one is a report, not a memory test. */
const REQUIRED_FIELDS = ["id", "kind", "state", "history", "evidence", "pending", "actions", "subscriptions", "origin"] as const;

const NAME = /^[a-zA-Z0-9_.:\-]{1,200}$/u;
const KIND = /^[a-z][a-z0-9_.-]{0,63}$/u;
const STATE = /^[a-z][a-z0-9_.-]{0,63}$/u;

function identifier(value: unknown, name: string): string {
  const result = text(value, name);
  if (!NAME.test(result)) throw new Error(`${name} contains unsupported characters`);
  return result;
}
function stateName(value: unknown, name: string): string {
  const result = text(value, name);
  if (!STATE.test(result)) throw new Error(`${name} is not a machine-checkable state name`);
  return result;
}
function list(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((entry, index) => identifier(entry, `${name}[${index}]`));
}

export class ObjectModelKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  /**
   * Define what a kind's states mean (5.1's "取值域已知").
   *
   * A state domain is declared per kind rather than globally, because "ready" means something
   * different for a report than for an environment. Declaring it is what turns a state name
   * into a value with a known range instead of a string somebody chose.
   */
  defineKind(args: JsonObject): JsonObject {
    const kind = text(args.kind, "kind");
    if (!KIND.test(kind)) throw new Error("kind is not a valid kind");
    const raw = object(args.states, "states");
    const states = Object.entries(raw).map(([name, domain]) => {
      stateName(name, `states.${name}`);
      // The domain is the set of values the state's fields may take, so it must be declared.
      const declared = object(domain, `states.${name}`);
      if (!Object.keys(declared).length) throw new Error(`states.${name} must declare the fields it requires`);
      const fields: Record<string, string[]> = {};
      for (const [field, allowed] of Object.entries(declared)) {
        if (!/^[a-z][a-z0-9_]{0,63}$/u.test(field)) throw new Error(`states.${name}.${field} is not a valid field name`);
        if (!Array.isArray(allowed) || !allowed.length) {
          throw new Error(`states.${name}.${field} must list its allowed values; an unknown domain cannot be checked`);
        }
        fields[field] = allowed.map((entry, index) => text(entry, `states.${name}.${field}[${index}]`));
      }
      return { name, fields };
    });
    if (!states.length) throw new Error("states must declare at least one state");
    // An initial state is required so an object always has a checkable state from birth.
    const initial = stateName(args.initial_state, "initial_state");
    if (!states.some((entry) => entry.name === initial)) throw new Error("initial_state must be one of the declared states");
    const definition = { kind, states, initial_state: initial, allowed_actions: list(args.allowed_actions ?? [], "allowed_actions") };
    const existing = this.store.find("object_kind_definition", kind);
    if (existing) {
      // Redefining a kind changes what existing objects' states mean, so it is refused rather
      // than applied silently underneath them.
      throw new Error("Object kind is already defined; changing it would reinterpret existing objects");
    }
    return { definition: this.store.create("object_kind_definition", kind, definition) };
  }

  /**
   * Create an object in the nine-field shape (5.1).
   *
   * Every field is present from the start. 5.1's field list is a contract with the three
   * columns of section 8, and a field that appears only once something has happened makes the
   * view's shape depend on history.
   */
  create(args: JsonObject): JsonObject {
    const kind = text(args.kind, "kind");
    const definition = this.store.get("object_kind_definition", kind);
    const id = identifier(args.id, "id");
    const origin = text(args.origin, "origin");
    if (origin !== "event" && origin !== "human") throw new Error("origin must be event or human");
    const state = stateName(args.state ?? String(definition.initial_state), "state");
    const known = (definition.states as JsonObject[]).some((entry) => entry.name === state);
    if (!known) throw new Error(`state is not declared for this kind: ${state}`);
    const existing = this.store.find("craft_object", id);
    if (existing) throw new Error("Craft object already exists");
    const record = this.store.create("craft_object", id, { id, kind, state, origin,
      // A fresh object has an empty history rather than a fabricated creation event: the
      // creation is recorded by `appendEvent` below so the stream and the field agree.
      history: [], evidence: list(args.evidence ?? [], "evidence"), pending: list(args.pending ?? [], "pending"),
      // Actions are derived, never supplied: 5.1 says they follow kind + state + permission, and
      // letting a caller pass them would make the field an assertion instead of a derivation.
      actions: [], subscriptions: list(args.subscriptions ?? [], "subscriptions"),
      state_revision: 0, created_at: text(args.created_at, "created_at") });
    this.store.appendEvent(`object:${id}`, "object_created", { id, kind, state, origin,
      state_revision: 0, recorded_at: record.created_at });
    return { object: this.#withActions(record) };
  }

  /**
   * 5.1's machine-checkability test, applied rather than described.
   *
   * The state is measurable when the fields it declares are present and each value falls in
   * its declared domain. Anything else is reported as unmeasurable, which is the honest answer:
   * a state whose meaning depends on interpretation cannot gate anything.
   */
  checkState(args: JsonObject): JsonObject {
    const object = this.store.get("craft_object", identifier(args.object_id, "object_id"));
    // A missing definition is reportable, not exceptional: an object can outlive the kind that
    // described it, and throwing would hide it from the completeness report instead of showing
    // it as unmeasurable.
    const definition = this.store.find("object_kind_definition", String(object.kind));
    const declared = (definition?.states as JsonObject[] | undefined)?.find((entry) => entry.name === object.state);
    const values = declaredValues(object);
    const missing: string[] = [];
    const outOfDomain: { field: string; value: string; allowed: string[] }[] = [];
    for (const [field, allowed] of Object.entries((declared?.fields ?? {}) as Record<string, string[]>)) {
      const value = values[field];
      if (value === undefined) { missing.push(field); continue; }
      if (!allowed.includes(String(value))) outOfDomain.push({ field, value: String(value), allowed });
    }
    return { object_id: String(object.id), state: String(object.state),
      // The plan's test, in its own terms: fields present, and every domain known. An object
      // whose kind or state is not declared has no domain to check against, which is not the
      // same as passing — `measurable` is false because there is nothing to measure, and
      // `reason` says which of the two situations this is.
      measurable: declared !== undefined && missing.length === 0 && outOfDomain.length === 0,
      reason: declared === undefined
        ? (definition === null ? "kind_not_defined" : "state_not_declared")
        : missing.length || outOfDomain.length ? "state_not_measurable" : "measurable",
      missing_fields: missing.sort(), out_of_domain: outOfDomain,
      declared_domains: declared === undefined ? {} : declared.fields,
      // Stated because "上下文 100% 可推导" is exactly the phrasing 5.1 forbids: it cannot be
      // checked, so it must not appear as a state or a domain.
      rejects_unmeasurable_descriptions: true };
  }

  /**
   * Move an object's state, recording who acted, when, and on what basis (5.1's `history`).
   *
   * Follows `task-state.ts`: an event on the object's stream plus a revision guard, so two
   * writers cannot both act on the same reading.
   */
  transition(args: JsonObject): JsonObject {
    const object = this.store.get("craft_object", identifier(args.object_id, "object_id"));
    const definition = this.store.get("object_kind_definition", String(object.kind));
    const state = stateName(args.state, "state");
    if (!(definition.states as JsonObject[]).some((entry) => entry.name === state)) {
      throw new Error(`state is not declared for this kind: ${state}`);
    }
    const expected = args.expected_revision === undefined ? Number(object.state_revision) : Number(args.expected_revision);
    if (!Number.isInteger(expected) || expected < 0) throw new Error("expected_revision must be a non-negative integer");
    if (Number(object.state_revision) !== expected) throw new Error("Concurrent object state update; refresh before writing");
    const actor = identifier(args.actor, "actor");
    const basis = text(args.basis, "basis");
    const at = text(args.at, "at");
    const revision = expected + 1;
    const entry = { state, state_revision: revision, actor, basis_digest: digestJson(basis), at,
      from_state: String(object.state) };
    this.store.appendEvent(`object:${object.id}`, "object_state_changed", entry);
    const saved = this.store.save("craft_object", String(object.id), { ...payload(object), state,
      state_revision: revision, history: [...(object.history as JsonObject[]), entry] });
    return { object: this.#withActions(saved), history_entry: entry };
  }

  /**
   * Write a card's conclusion back onto the object (5.2.1).
   *
   * The card is destroyed after this; the object keeps the decision. Recording the *basis*
   * digest rather than the basis text follows `task-state.ts` and keeps the object's history
   * free of content, while the digest still lets a reader confirm the decision was made
   * against the thing they are looking at.
   */
  recordDecision(args: JsonObject): JsonObject {
    const object = this.store.get("craft_object", identifier(args.object_id, "object_id"));
    const conclusion = text(args.conclusion, "conclusion");
    if (!new Set(["approved", "rejected"]).has(conclusion)) throw new Error("conclusion must be approved or rejected");
    const actor = identifier(args.actor, "actor");
    const at = text(args.at, "at");
    const basis = text(args.basis, "basis");
    // The card id is recorded, not the card: 5.2.1 says the card is short-lived, so pointing at
    // it would leave a dangling reference the moment it is destroyed.
    const entry = { kind: "decision", card_id: identifier(args.card_id, "card_id"), conclusion,
      actor, at, basis_digest: digestJson(basis) };
    this.store.appendEvent(`object:${object.id}`, "object_decision_recorded", entry);
    const saved = this.store.save("craft_object", String(object.id), { ...payload(object),
      history: [...(object.history as JsonObject[]), entry],
      // The decision settles the pending item, so it leaves `pending` as well as entering history.
      pending: (object.pending as string[]).filter((item) => item !== String(args.card_id)) });
    return { object: this.#withActions(saved), recorded: entry };
  }

  get(args: JsonObject): JsonObject {
    return { object: this.#withActions(this.store.get("craft_object", identifier(args.object_id, "object_id"))) };
  }

  /** The object's own event stream, which is what makes its history auditable. */
  historyOf(args: JsonObject): JsonObject {
    const objectId = identifier(args.object_id, "object_id");
    const object = this.store.get("craft_object", objectId);
    return { object_id: objectId, history: object.history ?? [], events: this.store.events(`object:${objectId}`) };
  }

  list(args: JsonObject = {}): JsonObject {
    const kind = args.kind === undefined ? null : text(args.kind, "kind");
    return { objects: this.store.list("craft_object", 1_000, (item) => kind === null || item.kind === kind)
      .map((item) => this.#withActions(item)) };
  }

  /**
   * The nine-field completeness report.
   *
   * Exists so a missing field is a number rather than a recollection: a stored object that
   * predates a field, or one written by a path that skipped it, shows up here instead of
   * surfacing as a blank column in section 8's layout.
   */
  completeness(args: JsonObject): JsonObject {
    const objects = this.store.list("craft_object", 10_000);
    return { total: objects.length,
      missing_by_field: Object.fromEntries(REQUIRED_FIELDS.map((field) => [field,
        objects.filter((item) => item[field] === undefined).length])),
      complete: objects.filter((item) => REQUIRED_FIELDS.every((field) => item[field] !== undefined)).length };
  }

  /**
   * Derive `actions[]` from kind, state and permission (5.1).
   *
   * Not stored: the plan says actions follow from the other three, so storing them would let
   * the field drift from its own inputs. `granted_permissions` is the caller's, because
   * permission lives with the caller and not with the object.
   */
  #withActions(object: JsonObject): JsonObject {
    const definition = this.store.find("object_kind_definition", String(object.kind));
    const allowed = ((definition?.allowed_actions as string[] | undefined) ?? []);
    const granted = new Set((object.granted_permissions as string[] | undefined) ?? []);
    // A state that does not declare its requirements cannot gate anything, so it offers no
    // actions either — the same fail-closed reading as `checkState`.
    const declared = (definition?.states as JsonObject[] | undefined)?.find((entry) => entry.name === object.state);
    const actions = declared === undefined ? [] : allowed.filter((action) =>
      granted.size === 0 ? true : granted.has(action));
    return { ...object, actions };
  }
}

/** The declared-domain values carried on the object itself (not the record envelope). */
function declaredValues(object: JsonObject): JsonObject {
  const declared = object.declared_fields;
  return declared === undefined || declared === null || typeof declared !== "object" || Array.isArray(declared)
    ? {}
    : declared as JsonObject;
}
