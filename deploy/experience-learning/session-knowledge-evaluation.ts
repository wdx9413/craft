import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicPrivateJson, craftPaths, dataRoot } from "../../common/craft-common-store-local/src/paths.ts";
import { stableDigest } from "../../core/digest.ts";
import { CRAFT_RELEASE_VERSION } from "../../core/version.ts";
import { buildChatRequest, defineProvider, PROVIDER_CATALOG, type ChatMessage, type ModelProviderSpec, type ModelTransport } from "../../core/model-gateway.ts";
import { generatedTextLanguageInstruction } from "../../core/config.ts";
import type { JsonObject } from "../../core/infrastructure/store.ts";
import { codexSessionTaskBatch, readCodexSessionTaskExcerpt, requestCodexSessionSourceRecheck, type CodexSessionCollectionOptions } from "../../core/codex-session-archive.ts";
import { redactKnowledgeModelText } from "./knowledge-classification.ts";
import type { ExperienceLearningClient } from "./worker.ts";
import { recordSessionVerificationEvidence } from "./session-verification-evidence.ts";

const SCHEMA = "craft.knowledge-session-evaluation-state.v1";
const OUTPUT_SCHEMA = { type: "object", properties: {
  decision: { type: "string", enum: ["labeled", "skip"] },
  expected_claim_ids: { type: "array", items: { type: "string", minLength: 1, maxLength: 160 }, maxItems: 8 },
}, required: ["decision", "expected_claim_ids"], additionalProperties: false };
const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{8,}/iu;
interface EvaluationState { processed_task_ids: string[]; trace_ids_by_task: Record<string, string>; last_attempted_task_id?: string; legacy_unknown_outcomes?: number; legacy_untraced_tasks?: number;
  uncertain_calls: Record<string, { trace_id: string; input_digest: string }> }
export interface SessionKnowledgeEvaluationDependencies {
  client: ExperienceLearningClient;
  providers?: readonly ModelProviderSpec[];
  transport?: ModelTransport;
  contentLanguage?: string;
  state_file?: string;
  archive_options?: CodexSessionCollectionOptions;
  read_excerpt?: typeof readCodexSessionTaskExcerpt;
  env?: NodeJS.ProcessEnv;
}

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}
function evaluationStatePath(deps: SessionKnowledgeEvaluationDependencies): string {
  return resolve(deps.state_file ?? join(craftPaths(dataRoot(deps.env)).knowledgeDir, "session-evaluation-state.json"));
}
function readState(path: string): EvaluationState {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error("Knowledge evaluation state file is invalid");
    const value = JSON.parse(readFileSync(path, "utf8")) as JsonObject;
    const traces = value.trace_ids_by_task === undefined ? {} : value.trace_ids_by_task;
    const uncertain = value.uncertain_calls === undefined ? {} : value.uncertain_calls;
    if (value.schema !== SCHEMA || !Array.isArray(value.processed_task_ids) || value.processed_task_ids.length > 50_000
      || value.processed_task_ids.some(id => typeof id !== "string" || !id.trim() || id.length > 160)
      || value.last_attempted_task_id !== undefined && (typeof value.last_attempted_task_id !== "string" || !value.last_attempted_task_id.trim() || value.last_attempted_task_id.length > 160)
      || value.legacy_unknown_outcomes !== undefined && (!Number.isSafeInteger(value.legacy_unknown_outcomes) || Number(value.legacy_unknown_outcomes) < 0 || Number(value.legacy_unknown_outcomes) > 50_000)
      || value.legacy_untraced_tasks !== undefined && (!Number.isSafeInteger(value.legacy_untraced_tasks) || Number(value.legacy_untraced_tasks) < 0 || Number(value.legacy_untraced_tasks) > 50_000)
      || !traces || typeof traces !== "object" || Array.isArray(traces) || Object.keys(traces).length > 50_000
      || !uncertain || typeof uncertain !== "object" || Array.isArray(uncertain) || Object.keys(uncertain).length > 50_000
      || Object.entries(uncertain as Record<string, unknown>).some(([id, raw]) => {
        const item = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as JsonObject : null;
        return !id.trim() || id.length > 160 || !item || typeof item.trace_id !== "string"
          || !/^trace[-_][A-Za-z0-9_-]{1,160}$/u.test(item.trace_id) || typeof item.input_digest !== "string"
          || !/^sha256:[a-f0-9]{64}$/u.test(item.input_digest);
      })
      || Object.entries(traces as Record<string, unknown>).some(([taskId, traceId]) => !taskId.trim() || taskId.length > 160
        || typeof traceId !== "string" || !/^trace[-_][A-Za-z0-9_-]{1,160}$/u.test(traceId))) throw new Error("Knowledge evaluation state is invalid");
    return { processed_task_ids: [...new Set(value.processed_task_ids as string[])], trace_ids_by_task: traces as Record<string, string>, last_attempted_task_id: value.last_attempted_task_id as string | undefined,
      legacy_unknown_outcomes: value.legacy_unknown_outcomes as number | undefined, legacy_untraced_tasks: value.legacy_untraced_tasks as number | undefined, uncertain_calls: uncertain as EvaluationState["uncertain_calls"] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { processed_task_ids: [], trace_ids_by_task: {}, uncertain_calls: {} };
    throw error;
  }
}
async function writeState(path: string, state: EvaluationState): Promise<void> {
  try { if (lstatSync(dirname(path)).isSymbolicLink()) throw new Error("Knowledge evaluation state directory must not be a symbolic link"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await atomicPrivateJson(path, { schema: SCHEMA, processed_task_ids: state.processed_task_ids.slice(-50_000),
    trace_ids_by_task: Object.fromEntries(Object.entries(state.trace_ids_by_task).slice(-50_000)),
    last_attempted_task_id: state.last_attempted_task_id, legacy_unknown_outcomes: state.legacy_unknown_outcomes, legacy_untraced_tasks: state.legacy_untraced_tasks,
    uncertain_calls: state.uncertain_calls, updated_at: new Date().toISOString() });
}
function parseOutput(value: string): JsonObject {
  let parsed: unknown;
  try { parsed = JSON.parse(value.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "")); }
  catch { throw new Error("Knowledge evaluation labeler must return one JSON object"); }
  return object(parsed, "Knowledge evaluation label");
}
function safeFailureKind(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  return /^[A-Za-z][A-Za-z0-9]{0,31}$/u.test(name) ? name : "Error";
}

/** Recover only a completed, exactly bound evaluation output. */
async function completedEvaluation(client: ExperienceLearningClient, task: JsonObject, call: { trace_id: string; input_digest: string }): Promise<"skip" | "case" | null> {
  try {
    const taskId = String(task.task_id);
    const result = await client.call("craft_trace_get", { trace_id: call.trace_id });
    const trace = object(result.trace, "evaluation Trace"), events = result.events;
    if (trace.id !== call.trace_id || trace.task_id !== `knowledge:${taskId}` || trace.operation_id !== taskId
      || trace.status !== "completed" || !Array.isArray(events)) return null;
    const matching = (kind: string) => events.filter(event => event && typeof event === "object" && !Array.isArray(event)
      && event.trace_id === call.trace_id && event.operation_id === taskId && event.event_kind === kind
      && event.actor === "knowledge-session-evaluation-worker");
    const request = matching("model.request"), completed = matching("model.completed"), output = matching("knowledge.evaluation_case_candidate");
    if (request.length !== 1 || completed.length !== 1 || output.length !== 1) return null;
    if (request[0].data_digest !== stableDigest({ purpose: "knowledge_held_out_label", input_digest: call.input_digest, source_ref: task.source_ref, content_stored: false })
      || !Array.isArray(request[0].input_refs) || request[0].input_refs.length !== 1 || request[0].input_refs[0] !== call.input_digest
      || !Array.isArray(output[0].output_refs) || !Number.isSafeInteger(request[0].sequence) || !Number.isSafeInteger(completed[0].sequence)
      || !Number.isSafeInteger(output[0].sequence) || request[0].sequence >= completed[0].sequence || completed[0].sequence >= output[0].sequence) return null;
    const refs = output[0].output_refs as unknown[];
    if (!refs.length) return "skip";
    const [caseId, evidenceId, runId, binding] = refs;
    if (refs.length !== 4 || typeof caseId !== "string" || !/^knowledge_case_[a-f0-9]{24}$/u.test(caseId)
      || typeof evidenceId !== "string" || typeof runId !== "string" || typeof binding !== "string") return null;
    const listed = await client.call("craft_knowledge_evaluation_case_list", { after_id: caseId.slice(0, -1), limit: 1000 });
    const cases = Array.isArray(listed.cases) ? listed.cases as JsonObject[] : [];
    const item = cases.find(entry => entry.id === caseId);
    const run = object((await client.call("craft_knowledge_evaluation_run_get", { run_id: runId })).run, "evaluation run");
    if (!item || item.scope !== task.project_scope_id || item.source_session_id !== task.session_id || item.source_task_id !== taskId
      || item.label_source !== "model_candidate" || item.dataset_partition !== "held_out" || !Array.isArray(item.source_evidence_ids)
      || !item.source_evidence_ids.includes(evidenceId) || !Number.isSafeInteger(item.version) || typeof item.identity_digest !== "string"
      || run.id !== runId || run.mode !== "candidate_shadow" || !Number.isSafeInteger(run.version) || typeof run.identity_digest !== "string"
      || !Array.isArray(run.case_refs) || run.case_refs.length !== 1 || (run.case_refs[0] as JsonObject).case_id !== caseId
      || (run.case_refs[0] as JsonObject).case_version !== item.version || (run.case_refs[0] as JsonObject).identity_digest !== item.identity_digest
      || stableDigest(run.candidate_claim_refs) !== stableDigest(item.candidate_claim_refs)) return null;
    const resultEvidence = await client.call("craft_evidence_get", { evidence_id: evidenceId });
    const evidence = object(resultEvidence.evidence ?? resultEvidence, "evaluation Evidence"), metadata = evidence.metadata as JsonObject | undefined;
    if (evidence.id !== evidenceId || metadata?.provenance !== "codex_session_program_verification"
      || metadata.scope !== task.project_scope_id || metadata.source_session_id !== task.session_id || metadata.task_id !== taskId
      || metadata.turn_id !== task.turn_id) return null;
    return binding === stableDigest({ case_id: caseId, case_version: item.version, case_identity: item.identity_digest,
      run_id: runId, run_version: run.version, run_identity: run.identity_digest, evidence_id: evidenceId }) ? "case" : null;
  } catch { return null; }
}

/** Create at most one model-labeled, held-out candidate-shadow case; provenance gates still decide eligibility. */
export async function runSessionKnowledgeEvaluationOnce(deps: SessionKnowledgeEvaluationDependencies): Promise<JsonObject> {
  const path = evaluationStatePath(deps), state = readState(path);
  const batch = await codexSessionTaskBatch("held_out", deps.archive_options, deps.env);
  const processed = new Set(state.processed_task_ids);
  const legacyUnknown = (batch.tasks as JsonObject[]).filter(item => typeof item.task_id === "string"
    && processed.has(item.task_id) && item.verification_outcome === null).length;
  const legacyUntraced = state.processed_task_ids.filter(id => !state.trace_ids_by_task[id] && !state.uncertain_calls[id]).length;
  const diagnosticChanged = (state.legacy_unknown_outcomes ?? 0) !== legacyUnknown || (state.legacy_untraced_tasks ?? 0) !== legacyUntraced;
  if (diagnosticChanged) state.legacy_unknown_outcomes = legacyUnknown;
  if (diagnosticChanged) state.legacy_untraced_tasks = legacyUntraced;
  const pending = (batch.tasks as JsonObject[]).filter(item => typeof item.task_id === "string" && !processed.has(item.task_id));
  const previous = pending.findIndex(item => item.task_id === state.last_attempted_task_id);
  const task = pending[(previous + 1) % pending.length];
  if (!task) {
    if (diagnosticChanged) await writeState(path, state);
    return legacyUnknown ? { status: "waiting_for_legacy_outcome_evidence", processed: 0,
      legacy_unknown_outcomes: legacyUnknown, ...(legacyUntraced ? { legacy_untraced_tasks: legacyUntraced } : {}), raw_content_stored: false }
      : legacyUntraced ? { status: "waiting_for_legacy_trace_reconciliation", processed: 0, legacy_untraced_tasks: legacyUntraced, raw_content_stored: false }
      : Number(batch.excluded_source_recheck_pending) > 0 ? { status: "waiting_for_source_recheck", processed: 0, source_recheck_pending: batch.excluded_source_recheck_pending, raw_content_stored: false }
      : { status: "idle", processed: 0, raw_content_stored: false };
  }
  // Advance before waiting or calling the model. An unavailable project must not
  // starve later tasks, and pending tasks must remain eligible for a future retry.
  if (diagnosticChanged || state.last_attempted_task_id !== task.task_id) {
    state.last_attempted_task_id = String(task.task_id); await writeState(path, state);
  }
  if (state.uncertain_calls[String(task.task_id)]) {
    const taskId = String(task.task_id), call = state.uncertain_calls[taskId]!;
    const decision = await completedEvaluation(deps.client, task, call);
    if (decision) {
      let current: JsonObject;
      try { current = await (deps.read_excerpt ?? readCodexSessionTaskExcerpt)(taskId, { ...deps.archive_options, expected_partition: "held_out" }, deps.env); }
      catch { return { status: "waiting_for_source_revalidation", processed: 0, reason: "archive_unavailable", raw_content_stored: false }; }
      if (current.status !== "ready" || current.source_ref !== task.source_ref || current.session_id !== task.session_id
        || current.turn_id !== task.turn_id || current.project_scope_id !== task.project_scope_id
        || (current.verification_outcome ?? null) !== (task.verification_outcome ?? null)
        || JSON.stringify(current.evidence_ids) !== JSON.stringify(task.verification_evidence_ids)) {
        return { status: "waiting_for_source_revalidation", processed: 0, reason: "archive_changed", raw_content_stored: false };
      }
      state.processed_task_ids.push(taskId); state.trace_ids_by_task[taskId] = call.trace_id;
      delete state.uncertain_calls[taskId]; await writeState(path, state);
      return { status: "completed_call_reconciled", processed: 1, decision, trace_id: call.trace_id, raw_content_stored: false };
    }
    return { status: "waiting_for_call_reconciliation", processed: 0, reason: "model_result_unknown", raw_content_stored: false };
  }
  if (typeof task.project_scope_id !== "string" || !/^project:[A-Za-z0-9_-]{1,96}$/u.test(task.project_scope_id)) {
    state.processed_task_ids.push(String(task.task_id)); await writeState(path, state);
    return { status: "skipped", processed: 1, reason: "held_out_provenance_incomplete", raw_content_stored: false };
  }
  const excerpt = await (deps.read_excerpt ?? readCodexSessionTaskExcerpt)(task.task_id, { ...deps.archive_options, expected_partition: "held_out" }, deps.env);
  const evidenceIds = Array.isArray(excerpt.evidence_ids) ? excerpt.evidence_ids : [];
  if (excerpt.status !== "ready" || excerpt.session_id !== task.session_id || excerpt.turn_id !== task.turn_id
    || excerpt.source_ref !== task.source_ref
    || excerpt.project_scope_id !== task.project_scope_id || excerpt.verification_source !== task.verification_source
    || (excerpt.verification_outcome ?? null) !== (task.verification_outcome ?? null)
    || JSON.stringify(evidenceIds) !== JSON.stringify(task.verification_evidence_ids)) {
    if (excerpt.reason === "task_source_digest_mismatch" && typeof task.task_id === "string" && typeof task.source_ref === "string") {
      try { await requestCodexSessionSourceRecheck(task.task_id, task.source_ref, deps.archive_options, deps.env); } catch { /* A later poll retries a busy or unavailable index. */ }
    }
    // The indexed task and its excerpt may be read across a concurrent
    // reconciliation. Keep it pending for a later consistent snapshot.
    return { status: "waiting_for_consistent_excerpt", processed: 0, reason: "held_out_excerpt_unavailable", raw_content_stored: false };
  }
  if (excerpt.verification_outcome == null) return { status: "waiting_for_terminal_outcome", processed: 0,
    reason: "terminal_task_outcome_unverified", raw_content_stored: false };
  const verificationArtifacts = Array.isArray(excerpt.verification_artifacts) ? excerpt.verification_artifacts : [];
  if (!verificationArtifacts.length) {
    return { status: "waiting_for_verification_artifacts", processed: 0, reason: "verifiable_test_result_unavailable", raw_content_stored: false };
  }
  const listed = await deps.client.call("craft_knowledge_claim_list", { limit: 1_000, scope_kind: "project", scope_id: task.project_scope_id.slice("project:".length) });
  const candidates = (Array.isArray(listed.claims) ? listed.claims as JsonObject[] : []).filter(claim => claim.status === "candidate" && claim.scope === task.project_scope_id).slice(0, 12);
  const claims: JsonObject[] = [];
  for (const item of candidates) {
    const packetResult = await deps.client.call("craft_knowledge_semantic_review_packet", { claim_id: item.id });
    if (packetResult.status !== "ready") continue;
    const packet = object(packetResult.packet, "candidate Claim packet"), claim = object(packet.claim, "candidate Claim");
    if (claim.id !== item.id || packetResult.claim_status !== "candidate" || !Number.isSafeInteger(claim.version) || Number(claim.version) < 1
      || typeof claim.identity_digest !== "string" || typeof claim.content_digest !== "string"
      || typeof claim.content !== "string" || !claim.content.trim()) continue;
    claims.push({ claim_id: String(claim.id), claim_version: Number(claim.version), identity_digest: claim.identity_digest,
      content_digest: claim.content_digest, title: String(claim.title ?? ""), content: String(claim.content), tags: claim.tags ?? [] });
  }
  if (!claims.length) return { status: "waiting_for_candidate_claims", processed: 0, reason: "no_current_project_candidates", raw_content_stored: false };
  const profileResult = await deps.client.call("craft_evaluation_model_profile_ensure_single", { purpose: "knowledge_scenario_classification" });
  if (profileResult.status !== "ready_for_adapter" || !profileResult.profile) return { status: "waiting_for_model", processed: 0,
    reason: String(profileResult.reason ?? profileResult.status ?? "model_profile_unavailable"), raw_content_stored: false };
  const profile = object(profileResult.profile, "Knowledge evaluation profile");
  const detail = await deps.client.call("craft_evaluation_model_profile_get", { profile_id: profile.id, version: profile.version });
  const readiness = object(detail.readiness, "Knowledge evaluation profile readiness");
  if (readiness.status !== "ready_for_adapter") return { status: "waiting_for_model", processed: 0,
    reason: String(readiness.next_action ?? "model_profile_not_ready"), raw_content_stored: false };
  const provider = (deps.providers ?? PROVIDER_CATALOG).find(item => item.provider === profile.provider)
    ?? (detail.provider ? defineProvider(object(detail.provider, "Knowledge evaluation provider")) : undefined);
  if (!provider) return { status: "waiting_for_model", processed: 0, reason: "provider_unavailable", raw_content_stored: false };
  const candidateClaimIds = claims.map(claim => String(claim.claim_id));
  const candidateClaimRefs = claims.map(claim => ({ claim_id: claim.claim_id, claim_version: claim.claim_version,
    identity_digest: claim.identity_digest, content_digest: claim.content_digest }));
  const packet = redactKnowledgeModelText({ query: excerpt.task_goal, task_result: excerpt.task_result, verification_outcome: excerpt.verification_outcome,
    candidate_claims: claims, verification_artifacts: verificationArtifacts,
    sanitized: true, source_content_stored: false }) as JsonObject;
  const inputDigest = stableDigest({ purpose: "knowledge_candidate_shadow_label.v1", task_id: task.task_id, packet });
  const fingerprint = stableDigest({ provider: provider.provider, model: profile.model });
  const system = `为独立留出会话生成待审标签。只从给定的当前候选 Claim 中选择直接回答任务目标的 Claim，不得改写 Claim 或臆造标签；没有充分匹配时返回 skip。返回 JSON：decision 为 labeled 或 skip，expected_claim_ids 为所选 Claim ID 数组。该标签是模型候选，不是人工真值；来源证据资格由 Craft 后续独立判断。${generatedTextLanguageInstruction(deps.contentLanguage ?? "zh-CN")}`;
  const messages: ChatMessage[] = [{ role: "system", content: system }, { role: "user", content: JSON.stringify(packet) }];
  if (!deps.transport) return { status: "waiting_for_model", processed: 0, reason: "model_transport_unavailable", raw_content_stored: false };
  if (deps.transport.acquireCall && !deps.transport.acquireCall(provider.provider)) return { status: "waiting_for_budget", processed: 0, reason: "model_call_budget_exhausted", raw_content_stored: false };
  const started = object(await deps.client.call("craft_trace_start", { task_id: `knowledge:${task.task_id}`, operation_id: String(task.task_id),
    model_fingerprint: fingerprint, capability_fingerprint: `craft-knowledge:${CRAFT_RELEASE_VERSION}`,
    metadata: { purpose: "knowledge_held_out_label", input_digest: inputDigest, dataset_partition: "held_out", label_source: "model_candidate", content_stored: false } }), "Knowledge evaluation Trace start");
  const traceId = String(object(started.trace, "Knowledge evaluation Trace").id ?? "");
  if (!traceId) throw new Error("Knowledge evaluation Trace has no id");
  if (!/^trace[-_][A-Za-z0-9_-]{1,160}$/u.test(traceId)) throw new Error("Knowledge evaluation Trace id is invalid");
  let archiveRejected = false;
  try {
    await deps.client.call("craft_trace_append", { trace_id: traceId, event_kind: "model.request", actor: "knowledge-session-evaluation-worker",
      source: "codex-cli-learning-transport", trust: "observed", operation_id: String(task.task_id), input_refs: [inputDigest], model_fingerprint: fingerprint,
      data: { purpose: "knowledge_held_out_label", input_digest: inputDigest, source_ref: task.source_ref, content_stored: false },
      summary: "准备发送脱敏留出任务和当前候选摘要，生成待审评测标签" });
    const request = buildChatRequest(provider, { model: String(profile.model), messages, max_tokens: Math.min(Number(profile.max_output_tokens ?? 1_024), 1_024), temperature: 0 });
    if (provider.provider === "codex-cli") request.body.codex_output_schema = OUTPUT_SCHEMA;
    state.uncertain_calls[String(task.task_id)] = { trace_id: traceId, input_digest: inputDigest };
    await writeState(path, state);
    const response = await deps.transport.complete(provider, request);
    const output = parseOutput(response.text);
    if (!Array.isArray(output.expected_claim_ids) || output.expected_claim_ids.length > 8
      || output.expected_claim_ids.some(id => typeof id !== "string" || !candidateClaimIds.includes(id))
      || output.decision === "labeled" && output.expected_claim_ids.length === 0
      || output.decision === "skip" && output.expected_claim_ids.length !== 0
      || !["labeled", "skip"].includes(String(output.decision))) throw new Error("Knowledge evaluation labels must be selected from current candidate Claims");
    await deps.client.call("craft_trace_append", { trace_id: traceId, event_kind: "model.completed", actor: "knowledge-session-evaluation-worker",
      source: "codex-cli-learning-transport", trust: "observed", operation_id: String(task.task_id), model_fingerprint: fingerprint,
      usage: response.usage, data: { response_digest: stableDigest(response.text) }, summary: "Codex Host 返回了留出评测标签候选" });
    let caseId: string | null = null, caseEvidenceId: string | null = null, evaluationEligible: boolean | null = null;
    let runId: string | null = null, resultBinding: string | null = null, transcriptCheckStatus: unknown = "not_reported";
    if (output.decision === "skip") {
      const latestExcerpt = await (deps.read_excerpt ?? readCodexSessionTaskExcerpt)(task.task_id,
        { ...deps.archive_options, expected_partition: "held_out" }, deps.env);
      if (latestExcerpt.status !== "ready" || stableDigest(latestExcerpt) !== stableDigest(excerpt)) {
        archiveRejected = true; throw new Error("held-out Evidence changed during model execution");
      }
    }
    if (output.decision === "labeled") {
      const verificationEvidence = await recordSessionVerificationEvidence(deps.client, task, excerpt);
      if (!verificationEvidence) throw new Error("held-out test Evidence is unavailable");
      if (verificationEvidence.transcript_check_status !== "transcript_matched"
        || !Object.hasOwn(verificationEvidence, "transcript_check_outcome") || verificationEvidence.transcript_check_outcome !== (task.verification_outcome ?? null)) {
        archiveRejected = true; throw new Error("held-out Evidence archive verification is unavailable or mismatched");
      }
      const latestExcerpt = await (deps.read_excerpt ?? readCodexSessionTaskExcerpt)(task.task_id,
        { ...deps.archive_options, expected_partition: "held_out" }, deps.env);
      if (latestExcerpt.status !== "ready" || stableDigest(latestExcerpt) !== stableDigest(excerpt)) {
        archiveRejected = true; throw new Error("held-out Evidence changed during model execution");
      }
      caseEvidenceId = String(verificationEvidence.id);
      transcriptCheckStatus = verificationEvidence.transcript_check_status;
      const caseIdDigest = stableDigest({ task_id: task.task_id, candidate_claim_refs: candidateClaimRefs });
      const saved = await deps.client.call("craft_knowledge_evaluation_case_save", { case_id: `knowledge_case_${caseIdDigest.slice(-24)}`,
        query: String(redactKnowledgeModelText(excerpt.task_goal)), expected_claim_ids: output.expected_claim_ids as string[], scope: task.project_scope_id,
        source_session_id: task.session_id, source_task_id: task.task_id, source_evidence_ids: [...evidenceIds, caseEvidenceId],
        evaluation_channel: "real_session", dataset_partition: "held_out", label_source: "model_candidate", sanitized: true,
        candidate_claim_refs: candidateClaimRefs });
      const evaluationCase = object(saved.case, "saved Knowledge evaluation case"); caseId = String(evaluationCase.id);
      const run = await deps.client.call("craft_knowledge_evaluation_run", { run_id: `knowledge_run_${stableDigest({ case_id: caseId, input_digest: inputDigest }).slice(-24)}`,
        mode: "candidate_shadow", case_ids: [caseId], candidate_claim_ids: candidateClaimIds, top_k: 10 });
      const runRecord = object(run.run, "Knowledge evaluation run");
      if (Number.isSafeInteger(evaluationCase.version) && typeof evaluationCase.identity_digest === "string"
        && typeof runRecord.id === "string" && Number.isSafeInteger(runRecord.version) && typeof runRecord.identity_digest === "string") {
        runId = runRecord.id;
        resultBinding = stableDigest({ case_id: caseId, case_version: evaluationCase.version, case_identity: evaluationCase.identity_digest,
          run_id: runId, run_version: runRecord.version, run_identity: runRecord.identity_digest, evidence_id: caseEvidenceId });
      }
      const metrics = runRecord.metrics && typeof runRecord.metrics === "object" ? runRecord.metrics as JsonObject : {};
      evaluationEligible = metrics.provenance_eligible === true;
    }
    const resultDigest = stableDigest({ task_id: task.task_id, input_digest: inputDigest, case_id: caseId,
      verification_evidence_id: caseEvidenceId, decision: output.decision,
      expected_claim_ids: output.expected_claim_ids, evaluation_eligible: evaluationEligible });
    await deps.client.call("craft_trace_append", { trace_id: traceId, event_kind: "knowledge.evaluation_case_candidate",
      actor: "knowledge-session-evaluation-worker", source: "craft-knowledge", trust: "observed", operation_id: String(task.task_id),
      output_refs: [caseId, caseEvidenceId, runId, resultBinding].filter((value): value is string => value !== null), model_fingerprint: fingerprint,
      data: { result_digest: resultDigest, case_id: caseId, evidence_id: caseEvidenceId, transcript_check_status: transcriptCheckStatus, label_source: "model_candidate", evaluation_eligible: evaluationEligible },
      summary: caseId ? "已建立待二次审定的留出评测案例" : "模型未找到充分匹配的当前候选" });
    await deps.client.call("craft_trace_finalize", { trace_id: traceId, status: "completed", summary: "留出评测标签候选处理完成" });
    state.processed_task_ids.push(String(task.task_id)); state.trace_ids_by_task[String(task.task_id)] = traceId;
    delete state.uncertain_calls[String(task.task_id)];
    await writeState(path, state);
    return { status: caseId ? "case_candidate_created" : "case_skipped", processed: 1, task_id: task.task_id, case_id: caseId,
      trace_id: traceId, label_source: "model_candidate", evaluation_eligible: evaluationEligible, independent_adjudication_required: Boolean(caseId), raw_content_stored: false };
  } catch (error) {
    if (archiveRejected) { delete state.uncertain_calls[String(task.task_id)]; await writeState(path, state); }
    await deps.client.call("craft_trace_append", { trace_id: traceId, event_kind: "model.failed", actor: "knowledge-session-evaluation-worker",
      source: "craft-knowledge", trust: "observed", operation_id: String(task.task_id), model_fingerprint: fingerprint,
      data: { failure_kind: safeFailureKind(error), input_digest: inputDigest, result_state: archiveRejected ? "discarded" : state.uncertain_calls[String(task.task_id)] ? "unknown" : "not_dispatched" },
      summary: "留出评测标签处理未完成，调用状态待核对" });
    await deps.client.call("craft_trace_finalize", { trace_id: traceId, status: "failed", summary: "留出评测标签处理未完成" });
    throw error;
  }
}
