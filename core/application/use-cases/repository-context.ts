import { observeOperation } from "../../../common/craft-common-log/src/index.ts";
import { assertContextReadCurrent } from "../../context-access-guard.ts";
import type { CraftService } from "../craft-service.ts";
import type { JsonObject } from "../../infrastructure/store.ts";
import { stableDigest } from "../../digest.ts";
import { repositoryRoot } from "../../../capability/craft-codebase/repository-files.ts";
import { ContextBudget, DEFAULT_CONTEXT_MAX_CHARS, DEFAULT_CONTEXT_MAX_ITEMS, contextAssetMatches, contextAssetRef, requiredContextRef } from "../../../common/craft-common-base/src/context-assets.ts";
import { estimateTokens } from "../../token-budget.ts";
import { CraftOperationError } from "../../operation-error.ts";
import { codebaseFailureDiagnostic } from "./codebase-failure.ts";
import { operationErrorCode } from "../../../common/craft-common-log/src/operation.ts";

export { ensureRepository } from "../../../capability/craft-codebase/repository-onboarding.ts";
import { ensureRepository } from "../../../capability/craft-codebase/repository-onboarding.ts";

export async function openContext(service: CraftService, args: JsonObject): Promise<JsonObject> {
  if (typeof args.query !== "string" || !args.query.trim()) throw new CraftOperationError("INVALID_INPUT", "input_validation", "query must not be empty", { field: "query" });
  if (args.include_codebase !== undefined && typeof args.include_codebase !== "boolean") throw new CraftOperationError("INVALID_INPUT", "input_validation", "include_codebase must be boolean", { field: "include_codebase" });
  if (args.index_depth !== undefined && !["basic", "semantic"].includes(String(args.index_depth))) throw new CraftOperationError("INVALID_INPUT", "input_validation", "index_depth must be basic or semantic", { field: "index_depth", allowed: ["basic", "semantic"] });
  const maxChars = Number(args.max_chars ?? DEFAULT_CONTEXT_MAX_CHARS); const maxItems = Number(args.max_items ?? DEFAULT_CONTEXT_MAX_ITEMS);
  try { new ContextBudget(maxItems, maxChars); }
  catch { throw new CraftOperationError("LIMIT_EXCEEDED", "budget_validation", "Context budget is invalid", { budget: !Number.isSafeInteger(maxItems) || maxItems < 1 ? "max_items" : "max_chars", max_items: maxItems, max_chars: maxChars, minimum: 1 }); }
  if (maxItems > DEFAULT_CONTEXT_MAX_ITEMS || maxChars > DEFAULT_CONTEXT_MAX_CHARS) {
    throw new CraftOperationError("LIMIT_EXCEEDED", "budget_validation", `Context budget exceeds the configured maximum: max_items <= ${DEFAULT_CONTEXT_MAX_ITEMS}, max_chars <= ${DEFAULT_CONTEXT_MAX_CHARS}; omit these parameters to use defaults`, {
      max_items: maxItems, max_chars: maxChars,
      maximum_items: DEFAULT_CONTEXT_MAX_ITEMS, maximum_chars: DEFAULT_CONTEXT_MAX_CHARS,
    });
  }
  const taskKind = args.task_kind ?? (/review|bug|debug|code|开发|代码|修复|排查|重构|测试/iu.test(args.query) ? "code" : "general");
  if (!["code", "review", "debug", "development", "knowledge", "general"].includes(String(taskKind))) throw new CraftOperationError("INVALID_INPUT", "input_validation", "Unsupported Context task_kind", { field: "task_kind" });
  if (args.required_refs !== undefined && !Array.isArray(args.required_refs)) throw new CraftOperationError("INVALID_INPUT", "input_validation", "required_refs must be an array", { field: "required_refs" });
  let required: JsonObject[];
  try { required = ((args.required_refs ?? []) as unknown[]).map(requiredContextRef); }
  catch { throw new CraftOperationError("INVALID_INPUT", "input_validation", "required_refs contains an invalid reference", { field: "required_refs" }); }
  const codeRequired = required.filter(ref => ref.member === "codebase");
  const codeRelevant = ["code", "review", "debug", "development"].includes(String(taskKind)) || codeRequired.length > 0;
  const loadCodebase = args.include_codebase ?? codeRelevant;
  const { root } = repositoryRoot(args.project_root);
  const identity = service.scopeIdentityResolveProject({ project_root: root }).identity as JsonObject;
  const scope = identity.canonical_scope as JsonObject;
  let knowledgeSourceDiscovery: JsonObject;
  try {
    knowledgeSourceDiscovery = observeOperation(service.store, "knowledge", "project_source_discovery", { scope, project_root_digest: stableDigest(root) },
      () => service.knowledgeSources.discoverProjectSources({ project_root: root, scope_kind: scope.kind, scope_id: scope.id }));
  } catch (error) {
    knowledgeSourceDiscovery = { status: "unavailable", reason: "project_source_discovery_failed", failure_code: operationErrorCode(error), sources_registered: 0, sources_ingested: 0, candidates_created: 0 };
  }
  let codebase: JsonObject;
  try { codebase = loadCodebase ? observeOperation(service.store, "codebase", "repository_ensure", { project_root: root, index_depth: args.index_depth }, () => ensureRepository(service, { project_root: root, index_depth: args.index_depth, query: args.query })) : { status: "skipped", reason: "not_requested" }; }
  catch (error) { codebase = { status: "unavailable", reason: "repository_index_failed", ...codebaseFailureDiagnostic(error) }; }
  if (codeRequired.length && codebase.status !== "ready") throw new CraftOperationError("REQUIRED_MATERIAL_UNAVAILABLE", "codebase_projection", "Required Codebase material is unavailable", { member: "codebase", reason: codebase.reason });
  const controls = Object.fromEntries(["source_ids", "memory_ids", "retrieval_adapter_id", "allow_restricted", "principal_id", "principal_ids", "tenant_id", "cognitive_purpose", "user_scope_id", "team_scope_id", "organization_scope_id", "session_scope_id", "include_global", "include_working_notes", "now", "task_id", "session_id", "turn_id", "history_refs", "state_refs"].filter(key => args[key] !== undefined).map(key => [key, args[key]]));
  const defaultMembers = String(taskKind) === "knowledge" ? ["knowledge"] : ["knowledge", "memory", "experience", "history", "state"];
  const requiredMemberNames = required.map(ref => String(ref.member)).filter(member => ["knowledge", "memory", "experience", "history", "state"].includes(member));
  if (Array.isArray(args.memory_ids) && args.memory_ids.length > 0) requiredMemberNames.push("memory");
  for (const member of ["history", "state"]) if (Array.isArray(args[`${member}_refs`]) && (args[`${member}_refs`] as unknown[]).length > 0) requiredMemberNames.push(member);
  const selectedMembers = args.members ?? [...new Set([...defaultMembers, ...requiredMemberNames])];
  const codeFirst = ["code", "review", "debug", "development"].includes(String(taskKind)) || codeRequired.length > 0;
  // Keep one fallback candidate while bounding retrieval to the shared budget.
  // Required references remain eligible even when they exceed this optional
  // window; the budget gate below still validates them.
  const projectionLimit = Math.max(maxItems + 1, codeRequired.length);
  const projection = codebase.status === "ready" ? service.codebase.contextProjection({ workspace_id: codebase.workspace_id, index_id: codebase.index_id, query: args.query, limit: projectionLimit, required_refs: codeRequired, scope }) : null;
  const queryOmitted = Number(projection?.query_omitted_count ?? 0);
  const candidates = (projection?.candidates ?? []) as JsonObject[];
  const context = await service.contextWorkingSets.resolve({ ...controls, query: args.query, scope_kind: scope.kind, scope_id: scope.id,
    max_chars: maxChars, max_items: maxItems, required_refs: required, allow_partial: true, deduplicate: true,
    members: selectedMembers, codebase_candidates: candidates, prefer_codebase: codeFirst });
  const receipt = context.receipt as JsonObject;
  const references = context.codebase_references as JsonObject[];
  const budgetOmitted = Number(context.codebase_budget_omitted_count), budgetRebalanced = context.codebase_budget_rebalanced;
  const chars = Number(context.total_used_chars), items = Number(context.total_items);
  const reasons: string[] = [];
  if (receipt?.partial === true) {
    const failures = Array.isArray(receipt.contributor_failures) ? receipt.contributor_failures as JsonObject[] : [];
    if (failures.some(item => item.member === "knowledge" && item.reason === "source_verification_incomplete")) reasons.push("knowledge_source_verification_incomplete");
    if (!failures.length || failures.some(item => item.member !== "knowledge" || item.reason !== "source_verification_incomplete")) reasons.push("context_contribution_unavailable");
  }
  if (knowledgeSourceDiscovery.status === "unavailable") reasons.push("knowledge_source_discovery_unavailable");
  else if (knowledgeSourceDiscovery.status !== "ready")
    reasons.push("knowledge_source_discovery_incomplete");
  if (codebase.status === "unavailable") reasons.push("codebase_unavailable");
  if (codebase.status === "ready" && Number((codebase.summary as JsonObject).unsupported_file_count) > 0) reasons.push("codebase_analyzer_unsupported_files");
  if (Number(codebase.omitted_files ?? 0) > 0) reasons.push("codebase_files_omitted");
  if (budgetOmitted > 0) reasons.push("codebase_budget_exhausted");
  if (queryOmitted > 0) reasons.push("codebase_query_truncated");
  codebase = { ...codebase, budget_omitted_count: budgetOmitted, query_omitted_count: queryOmitted, budget_rebalanced: budgetRebalanced };
  const assetRefs = context.asset_refs as JsonObject[];
  const packIdentity = { scope, asset_refs: assetRefs, context_receipt_id: receipt?.id ?? null, working_set_id: (context.working_set as JsonObject).id, task_kind: taskKind, partial: reasons.length > 0, partial_reasons: reasons, codebase: { status: codebase.status, reason: codebase.reason ?? null, failure_code: codebase.failure_code ?? null, failure_stage: codebase.failure_stage ?? null, failure_details: codebase.failure_details ?? {}, index_id: codebase.index_id ?? null, checkpoint_id: codebase.checkpoint_id ?? null, omitted_files: codebase.omitted_files ?? 0, omitted_by_language: codebase.omitted_by_language ?? {}, budget_omitted_count: budgetOmitted, query_omitted_count: queryOmitted, references }, max_items: maxItems, max_chars: maxChars, total_items: items, total_used_chars: chars };
  const id = `context_pack_${stableDigest(packIdentity).slice(-24)}`;
  const alreadyEmitted = service.contextWorkingSets.emittedRefs({ ...args, scope_kind: scope.kind, scope_id: scope.id }, assetRefs);
  const novel = (member: string, item: JsonObject) => !alreadyEmitted.some(ref => contextAssetMatches(ref, contextAssetRef(member, item, scope)));
  const injectionItems = (context.items as JsonObject[]).filter(item => novel("memory", item));
  const injectionContributions = (context.contributions as JsonObject[]).map(part => ({ ...part, items: (part.items as JsonObject[]).filter(item => novel(String(part.member), item)) }));
  const injection = JSON.stringify({ items: injectionItems, contributions: injectionContributions, host_refs: context.host_refs, codebase_references: references });
  const estimatedTokens = estimateTokens(injection);
  if (args.max_tokens !== undefined && (!Number.isSafeInteger(args.max_tokens) || Number(args.max_tokens) < 1 || estimatedTokens > Number(args.max_tokens))) throw new CraftOperationError("LIMIT_EXCEEDED", "injection_budget", "Context injection exceeds estimated token budget or max_tokens is invalid", { budget: "max_tokens", estimated_tokens: estimatedTokens, limit: args.max_tokens });
  const identityDigest = stableDigest(packIdentity);
  const response = (packReceipt: JsonObject): JsonObject => {
    const contextStatus = receipt?.partial === true ? "partial" : "resolved";
    const packStatus = reasons.length ? "partial" : "ready";
    return { ...context, context_status: contextStatus, pack_status: packStatus, items: injectionItems, contributions: injectionContributions, knowledge_source_discovery: knowledgeSourceDiscovery, already_emitted_refs: alreadyEmitted, hook_reused: alreadyEmitted.length > 0, asset_refs: assetRefs, injection_measurement: { measurement_scope: "material_projection_excludes_protocol_envelope_and_host_history_bodies", serialized_chars: injection.length, estimated_tokens: estimatedTokens, tokenizer: "cjk_char_latin_four_char_estimate", exact: false, host_measured_tokens: null }, partial: reasons.length > 0, codebase: { ...codebase, analysis_confidence: (codebase.summary as JsonObject | undefined)?.certainty ?? null, references }, pack_receipt: packReceipt, host_execution_authority: false };
  };
  const priorPackReceipt = service.store.find("context_pack_receipt", id);
  if (priorPackReceipt) {
    assertContextReadCurrent(service.store, receipt);
    if (projection) service.codebase.assertContextProjectionCurrent(projection, references);
    if (priorPackReceipt.identity_digest !== identityDigest) throw new Error("Context Pack Receipt idempotency conflict");
    return response(priorPackReceipt);
  }
  return service.store.transaction(() => {
    assertContextReadCurrent(service.store, receipt);
    if (projection) service.codebase.assertContextProjectionCurrent(projection, references);
    const current = service.store.find("context_pack_receipt", id);
    if (current) {
      if (current.identity_digest !== identityDigest) throw new Error("Context Pack Receipt idempotency conflict");
      return response(current);
    }
    return response(service.store.create("context_pack_receipt", id, { ...packIdentity, identity_digest: identityDigest, content_free: true }));
  });
}
