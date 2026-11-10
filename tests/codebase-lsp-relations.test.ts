import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import test from "node:test";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { collectLspRelations, isCheckpointRelativePath, selectLspRelationSymbols } from "../capability/craft-codebase/lsp-relations.ts";

const cwd = "/workspace", path = "src/a.js", uri = pathToFileURL(`${cwd}/${path}`).href;
const content = "function target() {}\nfunction caller(){ target(); }\n";
const target = { id: "target", kind: "symbol", path, span: { start_offset: 9, end_offset: 15 } };
const caller = { id: "caller", kind: "symbol", path, span: { start_offset: 30, end_offset: 36 } };
const inner = { id: "inner", kind: "symbol", path, span: { start_offset: 38, end_offset: 43 } };
const symbols = [
  { name: "target", kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } }, selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 15 } } },
  { name: "caller", kind: 12, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 30 } }, selectionRange: { start: { line: 1, character: 9 }, end: { line: 1, character: 15 } },
    children: [{ name: "inner", kind: 6, range: { start: { line: 1, character: 17 }, end: { line: 1, character: 30 } }, selectionRange: { start: { line: 1, character: 17 }, end: { line: 1, character: 22 } } }] },
];
const range = { start: { line: 1, character: 19 }, end: { line: 1, character: 25 } };
const call = { symbol_id: "target", incoming_calls: [{ from: { name: "caller", uri, selectionRange: symbols[1]!.selectionRange }, fromRanges: [range] }] };
const base = (): JsonObject => ({ cwd, documents: [{ path, content, uri, symbols }], nodes: [target, caller, inner], references: [{ symbol_id: "target", locations: [{ uri, range }] }], calls: [call] });

test("LSP relation budget rotates across files before selecting later symbols", () => {
  assert.equal(isCheckpointRelativePath("src\\file.ts"), true);
  assert.equal(isCheckpointRelativePath("../outside.ts"), false);
  assert.equal(isCheckpointRelativePath("C:\\outside.ts"), false);
  assert.equal(isCheckpointRelativePath("/outside.ts"), false);
  const input = [
    { id: "a1", path: "a.go", symbol_kind: 5 }, { id: "a2", path: "a.go", symbol_kind: 12 }, { id: "a3", path: "a.go", symbol_kind: 6 },
    { id: "b1", path: "b.go", symbol_kind: 12 }, { id: "b2", path: "b.go", symbol_kind: 5 },
    { id: "c1", path: "c.go" }, { id: "c2", path: "c.go", symbol_kind: 5 },
  ];
  assert.deepEqual(selectLspRelationSymbols(input, 4).map(node => node.id), ["a1", "b1", "c1", "b2"]);
  assert.deepEqual(selectLspRelationSymbols([...input].reverse(), 4).map(node => node.id), ["a1", "b1", "c1", "b2"],
    "bounded relation selection must not depend on language-server response ordering");
  assert.deepEqual(selectLspRelationSymbols(input, 20, true).map(node => node.id), ["a2", "b1", "c1", "a3", "b2", "c2", "a1"]);
  assert.deepEqual(selectLspRelationSymbols(input, 20).map(node => node.id), ["a1", "b1", "c1", "a2", "b2", "c2", "a3"]);
  const canonicalOrder = [
    { id: "z", path: "ordered.go", name: "same", span: { start_offset: 2 } },
    { id: "z", path: "ordered.go", name: "same", span: { start_offset: 2 } },
    { id: "fallback-b", path: "ordered.go", name: "same" },
    { id: "a", path: "ordered.go", name: "same", span: { start_offset: 2 } },
    { id: "b", path: "ordered.go", name: "first", span: { start_offset: 2 } },
    { id: "fallback-a", path: "ordered.go", name: "same", span: { start_offset: "invalid" } },
    { id: "earlier", path: "ordered.go", name: "same", span: { start_offset: 1 } },
  ];
  assert.deepEqual(selectLspRelationSymbols(canonicalOrder, 20).map(node => node.id), ["earlier", "b", "a", "z", "z", "fallback-a", "fallback-b"]);
  assert.deepEqual(selectLspRelationSymbols([...canonicalOrder].reverse(), 20).map(node => node.id), ["earlier", "b", "a", "z", "z", "fallback-a", "fallback-b"]);
  assert.deepEqual(selectLspRelationSymbols([
    { path: "unnamed.go", span: { start_offset: 1 } }, { path: "unnamed.go", span: { start_offset: 1 } },
  ], 2).map(node => node.id), [undefined, undefined]);
  const manyPaths = Array.from({ length: 10 }, (_, index) => ({ id: `p${index}`, path: `p${index}.go` }));
  assert.deepEqual(selectLspRelationSymbols(manyPaths, 4).map(node => node.id), ["p0", "p3", "p6", "p9"]);
  assert.deepEqual(selectLspRelationSymbols(input, 0), []);
  assert.deepEqual(selectLspRelationSymbols(input, 1.5), []);
  assert.deepEqual(selectLspRelationSymbols([], 2), []);
  assert.deepEqual(selectLspRelationSymbols([{ id: "missing-path" }], 1).map(node => node.id), ["missing-path"]);
});

test("LSP locations and call hierarchy map to exact checkpoint symbols and UTF-16 source spans", () => {
  const result = collectLspRelations(base()), relations = result.relations as JsonObject[];
  assert.equal(relations.length, 2);
  assert.deepEqual(relations.map(edge => edge.kind), ["references", "calls"]);
  assert.deepEqual(relations[0]!.from, { path, start_offset: inner.span.start_offset });
  assert.deepEqual(relations[0]!.to, { path, start_offset: target.span.start_offset });
  assert.deepEqual(relations[1]!.source_span, { start_offset: 40, end_offset: 46 });
  assert.equal(result.omitted_relation_count, 0);
});

test("LSP relation mapping normalizes Windows checkpoint separators", () => {
  const input = base();
  const windowsPath = "src\\a.js", windowsUri = pathToFileURL(join(process.cwd(), "src", "a.js")).href;
  input.cwd = process.cwd();
  (input.documents as JsonObject[])[0]!.path = windowsPath;
  (input.documents as JsonObject[])[0]!.uri = windowsUri;
  input.nodes = (input.nodes as JsonObject[]).map(node => ({ ...node, path: windowsPath }));
  input.references = [{ symbol_id: "target", locations: [{ uri: windowsUri, range }] }];
  input.calls = [{ symbol_id: "target", incoming_calls: [{ from: { name: "caller", uri: windowsUri, selectionRange: symbols[1]!.selectionRange }, fromRanges: [range] }] }];
  const result = collectLspRelations(input), edges = result.relations as JsonObject[];
  assert.deepEqual(edges.map(edge => edge.kind), ["references", "calls"]);
  assert.deepEqual(edges.map(edge => (edge.from as JsonObject).path), [windowsPath, windowsPath]);
  assert.equal(result.omitted_relation_count, 0);
});

test("LSP relation mapping rejects file URIs outside the checkpoint on every platform", () => {
  const input = base();
  input.references = [{ symbol_id: "target", locations: [{ uri: pathToFileURL("/outside/checkpoint.js").href, range }] }];
  input.calls = [];
  const result = collectLspRelations(input);
  assert.deepEqual(result.relations, []);
  assert.equal(result.omitted_relation_count, 1);
});

test("LSP outgoing call hierarchy maps callers to callees and deduplicates incoming facts", () => {
  const input = base();
  input.references = [];
  input.calls = [
    call,
    { symbol_id: "caller", outgoing_calls: [{ to: { uri, selectionRange: symbols[0]!.selectionRange }, fromRanges: [range] }] },
  ];
  const result = collectLspRelations(input), relations = result.relations as JsonObject[];
  assert.equal(relations.length, 1);
  assert.equal(relations[0]!.kind, "calls");
  assert.deepEqual(relations[0]!.from, { path, start_offset: caller.span.start_offset });
  assert.deepEqual(relations[0]!.to, { path, start_offset: target.span.start_offset });
  assert.deepEqual(relations[0]!.source_span, { start_offset: 40, end_offset: 46 });
  assert.equal(result.omitted_relation_count, 0);
});

test("LSP call hierarchy maps an anonymous closure caller to its enclosing indexed function", () => {
  const input = base();
  input.references = [];
  (input.documents as JsonObject[])[0]!.symbols = [symbols[0], { ...symbols[1], children: undefined }];
  input.calls = [{ symbol_id: "target", incoming_calls: [{ from: { name: "caller.func1", uri,
    selectionRange: { start: { line: 1, character: 20 }, end: { line: 1, character: 20 } } }, fromRanges: [range] }] }];
  const result = collectLspRelations(input), relations = result.relations as JsonObject[];
  assert.equal(relations.length, 1);
  assert.equal(relations[0]!.kind, "calls");
  assert.deepEqual(relations[0]!.from, { path, start_offset: caller.span.start_offset });
  assert.equal(result.omitted_relation_count, 0);
});

test("LSP implementation and type definition locations map to typed graph endpoints", () => {
  const input = base();
  input.references = []; input.calls = [];
  input.implementations = [{ symbol_id: "target", locations: [{ uri, range: symbols[1]!.selectionRange }] }];
  input.type_definitions = [{ symbol_id: "caller", locations: [{ uri, range: symbols[0]!.selectionRange }] }];
  const result = collectLspRelations(input), edges = result.relations as JsonObject[];
  assert.deepEqual(edges.map(edge => edge.kind), ["implements", "type_definition"]);
  assert.deepEqual(edges[0]!.from, { path, start_offset: caller.span.start_offset });
  assert.deepEqual(edges[0]!.to, { path, start_offset: target.span.start_offset });
  assert.deepEqual(edges[1]!.from, { path, start_offset: caller.span.start_offset });
  assert.deepEqual(edges[1]!.to, { path, start_offset: target.span.start_offset });
});

test("LSP definitions map a reference token to its checkpoint definition candidate", () => {
  const input = base(); input.references = []; input.calls = [];
  input.definitions = [{ reference: { uri, range }, locations: [{ uri, range: symbols[0]!.selectionRange }] }];
  const result = collectLspRelations(input), edges = result.relations as JsonObject[];
  assert.deepEqual(edges.map(edge => edge.kind), ["definitions"]);
  assert.deepEqual(edges[0]!.from, { path, start_offset: inner.span.start_offset });
  assert.deepEqual(edges[0]!.to, { path, start_offset: target.span.start_offset });
  assert.deepEqual(edges[0]!.source_span, { start_offset: 40, end_offset: 46 });
});

test("LSP type hierarchy maps supertypes and subtypes to directed snapshot extends edges", () => {
  const input = base(); input.references = []; input.calls = [];
  input.type_hierarchy = [{ symbol_id: "target", supertypes: [{ uri, selectionRange: symbols[1]!.selectionRange }],
    subtypes: [{ uri, selectionRange: symbols[1]!.selectionRange }] }];
  const result = collectLspRelations(input), edges = result.relations as JsonObject[];
  assert.deepEqual(edges.map(edge => edge.kind), ["extends", "extends"]);
  assert.deepEqual(edges.map(edge => [Number((edge.from as JsonObject).start_offset), Number((edge.to as JsonObject).start_offset)]).sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!),
    [[Number(target.span.start_offset), Number(caller.span.start_offset)], [Number(caller.span.start_offset), Number(target.span.start_offset)]]);
  assert.equal(result.omitted_relation_count, 0);
});

test("LSP type hierarchy rejects malformed and out-of-snapshot endpoints while suppressing self edges", () => {
  const input = base(); input.references = []; input.calls = [];
  input.type_hierarchy = [
    { symbol_id: "missing", supertypes: [], subtypes: [] },
    { symbol_id: "target", supertypes: [], subtypes: "invalid" },
    { symbol_id: "target", supertypes: [{}], subtypes: [] },
    { symbol_id: "target", supertypes: [{ uri, selectionRange: { start: { line: 90, character: 0 } } }], subtypes: [] },
    { symbol_id: "target", supertypes: [{ uri, selectionRange: symbols[0]!.selectionRange }], subtypes: [] },
    { symbol_id: "target", supertypes: [], subtypes: [{ uri: "file:///outside/type.js", selectionRange: symbols[1]!.selectionRange }] },
  ];
  const result = collectLspRelations(input);
  assert.deepEqual(result.relations, []);
  assert.equal(result.omitted_relation_count, 5);
  assert.deepEqual(result.omitted_relation_stages, [
    { stage: "type_hierarchy_source_or_items_invalid", count: 2 },
    { stage: "type_hierarchy_supertype_unmapped", count: 2 },
    { stage: "type_hierarchy_subtype_unmapped", count: 1 },
  ]);
});

test("LSP relation collector handles URI normalization, duplicate facts, unsupported locations and malformed results", () => {
  const input = base(), refs = input.references as JsonObject[];
  refs.push({ symbol_id: "target", locations: [{ uri: pathToFileURL(`${cwd}/src/%61.js`).href, range }] });
  refs.push({ symbol_id: "missing", locations: [] }, { symbol_id: "target", locations: "invalid" });
  refs.push({ symbol_id: "target", locations: [
    { uri: "not a uri", range }, { uri: "https://example.invalid/a.js", range },
    { uri: pathToFileURL(cwd).href, range }, { uri: pathToFileURL("/").href, range },
    { uri, range: { start: { line: 99, character: 0 }, end: { line: 99, character: 1 } } },
    { uri, range: { start: { line: 1, character: 22 }, end: { line: 1, character: 21 } } },
  ] });
  refs.push({ symbol_id: "target", locations: [{ uri, range: { start: { line: 1, character: 99 }, end: { line: 1, character: 100 } } }] });
  (input.documents as JsonObject[])[0]!.symbols = [...symbols, null, { name: "no endpoint", range: symbols[0]!.range }, { name: "missing range" }];
  (input.documents as JsonObject[]).push({ path: "empty.js", content: "", uri: pathToFileURL(`${cwd}/empty.js`).href, symbols: [] });
  const result = collectLspRelations(input), relations = result.relations as JsonObject[];
  assert.equal(relations.length, 2);
  assert(Number(result.omitted_relation_count) >= 7);
});

test("LSP call hierarchy rejects missing endpoints and malformed ranges while empty inputs stay empty", () => {
  const input = base();
  input.references = [];
  input.calls = [
    { symbol_id: "unknown", incoming_calls: [] },
    { symbol_id: "target", incoming_calls: "invalid" },
    { symbol_id: "target", incoming_calls: [{ from: { uri: "file:///outside/workspace.js", selectionRange: symbols[1]!.selectionRange }, fromRanges: [range] }] },
    { symbol_id: "target", incoming_calls: [{ from: { uri, selectionRange: { start: { line: 1, character: 99 } } }, fromRanges: [range] }] },
    { symbol_id: "target", incoming_calls: [{ from: { uri, selectionRange: {} }, fromRanges: [range] }] },
    { symbol_id: "target", incoming_calls: [{ from: { uri, selectionRange: symbols[1]!.selectionRange }, fromRanges: "invalid" }] },
    { symbol_id: "target", incoming_calls: [{ from: { uri, selectionRange: symbols[1]!.selectionRange }, fromRanges: [{ start: { line: 90, character: 0 }, end: { line: 90, character: 1 } }] }] },
    { symbol_id: "target", incoming_calls: [{ from: { uri, selectionRange: symbols[1]!.selectionRange }, fromRanges: [range, range] }] },
  ];
  const result = collectLspRelations(input), relations = result.relations as JsonObject[];
  assert.equal(relations.length, 1);
  assert.equal(result.omitted_relation_count, 7);
  const empty = collectLspRelations({ cwd, documents: [], nodes: [], references: [], calls: [] });
  assert.deepEqual(empty, { relations: [], omitted_relation_count: 0, omitted_relation_stages: [] });
  assert.throws(() => collectLspRelations({}), /Invalid LSP relation collection input/);
});

test("LSP outgoing call hierarchy rejects invalid source, target and call-site evidence", () => {
  const input = base();
  input.references = [];
  input.nodes = [...input.nodes as JsonObject[], { id: "missing-path", kind: "symbol", path: "src/missing.js", span: { start_offset: 0, end_offset: 1 } }];
  input.calls = [
    { symbol_id: "unknown", outgoing_calls: [] },
    { symbol_id: "target", incoming_calls: [], outgoing_calls: "invalid" },
    { symbol_id: "missing-path", outgoing_calls: [{ to: { uri, selectionRange: symbols[0]!.selectionRange }, fromRanges: [range] }] },
    { symbol_id: "caller", outgoing_calls: [{ to: { uri: "file:///outside/target.js", selectionRange: symbols[0]!.selectionRange }, fromRanges: [range] }] },
    { symbol_id: "caller", outgoing_calls: [{ to: { uri, selectionRange: { start: { line: 99, character: 0 } } }, fromRanges: [range] }] },
    { symbol_id: "caller", outgoing_calls: [{ to: { uri, selectionRange: symbols[0]!.selectionRange }, fromRanges: "invalid" }] },
    { symbol_id: "caller", outgoing_calls: [{ to: { uri, selectionRange: symbols[0]!.selectionRange }, fromRanges: [{ start: { line: 99, character: 0 }, end: { line: 99, character: 1 } }] }] },
    { symbol_id: "caller", outgoing_calls: [{ to: { uri, selectionRange: symbols[0]!.selectionRange }, fromRanges: [{ start: { line: 1, character: 9 }, end: { line: 1, character: 8 } }] }] },
  ];
  const result = collectLspRelations(input);
  assert.deepEqual(result.relations, []);
  assert.equal(result.omitted_relation_count, 8);
  assert.deepEqual(result.omitted_relation_stages, [
    { stage: "call_target_or_incoming_invalid", count: 1 },
    { stage: "call_source_or_outgoing_invalid", count: 1 },
    { stage: "call_source_unmapped", count: 1 },
    { stage: "outgoing_call_target_unmapped", count: 2 },
    { stage: "outgoing_call_ranges_invalid", count: 1 },
    { stage: "outgoing_call_range_invalid", count: 2 },
  ]);
});

test("LSP semantic locations reject unknown endpoints, out-of-snapshot facts and suppress self edges", () => {
  const input = base(); input.references = []; input.calls = [];
  input.implementations = [
    { symbol_id: "missing", locations: [] }, { symbol_id: "target", locations: "invalid" },
    { symbol_id: "target", locations: [{ uri: "file:///outside/implementation.js", range }] },
    { symbol_id: "target", locations: [{ uri, range: { start: { line: 90, character: 0 }, end: { line: 90, character: 1 } } }] },
    { symbol_id: "target", locations: [{ uri, range: symbols[0]!.selectionRange }] },
  ];
  input.type_definitions = [
    { symbol_id: "missing", locations: [] }, { symbol_id: "caller", locations: "invalid" },
    { symbol_id: "caller", locations: [{ uri: "file:///outside/type.js", range }] },
    { symbol_id: "caller", locations: [{ uri, range: { start: { line: 80, character: 0 } } }] },
    { symbol_id: "target", locations: [{ uri, range: symbols[0]!.selectionRange }] },
  ];
  const result = collectLspRelations(input);
  assert.deepEqual(result.relations, []);
  assert.equal(result.omitted_relation_count, 8);
  assert.deepEqual(result.omitted_relation_stages, [
    { stage: "implementation_target_or_locations_invalid", count: 2 }, { stage: "implementation_location_unmapped", count: 2 },
    { stage: "type_definition_source_or_locations_invalid", count: 2 }, { stage: "type_definition_location_unmapped", count: 2 },
  ]);
});

test("LSP definition facts reject malformed and out-of-snapshot endpoints and suppress self edges", () => {
  const input = base(); input.references = []; input.calls = [];
  input.definitions = [
    { locations: [] }, { reference: { uri, range }, locations: "invalid" },
    { reference: { uri: "file:///outside/definition.js", range }, locations: [] },
    { reference: { uri, range: { start: { line: 90, character: 0 } } }, locations: [] },
    { reference: { uri, range: symbols[0]!.selectionRange }, locations: [{ uri, range: symbols[0]!.selectionRange }] },
    { reference: { uri, range }, locations: [{ uri: "file:///outside/definition.js", range }] },
    { reference: { uri, range }, locations: [{ uri, range: { start: { line: 90, character: 0 } } }] },
  ];
  const result = collectLspRelations(input);
  assert.deepEqual(result.relations, []);
  assert.equal(result.omitted_relation_count, 6);
  assert.deepEqual(result.omitted_relation_stages, [
    { stage: "definition_reference_or_locations_invalid", count: 2 },
    { stage: "definition_reference_unmapped", count: 2 },
    { stage: "definition_location_unmapped", count: 2 },
  ]);
});

test("LSP definition collection drops declaration aliases but keeps recursive reference sites", () => {
  const recursiveContent = "function foo(){ foo(); }\n";
  const recursiveUri = pathToFileURL(`${cwd}/src/recursive.js`).href;
  const recursiveNode = { id: "foo", kind: "symbol", path: "src/recursive.js", name: "foo", span: { start_offset: 9, end_offset: 12 } };
  const recursive = collectLspRelations({ cwd, nodes: [recursiveNode], references: [], calls: [], documents: [{ path: "src/recursive.js", uri: recursiveUri, content: recursiveContent,
    symbols: [{ name: "foo", kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 0, character: recursiveContent.length - 1 } }, selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } } }] }],
    definitions: [
      { reference: { uri: recursiveUri, range: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } } }, locations: [{ uri: recursiveUri, range: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } } }] },
      { reference: { uri: recursiveUri, range: { start: { line: 0, character: 16 }, end: { line: 0, character: 19 } } }, locations: [{ uri: recursiveUri, range: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } } }] },
    ] });
  const recursiveEdges = recursive.relations as JsonObject[];
  assert.equal(recursiveEdges.length, 1);
  assert.deepEqual(recursiveEdges[0]!.source_span, { start_offset: 16, end_offset: 19 });

  const destructorContent = "class Widget { ~Widget(); };";
  const destructorUri = pathToFileURL(`${cwd}/src/destructor.cpp`).href;
  const destructor = collectLspRelations({ cwd, nodes: [
    { id: "widget", kind: "symbol", path: "src/destructor.cpp", name: "Widget", span: { start_offset: 6, end_offset: 12 } },
    { id: "destructor", kind: "symbol", path: "src/destructor.cpp", name: "~Widget", span: { start_offset: 15, end_offset: 16 } },
  ], references: [], calls: [], documents: [{ path: "src/destructor.cpp", uri: destructorUri, content: destructorContent, symbols: [
    { name: "Widget", kind: 5, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 28 } }, selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } },
      children: [{ name: "~Widget", kind: 6, range: { start: { line: 0, character: 15 }, end: { line: 0, character: 25 } }, selectionRange: { start: { line: 0, character: 15 }, end: { line: 0, character: 16 } } }] },
  ] }], definitions: [{ reference: { uri: destructorUri, range: { start: { line: 0, character: 16 }, end: { line: 0, character: 22 } } },
    locations: [{ uri: destructorUri, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } } }] }] });
  assert.deepEqual(destructor.relations, []);
});

test("LSP relation facts stop at the 20,000-edge budget", () => {
  const longContent = `function target() {}\n${"x".repeat(20_002)}\n`;
  const input = base();
  input.documents = [{ path, content: longContent, uri, symbols: [symbols[0], { name: "caller", kind: 12,
    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 20_001 } },
    selectionRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } } }] }];
  input.nodes = [target, { id: "caller", kind: "symbol", path, span: { start_offset: 21, end_offset: 27 } }];
  input.references = [];
  input.calls = [{ symbol_id: "target", incoming_calls: [{ from: { uri, selectionRange: { start: { line: 1, character: 0 } } },
    fromRanges: Array.from({ length: 20_001 }, (_, character) => ({ start: { line: 1, character }, end: { line: 1, character: character + 1 } })) }] }];
  const result = collectLspRelations(input);
  assert.equal((result.relations as JsonObject[]).length, 20_000);
  assert.equal(result.omitted_relation_count, 1);
});
