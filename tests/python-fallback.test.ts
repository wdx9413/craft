import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { analyzePythonFallback } from "../capability/craft-codebase/python-fallback.ts";
import type { RepositoryFile } from "../capability/craft-codebase/repository-files.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { planPythonIncremental, pythonFileUnitDigest, type PythonFileUnit } from "../capability/craft-codebase/python-incremental.ts";
const file = (path: string, content: string): RepositoryFile => ({ path, content, language: "python", digest: createHash("sha256").update(content).digest("hex") });

test("Python fallback uses UTF-16 spans after Chinese and emoji and locates names beyond keywords", () => {
  const content = '# 中文😀\ndef f():\n    return "中文😀"\n\ndef caller():\n    value = "😀"\n    return f()\n';
  const result = analyzePythonFallback([file("main.py", content)]), nodes = result.nodes as JsonObject[], edges = result.edges as JsonObject[];
  const symbols = nodes.filter(node => node.kind === "symbol"); assert.equal(symbols.length, 2);
  for (const symbol of symbols) {
    const span = symbol.span as JsonObject, declaration = symbol.declaration_span as JsonObject;
    assert.equal(content.slice(Number(span.start_offset), Number(span.end_offset)), symbol.name);
    assert.equal(span.start_offset, content.indexOf(`def ${symbol.name}`) + 4);
    assert.ok(Number(declaration.end_offset) <= content.length);
  }
  assert.equal(edges.length, 1); const span = edges[0]!.source_span as JsonObject;
  assert.equal(span.start_offset, content.lastIndexOf("f()")); assert.equal(content.slice(Number(span.start_offset), Number(span.end_offset)), "f");
  assert.equal(nodes.find(node => node.id === edges[0]!.from_node_id)!.name, "caller");
  assert.equal(nodes.find(node => node.id === edges[0]!.to_node_id)!.name, "f");
  assert.equal(edges[0]!.provenance, "heuristic"); assert.equal(edges[0]!.confidence, "partial");
  assert.equal((result.diagnostics as JsonObject).fallback, true);
});

test("fallback call inference cannot reuse a caller after another file changes its definitions", () => {
  const before = [file("caller.py", "def caller():\n    helper()\n"), file("target.py", "def helper():\n    pass\n")];
  const analysis = analyzePythonFallback(before); assert.equal((analysis.edges as JsonObject[]).length, 1);
  const cached = (analysis.file_units as PythonFileUnit[]).map(unit => ({ ...unit, unit_digest: pythonFileUnitDigest(unit) }));
  const after = [before[0]!, file("target.py", "def replacement():\n    pass\n")];
  assert.equal((analyzePythonFallback(after).edges as JsonObject[]).length, 0);
  const plan = planPythonIncremental(after, cached);
  assert.ok(plan.affected_paths.includes("caller.py"), "an unchanged caller must be reconsidered when the global definition set changes");
  assert.equal(plan.reused_paths.includes("caller.py"), false);
});

test("Python fallback handles empty files, class methods and ambiguous calls without claiming AST semantics", () => {
  assert.deepEqual(analyzePythonFallback([]).nodes, []);
  const content = 'class Box:\n    # blank and comment lines do not end the body\n\n    async def method(self):\n        helper()\n        unknown()\n        method()\n        print("ignored")\n\ndef helper():\n    return 1\n';
  const result = analyzePythonFallback([file("box.py", content), file("empty.py", "")]);
  const nodes = result.nodes as JsonObject[], units = result.file_units as JsonObject[];
  assert.deepEqual(nodes.filter(node => node.kind === "symbol").map(node => node.declaration_kind), ["class", "method", "function"]);
  assert.equal((units[1]!.edges as JsonObject[]).length, 0);
  for (const unit of units) { assert.equal(unit.analyzer_version, result.analyzer_version); assert.equal(unit.incremental_safe, false); }
  const ambiguous = analyzePythonFallback([file("one.py", content), file("two.py", "def helper():\n    pass\n")]);
  assert.equal((ambiguous.edges as JsonObject[]).some(edge => {
    const target = (ambiguous.nodes as JsonObject[]).find(node => node.id === edge.to_node_id); return target?.name === "helper";
  }), false);
});
