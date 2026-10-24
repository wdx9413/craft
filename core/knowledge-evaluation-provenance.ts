import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { stableDigest } from "./digest.ts";

export type KnowledgeEvaluationProvenanceStatus =
  | "missing_provenance"
  | "incomplete_provenance"
  | "unsupported_provenance"
  | "simulated"
  | "development_only"
  | "model_labeled"
  | "unadjudicated_label"
  | "unsanitized"
  | "missing_source_evidence"
  | "unverified_source_evidence"
  | "missing_claim_evidence"
  | "unverified_claim_source"
  | "session_leak"
  | "verified_independent";

type ClaimEvidence = { claim_id: string; evidence: JsonObject };

/** Bind a second-pass Host decision to the exact persisted case and inputs. */
export function knowledgeEvaluationCaseBindingDigest(item: JsonObject): string {
  return stableDigest({ case_id: item.id, case_version: item.version, identity_digest: item.identity_digest ?? null,
    candidate_claim_refs: Array.isArray(item.candidate_claim_refs) ? item.candidate_claim_refs : [],
    source_evidence_ids: Array.isArray(item.source_evidence_ids) ? item.source_evidence_ids : [] });
}

/** Only the adjudication API can create this record after validating a completed Trace. */
export function knowledgeEvaluationAdjudicationVerified(store: CraftStore, item: JsonObject): boolean {
  if (item.label_source !== "host_adjudicated" || typeof item.adjudication_id !== "string") return false;
  const record = store.find("knowledge_evaluation_adjudication", item.adjudication_id, undefined, false);
  return record !== null && record.execution_origin === "managed_codex_cli"
    && record.case_id === item.id && record.status === "adjudicated"
    && record.result_case_version === item.version && record.result_case_identity_digest === item.identity_digest
    && ["accepted", "corrected"].includes(String(record.decision))
    && Array.isArray(record.expected_claim_ids)
    && stableDigest(record.expected_claim_ids) === stableDigest(item.expected_claim_ids);
}

/** Compatibility for old Claims that mixed an exact Host attestation into
 * source Evidence. Unbound or malformed review records remain source failures. */
function boundReviewAttestation(store: CraftStore, claim: JsonObject, evidence: JsonObject): boolean {
  if (evidence.source_type !== "host_model_review") return false;
  const metadata = evidence.metadata as JsonObject | undefined;
  const claimReview = claim.review as JsonObject | undefined;
  if (!claimReview || typeof metadata?.review_id !== "string" || metadata.review_id !== claimReview.review_id) return false;
  const review = store.find("knowledge_host_review", metadata.review_id, undefined, false);
  return review !== null && review.claim_id === claim.id && review.decision === "supported" && review.packet_attested === true
    && typeof review.packet_digest === "string" && review.packet_digest === claimReview.packet_digest
    && review.source_id === claim.source_id && review.source_digest === claimReview.source_digest
    && review.source_digest === metadata.source_digest && review.claim_identity_digest === (claim.identity_digest ?? null);
}

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
      ? [...new Set(claim.evidence_ids)]
      : [];
    return evidenceIds.flatMap((evidenceId) => {
      const evidence = typeof evidenceId === "string" ? store.find("evidence", evidenceId, undefined, false) : null;
      if (evidence && boundReviewAttestation(store, claim!, evidence)) return [];
      // Do not silently remove a broken Source from independence checks.
      return [{ claim_id: claimId, evidence: evidence ?? { status: "unavailable_source_evidence" } }];
    });
  });
  return { sourceEvidence, claimEvidence };
}

/**
 * A `reviewed` label is only a projection of authority.  Verify the complete
 * managed promotion chain before allowing the Claim into execution Context:
 * policy assessment -> exact held-out run -> exact adjudicated cases -> the
 * Claim revision immediately before promotion.  Imported labels and legacy
 * model reviews do not carry this local chain and therefore fail closed.
 */
export function knowledgeClaimPromotionProofVerified(store: CraftStore, claim: JsonObject): boolean {
  if (claim.status !== "reviewed" || !Number.isSafeInteger(claim.version) || Number(claim.version) < 2) return false;
  const review = claim.review as JsonObject | undefined;
  if (!review) return false;
  const promotionVersion = Number(review?.promotion_claim_version);
  if (!Number.isSafeInteger(promotionVersion) || promotionVersion < 2 || promotionVersion > Number(claim.version)) return false;
  let promotedRevision: JsonObject;
  try { promotedRevision = store.get("knowledge_claim", String(claim.id), promotionVersion); }
  catch { return false; }
  if (promotedRevision.status !== "reviewed" || promotedRevision.identity_digest !== (claim.identity_digest ?? null)
    || promotedRevision.content_digest !== (claim.content_digest ?? null) || promotedRevision.source_id !== claim.source_id
    || promotedRevision.scope !== claim.scope
    || stableDigest(promotedRevision.review ?? null) !== stableDigest(review)) return false;
  const source = typeof claim.source_id === "string" ? store.find("knowledge_source", claim.source_id, undefined, false) : null;
  const runId = typeof review?.effectiveness_run_id === "string" ? review.effectiveness_run_id : null;
  const assessmentId = typeof review?.promotion_review_id === "string" ? review.promotion_review_id : null;
  const activePolicy = store.find("knowledge_promotion_policy", typeof review?.policy_id === "string" ? review.policy_id : "", undefined, false);
  if (!review || review.reviewer !== "automated-promotion-policy" || review.automated !== true
    || typeof review.policy_id !== "string" || !Number.isSafeInteger(review.policy_revision) || Number(review.policy_revision) < 1
    || (activePolicy ? activePolicy.automatic !== true || activePolicy.revision !== review.policy_revision : review.policy_revision !== 1)
    || !source || source.status !== "active" || source.trust === "untrusted" || review.source_digest !== source.content_digest
    || !runId || !assessmentId) return false;
  const priorVersion = promotionVersion - 1;
  const assessment = store.find("knowledge_auto_review", assessmentId, undefined, false);
  const run = store.find("knowledge_evaluation_run", runId, undefined, false);
  if (!assessment || assessment.claim_id !== claim.id || assessment.claim_version !== priorVersion
    || assessment.claim_identity_digest !== (claim.identity_digest ?? null) || assessment.verdict !== "eligible"
    || assessment.effectiveness_run_id !== runId || assessment.policy_id !== review.policy_id
    || assessment.policy_revision !== review.policy_revision
    || !run || run.mode !== "candidate_shadow" || run.status !== "eligible"
    || (run.metrics as JsonObject | undefined)?.provenance_eligible !== true) return false;
  const refs = Array.isArray(run.candidate_claim_refs) ? run.candidate_claim_refs as JsonObject[] : [];
  if (!refs.some((ref) => ref.claim_id === claim.id && ref.claim_version === priorVersion
    && ref.identity_digest === (claim.identity_digest ?? null) && ref.content_digest === (claim.content_digest ?? null))) return false;
  const caseRefs = Array.isArray(run.case_refs) ? run.case_refs as JsonObject[] : [];
  const caseIds = Array.isArray(run.case_ids) ? run.case_ids.map(String) : [];
  if (!caseRefs.length || caseRefs.length !== caseIds.length) return false;
  let positiveLabel = false;
  for (const ref of caseRefs) {
    if (typeof ref.case_id !== "string" || !caseIds.includes(ref.case_id)) return false;
    const item = store.find("knowledge_evaluation_case", ref.case_id, undefined, false);
    if (!item || item.version !== ref.case_version || item.identity_digest !== ref.identity_digest) return false;
    if (Array.isArray(item.expected_claim_ids) && item.expected_claim_ids.includes(claim.id)) positiveLabel = true;
    const evidence = knowledgeEvaluationEvidence(store, item);
    if (!assessKnowledgeEvaluationProvenance(item, evidence.sourceEvidence, evidence.claimEvidence,
      knowledgeEvaluationAdjudicationVerified(store, item)).evaluation_eligible) return false;
  }
  return positiveLabel;
}

export function assessKnowledgeEvaluationProvenance(
  item: JsonObject,
  sourceEvidence: readonly JsonObject[],
  claimEvidence: readonly ClaimEvidence[],
  adjudicationVerified = false,
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
  if (item.label_source !== undefined && !["model_candidate", "operator_asserted", "host_adjudicated"].includes(String(item.label_source))) {
    return { status: "unsupported_provenance", evaluation_eligible: false };
  }
  if (item.label_source === "model_candidate") return { status: "model_labeled", evaluation_eligible: false };
  if (item.label_source !== "host_adjudicated" || !adjudicationVerified) return { status: "unadjudicated_label", evaluation_eligible: false };
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
