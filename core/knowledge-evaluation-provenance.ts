import type { CraftStore, JsonObject } from "./infrastructure/store.ts";

export type KnowledgeEvaluationProvenanceStatus =
  | "missing_provenance"
  | "incomplete_provenance"
  | "unsupported_provenance"
  | "simulated"
  | "development_only"
  | "unsanitized"
  | "missing_source_evidence"
  | "unverified_source_evidence"
  | "missing_claim_evidence"
  | "unverified_claim_source"
  | "session_leak"
  | "verified_independent";

type ClaimEvidence = { claim_id: string; evidence: JsonObject };

export function knowledgeEvaluationEvidence(store: CraftStore, item: JsonObject): {
  sourceEvidence: JsonObject[];
  claimEvidence: ClaimEvidence[];
} {
  const sourceIds = Array.isArray(item.source_evidence_ids)
    ? [...new Set(item.source_evidence_ids.filter((id): id is string => typeof id === "string"))]
    : [];
  const sourceEvidence = sourceIds.flatMap((id) => {
    const evidence = store.find("evidence", id, undefined, false);
    return evidence ? [evidence] : [];
  });
  const claimIds = Array.isArray(item.expected_claim_ids)
    ? [...new Set(item.expected_claim_ids.filter((id): id is string => typeof id === "string"))]
    : [];
  const claimEvidence = claimIds.flatMap((claimId) => {
    const claim = store.find("knowledge_claim", claimId, undefined, false);
    const evidenceIds = claim && Array.isArray(claim.evidence_ids)
      ? [...new Set(claim.evidence_ids.filter((id): id is string => typeof id === "string"))]
      : [];
    return evidenceIds.flatMap((evidenceId) => {
      const evidence = store.find("evidence", evidenceId, undefined, false);
      return evidence ? [{ claim_id: claimId, evidence }] : [];
    });
  });
  return { sourceEvidence, claimEvidence };
}

export function assessKnowledgeEvaluationProvenance(
  item: JsonObject,
  sourceEvidence: readonly JsonObject[],
  claimEvidence: readonly ClaimEvidence[],
): { status: KnowledgeEvaluationProvenanceStatus; evaluation_eligible: boolean } {
  const keys = ["source_session_id", "source_task_id", "source_evidence_ids", "evaluation_channel", "dataset_partition", "sanitized"];
  if (!keys.some((key) => Object.hasOwn(item, key))) return { status: "missing_provenance", evaluation_eligible: false };
  if (typeof item.source_session_id !== "string" || !item.source_session_id.trim()
    || typeof item.source_task_id !== "string" || !item.source_task_id.trim()
    || !Array.isArray(item.source_evidence_ids)
    || typeof item.evaluation_channel !== "string" || typeof item.dataset_partition !== "string"
    || typeof item.sanitized !== "boolean") return { status: "incomplete_provenance", evaluation_eligible: false };
  if (!["real_session", "simulation"].includes(item.evaluation_channel)
    || !["development", "held_out"].includes(item.dataset_partition)) return { status: "unsupported_provenance", evaluation_eligible: false };
  if (item.evaluation_channel === "simulation") return { status: "simulated", evaluation_eligible: false };
  if (item.dataset_partition !== "held_out") return { status: "development_only", evaluation_eligible: false };
  if (item.sanitized !== true) return { status: "unsanitized", evaluation_eligible: false };
  if (!item.source_evidence_ids.length) return { status: "missing_source_evidence", evaluation_eligible: false };

  const sourceEvidenceById = new Map(sourceEvidence.map((evidence) => [String(evidence.id), evidence]));
  for (const evidenceId of item.source_evidence_ids) {
    if (typeof evidenceId !== "string") return { status: "unverified_source_evidence", evaluation_eligible: false };
    const evidence = sourceEvidenceById.get(evidenceId);
    const metadata = evidence?.metadata;
    if (!evidence || !["confirmed", "program"].includes(String(evidence.confidence))
      || !metadata || typeof metadata !== "object" || Array.isArray(metadata)
      || (metadata as JsonObject).source_session_id !== item.source_session_id
      || (metadata as JsonObject).task_id !== item.source_task_id) {
      return { status: "unverified_source_evidence", evaluation_eligible: false };
    }
  }

  const claimIds = Array.isArray(item.expected_claim_ids) ? item.expected_claim_ids : [];
  if (!claimIds.length) return { status: "missing_claim_evidence", evaluation_eligible: false };
  for (const claimId of claimIds) {
    if (typeof claimId !== "string") return { status: "unverified_claim_source", evaluation_eligible: false };
    const evidence = claimEvidence.filter((itemEvidence) => itemEvidence.claim_id === claimId).map((itemEvidence) => itemEvidence.evidence);
    if (!evidence.length) return { status: "missing_claim_evidence", evaluation_eligible: false };
    for (const source of evidence) {
      const metadata = source.metadata;
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
        || typeof (metadata as JsonObject).source_session_id !== "string" || typeof (metadata as JsonObject).task_id !== "string") {
        return { status: "unverified_claim_source", evaluation_eligible: false };
      }
      if ((metadata as JsonObject).source_session_id === item.source_session_id
        || (metadata as JsonObject).task_id === item.source_task_id) {
        return { status: "session_leak", evaluation_eligible: false };
      }
    }
  }
  return { status: "verified_independent", evaluation_eligible: true };
}
