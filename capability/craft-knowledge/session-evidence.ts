import type { CraftStore, JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { stableDigest } from "../../core/digest.ts";
import { codexTaskGoalDigest } from "../../core/codex-task-prose.ts";
import { knowledgeDirectoryForScope } from "../../core/project-knowledge-content.ts";
import { scopeFromKey } from "../../common/craft-common-base/src/scope-policy.ts";
import { KnowledgeSourceRegistry } from "./knowledge-source-registry.ts";

const HASH = /^sha256:[a-f0-9]{64}$/u;
const RUNNERS = new Set(["javascript", "python", "go", "rust", "java-maven", "java-gradle", "dotnet"]);
const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{8,}/iu;
const SENSITIVE = [
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/iu,
  /\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password|passwd|secret|token)\s*[:=]/iu,
  /\bhttps?:\/\/\S+/iu,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+/u,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/u,
];

function string(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\r\n\0]/u.test(value)) {
    throw new Error(`${name} must be non-empty bounded text`);
  }
  return value.trim();
}

function safeSummary(value: unknown, name: string): string {
  const summary = string(value, name, 1_000);
  if (SECRET.test(summary) || SENSITIVE.some(pattern => pattern.test(summary))) throw new Error(`${name} contains sensitive content`);
  return summary;
}

function verificationArtifacts(value: unknown): JsonObject[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw new Error("verification_artifacts must contain one to eight test results");
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`verification_artifacts[${index}] must be an object`);
    const item = raw as JsonObject;
    if (!RUNNERS.has(String(item.runner)) || !HASH.test(String(item.command_digest)) || !HASH.test(String(item.result_digest))
      || !HASH.test(String(item.call_digest)) || item.exit_code !== 0 || item.summary_kind !== "tests_passed" || item.content_stored !== false
      || Object.keys(item).some(key => !["runner", "command_digest", "result_digest", "call_digest", "exit_code", "summary_kind", "content_stored"].includes(key))) {
      throw new Error(`verification_artifacts[${index}] is not a bounded successful test result`);
    }
    return { runner: item.runner, command_digest: item.command_digest, result_digest: item.result_digest,
      call_digest: item.call_digest, exit_code: 0, summary_kind: "tests_passed", content_stored: false };
  });
}

function createOnce(store: CraftStore, kind: string, id: string, identity: JsonObject, payload: JsonObject): { record: JsonObject; existed: boolean } {
  const digest = stableDigest(identity);
  const existing = store.find(kind, id);
  if (existing) {
    if (existing.identity_digest !== digest) throw new Error(`${kind} idempotency conflict`);
    return { record: existing, existed: true };
  }
  return { record: store.create(kind, id, { ...payload, identity_digest: digest }), existed: false };
}

/** Store only a sanitized task summary and digest-only test evidence in the exact project Knowledge directory. */
export function recordKnowledgeSessionEvidence(store: CraftStore, args: JsonObject): JsonObject {
  if (args.sanitized !== true) throw new Error("sanitized must be true");
  const scope = string(args.scope, "scope", 128);
  const parsedScope = scopeFromKey(scope);
  if (parsedScope.kind !== "project" || !/^project:[A-Za-z0-9_-]{1,96}$/u.test(scope)) {
    throw new Error("session verification Evidence requires one canonical project scope");
  }
  const taskId = string(args.task_id, "task_id", 160);
  const sessionId = string(args.source_session_id, "source_session_id", 256);
  const turnId = string(args.turn_id, "turn_id", 256);
  const sourceRef = string(args.source_ref, "source_ref", 80);
  if (!HASH.test(sourceRef)) throw new Error("source_ref must be a sha256 digest");
  const taskGoal = safeSummary(args.task_goal, "task_goal");
  const taskResult = safeSummary(args.task_result, "task_result");
  const artifacts = verificationArtifacts(args.verification_artifacts);
  const observedAt = args.observed_at === undefined ? new Date().toISOString() : string(args.observed_at, "observed_at", 64);
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error("observed_at must be a valid timestamp");

  const sourceScope = parsedScope.id;
  const knowledgeDirectory = knowledgeDirectoryForScope(store, scope);
  const sourceId = `knowledge_source_codex_session_${stableDigest(scope).slice(-24)}`;
  const sourceRegistration = new KnowledgeSourceRegistry(store).sourceRegister({ source_id: sourceId, kind: "custom",
    label: "Codex 会话验证证据", scope_kind: "project", scope_id: sourceScope,
    locator: `craft://knowledge/codex-session-verification/${stableDigest(scope).slice(-24)}`,
    content_digest: "craft:codex-session-verification:v1", trust: "verified", access: "proposal_only" });
  const source = sourceRegistration.source as JsonObject;
  if (source.status !== "active" || source.trust !== "verified") throw new Error("Codex session Evidence Source is not active and verified");

  const artifactDigest = stableDigest(artifacts);
  const legacyBody = ["# 已核验的 Codex 任务证据", "", `- 项目范围：${scope}`, `- 来源会话：${sessionId}`, `- 来源任务：${taskId}`,
    `- 来源回合：${turnId}`, `- 来源摘要：${sourceRef}`, "", "## 任务目标", taskGoal, "", "## 任务结果", taskResult, "",
    "## 自动化验证", ...artifacts.map((item, index) => `- 验证 ${index + 1}：${item.runner}；通过；命令摘要 ${item.command_digest}；结果摘要 ${item.result_digest}；调用摘要 ${item.call_digest}`), ""].join("\n");
  const baseIdentity = { schema: "craft.knowledge-session-evidence.v1", scope, task_id: taskId, source_session_id: sessionId,
    turn_id: turnId, source_ref: sourceRef, task_goal: taskGoal, task_result: taskResult, artifact_digest: artifactDigest };
  const legacySuffix = stableDigest({ ...baseIdentity, body_digest: stableDigest(legacyBody) }).slice(-24);
  // A prior write may have stopped after its immutable revision but before its Evidence.
  const legacyExists = store.find("evidence", `evidence_codex_session_verification_${legacySuffix}`, undefined, false) !== null
    || store.find("knowledge_source_revision", `knowledge_source_revision_codex_session_${legacySuffix}`, undefined, false) !== null;
  const title = legacyExists ? "已核验的 Codex 任务证据" : "待核验的 Codex 任务记录";
  const body = legacyExists ? legacyBody : ["# 待核验的 Codex 任务记录", "", "以下内容由调用方提供，尚未独立核验任务结果或实际效果。", "",
    `- 项目范围：${scope}`, `- 来源会话：${sessionId}`, `- 来源任务：${taskId}`, `- 来源回合：${turnId}`, `- 来源摘要：${sourceRef}`,
    "", "## 任务目标（调用方提供）", taskGoal, "", "## 任务结果（调用方提供）", taskResult, "", "## 报告的测试记录",
    ...artifacts.map((item, index) => `- 记录 ${index + 1}：${item.runner}；报告通过；命令摘要 ${item.command_digest}；结果摘要 ${item.result_digest}；调用摘要 ${item.call_digest}`), ""].join("\n");
  const bodyDigest = stableDigest(body);
  const identity = { ...baseIdentity, body_digest: bodyDigest };
  const suffix = stableDigest(identity).slice(-24);
  const revisionId = `knowledge_source_revision_codex_session_${suffix}`;
  const documentId = `knowledge_document_codex_session_${suffix}`;
  const fragmentId = `knowledge_fragment_codex_session_${suffix}`;
  const evidenceId = `evidence_codex_session_verification_${suffix}`;
  const locator = `codex-session-task:${taskId}#${sourceRef.slice(-16)}`;
  const contentRef = store.contentStore.writeSync({ kind: "knowledge", record_id: fragmentId, version: 1, scope,
    status: "candidate", sensitivity: "internal", source_id: sourceId, title, body });
  const contentDigest = stableDigest(body);
  const revisionIdentity = { source_id: sourceId, source_version: source.version, source_revision_digest: bodyDigest };
  const revision = createOnce(store, "knowledge_source_revision", revisionId, revisionIdentity, {
    source_id: sourceId, source_version: source.version, source_revision_digest: bodyDigest,
    locator_digest: stableDigest(locator), file_count: 1, status: "current", immutable: true,
  }).record;
  const documentIdentity = { source_id: sourceId, source_revision_id: revisionId, path: locator, content_digest: contentDigest };
  createOnce(store, "knowledge_document", documentId, documentIdentity, {
    source_id: sourceId, root_digest: stableDigest(sessionId), path: locator, content_digest: contentDigest, status: "current",
  });
  const fragmentIdentity = { source_id: sourceId, source_revision_id: revisionId, document_id: documentId,
    scope, content_digest: contentDigest, content_ref_digest: contentRef.digest };
  const fragment = createOnce(store, "knowledge_fragment", fragmentId, fragmentIdentity, {
    source_id: sourceId, source_revision_id: revisionId, document_id: documentId, document_digest: contentDigest,
    path: locator, locator, content_ref: contentRef, content_digest: contentDigest, status: "current", immutable: true,
  });
  const evidenceIdentity = { ...identity, source_id: sourceId, fragment_id: fragmentId, evidence_id: evidenceId };
  const evidence = createOnce(store, "evidence", evidenceId, evidenceIdentity, {
    source_type: "program", source_id: sourceId, source_revision_id: revisionId, fragment_id: fragmentId,
    record_origin: "caller_asserted",
    locator, claim: "调用方提供的脱敏 Codex 任务摘要和测试结果，尚未独立核验。", confidence: "unverified",
    content_digest: contentDigest, observed_at: observedAt,
    metadata: { provenance: "codex_session_program_verification", scope, project_scope_id: scope,
      source_session_id: sessionId, task_id: taskId, turn_id: turnId, source_ref_digest: sourceRef,
      ...(codexTaskGoalDigest(taskGoal) ? { task_goal_digest: codexTaskGoalDigest(taskGoal) } : {}),
      verification_artifact_digest: artifactDigest, content_stored: true, raw_content_stored: false },
  });
  const safeEvidence = evidence.record.confidence === "unverified" && evidence.record.recorded_confidence === undefined ? evidence.record : store.transaction(() => {
    const current = store.get("evidence", evidenceId);
    if (current.identity_digest !== evidence.record.identity_digest) throw new Error("session Evidence changed during confidence correction");
    if (current.confidence === "unverified" && current.recorded_confidence === undefined) return current;
    const { recorded_confidence: _recordedConfidence, ...persistable } = current;
    return store.save("evidence", evidenceId, { ...persistable, confidence: "unverified", record_origin: "caller_asserted",
      claim: "调用方提供的脱敏 Codex 任务摘要和测试结果，尚未独立核验。" }, Number(current.version) + 1);
  });
  return { evidence: safeEvidence, source_id: sourceId, fragment_id: fragmentId, content_digest: contentDigest,
    sanitized_content_stored: true, raw_content_stored: false };
}
