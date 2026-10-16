import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { cacheLspDocumentSymbols, lspDocumentSymbolsDigest, normalizeLspSymbols } from "../capability/craft-codebase/lsp-adapter.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";
const position = (line: number, character: number) => ({ line, character });
const range = { start: position(1, 0), end: position(1, 3) };
const content = "// 😀\r\nfoo\n";
const doc = { path: "a.py", language: "python", content, source_digest: createHash("sha256").update(content).digest("hex"), symbols: [{ name: "foo", range, children: [{ name: "bar", selectionRange: range }] }] };
const input = { analyzer: "lsp-fixture", analyzer_version: "1", documents: [doc] };
function normalizeManySymbols(count: number) {
  const content = `${"x\n".repeat(count)}x`;
  const symbols = Array.from({ length: count }, (_, line) => ({ name: `symbol_${line}`, range: { start: position(line, 0), end: position(line, 1) } }));
  return normalizeLspSymbols({ ...input, documents: [{ path: "large.py", language: "python", content,
    source_digest: createHash("sha256").update(content).digest("hex"), symbols }] });
}
test("LSP adapter normalizes nested multi-language symbols using exact UTF-16 snapshot positions", () => {
  for (const [path, language] of [["A.java", "java"], ["a.py", "python"], ["a.go", "go"]]) {
    const value = normalizeLspSymbols({ ...input, documents: [{ ...doc, path, language }] });
    const nodes = value.nodes as JsonObject[]; assert.equal(nodes.length, 2); assert.deepEqual(nodes[0]!.span, { start_offset: 7, end_offset: 10 }); assert.equal(JSON.stringify(value).includes(content), false); assert.deepEqual(value.edges, []);
  }
});
test("LSP adapter preserves valid symbol kinds for type-hierarchy selection and ignores invalid kinds", () => {
  const value = normalizeLspSymbols({ ...input, documents: [{ ...doc, symbols: [
    { name: "ClassLike", kind: 5, range, selectionRange: range },
    { name: "Unclassified", kind: 0, range, selectionRange: range },
  ] }] });
  const nodes = value.nodes as JsonObject[];
  assert.equal(nodes[0]!.symbol_kind, 5);
  assert.equal(nodes[0]!.declaration_kind, "class");
  assert.equal(Object.hasOwn(nodes[1]!, "symbol_kind"), false);
  const functionNode = (normalizeLspSymbols({ ...input, documents: [{ ...doc, symbols: [{ name: "run", kind: 12, range, selectionRange: range }] }] }).nodes as JsonObject[])[0]!;
  assert.equal(functionNode.declaration_kind, "function");
  const fullRange = { start: position(0, 0), end: position(1, 3) };
  const rangedNode = (normalizeLspSymbols({ ...input, documents: [{ ...doc, symbols: [{ name: "foo", kind: 12, range: fullRange, selectionRange: range }] }] }).nodes as JsonObject[])[0]!;
  assert.deepEqual(rangedNode.span, { start_offset: 7, end_offset: 10 });
  assert.deepEqual(rangedNode.declaration_span, { start_offset: 0, end_offset: 10 });
});
test("LSP adapter rejects invalid digests, positions, nesting and unbounded input", () => {
  for (const changed of [{ ...input, analyzer: "" }, { ...input, analyzer_version: "" }, { ...input, documents: {} }, { ...input, documents: Array(1001).fill(doc) }, { ...input, documents: [doc, doc] }, { ...input, documents: [null] }, { ...input, documents: [{ ...doc, content: "x".repeat(2_000_001) }] }, { ...input, documents: [{ ...doc, source_digest: "wrong" }] }]) assert.throws(() => normalizeLspSymbols(changed));
  const badSymbols = [null, { name: "" }, { name: "foo\nbar" }, { name: "x", range: { start: position(-1, 0), end: position(0, 1) } }, { name: "x", range: { start: position(0, 99), end: position(0, 1) } }, { name: "x", range: { start: position(1, 2), end: position(1, 1) } }, { name: "x", range, children: {} }];
  for (const symbol of badSymbols) assert.throws(() => normalizeLspSymbols({ ...input, documents: [{ ...doc, symbols: [symbol] }] }));
  let nested: JsonObject = { name: "x", range }; for (let i = 0; i < 34; i++) nested = { name: "x", range, children: [nested] };
  assert.throws(() => normalizeLspSymbols({ ...input, documents: [{ ...doc, symbols: [nested] }] }), /nesting/);
});

test("LSP adapter accepts symbol graphs above the former 10,000-symbol cutoff", () => {
  const value = normalizeManySymbols(10_001);
  assert.equal((value.nodes as JsonObject[]).length, 10_001);
  assert.deepEqual(value.diagnostics, { budget_limited: false, omitted_symbols: 0 });
});

test("LSP adapter returns a bounded partial graph and omission count at the graph symbol budget", () => {
  const value = normalizeManySymbols(60_001);
  assert.equal((value.nodes as JsonObject[]).length, 60_000);
  assert.deepEqual(value.diagnostics, { budget_limited: true, omitted_symbols: 1 });
});

test("LSP symbol cache keeps only names, numeric kinds, valid ranges and nested symbols", () => {
  const cached = cacheLspDocumentSymbols([
    { name: "outer", kind: 5, range, selectionRange: range, detail: "discarded", children: [{ name: "inner", range }] },
    { name: "selection_only", kind: "invalid", range: { start: "bad", end: null }, selectionRange: range },
    { name: "invalid_positions", kind: Number.MAX_SAFE_INTEGER + 1, range: [], selectionRange: { start: [], end: { line: -1, character: 0 } } },
  ]);
  assert.deepEqual(cached[0], { name: "outer", kind: 5, range, selectionRange: range, children: [{ name: "inner", range }] });
  assert.deepEqual(cached[1], { name: "selection_only", selectionRange: range });
  assert.deepEqual(cached[2], { name: "invalid_positions" });
  const digest = lspDocumentSymbolsDigest({ analyzer: "a", analyzer_version: "1", path: "x.java", language: "java", source_digest: "d", symbols: cached });
  assert.match(digest, /^sha256:[a-f0-9]{64}$/u);
});


test("LSP indexed relation endpoints preserve first-symbol selection and bounded relation batches", () => {
  const relation = { kind: "references", from: { path: "a.py", start_offset: 7 }, to: { path: "a.py", start_offset: 7 }, source_span: { start_offset: 7, end_offset: 10 } };
  const value = normalizeLspSymbols({ ...input, relations: Array(20_000).fill(relation) });
  const nodes = value.nodes as JsonObject[], edges = value.edges as JsonObject[];
  assert.equal(edges.length, 20_000);
  assert(edges.every(edge => edge.from_node_id === nodes[0]!.id && edge.to_node_id === nodes[0]!.id));
  assert.notEqual(nodes[0]!.id, nodes[1]!.id);
  assert.throws(() => normalizeLspSymbols({ ...input, relations: [{ ...relation, to: { path: "missing.py", start_offset: 7 } }] }), /outside supplied symbols/);
  assert.throws(() => normalizeLspSymbols({ ...input, relations: [{ ...relation, to: { path: "a.py", start_offset: "7" } }] }), /outside supplied symbols/);
  assert.equal((normalizeLspSymbols({ ...input, relations: [{ ...relation, kind: "extends" }] }).edges as JsonObject[])[0]!.kind, "extends");
  assert.equal((normalizeLspSymbols({ ...input, relations: [{ ...relation, kind: "definitions" }] }).edges as JsonObject[])[0]!.kind, "definitions");
  assert.throws(() => normalizeLspSymbols({ ...input, relations: [{ ...relation, kind: "unknown" }] }), /relation kind/);
  assert.throws(() => normalizeLspSymbols({ ...input, relations: Array(20_001).fill(relation) }), /budget/);
  for (const source_span of [undefined, { start_offset: -1, end_offset: 1 }, { start_offset: 3, end_offset: 2 }, { start_offset: 0, end_offset: content.length + 1 }]) {
    assert.throws(() => normalizeLspSymbols({ ...input, relations: [{ ...relation, source_span }] }), /span/);
  }
});
