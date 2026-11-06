import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { text } from "./validation.ts";
import { payload, stableDigest } from "./digest.ts";

/**
 * Object hatching: the one narrow job free expression is allowed to do.
 *
 * Most work objects arrive from an event — a Binlog offset moves, a webhook fires, a branch
 * is pushed. Section 5.3 is about the other half: an intention with no event behind it.
 * "Evaluate migrating the serialization library" is not triggered by anything; somebody has
 * to say it. That is the one moment free expression is the right interface, and the plan
 * constrains it hard because the same door opens onto a much worse design:
 *
 * > Continuous back-and-forth in the free-expression area turns "create an object" into
 * > "chat", and once chat is allowed there the centre column fills with conversation —
 * > which is red line one. The interface the whole plan exists to avoid comes back through
 * > the one entrance left open.
 *
 * So this kernel makes that entrance narrow in a way the code enforces rather than the
 * documentation requests:
 *
 *  1. **A hatch produces exactly one object and closes.** The session is terminal after a
 *     single hatch; a second `hatch` on the same session is refused. There is no "continue".
 *  2. **The origin is recorded as `human`.** An object that came from a person is
 *     distinguishable from one an event produced, which matters later: the two have
 *     different evidence behind them.
 *  3. **Missing information is gathered structurally, never by returning to free
 *     expression.** When the hatched object turns out to need more, the completion request
 *     names the fields it wants, and `complete` accepts exactly those fields. A caller
 *     cannot answer with prose because there is nowhere to put it.
 *
 * The third rule is the one that needs machinery. A rule that says "do not go back to
 * chatting" is unenforceable on its own; a rule that says "this call accepts these named
 * fields and rejects anything else" is enforced by the validator. The exit is therefore a
 * closed set of typed fields rather than a text box, and the kernel refuses a completion
 * that supplies a field nobody asked for.
 */

export type ObjectOrigin = "human" | "event";

const NAME = /^[a-zA-Z0-9_.:-]{1,200}$/u;
const KIND = /^[a-z][a-z0-9_.-]{0,63}$/u;
const FIELD = /^[a-z][a-z0-9_]{0,63}$/u;

function identifier(value: unknown, name: string): string {
  const result = text(value, name);
  if (!NAME.test(result)) throw new Error(`${name} contains unsupported characters`);
  return result;
}
function kind(value: unknown, name: string): string {
  const result = text(value, name);
  if (!KIND.test(result)) throw new Error(`${name} is not a valid kind`);
  return result;
}
function fieldName(value: unknown, name: string): string {
  const result = text(value, name);
  if (!FIELD.test(result)) throw new Error(`${name} is not a valid field name`);
  return result;
}
function instant(value: unknown, name: string): string {
  const result = text(value, name);
  if (Number.isNaN(Date.parse(result))) throw new Error(`${name} must be an ISO timestamp`);
  return result;
}

/**
 * Derive an object id from the expressed intention.
 *
 * Deterministic and content-addressed rather than random, so expressing the same intention
 * twice yields the same object instead of two near-identical ones. A random id would make
 * the second hatch a duplicate the user has to notice and clean up.
 *
 * The id is a digest rather than a readable prefix of the intention. An earlier version
 * sliced the first 24 characters of a base64 encoding, which collided for any two
 * intentions sharing an opening phrase — "Evaluate migrating the serialization library" and
 * "Evaluate migrating the cache layer" produced the same id, so the second hatch was
 * refused as a duplicate of an unrelated object. A digest of the whole normalized string
 * cannot collide that way.
 */
function deriveId(objectKind: string, intention: string): string {
  // Normalized before hashing, so casing and surrounding whitespace do not create a second
  // object for one intention.
  const normalized = intention.trim().replace(/\s+/gu, " ").toLowerCase();
  return `${objectKind}_${stableDigest(normalized).slice("sha256:".length, "sha256:".length + 16)}`;
}

export class ObjectHatchingKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  /**
   * Open a free-expression session.
   *
   * A session is the container for the single hatch it is allowed to produce. It is
   * explicitly a one-shot: the record carries the limit so a later `hatch` can refuse
   * without needing to infer intent from a count.
   */
  openSession(args: JsonObject): JsonObject {
    const sessionId = identifier(args.session_id, "session_id");
    const openedAt = instant(args.opened_at, "opened_at");
    const existing = this.store.find("hatch_session", sessionId);
    if (existing) return { session: existing, idempotent: true };
    return { session: this.store.create("hatch_session", sessionId, {
      status: "open", hatch_limit: 1, hatched_object_id: null, opened_at: openedAt, closed_at: null,
      // Free expression is for creating, not for conversing. Recording the turn limit on
      // the session keeps that a property of the session rather than a UI convention.
      conversation_turns_allowed: 0,
    }), idempotent: false };
  }

  /**
   * Hatch one object from an expressed intention, and close the session.
   *
   * The session closing is not a separate step a caller can forget: it happens here,
   * because a session left open is exactly the free-expression area that would be used for
   * a second turn.
   */
  hatch(args: JsonObject): JsonObject {
    const sessionId = identifier(args.session_id, "session_id");
    const session = this.store.get("hatch_session", sessionId);
    if (session.status !== "open") throw new Error("Hatch session is closed; free expression produces one object and closes");
    const intention = text(args.intention, "intention");
    if (intention.trim().length < 3) throw new Error("intention must describe what to work on");
    const objectKind = kind(args.object_kind, "object_kind");
    const objectId = args.object_id === undefined ? deriveId(objectKind, intention) : identifier(args.object_id, "object_id");
    const hatchedAt = instant(args.hatched_at, "hatched_at");

    // The object is the durable thing; the session is scaffolding that is discarded. This
    // is why the object carries `origin` and the session does not.
    const object = this.store.create("hatched_object", objectId, {
      object_kind: objectKind, origin: "human" satisfies ObjectOrigin, intention,
      // The intention is kept verbatim as the object's opening statement. It is the only
      // free text in the record, and it is written once rather than appended to.
      fields: {}, pending_fields: [], state: "hatched", hatched_at: hatchedAt,
    });
    this.store.save("hatch_session", sessionId, { ...payload(session), status: "closed",
      hatched_object_id: objectId, closed_at: hatchedAt });
    return { object, session_closed: true };
  }

  getObject(args: JsonObject): JsonObject {
    return { object: this.store.get("hatched_object", identifier(args.object_id, "object_id")) };
  }

  getSession(args: JsonObject): JsonObject {
    return { session: this.store.get("hatch_session", identifier(args.session_id, "session_id")) };
  }

  /**
   * Ask for specific missing fields (5.3's structured-completion exit).
   *
   * The request names the fields. It does not ask a question in prose, because the answer
   * to a prose question is prose, and prose is the conversation this design removes.
   */
  requestFields(args: JsonObject): JsonObject {
    const object = this.store.get("hatched_object", identifier(args.object_id, "object_id"));
    if (!Array.isArray(args.fields) || !args.fields.length) throw new Error("fields must be a non-empty array");
    const requested = args.fields.map((value, index) => fieldName(value, `fields[${index}]`));
    if (new Set(requested).size !== requested.length) throw new Error("fields must contain unique values");
    const known = new Set(Object.keys(object.fields as JsonObject));
    const pending = new Set(object.pending_fields as string[]);
    for (const name of requested) {
      // Asking again for a field that is already filled, or already pending, would let the
      // same card be raised repeatedly — the decision-fatigue failure section 6.4 covers.
      if (known.has(name)) throw new Error(`field is already filled: ${name}`);
      if (pending.has(name)) throw new Error(`field is already requested: ${name}`);
    }
    const saved = this.store.save("hatched_object", String(object.id), { ...payload(object),
      pending_fields: [...pending, ...requested].sort(), state: "awaiting_fields" });
    return { object: saved, requested_fields: [...requested].sort() };
  }

  /**
   * Supply the requested fields.
   *
   * The accepted set is exactly what was requested. A field nobody asked for is refused
   * rather than stored, because accepting it would make this a free-form channel by
   * another name — the caller could put anything in, which is the chat door reopening.
   */
  complete(args: JsonObject): JsonObject {
    const object = this.store.get("hatched_object", identifier(args.object_id, "object_id"));
    const pending = object.pending_fields as string[];
    if (!pending.length) throw new Error("object has no pending field request");
    if (!args.values || typeof args.values !== "object" || Array.isArray(args.values)) throw new Error("values must be an object");
    const supplied = Object.keys(args.values as JsonObject);
    if (!supplied.length) throw new Error("values must supply at least one requested field");
    const unexpected = supplied.filter((name) => !pending.includes(name)).sort();
    if (unexpected.length) {
      throw new Error(`values contains field(s) that were not requested: ${unexpected.join(", ")}`);
    }
    const missing = pending.filter((name) => !supplied.includes(name));
    const merged = { ...(object.fields as JsonObject) };
    for (const [name, value] of Object.entries(args.values as JsonObject)) {
      // Values are scalars for the same reason the receipt payload is flat: a nested value
      // needs a canonicalization rule, and every such rule is a way for two callers to
      // disagree about whether they supplied the same thing.
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new Error(`values.${name} must be a string, number or boolean`);
      }
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`values.${name} must be a finite number`);
      merged[name] = value;
    }
    const saved = this.store.save("hatched_object", String(object.id), { ...payload(object), fields: merged,
      pending_fields: missing, state: missing.length ? "awaiting_fields" : "ready" });
    return { object: saved, remaining_fields: missing };
  }

  list(args: JsonObject = {}): JsonObject {
    const objectKind = args.object_kind === undefined ? null : kind(args.object_kind, "object_kind");
    const origin = args.origin === undefined ? null : text(args.origin, "origin");
    if (origin !== null && origin !== "human" && origin !== "event") throw new Error("origin must be human or event");
    return { objects: this.store.list("hatched_object", 1_000, (item) =>
      (objectKind === null || item.object_kind === objectKind) && (origin === null || item.origin === origin)) };
  }
}
