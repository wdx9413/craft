import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { ProjectAnalysisCache } from "../../capability/craft-codebase/project-analysis-cache.ts";
import { ProjectGraphStore } from "../../capability/craft-codebase/project-graph-store.ts";
import { planTypeScriptIncremental } from "../../capability/craft-codebase/typescript-incremental.ts";
import { analyzeTypeScript, TYPESCRIPT_ANALYZER_VERSION, type TypeScriptAnalysisOptions } from "../../capability/craft-codebase/typescript-analysis.ts";
import { repositoryFiles } from "../../capability/craft-codebase/repository-files.ts";
import type { RepositoryOnboardingPort } from "../../capability/craft-codebase/repository-onboarding.ts";
import type { RepositoryFile } from "../../capability/craft-codebase/repository-files.ts";
import { CraftStore } from "../../core/infrastructure/store.ts";
import { craftPaths } from "../../core/infrastructure/paths.ts";
import { CraftService } from "../../core/service.ts";

const sourceRoot = resolve(process.cwd());
const rounds = Number(process.argv[2] ?? 5);
assert(Number.isSafeInteger(rounds) && rounds >= 2 && rounds <= 20, "benchmark rounds must be an integer between 2 and 20");
const temporaryRoot = mkdtempSync(join(tmpdir(), "craft-codebase-incremental-"));
const projectRoot = join(temporaryRoot, "project");
mkdirSync(projectRoot);
const source = repositoryFiles(sourceRoot);
assert.equal(source.state, "ready");
const benchmarkFiles = source.files.filter(file => {
  if (!/^(?:tsx?|mts|cts|jsx?|mjs|cjs)$/u.test(file.language) || /\.d\.ts$/u.test(file.path)) return false;
  const parsed = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, false);
  return ts.isExternalModule(parsed) && !/\bdeclare\s+(?:global|module)\b/u.test(file.content);
});
assert(benchmarkFiles.length > 0, "repository must contain ordinary external modules for incremental measurement");
for (const file of benchmarkFiles) {
  const destination = join(projectRoot, file.path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, file.content);
}
execFileSync("git", ["init", "--quiet", projectRoot]);

async function openStore(name: string): Promise<CraftStore> {
  return await new CraftStore(craftPaths(join(temporaryRoot, name))).open();
}
function graphDigest(store: CraftStore, indexId: string): string {
  const index = store.get("codebase_index", indexId);
  return String(index.graph_digest);
}
function graphDiff(leftStore: CraftStore, leftIndexId: string, rightStore: CraftStore, rightIndexId: string) {
  const read = (store: CraftStore, indexId: string) => {
    const index = store.get("codebase_index", indexId);
    const workspace = store.get("workspace", String(index.workspace_id));
    const graph = new ProjectGraphStore(String(workspace.root_path), String(workspace.id));
    const shards = (index.shard_ids as string[]).map(id => graph.read(id));
    return { nodes: shards.flatMap(shard => shard.nodes as Record<string, unknown>[]), edges: shards.flatMap(shard => shard.edges as Record<string, unknown>[]) };
  };
  const left = read(leftStore, leftIndexId), right = read(rightStore, rightIndexId);
  const compare = (a: Record<string, unknown>[], b: Record<string, unknown>[]) => {
    const aById = new Map(a.map(item => [String(item.id), item])), bById = new Map(b.map(item => [String(item.id), item]));
    return { left_count: a.length, right_count: b.length,
      only_left: [...aById.keys()].filter(id => !bById.has(id)).slice(0, 5),
      only_right: [...bById.keys()].filter(id => !aById.has(id)).slice(0, 5),
      changed: [...aById.keys()].filter(id => bById.has(id) && JSON.stringify(aById.get(id)) !== JSON.stringify(bById.get(id))).slice(0, 5) };
  };
  return { nodes: compare(left.nodes, right.nodes), edges: compare(left.edges, right.edges) };
}
function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle]! : Math.round((ordered[middle - 1]! + ordered[middle]!) / 2);
}
function instrument(service: CraftService) {
  const timings = { analyzer_ms: 0, analyzer_calls: 0, import_ms: 0, import_calls: 0, source_file_ms: 0, source_file_calls: 0,
    persist_index_ms: 0, persist_index_calls: 0, batch_persist_ms: 0, batch_persist_calls: 0, batch_persist_records: 0 };
  const reset = () => {
    timings.analyzer_ms = 0; timings.analyzer_calls = 0; timings.import_ms = 0; timings.import_calls = 0;
    timings.source_file_ms = 0; timings.source_file_calls = 0; timings.persist_index_ms = 0; timings.persist_index_calls = 0;
    timings.batch_persist_ms = 0; timings.batch_persist_calls = 0; timings.batch_persist_records = 0;
  };
  const port = service as unknown as RepositoryOnboardingPort;
  const analyze = port.analyzeTypeScript ?? analyzeTypeScript;
  const importAnalysis = port.codebaseAnalysisImport.bind(service);
  port.analyzeTypeScript = (files: readonly RepositoryFile[], options?: TypeScriptAnalysisOptions) => {
    const started = performance.now();
    try { return analyze(files, options); }
    finally { timings.analyzer_ms += performance.now() - started; timings.analyzer_calls++; }
  };
  port.codebaseAnalysisImport = args => {
    const started = performance.now();
    try { return importAnalysis(args); }
    finally { timings.import_ms += performance.now() - started; timings.import_calls++; }
  };
  const kernel = service.codebase as unknown as {
    sourceFile: (...args: unknown[]) => unknown;
    persistIndex: (...args: unknown[]) => unknown;
  };
  const sourceFile = kernel.sourceFile.bind(kernel);
  kernel.sourceFile = (...args) => {
    const started = performance.now();
    try { return sourceFile(...args); }
    finally { timings.source_file_ms += performance.now() - started; timings.source_file_calls++; }
  };
  const persistIndex = kernel.persistIndex.bind(kernel);
  kernel.persistIndex = (...args) => {
    const started = performance.now();
    try { return persistIndex(...args); }
    finally { timings.persist_index_ms += performance.now() - started; timings.persist_index_calls++; }
  };
  const createBatch = service.store.createBatch.bind(service.store);
  service.store.createBatch = entries => {
    const started = performance.now();
    try { return createBatch(entries); }
    finally {
      timings.batch_persist_ms += performance.now() - started;
      timings.batch_persist_calls++;
      timings.batch_persist_records += entries.length;
    }
  };
  return { timings, reset };
}

const incrementalStore = await openStore("incremental-data");
try {
  const incrementalService = new CraftService(incrementalStore);
  const incrementalInstrument = instrument(incrementalService);
  const initialStart = performance.now();
  const initial = incrementalService.codebaseRepositoryEnsure({ project_root: projectRoot, index_depth: "semantic" });
  const initialMs = Math.round(performance.now() - initialStart);
  assert.equal(initial.status, "ready", JSON.stringify(initial));
  const roundsResult: Array<Record<string, unknown>> = [];
  for (let round = 0; round < rounds; round++) {
    incrementalInstrument.reset();
    const sourceFile = benchmarkFiles[round % benchmarkFiles.length]!;
    const changedPath = join(projectRoot, sourceFile.path);
    writeFileSync(changedPath, `${readFileSync(changedPath, "utf8")}\n// isolated incremental benchmark change ${round + 1}\n`);
    const changedSnapshot = repositoryFiles(projectRoot);
    const cachedUnits = new ProjectAnalysisCache(projectRoot, String(initial.workspace_id))
      .list("codebase_semantic_file_analysis", 1_000);
    const repositoryState = incrementalStore.get("codebase_repository_state", `${String(initial.workspace_id)}_semantic`);
    const incrementalPlan = planTypeScriptIncremental(changedSnapshot.files
      .filter(file => /^(?:tsx?|mts|cts|jsx?|mjs|cjs)$/u.test(file.language))
      .map(file => ({ ...file, language: file.language === "tsx" ? "jsx" : file.language })), cachedUnits, TYPESCRIPT_ANALYZER_VERSION,
      String(repositoryState.typescript_path_set_digest));
    assert.equal(incrementalPlan.mode, "incremental", `round ${round + 1} single-file mutation should plan a bounded incremental update: ${JSON.stringify({
      reason: incrementalPlan.reason, selected_files: changedSnapshot.files.filter(file => /^(?:tsx?|mts|cts|jsx?|mjs|cjs)$/u.test(file.language)).length,
      cached_file_units: cachedUnits.length, initial_diagnostics: (initial.summary as Record<string, unknown>)?.diagnostics, changed_path: sourceFile.path })}`);

    const incrementalStart = performance.now();
    const incremental = incrementalService.codebaseRepositoryEnsure({ project_root: projectRoot, index_depth: "semantic" });
    const incrementalMs = Math.round(performance.now() - incrementalStart);
    assert.equal(incremental.status, "ready");
    assert.notEqual(incremental.index_id, initial.index_id);
    const incrementalIndex = incrementalStore.get("codebase_index", String(incremental.index_id));

    const fullStore = await openStore(`full-data-${round}`);
    try {
      const fullService = new CraftService(fullStore);
      const fullInstrument = instrument(fullService);
      const fullStart = performance.now();
      const cleanProjectRoot = join(temporaryRoot, `clean-project-${round}`);
      mkdirSync(cleanProjectRoot);
      for (const file of benchmarkFiles) {
        const destination = join(cleanProjectRoot, file.path);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, readFileSync(join(projectRoot, file.path), "utf8"), { encoding: "utf8", flag: "wx" });
      }
      execFileSync("git", ["init", "--quiet", cleanProjectRoot]);
      const full = fullService.codebaseRepositoryEnsure({ project_root: cleanProjectRoot, index_depth: "semantic" });
      const fullMs = Math.round(performance.now() - fullStart);
      assert.equal(full.status, "ready");
      const fullDiagnostics = (full.summary as Record<string, unknown>).diagnostics as Record<string, unknown>[];
      const fullTypeScript = (fullDiagnostics[0]?.languages as Record<string, unknown>[] | undefined)
        ?.find(language => language.analyzer === "typescript-checker")?.diagnostics as Record<string, unknown> | undefined;
      assert.equal(fullTypeScript?.incremental_mode, "full", "isolated clean rebuild must not reuse the incremental project's cache");
      if (graphDigest(incrementalStore, String(incremental.index_id)) !== graphDigest(fullStore, String(full.index_id))) {
        console.log(JSON.stringify({ round: round + 1, changed_file: sourceFile.path,
          incremental_graph: graphDigest(incrementalStore, String(incremental.index_id)),
          clean_graph: graphDigest(fullStore, String(full.index_id)),
          graph_difference: graphDiff(incrementalStore, String(incremental.index_id), fullStore, String(full.index_id)) }, null, 2));
        assert.fail(`round ${round + 1} incremental graph must equal a clean full rebuild`);
      }
      roundsResult.push({ round: round + 1, changed_file: sourceFile.path, incremental_update_ms: incrementalMs,
        clean_full_rebuild_ms: fullMs, incremental_mode: incrementalPlan.mode, incremental_reason: incrementalPlan.reason,
        affected_file_count: incrementalPlan.affected_paths.length, reused_file_count: incrementalPlan.reused_paths.length,
        incremental_analyzer_ms: Math.round(incrementalInstrument.timings.analyzer_ms),
        incremental_graph_import_ms: Math.round(incrementalInstrument.timings.import_ms),
        incremental_source_file_validation_ms: Math.round(incrementalInstrument.timings.source_file_ms),
        incremental_source_file_validation_calls: incrementalInstrument.timings.source_file_calls,
        incremental_persist_index_ms: Math.round(incrementalInstrument.timings.persist_index_ms),
        incremental_sqlite_batch_ms: Math.round(incrementalInstrument.timings.batch_persist_ms),
        incremental_batch_persist_records: incrementalInstrument.timings.batch_persist_records,
        full_analyzer_ms: Math.round(fullInstrument.timings.analyzer_ms),
        full_graph_import_ms: Math.round(fullInstrument.timings.import_ms),
        full_source_file_validation_ms: Math.round(fullInstrument.timings.source_file_ms),
        full_persist_index_ms: Math.round(fullInstrument.timings.persist_index_ms),
        full_sqlite_batch_ms: Math.round(fullInstrument.timings.batch_persist_ms),
        full_batch_persist_records: fullInstrument.timings.batch_persist_records,
        incremental_discovery_checkpoint_overhead_ms: Math.max(0, incrementalMs - Math.round(incrementalInstrument.timings.analyzer_ms) - Math.round(incrementalInstrument.timings.import_ms)),
        node_count: incrementalIndex.node_count, edge_count: incrementalIndex.edge_count,
        graph_digest: String(incrementalIndex.graph_digest), graph_matches_full_rebuild: true });
    } finally { fullStore.close(); }
  }
  const incrementalMs = roundsResult.map(row => Number(row.incremental_update_ms));
  const fullMs = roundsResult.map(row => Number(row.clean_full_rebuild_ms));

  console.log(JSON.stringify({
    source_repository: sourceRoot,
    isolated_project_files: benchmarkFiles.length,
    round_count: rounds,
    initial_cold_index_ms: initialMs,
    incremental_update_median_ms: median(incrementalMs),
    clean_full_rebuild_median_ms: median(fullMs),
    median_speedup_ratio: Number((median(fullMs) / Math.max(1, median(incrementalMs))).toFixed(2)),
    graph_matches_full_rebuild_every_round: roundsResult.every(row => row.graph_matches_full_rebuild === true),
    rounds: roundsResult,
  }, null, 2));
} finally {
  incrementalStore.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
}
