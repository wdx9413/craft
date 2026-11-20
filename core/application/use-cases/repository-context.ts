import { observeOperation } from 'craft-common-log/index';
import { assertContextReadCurrent } from "../../context-access-guard.ts";
import type { CraftService } from "../craft-service.ts";
import type { JsonObject } from "../../infrastructure/store.ts";
import { stableDigest } from "../../digest.ts";
import { repositoryRoot } from '@craft/capability-codebase/repository-files';
import { ContextBudget, DEFAULT_CONTEXT_MAX_CHARS, DEFAULT_CONTEXT_MAX_ITEMS, contextAssetMatches, contextAssetRef, requiredContextRef } from 'craft-common-base/context-assets';
import { estimateTokens } from "../../token-budget.ts";
import { CraftOperationError } from "../../operation-error.ts";
import { codebaseFailureDiagnostic } from "./codebase-failure.ts";
import { operationErrorCode } from 'craft-common-log/operation';

export { ensureRepository } from '@craft/capability-codebase/repository-onboarding';
import { ensureRepository } from '@craft/capability-codebase/repository-onboarding';

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
  const controls = Object.fromEntries(["source_ids", "memory_ids", "retrieval_adapter_id", "allow_restricted", "principal_id", "principal_ids", "tenant_id", "cognitive_purpose", "user_scope_id", "team_scope_id", "organization_scope_id", "session_scope_id", "include_global", "include_working_notes", "now", "task_id", "session_id", "turn_id", "history_refs", "state_refs", "program_memory_scope_id"].filter(key => args[key] !== undefined).map(key => [key, args[key]]));
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
  // Notes are a bounded, scope-matched Context addition. Device + current-root
  // Directory Notes are eligible; File Notes require an explicit task-bound path
  // supplied by the Host. The registry returns only confirmed legacy/current Notes.
  const requestedNotePaths = Array.isArray(args.note_paths) ? args.note_paths.filter((item): item is string => typeof item === "string") : [];
  const notesById = new Map<string, JsonObject>();
  const notePaths = [...new Set([...requestedNotePaths, root, ...(typeof args.project_root === "string" ? [args.project_root] : [])])].slice(0, 16);
  for (const notePath of notePaths) {
    try {
      const notesResult = service.craftNotesResolve({ device_id: args.device_id ?? "local", project_id: scope.id, path: notePath, limit: 3 }) as JsonObject;
      if (Array.isArray(notesResult.items)) for (const note of notesResult.items as JsonObject[]) notesById.set(String(note.id), note);
    } catch { /* A non-canonical or remote caller path cannot broaden this project-scoped lookup. */ }
  }
  const noteItemLimit = Math.min(3, Math.max(0, maxItems - 1));
  const notes = [...notesById.values()].slice(0, noteItemLimit).map(note => ({ id: note.id, subject_type: note.subject_type,
    subject_key: note.subject_key, text: note.text, status: note.status, version: note.version,
    ...(note.device_id === undefined ? {} : { device_id: note.device_id }),
    ...(note.project_id === undefined ? {} : { project_id: note.project_id }) }));
  const notesTextSize = notes.reduce((size, note) => size + String(note.text).length, 0);
  const noteBudget = notes.length > 0 && maxItems > notes.length && maxChars > notesTextSize ? { items: notes.length, chars: notesTextSize } : { items: 0, chars: 0 };
  const selectedNotes = noteBudget.items ? notes : [];
  const assertNotesCurrent = (): void => {
    for (const note of selectedNotes) {
      const deviceId = String(note.device_id ?? "local");
      const subjectPath = note.subject_type === "device" ? null : String(note.subject_key).slice(deviceId.length + 1);
      const current = service.craftNotesResolve({ device_id: deviceId, project_id: scope.id,
        ...(subjectPath === null ? {} : { path: subjectPath }), limit: 10 }) as JsonObject;
      const stillCurrent = Array.isArray(current.items) && (current.items as JsonObject[]).some(item =>
        item.id === note.id && item.version === note.version && item.status === note.status);
      if (!stillCurrent) throw new Error("Craft Notes changed during Context resolution");
    }
  };
  const context = await service.contextWorkingSets.resolve({ ...controls, query: args.query, scope_kind: scope.kind, scope_id: scope.id,
    max_chars: maxChars - noteBudget.chars, max_items: maxItems - noteBudget.items, required_refs: required, allow_partial: true, deduplicate: true,
    members: selectedMembers, codebase_candidates: candidates, prefer_codebase: codeFirst });
  const receipt = context.receipt as JsonObject;
  const references = context.codebase_references as JsonObject[];
  const budgetOmitted = Number(context.codebase_budget_omitted_count), budgetRebalanced = context.codebase_budget_rebalanced;
  const chars = Number(context.total_used_chars), items = Number(context.total_items);
  const reasons: string[] = [];
  const retrievalBudgetExhausted = context.skipped === true && context.reason === "context_budget_exhausted"
    && ((context.working_set as JsonObject).retrieval_members as unknown[]).length > 0;
  if (retrievalBudgetExhausted) reasons.push("context_budget_exhausted");
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
  const assetRefs = [...context.asset_refs as JsonObject[], ...selectedNotes.map(note => ({ member: "craft_notes", id: note.id, version: note.version, scope, status: note.status }))];
  const packIdentity = { scope, asset_refs: assetRefs, context_receipt_id: receipt?.id ?? null, working_set_id: (context.working_set as JsonObject).id, task_kind: taskKind, partial: reasons.length > 0, partial_reasons: reasons, codebase: { status: codebase.status, reason: codebase.reason ?? null, failure_code: codebase.failure_code ?? null, failure_stage: codebase.failure_stage ?? null, failure_details: codebase.failure_details ?? {}, index_id: codebase.index_id ?? null, checkpoint_id: codebase.checkpoint_id ?? null, omitted_files: codebase.omitted_files ?? 0, omitted_by_language: codebase.omitted_by_language ?? {}, budget_omitted_count: budgetOmitted, query_omitted_count: queryOmitted, references }, max_items: maxItems, max_chars: maxChars, total_items: items + selectedNotes.length, total_used_chars: chars + noteBudget.chars };
  const id = `context_pack_${stableDigest(packIdentity).slice(-24)}`;
  const alreadyEmitted = service.contextWorkingSets.emittedRefs({ ...args, scope_kind: scope.kind, scope_id: scope.id }, assetRefs);
  const novel = (member: string, item: JsonObject) => !alreadyEmitted.some(ref => contextAssetMatches(ref, contextAssetRef(member, item, scope)));
  const injectionItems = (context.items as JsonObject[]).filter(item => novel("memory", item));
  const injectionContributions = (context.contributions as JsonObject[]).map(part => ({ ...part, items: (part.items as JsonObject[]).filter(item => novel(String(part.member), item)) }));
  const injection = JSON.stringify({ items: injectionItems, contributions: injectionContributions, host_refs: context.host_refs, codebase_references: references, craft_notes: selectedNotes });
  const estimatedTokens = estimateTokens(injection);
  if (args.max_tokens !== undefined && (!Number.isSafeInteger(args.max_tokens) || Number(args.max_tokens) < 1 || estimatedTokens > Number(args.max_tokens))) throw new CraftOperationError("LIMIT_EXCEEDED", "injection_budget", "Context injection exceeds estimated token budget or max_tokens is invalid", { budget: "max_tokens", estimated_tokens: estimatedTokens, limit: args.max_tokens });
  const identityDigest = stableDigest(packIdentity);
  const response = (packReceipt: JsonObject): JsonObject => {
    const contextStatus = receipt?.partial === true || retrievalBudgetExhausted ? "partial" : "resolved";
    const packStatus = reasons.length ? "partial" : "ready";
    return { ...context, context_status: contextStatus, pack_status: packStatus, items: injectionItems, contributions: injectionContributions, craft_notes: selectedNotes, knowledge_source_discovery: knowledgeSourceDiscovery, already_emitted_refs: alreadyEmitted, hook_reused: alreadyEmitted.length > 0, asset_refs: assetRefs, injection_measurement: { measurement_scope: "material_projection_excludes_protocol_envelope_and_host_history_bodies", serialized_chars: injection.length, estimated_tokens: estimatedTokens, tokenizer: "cjk_char_latin_four_char_estimate", exact: false, host_measured_tokens: null }, partial: reasons.length > 0, codebase: { ...codebase, analysis_confidence: (codebase.summary as JsonObject | undefined)?.certainty ?? null, references }, pack_receipt: packReceipt, host_execution_authority: false };
  };
  const priorPackReceipt = service.store.find("context_pack_receipt", id);
  if (priorPackReceipt) {
    assertContextReadCurrent(service.store, receipt);
    if (projection) service.codebase.assertContextProjectionCurrent(projection, references);
    assertNotesCurrent();
    if (priorPackReceipt.identity_digest !== identityDigest) throw new Error("Context Pack Receipt idempotency conflict");
    return response(priorPackReceipt);
  }
  return service.store.transaction(() => {
    assertContextReadCurrent(service.store, receipt);
    if (projection) service.codebase.assertContextProjectionCurrent(projection, references);
    assertNotesCurrent();
    const current = service.store.find("context_pack_receipt", id);
    if (current) {
      if (current.identity_digest !== identityDigest) throw new Error("Context Pack Receipt idempotency conflict");
      return response(current);
    }
    return response(service.store.create("context_pack_receipt", id, { ...packIdentity, identity_digest: identityDigest, content_free: true }));
  });
}
