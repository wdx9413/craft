import assert from "node:assert/strict";
import test from "node:test";
import { planPythonIncremental, pythonFileUnitDigest, type PythonFileUnit } from "../capability/craft-codebase/python-incremental.ts";
import type { RepositoryFile } from "../capability/craft-codebase/repository-files.ts";
import type { JsonObject } from "../common/craft-common-store-local/src/store.ts";

const files: RepositoryFile[] = [
  { path: "pkg/base.py", content: "def base(): pass", digest: "base1", language: "py" },
  { path: "pkg/service.py", content: "from .base import base", digest: "service1", language: "py" },
  { path: "pkg/view.py", content: "def view(): pass", digest: "view1", language: "py" },
];
const unit = (path: string, source_digest: string, nodes: JsonObject[], edges: JsonObject[] = [], safe = true, version = "stdlib-1"): PythonFileUnit => {
  const value = { path, source_digest, analyzer: "python-ast-static", analyzer_version: version, nodes, edges,
    class_methods: [],
    unresolved_calls: 0, unresolved_imports: 0, unresolved_relations: 0, incremental_safe: safe, budget_limited: false };
  return { ...value, unit_digest: pythonFileUnitDigest(value) };
};
const cache = [
  unit("pkg/base.py", "base1", [{ id: "base-file", kind: "file", path: "pkg/base.py" }, { id: "base-symbol", kind: "symbol", path: "pkg/base.py" }]),
  unit("pkg/service.py", "service1", [{ id: "service-file", kind: "file", path: "pkg/service.py" }], [
    { kind: "imports", from_node_id: "service-file", to_node_id: "base-file" },
  ]),
  unit("pkg/view.py", "view1", [{ id: "view-file", kind: "file", path: "pkg/view.py" }]),
];

test("Python incremental planner reuses stable modules and expands reverse import closure", () => {
  const unchanged = planPythonIncremental(files, cache);
  assert.equal(unchanged.mode, "reuse");
  assert.deepEqual(unchanged.reused_paths, ["pkg/base.py", "pkg/service.py", "pkg/view.py"]);

  const changed = files.map(file => file.path === "pkg/base.py" ? { ...file, digest: "base2", content: "def base(): return 1" } : file);
  const incremental = planPythonIncremental(changed, cache);
  assert.equal(incremental.mode, "incremental");
  assert.deepEqual(incremental.affected_paths, ["pkg/base.py", "pkg/service.py"]);
  assert.deepEqual(incremental.reused_paths, ["pkg/view.py"]);
});

test("Python incremental planner fails closed for changed file sets and corrupt caches", () => {
  assert.equal(planPythonIncremental([...files, { path: "pkg/new.py", content: "", digest: "new", language: "py" }], cache).reason, "source_file_set_changed");
  assert.equal(planPythonIncremental(files, [{ ...cache[0]!, incremental_safe: false }, cache[1]!, cache[2]!]).reason, "invalid_or_incompatible_file_cache");
  const mixed = [cache[0]!, unit("pkg/service.py", "service1", cache[1]!.nodes, cache[1]!.edges, true, "jedi-0.19.2"), cache[2]!];
  assert.equal(planPythonIncremental(files, mixed).reason, "mixed_analyzer_versions");
  assert.equal(planPythonIncremental(files, [{ ...cache[0]!, nodes: [{ id: "corrupt" }] }, cache[1]!, cache[2]!]).reason, "invalid_or_incompatible_file_cache");
  assert.equal(planPythonIncremental(files, [...cache, cache[0]!]).reason, "invalid_or_incompatible_file_cache");
});

test("Python incremental planner reparses dynamic modules and their known importers", () => {
  const dynamic = unit("pkg/base.py", "base1", cache[0]!.nodes, [], false);
  const unchanged = planPythonIncremental(files, [dynamic, cache[1]!, cache[2]!]);
  assert.equal(unchanged.mode, "incremental");
  assert.equal(unchanged.reason, "dynamic_modules_and_reverse_import_closure");
  assert.deepEqual(unchanged.affected_paths, ["pkg/base.py", "pkg/service.py"]);
  assert.deepEqual(unchanged.reused_paths, ["pkg/view.py"]);

  const changed = files.map(file => file.path === "pkg/view.py" ? { ...file, digest: "view2", content: "def view(): return 2" } : file);
  const both = planPythonIncremental(changed, [dynamic, cache[1]!, cache[2]!]);
  assert.equal(both.mode, "incremental");
  assert.equal(both.reason, "changed_and_dynamic_modules_and_reverse_import_closure");
  assert.deepEqual(both.affected_paths, ["pkg/base.py", "pkg/service.py", "pkg/view.py"]);
  assert.deepEqual(both.reused_paths, []);
});
