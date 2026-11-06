import assert from "node:assert/strict";
import test from "node:test";
import { planTypeScriptIncremental } from "../capability/craft-codebase/typescript-incremental.ts";
import { typeScriptFileUnitDigest, TYPESCRIPT_ANALYZER_VERSION, type TypeScriptFileUnit } from "../capability/craft-codebase/typescript-analysis.ts";
import { stableDigest } from "../common/craft-common-base/src/digest.ts";
import type { RepositoryFile } from "../capability/craft-codebase/repository-files.ts";
import type { JsonObject } from "../common/craft-common-store-local/src/store.ts";

const files: RepositoryFile[] = [
  { path: "a.ts", content: "export const a = 1", digest: "a1", language: "ts" },
  { path: "b.ts", content: 'import { a } from "./a"; export const b = a', digest: "b1", language: "ts" },
  { path: "c.ts", content: "export const c = 3", digest: "c1", language: "ts" },
];
const unit = (path: string, source_digest: string, nodes: JsonObject[], edges: JsonObject[] = [], external_module = true): TypeScriptFileUnit => {
  const value = { path, source_digest, analyzer_version: TYPESCRIPT_ANALYZER_VERSION, external_module, nodes, edges, unresolved_relations: 0, budget_limited: false };
  return { ...value, unit_digest: typeScriptFileUnitDigest(value) };
};
const cache: TypeScriptFileUnit[] = [
  unit("a.ts", "a1", [{ id: "file-a", kind: "file", path: "a.ts" }, { id: "symbol-a", kind: "symbol", path: "a.ts" }]),
  unit("b.ts", "b1", [{ id: "file-b", kind: "file", path: "b.ts" }, { id: "symbol-b", kind: "symbol", path: "b.ts" }], [
    { kind: "imports", from_node_id: "file-b", to_node_id: "file-a" },
  ]),
  unit("c.ts", "c1", [{ id: "file-c", kind: "file", path: "c.ts" }, { id: "symbol-c", kind: "symbol", path: "c.ts" }]),
];

test("TypeScript incremental planner reuses exact snapshots and computes reverse import closure", () => {
  const unchanged = planTypeScriptIncremental(files, cache, TYPESCRIPT_ANALYZER_VERSION);
  assert.equal(unchanged.mode, "reuse");
  assert.deepEqual(unchanged.reused_paths, ["a.ts", "b.ts", "c.ts"]);

  const modified = files.map(file => file.path === "a.ts" ? { ...file, digest: "a2", content: "export const a = 2" } : file);
  const incremental = planTypeScriptIncremental(modified, cache, TYPESCRIPT_ANALYZER_VERSION);
  assert.equal(incremental.mode, "incremental");
  assert.deepEqual(incremental.affected_paths, ["a.ts", "b.ts"]);
  assert.deepEqual(incremental.reused_paths, ["c.ts"]);

  const isolated = files.map(file => file.path === "c.ts" ? { ...file, digest: "c2" } : file);
  assert.deepEqual(planTypeScriptIncremental(isolated, cache, TYPESCRIPT_ANALYZER_VERSION).affected_paths, ["c.ts"]);
});

test("TypeScript incremental planner falls back for file set, cache and analyzer ambiguities", () => {
  assert.equal(planTypeScriptIncremental([...files, { path: "d.ts", content: "", digest: "d1", language: "ts" }], cache, TYPESCRIPT_ANALYZER_VERSION).reason, "source_file_set_changed");
  assert.equal(planTypeScriptIncremental(files, [], TYPESCRIPT_ANALYZER_VERSION).reason, "source_file_set_changed");
  assert.equal(planTypeScriptIncremental(files, [{ ...cache[0]!, analyzer_version: "old" }, cache[1]!, cache[2]!], TYPESCRIPT_ANALYZER_VERSION).reason, "invalid_or_incompatible_file_cache");
  assert.equal(planTypeScriptIncremental(files, [...cache, cache[0]!], TYPESCRIPT_ANALYZER_VERSION).reason, "invalid_or_incompatible_file_cache");
  assert.equal(planTypeScriptIncremental(files, [{ ...cache[0]!, budget_limited: true }, cache[1]!, cache[2]!], TYPESCRIPT_ANALYZER_VERSION).reason, "invalid_or_incompatible_file_cache");
  assert.equal(planTypeScriptIncremental(files, [{ ...cache[0]!, nodes: [{ id: "corrupted" }] }, cache[1]!, cache[2]!], TYPESCRIPT_ANALYZER_VERSION).reason, "invalid_or_incompatible_file_cache");
  const scriptUnit = unit("a.ts", "a1", cache[0]!.nodes, [], false);
  assert.equal(planTypeScriptIncremental(files, [scriptUnit, cache[1]!, cache[2]!], TYPESCRIPT_ANALYZER_VERSION).reason, "global_or_ambient_type_scope");
  const declarationFiles = files.map(file => file.path === "a.ts" ? { ...file, path: "a.d.ts", digest: "a2", content: "declare const a: number" } : file);
  const declarationCache = [unit("a.d.ts", "a1", [{ id: "file-a", kind: "file", path: "a.d.ts" }]), cache[1]!, cache[2]!];
  assert.equal(planTypeScriptIncremental(declarationFiles, declarationCache, TYPESCRIPT_ANALYZER_VERSION).reason, "global_or_ambient_type_scope");
  const scriptChange = files.map(file => file.path === "a.ts" ? { ...file, digest: "a2", content: "const a = 2" } : file);
  assert.equal(planTypeScriptIncremental(scriptChange, cache, TYPESCRIPT_ANALYZER_VERSION).reason, "changed_module_scope_is_ambiguous");
  const globalChange = files.map(file => file.path === "a.ts" ? { ...file, digest: "a2", content: "export {}; declare global {}" } : file);
  assert.equal(planTypeScriptIncremental(globalChange, cache, TYPESCRIPT_ANALYZER_VERSION).reason, "changed_module_scope_is_ambiguous");
});

test("TypeScript incremental planner reanalyzes uncached units only when the pinned file set is unchanged", () => {
  const pathSetDigest = stableDigest(files.map(file => file.path).sort());
  const incompleteCache = cache.filter(item => item.path !== "c.ts");
  const incremental = planTypeScriptIncremental(files, incompleteCache, TYPESCRIPT_ANALYZER_VERSION, pathSetDigest);
  assert.equal(incremental.mode, "incremental");
  assert.equal(incremental.reason, "changed_and_uncached_modules_and_reverse_import_closure");
  assert.deepEqual(incremental.affected_paths, ["c.ts"]);
  assert.deepEqual(incremental.reused_paths, ["a.ts", "b.ts"]);
  assert.equal(planTypeScriptIncremental(files, incompleteCache, TYPESCRIPT_ANALYZER_VERSION, "stale-path-set").reason, "source_file_set_changed");
  assert.equal(planTypeScriptIncremental(files, [], TYPESCRIPT_ANALYZER_VERSION, pathSetDigest).reason, "no_reusable_file_units");
  assert.equal(planTypeScriptIncremental(files.filter(file => file.path !== "c.ts"), cache, TYPESCRIPT_ANALYZER_VERSION).reason, "source_file_set_changed");
});
