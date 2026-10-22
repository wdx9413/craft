import type { JsonObject } from "./infrastructure/store.ts";
import { estimateTokens } from "./token-budget.ts";

/** Default hard limit for the compact Context response, including provenance metadata. */
export const DEFAULT_CONTEXT_RESPONSE_MAX_TOKENS = 1_500;
export type ContextResponseDetail = "compact" | "full";

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function pick(value: unknown, keys: readonly string[]): JsonObject {
  const source = object(value);
  return Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}

/** Keep selected evidence and its stable identity; drop duplicated audit payloads from the default Agent response. */
export function compactContextResponse(value: JsonObject): JsonObject {
  const receipt = object(value.receipt), packReceipt = object(value.pack_receipt), workingSet = object(value.working_set);
  const codebase = object(value.codebase), injection = object(value.injection_measurement);
  const contributions = Array.isArray(value.contributions) ? value.contributions.map(part => {
    const source = object(part);
    const summary = pick(source, ["member", "omitted_count", "partial", "status", "reason"]);
    if (Array.isArray(source.items)) {
      summary.item_count = source.items.length;
      summary.items = source.items.map(item => pick(item, ["claim_id", "claim_version", "procedure_id", "procedure_version", "procedure_kind",
        "content", "content_excerpt", "content_digest", "source_id", "evidence_ids", "scope", "scenario_key", "status",
        "trigger", "name", "definition_digest", "routeable", "host_next_step", "reason"]));
    }
    return summary;
  }) : [];
  const result: JsonObject = {
    context_status: value.context_status,
    pack_status: value.pack_status,
    partial: value.partial,
    partial_reasons: packReceipt.partial_reasons ?? [],
    items: Array.isArray(value.items) ? [...value.items] : [],
    contributions,
    asset_refs: value.asset_refs ?? [],
    already_emitted_count: Array.isArray(value.already_emitted_refs) ? value.already_emitted_refs.length : 0,
    hook_reused: value.hook_reused ?? false,
    receipt: pick(receipt, ["id", "scope", "scope_access", "partial", "partial_reasons", "members", "retrieval_members", "retrieval_adapter_id", "total_items", "total_used_chars", "omitted_count", "deduplicated_count", "deduplicated_refs_omitted_count"]),
    working_set: pick(workingSet, ["id", "source_receipt_id", "omitted_count", "host_items", "host_used_chars"]),
    pack_receipt: pick(packReceipt, ["id", "scope", "task_kind", "partial", "partial_reasons", "max_items", "max_chars", "total_items", "total_used_chars"]),
    codebase: pick(codebase, ["status", "reason", "failure_code", "failure_stage", "workspace_id", "index_id", "checkpoint_id", "omitted_files", "budget_omitted_count", "query_omitted_count", "budget_rebalanced", "analysis_confidence", "references"]),
    injection_measurement: pick(injection, ["measurement_scope", "serialized_chars", "estimated_tokens", "tokenizer", "exact", "host_measured_tokens"]),
    host_execution_authority: value.host_execution_authority ?? false,
  };
  if (Array.isArray(value.host_refs) && value.host_refs.length > 0) result.host_refs = value.host_refs;
  if (value.trace_correlation !== undefined) result.trace_correlation = value.trace_correlation;
  if (value.telemetry_error !== undefined) result.telemetry_error = value.telemetry_error;
  if (value.knowledge_source_discovery !== undefined) result.knowledge_source_discovery = pick(value.knowledge_source_discovery, ["status", "reason", "sources_registered", "sources_ingested", "candidates_created"]);
  if (Array.isArray((result.codebase as JsonObject).references)) (result.codebase as JsonObject).references = [...(result.codebase as JsonObject).references as JsonObject[]];
  return result;
}

export function resolveContextResponseDetail(name: string, supplied: unknown): ContextResponseDetail | null {
  if (name !== "craft_context_open") return null;
  const args = object(supplied);
  const detail = args.response_detail === undefined ? "compact" : args.response_detail;
  if (detail !== "compact" && detail !== "full") throw new Error("response_detail must be compact or full");
  if (detail === "full" && args.max_tokens === undefined) throw new Error("response_detail=full requires max_tokens");
  return detail;
}

export function formatContextResponse(value: JsonObject, detail: ContextResponseDetail | null, maxTokens: unknown, controls: JsonObject = {}): { result: JsonObject; contentText: string } {
  if (detail === null) return { result: value, contentText: JSON.stringify(value, null, 2) };
  if (detail === "full") {
    const responseTokens = estimateTokens(JSON.stringify(value));
    const responseLimit = Number(maxTokens);
    if (!Number.isSafeInteger(responseLimit) || responseLimit < 1 || responseTokens > responseLimit) {
      throw new Error(`Full Context response exceeds estimated token budget (${responseTokens}/${responseLimit})`);
    }
    return { result: value, contentText: JSON.stringify(value) };
  }
  const result = compactContextResponse(value);
  const requestedLimit = Number(maxTokens ?? DEFAULT_CONTEXT_RESPONSE_MAX_TOKENS);
  const responseLimit = Math.min(requestedLimit, DEFAULT_CONTEXT_RESPONSE_MAX_TOKENS);
  const measurement = object(result.injection_measurement);
  const responseMeasurement = (tokens: number): void => {
    result.injection_measurement = { ...measurement, response_estimated_tokens: tokens, response_token_limit: responseLimit };
  };
  const measure = (): number => {
    responseMeasurement(0);
    const initialTokens = estimateTokens(JSON.stringify(result));
    responseMeasurement(initialTokens);
    return estimateTokens(JSON.stringify(result));
  };
  let responseTokens = measure();
  let responseOmittedItems = 0;
  const groups: Array<{ member: string; items: JsonObject[]; contribution?: JsonObject }> = [
    { member: "memory", items: result.items as JsonObject[] },
    ...(result.contributions as JsonObject[]).filter(part => Array.isArray(part.items)).map(part => ({ member: String(part.member), items: part.items as JsonObject[], contribution: part })),
    { member: "codebase", items: ((result.codebase as JsonObject).references ?? []) as JsonObject[] },
  ];
  const idOf = (item: JsonObject) => item.memory_id ?? item.claim_id ?? item.procedure_id ?? item.node_id ?? item.id;
  const versionOf = (item: JsonObject) => item.memory_version ?? item.claim_version ?? item.procedure_version ?? item.record_version ?? item.version;
  const required = (member: string, item: JsonObject): boolean => item.reason === "required"
    || member === "memory" && Array.isArray(controls.memory_ids) && controls.memory_ids.includes(idOf(item))
    || Array.isArray(controls.required_refs) && controls.required_refs.some(ref => ref && typeof ref === "object" && (ref as JsonObject).member === member && (ref as JsonObject).id === idOf(item)
      && ((ref as JsonObject).version === undefined || (ref as JsonObject).version === versionOf(item)));
  // Keep each member's ranking order. Response-level omissions never change the
  // source receipt, mutate its selected materials, or silently discard required refs.
  while (responseTokens > responseLimit) {
    let removed: { member: string; item: JsonObject } | undefined;
    for (let groupIndex = groups.length - 1; groupIndex >= 0 && !removed; groupIndex--) {
      const group = groups[groupIndex]!;
      for (let index = group.items.length - 1; index >= 0; index--) {
        if (required(group.member, group.items[index]!)) continue;
        removed = { member: group.member, item: group.items.splice(index, 1)[0]! };
        if (group.contribution) group.contribution.item_count = group.items.length;
        break;
      }
    }
    if (!removed) break;
    const omitted = removed;
    result.asset_refs = (result.asset_refs as JsonObject[]).filter(ref => ref.member !== omitted.member || ref.id !== idOf(omitted.item)
      || versionOf(omitted.item) !== undefined && ref.version !== versionOf(omitted.item));
    responseOmittedItems += 1;
    result.response_partial = true;
    result.response_omitted_items = responseOmittedItems;
    result.response_omission_reason = "response_token_budget";
    responseTokens = measure();
  }
  if (!Number.isSafeInteger(responseLimit) || responseLimit < 1 || responseTokens > responseLimit) {
    throw new Error(`Compact Context response exceeds estimated token budget (${responseTokens}/${responseLimit})`);
  }
  responseMeasurement(responseTokens);
  return { result, contentText: JSON.stringify(result) };
}
