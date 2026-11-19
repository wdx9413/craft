import { activeProcedure } from '@craft/capability-experience/procedure-release';
import type { EvaluationContractKernel } from "../evaluation-contract.ts";
import type { CraftStore, JsonObject } from "../infrastructure/store.ts";
import { stableDigest } from "../digest.ts";

interface ProcedureGatePort { gate(args: JsonObject): JsonObject }
interface EvaluationVerifierPort { verifyTaskEffectEvaluation(input: JsonObject): JsonObject }

/** Revoke only the exact active Experience asset named by a trusted signed task-effect failure. */
export function autoDemoteFromVerifiedHostFeedback(feedback: JsonObject | undefined, store: CraftStore,
  procedures: ProcedureGatePort, evaluations: EvaluationVerifierPort | EvaluationContractKernel): JsonObject[] {
  if (!feedback || !["incorrect", "stale"].includes(String(feedback.outcome))
    || typeof feedback.evaluation_contract_id !== "string" || typeof feedback.evaluation_id !== "string") return [];
  const refs = Array.isArray(feedback.asset_refs) ? feedback.asset_refs as JsonObject[] : [];
  const candidates = refs.filter(ref => ref.member === "experience" && typeof ref.id === "string"
    && Number.isSafeInteger(ref.version) && typeof ref.digest === "string");
  const results: JsonObject[] = [];
  for (const ref of candidates) {
    const current = activeProcedure(store, String(ref.id));
    if (!current || Number(current.version) !== Number(ref.version) || current.content_digest !== ref.digest) continue;
    const candidateRef = { kind: "experience_procedure", id: String(current.id),
      version: Number(current.candidate_version ?? current.version), digest: String(current.definition_digest ?? current.content_digest) };
    const verified = evaluations.verifyTaskEffectEvaluation({ contract_id: feedback.evaluation_contract_id,
      evaluation_id: feedback.evaluation_id, candidate_ref: candidateRef });
    if (verified.valid !== true || verified.eligible !== false
      || stableDigest(verified.candidate_ref) !== stableDigest(candidateRef)) continue;
    const contract = store.get("evaluation_contract", String(feedback.evaluation_contract_id));
    const evaluation = store.get("task_effect_evaluation", String(feedback.evaluation_id));
    if (contract.contract_digest !== verified.contract_digest || evaluation.evaluation_digest !== verified.evaluation_digest
      || evaluation.contract_id !== contract.id) continue;
    const evidenceId = `experience_feedback_failure_${stableDigest({ feedback_id: feedback.id, procedure_id: current.id,
      procedure_version: current.version, evaluation_id: evaluation.id, evaluation_digest: evaluation.evaluation_digest }).slice(-24)}`;
    const evidence = store.find("evidence", evidenceId) ?? store.create("evidence", evidenceId, {
      source_type: "program", confidence: "confirmed", record_origin: "experience_evaluator",
      claim: "A trusted paired task-effect report failed for this exact active Experience Procedure.",
      metadata: { feedback_id: feedback.id, receipt_id: feedback.receipt_id, procedure_id: current.id,
        procedure_version: current.version, candidate_ref: candidateRef, evaluation_contract_id: contract.id,
        evaluation_contract_digest: contract.contract_digest, evaluation_id: evaluation.id,
        evaluation_digest: evaluation.evaluation_digest, verdict: "failed", content_free: true },
    });
    const gateId = `experience_feedback_demotion_${stableDigest({ feedback_id: feedback.id, procedure_id: current.id,
      procedure_version: current.version, evaluation_id: evaluation.id, evidence_id: evidence.id }).slice(-20)}`;
    const demotion = procedures.gate({ procedure_id: current.id, stage: "canary", passed: false,
      verdict: "trusted_task_effect_failure", evidence_ids: [String(evidence.id)], expected_version: current.version, gate_id: gateId });
    results.push({ procedure_id: current.id, procedure_version: current.version, gate_id: gateId,
      release_revoked: (demotion.procedure as JsonObject | undefined)?.routeable === false, idempotent: demotion.idempotent === true });
  }
  return results;
}
