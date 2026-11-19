import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { object, text } from "./validation.ts";
import { stableDigest, payload, digestJson } from "./digest.ts";
import { EvaluationContractKernel } from "./evaluation-contract.ts";

const TARGETS = new Set(["codex_user_config", "repository_agents"]);
const SCOPES = new Set(["user", "project"]);
const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|access[_-]?token)\s*[:=]\s*[^\s]+/iu;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

export function hostPolicyCandidateRef(input: JsonObject): NonNullable<Parameters<EvaluationContractKernel["verifyTaskEffectEvaluation"]>[0]["candidate_ref"]> {
  const identity = { schema: "craft.host-policy-candidate.v1", target: text(input.target, "target"),
    scope: object(input.scope, "scope"), base_digest: text(input.base_digest, "base_digest"), diff: validateDiff(input.diff) };
  const digest = stableDigest(identity);
  return { kind: "host_policy_candidate", id: `host_policy_candidate_${digest.slice(-24)}`, version: 1, digest };
}

function validateDiff(value: unknown): string {
  const diff = text(value, "diff");
  if (diff.length > 20_000 || CONTROL.test(diff)) throw new Error("diff must be bounded plain text");
  if (SECRET.test(diff)) throw new Error("diff appears to contain a secret");
  if (!diff.includes("--- ") || !diff.includes("+++ ")) throw new Error("diff must include unified diff file headers");
  return diff;
}

/** Stores reviewable host-policy diffs. This kernel has no write/apply operation. */
export class HostPolicyProposalKernel {
  readonly store: CraftStore;
  readonly evaluationContracts: EvaluationContractKernel;
  constructor(store: CraftStore, evaluationContracts = new EvaluationContractKernel(store)) {
    this.store = store;
    this.evaluationContracts = evaluationContracts;
  }

  prepare(raw: JsonObject): JsonObject {
    const target = text(raw.target, "target");
    if (!TARGETS.has(target)) throw new Error("Host policy target is unsupported");
    const scope = object(raw.scope, "scope");
    const scopeKind = text(scope.kind, "scope.kind"), scopeId = text(scope.id, "scope.id");
    if (!SCOPES.has(scopeKind)) throw new Error("Host policy proposal scope must be user or project");
    const baseDigest = text(raw.base_digest, "base_digest");
    if (!/^sha256:[a-f0-9]{64}$/u.test(baseDigest)) throw new Error("base_digest must be a sha256 digest");
    const identity = { schema: "craft.host-policy-candidate.v1", target, scope: { kind: scopeKind, id: scopeId },
      base_digest: baseDigest, diff: validateDiff(raw.diff) };
    const candidateRef = hostPolicyCandidateRef(identity);
    const candidateId = String(candidateRef.id);
    const existing = this.store.find("host_policy_candidate", candidateId);
    if (existing) {
      if (existing.identity_digest !== candidateRef.digest) throw new Error("Host policy candidate identity conflict");
      return { candidate: existing, candidate_ref: candidateRef, idempotent: true, can_apply: false };
    }
    const candidate = this.store.create("host_policy_candidate", candidateId, { ...identity, identity_digest: candidateRef.digest,
      status: "awaiting_independent_evaluation", can_apply: false });
    return { candidate, candidate_ref: candidateRef, idempotent: false, can_apply: false };
  }

  propose(raw: JsonObject): JsonObject {
    const target = text(raw.target, "target");
    if (!TARGETS.has(target)) throw new Error("Host policy target is unsupported");
    const scope = object(raw.scope, "scope");
    const scopeKind = text(scope.kind, "scope.kind");
    const scopeId = text(scope.id, "scope.id");
    if (!SCOPES.has(scopeKind)) throw new Error("Host policy proposal scope must be user or project");
    const baseDigest = text(raw.base_digest, "base_digest");
    if (!/^sha256:[a-f0-9]{64}$/u.test(baseDigest)) throw new Error("base_digest must be a sha256 digest");
    const diff = validateDiff(raw.diff);
    const actor = text(raw.proposed_by, "proposed_by");
    const evaluationContractId = text(raw.evaluation_contract_id, "evaluation_contract_id");
    const evaluationId = text(raw.evaluation_id, "evaluation_id");
    const candidateRef = hostPolicyCandidateRef({ target, scope: { kind: scopeKind, id: scopeId }, base_digest: baseDigest, diff });
    const candidate = this.store.get("host_policy_candidate", String(candidateRef.id));
    if (candidate.identity_digest !== candidateRef.digest || candidate.diff !== diff) throw new Error("Host policy diff changed after candidate preparation");
    const evaluation = this.evaluationContracts.verifyTaskEffectEvaluation({
      contract_id: evaluationContractId, evaluation_id: evaluationId, candidate_ref: candidateRef,
    });
    if (evaluation.valid !== true || evaluation.eligible !== true || evaluation.routeable !== true
      || typeof evaluation.contract_digest !== "string" || typeof evaluation.evaluation_digest !== "string"
      || !evaluation.candidate_ref || typeof evaluation.candidate_ref !== "object"
      || stableDigest(evaluation.candidate_ref) !== stableDigest(candidateRef)) {
      throw new Error("Host policy proposals require a routeable exact task-effect Evaluation Contract and eligible signed result");
    }
    const contract = this.store.get("evaluation_contract", evaluationContractId);
    const evaluationRecord = this.store.get("task_effect_evaluation", evaluationId);
    if (contract.contract_digest !== evaluation.contract_digest || evaluationRecord.evaluation_digest !== evaluation.evaluation_digest
      || evaluationRecord.contract_id !== evaluationContractId) throw new Error("Host policy effect evidence changed after verification");
    const sourceRefs = normalizeRefs(raw.source_refs);
    for (const reference of sourceRefs) this.store.get(String(reference.kind), String(reference.id), Number(reference.version));
    const effectEvidence = { contract_ref: { kind: "evaluation_contract", id: String(contract.id), version: Number(contract.version), digest: String(contract.contract_digest) },
      evaluation_ref: { kind: "task_effect_evaluation", id: String(evaluationRecord.id), version: Number(evaluationRecord.version), digest: String(evaluationRecord.evaluation_digest) },
      candidate_ref: candidateRef };
    const identity = { target, scope: { kind: scopeKind, id: scopeId }, base_digest: baseDigest, diff, effect_evidence: effectEvidence,
      proposed_by: actor, source_refs: sourceRefs };
    const proposalId = raw.proposal_id === undefined ? `host_policy_${stableDigest(identity).slice(-20)}` : text(raw.proposal_id, "proposal_id");
    const existing = this.store.find("host_policy_proposal", proposalId);
    const digest = stableDigest(identity);
    if (existing) {
      if (existing.identity_digest !== digest) throw new Error("Host policy proposal idempotency conflict");
      return { proposal: existing, idempotent: true, can_apply: false };
    }
    const proposal = this.store.create("host_policy_proposal", proposalId, { ...identity, identity_digest: digest,
      status: "review_required", review: null, applied: false, created_at: new Date().toISOString() });
    return { proposal, idempotent: false, can_apply: false };
  }

  review(raw: JsonObject): JsonObject {
    const proposalId = text(raw.proposal_id, "proposal_id");
    const expectedVersion = Number(raw.expected_version);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new Error("expected_version must be a positive integer");
    const decision = text(raw.decision, "decision");
    if (decision !== "accept" && decision !== "reject") throw new Error("decision must be accept or reject");
    const reason = text(raw.reason, "reason");
    const approvalRef = text(raw.approval_ref, "approval_ref");
    const approval = this.store.get("internal_action_approval", approvalRef);
    const approvalArgs = { proposal_id: proposalId, expected_version: expectedVersion, decision, reason };
    if (approval.status !== "consumed" || approval.action !== "host_policy_proposal_review" || approval.effect !== "external_write"
      || approval.args_digest !== digestJson(approvalArgs) || typeof approval.decided_at !== "string") {
      throw new Error("Host policy review requires a consumed Workbench human approval bound to this decision");
    }
    const proposal = this.store.get("host_policy_proposal", proposalId);
    if (Number(proposal.version) !== expectedVersion) throw new Error("Host policy proposal version conflict");
    if (proposal.status !== "review_required") throw new Error("Host policy proposal has already been reviewed");
    const updated = this.store.save("host_policy_proposal", proposalId, { ...payload(proposal),
      status: decision === "accept" ? "accepted_for_manual_application" : "rejected",
      review: { reviewer: "workbench_human", approval_ref: approval.id, decision, reason_digest: stableDigest(reason), reviewed_at: new Date().toISOString() },
      applied: false });
    return { proposal: updated, can_apply: false, application_owner: "user_or_host" };
  }

  get(raw: JsonObject): JsonObject {
    const proposal = this.store.get("host_policy_proposal", text(raw.proposal_id, "proposal_id"));
    return { proposal, can_apply: false, application_owner: "user_or_host" };
  }
}

function normalizeRefs(raw: unknown): JsonObject[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 20) throw new Error("source_refs must be an array of at most 20 references");
  const refs = raw.map((value, index) => {
    const item = object(value, `source_refs[${index}]`);
    return { kind: text(item.kind, `source_refs[${index}].kind`), id: text(item.id, `source_refs[${index}].id`),
      version: Number.isSafeInteger(Number(item.version)) && Number(item.version) > 0 ? Number(item.version) : (() => { throw new Error(`source_refs[${index}].version must be a positive integer`); })() };
  });
  if (new Set(refs.map(item => `${item.kind}:${item.id}:${item.version}`)).size !== refs.length) throw new Error("source_refs must be unique");
  return refs.sort((left, right) => `${left.kind}:${left.id}:${left.version}`.localeCompare(`${right.kind}:${right.id}:${right.version}`));
}
