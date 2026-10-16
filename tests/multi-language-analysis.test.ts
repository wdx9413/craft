import assert from "node:assert/strict";
import test from "node:test";
import { combineLanguageAnalyses } from "../capability/craft-codebase/multi-language-analysis.ts";

test("combined analysis returns undefined without a complete analyzer graph", () => {
  assert.equal(combineLanguageAnalyses([]), undefined);
  assert.equal(combineLanguageAnalyses([{ nodes: [], edges: "invalid" }]), undefined);
});

test("combined analysis keeps repository graphs above the former 150k edge ceiling", () => {
  const nodes = [
    { id: "ts_file", kind: "file", path: "src/large.ts" },
    { id: "ts_symbol", kind: "symbol", path: "src/large.ts" },
  ];
  const edges = Array.from({ length: 160_001 }, () => ({
    kind: "calls", from_node_id: "ts_symbol", to_node_id: "ts_symbol", source_span: { start_offset: 1, end_offset: 2 },
  }));
  const graph = combineLanguageAnalyses([{ nodes, edges, analyzer: "typescript-checker", analyzer_version: "test" }]);
  assert(graph);
  assert.equal((graph.edges as unknown[]).length, edges.length);
  assert.equal((graph.diagnostics as Record<string, unknown>).omitted_edges, 0);
  assert.equal((graph.diagnostics as Record<string, unknown>).budget_limited, false);
});

test("combined analysis distinguishes external endpoints from bounded edge loss", () => {
  const nodes = [{ id: "file", kind: "file", path: "src/a.ts" }, { id: "symbol", kind: "symbol", path: "src/a.ts" }];
  const endpointOmission = combineLanguageAnalyses([{ nodes, edges: [
    { kind: "calls", from_node_id: "symbol", to_node_id: "outside" },
  ] }])!.diagnostics as Record<string, unknown>;
  assert.equal(endpointOmission.omitted_edges, 1);
  assert.equal(endpointOmission.unresolved_endpoint_edges, 1);
  assert.equal(endpointOmission.budget_omitted_edges, 0);
  assert.equal(endpointOmission.budget_limited, false);
  assert.deepEqual(endpointOmission.unresolved_endpoint_edges_by_kind, { calls: 1 });

  const budgetEdges = Array.from({ length: 300_001 }, () => ({ kind: "references", from_node_id: "symbol", to_node_id: "symbol" }));
  const budgetOmission = combineLanguageAnalyses([{ nodes, edges: budgetEdges }])!.diagnostics as Record<string, unknown>;
  assert.equal(budgetOmission.unresolved_endpoint_edges, 0);
  assert.equal(budgetOmission.budget_omitted_edges, 1);
  assert.equal(budgetOmission.budget_limited, true);
  assert.deepEqual(budgetOmission.budget_omitted_edges_by_kind, { references: 1 });
});

test("combined analysis reports node, serialized-byte, and analyzer budgets", () => {
  const fileNode = { id: "file", kind: "file", path: "src/a.ts" };
  const symbolNode = { id: "symbol", kind: "symbol", path: "src/a.ts" };
  const nodeBudget = combineLanguageAnalyses([{ nodes: [fileNode, ...Array.from({ length: 60_000 }, (_, ordinal) => ({
    id: `symbol_${ordinal}`, kind: "symbol", path: "src/a.ts",
  }))], edges: [] }])!.diagnostics as Record<string, unknown>;
  assert.equal(nodeBudget.omitted_nodes, 1);
  assert.equal(nodeBudget.budget_limited, true);

  assert.throws(() => combineLanguageAnalyses([{ nodes: Array.from({ length: 60_001 }, (_, ordinal) => ({
    id: `file_${ordinal}`, kind: "file", path: `src/${ordinal}.ts`,
  })), edges: [] }]), /Required file nodes exceed combined analysis budget/u);

  const hugeSymbol = { ...symbolNode, name: "x".repeat(64_000_001) };
  const symbolByteBudget = combineLanguageAnalyses([{ nodes: [fileNode, hugeSymbol], edges: [] }])!.diagnostics as Record<string, unknown>;
  assert.equal(symbolByteBudget.omitted_nodes, 1);
  assert.equal(symbolByteBudget.budget_limited, true);

  const edgeByteBudget = combineLanguageAnalyses([{ nodes: [fileNode, symbolNode], edges: [
    { kind: "references", from_node_id: "symbol", to_node_id: "symbol", detail: "x".repeat(64_000_001) },
  ] }])!.diagnostics as Record<string, unknown>;
  assert.equal(edgeByteBudget.budget_omitted_edges, 1);
  assert.equal(edgeByteBudget.budget_limited, true);

  const analyzerBudget = combineLanguageAnalyses([
    { analyzer: "typescript-checker", analyzer_version: "1", nodes: [fileNode, symbolNode], edges: [], diagnostics: {} },
    { analyzer: "python-ast", analyzer_version: "1", nodes: [], edges: [], diagnostics: { budget_limited: true } },
  ])!;
  assert.equal(analyzerBudget.analyzer, "multi-language-static");
  assert.equal((analyzerBudget.diagnostics as Record<string, unknown>).budget_limited, true);
});

test("combined analysis accounts for uneven edge groups and every missing endpoint", () => {
  const fileNode = { id: "file", kind: "file", path: "src/a.ts" };
  const symbolNode = { id: "symbol", kind: "symbol", path: "src/a.ts" };
  const graph = combineLanguageAnalyses([
    { analyzer: "typescript-checker", nodes: [fileNode, symbolNode], edges: [
      { kind: "calls", from_node_id: "symbol", to_node_id: "external_a" },
      { from_node_id: "external_b", to_node_id: "symbol" },
    ] },
    { analyzer: "python-ast", nodes: [], edges: [{ kind: "references", from_node_id: "missing", to_node_id: "symbol" }] },
  ])!;
  const diagnostics = graph.diagnostics as Record<string, unknown>;
  assert.equal(graph.analyzer, "multi-language-static");
  assert.equal(diagnostics.unresolved_endpoint_edges, 3);
  assert.equal(diagnostics.budget_limited, false);
  assert.deepEqual(diagnostics.unresolved_endpoint_edges_by_kind, { calls: 1, references: 1, unknown: 1 });
});
