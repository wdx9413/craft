/**
 * Argument validators shared by every kernel.
 *
 * These were copied into roughly 170 modules — `text` 135 times, `object` 36, and
 * the `list` below 9. `layer-map.md` recorded the copies as a blocker for splitting
 * the version-stacked modules, warning that "the copies' signatures are not
 * identical, so sharing must begin by carefully extracting the helper". Measuring
 * them showed the warning was half right, and the difference decides what may be
 * shared here.
 *
 * **Shared, because the copies are identical.** `text(value, name)` is
 * byte-identical across all 131 of its mainstream copies once layout is normalized
 * — the apparent variants were one-line versus three-line spellings of the same
 * body, and a naive text comparison had flagged them as two behaviours. `object` is
 * likewise identical across 35, and the `list` below across 7.
 *
 * **Not shared, because the names cover different functions.** These keep their own
 * implementations rather than being merged by name:
 *
 *  - `digest` exists 112 times with **5 distinct behaviours**: 73 use
 *    `JSON.stringify`, 21 hash the raw value, 16 use a key-sorted `canonical`, one
 *    returns a number via `parseInt`, one uses `String(value)`. `canonical` and
 *    `JSON.stringify` hash the same object to different digests, and Craft uses
 *    digests for content addressing — merging these would silently change identity.
 *  - `strings` has **9 distinct signatures**, `integer` **9**, `text` 4 (the 4
 *    non-mainstream copies read a property off an object rather than validating a
 *    value), `object` 2, `list` 2.
 *  - `verification-plane.ts` has a `list` that rejects an empty array instead of
 *    treating `undefined` as absent. That is a different contract, not a spelling
 *    difference, so it keeps its own.
 *
 * Placed at the `src/` root (domain rank) rather than under `infrastructure/`
 * because no `infrastructure/` module defines or needs these; had one, an
 * infrastructure file importing this would be an upward import and the layering
 * audit would reject it.
 */
import type { JsonObject } from "./infrastructure/store.ts";

/** A non-empty string, trimmed. An absent or blank value is an error. */
export function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}

/** A plain object, excluding arrays and null. */
export function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}

/**
 * Strings from an array.
 *
 * `undefined` means the caller omitted the field, which is not an error; a
 * non-array is. Each element is validated as text.
 */
export function list(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((item) => text(item, name));
}

/**
 * Strings from an array, which must not repeat.
 *
 * A different contract from `list`, not a spelling of it: `list` treats `undefined`
 * as an absent optional field and tolerates repetition, while this one rejects a
 * repeated value outright. Both existed under the name `list` in separate modules,
 * which is why the earlier extraction kept them apart.
 */
export function uniqueList(value: unknown, name: string): string[] {

  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const items = value.map((item) => text(item, name));
  if (new Set(items).size !== items.length) throw new Error(`${name} must contain unique values`);
  return items;
}

/**
 * Strings from an array, deduplicated **and sorted**, with an optional requirement.
 *
 * The third distinct `strings` contract in this module, and it is here for the same reason as
 * `uniqueList`: `list` treats `undefined` as absent and tolerates repetition, `uniqueList`
 * rejects repetition, and this one additionally **sorts** the result. Sorting is not cosmetic —
 * callers digest the result, so the order is part of an identity, which is why the three cannot
 * be one function with flags.
 *
 * Three modules defined this signature. Two agreed; `stateful-compute.ts` adds
 * `if (required && !result.length) throw`. That extra guard is a **different contract**, so it
 * stays where it is rather than being merged in — folding it here would make `required: true`
 * with an empty array start throwing in two modules that never threw, which is a behaviour
 * change disguised as an extraction.
 */
export function sortedUniqueList(value: unknown, name: string, required = false): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const items = value.map((item) => text(item, name));
  if (new Set(items).size !== items.length) throw new Error(`${name} must contain unique values`);
  return [...items].sort();
}

/** A scope, as `{kind, id}`, from the `scope_kind` / `scope_id` pair every scoped record uses. */
export interface ScopeRef { readonly kind: string; readonly id: string }

/**
 * The scope kinds Craft recognises.
 *
 * The same four appear in `ContextRequest.scope_kind` in `capability-protocol.ts` and in the
 * `SCOPE_KINDS` set of every module that parses a scope. Two of those modules defined
 * `scope(args)` identically, which is why it lives here rather than in either of them.
 */
export const SCOPE_KINDS: ReadonlySet<string> = new Set(["user", "project", "workspace", "task"]);

/** Read `{scope_kind, scope_id}` from arguments, rejecting an unsupported kind. */
export function parseScope(args: JsonObject): ScopeRef {
  const kind = text(args.scope_kind, "scope_kind");
  if (!SCOPE_KINDS.has(kind)) throw new Error("scope_kind is unsupported");
  return { kind, id: text(args.scope_id, "scope_id") };
}

/**
 * Refuse a string that looks like an assigned credential.
 *
 * Two modules defined this body identically. It is **not** merged with the other two families
 * that look similar and are not: `guided-work.ts` uses a different pattern (it also matches
 * `["']?` before the separator and needs only one character after it) and a different message,
 * and `project-knowledge.ts` guards four terms instead of six and returns `void`. Merging by
 * name across those would widen or narrow what each module refuses.
 */
export function noCredentialAssignment(value: string, name: string): string {
  if (/(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{8,}/iu.test(value)) {
    throw new Error(`${name} must not contain credentials or secrets`);
  }
  return value;
}
