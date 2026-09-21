import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { payload, stableDigest } from "./digest.ts";

function bool(value: unknown): boolean { return value === true; }

/**
 * Compatibility migration is intentionally two-stage. Planning is read-only;
 * applying writes only content-free provenance links and never upgrades trust.
 */
export class ComponentHistoryMigrationKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  knowledgeReviewed(args: JsonObject = {}): JsonObject {
    const apply = bool(args.apply);
    const reviewed = this.store.list("knowledge_claim", 10_000, (item) => item.status === "reviewed");
    const assess = reviewed.map((claim) => {
      const evidenceIds = Array.isArray(claim.evidence_ids) ? claim.evidence_ids.map(String) : [];
      const sourceRevision = typeof claim.source_revision_id === "string" ? claim.source_revision_id : null;
      const fragment = typeof claim.fragment_id === "string" ? claim.fragment_id : null;
      const semanticReview = typeof claim.semantic_review_id === "string" || typeof claim.model_review_id === "string" || claim.review !== null && claim.review !== undefined;
      const complete = Boolean(sourceRevision && fragment && evidenceIds.length && semanticReview);
      return { claim, complete, source_revision_id: sourceRevision, fragment_id: fragment, evidence_ids: evidenceIds, semantic_review_bound: semanticReview };
    });
    const revalidation = assess.filter((item) => !item.complete);
    if (!apply) return { mode: "dry_run", reviewed: reviewed.length, current: assess.length - revalidation.length, revalidation_required: revalidation.map((item) => ({ claim_id: item.claim.id, missing: missingKnowledge(item) })), writes: 0 };
    const changed: JsonObject[] = [];
    for (const item of revalidation) {
      const claim = item.claim;
      changed.push(this.store.save("knowledge_claim", String(claim.id), { ...payload(claim), status: "revalidation_required", revalidation_required: true,
        revalidation_reason: "legacy_review_missing_source_revision_fragment_evidence_or_semantic_review", revalidation_at: new Date().toISOString() }));
    }
    for (const item of assess.filter((entry) => entry.complete)) {
      const claim = item.claim;
      const id = `knowledge_semantic_review_link_${stableDigest({ claim: claim.id, version: claim.version, revision: item.source_revision_id, fragment: item.fragment_id, evidence: item.evidence_ids }).slice(-20)}`;
      if (!this.store.find("knowledge_semantic_review_link", id)) this.store.create("knowledge_semantic_review_link", id, { claim_id: claim.id, claim_version: claim.version, source_revision_id: item.source_revision_id, fragment_id: item.fragment_id, evidence_ids: item.evidence_ids, semantic_review_bound: true, migrated: true, content_free: true });
    }
    return { mode: "applied", reviewed: reviewed.length, revalidation_required: changed.map((item) => item.id), current: assess.length - changed.length, writes: changed.length };
  }

  experienceWorkflowEvolution(args: JsonObject = {}): JsonObject {
    const apply = bool(args.apply);
    const legacy = this.store.list("workflow_evolution_observation", 10_000);
    const plan = legacy.map((item) => {
      const evidenceIds = Array.isArray(item.evidence_ids) ? item.evidence_ids.map(String) : [];
      const trustedEvidence = evidenceIds.length > 0 && evidenceIds.every((id) => {
        const evidence = this.store.find("evidence", id); return evidence !== null && ["confirmed", "bounded"].includes(String(evidence.confidence));
      });
      return { legacy: item, evidence_ids: evidenceIds, trusted_evidence: trustedEvidence, target_id: `experience_observation_migrated_${stableDigest({ id: item.id, version: item.version }).slice(-20)}` };
    });
    if (!apply) return { mode: "dry_run", legacy_observations: legacy.length, migratable: plan.filter((item) => item.trusted_evidence).map((item) => item.legacy.id), revalidation_required: plan.filter((item) => !item.trusted_evidence).map((item) => ({ observation_id: item.legacy.id, reason: "missing_or_untrusted_evidence" })), writes: 0 };
    const migrated: JsonObject[] = []; let writes = 0; let idempotent = 0;
    for (const item of plan) {
      const legacyObservation = item.legacy;
      const sourceId = `experience_legacy_source_${stableDigest({ id: legacyObservation.id, version: legacyObservation.version }).slice(-20)}`;
      const source = this.store.find("experience_legacy_source", sourceId) ?? this.store.create("experience_legacy_source", sourceId, { legacy_kind: "workflow_evolution_observation", legacy_id: legacyObservation.id, legacy_version: legacyObservation.version, source_digest: legacyObservation.identity_digest ?? stableDigest(legacyObservation.id), content_free: true });
      const kind = legacyObservation.outcome === "passed" ? "success" : legacyObservation.outcome === "failed" ? "failure" : "correction";
      const identity = { source_ref: { kind: "experience_legacy_source", id: source.id, version: source.version }, kind, scenario_key: legacyObservation.scenario_key, scope: legacyObservation.source && typeof legacyObservation.source === "object" ? (legacyObservation.source as JsonObject).scope : null, finding_digest: stableDigest({ legacy_id: legacyObservation.id, outcome: legacyObservation.outcome }), evidence_ids: item.evidence_ids, content_free: true, migrated_from: { id: legacyObservation.id, version: legacyObservation.version } };
      const status = item.trusted_evidence ? "recorded" : "revalidation_required";
      const existing = this.store.find("experience_observation", item.target_id);
      const result = existing ?? this.store.create("experience_observation", item.target_id, { ...identity, identity_digest: stableDigest(identity), status, revalidation_required: !item.trusted_evidence });
      if (existing) idempotent += 1; else writes += 1;
      migrated.push(result);
    }
    return { mode: "applied", legacy_observations: legacy.length, migrated: migrated.map((item) => ({ id: item.id, status: item.status })), writes, idempotent };
  }
}

function missingKnowledge(item: { source_revision_id: string | null; fragment_id: string | null; evidence_ids: string[]; semantic_review_bound: boolean }): string[] {
  return [item.source_revision_id ? null : "source_revision", item.fragment_id ? null : "fragment", item.evidence_ids.length ? null : "evidence", item.semantic_review_bound ? null : "semantic_review"].filter((value): value is string => value !== null);
}
