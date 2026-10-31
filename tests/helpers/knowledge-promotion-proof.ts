import type { CraftStore, JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { stableDigest } from "../../common/craft-common-base/src/digest.ts";
import { updateKnowledgeScenarioClaim } from "../../capability/craft-knowledge/scenario-catalog.ts";
import { knowledgeDirectoryForScope } from "../../core/project-knowledge-content.ts";
import { scopeFromKey } from "../../common/craft-common-base/src/scope-policy.ts";
import { KNOWLEDGE_TASK_EFFECT_POLICY, knowledgeTaskEffectId, knowledgeTaskEffectAssessmentDigest } from "../../core/knowledge-task-effect-proof.ts";

/** Synthetic issuer receipt for read-side invalidation tests, never live task-effect evidence.
 * Issuer admission (21 independent tasks, native engines and assert sets) is tested separately. */
export function attachTaskEffectReceiptFixture(store: CraftStore, run: JsonObject): void {
  const claim = store.get("knowledge_claim", String((run.candidate_claim_refs as JsonObject[])[0]!.claim_id));
  const dependencies = new Map<string, JsonObject>();
  const depend = (kind: string, id: string) => {
    const record = store.find(kind, id, undefined, false);
    if (!record) throw new Error(`Task-effect fixture dependency is missing: ${kind}/${id}`);
    dependencies.set(`${kind}:${id}`, { kind, id, version: record.version, digest: stableDigest(record) });
  };
  depend("knowledge_source", String(claim.source_id));
  for (const id of claim.evidence_ids as string[]) depend("evidence", id);
  for (const id of run.case_ids as string[]) {
    const item = store.get("knowledge_evaluation_case", id);
    depend("knowledge_evaluation_case", id); depend("knowledge_evaluation_adjudication", String(item.adjudication_id));
    for (const evidenceId of item.source_evidence_ids as string[]) depend("evidence", evidenceId);
  }
  const pair = ["baseline", "candidate"].map(side => {
    const id = `fixture-effect-${side}-${stableDigest(run.id).slice(-20)}`;
    if (!store.find("workbench_evaluation", id)) store.create("workbench_evaluation", id, { state: "completed", fixture_only: true });
    depend("workbench_evaluation", id); return id;
  });
  const metrics = { fixture_only: true, status: "comparable", expected_pairs: 21, measured_pairs: 21, independent_task_runs: true };
  const body: JsonObject = { scope: claim.scope, claim_id: claim.id, policy: KNOWLEDGE_TASK_EFFECT_POLICY, retrieval_run_id: run.id,
    retrieval_run_digest: stableDigest(run), baseline_id: pair[0], candidate_id: pair[1], dependencies: [...dependencies.values()],
    comparison_digest: stableDigest(metrics), metrics, observed_model: "fixture-only", execution_origin: "controlled_paired_host_tasks", status: "eligible", reasons: [] };
  store.create("knowledge_task_effect", knowledgeTaskEffectId(run), { ...body, assessment_digest: knowledgeTaskEffectAssessmentDigest(body), fixture_only: true });
}

/** Build a complete local fixture chain for read-side Knowledge tests. */
export function attachVerifiedPromotionFixture(store: CraftStore, claim: JsonObject, options: { task_effect?: boolean } = {}): JsonObject {
  const claimId = String(claim.id), suffix = stableDigest(claimId).slice(-20);
  let candidate = claim;
  let source = typeof candidate.source_id === "string" ? store.find("knowledge_source", candidate.source_id) : null;
  if (!source) {
    const sourceId = typeof candidate.source_id === "string" && candidate.source_id ? candidate.source_id : `fixture-source-${suffix}`;
    const sourceScope = scopeFromKey(String(candidate.scope ?? "global"));
    source = store.find("knowledge_source", sourceId) ?? store.create("knowledge_source", sourceId, {
      status: "active", trust: "verified", content_digest: stableDigest({ claim_id: claimId, scope: candidate.scope ?? "global" }),
      scope: sourceScope, kind: "test_fixture", label: "Verified test fixture source",
    });
    if (candidate.source_id !== sourceId) candidate = store.save("knowledge_claim", claimId, { ...candidate, source_id: sourceId });
  }
  if (!source) throw new Error(`Verified promotion fixture requires a Knowledge Source: ${String(candidate.source_id)}`);
  if (candidate.identity_digest === undefined || candidate.content_digest === undefined) {
    candidate = store.save("knowledge_claim", claimId, { ...candidate,
      identity_digest: candidate.identity_digest ?? stableDigest({ claim_id: claimId, source_id: candidate.source_id, scope: candidate.scope ?? "global" }),
      content_digest: candidate.content_digest ?? stableDigest(candidate.content ?? candidate.content_ref ?? null),
    });
  }
  const caseId = `fixture-case-${suffix}`, caseIdentity = stableDigest({ case_id: caseId, claim_id: claimId });
  const sourceEvidenceId = `fixture-source-evidence-${suffix}`;
  store.create("evidence", sourceEvidenceId, { confidence: "confirmed", source_type: "receipt", claim: "Independent held out task receipt.",
    metadata: { source_session_id: `heldout-session-${suffix}`, task_id: `heldout-task-${suffix}`, source_ref_digest: stableDigest(`heldout-${suffix}`) } });
  const originalEvidenceIds = Array.isArray(candidate.evidence_ids) ? [...new Set(candidate.evidence_ids.filter((value): value is string => typeof value === "string"))] : [];
  const claimEvidenceId = originalEvidenceIds[0] ?? `fixture-claim-evidence-${suffix}`;
  if (originalEvidenceIds.length) for (const evidenceId of originalEvidenceIds) {
    const current = store.find("evidence", evidenceId);
    const metadata = { ...((current?.metadata as JsonObject | undefined) ?? {}), source_session_id: `source-session-${suffix}`, task_id: `source-task-${suffix}`, source_ref_digest: stableDigest(`source-${suffix}`) };
    if (current) { const { version: _version, ...body } = current; store.save("evidence", evidenceId, { ...body, confidence: "confirmed", metadata }); }
    else store.create("evidence", evidenceId, { confidence: "confirmed", source_type: "receipt", claim: "Independent candidate source evidence.", metadata });
  } else {
    store.create("evidence", claimEvidenceId, { confidence: "confirmed", source_type: "receipt", claim: "Independent candidate source evidence.",
      metadata: { source_session_id: `source-session-${suffix}`, task_id: `source-task-${suffix}`, source_ref_digest: stableDigest(`source-${suffix}`) } });
  }
  const adjudicationId = `fixture-adjudication-${suffix}`;
  store.create("knowledge_evaluation_case", caseId, { identity_digest: caseIdentity, expected_claim_ids: [claimId],
    candidate_claim_refs: [{ claim_id: claimId }], source_evidence_ids: [sourceEvidenceId], source_session_id: `heldout-session-${suffix}`,
    source_task_id: `heldout-task-${suffix}`, evaluation_channel: "real_session", dataset_partition: "held_out", sanitized: true,
    label_source: "host_adjudicated", adjudication_id: adjudicationId });
  store.create("knowledge_evaluation_adjudication", adjudicationId, { execution_origin: "managed_codex_cli", case_id: caseId,
    status: "adjudicated", result_case_version: 1, result_case_identity_digest: caseIdentity, decision: "accepted", expected_claim_ids: [claimId] });
  const runId = `fixture-effectiveness-${suffix}`;
  store.create("knowledge_evaluation_run", runId, { mode: "candidate_shadow", status: "eligible", case_ids: [caseId],
    case_refs: [{ case_id: caseId, case_version: 1, identity_digest: caseIdentity }],
    candidate_source_refs: [{ claim_id: claimId, source_id: source.id, source_version: source.version,
      source_digest: source.content_digest, source_status: source.status, source_trust: source.trust }],
      candidate_claim_refs: [{ claim_id: claimId, claim_version: candidate.version, identity_digest: candidate.identity_digest ?? null,
      content_digest: candidate.content_digest ?? null }], metrics: { provenance_eligible: true } });
  if (options.task_effect !== false) attachTaskEffectReceiptFixture(store, store.get("knowledge_evaluation_run", runId));
  const reviewId = `fixture-promotion-review-${suffix}`;
  const supportRefs = [1, 2].map(index => {
    const evidence = store.create("evidence", `fixture-support-evidence-${suffix}-${index}`, { confidence: "confirmed",
      metadata: { source_session_id: `fixture-support-session-${suffix}-${index}`, task_id: `fixture-support-task-${index}` } });
    const support = store.create("knowledge_claim_support", `fixture-support-${suffix}-${index}`, { claim_id: claimId,
      scope: candidate.scope, evidence_id: evidence.id });
    return { support_id: support.id, support_version: support.version, evidence_id: evidence.id, evidence_version: evidence.version };
  });
  store.create("knowledge_auto_review", reviewId, { claim_id: claimId, claim_version: candidate.version,
    claim_identity_digest: candidate.identity_digest ?? null, verdict: "eligible", effectiveness_run_id: runId,
    policy_id: "knowledge-promotion-default", policy_revision: 1, required_independent_support: 2, minimum_confidence: "bounded", support_refs: supportRefs });
  const evidenceIds = originalEvidenceIds.length ? originalEvidenceIds : [claimEvidenceId];
  /* keep every original Evidence ID stable; only the fixture's provenance metadata is enriched */
  const validEvidenceIds = [...new Set(evidenceIds.filter((id) => {
    const evidence = store.find("evidence", id), metadata = evidence?.metadata as JsonObject | undefined;
    return typeof metadata?.source_session_id === "string" && typeof metadata.task_id === "string";
  }))];
  const promoted = store.save("knowledge_claim", claimId, { ...candidate, evidence_ids: validEvidenceIds, status: "reviewed",
    review: { reviewer: "automated-promotion-policy", automated: true, policy_id: "knowledge-promotion-default", policy_revision: 1,
      source_digest: source.content_digest, effectiveness_run_id: runId, promotion_review_id: reviewId, promotion_claim_version: Number(candidate.version) + 1,
      ...(candidate.review as JsonObject ?? {}) } });
  const scenarioCatalog = typeof promoted.scenario_key === "string" || typeof promoted.coarse_scenario_key === "string"
    ? updateKnowledgeScenarioClaim(knowledgeDirectoryForScope(store, String(promoted.scope)), promoted, "reviewed") : null;
  return scenarioCatalog ? { ...promoted, scenario_catalog: scenarioCatalog } : promoted;
}
