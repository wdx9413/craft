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
import { payload } from "./digest.ts";
import { text } from "./validation.ts";
import { contentReference, type ContentRef } from "./infrastructure/content-store.ts";

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
  try { store.contentStore.readCompatSync(claim.content_ref); return true; } catch { return false; }
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
      try { fragments.push({ evidence_id: evidence.id, fragment_id: fragment.id, locator: fragment.locator, source_revision_id: fragment.source_revision_id, content_digest: fragment.content_digest, content: this.store.contentStore.readCompatSync(ref as ContentRef).body }); } catch { /* unavailable fragment remains unavailable */ }
    }
    if (!fragments.length) return { status: "unavailable", reason: "evidence_fragment_unavailable", packet: null };
    const content = typeof claim.content === "string" ? claim.content : this.store.contentStore.readCompatSync(claim.content_ref as ContentRef).body;
    const packet = { schema_version: "craft.knowledge-semantic-review.v1", claim: { id: claim.id, version: claim.version, kind: claim.kind, scope: claim.scope, content, content_digest: claim.content_digest },
      source: { id: source.id, version: source.version, content_digest: source.content_digest, trust: source.trust }, evidence_fragments: fragments,
      rubric: { supported: "Claim is directly supported by supplied fragments within the same scope.", contradicted: "Supplied fragments contradict the Claim.", insufficient: "Fragments do not establish the Claim or scope." } };
    return { status: "ready", packet, packet_digest: digest(packet) };
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
   * A supported Host review may promote current source-backed Knowledge in one
   * step.  This is distinct from routing an Experience/Workflow: being
   * `reviewed` makes a Claim available to Context, but never widens an Action
   * Contract or grants an effect.
   */
  hostReview(args: JsonObject): JsonObject {
    const claim = this.store.get("knowledge_claim", text(args.claim_id, "claim_id"));
    const hostKind = text(args.host_kind ?? "codex", "host_kind");
    if (!new Set(["codex", "claude", "independent"]).has(hostKind)) throw new Error("host_kind must be codex, claude, or independent");
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
    if (packetDigest !== null) {
      const packet = this.reviewPacket({ claim_id: claim.id });
      if (packet.status !== "ready" || packet.packet_digest !== packetDigest) throw new Error("packet_digest must match the exact semantic review packet");
    }
    const priorReviewId = claim.status === "reviewed" && typeof (claim.review as JsonObject | undefined)?.review_id === "string"
      ? String((claim.review as JsonObject).review_id) : null;
    const priorReview = priorReviewId ? this.store.find("knowledge_host_review", priorReviewId) : null;
    if (priorReview) return { review: priorReview, claim, promoted: false, idempotent: true, status: "already_reviewed", blocking_reasons: [] };
    const credibleEvidence = Array.isArray(claim.evidence_ids) && claim.evidence_ids.some((id) => {
      const evidence = this.store.find("evidence", String(id));
      return evidence && ["bounded", "confirmed"].includes(String(evidence.confidence));
    });
    const blockingReasons: string[] = [];
    if (claim.status !== "candidate" && claim.status !== "reviewed") blockingReasons.push(`claim_status_${String(claim.status)}`);
    if (source.status !== "active" || source.trust === "untrusted") blockingReasons.push("source_not_trusted_active");
    if (!credibleEvidence) blockingReasons.push("credible_evidence_missing");
    if (!claimContentIsIntact(this.store, claim)) blockingReasons.push("content_reference_invalid");
    if (claim.valid_until && Date.parse(String(claim.valid_until)) < now) blockingReasons.push("claim_expired");
    const contradictions = this.store.list("knowledge_relation", 10_000, (relation) => relation.relation === "contradicts" && (relation.from_claim_id === claim.id || relation.to_claim_id === claim.id));
    if (contradictions.length) blockingReasons.push("contradiction_requires_adjudication");

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
    });
    const promotable = decision === "supported" && !blockingReasons.length;
    if (!promotable || claim.status === "reviewed") {
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
      metadata: { review_id: review.id, source_id: source.id, source_digest: sourceDigest, host_kind: hostKind, host_run_key: hostRunKey, model_ref: modelRef, rubric_id: rubricId, reason_code: reasonCode },
    });
    // `promotable` already proves this is an array containing credible Evidence.
    const evidenceIds = [...new Set([...(claim.evidence_ids as unknown[]).map(String), String(evidence.id)])].sort();
    const reviewedClaim = this.store.save("knowledge_claim", String(claim.id), {
      ...payload(claim), evidence_ids: evidenceIds, status: "reviewed",
      review: {
        reviewer: `host:${hostKind}`, review_id: review.id, host_run_key: hostRunKey, model_ref: modelRef,
        rubric_id: rubricId, source_digest: sourceDigest, packet_digest: packetDigest, reason_code: reasonCode,
        reviewed_at: new Date(now).toISOString(), automated: true, host_attested: true,
      },
    });
    return { review, evidence, claim: reviewedClaim, promoted: true, idempotent: existing !== null, status: "reviewed", blocking_reasons: [] };
  }

  assess(args: JsonObject = {}): JsonObject {
    const claimIds = args.claim_ids === undefined
      ? this.store.list("knowledge_claim", 10_000).map((claim) => String(claim.id))
      : (() => {
        if (!Array.isArray(args.claim_ids) || !args.claim_ids.length) throw new Error("claim_ids must be a non-empty array");
        return [...new Set(args.claim_ids.map((id) => text(id, "claim_ids")))].sort();
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
    return { assessments, summary, auto_promote: autoPromote, policy, reviewer: "automated-promotion-policy" };
  }

  private assessOne(claimId: string, now: number, autoPromote: boolean, policy: PromotionPolicy): JsonObject {
    const claim = this.store.get("knowledge_claim", claimId);
    const reasons: string[] = [];
    let verdict: Verdict;
    if (claim.status === "reviewed") verdict = "already_reviewed";
    else if (claim.status !== "candidate") { verdict = "rejected"; reasons.push(`claim_status_${String(claim.status)}`); }
    else {
      const sourceId = typeof claim.source_id === "string" ? claim.source_id : null;
      const source = sourceId ? this.store.find("knowledge_source", sourceId) : null;
      const evidenceIds = Array.isArray(claim.evidence_ids) ? claim.evidence_ids.map(String) : [];
      const credibleEvidence = evidenceIds.filter((id) => {
        const evidence = this.store.find("evidence", id);
        return evidence && ["bounded", "confirmed"].includes(String(evidence.confidence));
      });
      if (String(claim.scope ?? "").startsWith("legacy:")) reasons.push("legacy_scope_requires_live_revalidation");
      if (!sourceId) reasons.push("source_missing");
      else if (!source) reasons.push("source_not_registered");
      else if (source.status !== "active" || source.trust === "untrusted") reasons.push("source_not_trusted_active");
      if (!credibleEvidence.length) reasons.push("credible_evidence_missing");
      const supports = this.supports(claim);
      const independentSupport = supports.filter((support) => {
        const evidence = this.store.find("evidence", String(support.evidence_id));
        return evidence && ["bounded", "confirmed"].includes(String(evidence.confidence))
          && CONFIDENCE_ORDER[String(evidence.confidence) as Confidence] >= CONFIDENCE_ORDER[policy.minimum_confidence];
      });
      if (independentSupport.length < policy.minimum_independent_support) reasons.push("independent_support_below_threshold");
      if (!claimContentIsIntact(this.store, claim)) reasons.push("content_reference_invalid");
      if (claim.valid_until && Date.parse(String(claim.valid_until)) < now) reasons.push("claim_expired");
      const contradicts = this.store.list("knowledge_relation", 10_000, (relation) => relation.relation === "contradicts" && (relation.from_claim_id === claim.id || relation.to_claim_id === claim.id));
      if (contradicts.length) reasons.push("contradiction_requires_adjudication");
      verdict = reasons.length ? "revalidation_required" : "eligible";
    }
    const identity = { claim_id: claim.id, claim_version: claim.version, claim_status: claim.status, claim_identity_digest: claim.identity_digest ?? null, verdict, reasons, policy_id: policy.id, policy_revision: policy.revision };
    const reviewId = `knowledge_auto_review_${String(claim.id)}_${digest(identity).slice(-16)}`;
    const existing = this.store.find("knowledge_auto_review", reviewId);
    const review = existing ?? this.store.create("knowledge_auto_review", reviewId, { ...identity, identity_digest: digest(identity), automated: true, reviewed_at: new Date(now).toISOString() });
    let reviewedClaim: JsonObject | null = null;
    // Automated promotion is deliberately narrow: only current, non-legacy claims
    // with an active Source and credible Evidence can use it.  The result remains
    // auditable through both this review record and the normal Claim review field.
    if (autoPromote && policy.automatic && verdict === "eligible") {
      reviewedClaim = this.store.save("knowledge_claim", String(claim.id), { ...payload(claim), status: "reviewed", review: { reviewer: "automated-promotion-policy", reason_digest: digest({ review_id: review.id, verdict, policy_id: policy.id, policy_revision: policy.revision }), reviewed_at: new Date(now).toISOString(), automated: true, policy_id: policy.id, policy_revision: policy.revision } });
    }
    return { claim_id: claim.id, claim_version: claim.version, verdict, reasons, review, claim: reviewedClaim ?? claim, promoted: reviewedClaim !== null, independent_support: this.supports(claim).length, required_independent_support: policy.minimum_independent_support, idempotent: existing !== null };
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
}
