import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { stableDigest } from "./digest.ts";

export const KNOWLEDGE_TASK_EFFECT_POLICY = "craft.knowledge-task-effect.v1";
export const knowledgeTaskEffectId = (run: JsonObject) => `knowledge_task_effect_${stableDigest({ id: run.id, version: run.version }).slice(-48)}`;
export function knowledgeTaskEffectAssessmentDigest(receipt: JsonObject): string {
  const keys = ["policy", "scope", "claim_id", "retrieval_run_id", "retrieval_run_digest", "baseline_id", "candidate_id", "dependencies", "comparison_digest", "observed_model", "execution_origin", "status", "reasons"];
  return stableDigest(Object.fromEntries(keys.map(key => [key, receipt[key]])));
}

/** Check the local immutable assessment and every dependency observed when it was issued. */
export function knowledgeTaskEffectProofVerified(store: CraftStore, run: JsonObject): boolean {
  const receipt = store.find("knowledge_task_effect", knowledgeTaskEffectId(run), undefined, false);
  if (!receipt || receipt.version !== 1 || receipt.policy !== KNOWLEDGE_TASK_EFFECT_POLICY || receipt.status !== "eligible"
    || receipt.execution_origin !== "controlled_paired_host_tasks" || receipt.retrieval_run_digest !== stableDigest(run)
    || receipt.assessment_digest !== knowledgeTaskEffectAssessmentDigest(receipt) || stableDigest(receipt.metrics) !== receipt.comparison_digest
    || !Array.isArray(receipt.dependencies) || !receipt.dependencies.length || receipt.dependencies.length > 10_000) return false;
  const seen = new Set<string>();
  for (const value of receipt.dependencies) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const ref = value as JsonObject;
    if (typeof ref.kind !== "string" || typeof ref.id !== "string" || seen.has(`${ref.kind}:${ref.id}`)) return false;
    seen.add(`${ref.kind}:${ref.id}`);
    const record = store.find(ref.kind, ref.id, undefined, false);
    if (!record || record.version !== ref.version || stableDigest(record) !== ref.digest) return false;
  }
  return true;
}
