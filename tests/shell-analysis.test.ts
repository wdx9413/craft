import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonObject } from "../core/infrastructure/store.ts";
import type { RepositoryFile } from "../capability/craft-codebase/repository-files.ts";
import { analyzeShell } from "../capability/craft-codebase/shell-analysis.ts";

const file = (path: string, content: string, language: string): RepositoryFile =>
  ({ path, content, digest: createHash("sha256").update(content).digest("hex"), language, file_version: "1" });

const symbols = (analysis: JsonObject, name: string): JsonObject[] =>
  (analysis.nodes as JsonObject[]).filter((node) => node.kind === "symbol" && node.name === name);

test("POSIX shell definitions, source edges and calls resolve deterministically", () => {
  const lib = file("scripts/lib.sh", "deploy() {\n  echo deploy\n}\n", "sh");
  const main = file("scripts/main.sh", "source ./lib.sh\nmain() {\n  deploy\n}\nmain\n", "sh");
  const analysis = analyzeShell([lib, main]);
  assert.equal((analysis.diagnostics as JsonObject).relations, "analyzed");
  assert.equal(symbols(analysis, "deploy").length, 1);
  assert.equal(symbols(analysis, "main").length, 1);
  const edges = analysis.edges as JsonObject[];
  const imports = edges.filter((edge) => edge.kind === "imports");
  assert.equal(imports.length, 1);
  assert.equal((imports[0]!.source_span as JsonObject).start_offset, main.content.indexOf("./lib.sh"));
  const calls = edges.filter((edge) => edge.kind === "calls");
  assert(calls.some((edge) => edge.to_node_id === symbols(analysis, "deploy")[0]!.id));
  const ids = new Set((analysis.nodes as JsonObject[]).map((node) => node.id));
  assert.equal(edges.every((edge) => ids.has(edge.from_node_id) && ids.has(edge.to_node_id)), true);
});

test("PowerShell function/filter definitions and Import-Module edges are indexed", () => {
  const moduleFile = file("adapters/tool.psm1", "function Invoke-Tool { param($x) }\n", "psm1");
  const script = file("adapters/run.ps1", "Import-Module ./tool.psm1\nInvoke-Tool 1\n", "ps1");
  const analysis = analyzeShell([moduleFile, script]);
  assert.equal(symbols(analysis, "Invoke-Tool").length, 1);
  const edges = analysis.edges as JsonObject[];
  assert.equal(edges.filter((edge) => edge.kind === "imports").length, 1);
  assert(edges.some((edge) => edge.kind === "calls" && edge.to_node_id === symbols(analysis, "Invoke-Tool")[0]!.id));
});

test("an ambiguously named function produces no invented call edge", () => {
  const a = file("a.sh", "run() { echo a; }\n", "sh");
  const b = file("b.sh", "run() { echo b; }\n", "sh");
  const caller = file("c.sh", "run\n", "sh");
  const analysis = analyzeShell([a, b, caller]);
  assert.equal(symbols(analysis, "run").length, 2);
  assert.equal((analysis.edges as JsonObject[]).filter((edge) => edge.kind === "calls").length, 0);
});

test("unresolved source imports are counted, never emitted as dangling edges", () => {
  const main = file("main.sh", "source ./missing.sh\n", "sh");
  const analysis = analyzeShell([main]);
  assert.equal((analysis.diagnostics as JsonObject).unresolved_relations, 1);
  assert.equal((analysis.edges as JsonObject[]).length, 0);
});

test("function keyword form definitions are indexed", () => {
  const main = file("scripts/main.sh", "function main() {\n  echo hi\n}\nmain\n", "sh");
  const analysis = analyzeShell([main]);
  assert.equal(symbols(analysis, "main").length, 1);
  const edges = analysis.edges as JsonObject[];
  // The trailing "main" on its own line is a call invocation
  assert.equal(edges.filter((edge) => edge.kind === "calls").length, 1);
});

test("absolute and parent-relative source imports normalize to known files", () => {
  const lib = file("lib.sh", "deploy() { echo deploy; }\n", "sh");
  const absolute = file("scripts/absolute.sh", "source /lib.sh\n", "sh");
  const parent = file("scripts/parent.sh", "source ../lib.sh\n", "sh");
  const analysis = analyzeShell([lib, absolute, parent]);
  const imports = (analysis.edges as JsonObject[]).filter((edge) => edge.kind === "imports");
  assert.equal(imports.length, 2);
  assert.equal((analysis.diagnostics as JsonObject).unresolved_relations, 0);
});

test("bounded budgets omit nodes, symbols and edges without dangling endpoints", () => {
  const lib = file("lib.sh", "deploy() { echo deploy; }\n", "sh");
  const main = file("scripts/main.sh", "source /lib.sh\ndeploy\n", "sh");
  const analysis = analyzeShell([lib, main], { maxNodes: 0, maxEdges: 0 });
  const diagnostics = analysis.diagnostics as JsonObject;
  assert.equal((analysis.nodes as JsonObject[]).length, 0);
  assert.equal((analysis.edges as JsonObject[]).length, 0);
  assert.equal(diagnostics.budget_limited, true);
  assert.ok(Number(diagnostics.omitted_nodes) > 0);
  assert.ok(Number(diagnostics.omitted_edges) > 0);
});

test("call limits stop both the per-name scan and the per-match scan", () => {
  const main = file("scripts/main.sh", "foo() { }\nbar() { }\nfoo foo foo\nbar\n", "sh");
  const analysis = analyzeShell([main], { maxCallsPerFile: 1 });
  const calls = (analysis.edges as JsonObject[]).filter((edge) => edge.kind === "calls");
  assert.equal(calls.length, 1);
  const ids = new Set((analysis.nodes as JsonObject[]).map((node) => node.id));
  assert.equal(calls.every((edge) => ids.has(edge.from_node_id) && ids.has(edge.to_node_id)), true);
});

test("a symbol cap is enforced before duplicate-start and overflow paths are reached", () => {
  const main = file("scripts/main.sh", "foo() { }\nbar() { }\n", "sh");
  const analysis = analyzeShell([main], { maxSymbolsPerFile: 0 });
  assert.equal(symbols(analysis, "foo").length, 0);
  assert.equal(symbols(analysis, "bar").length, 0);
});
