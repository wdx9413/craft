import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalJson, digestJson, payload, stableDigest } from "../src/digest.ts";

/** What the digest of a string is, computed without going through the module under test. */
const sha256Of = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/**
 * The two digests are not interchangeable, and this module exists because of that.
 *
 * `digest.ts` says of itself: *"Craft uses digests for content addressing, so choosing the wrong
 * one silently changes a record's identity — and `digest` alone does not say which it is."*
 * Nothing tested that claim, and no test imported this module at all, so the distinction was
 * carried by prose in 18 files.
 */

/**
 * Digests captured from the implementation **before** it was extracted.
 *
 * The 18 copies of `canonical` were merged into one; a merge like that is only safe if the
 * merged function produces byte-identical output, so these values were produced by the original
 * body (`tests` cannot show that by re-deriving them from the new one — that would be circular).
 * They are the migration's evidence, not a restatement of it.
 */
const GOLDEN: ReadonlyArray<[string, unknown, string]> = [
  ["empty-object", {}, "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"],
  ["ordered", { a: 1, b: 2 }, "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"],
  ["nested", { z: { y: [1, 2, { x: "w" }] }, a: null }, "sha256:13ca25f953f5d6adc80fec1681d8c13be6df32eb7c9c0d26e5f88ef55529a59a"],
  ["array", [1, "two", { three: 3 }, [4]], "sha256:95622b6cc541c61dcaf28d678257ceab310e25f669bfc6695a7c231651c3c83b"],
  ["scalars", [0, -1, 1.5, true, false, null, ""], "sha256:20eb9b4c13dbd6b3475d738248e324bd1c182111b98f943ee3a99ddee59c947f"],
  ["unicode", { "键": "值", emoji: "🚀", combined: "é" }, "sha256:dc1b0dd17616217d78c9894f601eea9aac2675217a3bac4a25bcdb66047e1e9e"],
  ["quotes", { 'a"b': "c\nd\te\\f" }, "sha256:1811337cdf5c5043fff0c040ae662b91db5202b2af982dbbe4c321d27aabf83e"],
  ["undefined-element", [undefined], "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"],
  ["sparse", { a: undefined, b: 1 }, "sha256:044d797234f10415a0fb43a108e8ac41cbbcd0490bda10bf067d8b0d2e9baaf0"],
  ["no-own-keys", new Date(0), "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"],
  ["deep", { l1: { l2: { l3: { l4: { l5: "bottom" } } } } }, "sha256:e2896e2d7d965dabf25a845479e8c738d50c3b39318a3646b2ce4041e3fa2cb5"],
];

test("v0.12.43 keeps the digests the 18 merged copies produced", () => {
  for (const [name, value, expected] of GOLDEN) {
    assert.equal(stableDigest(value), expected, `${name} changed identity`);
  }
});

test("v0.12.43 states the difference between a stable digest and a JSON digest", () => {
  // The reason this module exports two names instead of one `digest`. Key order is the whole
  // difference, so the case that shows it is a permutation — for `{a:1}` the two agree, and
  // asserting they always differ would be false.
  assert.equal(stableDigest({ a: 1, b: 2 }), stableDigest({ b: 2, a: 1 }));
  assert.notEqual(digestJson({ a: 1, b: 2 }), digestJson({ b: 2, a: 1 }));
  assert.notEqual(stableDigest({ b: 2, a: 1 }), digestJson({ b: 2, a: 1 }));
  // Where the order already agrees they agree, which is why a wrong choice can go unnoticed for
  // a long time and then change a record's identity the first time a field is added.
  assert.equal(stableDigest({ a: 1 }), digestJson({ a: 1 }));
  assert.equal(digestJson({ a: 1 }), sha256Of(JSON.stringify({ a: 1 })));
});

test("v0.12.43 serializes arrays in order and object keys in sorted order", () => {
  assert.equal(canonicalJson([]), "[]");
  assert.equal(canonicalJson([1, [2, 3]]), "[1,[2,3]]");
  // Array order is meaning, so it is preserved; key order is not, so it is normalized.
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ nested: { z: 1, a: 2 } }), '{"nested":{"a":2,"z":1}}');
  // Scalars fall through to JSON, which is what makes a string distinguishable from its text.
  assert.equal(canonicalJson("x"), '"x"');
  assert.equal(canonicalJson(1), "1");
  assert.equal(canonicalJson(true), "true");
  assert.equal(canonicalJson(null), "null");
  // A top-level `undefined` is refused by name, because the merged copies could not serialize
  // it either: `JSON.stringify` returns `undefined`, and `Hash.update` then raised
  // ERR_INVALID_ARG_TYPE from inside crypto rather than naming the input.
  assert.throws(() => canonicalJson(undefined), /cannot serialize undefined/u);
  assert.throws(() => stableDigest(undefined), /cannot serialize undefined/u);
  assert.throws(() => canonicalJson(() => 1), /cannot serialize function/u);
  // A nested `undefined` is **not** refused, because refusing it would change identity: the
  // merged copies rendered it two different ways and both are preserved.
  assert.equal(canonicalJson([undefined]), "[]", "Array.join renders undefined as empty");
  assert.equal(canonicalJson([1, undefined, 2]), "[1,,2]");
  assert.equal(canonicalJson({ a: undefined }), '{"a":undefined}', "interpolation renders the text");
  // Which means nesting decides the digest, and the golden `undefined-element` entry pins it.
  assert.equal(stableDigest([undefined]), stableDigest([]));
  assert.notEqual(stableDigest({ a: undefined }), stableDigest({}));
});

test("v0.12.43 keeps record payloads free of the store's own bookkeeping", () => {
  // Identity digests are computed over the remainder: `id`, `version` and the timestamps say
  // where a record lives, not what it says.
  assert.deepEqual(payload({ id: "a", version: 2, created_at: "t", updated_at: "t", content: 1 }), { content: 1 });
  assert.deepEqual(payload({ content: 1 }), { content: 1 });
  assert.deepEqual(payload({ id: "a", version: 1, created_at: "t", updated_at: "t" }), {});
  // A key that merely looks reserved is not reserved.
  assert.deepEqual(payload({ Id: "a", Version: 1, content: 2 }), { Id: "a", Version: 1, content: 2 });
});

test("v0.12.34 a payload does not return a body that lives behind a content reference", () => {
  // The body moved to the content store, so returning a stale copy of it would hand a caller
  // text no digest protects.
  assert.deepEqual(payload({ id: "a", version: 1, content: "inline", content_ref: { path: "x" } }), { content_ref: { path: "x" } });
  // A record that carries the key at all counts as content-store-backed, so the inline copy is
  // not returned either. Writers either omit the key or set a real reference.
  assert.deepEqual(payload({ content: "inline", content_ref: null }), { content_ref: null });
  assert.deepEqual(payload({ content: "inline" }), { content: "inline" });
});
