/**
 * Evidence-first automated review for imported knowledge.
 *
 * This is intentionally a verifier, not an LLM fact checker.  It can prove that
 * a Claim has an active Source, credible Evidence, an intact body and a bounded
 * scope; it cannot prove that an old prose assertion still matches a live system.
 * Consequently legacy imports with missing provenance become
 * `revalidation_required`, never silently `reviewed`.
 */
import { createHash } from "node:crypto";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { payload, stableDigest } from "./digest.ts";
import { text } from "./validation.ts";
import { contentReference, type ContentRef } from "./infrastructure/content-store.ts";
import { updateKnowledgeScenarioClaim } from "../capability/craft-knowledge/scenario-catalog.ts";
import { scopeFromKey } from "../common/craft-common-base/src/scope-policy.ts";
import { knowledgeDirectoryForScope } from "./project-knowledge-content.ts";
import { assessKnowledgeEvaluationProvenance, knowledgeClaimPromotionProofVerified, knowledgeEvaluationAdjudicationVerified, knowledgeEvaluationEvidence, knowledgeEvaluationSourceMatches, knowledgeTaskEffectEvidenceVerified } from "./knowledge-evaluation-provenance.ts";

type Verdict = "eligible" | "revalidation_required" | "rejected" | "already_reviewed";
type Confidence = "bounded" | "confirmed";
type HostReviewDecision = "supported" | "needs_evidence" | "rejected";

const DEFAULT_POLICY_ID = "knowledge-promotion-default";
const CONFIDENCE_ORDER: Readonly<Record<Confidence, number>> = { bounded: 1, confirmed: 2 };

type PromotionPolicy = {
  readonly id: string;
  readonly revision: number;
  readonly automatic: boolean;
  readonly minimum_independent_support: number;
  readonly minimum_confidence: Confidence;
};

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function claimContentIsIntact(store: CraftStore, claim: JsonObject): boolean {
  if (typeof claim.content === "string") return true;
  if (!contentReference(claim.content_ref)) return false;
  try { store.contentStore.readCompatSync(claim.content_ref, String(claim.scope)); return true; } catch { return false; }
}

/** Records a reproducible automated assessment without hiding its limits. */
export class KnowledgeAutoReviewKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  /**
   * Read or change the local automatic-promotion policy.
   *
   * This is intentionally a local operator setting rather than portable
   * Knowledge: importing a bundle from another machine must never silently
   * lower this machine's trust threshold.
   */
  policyGet(): JsonObject { return { policy: this.policy() }; }

  policySave(args: JsonObject): JsonObject {
    const existing = this.policy();
    const minimum = Number(args.minimum_independent_support ?? existing.minimum_independent_support);
    if (!Number.isSafeInteger(minimum) || minimum < 1 || minimum > 10) throw new Error("minimum_independent_support must be an integer between 1 and 10");
    const confidence = String(args.minimum_confidence ?? existing.minimum_confidence);
    if (confidence !== "bounded" && confidence !== "confirmed") throw new Error("minimum_confidence must be bounded or confirmed");
    const automatic = args.automatic === undefined ? existing.automatic : args.automatic === true;
    const identity = { automatic, minimum_independent_support: minimum, minimum_confidence: confidence };
    if (existing.identity_digest === digest(identity)) return { policy: existing, idempotent: true };
    const saved = this.store.save("knowledge_promotion_policy", DEFAULT_POLICY_ID, {
      scope: { kind: "global", id: "global" },
      ...identity,
      policy_id: DEFAULT_POLICY_ID,
      revision: Number(existing.revision) + 1,
      identity_digest: digest(identity),
      changed_at: new Date().toISOString(),
      changed_by: String(args.actor ?? "local_operator"),
    });
    return { policy: saved, idempotent: false };
  }

  /** Build the exact bounded material a Host-managed model must inspect. */
  reviewPacket(args: JsonObject): JsonObject {
    const claim = this.store.get("knowledge_claim", text(args.claim_id, "claim_id"));
    const source = typeof claim.source_id === "string" ? this.store.find("knowledge_source", claim.source_id) : null;
    if (!source || source.status !== "active" || source.trust === "untrusted") return { status: "unavailable", reason: "source_unavailable", packet: null };
    if (!claimContentIsIntact(this.store, claim)) return { status: "unavailable", reason: "claim_content_unavailable", packet: null };
    const fragments: JsonObject[] = [];
    for (const evidenceId of Array.isArray(claim.evidence_ids) ? claim.evidence_ids : []) {
      const evidence = this.store.find("evidence", String(evidenceId));
      if (!evidence || typeof evidence.fragment_id !== "string") continue;
      const fragment = this.store.find("knowledge_fragment", evidence.fragment_id); const ref = fragment?.content_ref;
      if (!fragment || !contentReference(ref)) continue;
      try { fragments.push({ evidence_id: evidence.id, fragment_id: fragment.id, locator: fragment.locator, source_revision_id: fragment.source_revision_id, content_digest: fragment.content_digest,
        ...((evidence.metadata as JsonObject | undefined)?.provenance === "codex_session_program_verification"
          ? { qualification: "会话材料由调用方提供；原文中的核验表述不能证明任务结果或实际效果。" } : {}),
        content: this.store.contentStore.readCompatSync(ref as ContentRef, String(claim.scope)).body }); } catch { /* unavailable fragment remains unavailable */ }
    }
    if (!fragments.length) return { status: "unavailable", reason: "evidence_fragment_unavailable", packet: null };
    // `CraftStore.record` materializes a valid content reference before this
    // kernel sees the Claim; `claimContentIsIntact` above rejects an invalid
    // reference.  Keep one canonical body path rather than an unreachable
    // second read of the same reference.
    const content = String(claim.content);
    const packet = { schema_version: "craft.knowledge-semantic-review.v1", claim: { id: claim.id, version: claim.version, kind: claim.kind, scope: claim.scope, content, content_digest: claim.content_digest },
      source: { id: source.id, version: source.version, content_digest: source.content_digest, trust: source.trust }, evidence_fragments: fragments,
      rubric: { supported: "Claim is directly supported by supplied fragments within the same scope.", contradicted: "Supplied fragments contradict the Claim.", insufficient: "Fragments do not establish the Claim or scope." } };
    return { status: "ready", claim_status: claim.status, packet, packet_digest: digest(packet) };
  }

  /** Optional OpenAI-compatible reviewer. Credentials are read only at call time. */
  async providerReview(args: JsonObject): Promise<JsonObject> {
    const packetResult = this.reviewPacket({ claim_id: text(args.claim_id, "claim_id") });
    if (packetResult.status !== "ready") return packetResult;
    const endpoint = typeof args.endpoint === "string" ? args.endpoint.trim() : "";
    const model = typeof args.model === "string" ? args.model.trim() : "";
    const credentialEnv = typeof args.credential_env === "string" ? args.credential_env.trim() : "";
    const key = credentialEnv ? process.env[credentialEnv] : undefined;
    if (!endpoint || !model || !credentialEnv || !key) return { status: "unavailable", reason: "semantic_provider_unavailable", packet_digest: packetResult.packet_digest };
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ model,
        response_format: { type: "json_object" }, messages: [
          { role: "system", content: "Return JSON only: {decision: supported|needs_evidence|rejected, reason_code: short_snake_case}. Decide only from the supplied evidence packet." },
          { role: "user", content: JSON.stringify(packetResult.packet) },
        ] }), signal: AbortSignal.timeout(Number(args.timeout_ms ?? 10_000)) });
      if (!response.ok) return { status: "unavailable", reason: `semantic_provider_http_${response.status}`, packet_digest: packetResult.packet_digest };
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> }; const content = body.choices?.[0]?.message?.content;
      if (!content) return { status: "unavailable", reason: "semantic_provider_empty_response", packet_digest: packetResult.packet_digest };
      const verdict = JSON.parse(content) as { decision?: string; reason_code?: string };
      if (!verdict.decision || !["supported", "needs_evidence", "rejected"].includes(verdict.decision)) return { status: "unavailable", reason: "semantic_provider_invalid_response", packet_digest: packetResult.packet_digest };
      const review = this.hostReview({ claim_id: args.claim_id, host_kind: "independent", host_run_key: `provider:${model}:${String(packetResult.packet_digest).slice(-16)}`,
        model_ref: model, source_digest: ((packetResult.packet as JsonObject).source as JsonObject).content_digest, packet_digest: packetResult.packet_digest,
        decision: verdict.decision, reason_code: verdict.reason_code ?? verdict.decision });
      return { status: "completed", packet_digest: packetResult.packet_digest, review };
    } catch (error) {
      return { status: "unavailable", reason: error instanceof Error ? error.name : "semantic_provider_request_failed", packet_digest: packetResult.packet_digest };
    }
  }

  /**
   * Add one independently observable support record to a candidate Claim.
   * The exact evidence and observation key are both unique: repeating one
   * prompt, or attaching one Evidence record to several sessions, cannot
   * inflate promotion confidence.
   */
  supportRecord(args: JsonObject): JsonObject {
    const claim = this.store.get("knowledge_claim", text(args.claim_id, "claim_id"));
    if (claim.status !== "candidate") throw new Error("Knowledge support can only be recorded for a candidate claim");
    const evidence = this.store.get("evidence", text(args.evidence_id, "evidence_id"));
    if (!["bounded", "confirmed"].includes(String(evidence.confidence))) throw new Error("Knowledge support requires bounded or confirmed Evidence");
    const observationKey = text(args.observation_key, "observation_key");
    const scope = text(args.scope ?? claim.scope, "scope");
    if (scope !== claim.scope) throw new Error("Knowledge support scope must match the claim scope");
    const identity = { claim_id: claim.id, claim_version: claim.version, evidence_id: evidence.id, observation_key: observationKey, scope };
    const supportId = String(args.support_id ?? `knowledge_support_${digest(identity).slice(-24)}`);
    const existing = this.store.find("knowledge_claim_support", supportId);
    if (existing) {
      if (existing.identity_digest !== digest(identity)) throw new Error("Knowledge support idempotency conflict");
      return { support: existing, idempotent: true };
    }
    const sameObservation = this.store.list("knowledge_claim_support", 10_000, (item) => item.claim_id === claim.id && item.observation_key === observationKey);
    if (sameObservation.length) throw new Error("Knowledge support observation_key is already recorded for this claim");
    const sameEvidence = this.store.list("knowledge_claim_support", 10_000, (item) => item.claim_id === claim.id && item.evidence_id === evidence.id);
    if (sameEvidence.length) throw new Error("Knowledge support evidence is already recorded for this claim");
    const support = this.store.create("knowledge_claim_support", supportId, {
      ...identity, identity_digest: digest(identity), recorded_at: new Date().toISOString(),
      source_type: evidence.source_type, confidence: evidence.confidence,
    });
    return { support, idempotent: false };
  }

  /**
   * Records a review performed by the model already running in a Host such as
   * Codex.  It deliberately does not configure, call, or persist credentials
   * for another model provider: the Host is the reviewer and attests the exact
   * Claim/source revision it saw.
   *
   * A supported Host review only records that the supplied Evidence packet
   * supports the Claim. It cannot promote the Claim: a separate independent
   * effectiveness evaluation is required before the Claim can enter Context.
   */
  hostReview(args: JsonObject): JsonObject {
    const claim = this.store.get("knowledge_claim", text(args.claim_id, "claim_id"));
    if (typeof claim.scope !== "string") throw new Error("Claim scope is required for Host review");
    const hostKind = text(args.host_kind ?? "codex", "host_kind");
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(hostKind)) throw new Error("host_kind must be a bounded Host identifier");
    const hostRunKey = text(args.host_run_key, "host_run_key");
    const decision = text(args.decision, "decision") as HostReviewDecision;
    if (!new Set<HostReviewDecision>(["supported", "needs_evidence", "rejected"]).has(decision)) throw new Error("decision must be supported, needs_evidence, or rejected");
    const rubricId = text(args.rubric_id ?? "knowledge-host-review-v1", "rubric_id");
    const modelRef = text(args.model_ref ?? "host-managed", "model_ref");
    const suppliedSourceDigest = text(args.source_digest, "source_digest");
    const packetDigest = args.packet_digest === undefined ? null : text(args.packet_digest, "packet_digest");
    const reasonCode = text(args.reason_code ?? (decision === "supported" ? "rubric_pass" : decision), "reason_code");
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(reasonCode)) throw new Error("reason_code must be a short stable identifier");
    const now = args.now === undefined ? Date.now() : Date.parse(text(args.now, "now"));
    if (!Number.isFinite(now)) throw new Error("now must be an ISO timestamp");

    const source = typeof claim.source_id === "string" ? this.store.find("knowledge_source", claim.source_id) : null;
    const sourceDigest = source?.content_digest;
    if (!source || typeof sourceDigest !== "string" || sourceDigest !== suppliedSourceDigest) {
      throw new Error("source_digest must match the active Claim Source");
    }
    const priorReviewId = typeof (claim.review as JsonObject | undefined)?.review_id === "string"
      ? String((claim.review as JsonObject).review_id) : null;
    const priorReview = priorReviewId ? this.store.find("knowledge_host_review", priorReviewId) : null;
    // Promotion changes the Claim version. Only an exact replay of its original
    // packet/reviewer identity may use the original attestation after that change.
    const reviewIdentity = { packet_digest: packetDigest, host_kind: hostKind, host_run_key: hostRunKey, model_ref: modelRef, rubric_id: rubricId, decision, reason_code: reasonCode };
    const replay = priorReview && packetDigest !== null && Object.entries(reviewIdentity).every(([key, value]) => priorReview[key] === value);
    if (!replay && packetDigest !== null) {
      const packet = this.reviewPacket({ claim_id: claim.id });
      if (packet.status !== "ready" || packet.packet_digest !== packetDigest) throw new Error("packet_digest must match the exact semantic review packet");
    }
    const credibleEvidence = Array.isArray(claim.evidence_ids) && claim.evidence_ids.some((id) => {
      const evidence = this.store.find("evidence", String(id));
      return evidence && ["bounded", "confirmed"].includes(String(evidence.confidence));
    });
    const blockingReasons: string[] = [];
    if (decision === "supported" && packetDigest === null) blockingReasons.push("semantic_review_packet_required");
    if (claim.status !== "candidate" && claim.status !== "reviewed") blockingReasons.push(`claim_status_${String(claim.status)}`);
    if (source.status !== "active" || source.trust === "untrusted") blockingReasons.push("source_not_trusted_active");
    if (!credibleEvidence) blockingReasons.push("credible_evidence_missing");
    if (!claimContentIsIntact(this.store, claim)) blockingReasons.push("content_reference_invalid");
    if (claim.valid_until && Date.parse(String(claim.valid_until)) < now) blockingReasons.push("claim_expired");
    const contradictions = this.store.list("knowledge_relation", 10_000, (relation) => relation.relation === "contradicts" && (relation.from_claim_id === claim.id || relation.to_claim_id === claim.id));
    if (contradictions.length) blockingReasons.push("contradiction_requires_adjudication");

    if (replay) return { review: priorReview, claim, promoted: false, idempotent: true,
      status: blockingReasons.length ? "revalidation_required" : "already_reviewed", current_valid: !blockingReasons.length, blocking_reasons: blockingReasons };

    const identity = {
      claim_id: claim.id, claim_version: claim.version, claim_identity_digest: claim.identity_digest ?? null,
      source_id: source.id, source_digest: sourceDigest, host_kind: hostKind, host_run_key: hostRunKey,
      model_ref: modelRef, rubric_id: rubricId, packet_digest: packetDigest, decision, reason_code: reasonCode, blocking_reasons: blockingReasons,
    };
    const reviewId = `knowledge_host_review_${String(claim.id)}_${digest(identity).slice(-16)}`;
    const existing = this.store.find("knowledge_host_review", reviewId);
    const review = existing ?? this.store.create("knowledge_host_review", reviewId, {
      ...identity, identity_digest: digest(identity), reviewed_at: new Date(now).toISOString(),
      automated: true, host_attested: true, packet_attested: packetDigest !== null, content_free: true,
      validation_status: packetDigest === null ? "revalidation_required" : "packet_bound",
    });
    if (decision !== "supported" || blockingReasons.length || claim.status === "reviewed") {
      return {
        review, claim, promoted: false, idempotent: existing !== null,
        status: claim.status === "reviewed" ? "already_reviewed" : blockingReasons.length ? "needs_evidence" : decision,
        blocking_reasons: blockingReasons,
      };
    }
    const evidenceId = `evidence_${reviewId}`;
    const evidence = this.store.find("evidence", evidenceId) ?? this.store.create("evidence", evidenceId, {
      source_type: "host_model_review", confidence: "bounded",
      claim: "A Host-managed model reviewed an exact source-backed Knowledge Claim.",
      locator: `host-review:${hostKind}:${hostRunKey}`,
      observed_at: new Date(now).toISOString(),
      metadata: { evidence_role: "review_attestation", review_id: review.id, source_id: source.id, source_digest: sourceDigest, host_kind: hostKind, host_run_key: hostRunKey, model_ref: modelRef, rubric_id: rubricId, reason_code: reasonCode },
    });
    // A model review is an attestation, not another independent task Source.
    // Keep it out of source Evidence so it cannot inflate support or poison provenance.
    const supportedClaim = this.store.save("knowledge_claim", String(claim.id), {
      ...payload(claim), status: "candidate",
      review: {
        reviewer: `host:${hostKind}`, review_id: review.id, attestation_evidence_id: evidence.id, host_run_key: hostRunKey, model_ref: modelRef,
        rubric_id: rubricId, source_digest: sourceDigest, packet_digest: packetDigest, reason_code: reasonCode,
        reviewed_at: new Date(now).toISOString(), automated: true, host_attested: true, source_supported: true,
        evaluation_status: "pending_independent_effectiveness",
      },
    });
    updateKnowledgeScenarioClaim(this.knowledgeDirectory(String(supportedClaim.scope), supportedClaim), supportedClaim, "candidate");
    return { review, evidence, claim: supportedClaim, promoted: false, idempotent: existing !== null,
      status: "awaiting_independent_evaluation", blocking_reasons: ["independent_effectiveness_evaluation_required"] };
  }

  assess(args: JsonObject = {}): JsonObject {
    if (args.scope_kind === undefined || args.scope_id === undefined) throw new Error("scope_kind and scope_id are required");
    const selectedScope = { kind: text(args.scope_kind, "scope_kind"), id: text(args.scope_id, "scope_id") };
    const claimIds = args.claim_ids === undefined
      ? this.store.list("knowledge_claim", 10_000, claim => this.claimMatchesScope(claim, selectedScope)).map((claim) => String(claim.id))
      : (() => {
        if (!Array.isArray(args.claim_ids) || !args.claim_ids.length) throw new Error("claim_ids must be a non-empty array");
        const ids = [...new Set(args.claim_ids.map((id) => text(id, "claim_ids")))].sort();
        const claims = ids.map(id => this.store.get("knowledge_claim", id));
        if (claims.some(claim => !this.claimMatchesScope(claim, selectedScope))) throw new Error("claim_ids must belong to the requested Knowledge scope");
        return ids;
      })();
    const now = args.now === undefined ? Date.now() : Date.parse(text(args.now, "now"));
    if (!Number.isFinite(now)) throw new Error("now must be an ISO timestamp");
    const policy = this.policy();
    // Automatic promotion is the default; callers can ask for a dry-run with
    // auto_promote:false. A disabled local policy is an explicit circuit-breaker.
    const autoPromote = args.auto_promote === undefined ? policy.automatic : args.auto_promote === true;
    const assessments = claimIds.map((claimId) => this.assessOne(claimId, now, autoPromote, policy));
    const summary = assessments.reduce<Record<string, number>>((counts, item) => {
      const verdict = String(item.verdict); counts[verdict] = (counts[verdict] ?? 0) + 1; return counts;
    }, {});
    return { assessments, summary, auto_promote: autoPromote, policy, reviewer: "automated-promotion-policy", scope: selectedScope };
  }

  private claimMatchesScope(claim: JsonObject, expected: { kind: string; id: string }): boolean {
    if (typeof claim.scope !== "string") return false;
    try {
      const actual = scopeFromKey(claim.scope);
      return actual.kind === expected.kind && actual.id === expected.id;
    } catch { return false; }
  }

  private knowledgeDirectory(scope: string, claim?: JsonObject): string {
    const reference = claim?.content_ref as JsonObject | undefined;
    return knowledgeDirectoryForScope(this.store, scope, {
      ...(typeof reference?.path === "string" ? { reference_path: reference.path } : {}),
    });
  }

  private assessOne(claimId: string, now: number, autoPromote: boolean, policy: PromotionPolicy): JsonObject {
    const claim = this.store.get("knowledge_claim", claimId);
    const reasons: string[] = [];
    let independentSupportCount = 0;
    let supportRefs: JsonObject[] = [];
    let verdict: Verdict;
    const priorRunId = (claim.review as JsonObject | undefined)?.effectiveness_run_id;
    const priorRun = claim.status === "reviewed" && typeof priorRunId === "string" ? this.store.find("knowledge_evaluation_run", priorRunId) : undefined;
    if (claim.status === "reviewed" && knowledgeClaimPromotionProofVerified(this.store, claim)) verdict = "already_reviewed";
    else if (claim.status === "reviewed" && !knowledgeTaskEffectEvidenceVerified(this.store, priorRun ?? undefined)) {
      // Legacy or invalid effect evidence needs revalidation; formal retrieval stays closed.
      verdict = "revalidation_required";
      reasons.push("independent_effectiveness_evaluation_required");
    }
    else if (claim.status === "reviewed") {
      const quarantined = this.store.save("knowledge_claim", String(claim.id), { ...payload(claim), status: "candidate",
        promotion_revalidation_required: true,
        review: { ...(claim.review as JsonObject ?? {}), qualification_status: "legacy_promotion_quarantined", revalidation_required: true } });
      updateKnowledgeScenarioClaim(this.knowledgeDirectory(String(quarantined.scope), quarantined), quarantined, "candidate");
      return this.assessOne(claimId, now, autoPromote, policy);
    }
    else if (claim.status !== "candidate") { verdict = "rejected"; reasons.push(`claim_status_${String(claim.status)}`); }
    else {
      const sourceId = typeof claim.source_id === "string" ? claim.source_id : null;
      const source = sourceId ? this.store.find("knowledge_source", sourceId) : null;
      const evidenceIds = Array.isArray(claim.evidence_ids) ? claim.evidence_ids.map(String) : [];
      const credibleEvidence = evidenceIds.filter((id) => {
        const evidence = this.store.find("evidence", id);
        return evidence && evidence.record_origin !== "caller_asserted"
          && (evidence.metadata as JsonObject | undefined)?.provenance !== "codex_session_program_verification"
          && ["bounded", "confirmed"].includes(String(evidence.confidence));
      });
      if (String(claim.scope).startsWith("legacy:")) reasons.push("legacy_scope_requires_live_revalidation");
      if (claim.promotion_revalidation_required === true) reasons.push("independent_promotion_revalidation_required");
      if (!sourceId) reasons.push("source_missing");
      else if (!source) reasons.push("source_not_registered");
      else if (source.status !== "active" || source.trust === "untrusted") reasons.push("source_not_trusted_active");
      if (!credibleEvidence.length) reasons.push("credible_evidence_missing");
      const effectivenessRun = this.independentEffectivenessRun(claim);
      if (!effectivenessRun) reasons.push("independent_effectiveness_evaluation_required");
      const supports = this.supports(claim);
      const supportKeys = new Set<string>();
      const independentSupport = supports.filter((support) => {
        const evidence = this.store.find("evidence", String(support.evidence_id));
        if (!evidence || evidence.record_origin === "caller_asserted"
          || (evidence.metadata as JsonObject | undefined)?.provenance === "codex_session_program_verification"
          || !["bounded", "confirmed"].includes(String(evidence.confidence))
          || CONFIDENCE_ORDER[String(evidence.confidence) as Confidence] < CONFIDENCE_ORDER[policy.minimum_confidence]) return false;
        const evidenceSource = typeof evidence.source_id === "string" ? this.store.find("knowledge_source", evidence.source_id) : null;
        if (typeof evidence.source_id === "string") {
          if (!evidenceSource || evidenceSource.status !== "active" || evidenceSource.trust === "untrusted") return false;
        }
        const metadata = evidence.metadata && typeof evidence.metadata === "object" && !Array.isArray(evidence.metadata)
          ? evidence.metadata as JsonObject : {};
        const sessionId = typeof metadata.source_session_id === "string" && metadata.source_session_id.trim()
          ? metadata.source_session_id.trim() : null;
        const key = evidenceSource ? `source:${evidenceSource.id}` : sessionId ? `session:${sessionId}` : null;
        // observation_key is an idempotency label supplied by the recorder, not
        // proof that two observations came from independent sources.
        if (!key) return false;
        if (supportKeys.has(key)) return false;
        supportKeys.add(key);
        return true;
      });
      independentSupportCount = independentSupport.length;
      supportRefs = independentSupport.map(support => {
        const evidence = this.store.get("evidence", String(support.evidence_id));
        return { support_id: support.id, support_version: support.version, evidence_id: evidence.id, evidence_version: evidence.version };
      });
      if (independentSupport.length < policy.minimum_independent_support) reasons.push("independent_support_below_threshold");
      if (!claimContentIsIntact(this.store, claim)) reasons.push("content_reference_invalid");
      if (claim.valid_until && Date.parse(String(claim.valid_until)) < now) reasons.push("claim_expired");
      const contradicts = this.store.list("knowledge_relation", 10_000, (relation) => relation.relation === "contradicts" && (relation.from_claim_id === claim.id || relation.to_claim_id === claim.id));
      if (contradicts.length) reasons.push("contradiction_requires_adjudication");
      verdict = reasons.length ? "revalidation_required" : "eligible";
    }
    const effectivenessRun = claim.status === "candidate" ? this.independentEffectivenessRun(claim) : null;
    const identity = { claim_id: claim.id, claim_version: claim.version, claim_status: claim.status, claim_identity_digest: claim.identity_digest ?? null,
      effectiveness_run_id: effectivenessRun?.id ?? null, verdict, reasons, policy_id: policy.id, policy_revision: policy.revision,
      required_independent_support: policy.minimum_independent_support, minimum_confidence: policy.minimum_confidence, support_refs: supportRefs };
    const reviewId = `knowledge_auto_review_${String(claim.id)}_${digest(identity).slice(-16)}`;
    const existing = this.store.find("knowledge_auto_review", reviewId);
    const review = existing ?? this.store.create("knowledge_auto_review", reviewId, { ...identity, identity_digest: digest(identity), automated: true, reviewed_at: new Date(now).toISOString() });
    let reviewedClaim: JsonObject | null = null;
    // Automated promotion is deliberately narrow: only current, non-legacy claims
    // with an active Source and credible Evidence can use it.  The result remains
    // auditable through both this review record and the normal Claim review field.
    if (autoPromote && policy.automatic && verdict === "eligible") {
      reviewedClaim = this.store.save("knowledge_claim", String(claim.id), { ...payload(claim), status: "reviewed", review: { reviewer: "automated-promotion-policy", source_digest: this.store.get("knowledge_source", String(claim.source_id)).content_digest, effectiveness_run_id: effectivenessRun!.id, promotion_review_id: review.id, promotion_claim_version: Number(claim.version) + 1, reason_digest: digest({ review_id: review.id, verdict, policy_id: policy.id, policy_revision: policy.revision, effectiveness_run_id: effectivenessRun!.id }), reviewed_at: new Date(now).toISOString(), automated: true, policy_id: policy.id, policy_revision: policy.revision } });
      updateKnowledgeScenarioClaim(this.knowledgeDirectory(String(reviewedClaim.scope), reviewedClaim), reviewedClaim, "reviewed");
    }
    return { claim_id: claim.id, claim_version: claim.version, verdict, reasons, review, claim: reviewedClaim ?? claim, promoted: reviewedClaim !== null, independent_support: independentSupportCount, required_independent_support: policy.minimum_independent_support, idempotent: existing !== null };
  }

  private policy(): PromotionPolicy & JsonObject {
    const stored = this.store.find("knowledge_promotion_policy", DEFAULT_POLICY_ID);
    if (stored) return stored as PromotionPolicy & JsonObject;
    const identity: Pick<PromotionPolicy, "automatic" | "minimum_independent_support" | "minimum_confidence"> = { automatic: true, minimum_independent_support: 2, minimum_confidence: "bounded" };
    return { id: DEFAULT_POLICY_ID, policy_id: DEFAULT_POLICY_ID, revision: 1, ...identity, identity_digest: digest(identity), defaulted: true };
  }

  private supports(claim: JsonObject): JsonObject[] {
    return this.store.list("knowledge_claim_support", 10_000, (item) => item.claim_id === claim.id);
  }

  /** A candidate needs an independent held-out retrieval evaluation of this exact revision. */
  private independentEffectivenessRun(claim: JsonObject): JsonObject | null {
    const runs = this.store.list("knowledge_evaluation_run", 10_000,
      (run) => run.mode === "candidate_shadow" && run.status === "eligible")
      .sort((left, right) => String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")));
    for (const run of runs) {
      if (!knowledgeTaskEffectEvidenceVerified(this.store, run)) continue;
      const candidateRefs = Array.isArray(run.candidate_claim_refs) ? run.candidate_claim_refs as JsonObject[] : [];
      const candidateRef = candidateRefs.find((item) => item.claim_id === claim.id);
      const source = typeof claim.source_id === "string" ? this.store.find("knowledge_source", claim.source_id) : null;
      if (!knowledgeEvaluationSourceMatches(run, claim, source) || !candidateRef || candidateRef.claim_version !== claim.version
        || candidateRef.identity_digest !== (claim.identity_digest ?? null)
        || candidateRef.content_digest !== (claim.content_digest ?? null)) continue;
      const caseRefs = Array.isArray(run.case_refs) ? run.case_refs as JsonObject[] : [];
      const caseIds = Array.isArray(run.case_ids) ? run.case_ids.map(String) : [];
      if (!caseRefs.length || caseRefs.length !== caseIds.length || candidateRefs.length === 0
        || (run.metrics as JsonObject | undefined)?.provenance_eligible !== true) continue;
      let sawPositiveLabel = false;
      let valid = true;
      for (const caseRef of caseRefs) {
        if (typeof caseRef.case_id !== "string" || !caseIds.includes(caseRef.case_id)) { valid = false; break; }
        const item = this.store.find("knowledge_evaluation_case", caseRef.case_id, undefined, false);
        if (!item || item.version !== caseRef.case_version || item.identity_digest !== caseRef.identity_digest) { valid = false; break; }
        if (Array.isArray(item.expected_claim_ids) && item.expected_claim_ids.includes(claim.id)) sawPositiveLabel = true;
        const evidence = knowledgeEvaluationEvidence(this.store, item);
        if (!assessKnowledgeEvaluationProvenance(item, evidence.sourceEvidence, evidence.claimEvidence,
          knowledgeEvaluationAdjudicationVerified(this.store, item)).evaluation_eligible) { valid = false; break; }
      }
      if (valid && sawPositiveLabel) return run;
    }
    return null;
  }
}
