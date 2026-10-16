import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { JsonObject } from "../common/craft-common-store-local/src/store.ts";
import { javaFileUnitDigest, planJavaIncremental, type JavaFileUnit } from "../capability/craft-codebase/java-incremental.ts";
import type { RepositoryFile } from "../capability/craft-codebase/repository-files.ts";

const file = (path: string, content = path): RepositoryFile => ({ path, content, language: "java",
  digest: createHash("sha256").update(content, "utf8").digest("hex") });
const unit = (path: string, source: RepositoryFile, packageName: string, nodes: JsonObject[] = [], edges: JsonObject[] = [], extra: Partial<JavaFileUnit> = {}): JavaFileUnit => {
  const value = { path, source_digest: source.digest, analyzer: "jdk-compiler-tree" as const, analyzer_version: "craft-java-javac-v1" as const, package_name: packageName,
    nodes, edges, unresolved_calls: 0, unresolved_imports: 0, incremental_safe: true, budget_limited: false, ...extra };
  return { ...value, unit_digest: javaFileUnitDigest(value) };
};

test("Java incremental planner reuses unchanged units and invalidates cross-file and package dependents", () => {
  const base = file("api/Base.java", "package api; class Base { void run() {} }");
  const caller = file("app/Worker.java", "package app; class Worker extends api.Base { void work() { run(); } }");
  const packagePeer = file("api/Peer.java", "package api; class Peer {}");
  const unrelated = file("util/Format.java", "package util; class Format {}");
  const units = [
    unit(base.path, base, "api", [{ id: "base", path: base.path }], [
      { kind: "calls", from_node_id: "base", to_node_id: "base" },
      { kind: "imports", from_node_id: "base", to_node_id: "external_library_symbol" },
      { kind: "references", from_node_id: "base", to_node_id: "base" },
    ]),
    unit(caller.path, caller, "app", [{ id: "worker", path: caller.path }], [
      { kind: "extends", from_node_id: "worker", to_node_id: "base" },
      { kind: "calls", from_node_id: "worker", to_node_id: "base" },
      { kind: "references", from_node_id: "worker", to_node_id: "base" },
      { kind: "implements", from_node_id: "worker", to_node_id: "base" },
      { kind: "type_definition", from_node_id: "worker", to_node_id: "base" },
    ]),
    unit(packagePeer.path, packagePeer, "api", [{ id: "peer", path: packagePeer.path }]),
    unit(unrelated.path, unrelated, "util", [{ id: "format", path: unrelated.path }], [
      { kind: "contains", from_node_id: "format", to_node_id: "base" },
    ]),
  ];
  assert.deepEqual(planJavaIncremental([base, caller, packagePeer, unrelated], units, "craft-java-javac-v1"), {
    mode: "reuse", affected_paths: [], reused_paths: [base.path, caller.path, packagePeer.path, unrelated.path].sort(), reason: "all_source_digests_match",
  });
  const changedBase = file(base.path, `${base.content}\n// update`);
  const plan = planJavaIncremental([changedBase, caller, packagePeer, unrelated], units, "craft-java-javac-v1");
  assert.equal(plan.mode, "incremental");
  assert.deepEqual(plan.affected_paths, [base.path, caller.path, packagePeer.path].sort());
  assert.deepEqual(plan.reused_paths, [unrelated.path]);
});

test("Java incremental planner rebuilds on path, analyzer, cache-integrity, budget, and unresolved changes", () => {
  const original = [file("a/A.java"), file("b/B.java")];
  const cache = original.map(item => unit(item.path, item, item.path === "a/A.java" ? "a" : "b", [{ id: item.path, path: item.path }]));
  const full = (files: readonly RepositoryFile[], units: readonly JsonObject[], version = "craft-java-javac-v1") =>
    planJavaIncremental(files, units, version);
  assert.equal(full(original, []).reason, "no_reusable_file_units");
  assert.equal(full([original[0]!], cache).reason, "source_file_set_changed");
  assert.equal(full(original, cache, "new-analyzer").reason, "invalid_or_incompatible_file_cache");
  assert.equal(full(original, [{ ...cache[0], unit_digest: "stale" }, cache[1]!]).reason, "invalid_or_incompatible_file_cache");
  assert.equal(full(original, [cache[0]!, { ...cache[1]!, budget_limited: true }]).reason, "invalid_or_incompatible_file_cache");
  const unresolved = unit(original[0]!.path, original[0]!, "a", [], [], { unresolved_calls: 1, incremental_safe: false });
  assert.deepEqual(full(original, [unresolved, cache[1]!]), {
    mode: "incremental", affected_paths: [original[0]!.path], reused_paths: [original[1]!.path], reason: "unsafe_files_and_reverse_dependency_closure",
  });
  const unsafe = unit(original[0]!.path, original[0]!, "a", [], [], { incremental_safe: false });
  assert.deepEqual(full(original, [unsafe, cache[1]!]), {
    mode: "incremental", affected_paths: [original[0]!.path], reused_paths: [original[1]!.path], reason: "unsafe_files_and_reverse_dependency_closure",
  });
  const allUnsafe = [unsafe, unit(original[1]!.path, original[1]!, "b", [], [], { incremental_safe: false })];
  assert.equal(full(original, allUnsafe).reason, "all_java_units_require_reanalysis");
  const edited = file(original[0]!.path, "updated without known dependents");
  assert.deepEqual(full([edited, original[1]!], cache), {
    mode: "incremental", affected_paths: [edited.path], reused_paths: [original[1]!.path], reason: "changed_files_and_reverse_dependency_closure",
  });
});

test("Java cache validation rejects duplicate and malformed units instead of merging them", () => {
  const source = file("src/Main.java");
  const cached = unit(source.path, source, "src", [{ id: "main", path: source.path }]);
  assert.equal(planJavaIncremental([source], [cached, cached], "craft-java-javac-v1").reason, "invalid_or_incompatible_file_cache");
  assert.equal(planJavaIncremental([source], [{ ...cached, edges: {} }], "craft-java-javac-v1").reason, "invalid_or_incompatible_file_cache");
});
