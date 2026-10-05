import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { normalizeLspSymbols } from "../capability/craft-codebase/lsp-adapter.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";
const position = (line: number, character: number) => ({ line, character });
const range = { start: position(1, 0), end: position(1, 3) };
const content = "// 😀\r\nfoo\n";
const doc = { path: "a.py", language: "python", content, source_digest: createHash("sha256").update(content).digest("hex"), symbols: [{ name: "foo", range, children: [{ name: "bar", selectionRange: range }] }] };
const input = { analyzer: "lsp-fixture", analyzer_version: "1", documents: [doc] };
test("LSP adapter normalizes nested multi-language symbols using exact UTF-16 snapshot positions", () => {
  for (const [path, language] of [["A.java", "java"], ["a.py", "python"], ["a.go", "go"]]) {
    const value = normalizeLspSymbols({ ...input, documents: [{ ...doc, path, language }] });
    const nodes = value.nodes as JsonObject[]; assert.equal(nodes.length, 2); assert.deepEqual(nodes[0]!.span, { start_offset: 7, end_offset: 10 }); assert.equal(JSON.stringify(value).includes(content), false); assert.deepEqual(value.edges, []);
  }
});
test("LSP adapter rejects invalid digests, positions, nesting and unbounded input", () => {
  for (const changed of [{ ...input, analyzer: "" }, { ...input, analyzer_version: "" }, { ...input, documents: {} }, { ...input, documents: Array(1001).fill(doc) }, { ...input, documents: [doc, doc] }, { ...input, documents: [null] }, { ...input, documents: [{ ...doc, content: "x".repeat(2_000_001) }] }, { ...input, documents: [{ ...doc, source_digest: "wrong" }] }]) assert.throws(() => normalizeLspSymbols(changed));
  const badSymbols = [null, { name: "" }, { name: "foo\nbar" }, { name: "x", range: { start: position(-1, 0), end: position(0, 1) } }, { name: "x", range: { start: position(0, 99), end: position(0, 1) } }, { name: "x", range: { start: position(1, 2), end: position(1, 1) } }, { name: "x", range, children: {} }];
  for (const symbol of badSymbols) assert.throws(() => normalizeLspSymbols({ ...input, documents: [{ ...doc, symbols: [symbol] }] }));
  let nested: JsonObject = { name: "x", range }; for (let i = 0; i < 34; i++) nested = { name: "x", range, children: [nested] };
  assert.throws(() => normalizeLspSymbols({ ...input, documents: [{ ...doc, symbols: [nested] }] }), /nesting/);
  assert.throws(() => normalizeLspSymbols({ ...input, documents: [{ ...doc, symbols: Array(10001).fill({ name: "x", range }) }] }), /count/);
});
