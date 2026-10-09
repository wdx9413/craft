import { assertContextReadCurrent } from "../../context-access-guard.ts";
import type { CraftService } from "../craft-service.ts";
import type { JsonObject } from "../../infrastructure/store.ts";
import { stableDigest } from "../../digest.ts";
import { repositoryRoot } from "../../../capability/craft-codebase/repository-files.ts";
import { ContextBudget, contextAssetMatches, contextAssetRef, requiredContextRef } from "../../../common/craft-common-base/src/context-assets.ts";
import { estimateTokens } from "../../token-budget.ts";

export { ensureRepository } from "../../../capability/craft-codebase/repository-onboarding.ts";
import { ensureRepository } from "../../../capability/craft-codebase/repository-onboarding.ts";

export async function openContext(service: CraftService, args: JsonObject): Promise<JsonObject> {
  if (typeof args.query !== "string" || !args.query.trim()) throw new Error("query must not be empty");
  if (args.include_codebase !== undefined && typeof args.include_codebase !== "boolean") throw new Error("include_codebase must be boolean");
  if (args.index_depth !== undefined && !["basic", "semantic"].includes(String(args.index_depth))) throw new Error("index_depth must be basic or semantic");
  const maxChars = Number(args.max_chars ?? 12000); const maxItems = Number(args.max_items ?? 12);
  new ContextBudget(maxItems, maxChars);
  const { root } = repositoryRoot(args.project_root);
  const identity = service.scopeIdentityResolveProject({ project_root: root }).identity as JsonObject;
  const scope = identity.canonical_scope as JsonObject;
  let codebase: JsonObject;
  try { codebase = args.include_codebase === false ? { status: "skipped", reason: "not_requested" } : ensureRepository(service, { project_root: root, index_depth: args.index_depth, query: args.query }); }
  catch { codebase = { status: "unavailable", reason: "repository_index_failed" }; }
  if (args.required_refs !== undefined && !Array.isArray(args.required_refs)) throw new Error("required_refs must be an array");
  const required = ((args.required_refs ?? []) as unknown[]).map(requiredContextRef);
  const codeRequired = required.filter(ref => ref.member === "codebase");
  const controls = Object.fromEntries(["source_ids", "memory_ids", "retrieval_adapter_id", "allow_restricted", "principal_id", "principal_ids", "tenant_id", "cognitive_purpose", "user_scope_id", "team_scope_id", "organization_scope_id", "session_scope_id", "include_global", "include_working_notes", "now", "task_id", "session_id", "turn_id", "history_refs", "state_refs"].filter(key => args[key] !== undefined).map(key => [key, args[key]]));
  const taskKind = args.task_kind ?? (/review|bug|debug|code|开发|代码|修复|排查|重构|测试/iu.test(args.query) ? "code" : "general");
  if (!["code", "review", "debug", "development", "knowledge", "general"].includes(String(taskKind))) throw new Error("Unsupported Context task_kind");
  const codeFirst = ["code", "review", "debug", "development"].includes(String(taskKind)) || codeRequired.length > 0;
  const projection = codebase.status === "ready" ? service.codebase.contextProjection({ workspace_id: codebase.workspace_id, index_id: codebase.index_id, query: args.query, limit: 100, required_refs: codeRequired, scope }) : null;
  const queryOmitted = Number(projection?.query_omitted_count ?? 0);
  const candidates = (projection?.candidates ?? []) as JsonObject[];
  const context = await service.contextWorkingSets.resolve({ ...controls, query: args.query, scope_kind: scope.kind, scope_id: scope.id,
    max_chars: maxChars, max_items: maxItems, required_refs: required, allow_partial: true, deduplicate: true,
    members: args.members ?? ["knowledge", "memory", "experience", "history", "state"], codebase_candidates: candidates, prefer_codebase: codeFirst });
  const receipt = context.receipt as JsonObject;
  const references = context.codebase_references as JsonObject[];
  const budgetOmitted = Number(context.codebase_budget_omitted_count), budgetRebalanced = context.codebase_budget_rebalanced;
  const chars = Number(context.total_used_chars), items = Number(context.total_items);
  const reasons: string[] = [];
  if (receipt?.partial === true) reasons.push("context_contribution_unavailable");
  if (codebase.status === "unavailable") reasons.push("codebase_unavailable");
  if (codebase.status === "ready" && (codebase.summary as JsonObject).certainty !== "complete") reasons.push("codebase_partial_analysis");
  if (Number(codebase.omitted_files ?? 0) > 0) reasons.push("codebase_files_omitted");
  if (budgetOmitted > 0 || codebase.status === "ready" && (Number(receipt?.total_items ?? 0) >= maxItems || Number(receipt?.total_used_chars ?? 0) >= maxChars)) reasons.push("codebase_budget_exhausted");
  if (queryOmitted > 0) reasons.push("codebase_query_truncated");
  codebase = { ...codebase, budget_omitted_count: budgetOmitted, query_omitted_count: queryOmitted, budget_rebalanced: budgetRebalanced };
  const assetRefs = context.asset_refs as JsonObject[];
  const packIdentity = { scope, asset_refs: assetRefs, context_receipt_id: receipt?.id ?? null, working_set_id: (context.working_set as JsonObject).id, task_kind: taskKind, partial: reasons.length > 0, partial_reasons: reasons, codebase: { status: codebase.status, reason: codebase.reason ?? null, index_id: codebase.index_id ?? null, checkpoint_id: codebase.checkpoint_id ?? null, omitted_files: codebase.omitted_files ?? 0, budget_omitted_count: budgetOmitted, query_omitted_count: queryOmitted, references }, max_items: maxItems, max_chars: maxChars, total_items: items, total_used_chars: chars };
  const id = `context_pack_${stableDigest(packIdentity).slice(-24)}`;
  const alreadyEmitted = service.contextWorkingSets.emittedRefs({ ...args, scope_kind: scope.kind, scope_id: scope.id }, assetRefs);
  const novel = (member: string, item: JsonObject) => !alreadyEmitted.some(ref => contextAssetMatches(ref, contextAssetRef(member, item, scope)));
  const injectionItems = (context.items as JsonObject[]).filter(item => novel("memory", item));
  const injectionContributions = (context.contributions as JsonObject[]).map(part => ({ ...part, items: (part.items as JsonObject[]).filter(item => novel(String(part.member), item)) }));
  const injection = JSON.stringify({ items: injectionItems, contributions: injectionContributions, host_refs: context.host_refs, codebase_references: references });
  const estimatedTokens = estimateTokens(injection);
  if (args.max_tokens !== undefined && (!Number.isSafeInteger(args.max_tokens) || Number(args.max_tokens) < 1 || estimatedTokens > Number(args.max_tokens))) throw new Error("Context injection exceeds estimated token budget or max_tokens is invalid");
  return service.store.transaction(() => {
    assertContextReadCurrent(service.store, receipt);
    if (projection) service.codebase.assertContextProjectionCurrent(projection, references);
    const packReceipt = service.store.find("context_pack_receipt", id) ?? service.store.create("context_pack_receipt", id, { ...packIdentity, identity_digest: stableDigest(packIdentity), content_free: true });
    return { ...context, items: injectionItems, contributions: injectionContributions, already_emitted_refs: alreadyEmitted, hook_reused: alreadyEmitted.length > 0, asset_refs: assetRefs, injection_measurement: { measurement_scope: "material_projection_excludes_protocol_envelope_and_host_history_bodies", serialized_chars: injection.length, estimated_tokens: estimatedTokens, tokenizer: "cjk_char_latin_four_char_estimate", exact: false, host_measured_tokens: null }, partial: reasons.length > 0, codebase: { ...codebase, references }, pack_receipt: packReceipt, host_execution_authority: false };
  });
}
