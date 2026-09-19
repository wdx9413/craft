/**
 * Content digests and record payloads, shared across kernels.
 *
 * `layer-map.md` recorded that extracting shared helpers had to precede splitting the
 * multi-kernel modules, and flagged that the copies "are not identical". Measured in
 * full — not truncated — the picture is:
 *
 *  - `digest` exists 112 times in **11 distinct (params + body) shapes**. The
 *    dominant one is 81 copies of `JSON.stringify`, and it is shared here as
 *    `digestJson`. It sits beside a second 17-copy variant whose body hashes a
 *    key-sorted `canonical(value)` instead.
 *  - `payload` exists 73 times in **3 shapes that differ only in local variable
 *    names** (`...rest` versus `...value`, `_created` versus `_createdAt`). Behaviour
 *    is identical, so all 73 are shared.
 *  - `positive` exists 4 times in 4 genuinely different signatures and is
 *    deliberately not shared.
 *
 * ### Why the digest name matters
 *
 * `digestJson` and the key-sorted variant are not interchangeable:
 * `digestJson({a:1,b:2})` and `digestJson({b:2,a:1})` produce **different** digests,
 * while a key-sorted digest produces the same one. Craft uses digests for content
 * addressing, so choosing the wrong one silently changes a record's identity — and
 * `digest` alone does not say which it is. Naming them apart is the whole reason this
 * module exists rather than one shared `digest`.
 *
 * The key-sorted variant is shared here as `stableDigest`, built on `canonicalJson`. The
 * paragraph that used to end this list said it was "not exported yet: its 17 copies agree with
 * each other, but the `canonical` helper they depend on is itself duplicated with differing
 * definitions, so it needs its own decision" — that decision has now been made, by measuring
 * rather than by reading:
 *
 *  - `canonical` exists **18 times in 14 distinct (params + body) spellings**, and all 14 are
 *    **one behaviour**: arrays as `[a,b]`, objects as `{"k":v}` with keys sorted by
 *    `localeCompare`, everything else as `JSON.stringify`. The spellings differ only in
 *    parameter names (`a/b`, `left/right`, `k/v`, `child/item/entry`) and in whether the body
 *    is wrapped across lines. They are therefore merged, which is the opposite conclusion from
 *    `digest` — and the difference is the point: `digest` had five *behaviours*, `canonical`
 *    has one appearance problem.
 *  - the 17 copies of the digest **do** agree, all `sha256:`-prefixed. A **18th** caller is not
 *    among them: `craft-service.ts` has a `fingerprint` that hashes the same serialization and
 *    returns bare hex, with callers that add `sha256:` themselves. It keeps its own name,
 *    because it has a different public shape rather than a different algorithm.
 */
import { createHash } from "node:crypto";
import type { JsonObject } from "./infrastructure/store.ts";

/**
 * Digest of the JSON serialization of a value.
 *
 * **Key order is significant**: two objects with the same pairs in a different order
 * produce different digests. That is the right choice for a value whose shape is
 * fixed by its producer, and it is what 81 call sites already relied on.
 */
export function digestJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

/**
 * A serialization that does not depend on key order, so equal records digest equally.
 *
 * The counterpart to {@link digestJson}, and not interchangeable with it:
 * `digestJson({a:1,b:2})` and `digestJson({b:2,a:1})` differ, while `stableDigest` of the same
 * two produces one value. Craft uses digests for content addressing, so this is a choice about
 * a record's identity, not about formatting.
 *
 * A top-level `undefined` is refused by name. The 18 merged copies ended in
 * `JSON.stringify(value)`, which returns **`undefined`** rather than a string for `undefined`,
 * a function or a symbol — so `Hash.update` raised `ERR_INVALID_ARG_TYPE`, naming the crypto
 * call instead of the input. Naming it here is the only behaviour change in the merge, and it
 * affects only inputs the old code could not serialize either.
 *
 * Nested `undefined` is **not** refused, because refusing it would change identity: see
 * {@link nested} for the two different renderings the original copies produced and this
 * preserves. A golden-digest test caught an earlier version of this function that rendered a
 * nested `undefined` one way everywhere and silently changed the digest of `[undefined]`.
 */
export function canonicalJson(value: unknown): string {
  const serialized = nested(value);
  if (serialized === undefined) throw new Error(`canonicalJson cannot serialize ${typeof value}`);
  return serialized;
}

/**
 * The recursion, which must return `undefined` verbatim rather than a string.
 *
 * This is not a style choice. The original 18 copies interpolated the recursion into two
 * different templates, and JavaScript renders `undefined` differently in each:
 *
 * | position | expression | `undefined` renders as |
 * |---|---|---|
 * | array element | `[${items.map(f).join(",")}]` | `` (empty — `Array.join` maps `undefined` and holes to "") |
 * | object value | `` `${JSON.stringify(k)}:${f(v)}` `` | `undefined` (template interpolation) |
 *
 * Returning `undefined` from here reproduces both for free, which is why the function is typed
 * `string | undefined` and is private: callers get {@link canonicalJson}, which guarantees a
 * string or throws.
 */
function nested(value: unknown): string | undefined {
  if (Array.isArray(value)) return `[${value.map((item) => nested(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonObject).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${nested(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * A content address that does not depend on key order.
 *
 * The `sha256:` prefix is part of the returned value and therefore part of the identity a
 * record stores, which is why the one prefix-less variant next door is not merged into this.
 */
export function stableDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

/**
 * A stored record's own content, without the store's bookkeeping.
 *
 * `id`, `version` and the timestamps describe where the record lives, not what it
 * says; identity digests are computed over the remainder. Dropping them here is what
 * makes an idempotency check compare meaning rather than storage metadata.
 */
export function payload(record: JsonObject): JsonObject {
  const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record;
  return rest;
}
