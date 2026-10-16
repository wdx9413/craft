import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { resolvePythonAnalyzerPath, analyzePythonCheckpoint, analyzePythonControlFlow, analyzePythonDataFlow } from "../capability/craft-codebase/python-analysis.ts";
import { combineLanguageAnalyses } from "../capability/craft-codebase/multi-language-analysis.ts";
import type { JsonObject } from "../common/craft-common-store-local/src/store.ts";

const file = (content = "def f(): pass") => ({ path: "a.py", content, digest: createHash("sha256").update(content).digest("hex"), language: "py" });
const graph = (language: string, nodes: JsonObject[], edges: JsonObject[] = [], diagnostics: JsonObject = {}) => ({
  format: "craft-static-analysis-v1", analyzer: `${language}-static`, analyzer_version: "1", nodes, edges, diagnostics,
});
const node = (id: string, kind: string, language = "py", name = id): JsonObject => ({ id, kind, path: `${language}.py`, name, language, source_digest: "d", span: { start_offset: 0, end_offset: 0 } });

test("Python adapter resolves packaged paths and handles empty, missing, oversized and valid analyses", () => {
  const cwd = "/repo";
  const first = resolvePythonAnalyzerPath(cwd, path => path.endsWith("scripts/codebase/analyze-python.py"));
  assert(first?.endsWith("scripts/codebase/analyze-python.py"));
  assert(resolvePythonAnalyzerPath(cwd, path => path.includes("/capability/craft-codebase/analyzers/"))?.endsWith("analyzers/analyze-python.py"));
  assert.equal(resolvePythonAnalyzerPath(cwd, () => false), undefined);
  assert.equal(resolvePythonAnalyzerPath(cwd, () => false, null), undefined);
  const priorEntry = process.argv[1];
  process.argv[1] = undefined as unknown as string;
  try { assert.equal(resolvePythonAnalyzerPath(cwd, () => false), undefined); } finally { process.argv[1] = priorEntry!; }
  assert.deepEqual(analyzePythonCheckpoint([]), {});
  assert.equal(analyzePythonCheckpoint([file()], { cwd, fileExists: () => false, execute: () => "{}" }).diagnostic?.reason, "analyzer_not_packaged");
  const oversized = file("x".repeat(24_000_001));
  assert.equal(analyzePythonCheckpoint([oversized], { analyzerPath: "/worker" }).diagnostic?.reason, "input_budget_exceeded");
  assert.equal(analyzePythonCheckpoint([file("😀".repeat(7_000_000))], { analyzerPath: "/worker" }).diagnostic?.reason, "input_budget_exceeded");
  const valid = graph("python", [node("f", "file")]);
  const result = analyzePythonCheckpoint([file()], { analyzerPath: "/worker", execute: () => JSON.stringify(valid) });
  assert.equal(result.analysis?.analyzer, "python-static");
  const unitResponse: JsonObject = graph("python", [node("f", "file")]); unitResponse.file_units = [];
  const optionsResult = analyzePythonCheckpoint([file()], { analyzerPath: "/worker", includePaths: ["a.py"], includeFileUnits: true,
    cachedFileUnits: [], execute: (_command, _args, input) => { assert.match(input, /cached_file_units/u); return JSON.stringify(unitResponse); } });
  assert.deepEqual(optionsResult.analysis?.file_units, []);
  const executed = analyzePythonCheckpoint([file()], { cwd: process.cwd() });
  assert.equal(executed.analysis?.analyzer, "python-ast-static");
});

test("Python adapter bounds malformed responses and classifies subprocess failures without leaking output", () => {
  const args = { analyzerPath: "/worker" };
  assert.equal(analyzePythonCheckpoint([file()], { ...args, execute: () => "{" }).diagnostic?.reason, "analysis_failed");
  assert.equal(analyzePythonCheckpoint([file()], { ...args, execute: () => JSON.stringify({ format: "wrong", nodes: [], edges: [] }) }).diagnostic?.reason, "invalid_analyzer_response");
  assert.equal(analyzePythonCheckpoint([file()], { ...args, execute: () => "x".repeat(64_000_001) }).diagnostic?.reason, "output_budget_exceeded");
  const error = (code: string) => Object.assign(new Error("sensitive stderr"), { code });
  assert.equal(analyzePythonCheckpoint([file()], { ...args, execute: () => { throw error("ENOENT"); } }).diagnostic?.reason, "python_runtime_unavailable");
  assert.equal(analyzePythonCheckpoint([file()], { ...args, execute: () => { throw error("ETIMEDOUT"); } }).diagnostic?.reason, "analysis_timed_out");
  assert.equal(analyzePythonCheckpoint([file()], { ...args, execute: () => { throw error("EFAIL"); } }).diagnostic?.reason, "analysis_failed");
});

test("Python control-flow adapter validates bounded source-free responses and reports failures safely", () => {
  const source = file("def route(): return 1");
  const symbol = { id: "route-id", name: "route", startOffset: 4 };
  const args = { analyzerPath: "/worker" };
  const valid = { format: "craft-python-control-flow-v1", language: "python", status: "complete", blocks: [], edges: [], partial_reasons: [], source_content_included: false };
  assert.equal(analyzePythonControlFlow(source, symbol, { cwd: "/repo", fileExists: () => false }).diagnostic?.reason, "analyzer_not_packaged");
  assert.deepEqual(analyzePythonControlFlow(source, symbol, { ...args, execute: () => JSON.stringify(valid) }).result?.status, "complete");
  for (const invalid of [{ ...valid, format: "wrong" }, { ...valid, language: "typescript" }, { ...valid, blocks: "wrong" },
    { ...valid, edges: "wrong" }, { ...valid, partial_reasons: "wrong" }]) {
    assert.equal(analyzePythonControlFlow(source, symbol, { ...args, execute: () => JSON.stringify(invalid) }).diagnostic?.reason, "invalid_control_flow_response");
  }
  assert.equal(analyzePythonControlFlow(source, symbol, { ...args, execute: () => "{" }).diagnostic?.reason, "analysis_failed");
  assert.equal(analyzePythonControlFlow(source, symbol, { ...args, execute: () => "x".repeat(64_000_001) }).diagnostic?.reason, "output_budget_exceeded");
  assert.equal(analyzePythonControlFlow(file("x".repeat(24_000_001)), symbol, args).diagnostic?.reason, "input_budget_exceeded");
  const error = (code: string) => Object.assign(new Error("secret subprocess output"), { code });
  assert.equal(analyzePythonControlFlow(source, symbol, { ...args, execute: () => { throw error("ENOENT"); } }).diagnostic?.reason, "python_runtime_unavailable");
  assert.equal(analyzePythonControlFlow(source, symbol, { ...args, execute: () => { throw error("ETIMEDOUT"); } }).diagnostic?.reason, "analysis_timed_out");
  assert.equal(analyzePythonControlFlow(source, symbol, { ...args, execute: () => { throw error("EFAIL"); } }).diagnostic?.reason, "analysis_failed");
  const executed = analyzePythonControlFlow(source, symbol);
  assert.equal(executed.result?.status, "complete");
});

test("Python data-flow adapter validates bounded responses and reports subprocess failures safely", () => {
  const source = file("def route(value): return value");
  const symbol = { id: "route-id", name: "route", startOffset: 4 };
  const args = { analyzerPath: "/worker" };
  const valid = { format: "craft-python-data-flow-v1", language: "python", status: "complete", candidates: [], definitions: [],
    uses: [], flows: [], partial_reasons: [], source_content_included: false };
  assert.equal(analyzePythonDataFlow(source, symbol, "value", { cwd: "/repo", fileExists: () => false }).diagnostic?.reason, "analyzer_not_packaged");
  assert.equal(analyzePythonDataFlow(source, symbol, "value", { ...args, execute: (_command, _args, input) => {
    assert.match(input, /data_flow_query/u); return JSON.stringify(valid);
  } }).result?.status, "complete");
  for (const invalid of [{ ...valid, format: "wrong" }, { ...valid, language: "typescript" }, { ...valid, candidates: "wrong" },
    { ...valid, definitions: "wrong" }, { ...valid, uses: "wrong" }, { ...valid, flows: "wrong" }, { ...valid, partial_reasons: "wrong" }]) {
    assert.equal(analyzePythonDataFlow(source, symbol, "value", { ...args, execute: () => JSON.stringify(invalid) }).diagnostic?.reason, "invalid_data_flow_response");
  }
  assert.equal(analyzePythonDataFlow(source, symbol, "value", { ...args, execute: () => "{" }).diagnostic?.reason, "analysis_failed");
  assert.equal(analyzePythonDataFlow(source, symbol, "value", { ...args, execute: () => "x".repeat(64_000_001) }).diagnostic?.reason, "output_budget_exceeded");
  assert.equal(analyzePythonDataFlow(file("x".repeat(24_000_001)), symbol, "value", args).diagnostic?.reason, "input_budget_exceeded");
  const error = (code: string) => Object.assign(new Error("secret subprocess output"), { code });
  assert.equal(analyzePythonDataFlow(source, symbol, "value", { ...args, execute: () => { throw error("ENOENT"); } }).diagnostic?.reason, "python_runtime_unavailable");
  assert.equal(analyzePythonDataFlow(source, symbol, "value", { ...args, execute: () => { throw error("ETIMEDOUT"); } }).diagnostic?.reason, "analysis_timed_out");
  assert.equal(analyzePythonDataFlow(source, symbol, "value", { ...args, execute: () => { throw error("EFAIL"); } }).diagnostic?.reason, "analysis_failed");
  assert.equal(analyzePythonDataFlow(source, symbol, "value").result?.status, "complete");
});

test("language graph merge preserves file nodes, interleaves symbols and filters missing endpoints", () => {
  assert.equal(combineLanguageAnalyses([]), undefined);
  const pyFile = node("py-file", "file"), tsFile = node("ts-file", "file", "ts");
  const pySymbol = node("py-symbol", "symbol", "py"), tsSymbol = node("ts-symbol", "symbol", "ts");
  const edge = (from: string, to: string): JsonObject => ({ kind: "calls", from_node_id: from, to_node_id: to, source_span: { start_offset: 0, end_offset: 0 } });
  const merged = combineLanguageAnalyses([graph("py", [pyFile, pySymbol], [edge("py-symbol", "py-file"), edge("missing", "py-file")], { budget_limited: true }),
    graph("ts", [tsFile, tsSymbol], [edge("ts-symbol", "ts-file")])], [{ language: "java", reason: "no_adapter" }])!;
  assert.equal(merged.analyzer, "multi-language-static");
  assert.deepEqual((merged.nodes as JsonObject[]).map(item => item.id), ["py-file", "ts-file", "py-symbol", "ts-symbol"]);
  assert.equal((merged.edges as JsonObject[]).length, 2);
  assert.equal((merged.diagnostics as JsonObject).budget_limited, true);
  assert.equal(((merged.diagnostics as JsonObject).degraded_languages as JsonObject[]).length, 1);
  const clean: JsonObject = graph("go", [node("go-file", "file", "go")]); delete clean.diagnostics;
  const cleanMerged = combineLanguageAnalyses([clean])!;
  assert.equal((cleanMerged.diagnostics as JsonObject).budget_limited, false);
  assert.deepEqual((cleanMerged.diagnostics as JsonObject).languages, [{ analyzer: "go-static", diagnostics: {} }]);
  const explicit = graph("go", [node("go-file-2", "file", "go")], [], { budget_limited: false });
  assert.equal((combineLanguageAnalyses([explicit])!.diagnostics as JsonObject).budget_limited, false);
});

test("language graph merge reports node and edge omissions and enforces required file nodes", () => {
  assert.equal(combineLanguageAnalyses([{ nodes: [], edges: "invalid" }]), undefined);
  const required = node("f", "file");
  const symbols = Array.from({ length: 60_001 }, (_, index) => node(`s${index}`, "symbol"));
  const bounded = combineLanguageAnalyses([graph("py", [required, ...symbols])])!;
  assert.equal((bounded.diagnostics as JsonObject).budget_limited, true);
  assert(Number((bounded.diagnostics as JsonObject).omitted_nodes) > 0);
  const largeSymbol = node("large", "symbol"); largeSymbol.name = "x".repeat(64_000_001);
  const charBounded = combineLanguageAnalyses([graph("py", [required, largeSymbol])])!;
  assert(Number((charBounded.diagnostics as JsonObject).omitted_nodes) > 0);
  const largeEdges = Array.from({ length: 300_001 }, () => ({ kind: "calls", from_node_id: "s0", to_node_id: "s0", source_span: { start_offset: 0, end_offset: 0 } }));
  const edgeBounded = combineLanguageAnalyses([graph("py", [required, node("s0", "symbol")], largeEdges)])!;
  assert(Number((edgeBounded.diagnostics as JsonObject).omitted_edges) > 0);
  const enormousFile = node("huge", "file"); enormousFile.name = "x".repeat(64_000_001);
  assert.throws(() => combineLanguageAnalyses([graph("py", [enormousFile])]), /Required file nodes/);
});
