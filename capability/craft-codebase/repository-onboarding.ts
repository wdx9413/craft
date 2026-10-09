import type { CraftStore, JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { payload, stableDigest } from "../../common/craft-common-base/src/digest.ts";
import { repositoryFiles, repositoryRoot } from "./repository-files.ts";
import { basicAnalysis } from "./basic-analysis.ts";
import { analyzeTypeScript } from "./typescript-analysis.ts";
export interface RepositoryOnboardingPort {
  store: CraftStore;
  workspace: { freshness(args: JsonObject): JsonObject };
  workspaceOpen(args: JsonObject): JsonObject;
  workspaceCheckpoint(args: JsonObject): JsonObject;
  codebaseActivate(args: JsonObject): JsonObject;
  codebaseAnalysisImport(args: JsonObject): JsonObject;
  codebaseIndexBuild(args: JsonObject): JsonObject;
}
const REPOSITORY_INDEX_POLICY = 4;

/** Same real worktree + same data space yields the same identity across all Hosts. */
export function ensureRepository(service: RepositoryOnboardingPort, args: JsonObject): JsonObject {
  const { root, isRepository } = repositoryRoot(args.project_root);
  const workspaceId = `repository_${stableDigest(root).slice(-24)}`;
  const base = { root_path: root, workspace_id: workspaceId };
  if (!isRepository) return { ...base, status: "skipped", reason: "not_repository" };
  if (args.index_depth !== undefined && !["basic", "semantic"].includes(String(args.index_depth))) throw new Error("index_depth must be basic or semantic");
  if (service.store.find("codebase_activation", `codebase_activation_${workspaceId}`)?.status === "disabled") return { ...base, status: "disabled", reason: "project_opt_out" };
  const selected = repositoryFiles(root);
  const depth = args.index_depth ?? "basic";
  // Parsing and per-file cache publication must not retain the checkpoint/index
  // writer transaction. The import below validates every source digest against
  // the checkpoint, so file changes between discovery and publication fail closed.
  const semanticFiles = selected.files.filter(file => /^(?:tsx?|mts|cts|jsx?|mjs|cjs)$/u.test(file.language));
  const analysis = selected.state !== "ready" || selected.files.length === 0 ? undefined
    : depth === "basic" ? basicAnalysis(service.store, workspaceId, selected.files)
    : semanticFiles.length ? analyzeTypeScript(semanticFiles.map(file => ({ ...file, language: file.language === "tsx" ? "jsx" : file.language }))) : undefined;
  // Serialize cache/checkpoint publication across processes sharing this data space.
  return service.store.transaction(() => {
    const activation = service.store.find("codebase_activation", `codebase_activation_${workspaceId}`);
    if (activation?.status === "disabled") return { ...base, status: "disabled", reason: "project_opt_out" };
    if (selected.state === "disabled") return { ...base, status: "disabled", reason: "project_opt_out" };
    const includes = selected.files.map(file => file.path).sort();
    const old = service.store.find("workspace", workspaceId);
    if (!old && !includes.length) return { ...base, status: "empty", omitted_files: selected.omitted };
    if (!old) service.workspaceOpen({ workspace_id: workspaceId, root_path: root, include_paths: includes, name: root });
    else if (JSON.stringify(old.include_paths) !== JSON.stringify(includes)) service.store.save("workspace", workspaceId, { ...payload(old), include_paths: includes });
    const freshness = service.workspace.freshness({ workspace_id: workspaceId });
    if (freshness.status !== "current") service.workspaceCheckpoint({ workspace_id: workspaceId, label: "automatic repository snapshot" });
    const workspace = service.store.get("workspace", workspaceId);
    if (!activation) service.codebaseActivate({ workspace_id: workspaceId, actor: "repository-auto" });
    if (!includes.length) return { ...base, status: "empty", checkpoint_id: workspace.latest_checkpoint_id, omitted_files: selected.omitted };
    const checkpointId = String(workspace.latest_checkpoint_id);
    const stateId = `${workspaceId}_${depth}`;
    const prior = service.store.find("codebase_repository_state", stateId);
    const cachedIndex = prior ? service.store.find("codebase_index", String(prior.index_id)) : undefined;
    if (prior?.checkpoint_id === checkpointId && prior.policy_version === REPOSITORY_INDEX_POLICY && cachedIndex?.status === "ready") return { ...base, status: "ready", index_id: prior.index_id, checkpoint_id: checkpointId, index_depth: depth, reused: true, omitted_files: selected.omitted, summary: prior.summary };
    // Restoring a checkpoint must not revive the stale index previously attached to it.
    const indexId = `repository_index_${stableDigest({ workspaceId, depth, checkpointId, state_revision: workspace.state_revision, policy: REPOSITORY_INDEX_POLICY }).slice(-24)}`;
    const built = analysis ? service.codebaseAnalysisImport({ workspace_id: workspaceId, checkpoint_id: checkpointId, index_id: indexId, analysis }) : service.codebaseIndexBuild({ workspace_id: workspaceId, index_id: indexId });
    const index = built.index as JsonObject;
    const details = index.analysis as JsonObject;
    const rawDiagnostics = analysis?.diagnostics ?? index.diagnostics;
    const diagnostics = Array.isArray(rawDiagnostics) ? rawDiagnostics : [rawDiagnostics];
    const summary = { analyzer: details.analyzer, certainty: details.certainty, supported_file_count: details.supported_file_count, unsupported_file_count: details.unsupported_file_count, diagnostic_count: diagnostics.length, diagnostics: diagnostics.slice(0, 10) };
    service.store.save("codebase_repository_state", stateId, { workspace_id: workspaceId, checkpoint_id: checkpointId, policy_version: REPOSITORY_INDEX_POLICY, index_id: index.id, summary });
    return { ...base, status: "ready", index_id: index.id, checkpoint_id: checkpointId, index_depth: depth, reused: false, omitted_files: selected.omitted,
      summary };
  });
}
