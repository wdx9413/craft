import { createHash, randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

function id(prefix: string): string { return `${prefix}_${randomUUID().replaceAll("-", "")}`; }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function integer(value: unknown, name: string, minimum = 1): number { const result = Number(value); if (!Number.isInteger(result) || result < minimum) throw new Error(`${name} must be an integer at least ${minimum}`); return result; }
function records(value: unknown, name: string): JsonObject[] { if (!Array.isArray(value)) throw new Error(`${name} must be an array`); return value.map((item) => { if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${name} must contain objects`); return item as JsonObject; }); }
function uniqueTextArray(value: unknown, name: string, minimum = 1): string[] { if (!Array.isArray(value)) throw new Error(`${name} must be an array`); const result = value.map((item) => text(item, name)); if (result.length < minimum || new Set(result).size !== result.length) throw new Error(`${name} must contain at least ${minimum} unique values`); return result; }
function recordPayload(record: JsonObject): JsonObject { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...payload } = record; return payload; }
function assertNoSecret(value: string, name: string): string { if (/(?:api[_-]?key|authorization|cookie|password|secret|token)["']?\s*[:=]\s*[^\s]+/iu.test(value)) throw new Error(`${name} must not contain sensitive assignments`); return value; }

const SKILL_TARGETS = new Set(["codex-cli", "claude-code", "deepseek-harness", "generic-mcp"]);
const WORKFLOW_TARGETS = new Set(["craft-workflow"]);

/**
 * Governs the last mile from an evidence-backed Wiki candidate to a portable,
 * human-imported package. It deliberately has no filesystem or Host execution
 * dependency: delivery is reviewable before an adapter is ever introduced.
 */
export class WikiCandidateGovernanceKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  private claimsCurrent(candidate: JsonObject): void {
    const refs = records(candidate.claim_refs, "Wiki candidate claim_refs");
    if ([refs.length < 2, new Set(refs.map((ref) => `${ref.claim_id}@${ref.claim_version}`)).size !== refs.length].some(Boolean)) throw new Error("Wiki candidate requires unique claim references");
    for (const ref of refs) {
      const claim = this.store.get("knowledge_claim", text(ref.claim_id, "claim_ref.claim_id"));
      if ([Number(claim.version) !== integer(ref.claim_version, "claim_ref.claim_version"), claim.status !== "reviewed"].some(Boolean)) throw new Error("Wiki candidate Claim drifted or is no longer reviewed");
      for (const evidenceId of uniqueTextArray(claim.evidence_ids, "claim.evidence_ids")) this.store.get("evidence", evidenceId);
    }
  }

  private evaluationProof(candidate: JsonObject, candidateVersion: number, args: JsonObject): JsonObject {
    this.claimsCurrent(candidate);
    const knowledgeRun = this.store.get("knowledge_evaluation_run", text(args.knowledge_evaluation_run_id, "knowledge_evaluation_run_id"));
    if ([knowledgeRun.status !== "eligible", Number((knowledgeRun.metrics as JsonObject).candidate_leaks) !== 0].some(Boolean)) throw new Error("Wiki candidate requires an eligible leak-free knowledge evaluation");
    const evaluation = this.store.get("evaluation_run", text(args.evaluation_run_id, "evaluation_run_id"));
    if ([evaluation.split !== "held_out", evaluation.verdict !== "passed", evaluation.subject_type !== "wiki_skill_candidate", evaluation.subject_id !== candidate.id, Number(evaluation.subject_version) !== candidateVersion].some(Boolean)) throw new Error("Wiki candidate requires a passed held-out evaluation for its exact version");
    const signoff = this.store.get("signoff", text(args.signoff_id, "signoff_id"));
    if ([signoff.decision !== "passed", signoff.evaluation_run_id !== evaluation.id, signoff.subject_type !== "wiki_skill_candidate", signoff.subject_id !== candidate.id, Number(signoff.subject_version) !== candidateVersion].some(Boolean)) throw new Error("Wiki candidate requires a passed Signoff for its exact held-out evaluation");
    return { candidate_id: candidate.id, candidate_version: candidateVersion, candidate_identity_digest: candidate.identity_digest, knowledge_evaluation_run_id: knowledgeRun.id, knowledge_evaluation_run_version: knowledgeRun.version, evaluation_run_id: evaluation.id, signoff_id: signoff.id };
  }

  attest(args: JsonObject): JsonObject {
    const candidate = this.store.get("wiki_skill_candidate", text(args.candidate_id, "candidate_id"));
    const attestationId = String(args.attestation_id ?? id("wiki_candidate_evaluation")); const existing = this.store.find("wiki_candidate_evaluation_attestation", attestationId);
    if (existing) {
      if ([existing.candidate_id !== candidate.id, existing.knowledge_evaluation_run_id !== text(args.knowledge_evaluation_run_id, "knowledge_evaluation_run_id"), existing.evaluation_run_id !== text(args.evaluation_run_id, "evaluation_run_id"), existing.signoff_id !== text(args.signoff_id, "signoff_id")].some(Boolean)) throw new Error("Wiki candidate evaluation attestation idempotency conflict");
      return { attestation: existing, candidate, idempotent: true };
    }
    if (candidate.status !== "ready_for_evaluation") throw new Error("Wiki candidate must be ready_for_evaluation before attestation");
    const proof = this.evaluationProof(candidate, Number(candidate.version), args); const identity = { ...proof };
    const attestation = this.store.create("wiki_candidate_evaluation_attestation", attestationId, { ...identity, identity_digest: digest(identity), status: "passed" });
    const saved = this.store.save("wiki_skill_candidate", String(candidate.id), { ...recordPayload(candidate), status: "evaluation_passed", evaluation_attestation_id: attestation.id, evaluated_candidate_version: candidate.version });
    return { attestation, candidate: saved, idempotent: false };
  }

  authorize(args: JsonObject): JsonObject {
    const candidate = this.store.get("wiki_skill_candidate", text(args.candidate_id, "candidate_id"));
    const authorizationId = String(args.authorization_id ?? id("wiki_candidate_publication")); const existing = this.store.find("wiki_candidate_publication_authorization", authorizationId);
    if (existing) {
      if ([existing.candidate_id !== candidate.id, existing.attestation_id !== text(args.attestation_id, "attestation_id"), existing.reviewer !== text(args.reviewer, "reviewer"), existing.reason_digest !== digest(assertNoSecret(text(args.reason, "reason"), "reason"))].some(Boolean)) throw new Error("Wiki candidate publication authorization idempotency conflict");
      return { authorization: existing, candidate, idempotent: true };
    }
    if (candidate.status !== "evaluation_passed") throw new Error("Wiki candidate must have a passed evaluation before publication authorization");
    const attestation = this.store.get("wiki_candidate_evaluation_attestation", text(args.attestation_id, "attestation_id"));
    if ([attestation.candidate_id !== candidate.id, attestation.candidate_identity_digest !== candidate.identity_digest, attestation.status !== "passed"].some(Boolean)) throw new Error("Wiki candidate evaluation attestation drifted");
    const proof = this.evaluationProof(candidate, integer(attestation.candidate_version, "attestation.candidate_version"), attestation);
    const reviewer = text(args.reviewer, "reviewer"); const reason = assertNoSecret(text(args.reason, "reason"), "reason");
    const identity = { ...proof, attestation_id: attestation.id, reviewer, reason_digest: digest(reason) };
    const authorization = this.store.create("wiki_candidate_publication_authorization", authorizationId, { ...identity, identity_digest: digest(identity), publication_allowed: true, execution_authority: false });
    const saved = this.store.save("wiki_skill_candidate", String(candidate.id), { ...recordPayload(candidate), status: "publication_authorized", publication_authorization_id: authorization.id, publication_allowed: true, execution_authority: false, publication_review: { reviewer, reason_digest: identity.reason_digest, authorized_at: new Date().toISOString() } });
    return { authorization, candidate: saved, idempotent: false };
  }

  packagePrepare(args: JsonObject): JsonObject {
    const candidate = this.store.get("wiki_skill_candidate", text(args.candidate_id, "candidate_id"));
    if (candidate.status !== "publication_authorized") throw new Error("Wiki candidate must be publication_authorized before preparing a package");
    const authorization = this.store.get("wiki_candidate_publication_authorization", text(args.authorization_id, "authorization_id"));
    if ([authorization.candidate_id !== candidate.id, authorization.candidate_identity_digest !== candidate.identity_digest, authorization.publication_allowed !== true, authorization.execution_authority !== false].some(Boolean)) throw new Error("Wiki candidate publication authorization drifted");
    const attestation = this.store.get("wiki_candidate_evaluation_attestation", text(authorization.attestation_id, "authorization.attestation_id"));
    if ([attestation.candidate_id !== candidate.id, attestation.status !== "passed"].some(Boolean)) throw new Error("Wiki candidate evaluation attestation drifted");
    const proof = this.evaluationProof(candidate, integer(attestation.candidate_version, "attestation.candidate_version"), attestation);
    const targetHost = text(args.target_host, "target_host"); const allowedTargets = candidate.kind === "skill" ? SKILL_TARGETS : WORKFLOW_TARGETS;
    if (!allowedTargets.has(targetHost)) throw new Error("Publication target is incompatible with the Wiki candidate kind");
    const content = [
      `# ${text(candidate.title, "candidate.title")}`,
      "",
      "## Applicability",
      text(candidate.applicability, "candidate.applicability"),
      "",
      candidate.kind === "skill" ? "## Instructions" : "## Workflow instructions",
      text(candidate.instructions, "candidate.instructions"),
      "",
      "## Fallback",
      text(candidate.fallback_condition, "candidate.fallback_condition"),
      "",
      "## Evidence references",
      ...(records(candidate.claim_refs, "candidate.claim_refs").map((ref) => `- ${text(ref.claim_id, "claim_ref.claim_id")}@${integer(ref.claim_version, "claim_ref.claim_version")}`)),
    ].join("\n");
    const packageId = String(args.package_id ?? id("wiki_candidate_package")); const identity = { ...proof, authorization_id: authorization.id, target_host: targetHost, package_format: `craft.portable-${candidate.kind}.v1`, content_digest: digest(content) };
    const existing = this.store.find("wiki_candidate_publication_package", packageId);
    if (existing) { if (existing.identity_digest !== digest(identity)) throw new Error("Wiki candidate publication package idempotency conflict"); return { package: existing, idempotent: true }; }
    const packageRecord = this.store.create("wiki_candidate_publication_package", packageId, { ...identity, identity_digest: digest(identity), content, manual_import_required: true, execution_authority: false, status: "prepared" });
    return { package: packageRecord, idempotent: false };
  }
}
