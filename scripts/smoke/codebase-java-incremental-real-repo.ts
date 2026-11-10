import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { checkpointManifestDigest, readGitEvaluationState } from "../eval/codebase-evaluation-provenance.ts";
import { ProjectAnalysisCache } from "../../capability/craft-codebase/project-analysis-cache.ts";
import { repositoryFiles } from "../../capability/craft-codebase/repository-files.ts";
import { CraftStore } from "../../core/infrastructure/store.ts";
import { craftPaths } from "../../core/infrastructure/paths.ts";
import { CraftService } from "../../core/service.ts";

const sourceRoot = resolve(process.argv[2] ?? "");
assert(process.argv[2], "usage: node --experimental-strip-types scripts/smoke/codebase-java-incremental-real-repo.ts <java-repository>");
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim();
const sourceStatus = execFileSync("git", ["status", "--short"], { cwd: sourceRoot, encoding: "utf8" }).trim();
const craftRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const craftRevision = readGitEvaluationState(craftRoot);
const selected = repositoryFiles(sourceRoot);
assert.equal(selected.state, "ready", JSON.stringify(selected));
const javaFiles = selected.files.filter(file => file.language === "java");
assert(javaFiles.length > 1, "real repository must contain multiple Java source files");

const temporaryRoot = mkdtempSync(join(tmpdir(), "craft-java-incremental-real-repo-"));
const projectRoot = join(temporaryRoot, "project");
mkdirSync(projectRoot);
for (const file of javaFiles) {
  const destination = join(projectRoot, file.path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, file.content, { encoding: "utf8", flag: "wx" });
}
execFileSync("git", ["init", "--quiet", projectRoot]);

async function openStore(name: string): Promise<CraftStore> {
  return await new CraftStore(craftPaths(join(temporaryRoot, name))).open();
}
function javaDiagnostics(result: JsonObject): JsonObject {
  const diagnostics = (result.summary as JsonObject | undefined)?.diagnostics;
  assert(Array.isArray(diagnostics), "semantic index must expose diagnostics");
  const languages = (diagnostics[0] as JsonObject).languages;
  assert(Array.isArray(languages), "Java analyzer diagnostics must be present");
  const java = (languages as JsonObject[]).find(item => item.analyzer === "jdk-compiler-tree");
  assert(java && java.diagnostics && typeof java.diagnostics === "object", "Java analyzer summary must exist");
  return java.diagnostics as JsonObject;
}
function graphDigest(store: CraftStore, indexId: string): string {
  return String(store.get("codebase_index", indexId).graph_digest);
}

const incrementalStore = await openStore("incremental-data");
try {
  const incrementalService = new CraftService(incrementalStore);
  const initial = incrementalService.codebaseRepositoryEnsure({ project_root: projectRoot, index_depth: "semantic" });
  assert.equal(initial.status, "ready", JSON.stringify(initial));
  const analysisCache = new ProjectAnalysisCache(projectRoot, String(initial.workspace_id), incrementalStore.paths);
  const cachedUnits = analysisCache.list("codebase_java_file_analysis", 2_000) as JsonObject[];
  assert.equal(cachedUnits.length, javaFiles.length, "initial analysis must cache every bounded Java file unit");
  const safeUnits = cachedUnits.filter(unit => unit.incremental_safe === true).sort((left, right) => String(left.path).localeCompare(String(right.path)));
  assert(safeUnits.length > 0, "real repository must have at least one safely reusable Java unit");
  assert(safeUnits.length < javaFiles.length, "real repository should retain its unresolved Java units as partial evidence");
  const changedPath = String(safeUnits[0]!.path);
  const changedFile = javaFiles.find(file => file.path === changedPath)!;
  const destination = join(projectRoot, changedPath);
  writeFileSync(destination, `${changedFile.content}\n// isolated Craft Java incremental verification\n`);

  const updated = incrementalService.codebaseRepositoryEnsure({ project_root: projectRoot, index_depth: "semantic" });
  assert.equal(updated.status, "ready", JSON.stringify(updated));
  const updateDiagnostics = javaDiagnostics(updated);
  assert.equal(updateDiagnostics.incremental_mode, "incremental", JSON.stringify(updateDiagnostics));
  const parsedFileCount = Number(updateDiagnostics.parsed_file_count);
  const reusedFileCount = Number(updateDiagnostics.reused_file_count);
  assert(parsedFileCount > 0 && parsedFileCount < javaFiles.length, "single-file update must reanalyze a strict subset");
  assert(reusedFileCount > 0, "single-file update must reuse safe unchanged Java units");

  const cleanStore = await openStore("clean-rebuild-data");
  let cleanGraphDigest = "";
  try {
    const clean = new CraftService(cleanStore).codebaseRepositoryEnsure({ project_root: projectRoot, index_depth: "semantic" });
    assert.equal(clean.status, "ready", JSON.stringify(clean));
    cleanGraphDigest = graphDigest(cleanStore, String(clean.index_id));
    assert.equal(graphDigest(incrementalStore, String(updated.index_id)), cleanGraphDigest,
      "incremental Java graph must match a clean rebuild for the same mutated checkpoint");
  } finally { cleanStore.close(); }

  const index = incrementalStore.get("codebase_index", String(updated.index_id));
  const analysis = index.analysis as JsonObject;
  const checkpoint = incrementalStore.get("workspace_checkpoint", String(index.checkpoint_id));
  console.log(JSON.stringify({
    source_repository: sourceRoot,
    source_revision: sourceRevision,
    source_dirty: sourceStatus.length > 0,
    craft_revision: craftRevision,
    java_file_count: javaFiles.length,
    initial_safe_unit_count: safeUnits.length,
    initial_unsafe_unit_count: javaFiles.length - safeUnits.length,
    initial_compiler_errors: javaDiagnostics(initial).compiler_errors,
    changed_path: changedPath,
    incremental_mode: updateDiagnostics.incremental_mode,
    incremental_reason: updateDiagnostics.incremental_reason,
    parsed_file_count: parsedFileCount,
    reused_file_count: reusedFileCount,
    graph_unit_rebuild_count: updateDiagnostics.graph_unit_rebuild_count,
    graph_unit_reuse_count: updateDiagnostics.graph_unit_reuse_count,
    compiler_input_file_count: updateDiagnostics.compiler_input_file_count,
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
