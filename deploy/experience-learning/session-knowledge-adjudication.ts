import { stableDigest } from "../../core/digest.ts";
import { defineProvider, PROVIDER_CATALOG, type ModelProviderSpec } from "../../core/model-gateway.ts";
import type { JsonObject } from "../../core/infrastructure/store.ts";
import { clearKnowledgeAdjudicationFailure, readKnowledgeAdjudicationCursor, readKnowledgeAdjudicationRetries,
  recordKnowledgeAdjudicationFailure, writeKnowledgeAdjudicationCursor } from "./session-knowledge-adjudication-state.ts";
import type { DistillationDependencies } from "./worker.ts";

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}
function safeFailureKind(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  return /^[A-Za-z][A-Za-z0-9]{0,31}$/u.test(name) ? name : "Error";
}
function safeFailureCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : undefined;
}
function providerFor(profile: JsonObject, detail: JsonObject, providers: readonly ModelProviderSpec[]): ModelProviderSpec | undefined {
  return providers.find(item => item.provider === profile.provider)
    ?? (detail.provider ? defineProvider(object(detail.provider, "Knowledge adjudication provider")) : undefined);
}
function runRefs(run: JsonObject): string[] {
  return Array.isArray(run.case_ids) ? run.case_ids.filter((item): item is string => typeof item === "string") : [];
}

/** Adjudicate one pending held-out case, or finish a previously adjudicated shadow run without another model call. */
export async function runSessionKnowledgeAdjudicationOnce(deps: DistillationDependencies, now = new Date().toISOString()): Promise<JsonObject> {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("Knowledge adjudication now must be an ISO timestamp");
  const afterId = deps.knowledge_adjudication_cursor_file ? readKnowledgeAdjudicationCursor(deps.knowledge_adjudication_cursor_file) : undefined;
  const retries = deps.knowledge_adjudication_cursor_file ? readKnowledgeAdjudicationRetries(deps.knowledge_adjudication_cursor_file) : {};
  const caseResult = await deps.client.call("craft_knowledge_evaluation_case_list", { limit: 1_000,
    ...(deps.knowledge_adjudication_cursor_file ? { after_id: afterId ?? "" } : {}) });
  const cases = Array.isArray(caseResult.cases) ? caseResult.cases as JsonObject[] : [];
  if (deps.knowledge_adjudication_cursor_file && (!Array.isArray(caseResult.cases) || cases.length > 1_000)) {
    throw new Error("Knowledge evaluation case page is invalid");
  }
  const runResult = await deps.client.call("craft_knowledge_evaluation_run_list", { limit: 1_000 });
  const runs = Array.isArray(runResult.runs) ? runResult.runs as JsonObject[] : [];
  const pending = cases.filter(item => item.dataset_partition === "held_out" && item.evaluation_channel === "real_session"
    && (Array.isArray(item.candidate_claim_refs) && item.candidate_claim_refs.length > 0
      || Array.isArray(item.expected_claim_ids) && item.expected_claim_ids.length > 0)
    && (item.label_source === "model_candidate" && !item.adjudication_id
      || item.label_source === "host_adjudicated" && !runs.some(run => run.mode === (Array.isArray(item.candidate_claim_refs) && item.candidate_claim_refs.length > 0 ? "candidate_shadow" : "retrieval")
        && runRefs(run).includes(String(item.id)))));
  const eligible = pending.filter(item => Date.parse(String(retries[String(item.id)]?.next_attempt_at ?? "1970-01-01T00:00:00.000Z")) <= nowMs);
  const pendingDates = pending.map(item => Date.parse(String(item.created_at ?? ""))).filter(Number.isFinite).sort((a, b) => a - b);
  const retryDates = pending.map(item => Date.parse(String(retries[String(item.id)]?.next_attempt_at ?? ""))).filter(value => Number.isFinite(value) && value > nowMs).sort((a, b) => a - b);
  const queueMetrics: JsonObject = { page_pending_count: pending.length, page_ready_count: eligible.length,
    page_deferred_count: pending.length - eligible.length, page_oldest_pending_at: pendingDates.length ? new Date(pendingDates[0]!).toISOString() : null,
    page_oldest_pending_age_ms: pendingDates.length ? Math.max(0, nowMs - pendingDates[0]!) : 0,
    page_next_retry_at: retryDates.length ? new Date(retryDates[0]!).toISOString() : null };
  const withMetrics = (result: JsonObject): JsonObject => deps.knowledge_adjudication_cursor_file
    ? { ...result, queue_metrics: queueMetrics } : result;
  let current: JsonObject | undefined;
  if (deps.knowledge_adjudication_cursor_file) {
    const hasMore = caseResult.has_more;
    const nextCursor = caseResult.next_cursor;
    if (typeof hasMore !== "boolean" || nextCursor !== null && (typeof nextCursor !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/u.test(nextCursor))
      || !hasMore && nextCursor !== null
      || hasMore && (!nextCursor || nextCursor === afterId)) throw new Error("Knowledge evaluation case page is invalid");
    current = eligible[0];
    await writeKnowledgeAdjudicationCursor(deps.knowledge_adjudication_cursor_file, current ? String(current.id) : hasMore ? String(nextCursor) : null);
  } else {
    current = eligible.sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""))
      || String(a.id).localeCompare(String(b.id)))[0];
  }
  if (!current) return withMetrics({ status: pending.length ? "waiting_for_retry" : "idle", processed: 0, model_calls: 0, raw_content_stored: false });

  if (current.label_source === "host_adjudicated") {
    const adjudicationId = String(current.adjudication_id ?? "");
    const exactCandidateRefs = Array.isArray(current.candidate_claim_refs) ? current.candidate_claim_refs as JsonObject[] : [];
    const mode = exactCandidateRefs.length ? "candidate_shadow" : "retrieval";
    const shadow = await deps.client.call("craft_knowledge_evaluation_run", { run_id: `knowledge_run_${stableDigest({ case_id: current.id, adjudication_id: adjudicationId }).slice(-24)}`,
      mode, case_ids: [String(current.id)], ...(exactCandidateRefs.length ? { candidate_claim_ids: exactCandidateRefs.map(ref => String(ref.claim_id)) } : {}),
      top_k: 10, now: String(current.adjudication_created_at ?? current.updated_at ?? current.created_at) });
    const run = object(shadow.run, "Knowledge candidate-shadow run");
    if (deps.knowledge_adjudication_cursor_file) await clearKnowledgeAdjudicationFailure(deps.knowledge_adjudication_cursor_file, String(current.id));
    return withMetrics({ status: "shadow_evaluation_created", processed: 1, model_calls: 0, case_id: current.id, run_id: run.id,
      run_status: run.status, evaluation_eligible: (run.metrics as JsonObject | undefined)?.provenance_eligible === true, raw_content_stored: false });
  }

  const claimRefs: JsonObject[] = Array.isArray(current.candidate_claim_refs) && current.candidate_claim_refs.length > 0
    ? current.candidate_claim_refs as JsonObject[]
    : (current.expected_claim_ids as string[]).map(claim_id => ({ claim_id }));
  const claimsAreVersionBound = Array.isArray(current.candidate_claim_refs) && current.candidate_claim_refs.length > 0;
  const claims: JsonObject[] = [];
  for (const ref of claimRefs) {
    const packetResult = await deps.client.call("craft_knowledge_semantic_review_packet", { claim_id: ref.claim_id });
    if (packetResult.status !== "ready" || !["candidate", "reviewed"].includes(String(packetResult.claim_status))) return withMetrics({ status: "waiting_for_current_claims", processed: 0, model_calls: 0, raw_content_stored: false });
    const packet = object(packetResult.packet, "Knowledge Claim packet"), claim = object(packet.claim, "Knowledge Claim");
    if (claim.id !== ref.claim_id || claimsAreVersionBound && (claim.version !== ref.claim_version
      || claim.content_digest !== ref.content_digest) || typeof claim.content !== "string" || !claim.content.trim()) {
      return withMetrics({ status: "waiting_for_current_candidates", processed: 0, model_calls: 0, raw_content_stored: false });
    }
    claims.push({ claim_id: claim.id, claim_version: claim.version, title: claim.title ?? "", content: claim.content, tags: claim.tags ?? [] });
  }
  const evidence: JsonObject[] = [];
  for (const evidenceId of Array.isArray(current.source_evidence_ids) ? current.source_evidence_ids as string[] : []) {
    const result = await deps.client.call("craft_evidence_get", { evidence_id: evidenceId });
    const item = object(result.evidence ?? result, "held-out Evidence");
    const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata as JsonObject : {};
    if (item.id !== evidenceId || !["confirmed", "program"].includes(String(item.confidence))
      || metadata.source_session_id !== current.source_session_id || metadata.task_id !== current.source_task_id) {
      return withMetrics({ status: "waiting_for_verified_evidence", processed: 0, model_calls: 0, raw_content_stored: false });
    }
    if (metadata.provenance === "codex_session_program_verification")
      return withMetrics({ status: "waiting_for_outcome_evidence", processed: 0, model_calls: 0, raw_content_stored: false });
    evidence.push({ evidence_id: item.id, source_type: item.source_type, confidence: item.confidence,
      claim: typeof item.claim === "string" ? item.claim : "", source_session_id: metadata.source_session_id, task_id: metadata.task_id });
  }
  if (!evidence.length) return withMetrics({ status: "waiting_for_verified_evidence", processed: 0, model_calls: 0, raw_content_stored: false });
  const profileResult = await deps.client.call("craft_evaluation_model_profile_ensure_single", { purpose: "knowledge_scenario_classification" });
  if (profileResult.status !== "ready_for_adapter" || !profileResult.profile) return withMetrics({ status: "waiting_for_model", processed: 0, model_calls: 0,
    reason: String(profileResult.reason ?? profileResult.status ?? "model_profile_unavailable"), raw_content_stored: false });
  const profile = object(profileResult.profile, "Knowledge adjudication profile");
  const detail = object(await deps.client.call("craft_evaluation_model_profile_get", { profile_id: profile.id, version: profile.version }), "Knowledge adjudication profile detail");
  if (object(detail.readiness, "Knowledge adjudication profile readiness").status !== "ready_for_adapter") return withMetrics({ status: "waiting_for_model", processed: 0,
    model_calls: 0, reason: "model_profile_not_ready", raw_content_stored: false });
  const provider = providerFor(profile, detail, deps.providers ?? PROVIDER_CATALOG);
  if (!provider) return withMetrics({ status: "waiting_for_model", processed: 0, model_calls: 0, reason: "provider_unavailable", raw_content_stored: false });
  if (provider.provider !== "codex-cli" || profile.model !== "gpt-6-luna") return withMetrics({ status: "waiting_for_model", processed: 0,
    model_calls: 0, reason: "codex_host_required", raw_content_stored: false });
  // The MCP service owns the Codex process and Trace. Worker inputs are only an
  // optimistic case version; server-side reads and validation are authoritative.
  try {
    const persisted = object(await deps.client.call("craft_knowledge_evaluation_case_adjudicate", {
      case_id: String(current.id), expected_version: current.version }), "Knowledge adjudication persistence");
    const case_ = object(persisted.case, "adjudicated Knowledge case");
    const adjudication = object(persisted.adjudication, "Knowledge adjudication record");
    const decision = String(adjudication.decision);
    if (deps.knowledge_adjudication_cursor_file) await clearKnowledgeAdjudicationFailure(deps.knowledge_adjudication_cursor_file, String(current.id));
    if (decision === "accepted" || decision === "corrected") {
      const mode = claimsAreVersionBound ? "candidate_shadow" : "retrieval";
      const run = object(await deps.client.call("craft_knowledge_evaluation_run", { run_id: `knowledge_run_${stableDigest({ case_id: case_.id, adjudication_id: adjudication.id }).slice(-24)}`,
        mode, case_ids: [String(case_.id)], ...(claimsAreVersionBound ? { candidate_claim_ids: claimRefs.map(ref => String(ref.claim_id)) } : {}), top_k: 10,
        now: String(adjudication.created_at ?? case_.updated_at ?? case_.created_at) }), "Knowledge candidate-shadow run").run as JsonObject;
      return withMetrics({ status: "adjudicated", processed: 1, model_calls: Number(persisted.model_calls ?? 1), case_id: case_.id, trace_id: persisted.trace_id,
        adjudication_id: adjudication.id, decision, evaluation_run_id: run.id, evaluation_status: run.status,
        evaluation_eligible: (run.metrics as JsonObject | undefined)?.provenance_eligible === true, raw_content_stored: false });
    }
    return withMetrics({ status: decision, processed: 1, model_calls: Number(persisted.model_calls ?? 1), case_id: case_.id, trace_id: persisted.trace_id,
      adjudication_id: adjudication.id, raw_content_stored: false });
  } catch (error) {
    if (deps.knowledge_adjudication_cursor_file) await recordKnowledgeAdjudicationFailure(
      deps.knowledge_adjudication_cursor_file, String(current.id), safeFailureKind(error), now, safeFailureCode(error));
    throw error;
  }
}
