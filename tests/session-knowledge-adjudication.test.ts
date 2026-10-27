import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChatResult, ModelProviderSpec, ModelTransport } from "../core/model-gateway.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { readKnowledgeAdjudicationCursor, readKnowledgeAdjudicationRetries, recordKnowledgeAdjudicationFailure, writeKnowledgeAdjudicationCursor } from "../deploy/experience-learning/session-knowledge-adjudication-state.ts";
import { runSessionKnowledgeAdjudicationOnce } from "../deploy/experience-learning/session-knowledge-adjudication.ts";
import type { ExperienceLearningClient } from "../deploy/experience-learning/worker.ts";

const provider: ModelProviderSpec = { provider: "codex-cli", label: "Codex CLI Host", protocol: "openai-compatible",
  base_url: "https://codex-cli-host.invalid", api_key_env: "CODEX_CLI_AUTH_STORE", chat_path: "/host/exec", models: { small: "gpt-6-luna" },
  cost_hint: 1, supports_tools: false, host_managed_auth: true };
const caseRecord: JsonObject = { id: "held-case", version: 1, identity_digest: "case-identity", query: "验证任务",
  expected_claim_ids: ["candidate-1"], candidate_claim_refs: [{ claim_id: "candidate-1", claim_version: 2, identity_digest: "claim-identity", content_digest: "claim-content" }],
  source_evidence_ids: ["held-evidence"], source_session_id: "held-session", source_task_id: "held-task", dataset_partition: "held_out",
  evaluation_channel: "real_session", label_source: "model_candidate", created_at: "2026-10-01T00:00:00.000Z" };

function fixture(options: { cases?: JsonObject[]; caseListResult?: JsonObject; runsResult?: JsonObject; evidenceSession?: string; evidence?: JsonObject;
  response?: string; profileStatus?: string; profileResult?: JsonObject; profileDetail?: JsonObject; profile?: JsonObject; provider?: JsonObject;
  packetResult?: JsonObject; packetByClaim?: Record<string, JsonObject>; throwOn?: string; throwRaw?: boolean; throwName?: string; throwCode?: string;
  traceStartResult?: JsonObject; adjudicationResult?: JsonObject; evidenceDirect?: boolean;
  usage?: { input_tokens: number; output_tokens: number; cache_hit_tokens?: number; cache_miss_tokens?: number } | null; acquire?: boolean } = {}) {
  const calls: Array<{ name: string; args: JsonObject }> = [];
  let failTransportOnce = options.throwOn === "transport.complete";
  const client: ExperienceLearningClient = { async call(name, args = {}) {
    calls.push({ name, args });
    if (options.throwOn === name) { if (options.throwRaw) throw "controlled failure"; throw Object.assign(new Error("controlled failure"), {
      name: options.throwName ?? "TypeError", ...(options.throwCode ? { code: options.throwCode } : {}) }); }
    if (name === "craft_knowledge_evaluation_case_list") {
      if (options.caseListResult) return options.caseListResult;
      const allCases = options.cases ?? [caseRecord];
      if (args.after_id === undefined) return { cases: allCases };
      const page = allCases.filter(item => String(item.id) > String(args.after_id)).sort((a, b) => String(a.id).localeCompare(String(b.id))).slice(0, 1_000);
      return { cases: page, has_more: false, next_cursor: null };
    }
    if (name === "craft_knowledge_evaluation_run_list") return options.runsResult ?? { runs: [] };
    if (name === "craft_knowledge_semantic_review_packet") {
      const claimId = String(args.claim_id ?? "candidate-1");
      const claim = options.packetByClaim?.[claimId] ?? { id: "candidate-1", version: 2, identity_digest: "claim-identity", content_digest: "claim-content", content: "事实内容", title: "事实", tags: [] };
      return options.packetResult ?? { status: "ready", claim_status: "candidate", packet: { claim } };
    }
    if (name === "craft_evidence_get") return options.evidenceDirect ? (options.evidence ?? { id: "held-evidence", source_type: "program", confidence: "confirmed", claim: "任务验证通过",
      metadata: { source_session_id: options.evidenceSession ?? "held-session", task_id: "held-task" } }) : options.evidence ? { evidence: options.evidence } : { evidence: { id: "held-evidence", source_type: "program", confidence: "confirmed", claim: "任务验证通过",
      metadata: { source_session_id: options.evidenceSession ?? "held-session", task_id: "held-task" } } };
    if (name === "craft_evaluation_model_profile_ensure_single") return options.profileResult ?? (options.profileStatus === "missing" ? { status: "missing" } : { status: "ready_for_adapter", profile: options.profile ?? { id: "profile", version: 1, provider: "codex-cli", model: "gpt-6-luna", max_output_tokens: 256 } });
    if (name === "craft_evaluation_model_profile_get") return options.profileDetail ?? { readiness: { status: "ready_for_adapter" }, ...(options.provider ? { provider: options.provider } : {}) };
    if (name === "craft_trace_start") return options.traceStartResult ?? { trace: { id: "adjudication-trace" } };
    if (name === "craft_knowledge_evaluation_case_adjudicate") {
      if (failTransportOnce) { failTransportOnce = false; if (options.throwRaw) throw "controlled failure";
        throw Object.assign(new Error("controlled model failure"), { name: options.throwName ?? "TypeError" }); }
      if (options.adjudicationResult) return options.adjudicationResult;
      let output: JsonObject;
      try { output = JSON.parse(options.response ?? JSON.stringify({ decision: "accepted", expected_claim_ids: ["candidate-1"] })) as JsonObject; }
      catch { throw new Error("Knowledge adjudicator must return one JSON object"); }
      if (!output || Array.isArray(output) || typeof output !== "object") throw new Error("Knowledge adjudicator must return one JSON object");
      const labels = output.expected_claim_ids;
      if (!Array.isArray(labels) || !["accepted", "corrected", "rejected", "uncertain"].includes(String(output.decision))
        || labels.some(id => !["candidate-1", "candidate-2"].includes(String(id)))
        || ["rejected", "uncertain"].includes(String(output.decision)) && labels.length !== 0) {
        throw new Error("Knowledge adjudication output does not match the bound candidate labels");
      }
      return { case: { ...caseRecord, label_source: ["accepted", "corrected"].includes(String(output.decision)) ? "host_adjudicated" : "model_candidate", version: 2 },
        adjudication: { id: "adjudication-1", decision: output.decision, created_at: "2026-10-01T00:01:00.000Z" }, trace_id: "adjudication-trace" };
    }
    if (name === "craft_knowledge_evaluation_run") return { run: { id: "shadow-run", status: "insufficient", metrics: { provenance_eligible: false } } };
    if (name.startsWith("craft_trace_")) return {};
    throw new Error(`unexpected tool ${name}`);
  } };
  const transport: ModelTransport = { acquireCall: () => options.acquire ?? true, async complete(): Promise<ChatResult> {
    if (failTransportOnce) { failTransportOnce = false; if (options.throwRaw) throw "controlled failure"; throw Object.assign(new Error("controlled model failure"), { name: options.throwName ?? "TypeError" }); }
    return { text: options.response ?? JSON.stringify({ decision: "accepted", expected_claim_ids: ["candidate-1"] }), model: "gpt-6-luna", usage: options.usage ?? null };
  } };
  return { client, transport, calls };
}

test("idle Knowledge adjudication returns before profile lookup or model work", async () => {
  await assert.rejects(runSessionKnowledgeAdjudicationOnce({ client: fixture().client }, "not-a-date"), /now must be an ISO timestamp/u);
  const f = fixture({ cases: [] });
  assert.deepEqual(await runSessionKnowledgeAdjudicationOnce({ client: f.client }), { status: "idle", processed: 0, model_calls: 0, raw_content_stored: false });
  assert.equal(f.calls.some(call => call.name.includes("profile")), false);
  const malformedLists = fixture({ caseListResult: { cases: "invalid" }, runsResult: { runs: null } });
  assert.equal((await runSessionKnowledgeAdjudicationOnce({ client: malformedLists.client })).status, "idle");
  const alreadyEvaluated = fixture({ cases: [{ ...caseRecord, label_source: "host_adjudicated", adjudication_id: "a" }],
    runsResult: { runs: [{ mode: "candidate_shadow", case_ids: ["held-case"] }] } });
  assert.equal((await runSessionKnowledgeAdjudicationOnce({ client: alreadyEvaluated.client })).status, "idle");
  const unsupportedLabel = fixture({ cases: [{ ...caseRecord, label_source: "operator_asserted" }] });
  assert.equal((await runSessionKnowledgeAdjudicationOnce({ client: unsupportedLabel.client })).status, "idle");
});

test("held-out source mismatch blocks model adjudication", async () => {
  const f = fixture({ evidenceSession: "other-session" });
  const result = await runSessionKnowledgeAdjudicationOnce({ client: f.client, transport: f.transport, providers: [provider] });
  assert.equal(result.status, "waiting_for_verified_evidence");
  assert.equal(f.calls.some(call => call.name === "craft_trace_start"), false);
});

test("a blocked oldest held-out case does not starve the next case", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-adjudication-worker-"));
  try {
    const blocked = { ...caseRecord, id: "case-a", source_evidence_ids: [], created_at: undefined };
    const ready = { ...caseRecord, id: "case-b", created_at: undefined };
    const later = { ...caseRecord, id: "case-c", created_at: "2026-10-02T00:00:00.000Z" };
    const f = fixture({ cases: [blocked, ready, later] });
    const deps = { client: f.client, transport: f.transport, providers: [provider], knowledge_adjudication_cursor_file: join(root, "knowledge", "cursor.json") };
    assert.equal((await runSessionKnowledgeAdjudicationOnce(deps)).status, "waiting_for_verified_evidence");
    assert.equal((await runSessionKnowledgeAdjudicationOnce(deps)).status, "adjudicated");
    assert.equal(f.calls.filter(call => call.name === "craft_knowledge_evaluation_case_adjudicate").length, 1);
    assert.deepEqual(f.calls.filter(call => call.name === "craft_knowledge_evaluation_case_list").map(call => call.args.after_id), ["", "case-a"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("adjudication cursor advances over empty pages and resets after the final page", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-adjudication-page-cursor-")), cursorFile = join(root, "knowledge", "cursor.json");
  try {
    const first = fixture({ caseListResult: { cases: [], has_more: true, next_cursor: "page-last-id" } });
    await runSessionKnowledgeAdjudicationOnce({ client: first.client, knowledge_adjudication_cursor_file: cursorFile });
    assert.equal(readKnowledgeAdjudicationCursor(cursorFile), "page-last-id");
    const last = fixture({ caseListResult: { cases: [], has_more: false, next_cursor: null } });
    await runSessionKnowledgeAdjudicationOnce({ client: last.client, knowledge_adjudication_cursor_file: cursorFile });
    assert.equal(last.calls.find(call => call.name === "craft_knowledge_evaluation_case_list")?.args.after_id, "page-last-id");
    assert.equal(readKnowledgeAdjudicationCursor(cursorFile), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("adjudication fails closed when a page cursor is missing or repeats", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-adjudication-invalid-page-")), cursorFile = join(root, "knowledge", "cursor.json");
  try {
    const missing = fixture({ caseListResult: { cases: [], has_more: true, next_cursor: null } });
    await assert.rejects(runSessionKnowledgeAdjudicationOnce({ client: missing.client, knowledge_adjudication_cursor_file: cursorFile }), /page is invalid/u);
    await writeKnowledgeAdjudicationCursor(cursorFile, "page-last-id");
    const repeated = fixture({ caseListResult: { cases: [], has_more: true, next_cursor: "page-last-id" } });
    await assert.rejects(runSessionKnowledgeAdjudicationOnce({ client: repeated.client, knowledge_adjudication_cursor_file: cursorFile }), /page is invalid/u);
    const malformed = fixture({ caseListResult: { cases: "invalid", has_more: true, next_cursor: "next-page" } });
    await assert.rejects(runSessionKnowledgeAdjudicationOnce({ client: malformed.client, knowledge_adjudication_cursor_file: join(root, "knowledge", "malformed.json") }), /page is invalid/u);
    const unexpectedEndCursor = fixture({ caseListResult: { cases: [], has_more: false, next_cursor: "unexpected" } });
    await assert.rejects(runSessionKnowledgeAdjudicationOnce({ client: unexpectedEndCursor.client,
      knowledge_adjudication_cursor_file: join(root, "knowledge", "unexpected-end.json") }), /page is invalid/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed cases back off, expose bounded page metrics, and retry after the delay", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-adjudication-backoff-")), cursorFile = join(root, "knowledge", "cursor.json");
  try {
    const f = fixture({ throwOn: "transport.complete" });
    const start = "2026-10-23T00:00:00.000Z";
    await assert.rejects(runSessionKnowledgeAdjudicationOnce({ client: f.client, transport: f.transport, providers: [provider],
      knowledge_adjudication_cursor_file: cursorFile }, start));
    const retry = readKnowledgeAdjudicationRetries(cursorFile)["held-case"];
    assert.equal(retry?.attempts, 1);
    assert.equal(retry?.next_attempt_at, "2026-10-23T00:00:30.000Z");

    await runSessionKnowledgeAdjudicationOnce({ client: f.client, knowledge_adjudication_cursor_file: cursorFile }, "2026-10-23T00:00:05.000Z");
    const waiting = await runSessionKnowledgeAdjudicationOnce({ client: f.client, knowledge_adjudication_cursor_file: cursorFile }, "2026-10-23T00:00:10.000Z");
    assert.equal(waiting.status, "waiting_for_retry");
    assert.equal((waiting.queue_metrics as JsonObject).page_pending_count, 1);
    assert.equal((waiting.queue_metrics as JsonObject).page_ready_count, 0);
    assert.equal((waiting.queue_metrics as JsonObject).page_deferred_count, 1);
    assert.equal((waiting.queue_metrics as JsonObject).page_next_retry_at, retry?.next_attempt_at);
    assert.equal(f.calls.filter(call => call.name === "craft_knowledge_evaluation_case_adjudicate").length, 1);

    const recovered = await runSessionKnowledgeAdjudicationOnce({ client: f.client, transport: f.transport, providers: [provider],
      knowledge_adjudication_cursor_file: cursorFile }, "2026-10-23T00:00:30.000Z");
    assert.equal(recovered.status, "adjudicated");
    assert.deepEqual(readKnowledgeAdjudicationRetries(cursorFile), {});
    assert.equal((recovered.queue_metrics as JsonObject).page_ready_count, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("multi-case ordering selects the oldest eligible case and earliest deferred retry", async () => {
  const older = { ...caseRecord, id: "case-a", created_at: "2026-10-01T00:00:00.000Z" };
  const newer = { ...caseRecord, id: "case-b", created_at: "2026-10-02T00:00:00.000Z" };
  const ordered = fixture({ cases: [{ ...newer, created_at: undefined }, { ...older, created_at: undefined }] });
  const selected = await runSessionKnowledgeAdjudicationOnce({ client: ordered.client, transport: ordered.transport, providers: [provider] });
  assert.equal(ordered.calls.find(call => call.name === "craft_knowledge_evaluation_case_adjudicate")?.args.case_id, "case-a");

  const root = mkdtempSync(join(tmpdir(), "craft-adjudication-retry-order-")), cursorFile = join(root, "knowledge", "cursor.json");
  try {
    const metrics = fixture({ cases: [newer, older] });
    const measured = await runSessionKnowledgeAdjudicationOnce({ client: metrics.client, knowledge_adjudication_cursor_file: cursorFile }, "2026-10-23T00:00:10.000Z");
    assert.equal((measured.queue_metrics as JsonObject).page_oldest_pending_at, "2026-10-01T00:00:00.000Z");
    await writeKnowledgeAdjudicationCursor(cursorFile, null);
    await recordKnowledgeAdjudicationFailure(cursorFile, "case-a", "TypeError", "2026-10-23T00:00:00.000Z");
    await recordKnowledgeAdjudicationFailure(cursorFile, "case-b", "TypeError", "2026-10-23T00:00:00.000Z");
    await recordKnowledgeAdjudicationFailure(cursorFile, "case-b", "TypeError", "2026-10-23T00:00:01.000Z");
    const deferred = fixture({ cases: [newer, older] });
    const waiting = await runSessionKnowledgeAdjudicationOnce({ client: deferred.client, knowledge_adjudication_cursor_file: cursorFile }, "2026-10-23T00:00:10.000Z");
    assert.equal(waiting.status, "waiting_for_retry");
    assert.equal((waiting.queue_metrics as JsonObject).page_next_retry_at, "2026-10-23T00:00:30.000Z");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Host adjudication binds candidate, held-out evidence and result to a completed Trace", async () => {
  const f = fixture({ usage: { input_tokens: 8, output_tokens: 5 } });
  const result = await runSessionKnowledgeAdjudicationOnce({ client: f.client, transport: f.transport, providers: [provider] });
  assert.equal(result.status, "adjudicated");
  assert.equal(result.model_calls, 1);
  assert.equal(result.evaluation_status, "insufficient");
  assert.equal(result.evaluation_eligible, false);
  assert.equal(result.raw_content_stored, false);
  const persist = f.calls.find(call => call.name === "craft_knowledge_evaluation_case_adjudicate");
  assert.deepEqual(persist?.args, { case_id: "held-case", expected_version: 1 });
  assert.equal(result.trace_id, "adjudication-trace");
  assert.equal(f.calls.some(call => call.name.startsWith("craft_trace_")), false);
  assert.equal(f.calls.some(call => call.name === "craft_knowledge_evaluation_run"), true);
});

test("recovered Host adjudication reports zero new model calls", async () => {
  const f = fixture({ adjudicationResult: { case: { ...caseRecord, label_source: "host_adjudicated", version: 2 },
    adjudication: { id: "adjudication-1", decision: "accepted", created_at: "2026-10-01T00:01:00.000Z" },
    trace_id: "adjudication-trace", model_calls: 0 } });
  const result = await runSessionKnowledgeAdjudicationOnce({ client: f.client, transport: f.transport, providers: [provider] });
  assert.equal(result.status, "adjudicated");
  assert.equal(result.model_calls, 0);
  assert.equal(f.calls.some(call => call.name === "craft_knowledge_evaluation_run"), true);
});

test("previously adjudicated cases create exactly one shadow run without a second model call", async () => {
  const f = fixture({ cases: [{ ...caseRecord, label_source: "host_adjudicated", adjudication_id: "adjudication-1", adjudication_created_at: "now" }] });
  const result = await runSessionKnowledgeAdjudicationOnce({ client: f.client });
  assert.equal(result.status, "shadow_evaluation_created");
  assert.equal(result.model_calls, 0);
  assert.equal(result.evaluation_eligible, false);
  const run = f.calls.find(call => call.name === "craft_knowledge_evaluation_run");
  assert.equal(run?.args.mode, "candidate_shadow");
  assert.deepEqual(run?.args.candidate_claim_ids, ["candidate-1"]);

  const retrievalCase = { ...caseRecord, candidate_claim_refs: undefined, label_source: "host_adjudicated", adjudication_id: undefined,
    adjudication_created_at: undefined, updated_at: undefined };
  const retrieval = fixture({ cases: [retrievalCase], runsResult: { runs: [{ mode: "retrieval", case_ids: [1, "another-case"] }, { mode: "retrieval", case_ids: "invalid" }] } });
  const retrievalResult = await runSessionKnowledgeAdjudicationOnce({ client: retrieval.client });
  assert.equal(retrievalResult.status, "shadow_evaluation_created");
  assert.equal(retrieval.calls.find(call => call.name === "craft_knowledge_evaluation_run")?.args.mode, "retrieval");

  const root = mkdtempSync(join(tmpdir(), "craft-adjudication-shadow-retry-clear-")), cursorFile = join(root, "knowledge", "cursor.json");
  try {
    const scoped = fixture({ cases: [{ ...caseRecord, label_source: "host_adjudicated", adjudication_id: "a", adjudication_created_at: "now" }] });
    await writeKnowledgeAdjudicationCursor(cursorFile, null);
    const result = await runSessionKnowledgeAdjudicationOnce({ client: scoped.client, knowledge_adjudication_cursor_file: cursorFile });
    assert.equal(result.status, "shadow_evaluation_created");
    assert.deepEqual(readKnowledgeAdjudicationRetries(cursorFile), {});
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("retrieval adjudication uses original labels and rejected decisions do not create a run", async () => {
  const retrievalCase = { ...caseRecord, candidate_claim_refs: undefined };
  const retrieval = fixture({ cases: [retrievalCase] });
  const retrievalResult = await runSessionKnowledgeAdjudicationOnce({ client: retrieval.client, transport: retrieval.transport, providers: [provider] });
  assert.equal(retrievalResult.status, "adjudicated");
  assert.equal(retrieval.calls.find(call => call.name === "craft_knowledge_evaluation_run")?.args.mode, "retrieval");

  const correctedCase = { ...caseRecord, expected_claim_ids: ["incorrect-label"], candidate_claim_refs: [
    ...(caseRecord.candidate_claim_refs as JsonObject[]), { claim_id: "candidate-2", claim_version: 1, identity_digest: "second-identity", content_digest: "second-content" }] };
  const corrected = fixture({ cases: [correctedCase], packetByClaim: { "candidate-2": { id: "candidate-2", version: 1, identity_digest: "second-identity",
    content_digest: "second-content", content: "另一个事实", title: null, tags: null } },
    response: JSON.stringify({ decision: "corrected", expected_claim_ids: ["candidate-2"] }) });
  const correctedResult = await runSessionKnowledgeAdjudicationOnce({ client: corrected.client, transport: corrected.transport, providers: [provider] });
  assert.equal(correctedResult.status, "adjudicated");
  assert.equal(corrected.calls.find(call => call.name === "craft_knowledge_evaluation_run")?.args.mode, "candidate_shadow");

  for (const decision of ["rejected", "uncertain"]) {
    const f = fixture({ response: JSON.stringify({ decision, expected_claim_ids: [] }) });
    const result = await runSessionKnowledgeAdjudicationOnce({ client: f.client, transport: f.transport, providers: [provider] });
    assert.equal(result.status, decision);
    assert.equal(f.calls.some(call => call.name === "craft_knowledge_evaluation_run"), false);
  }
});

test("unavailable claims, Evidence, model profile, provider and call budget fail closed", async () => {
  const missingClaims = fixture({ packetResult: { status: "missing" } });
  assert.equal((await runSessionKnowledgeAdjudicationOnce({ client: missingClaims.client })).status, "waiting_for_current_claims");
  const staleClaim = fixture({ packetResult: { status: "ready", claim_status: "candidate", packet: { claim: { id: "candidate-1", version: 99, content: "stale" } } } });
  assert.equal((await runSessionKnowledgeAdjudicationOnce({ client: staleClaim.client })).status, "waiting_for_current_candidates");
  const missingEvidence = fixture({ cases: [{ ...caseRecord, source_evidence_ids: [] }] });
  assert.equal((await runSessionKnowledgeAdjudicationOnce({ client: missingEvidence.client })).status, "waiting_for_verified_evidence");
  const profileMissing = fixture({ profileResult: { status: "unavailable" } });
  assert.equal((await runSessionKnowledgeAdjudicationOnce({ client: profileMissing.client })).status, "waiting_for_model");
  const profileNotReady = fixture({ profileDetail: { readiness: { status: "missing" } } });
  assert.equal((await runSessionKnowledgeAdjudicationOnce({ client: profileNotReady.client })).reason, "model_profile_not_ready");
  const noProvider = fixture({ profile: { id: "p", provider: "unknown", model: "m" } });
  assert.equal((await runSessionKnowledgeAdjudicationOnce({ client: noProvider.client, providers: [] })).reason, "provider_unavailable");
  const noTransport = fixture();
  assert.equal((await runSessionKnowledgeAdjudicationOnce({ client: noTransport.client, providers: [provider] })).status, "adjudicated");
  const missingReason = fixture({ profileResult: {} });
  assert.equal((await runSessionKnowledgeAdjudicationOnce({ client: missingReason.client })).reason, "model_profile_unavailable");
  const providerFallback = fixture({ profile: { id: "p", provider: "dynamic", model: "m" }, provider: provider as unknown as JsonObject });
  assert.equal((await runSessionKnowledgeAdjudicationOnce({ client: providerFallback.client, providers: [], transport: providerFallback.transport })).reason, "codex_host_required");
  const catalogProvider = fixture();
  assert.equal((await runSessionKnowledgeAdjudicationOnce({ client: catalogProvider.client, transport: catalogProvider.transport })).status, "adjudicated");
  const missingBudgetHook = fixture();
  const noBudgetTransport: ModelTransport = { async complete() { return { text: JSON.stringify({ decision: "accepted", expected_claim_ids: ["candidate-1"] }), model: "gpt-6-luna", usage: null }; } };
  assert.equal((await runSessionKnowledgeAdjudicationOnce({ client: missingBudgetHook.client, providers: [provider], transport: noBudgetTransport })).status, "adjudicated");
});

test("Host output must use allowed labels and valid decisions before persisting", async () => {
  for (const response of ["[]", JSON.stringify({ decision: "accepted" }), JSON.stringify({ decision: "unsupported", expected_claim_ids: [] }),
    JSON.stringify({ decision: "accepted", expected_claim_ids: ["other"] }), JSON.stringify({ decision: "uncertain", expected_claim_ids: ["candidate-1"] })]) {
    const f = fixture({ response });
    await assert.rejects(runSessionKnowledgeAdjudicationOnce({ client: f.client, transport: f.transport, providers: [provider] }));
    assert.equal(f.calls.some(call => call.name === "craft_knowledge_evaluation_case_adjudicate"), true);
  }
});

test("malformed Host output is retained only as a failed Trace and never adjudicated", async () => {
  const f = fixture({ response: "not JSON" });
  await assert.rejects(runSessionKnowledgeAdjudicationOnce({ client: f.client, transport: f.transport, providers: [provider] }), /one JSON object/u);
  assert.equal(f.calls.some(call => call.name === "craft_knowledge_evaluation_case_adjudicate"), true);
  assert.equal(f.calls.some(call => call.name.startsWith("craft_trace_")), false);
  for (const options of [{ throwOn: "transport.complete", throwRaw: true }, { throwOn: "transport.complete", throwName: "Bad Host Error" }]) {
    const failed = fixture(options);
    await assert.rejects(runSessionKnowledgeAdjudicationOnce({ client: failed.client, providers: [provider], transport: failed.transport }));
  }
  const listFallback = fixture({ cases: [{ ...caseRecord, source_evidence_ids: undefined }] });
  assert.equal((await runSessionKnowledgeAdjudicationOnce({ client: listFallback.client, transport: listFallback.transport, providers: [provider] })).status, "waiting_for_verified_evidence");
  const malformedMetadata = fixture({ evidence: { id: "held-evidence", confidence: "confirmed", metadata: [] } });
  assert.equal((await runSessionKnowledgeAdjudicationOnce({ client: malformedMetadata.client })).status, "waiting_for_verified_evidence");
  const missingMetadata = fixture({ evidence: { id: "held-evidence", confidence: "confirmed", metadata: null } });
  assert.equal((await runSessionKnowledgeAdjudicationOnce({ client: missingMetadata.client })).status, "waiting_for_verified_evidence");
  const nonTextClaim = fixture({ evidence: { id: "held-evidence", source_type: "program", confidence: "confirmed", claim: 42,
    metadata: { source_session_id: "held-session", task_id: "held-task" } } });
  assert.equal((await runSessionKnowledgeAdjudicationOnce({ client: nonTextClaim.client, providers: [provider], transport: nonTextClaim.transport })).status, "adjudicated");
  for (const case_ of [{ id: "held-case", updated_at: "case-updated" }, { id: "held-case", created_at: "case-created" }]) {
    const fallbackDate = fixture({ adjudicationResult: { case: case_, adjudication: { id: "a", decision: "accepted" } } });
    assert.equal((await runSessionKnowledgeAdjudicationOnce({ client: fallbackDate.client, providers: [provider], transport: fallbackDate.transport })).status, "adjudicated");
  }
});

test("retry cursor keeps only a validated structured MCP error code", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-knowledge-adjudication-code-"));
  const cursor = join(root, "knowledge", "cursor.json");
  try {
    const f = fixture({ throwOn: "craft_knowledge_evaluation_case_adjudicate", throwCode: "ERR_MCP_INTERNAL_ERROR" });
    await assert.rejects(runSessionKnowledgeAdjudicationOnce({ client: f.client, transport: f.transport, providers: [provider],
      knowledge_adjudication_cursor_file: cursor }));
    const saved = readKnowledgeAdjudicationRetries(cursor)["held-case"];
    assert.equal(saved?.failure_kind, "TypeError");
    assert.equal(saved?.failure_code, "ERR_MCP_INTERNAL_ERROR");
    assert.equal(readFileSync(cursor, "utf8").includes("controlled failure"), false);

    const unsafe = fixture({ throwOn: "craft_knowledge_evaluation_case_adjudicate", throwCode: "private/path" });
    await assert.rejects(runSessionKnowledgeAdjudicationOnce({ client: unsafe.client, transport: unsafe.transport, providers: [provider],
      knowledge_adjudication_cursor_file: join(root, "knowledge", "unsafe.json") }));
    assert.equal(readKnowledgeAdjudicationRetries(join(root, "knowledge", "unsafe.json"))["held-case"]?.failure_code, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("adjudication accepts a direct Evidence response shape", async () => {
  const f = fixture({ evidenceDirect: true });
  const result = await runSessionKnowledgeAdjudicationOnce({ client: f.client, transport: f.transport, providers: [provider] });
  assert.equal(result.status, "adjudicated");
});

test("malformed MCP replies and raw failures retain safe retry state", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-adjudication-safe-failure-"));
  try {
    const malformed = fixture({ adjudicationResult: { case: null, adjudication: {} } });
    await assert.rejects(runSessionKnowledgeAdjudicationOnce({ client: malformed.client }), /adjudicated Knowledge case must be an object/u);
    for (const options of [{ throwOn: "transport.complete", throwRaw: true },
      { throwOn: "transport.complete", throwName: "Bad Host Error" }]) {
      const cursor = join(root, `cursor-${options.throwRaw ? "raw" : "named"}.json`);
      const failed = fixture(options);
      await assert.rejects(runSessionKnowledgeAdjudicationOnce({ client: failed.client,
        knowledge_adjudication_cursor_file: cursor }, "2026-10-23T00:00:00.000Z"));
      assert.equal(readKnowledgeAdjudicationRetries(cursor)["held-case"]?.failure_kind, "Error");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("test-only held-out evidence waits without asking the model and remains pending", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-adjudication-evidence-"));
  try {
    const f = fixture({ evidence: { id: "held-evidence", source_type: "program", confidence: "confirmed", claim: "测试通过",
      metadata: { source_session_id: "held-session", task_id: "held-task", provenance: "codex_session_program_verification" } } });
    const cursor = join(root, "knowledge", "cursor.json");
    const result = await runSessionKnowledgeAdjudicationOnce({ client: f.client, providers: [provider], transport: f.transport,
      knowledge_adjudication_cursor_file: cursor });
    assert.equal(result.status, "waiting_for_outcome_evidence");
    assert.equal(result.model_calls, 0);
    assert.equal(readKnowledgeAdjudicationCursor(cursor), "held-case");
    assert.equal(f.calls.some(call => call.name === "craft_knowledge_evaluation_case_adjudicate"), false);
    assert.equal(f.calls.some(call => call.name === "craft_evaluation_model_profile_ensure_single"), false);
    assert.deepEqual(readKnowledgeAdjudicationRetries(cursor), {});
  } finally { rmSync(root, { recursive: true, force: true }); }
});
