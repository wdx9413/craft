import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicPrivateJson, craftPaths, dataRoot } from "../../common/craft-common-store-local/src/paths.ts";
import { stableDigest } from "../../core/digest.ts";
import { CRAFT_RELEASE_VERSION } from "../../core/version.ts";
import { buildChatRequest, defineProvider, PROVIDER_CATALOG, type ChatMessage, type ModelProviderSpec, type ModelTransport } from "../../core/model-gateway.ts";
import { generatedTextLanguageInstruction } from "../../core/config.ts";
import type { JsonObject } from "../../core/infrastructure/store.ts";
import { codexSessionTaskBatch, readCodexSessionTaskExcerpt, type CodexSessionCollectionOptions } from "../../core/codex-session-archive.ts";
import { redactKnowledgeModelText } from "./knowledge-classification.ts";
import type { ExperienceLearningClient } from "./worker.ts";
import { recordSessionVerificationEvidence } from "./session-verification-evidence.ts";

const SCHEMA = "craft.knowledge-session-evaluation-state.v1";
const OUTPUT_SCHEMA = { type: "object", properties: {
  decision: { type: "string", enum: ["labeled", "skip"] },
  expected_claim_ids: { type: "array", items: { type: "string", minLength: 1, maxLength: 160 }, maxItems: 8 },
}, required: ["decision", "expected_claim_ids"], additionalProperties: false };
const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{8,}/iu;
interface EvaluationState { processed_task_ids: string[] }
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
    if (value.schema !== SCHEMA || !Array.isArray(value.processed_task_ids) || value.processed_task_ids.length > 50_000
      || value.processed_task_ids.some(id => typeof id !== "string" || !id.trim() || id.length > 160)) throw new Error("Knowledge evaluation state is invalid");
    return { processed_task_ids: [...new Set(value.processed_task_ids as string[])] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { processed_task_ids: [] };
    throw error;
  }
}
async function writeState(path: string, state: EvaluationState): Promise<void> {
  try { if (lstatSync(dirname(path)).isSymbolicLink()) throw new Error("Knowledge evaluation state directory must not be a symbolic link"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await atomicPrivateJson(path, { schema: SCHEMA, processed_task_ids: state.processed_task_ids.slice(-50_000), updated_at: new Date().toISOString() });
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

/** Create at most one model-labeled, held-out session case; provenance gates still decide eligibility. */
export async function runSessionKnowledgeEvaluationOnce(deps: SessionKnowledgeEvaluationDependencies): Promise<JsonObject> {
  const path = evaluationStatePath(deps), state = readState(path);
  const batch = await codexSessionTaskBatch("held_out", deps.archive_options, deps.env);
  const task = (batch.tasks as JsonObject[]).find(item => typeof item.task_id === "string" && !state.processed_task_ids.includes(item.task_id));
  if (!task) return { status: "idle", processed: 0, raw_content_stored: false };
  if (typeof task.project_scope_id !== "string" || !/^project:[A-Za-z0-9_-]{1,96}$/u.test(task.project_scope_id)) {
    state.processed_task_ids.push(String(task.task_id)); await writeState(path, state);
    return { status: "skipped", processed: 1, reason: "held_out_provenance_incomplete", raw_content_stored: false };
  }
  const excerpt = await (deps.read_excerpt ?? readCodexSessionTaskExcerpt)(task.task_id, { ...deps.archive_options, expected_partition: "held_out" }, deps.env);
  const evidenceIds = Array.isArray(excerpt.evidence_ids) ? excerpt.evidence_ids : [];
  if (excerpt.status !== "ready" || excerpt.session_id !== task.session_id || excerpt.turn_id !== task.turn_id
    || excerpt.project_scope_id !== task.project_scope_id || JSON.stringify(evidenceIds) !== JSON.stringify(task.verification_evidence_ids)) {
    state.processed_task_ids.push(String(task.task_id)); await writeState(path, state);
    return { status: "skipped", processed: 1, reason: "held_out_excerpt_unavailable", raw_content_stored: false };
  }
  const verificationArtifacts = Array.isArray(excerpt.verification_artifacts) ? excerpt.verification_artifacts : [];
  if (!verificationArtifacts.length) {
    state.processed_task_ids.push(String(task.task_id)); await writeState(path, state);
    return { status: "skipped", processed: 1, reason: "verifiable_test_result_unavailable", raw_content_stored: false };
  }
  const listed = await deps.client.call("craft_knowledge_claim_list", { limit: 1_000, scope_kind: "project", scope_id: task.project_scope_id.slice("project:".length) });
  const reviewed = (Array.isArray(listed.claims) ? listed.claims as JsonObject[] : []).filter(claim => claim.status === "reviewed" && claim.scope === task.project_scope_id).slice(0, 12);
  const claims: JsonObject[] = [];
  for (const item of reviewed) {
    const packetResult = await deps.client.call("craft_knowledge_semantic_review_packet", { claim_id: item.id });
    if (packetResult.status !== "ready") continue;
    const packet = object(packetResult.packet, "reviewed Claim packet"), claim = object(packet.claim, "reviewed Claim");
    if (claim.id !== item.id || claim.status !== "reviewed" || typeof claim.content !== "string" || !claim.content.trim()) continue;
    claims.push({ claim_id: String(claim.id), title: String(claim.title ?? ""), content: String(claim.content), tags: claim.tags ?? [] });
  }
  if (!claims.length) return { status: "waiting_for_reviewed_claims", processed: 0, reason: "no_reviewed_project_claims", raw_content_stored: false };
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
  const packet = redactKnowledgeModelText({ query: excerpt.task_goal, task_result: excerpt.task_result,
    reviewed_claims: claims, verification_artifacts: verificationArtifacts,
    sanitized: true, source_content_stored: false }) as JsonObject;
  const inputDigest = stableDigest({ purpose: "knowledge_held_out_label.v1", task_id: task.task_id, packet });
  const fingerprint = stableDigest({ provider: provider.provider, model: profile.model });
  const system = `为独立留出会话生成待审标签。只从给定的已审核 Claim 中选择直接回答任务目标的 Claim，不得改写 Claim 或臆造标签；没有充分匹配时返回 skip。返回 JSON：decision 为 labeled 或 skip，expected_claim_ids 为所选 Claim ID 数组。该标签是模型候选，不是人工真值；来源证据资格由 Craft 后续独立判断。${generatedTextLanguageInstruction(deps.contentLanguage ?? "zh-CN")}`;
  const messages: ChatMessage[] = [{ role: "system", content: system }, { role: "user", content: JSON.stringify(packet) }];
  if (!deps.transport) return { status: "waiting_for_model", processed: 0, reason: "model_transport_unavailable", raw_content_stored: false };
  if (deps.transport.acquireCall && !deps.transport.acquireCall(provider.provider)) return { status: "waiting_for_budget", processed: 0, reason: "model_call_budget_exhausted", raw_content_stored: false };
  const started = object(await deps.client.call("craft_trace_start", { task_id: `knowledge:${task.task_id}`, operation_id: String(task.task_id),
    model_fingerprint: fingerprint, capability_fingerprint: `craft-knowledge:${CRAFT_RELEASE_VERSION}`,
    metadata: { purpose: "knowledge_held_out_label", input_digest: inputDigest, dataset_partition: "held_out", label_source: "model_candidate", content_stored: false } }), "Knowledge evaluation Trace start");
  const traceId = String(object(started.trace, "Knowledge evaluation Trace").id ?? "");
  if (!traceId) throw new Error("Knowledge evaluation Trace has no id");
  try {
    await deps.client.call("craft_trace_append", { trace_id: traceId, event_kind: "model.request", actor: "knowledge-session-evaluation-worker",
      source: "codex-cli-learning-transport", trust: "observed", operation_id: String(task.task_id), input_refs: [inputDigest], model_fingerprint: fingerprint,
      data: { purpose: "knowledge_held_out_label", input_digest: inputDigest, source_ref: task.source_ref, content_stored: false },
      summary: "已发送脱敏留出任务和已审核 Claim 摘要，生成待审评测标签" });
    const request = buildChatRequest(provider, { model: String(profile.model), messages, max_tokens: Math.min(Number(profile.max_output_tokens ?? 1_024), 1_024), temperature: 0 });
    if (provider.provider === "codex-cli") request.body.codex_output_schema = OUTPUT_SCHEMA;
    const response = await deps.transport.complete(provider, request);
    const output = parseOutput(response.text);
    if (!Array.isArray(output.expected_claim_ids) || output.expected_claim_ids.length > 8
      || output.expected_claim_ids.some(id => typeof id !== "string" || !claims.some(claim => claim.claim_id === id))
      || output.decision === "labeled" && output.expected_claim_ids.length === 0
      || output.decision === "skip" && output.expected_claim_ids.length !== 0
      || !["labeled", "skip"].includes(String(output.decision))) throw new Error("Knowledge evaluation labels must be selected from reviewed Claims");
    await deps.client.call("craft_trace_append", { trace_id: traceId, event_kind: "model.completed", actor: "knowledge-session-evaluation-worker",
      source: "codex-cli-learning-transport", trust: "observed", operation_id: String(task.task_id), model_fingerprint: fingerprint,
      usage: response.usage, data: { response_digest: stableDigest(response.text) }, summary: "Codex Host 返回了留出评测标签候选" });
    let caseId: string | null = null, caseEvidenceId: string | null = null, evaluationEligible: boolean | null = null;
    if (output.decision === "labeled") {
      const verificationEvidence = await recordSessionVerificationEvidence(deps.client, task, excerpt);
      if (!verificationEvidence) throw new Error("held-out test Evidence is unavailable");
      caseEvidenceId = String(verificationEvidence.id);
      const saved = await deps.client.call("craft_knowledge_evaluation_case_save", { case_id: `knowledge_case_${stableDigest(task.task_id).slice(-24)}`,
        query: String(redactKnowledgeModelText(excerpt.task_goal)), expected_claim_ids: output.expected_claim_ids as string[], scope: task.project_scope_id,
        source_session_id: task.session_id, source_task_id: task.task_id, source_evidence_ids: [...evidenceIds, caseEvidenceId],
        evaluation_channel: "real_session", dataset_partition: "held_out", label_source: "model_candidate", sanitized: true });
      const evaluationCase = object(saved.case, "saved Knowledge evaluation case"); caseId = String(evaluationCase.id);
      const run = await deps.client.call("craft_knowledge_evaluation_run", { run_id: `knowledge_run_${stableDigest({ case_id: caseId, now: new Date().toISOString() }).slice(-24)}`,
        case_ids: [caseId], top_k: 10 });
      const runRecord = object(run.run, "Knowledge evaluation run");
      const metrics = runRecord.metrics && typeof runRecord.metrics === "object" ? runRecord.metrics as JsonObject : {};
      evaluationEligible = metrics.provenance_eligible === true;
    }
    const resultDigest = stableDigest({ task_id: task.task_id, input_digest: inputDigest, case_id: caseId,
      verification_evidence_id: caseEvidenceId, decision: output.decision,
      expected_claim_ids: output.expected_claim_ids, evaluation_eligible: evaluationEligible });
    await deps.client.call("craft_trace_append", { trace_id: traceId, event_kind: "knowledge.evaluation_case_candidate",
      actor: "knowledge-session-evaluation-worker", source: "craft-knowledge", trust: "observed", operation_id: String(task.task_id),
      output_refs: [caseId, caseEvidenceId].filter((value): value is string => value !== null), model_fingerprint: fingerprint,
      data: { result_digest: resultDigest, case_id: caseId, evidence_id: caseEvidenceId, label_source: "model_candidate", evaluation_eligible: evaluationEligible },
      summary: caseId ? "已建立待独立审定的留出评测案例" : "模型未找到充分匹配的已审核 Claim" });
    state.processed_task_ids.push(String(task.task_id)); await writeState(path, state);
    await deps.client.call("craft_trace_finalize", { trace_id: traceId, status: "completed", summary: "留出评测标签候选处理完成" });
    return { status: caseId ? "case_candidate_created" : "case_skipped", processed: 1, task_id: task.task_id, case_id: caseId,
      label_source: "model_candidate", evaluation_eligible: evaluationEligible, independent_adjudication_required: Boolean(caseId), raw_content_stored: false };
  } catch (error) {
    await deps.client.call("craft_trace_append", { trace_id: traceId, event_kind: "model.failed", actor: "knowledge-session-evaluation-worker",
      source: "craft-knowledge", trust: "observed", operation_id: String(task.task_id), model_fingerprint: fingerprint,
      data: { failure_kind: safeFailureKind(error), input_digest: inputDigest }, summary: "留出评测标签处理未完成，将在后续增量轮次重试" });
    await deps.client.call("craft_trace_finalize", { trace_id: traceId, status: "failed", summary: "留出评测标签处理未完成" });
    throw error;
  }
}
