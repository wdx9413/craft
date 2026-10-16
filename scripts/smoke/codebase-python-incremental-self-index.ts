import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { repositoryFiles } from "../../capability/craft-codebase/repository-files.ts";
import { analyzePythonCheckpoint } from "../../capability/craft-codebase/python-analysis.ts";
import { planPythonIncremental } from "../../capability/craft-codebase/python-incremental.ts";
import type { PythonFileUnit } from "../../capability/craft-codebase/python-incremental.ts";

const source = repositoryFiles(process.cwd());
assert.equal(source.state, "ready");
const files = source.files.filter(file => file.language === "py");
assert(files.length > 0, "repository must contain Python files for incremental verification");
const measure = <T>(operation: () => T): { value: T; elapsedMs: number } => {
  const started = performance.now(); const value = operation();
  return { value, elapsedMs: Math.round(performance.now() - started) };
};
const initial = measure(() => analyzePythonCheckpoint(files, { includeFileUnits: true }));
const initialUnits = initial.value.analysis?.file_units as PythonFileUnit[] | undefined;
assert(initialUnits?.length === files.length, "initial full Python analysis must produce one complete unit per file");
const target = files[0]!;
const updatedContent = `${target.content}\n# isolated incremental verification\n`;
const changedFiles = files.map(file => file.path === target.path
  ? { ...file, content: updatedContent, digest: createHash("sha256").update(updatedContent).digest("hex") }
  : file);
const plan = planPythonIncremental(changedFiles, initialUnits);
assert.equal(plan.mode, "incremental");
assert(plan.affected_paths.includes(target.path), "changed module must be reparsed");
const reused = new Set(plan.reused_paths);
const cached = initialUnits.filter(unit => reused.has(unit.path));
const incremental = measure(() => analyzePythonCheckpoint(changedFiles, { includePaths: plan.affected_paths, includeFileUnits: true,
  cachedFileUnits: cached }));
assert.equal(incremental.value.analysis?.diagnostics && (incremental.value.analysis.diagnostics as Record<string, unknown>).incremental_mode, "incremental");
const incrementalUnits = incremental.value.analysis?.file_units as PythonFileUnit[] | undefined;
assert.deepEqual(incrementalUnits?.map(unit => unit.path), plan.affected_paths);
const clean = measure(() => analyzePythonCheckpoint(changedFiles, { includeFileUnits: true }));
const cleanUnits = clean.value.analysis?.file_units as PythonFileUnit[] | undefined;
assert(cleanUnits?.length === files.length, "clean rebuild must return every Python file unit");
const merge = (units: readonly PythonFileUnit[], key: "nodes" | "edges") => units.flatMap(unit => unit[key])
  .sort((left, right) => String(left.id ?? `${left.from_node_id}:${left.to_node_id}:${left.kind}`)
    .localeCompare(String(right.id ?? `${right.from_node_id}:${right.to_node_id}:${right.kind}`)));
const merged = [...incrementalUnits!, ...cached];
assert.deepEqual(merge(merged, "nodes"), merge(cleanUnits, "nodes"));
assert.deepEqual(merge(merged, "edges"), merge(cleanUnits, "edges"));
console.log(JSON.stringify({ source_repository: process.cwd(), indexed_python_files: files.length, changed_file: target.path,
  incremental_reason: plan.reason,
  parsed_file_count: incrementalUnits!.length, reused_file_count: cached.length, initial_full_analysis_ms: initial.elapsedMs,
  incremental_analysis_ms: incremental.elapsedMs, clean_full_rebuild_ms: clean.elapsedMs, graph_matches_full_rebuild: true,
  node_count: merge(merged, "nodes").length, edge_count: merge(merged, "edges").length,
  analyzer_version: incrementalUnits![0]!.analyzer_version }, null, 2));
