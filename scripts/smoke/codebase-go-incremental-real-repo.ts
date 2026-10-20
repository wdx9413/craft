import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { checkpointManifestDigest, readGitEvaluationState } from "../eval/codebase-evaluation-provenance.ts";
import { CODEBASE_LSP_CONFIG } from "../../capability/craft-codebase/lsp-config.ts";
import { ProjectGraphStore } from "../../capability/craft-codebase/project-graph-store.ts";
import { repositoryFiles } from "../../capability/craft-codebase/repository-files.ts";
import { CraftStore } from "../../core/infrastructure/store.ts";
import { craftPaths } from "../../core/infrastructure/paths.ts";
import { CraftService } from "../../core/service.ts";

const sourceRoot = resolve(process.argv[2] ?? "");
assert(process.argv[2], "usage: node --experimental-strip-types scripts/smoke/codebase-go-incremental-real-repo.ts <go-repository> [--lsp-config <trusted-config.json>]");
const configOption = process.argv.indexOf("--lsp-config");
assert(configOption < 0 || (process.argv[configOption + 1] && process.argv[configOption + 1]!.length > 0), "--lsp-config requires a config path");
const lspConfigMaterial = configOption < 0 ? undefined : readFileSync(resolve(process.argv[configOption + 1]!));
const allowDegradedLsp = process.argv.includes("--allow-degraded-lsp");
const configuredMaxGoDocuments = lspConfigMaterial
  ? Number(((JSON.parse(lspConfigMaterial.toString("utf8")) as JsonObject).adapters as JsonObject[]).find(item => item.language === "go")?.max_documents ?? 100)
  : Number.POSITIVE_INFINITY;
const sourceState = readGitEvaluationState(sourceRoot);
assert(sourceState.revision, "Go source repository must have Git provenance");
const craftRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const craftRevision = readGitEvaluationState(craftRoot);
const selected = repositoryFiles(sourceRoot);
assert.equal(selected.state, "ready", JSON.stringify(selected));
const goFiles = selected.files.filter(file => file.language === "go");
assert(goFiles.length > 1, "real repository must contain multiple Go source files");
const expectedGoAnalysisFiles = lspConfigMaterial ? Math.min(goFiles.length, configuredMaxGoDocuments) : goFiles.length;
let goLspDegraded = false;

const temporaryRoot = mkdtempSync(join(tmpdir(), "craft-go-incremental-real-repo-"));
const projectRoot = join(temporaryRoot, "project");
mkdirSync(projectRoot);
for (const file of goFiles) {
  const destination = join(projectRoot, file.path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, file.content, { encoding: "utf8", flag: "wx" });
}
for (const file of selected.context_files) {
  const destination = join(projectRoot, file.path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, file.content, { encoding: "utf8", flag: "wx" });
}
execFileSync("git", ["init", "--quiet", projectRoot]);

async function openStore(name: string): Promise<CraftStore> {
  const store = await new CraftStore(craftPaths(join(temporaryRoot, name))).open();
  if (lspConfigMaterial) writeFileSync(join(store.paths.configDir, CODEBASE_LSP_CONFIG), lspConfigMaterial, { flag: "wx" });
  return store;
}
function ensureRepository(service: CraftService): JsonObject {
  const previousEntry = process.argv[1];
  process.argv[1] = resolve(dirname(fileURLToPath(import.meta.url)), "../../bin/craft-mcp.ts");
  try { return service.codebaseRepositoryEnsure({ project_root: projectRoot, index_depth: "semantic" }); }
  finally { process.argv[1] = previousEntry!; }
}
function goDiagnostics(result: JsonObject): JsonObject {
  const diagnostics = (result.summary as JsonObject | undefined)?.diagnostics;
  assert(Array.isArray(diagnostics), "semantic index must expose diagnostics");
  if (lspConfigMaterial && !goLspDegraded) {
    const degraded = ((diagnostics[0] as JsonObject).degraded_languages as JsonObject[] | undefined)?.find(item => item.language === "go");
    if (degraded?.semantic_adapter_status === "unavailable" || degraded?.fallback_analyzer === "craft-basic-symbols") {
      goLspDegraded = true;
      if (!allowDegradedLsp) throw new Error(`Go semantic analyzer unavailable: ${JSON.stringify(degraded)}`);
    }
  }
  const languages = (diagnostics[0] as JsonObject).languages;
  if (!Array.isArray(languages)) {
    const unavailable = (diagnostics[0] as JsonObject).language === "go" ? diagnostics[0] as JsonObject : undefined;
    if (unavailable) throw new Error(`Go semantic analyzer unavailable: ${JSON.stringify(unavailable)}`);
    assert.fail(`Go analyzer diagnostics must be present: ${JSON.stringify(result.summary)}`);
  }
  const go = (languages as JsonObject[]).find(item => item.analyzer === (lspConfigMaterial && !goLspDegraded ? "lsp-go" : "craft-basic-symbols"));
  assert(go && go.diagnostics && typeof go.diagnostics === "object", "Go analyzer summary must exist");
  if (Array.isArray(go.diagnostics)) {
    const basic = (go.diagnostics as JsonObject[]).find(item => item.kind === "basic_analysis");
    assert(basic, "basic Go analyzer diagnostics must exist");
    return basic;
  }
  return go.diagnostics as JsonObject;
}
function graphDigest(store: CraftStore, indexId: string): string {
  return String(store.get("codebase_index", indexId).graph_digest);
}
function graphDifference(store: CraftStore, leftIndexId: string, rightStore: CraftStore, rightIndexId: string): JsonObject {
  const material = (source: CraftStore, id: string): { nodes: JsonObject[]; edges: JsonObject[] } => {
    const index = source.get("codebase_index", id);
    const workspace = source.get("workspace", String(index.workspace_id));
    const projectGraph = workspace.snapshot_storage === "project_codebase"
      ? new ProjectGraphStore(String(workspace.root_path), String(workspace.id)) : null;
    const shards = (index.shard_ids as string[]).map(shardId => projectGraph
      ? projectGraph.read(shardId) : source.get("codebase_index_shard", shardId));
    return { nodes: shards.flatMap(shard => shard.nodes as JsonObject[]), edges: shards.flatMap(shard => shard.edges as JsonObject[]) };
  };
  const left = material(store, leftIndexId), right = material(rightStore, rightIndexId);
  const nodeLabel = (nodes: JsonObject[], id: string): JsonObject | undefined => {
    const node = nodes.find(item => item.id === id);
    return node ? { id: node.id, name: node.name, path: node.path, kind: node.kind, span: node.span } : undefined;
  };
  const edgeView = (edge: JsonObject, nodes: JsonObject[]): JsonObject => ({ edge,
    from: nodeLabel(nodes, String(edge.from_node_id)), to: nodeLabel(nodes, String(edge.to_node_id)) });
  const compare = (a: JsonObject[], b: JsonObject[]) => {
    const leftById = new Map(a.map(item => [String(item.id), item])), rightById = new Map(b.map(item => [String(item.id), item]));
    const onlyLeft = [...leftById.keys()].filter(id => !rightById.has(id));
    const onlyRight = [...rightById.keys()].filter(id => !leftById.has(id));
    const changed = [...leftById.keys()].filter(id => rightById.has(id) && JSON.stringify(leftById.get(id)) !== JSON.stringify(rightById.get(id)));
    return { only_incremental_count: onlyLeft.length, only_clean_count: onlyRight.length, changed_count: changed.length,
      examples: { only_incremental: onlyLeft.slice(0, 3).map(id => edgeView(leftById.get(id)!, left.nodes)), only_clean: onlyRight.slice(0, 3).map(id => edgeView(rightById.get(id)!, right.nodes)),
        changed: changed.slice(0, 2).map(id => ({ incremental: leftById.get(id), clean: rightById.get(id) })) } };
  };
  return { node_count: { incremental: left.nodes.length, clean: right.nodes.length }, edge_count: { incremental: left.edges.length, clean: right.edges.length },
    nodes: compare(left.nodes, right.nodes), edges: compare(left.edges, right.edges) };
}

const incrementalStore = await openStore("incremental-data");
try {
  const incrementalService = new CraftService(incrementalStore);
  const initial = ensureRepository(incrementalService);
  assert.equal(initial.status, "ready", JSON.stringify(initial));
  const initialDiagnostics = goDiagnostics(initial);
  const expectedInitialFileCount = lspConfigMaterial && !goLspDegraded ? expectedGoAnalysisFiles : goFiles.length;
  if (lspConfigMaterial && !goLspDegraded) {
    assert.equal(Number(initialDiagnostics.symbol_cache_misses), expectedGoAnalysisFiles, "initial LSP pass must analyze every bounded Go document");
  } else {
    assert.equal(Number(initialDiagnostics.analyzed_files), expectedInitialFileCount, "initial fallback pass must analyze every Go file");
    const cachedUnits = incrementalStore.list("codebase_file_analysis", 2_000,
      item => item.workspace_id === initial.workspace_id) as JsonObject[];
    assert.equal(cachedUnits.length, expectedInitialFileCount, "initial fallback pass must cache every Go file");
  }

  const changedFile = goFiles[0]!;
  const destination = join(projectRoot, changedFile.path);
  writeFileSync(destination, `${changedFile.content}\n// isolated Craft Go incremental verification\n`);
  const updated = ensureRepository(incrementalService);
  assert.equal(updated.status, "ready", JSON.stringify(updated));
  const updateDiagnostics = goDiagnostics(updated);
  const analyzedFileCount = lspConfigMaterial && !goLspDegraded ? Number(updateDiagnostics.symbol_cache_misses) : Number(updateDiagnostics.analyzed_files);
  const reusedFileCount = lspConfigMaterial && !goLspDegraded ? Number(updateDiagnostics.symbol_cache_hits) : Number(updateDiagnostics.reused_files);
  assert.equal(analyzedFileCount, 1, "single-file update must reanalyze exactly the changed Go file");
  assert.equal(reusedFileCount, expectedInitialFileCount - 1, "single-file update must reuse every unchanged Go file");

  const cleanStore = await openStore("clean-rebuild-data");
  let cleanGraphDigest = "";
  try {
    const clean = ensureRepository(new CraftService(cleanStore));
    assert.equal(clean.status, "ready", JSON.stringify(clean));
    cleanGraphDigest = graphDigest(cleanStore, String(clean.index_id));
    assert.equal(graphDigest(incrementalStore, String(updated.index_id)), cleanGraphDigest,
      `incremental Go graph must match a clean rebuild for the same changed checkpoint: ${JSON.stringify(graphDifference(incrementalStore, String(updated.index_id), cleanStore, String(clean.index_id)))}`);
  } finally { cleanStore.close(); }

  const index = incrementalStore.get("codebase_index", String(updated.index_id));
  const analysis = index.analysis as JsonObject;
  const checkpoint = incrementalStore.get("workspace_checkpoint", String(index.checkpoint_id));
  if (!lspConfigMaterial) assert.equal((analysis.relation_analysis as JsonObject).status, "not_analyzed",
    "basic fallback symbols must not be represented as semantic call relations");
  console.log(JSON.stringify({
    source_repository: sourceRoot,
    source_revision: sourceState.revision,
    source_dirty: sourceState.dirty,
    craft_revision: craftRevision,
    analyzer: String((analysis.relation_analysis as JsonObject).analyzer),
    semantic_adapter_degraded: goLspDegraded,
    go_file_count: goFiles.length,
    initial_analyzed_file_count: initialDiagnostics.analyzed_files,
    changed_path: changedFile.path,
    analyzed_file_count: analyzedFileCount,
    reused_file_count: reusedFileCount,
    checkpoint_id: index.checkpoint_id,
    checkpoint_manifest_digest: checkpointManifestDigest(checkpoint.entries as JsonObject[]),
    graph_digest: graphDigest(incrementalStore, String(updated.index_id)),
    clean_graph_digest: cleanGraphDigest,
    graph_matches_clean_rebuild: true,
    relation_analysis: analysis.relation_analysis,
  }, null, 2));
} finally {
  incrementalStore.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
}
