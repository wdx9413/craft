import type { CraftService } from "../craft-service.ts";
import type { JsonObject } from "../../infrastructure/store.ts";
import { payload, stableDigest } from "../../digest.ts";
import { repositoryFiles, repositoryRoot } from "../../../capability/craft-codebase/repository-files.ts";
import { basicAnalysis } from "../../../capability/craft-codebase/basic-analysis.ts";

const REPOSITORY_INDEX_POLICY = 2;

/** Same real worktree + same data space yields the same identity across all Hosts. */
export function ensureRepository(service: CraftService, args: JsonObject): JsonObject {
  const { root, isRepository } = repositoryRoot(args.project_root);
  const workspaceId = `repository_${stableDigest(root).slice(-24)}`;
  const base = { root_path: root, workspace_id: workspaceId };
  if (!isRepository) return { ...base, status: "skipped", reason: "not_repository" };
  if (args.index_depth !== undefined && !["basic", "semantic"].includes(String(args.index_depth))) throw new Error("index_depth must be basic or semantic");
  // Serialize cache/checkpoint publication across processes sharing this data space.
  return service.store.transaction(() => {
    const activation = service.store.find("codebase_activation", `codebase_activation_${workspaceId}`);
    if (activation?.status === "disabled") return { ...base, status: "disabled", reason: "project_opt_out" };
    const selected = repositoryFiles(root);
    if (selected.state === "disabled") return { ...base, status: "disabled", reason: "project_opt_out" };
    const includes = selected.files.map(file => file.path);
    const old = service.store.find("workspace", workspaceId);
    if (!old && !includes.length) return { ...base, status: "empty", omitted_files: selected.omitted };
    if (!old) service.workspaceOpen({ workspace_id: workspaceId, root_path: root, include_paths: includes, name: root });
    else service.store.save("workspace", workspaceId, { ...payload(old), include_paths: includes });
    const freshness = service.workspace.freshness({ workspace_id: workspaceId });
    if (freshness.status !== "current") service.workspaceCheckpoint({ workspace_id: workspaceId, label: "automatic repository snapshot" });
    const workspace = service.store.get("workspace", workspaceId);
    if (!activation) service.codebaseActivate({ workspace_id: workspaceId, actor: "repository-auto" });
    if (!includes.length) return { ...base, status: "empty", checkpoint_id: workspace.latest_checkpoint_id, omitted_files: selected.omitted };
    const depth = args.index_depth ?? "basic";
    const checkpointId = String(workspace.latest_checkpoint_id);
    const stateId = `${workspaceId}_${depth}`;
    const prior = service.store.find("codebase_repository_state", stateId);
    const cachedIndex = prior ? service.store.find("codebase_index", String(prior.index_id)) : undefined;
    if (prior?.checkpoint_id === checkpointId && prior.policy_version === REPOSITORY_INDEX_POLICY && cachedIndex?.status === "ready") return { ...base, status: "ready", index_id: prior.index_id, checkpoint_id: checkpointId, index_depth: depth, reused: true, omitted_files: selected.omitted, summary: prior.summary };
    // Restoring a checkpoint must not revive the stale index previously attached to it.
    const indexId = `repository_index_${stableDigest({ workspaceId, depth, checkpointId, state_revision: workspace.state_revision, policy: REPOSITORY_INDEX_POLICY }).slice(-24)}`;
    const analysis = depth === "basic" ? basicAnalysis(service.store, workspaceId, selected.files) : undefined;
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

export async function openContext(service: CraftService, args: JsonObject): Promise<JsonObject> {
  if (typeof args.query !== "string" || !args.query.trim()) throw new Error("query must not be empty");
  if (args.include_codebase !== undefined && typeof args.include_codebase !== "boolean") throw new Error("include_codebase must be boolean");
  if (args.index_depth !== undefined && !["basic", "semantic"].includes(String(args.index_depth))) throw new Error("index_depth must be basic or semantic");
  const maxChars = Number(args.max_chars ?? 12000); const maxItems = Number(args.max_items ?? 12);
  if (!Number.isInteger(maxChars) || maxChars < 1 || !Number.isInteger(maxItems) || maxItems < 1) throw new Error("Context budget is invalid");
  const { root } = repositoryRoot(args.project_root);
  const identity = service.scopeIdentityResolveProject({ project_root: root }).identity as JsonObject;
  const scope = identity.canonical_scope as JsonObject;
  let codebase: JsonObject;
  try { codebase = args.include_codebase === false ? { status: "skipped", reason: "not_requested" } : ensureRepository(service, { project_root: root, index_depth: args.index_depth }); }
  catch { codebase = { status: "unavailable", reason: "repository_index_failed" }; }
  const controls = Object.fromEntries(["source_ids", "memory_ids", "retrieval_adapter_id", "allow_restricted", "principal_id", "principal_ids", "tenant_id", "cognitive_purpose", "user_scope_id", "team_scope_id", "organization_scope_id", "session_scope_id", "include_global", "include_working_notes", "now"].filter(key => args[key] !== undefined).map(key => [key, args[key]]));
  const context = await service.contextResolutionResolve({ ...controls, query: args.query, scope_kind: scope.kind, scope_id: scope.id, max_chars: maxChars, max_items: maxItems, allow_partial: true, deduplicate: true, members: args.members ?? ["knowledge", "memory", "experience"] });
  const receipt = context.receipt as JsonObject;
  let chars = Number(receipt.total_used_chars); let items = Number(receipt.total_items);
  const references: JsonObject[] = [];
  let budgetOmitted = 0; let queryOmitted = 0;
  if (codebase.status === "ready" && items < maxItems && chars < maxChars) {
    const terms = [...new Set((args.query.match(/[A-Za-z_$][\w$]{1,63}/gu) ?? [args.query]))].slice(0, 6);
    const nodes = new Map<string, JsonObject>();
    for (const term of terms) {
      const found = service.codebaseSymbolFind({ workspace_id: codebase.workspace_id, index_id: codebase.index_id, query: term, limit: Math.min(100, maxItems - items) });
      queryOmitted += Number(((found.receipt as JsonObject).query as JsonObject).omitted_count);
      for (const node of found.symbols as JsonObject[]) nodes.set(String(node.id), node);
    }
    for (const node of nodes.values()) {
      const ref = { node_id: node.id, path: node.path, name: node.name, span: node.span, source_digest: node.source_digest };
      const size = JSON.stringify(ref).length;
      if (chars + size > maxChars || items >= maxItems) { budgetOmitted++; continue; }
      references.push(ref); chars += size; items++;
    }
  }
  const reasons: string[] = [];
  if (receipt.partial === true) reasons.push("context_contribution_unavailable");
  if (codebase.status === "unavailable") reasons.push("codebase_unavailable");
  if (codebase.status === "ready" && (codebase.summary as JsonObject).certainty !== "complete") reasons.push("codebase_partial_analysis");
  if (Number(codebase.omitted_files ?? 0) > 0) reasons.push("codebase_files_omitted");
  if (budgetOmitted > 0 || codebase.status === "ready" && (Number(receipt.total_items) >= maxItems || Number(receipt.total_used_chars) >= maxChars)) reasons.push("codebase_budget_exhausted");
  if (queryOmitted > 0) reasons.push("codebase_query_truncated");
  codebase = { ...codebase, budget_omitted_count: budgetOmitted, query_omitted_count: queryOmitted };
  const packIdentity = { scope, context_receipt_id: receipt.id, partial: reasons.length > 0, partial_reasons: reasons, codebase: { status: codebase.status, reason: codebase.reason ?? null, index_id: codebase.index_id ?? null, checkpoint_id: codebase.checkpoint_id ?? null, omitted_files: codebase.omitted_files ?? 0, budget_omitted_count: budgetOmitted, query_omitted_count: queryOmitted, references }, max_items: maxItems, max_chars: maxChars, total_items: items, total_used_chars: chars };
  const id = `context_pack_${stableDigest(packIdentity).slice(-24)}`;
  const packReceipt = service.store.transaction(() => service.store.find("context_pack_receipt", id) ?? service.store.create("context_pack_receipt", id, { ...packIdentity, content_free: true }));
  return { ...context, partial: reasons.length > 0, codebase: { ...codebase, references }, pack_receipt: packReceipt, host_execution_authority: false };
}
