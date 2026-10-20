import { stableDigest } from "../../core/digest.ts";
import type { JsonObject } from "../../core/infrastructure/store.ts";
import type { ExperienceLearningClient } from "./worker.ts";

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}

/** Persist a sanitized, deterministic Evidence record for a passed Codex test command. */
export async function recordSessionVerificationEvidence(client: ExperienceLearningClient, task: JsonObject,
  excerpt: JsonObject): Promise<JsonObject | null> {
  const artifacts = Array.isArray(excerpt.verification_artifacts) ? excerpt.verification_artifacts : [];
  if (!artifacts.length || typeof task.task_id !== "string" || typeof task.session_id !== "string" || typeof task.turn_id !== "string"
    || typeof task.project_scope_id !== "string" || typeof excerpt.source_ref !== "string") return null;
  const artifactDigest = stableDigest(artifacts);
  const evidenceId = `evidence_codex_session_verification_${stableDigest({ task_id: task.task_id, artifact_digest: artifactDigest }).slice(-20)}`;
  const saved = await client.call("craft_evidence_record", { evidence_id: evidenceId, source_type: "program", confidence: "confirmed",
    claim: "归档任务的自动化测试命令已成功完成，结果摘要已核验。", locator: `codex-session-task:${task.task_id}`,
    ...(typeof task.completed_at === "string" ? { observed_at: task.completed_at } : {}),
    metadata: { provenance: "codex_session_program_verification", project_scope_id: task.project_scope_id,
      source_session_id: task.session_id, task_id: task.task_id, turn_id: task.turn_id,
      source_ref_digest: excerpt.source_ref, verification_artifact_digest: artifactDigest,
      verification_artifacts: artifacts, content_stored: false, raw_content_stored: false } });
  const evidence = object(saved.evidence ?? saved, "session verification Evidence");
  if (evidence.id !== evidenceId) throw new Error("session verification Evidence id did not match the request");
  return evidence;
}
