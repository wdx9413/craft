import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicPrivateJson, craftPaths, dataRoot } from "../../common/craft-common-store-local/src/paths.ts";
import { stableDigest } from "../../core/digest.ts";
import { CRAFT_RELEASE_VERSION } from "../../core/version.ts";
import { buildChatRequest, defineProvider, PROVIDER_CATALOG, type ChatMessage, type ModelProviderSpec, type ModelTransport } from "../../core/model-gateway.ts";
import { generatedTextLanguageInstruction } from "../../core/config.ts";
import type { JsonObject } from "../../core/infrastructure/store.ts";
import { codexSessionTaskBatch, readCodexSessionTaskExcerpt, type CodexSessionCollectionOptions } from "../../core/codex-session-archive.ts";
import type { ExperienceLearningClient } from "./worker.ts";
import { recordSessionVerificationEvidence } from "./session-verification-evidence.ts";

const STATE_SCHEMA = "craft.knowledge-session-candidate-state.v1";
const OUTPUT_SCHEMA = { type: "object", properties: {
  decision: { type: "string", enum: ["candidate", "skip"] },
  kind: { type: "string", enum: ["fact", "rule", "decision", "term", "failure_mode"] },
  title: { type: "string", maxLength: 160 }, content: { type: "string", maxLength: 2_000 }, tags: { type: "array", items: { type: "string", maxLength: 48 }, maxItems: 8 },
}, required: ["decision", "kind", "title", "content", "tags"], additionalProperties: false };
const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{8,}/iu;

type CandidateSkipReason = "verified_project_evidence_incomplete" | "verified_task_excerpt_unavailable" | "verifiable_test_result_unavailable";
interface CandidateSkip { source_ref_digest: string; reason_code: CandidateSkipReason; recorded_at: string }
interface CandidateState { processed_task_ids: string[]; terminal_skips: Record<string, CandidateSkip> }
export interface SessionKnowledgeCandidateDependencies {
  client: ExperienceLearningClient;
  providers?: readonly ModelProviderSpec[];
  transport?: ModelTransport;
  contentLanguage?: string;
  state_file?: string;
  archive_options?: CodexSessionCollectionOptions;
  read_excerpt?: typeof readCodexSessionTaskExcerpt;
  record_verification_evidence?: typeof recordSessionVerificationEvidence;
  env?: NodeJS.ProcessEnv;
}

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}
function candidateStatePath(options: SessionKnowledgeCandidateDependencies): string {
  return resolve(options.state_file ?? join(craftPaths(dataRoot(options.env)).knowledgeDir, "session-candidate-state.json"));
}
function readCandidateState(path: string): CandidateState {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error("Knowledge session candidate state file is invalid");
    const value = JSON.parse(readFileSync(path, "utf8")) as JsonObject;
    const skips = value.terminal_skips === undefined ? {} : value.terminal_skips;
    if (value.schema !== STATE_SCHEMA || !Array.isArray(value.processed_task_ids)
      || value.processed_task_ids.length > 50_000 || value.processed_task_ids.some(id => typeof id !== "string" || !id.trim() || id.length > 160)
      || !skips || typeof skips !== "object" || Array.isArray(skips) || Object.keys(skips).length > 50_000
      || Object.entries(skips as Record<string, unknown>).some(([id, raw]) => {
        const item = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as JsonObject : null;
        return !id.trim() || id.length > 160 || !item || typeof item.source_ref_digest !== "string"
          || !/^sha256:[a-f0-9]{64}$/u.test(item.source_ref_digest)
          || !["verified_project_evidence_incomplete", "verified_task_excerpt_unavailable", "verifiable_test_result_unavailable"].includes(String(item.reason_code))
          || typeof item.recorded_at !== "string" || !Number.isFinite(Date.parse(item.recorded_at));
      })) {
      throw new Error("Knowledge session candidate state is invalid");
    }
    return { processed_task_ids: [...new Set(value.processed_task_ids as string[])], terminal_skips: skips as Record<string, CandidateSkip> };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { processed_task_ids: [], terminal_skips: {} };
    throw error;
  }
}
async function writeCandidateState(path: string, state: CandidateState): Promise<void> {
  const parent = dirname(path);
  try { if (lstatSync(parent).isSymbolicLink()) throw new Error("Knowledge session candidate state directory must not be a symbolic link"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await atomicPrivateJson(path, { schema: STATE_SCHEMA, processed_task_ids: state.processed_task_ids.slice(-50_000),
    terminal_skips: Object.fromEntries(Object.entries(state.terminal_skips).slice(-50_000)), updated_at: new Date().toISOString() });
}
async function recordTerminalSkip(path: string, state: CandidateState, task: JsonObject, reason: CandidateSkipReason): Promise<void> {
  const taskId = String(task.task_id);
  state.processed_task_ids.push(taskId);
  state.terminal_skips[taskId] = { source_ref_digest: stableDigest(task.source_ref), reason_code: reason, recorded_at: new Date().toISOString() };
  await writeCandidateState(path, state);
}
function parseModelResult(value: string): JsonObject {
  let parsed: unknown;
  try { parsed = JSON.parse(value.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "")); }
  catch { throw new Error("Knowledge task generator must return one JSON object"); }
  return object(parsed, "Knowledge task candidate");
}
function safeFailureKind(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  return /^[A-Za-z][A-Za-z0-9]{0,31}$/u.test(name) ? name : "Error";
}
function validateCandidate(value: JsonObject): JsonObject | null {
  if (value.decision === "skip") return null;
  if (value.decision !== "candidate" || !["fact", "rule", "decision", "term", "failure_mode"].includes(String(value.kind))) {
    throw new Error("Knowledge task candidate decision or kind is invalid");
  }
  for (const key of ["title", "content"]) {
    if (typeof value[key] !== "string" || !String(value[key]).trim() || String(value[key]).length > (key === "title" ? 160 : 2_000)
      || SECRET.test(String(value[key]))) throw new Error(`Knowledge task candidate ${key} is invalid or sensitive`);
  }
  if (!Array.isArray(value.tags) || value.tags.length > 8 || value.tags.some(tag => typeof tag !== "string" || !tag.trim() || tag.length > 48)) {
    throw new Error("Knowledge task candidate tags are invalid");
  }
  return { kind: value.kind, title: String(value.title).trim(), content: String(value.content).trim(), tags: value.tags as string[] };
}

/** Generate at most one project Knowledge candidate from an exact, verified, passed generation task. */
export async function runSessionKnowledgeCandidateOnce(deps: SessionKnowledgeCandidateDependencies): Promise<JsonObject> {
  const path = candidateStatePath(deps), state = readCandidateState(path);
  const batch = await codexSessionTaskBatch("candidate_generation", deps.archive_options, deps.env);
  const tasks = batch.tasks as JsonObject[];
  const task = tasks.find(item => typeof item.task_id === "string" && !state.processed_task_ids.includes(item.task_id));
  if (!task) return { status: "idle", processed: 0, verified_candidates_pending: 0, raw_content_stored: false };
  if (typeof task.project_scope_id !== "string" || !/^project:[A-Za-z0-9_-]{1,96}$/u.test(task.project_scope_id)
    || !Array.isArray(task.verification_evidence_ids) || task.verification_evidence_ids.length === 0
    || typeof task.context_receipt_id !== "string" || typeof task.verification_ref_digest !== "string"
    || typeof task.terminal_identity_digest !== "string") {
    await recordTerminalSkip(path, state, task, "verified_project_evidence_incomplete");
    return { status: "skipped", processed: 1, reason: "verified_project_evidence_incomplete", raw_content_stored: false };
  }
  const excerpt = await (deps.read_excerpt ?? readCodexSessionTaskExcerpt)(task.task_id,
    { ...deps.archive_options, expected_partition: "candidate_generation" }, deps.env);
  const excerptEvidenceIds = Array.isArray(excerpt.evidence_ids) ? excerpt.evidence_ids : [];
  if (excerpt.status !== "ready" || excerpt.session_id !== task.session_id || excerpt.turn_id !== task.turn_id
    || excerpt.project_scope_id !== task.project_scope_id || excerpt.verification_outcome !== "passed"
    || JSON.stringify(excerptEvidenceIds) !== JSON.stringify(task.verification_evidence_ids)) {
    await recordTerminalSkip(path, state, task, "verified_task_excerpt_unavailable");
    return { status: "skipped", processed: 1, reason: "verified_task_excerpt_unavailable", raw_content_stored: false };
  }
  const verificationArtifacts = Array.isArray(excerpt.verification_artifacts) ? excerpt.verification_artifacts : [];
  if (!verificationArtifacts.length) {
    await recordTerminalSkip(path, state, task, "verifiable_test_result_unavailable");
    return { status: "skipped", processed: 1, reason: "verifiable_test_result_unavailable", raw_content_stored: false };
  }
  const profileResult = await deps.client.call("craft_evaluation_model_profile_ensure_single", { purpose: "knowledge_scenario_classification" });
  if (profileResult.status !== "ready_for_adapter") return { status: "waiting_for_model", processed: 0,
    reason: String(profileResult.reason || "model_profile_not_ready"), raw_content_stored: false };
  if (!profileResult.profile) return { status: "waiting_for_model", processed: 0, reason: "model_profile_unavailable", raw_content_stored: false };
  const profile = object(profileResult.profile, "Knowledge generation profile");
  const detail = await deps.client.call("craft_evaluation_model_profile_get", { profile_id: profile.id, version: profile.version });
  const readiness = object(detail.readiness, "Knowledge generation profile readiness");
  if (readiness.status !== "ready_for_adapter") return { status: "waiting_for_model", processed: 0,
    reason: String(readiness.next_action ?? "model_profile_not_ready"), raw_content_stored: false };
  const provider = (deps.providers ?? PROVIDER_CATALOG).find(item => item.provider === profile.provider)
    ?? (detail.provider ? defineProvider(object(detail.provider, "Knowledge generation provider")) : undefined);
  if (!provider) return { status: "waiting_for_model", processed: 0, reason: "provider_unavailable", raw_content_stored: false };
  const packet = { project_scope_id: task.project_scope_id, task_goal: excerpt.task_goal, task_result: excerpt.task_result,
    verification_outcome: excerpt.verification_outcome, verification_artifacts: verificationArtifacts,
    evidence_count: excerptEvidenceIds.length + 1, sanitized: true, content_stored: false };
  const inputDigest = stableDigest({ purpose: "knowledge_session_candidate_generation.v1", task_id: task.task_id, packet });
  const modelFingerprint = stableDigest({ provider: provider.provider, model: profile.model });
  const system = `从已验证的项目任务中提炼一条可复用、可独立核实的项目知识候选。仅依据输入中的任务目标和结果，不补充未观察到的事实；若没有稳定、可验证的知识，返回 decision=skip。返回一个 JSON 对象，字段为 decision、kind、title、content、tags。所有可读文字使用中文。不得写入会话细节、个人信息、密钥、路径或代码。候选只供后续独立证据评审，不代表事实已确认。${generatedTextLanguageInstruction(deps.contentLanguage ?? "zh-CN")}`;
  const messages: ChatMessage[] = [{ role: "system", content: system }, { role: "user", content: JSON.stringify(packet) }];
  if (!deps.transport) return { status: "waiting_for_model", processed: 0, reason: "model_transport_unavailable", raw_content_stored: false };
  const transport = deps.transport;
  if (transport.acquireCall && !transport.acquireCall(provider.provider)) return { status: "waiting_for_budget", processed: 0, reason: "model_call_budget_exhausted", raw_content_stored: false };
  const traceStart = object(await deps.client.call("craft_trace_start", { task_id: `knowledge:${task.task_id}`, operation_id: String(task.task_id),
    model_fingerprint: modelFingerprint, capability_fingerprint: `craft-knowledge:${CRAFT_RELEASE_VERSION}`,
    metadata: { purpose: "knowledge_session_candidate_generation", input_digest: inputDigest, content_stored: false } }), "Knowledge generation Trace start");
  const trace = object(traceStart.trace, "Knowledge generation Trace");
  const traceId = String(trace.id ?? "");
  if (!traceId) throw new Error("Knowledge generation Trace has no id");
  await deps.client.call("craft_trace_append", { trace_id: traceId, event_kind: "model.request", actor: "knowledge-session-candidate-worker",
    source: "codex-cli-learning-transport", trust: "observed", operation_id: String(task.task_id), input_refs: [inputDigest], model_fingerprint: modelFingerprint,
    data: { purpose: "knowledge_session_candidate_generation", input_digest: inputDigest, source_ref: task.source_ref, content_stored: false },
    summary: "已发送脱敏且验证通过的任务摘要，用于生成 Knowledge 候选" });
  const request = buildChatRequest(provider, { model: String(profile.model), messages, max_tokens: Math.min(Number(profile.max_output_tokens ?? 1_024), 1_024), temperature: 0 });
  if (provider.provider === "codex-cli") request.body.codex_output_schema = OUTPUT_SCHEMA;
  let candidate: JsonObject | null;
  let claimId: string | null = null, verificationEvidenceId: string | null = null;
  try {
    const response = await transport.complete(provider, request);
    await deps.client.call("craft_trace_append", { trace_id: traceId, event_kind: "model.completed", actor: "knowledge-session-candidate-worker",
      source: "codex-cli-learning-transport", trust: "observed", operation_id: String(task.task_id), model_fingerprint: modelFingerprint,
      usage: response.usage, data: { model: response.model, response_digest: stableDigest(response.text) },
      summary: "Codex Host 返回了结构化 Knowledge 候选结果" });
    candidate = validateCandidate(parseModelResult(response.text));
    if (candidate) {
      const verificationEvidence = await (deps.record_verification_evidence ?? recordSessionVerificationEvidence)(deps.client, task, excerpt);
      if (!verificationEvidence) throw new Error("verified test Evidence is unavailable");
      verificationEvidenceId = String(verificationEvidence.id);
      const saved = await deps.client.call("craft_knowledge_claim_save", { claim_id: `knowledge_claim_${stableDigest(task.task_id).slice(-24)}`,
        kind: candidate.kind, title: candidate.title, content: candidate.content, scope: task.project_scope_id,
        source_id: String(verificationEvidence.source_id), evidence_ids: [...task.verification_evidence_ids, verificationEvidenceId], tags: candidate.tags });
      const claim = object(saved.claim, "saved Knowledge Claim"); claimId = String(claim.id);
    }
    const resultDigest = stableDigest({ task_id: task.task_id, input_digest: inputDigest, claim_id: claimId,
      verification_evidence_id: verificationEvidenceId, decision: candidate ? "candidate" : "skip",
      response_digest: stableDigest(response.text) });
    await deps.client.call("craft_trace_append", { trace_id: traceId, event_kind: candidate ? "knowledge.candidate_created" : "knowledge.candidate_skipped",
      actor: "knowledge-session-candidate-worker", source: "craft-knowledge", trust: "observed", operation_id: String(task.task_id),
      output_refs: [claimId, verificationEvidenceId].filter((value): value is string => value !== null), model_fingerprint: modelFingerprint,
      data: { result_digest: resultDigest, claim_id: claimId, evidence_id: verificationEvidenceId, decision: candidate ? "candidate" : "skip" },
      summary: candidate ? "已创建待独立证据评审的 Knowledge 候选" : "模型判定该任务没有稳定 Knowledge 候选" });
    state.processed_task_ids.push(String(task.task_id)); await writeCandidateState(path, state);
    await deps.client.call("craft_trace_finalize", { trace_id: traceId, status: "completed", summary: "Knowledge 任务候选生成完成" });
  } catch (error) {
    await deps.client.call("craft_trace_append", { trace_id: traceId, event_kind: "model.failed", actor: "knowledge-session-candidate-worker",
      source: "craft-knowledge", trust: "observed", operation_id: String(task.task_id), model_fingerprint: modelFingerprint,
      data: { failure_kind: safeFailureKind(error), input_digest: inputDigest }, summary: "Knowledge 候选生成未完成，将在后续增量轮次重试" });
    await deps.client.call("craft_trace_finalize", { trace_id: traceId, status: "failed", summary: "Knowledge 候选生成未完成" });
    throw error;
  }
  return { status: candidate ? "candidate_created" : "candidate_skipped", processed: 1, task_id: task.task_id,
    claim_id: claimId, trace_id: traceId, independent_review_required: Boolean(candidate), raw_content_stored: false };
}
