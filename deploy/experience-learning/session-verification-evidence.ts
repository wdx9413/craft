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
    || typeof task.project_scope_id !== "string" || typeof excerpt.source_ref !== "string" || excerpt.sanitized !== true
    || typeof excerpt.task_goal !== "string" || typeof excerpt.task_result !== "string") return null;
  const saved = await client.call("craft_knowledge_session_evidence_record", { scope: task.project_scope_id,
    task_id: task.task_id, source_session_id: task.session_id, turn_id: task.turn_id, source_ref: excerpt.source_ref,
    task_goal: excerpt.task_goal, task_result: excerpt.task_result, verification_artifacts: artifacts, sanitized: true,
    ...(["candidate_generation", "held_out"].includes(String(task.dataset_partition))
      ? { verify_against_archive: true, dataset_partition: task.dataset_partition } : {}),
    ...(typeof task.completed_at === "string" ? { observed_at: task.completed_at } : {}) });
  const evidence = object(saved.evidence, "session verification Evidence");
  if (typeof evidence.id !== "string" || !evidence.id) throw new Error("session verification Evidence id is missing");
  if (typeof saved.source_id !== "string" || typeof saved.fragment_id !== "string" || evidence.fragment_id !== saved.fragment_id
    || evidence.source_id !== saved.source_id || saved.raw_content_stored !== false || saved.sanitized_content_stored !== true) {
    throw new Error("session verification Evidence did not include its scoped Knowledge fragment");
  }
  const check = saved.transcript_check;
  const status = check && typeof check === "object" && !Array.isArray(check) ? (check as JsonObject).status : undefined;
  return { ...evidence, transcript_check_status: status === "transcript_matched" || status === "unverified" || status === "unavailable" ? status : "not_reported" };
}
