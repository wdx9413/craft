import assert from "node:assert/strict";
import test from "node:test";
import { compactContextResponse, DEFAULT_CONTEXT_RESPONSE_MAX_TOKENS, formatContextResponse, resolveContextResponseDetail } from "../core/context-response-projection.ts";
import { estimateTokens } from "../core/token-budget.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";

test("compact Context response preserves selected evidence and stable provenance only", () => {
  const source: JsonObject = {
    context_status: "partial", pack_status: "partial", partial: true,
    items: [{ memory_id: "memory-1", content: "project fact", content_digest: "digest-1" }],
    contributions: [{ member: "knowledge", items: [{ claim_id: "claim-1", content: "verified claim", evidence_ids: ["evidence-1"] }], internal_rank_trace: Array(50).fill("discard") }],
    asset_refs: [{ member: "memory", id: "memory-1", version: 2, digest: "digest-1" }],
    already_emitted_refs: [{ id: "old-ref" }], hook_reused: true,
    receipt: { id: "receipt-1", scope: { kind: "project", id: "p" }, partial: true, partial_reasons: ["missing"], members: ["knowledge"], retrieval_members: ["knowledge"], total_items: 2, total_used_chars: 100, omitted_count: 1, deduplicated_count: 3, deduplicated_refs_omitted_count: 4, deduplicated_refs: Array(50).fill("discard"), attempted_scopes: [{ id: "/other/project" }], private_trace: "discard" },
    working_set: { id: "working-1", source_receipt_id: "receipt-1", omitted_count: 1, host_items: 0, host_used_chars: 0, private_payload: "discard" },
    pack_receipt: { id: "pack-1", scope: { kind: "project", id: "p" }, task_kind: "code", partial: true, partial_reasons: ["missing"], max_items: 3, max_chars: 1_200, total_items: 2, total_used_chars: 100, identity_digest: "discard", asset_refs: Array(50).fill("discard") },
    codebase: { status: "ready", workspace_id: "workspace", index_id: "index", checkpoint_id: "checkpoint", analysis_confidence: "partial", references: [{ node_id: "symbol-1", checkpoint_id: "checkpoint" }], full_graph: "discard" },
    injection_measurement: { serialized_chars: 100, estimated_tokens: 40, tokenizer: "estimated", exact: false, host_measured_tokens: null, sensitive_prompt: "discard" },
    knowledge_source_discovery: { status: "ready", sources_registered: 2, sources_ingested: 1, candidates_created: 1, source_body: "discard" },
    host_refs: [{ member: "history", id: "host-ref" }], trace_correlation: { trace_id: "trace-1" }, telemetry_error: { category: "storage" }, host_execution_authority: false,
  };
  const result = compactContextResponse(source);
  assert.deepEqual(result.items, source.items);
  assert.deepEqual(result.contributions, [{ member: "knowledge", item_count: 1, items: [{ claim_id: "claim-1", content: "verified claim", evidence_ids: ["evidence-1"] }] }]);
  assert.equal(JSON.stringify(result.contributions).includes("verified claim"), true);
  assert.deepEqual(result.asset_refs, source.asset_refs);
  assert.deepEqual(result.trace_correlation, source.trace_correlation);
  assert.deepEqual(result.telemetry_error, source.telemetry_error);
  assert.deepEqual(result.codebase, { status: "ready", workspace_id: "workspace", index_id: "index", checkpoint_id: "checkpoint", analysis_confidence: "partial", references: [{ node_id: "symbol-1", checkpoint_id: "checkpoint" }] });
  assert.equal(result.already_emitted_count, 1);
  assert.equal(JSON.stringify(result).includes("discard"), false);
  assert.equal(JSON.stringify(result).includes("/other/project"), false);
});

test("compact Context response is bounded for three Chinese items at the default token ceiling", () => {
  const source: JsonObject = {
    context_status: "resolved", pack_status: "ready", partial: false,
    items: Array.from({ length: 3 }, (_, index) => ({ memory_id: `memory-${index}`, content: "项目事实。".repeat(78) })),
    contributions: [], asset_refs: [], receipt: {}, working_set: {}, pack_receipt: {}, codebase: {}, injection_measurement: {},
  };
  const result = compactContextResponse(source);
  const estimatedTokens = estimateTokens(JSON.stringify(result));
  assert(estimatedTokens <= DEFAULT_CONTEXT_RESPONSE_MAX_TOKENS);
});

test("compact Context response omits low-ranked items instead of exceeding its token ceiling", () => {
  const source: JsonObject = {
    context_status: "resolved", pack_status: "ready", partial: false,
    items: Array.from({ length: 3 }, (_, index) => ({ memory_id: `memory-${index}`, content: `${index}:` + "项目事实。".repeat(140) })),
    contributions: [], asset_refs: [], receipt: {}, working_set: {}, pack_receipt: {}, codebase: {}, injection_measurement: {},
  };
  const formatted = formatContextResponse(source, "compact", undefined);
  const result = JSON.parse(formatted.contentText) as JsonObject;
  assert.deepEqual(result.items, [source.items && (source.items as JsonObject[])[0]]);
  assert.equal(result.response_partial, true);
  assert.equal(result.response_omitted_items, 2);
  assert.equal(result.response_omission_reason, "response_token_budget");
  assert.equal((source.items as JsonObject[]).length, 3);
  assert(estimateTokens(formatted.contentText) <= DEFAULT_CONTEXT_RESPONSE_MAX_TOKENS);
});

test("compact Context response handles absent optional fields without inventing provenance", () => {
  const result = compactContextResponse({ pack_status: "ready" });
  assert.deepEqual(result.asset_refs, []);
  assert.equal(result.already_emitted_count, 0);
  assert.equal(result.host_execution_authority, false);
  assert.equal("trace_correlation" in result, false);
  assert.equal("telemetry_error" in result, false);
  assert.equal("host_refs" in result, false);
  assert.equal("knowledge_source_discovery" in result, false);
  const malformed = compactContextResponse({ receipt: [], working_set: [], pack_receipt: [], codebase: [], injection_measurement: [], contributions: [null], host_refs: [], trace_correlation: null, knowledge_source_discovery: null });
  assert.deepEqual(malformed.receipt, {});
  assert.deepEqual(malformed.contributions, [{}]);
  assert.equal("host_refs" in malformed, false);
  assert.equal(malformed.trace_correlation, null);
  assert.deepEqual(malformed.knowledge_source_discovery, {});
});

test("compact response keeps Knowledge passages and routeable Experience summaries", () => {
  const value: JsonObject = { contributions: [
    { member: "knowledge", items: [{ claim_id: "k", claim_version: 1, content: "部署前先检查实际加载的配置。", content_excerpt: { source_start: 10, source_end: 26 } }] },
    { member: "experience", items: [{ procedure_id: "e", procedure_version: 2, trigger: "排查部署配置不生效", routeable: true, host_next_step: "inspect", internal_graph: "discard" }] },
  ] };
  const result = formatContextResponse(value, "compact", undefined);
  assert.match(result.contentText, /部署前先检查实际加载的配置/u);
  assert.match(result.contentText, /排查部署配置不生效/u);
  assert.equal(result.contentText.includes("discard"), false);
});

test("response budget applies to every material member and removes only omitted asset revisions", () => {
  const source: JsonObject = { items: [], contributions: [
    { member: "knowledge", items: [{ claim_id: "k", claim_version: 1, content: "知识。".repeat(200) }, { claim_id: "k", claim_version: 2, content: "知识。".repeat(200) }] },
    { member: "experience", items: [{ procedure_id: "e", procedure_version: 1, trigger: "经验。".repeat(1000) }] },
  ], codebase: { references: [{ node_id: "code", record_version: 1, snippet: "代码。".repeat(1000) }] }, asset_refs: [
    { member: "knowledge", id: "k", version: 1 }, { member: "knowledge", id: "k", version: 2 }, { member: "experience", id: "e", version: 1 }, { member: "codebase", id: "code", version: 1 },
  ] };
  const formatted = formatContextResponse(source, "compact", 1200);
  assert(estimateTokens(formatted.contentText) <= 1200);
  assert.deepEqual(formatted.result.asset_refs, [{ member: "knowledge", id: "k", version: 1 }]);
  assert.equal(formatted.result.response_omitted_items, 3);
  assert.equal(((source.contributions as JsonObject[])[0]!.items as JsonObject[]).length, 2);
  assert.equal(((source.codebase as JsonObject).references as JsonObject[]).length, 1);
});

test("response formatting refuses to omit required Memory and typed Knowledge material", () => {
  const memory = { items: [{ memory_id: "m", memory_version: 1, content: "必需事实。".repeat(1000) }] };
  assert.throws(() => formatContextResponse(memory, "compact", 1000, { memory_ids: ["m"] }), /exceeds/u);
  assert.throws(() => formatContextResponse({ items: [{ ...memory.items[0], reason: "required" }] }, "compact", 1000), /exceeds/u);
  const knowledge = { contributions: [{ member: "knowledge", items: [{ claim_id: "k", claim_version: 1, content: "必需知识。".repeat(1000) }] }] };
  assert.throws(() => formatContextResponse(knowledge, "compact", 1000, { required_refs: [{ member: "knowledge", id: "k" }] }), /exceeds/u);
  assert.throws(() => formatContextResponse(knowledge, "compact", 1000, { required_refs: [{ member: "knowledge", id: "k", version: 1 }] }), /exceeds/u);
  const optional = formatContextResponse(knowledge, "compact", 1000, { required_refs: [null, "invalid", { member: "memory", id: "k" }, { member: "knowledge", id: "other" }, { member: "knowledge", id: "k", version: 2 }] });
  assert.equal(optional.result.response_omitted_items, 1);
});

test("response omissions accept generic Codebase asset identities", () => {
  const source: JsonObject = { codebase: { references: [{ id: "generic", version: 3, snippet: "代码。".repeat(1000) }] },
    asset_refs: [{ member: "codebase", id: "generic", version: 3 }] };
  const result = formatContextResponse(source, "compact", 1000);
  assert.deepEqual(result.result.asset_refs, []);
  assert.equal(result.result.response_omitted_items, 1);
});

test("MCP Context response defaults to compact, validates full mode, and enforces the response token budget", () => {
  const full = { pack_status: "ready", items: [{ content: "selected" }], receipt: { deduplicated_refs: ["verbose"] } } as JsonObject;
  assert.equal(resolveContextResponseDetail("craft_context_open", {}), "compact");
  assert.equal(resolveContextResponseDetail("other_tool", { response_detail: "bad" }), null);
  assert.equal(resolveContextResponseDetail("craft_context_open", { response_detail: "full", max_tokens: 2_000 }), "full");
  assert.throws(() => resolveContextResponseDetail("craft_context_open", { response_detail: "full" }), /requires max_tokens/u);
  assert.throws(() => resolveContextResponseDetail("craft_context_open", { response_detail: "verbose" }), /compact or full/u);

  const compact = formatContextResponse(full, "compact", undefined);
  assert.deepEqual(JSON.parse(compact.contentText), JSON.parse(JSON.stringify(compact.result)));
  assert.equal(Number((compact.result.injection_measurement as JsonObject).response_estimated_tokens) <= DEFAULT_CONTEXT_RESPONSE_MAX_TOKENS, true);
  const oversizedRequest = formatContextResponse(full, "compact", 10_000);
  assert.equal((oversizedRequest.result.injection_measurement as JsonObject).response_token_limit, DEFAULT_CONTEXT_RESPONSE_MAX_TOKENS);
  assert.throws(() => formatContextResponse(full, "compact", 1), /Compact Context response exceeds/u);
  assert.throws(() => formatContextResponse(full, "compact", 0), /Compact Context response exceeds/u);
  assert.throws(() => formatContextResponse(full, "compact", "invalid"), /Compact Context response exceeds/u);
  const complete = formatContextResponse(full, "full", 2_000);
  assert.equal(complete.result, full);
  assert.equal(JSON.parse(complete.contentText).receipt.deduplicated_refs[0], "verbose");
  assert.throws(() => formatContextResponse(full, "full", 1), /Full Context response exceeds/u);
  assert.throws(() => formatContextResponse(full, "full", 0), /Full Context response exceeds/u);
  assert.throws(() => formatContextResponse(full, "full", "invalid"), /Full Context response exceeds/u);
  assert.equal(formatContextResponse(full, null, undefined).contentText, JSON.stringify(full, null, 2));
});
