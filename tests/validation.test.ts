import assert from "node:assert/strict";
import test from "node:test";
import {
  SCOPE_KINDS,
  list,
  noCredentialAssignment,
  object,
  fallback,
  optionalScope,
  optionalText,
  parseScope,
  sortedUniqueList,
  text,
  uniqueList,
} from "../src/validation.ts";

/**
 * The shared validators, which had no test of their own.
 *
 * `validation.ts` exists because roughly 170 modules carried copies, and its own doc records the
 * rule that decided which copies could be merged: **merge only where the behaviour agrees**. That
 * rule is only worth anything if the behaviours are pinned somewhere, and until this file existed
 * they were pinned only by the modules that happened to call them.
 *
 * The three list-shaped validators are deliberately separate functions rather than one function
 * with flags, so each one's contract is asserted here in the terms that distinguish it:
 *
 * | function | `undefined` | repetitions | order |
 * |---|---|---|---|
 * | `list` | absent, not an error | tolerated | as given |
 * | `uniqueList` | absent, not an error | rejected | as given |
 * | `sortedUniqueList` | absent unless `required` | rejected | **sorted** |
 */

test("v0.12.43 reads a non-empty trimmed string", () => {
  assert.equal(text("  value  ", "name"), "value");
  assert.equal(text("x", "name"), "x");
  for (const bad of [undefined, null, "", "   ", 1, true, {}, []]) {
    assert.throws(() => text(bad, "field"), /field must not be empty/u, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("v0.12.43 reads a plain object and refuses arrays and null", () => {
  const value = { a: 1 };
  assert.equal(object(value, "name"), value);
  assert.deepEqual(object({}, "name"), {});
  // An array is an object in JavaScript and is still not one here, which is the whole reason
  // this validator exists rather than a `typeof` check at each call site.
  for (const bad of [undefined, null, [], [1], "x", 0, false]) {
    assert.throws(() => object(bad, "field"), /field must be an object/u, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("v0.12.43 distinguishes the three list contracts", () => {
  // `list`: `undefined` is an absent optional field, and a repeat is tolerated.
  assert.deepEqual(list(undefined, "f"), []);
  assert.deepEqual(list(["b", "a", "b"], "f"), ["b", "a", "b"]);
  assert.deepEqual(list([], "f"), []);
  assert.throws(() => list("x", "f"), /f must be an array/u);
  assert.throws(() => list([1], "f"), /f must not be empty/u);

  // `uniqueList`: same treatment of `undefined`, but a repeat is an error.
  assert.deepEqual(uniqueList(undefined, "f"), []);
  assert.deepEqual(uniqueList(["b", "a"], "f"), ["b", "a"], "order is preserved, not normalized");
  assert.deepEqual(uniqueList([], "f"), []);
  assert.throws(() => uniqueList(["a", "a"], "f"), /f must contain unique values/u);
  assert.throws(() => uniqueList("x", "f"), /f must be an array/u);

  // `sortedUniqueList`: rejects a repeat *and* sorts, because callers digest the result and the
  // order is therefore part of an identity rather than cosmetics.
  assert.deepEqual(sortedUniqueList(["b", "a"], "f"), ["a", "b"]);
  assert.deepEqual(sortedUniqueList(undefined, "f"), []);
  assert.deepEqual(sortedUniqueList([], "f"), []);
  // The input array is not reordered in place: a caller that kept a reference would otherwise see
  // it change under them.
  const given = ["b", "a"];
  assert.deepEqual(sortedUniqueList(given, "f"), ["a", "b"]);
  assert.deepEqual(given, ["b", "a"]);
  assert.throws(() => sortedUniqueList(["a", "a"], "f"), /f must contain unique values/u);
  assert.throws(() => sortedUniqueList([1], "f"), /f must not be empty/u);

  // `required`: an omitted value becomes an error instead of an empty result.
  assert.deepEqual(sortedUniqueList(["a"], "f", true), ["a"]);
  assert.throws(() => sortedUniqueList(undefined, "f", true), /f must be an array/u);
  assert.deepEqual(sortedUniqueList([], "f", true), [], "an empty array is still an array");
});

test("v0.12.43 records why stateful-compute keeps its own stricter strings", async () => {
  // The divergence is a contract difference, not a spelling difference, and this is the assertion
  // that keeps the recorded reason honest: `stateful-compute.ts` throws for `required: true` with
  // an empty array, and `sortedUniqueList` does not. If that module is ever migrated, this test
  // fails and the migration has to be a deliberate behaviour change.
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/stateful-compute.ts", import.meta.url), "utf8"));
  assert.match(source, /function strings\(value: unknown, name: string, required = false\)/u);
  assert.match(source, /required && !result\.length/u);
  // And the shared one does not carry that guard, so the two cannot have been the same function.
  assert.deepEqual(sortedUniqueList([], "f", true), []);
});

test("v0.12.43 reads a scope and refuses an unsupported kind", () => {
  assert.deepEqual([...SCOPE_KINDS], ["user", "project", "workspace", "task", "session"]);
  assert.deepEqual(parseScope({ scope_kind: "project", scope_id: "p" }), { kind: "project", id: "p" });
  for (const kind of SCOPE_KINDS) assert.equal(parseScope({ scope_kind: kind, scope_id: "x" }).kind, kind);
  assert.throws(() => parseScope({ scope_kind: "global", scope_id: "p" }), /scope_kind is unsupported/u);
  assert.throws(() => parseScope({ scope_id: "p" }), /scope_kind must not be empty/u);
  assert.throws(() => parseScope({ scope_kind: "project" }), /scope_id must not be empty/u);
  // The kind is validated before the id, so a fully empty call reports the kind rather than
  // whichever field happened to be read first.
  assert.throws(() => parseScope({}), /scope_kind/u);
});

test("v0.12.43 refuses an assigned credential but not the words alone", () => {
  assert.equal(noCredentialAssignment("ordinary text", "field"), "ordinary text");
  // A secret-like *assignment* is refused in each spelling the pattern covers.
  for (const bad of [
    "api_key=abcdefgh", "api-key: abcdefgh", "API_KEY = abcdefgh", "token=12345678",
    "password: hunter2hunter2", "secret=abcdefgh", "cookie=abcdefgh",
  ]) assert.throws(() => noCredentialAssignment(bad, "field"), /field must not contain credentials or secrets/u, bad);
  // Naming a credential is fine; assigning a long value is not. Both directions are asserted
  // because a pattern that refused the word itself would break ordinary documentation.
  assert.equal(noCredentialAssignment("set the token in your environment", "field"), "set the token in your environment");
  assert.equal(noCredentialAssignment("token=", "field"), "token=");
  // Shorter than the eight-character floor, so it is a placeholder rather than a credential.
  assert.equal(noCredentialAssignment("token=short", "field"), "token=short");
});

test("v0.12.43 records the authorization-header gap it does not close", () => {
  // Found by writing this test, and recorded rather than fixed: the pattern requires eight
  // non-space characters *immediately* after the separator, and a scheme word is shorter than
  // that. So the most recognisable credential form there is slips through.
  assert.equal(noCredentialAssignment("authorization: Bearer abcdefgh", "field"), "authorization: Bearer abcdefgh");
  assert.equal(noCredentialAssignment("Authorization: Basic dXNlcjpwYXNz", "field"), "Authorization: Basic dXNlcjpwYXNz");
  // What it *does* catch is the compact form, which is why the gap is narrow but real.
  assert.throws(() => noCredentialAssignment("authorization: Bearerabcdefgh", "field"), /credentials/u);
  // Widening the pattern would change what two kernels refuse, so it is a decision with its own
  // blast radius rather than a drive-by fix during a split. Pinned here so it cannot be lost.
});

test("v0.12.43 keeps the shared helpers from widening what a caller refuses", async () => {
  // The two look-alike guards that were deliberately **not** merged, asserted so the reason stays
  // true. `guided-work.ts` matches a different pattern with a different message, and
  // `project-knowledge.ts` guards four terms instead of six and returns nothing.
  const read = (name: string) => import("node:fs/promises").then((fs) => fs.readFile(new URL(`../${name}`, import.meta.url), "utf8"));
  const guided = await read("src/guided-work.ts");
  assert.match(guided, /function noSecret\(value: string, name: string\): string/u);
  assert.match(guided, /sensitive assignments/u);
  const project = await read("capability/craft-knowledge/project-knowledge.ts");
  assert.match(project, /function noSecret\(value: string\): void/u);
  assert.match(project, /Project Knowledge content appears to contain a secret/u);
  // It also keeps its own two digests, one of which hashes `String(value)` rather than the JSON
  // serialization — the "one copy returns a different thing" case `layer-map.md` recorded, and
  // the reason neither was merged into `digestJson` or `stableDigest`.
  assert.match(project, /function digest\(value: unknown\): string \{ return `sha256:\$\{createHash\("sha256"\)\.update\(String\(value\)\)/u);
  assert.match(project, /function recordDigest\(value: unknown\): string/u);
});

test("v0.12.34 an absent scope is reported rather than searched, and a half scope still fails", () => {
  // A read-only resolution must not fail a turn because the Host could not name a scope, and it
  // must not fall back to searching every scope either.
  assert.equal(optionalScope({}), null);
  assert.equal(optionalScope({ scope_kind: "  ", scope_id: null }), null);
  assert.deepEqual(optionalScope({ scope_kind: "session", scope_id: "s" }), { kind: "session", id: "s" });
  // Half a scope is a caller bug: the caller meant to name one.
  assert.throws(() => optionalScope({ scope_kind: "project" }), /scope_id/u);
  assert.throws(() => optionalScope({ scope_id: "p" }), /scope_kind/u);
});

test("v0.12.34 the shared default helpers keep absence and null apart", () => {
  assert.equal(fallback(undefined, "d"), "d");
  assert.equal(fallback("v", "d"), "v");
  // `null` is a value, not an absence: a default must not replace it.
  assert.equal(fallback(null, "d"), null);
  assert.equal(optionalText(undefined, "name"), null);
  assert.equal(optionalText(" v ", "name"), "v");
  assert.throws(() => optionalText("", "name"), /name/u);
});
