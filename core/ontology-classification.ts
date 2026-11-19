import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { appendClassificationRevision, createOntologyVersion, type ClassificationRevision, type OntologyVersion } from "craft-common-ontology";
import { EvaluationContractKernel } from "./evaluation-contract.ts";
import { stableDigest } from "./digest.ts";
import { object, text } from "./validation.ts";

type Ref = { kind: string; id: string; version: number; digest?: string };
type CycleReader = { get(args: JsonObject): JsonObject };
type EvaluationVerifier = { verifyTaskEffectEvaluation(input: JsonObject): JsonObject };

function ref(value: unknown, name: string): Ref {
  const input = object(value, name), kind = text(input.kind, `${name}.kind`), id = text(input.id, `${name}.id`), version = Number(input.version);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error(`${name}.version must be a positive integer`);
  return { kind, id, version, ...(input.digest === undefined ? {} : { digest: text(input.digest, `${name}.digest`) }) };
}

function ontologyPayload(record: JsonObject): OntologyVersion {
  const ontology = createOntologyVersion({ contract_version: record.contract_version, version: record.ontology_version,
    parent_digest: record.parent_digest, concept_kinds: record.concept_kinds, relation_kinds: record.relation_kinds, digest: record.ontology_digest });
  if (ontology.digest !== record.ontology_digest) throw new Error("Stored Ontology digest does not match its content");
  return ontology;
}

function routeableContractFor(store: CraftStore, evaluation: JsonObject, candidate: Ref, projectScopeId: string, injectedVerifier?: EvaluationVerifier): JsonObject {
  const candidateRef = object(evaluation.candidate_ref, "task-effect evaluation.candidate_ref");
  const currentCandidate = store.get(candidate.kind, candidate.id, candidate.version);
  if (candidate.kind !== "ontology_version" || candidateRef.kind !== candidate.kind || candidateRef.id !== candidate.id
    || Number(candidateRef.version) !== candidate.version || candidateRef.digest !== currentCandidate.identity_digest) {
    throw new Error("Task-effect evaluation does not prove the exact eligible Ontology candidate");
  }
  const contract = store.get("evaluation_contract", text(evaluation.contract_id, "task-effect evaluation.contract_id"));
  const taskEffect = object(contract.task_effect, "evaluation_contract.task_effect");
  const scope = object(contract.scope, "evaluation_contract.scope");
  const history = Array.isArray(contract.stage_history) ? contract.stage_history as JsonObject[] : [];
  const hasReceipt = (stage: string) => history.some((entry) => entry.stage === stage && entry.verification === "trusted"
    && Array.isArray(entry.evidence) && entry.evidence.includes(String(evaluation.id)));
  if (contract.effect !== "task_effect" || contract.capability_id !== "craft.ontology.classification"
    || contract.verified_stage !== "routeable" || taskEffect.candidate_family !== candidate.kind
    || scope.kind !== "project" || scope.id !== projectScopeId || !hasReceipt("business_eligible") || !hasReceipt("routeable")) {
    throw new Error("Ontology candidate requires its exact routeable project Evaluation Contract");
  }
  const verifier = injectedVerifier ?? new EvaluationContractKernel(store) as unknown as { verifyTaskEffectEvaluation?: (input: JsonObject) => JsonObject };
  if (typeof verifier.verifyTaskEffectEvaluation !== "function")
    throw new Error("Ontology promotion requires the installed Evaluation Contract verifier capability");
  const verification = verifier.verifyTaskEffectEvaluation({ contract_id: String(contract.id),
    evaluation_id: String(evaluation.id), candidate_ref: { kind: candidate.kind, id: candidate.id,
      version: candidate.version, digest: String(currentCandidate.identity_digest) } });
  if (verification.valid !== true || verification.eligible !== true || verification.routeable !== true
    || verification.evaluation_digest !== evaluation.evaluation_digest || verification.candidate_ref === undefined) {
    throw new Error("Ontology task-effect evaluation signature, provenance, thresholds or routeable binding is invalid");
  }
  return contract;
}

/** Validate the Evaluation Contract result used as an EvolutionCycle held-out evaluation. */
export function assertOntologyTaskEffectEvaluation(store: CraftStore, candidate: Ref, evaluationRef: Ref, projectScopeId: string, verifier?: EvaluationVerifier): JsonObject {
  const exactCandidate = ref(candidate, "candidate_ref"), exactEvaluation = ref(evaluationRef, "evaluation_ref");
  if (exactCandidate.kind !== "ontology_version" || exactEvaluation.kind !== "task_effect_evaluation")
    throw new Error("Ontology promotion requires a task-effect evaluation for an ontology_version candidate");
  const evaluation = store.get(exactEvaluation.kind, exactEvaluation.id, exactEvaluation.version);
  if (exactEvaluation.digest !== undefined && exactEvaluation.digest !== evaluation.evaluation_digest)
    throw new Error("Ontology evaluation reference digest does not match its immutable report");
  const contract = routeableContractFor(store, evaluation, exactCandidate, projectScopeId, verifier);
  if (evaluation.contract_id !== contract.id) throw new Error("Ontology evaluation contract identity mismatch");
  return { evaluation, contract };
}

/** Add Ontology as a Cycle candidate family; the existing contract and cycle remain the only gates. */
export function assertOntologyPromotionAuthority(store: CraftStore, cycle: JsonObject, candidates: Ref[], authorities: Ref[], verifier?: EvaluationVerifier): void {
  if (candidates.length !== 1 || candidates[0]?.kind !== "ontology_version") throw new Error("Ontology promotion requires one exact Ontology candidate");
  const candidate = candidates[0]!;
  const cycleRead = store.events(`evolution:${cycle.id}`).map((event) => event.payload as JsonObject);
  const candidateEvent = [...cycleRead].reverse().find((event) => event.stage === "candidate");
  const candidateIndex = candidateEvent ? cycleRead.indexOf(candidateEvent) : -1;
  const evaluationEvent = candidateIndex < 0 ? undefined : cycleRead.slice(candidateIndex + 1).find((event) => event.stage === "evaluate");
  if (!candidateEvent || !evaluationEvent) throw new Error("Ontology promotion requires prior Cycle candidate and held-out evaluation events");
  const candidateRefs = (candidateEvent.artifact_refs as JsonObject[] | undefined) ?? [];
  if (!candidateRefs.some((item) => item.kind === candidate.kind && item.id === candidate.id && Number(item.version) === candidate.version))
    throw new Error("EvolutionCycle candidate does not bind this exact Ontology version");
  const evalRefs = (evaluationEvent.evaluation_refs as JsonObject[] | undefined) ?? [];
  if (evalRefs.length !== 1) throw new Error("Ontology promotion requires exactly one Cycle evaluation reference");
  const cycleEvaluationRef = ref(evalRefs[0], "evaluation_ref");
  if (cycleEvaluationRef.kind !== "task_effect_evaluation") throw new Error("Ontology Cycle evaluation must be its task-effect report");
  const cycleEvaluation = store.get(cycleEvaluationRef.kind, cycleEvaluationRef.id, cycleEvaluationRef.version);
  if (cycleEvaluationRef.id !== String(cycleEvaluation.id) || cycleEvaluationRef.version !== Number(cycleEvaluation.version))
    throw new Error("EvolutionCycle evaluation reference does not bind its exact task-effect report");
  if (cycleEvaluationRef.digest !== undefined && cycleEvaluationRef.digest !== cycleEvaluation.evaluation_digest)
    throw new Error("EvolutionCycle evaluation reference digest does not match its report");
  const authority = authorities.find((item) => item.kind === "evaluation_contract");
  if (!authority) throw new Error("Ontology promotion requires a routeable Evaluation Contract authority");
  const contract = store.get("evaluation_contract", authority.id, undefined);
  if (Number(contract.version) !== authority.version)
    throw new Error("Ontology promotion authority must reference the exact routeable Evaluation Contract version");
  const taskEffect = object(contract.task_effect, "evaluation_contract.task_effect");
  if (contract.effect !== "task_effect" || contract.capability_id !== "craft.ontology.classification"
    || contract.verified_stage !== "routeable" || taskEffect.candidate_family !== "ontology_version"
    || !object(contract.scope, "evaluation_contract.scope") || (contract.scope as JsonObject).kind !== "project"
    || (contract.scope as JsonObject).id !== cycle.project_scope_id) {
    throw new Error("Ontology candidate requires its exact routeable project Evaluation Contract");
  }
  const contractHistory = Array.isArray(contract.stage_history) ? contract.stage_history as JsonObject[] : [];
  const contractEvaluationIds = contractHistory.filter((entry) => entry.stage === "routeable" && entry.verification === "trusted")
    .flatMap((entry) => Array.isArray(entry.evidence) ? entry.evidence.map(String) : []);
  if (!contractEvaluationIds.includes(String(cycleEvaluation.id))) throw new Error("Cycle held-out report is not the report recorded by the routeable Evaluation Contract");
  if (cycleEvaluation.contract_id !== contract.id) throw new Error("Cycle held-out report belongs to another Evaluation Contract");
  routeableContractFor(store, cycleEvaluation, candidate, String(cycle.project_scope_id), verifier);
}

export function ontologyVersionRegister(store: CraftStore, args: JsonObject): JsonObject {
  const ontology = createOntologyVersion(args.ontology ?? args);
  const scope = object(args.scope ?? { kind: "global", id: "craft" }, "scope");
  text(scope.kind, "scope.kind"); text(scope.id, "scope.id");
  const identity = { contract_version: ontology.contract_version, ontology_version: ontology.version, ontology_digest: ontology.digest,
    parent_digest: ontology.parent_digest, concept_kinds: ontology.concept_kinds, relation_kinds: ontology.relation_kinds, scope };
  const id = `ontology_${stableDigest(identity).slice(-32)}`;
  const identity_digest = stableDigest(identity);
  const existing = store.find("ontology_version", id);
  if (existing) {
    if (existing.identity_digest !== identity_digest) throw new Error("Ontology version idempotency conflict");
    return { ontology: existing, idempotent: true };
  }
  const ontologyRecord = store.create("ontology_version", id, { ...identity, status: "candidate", identity_digest });
  return { ontology: ontologyRecord, idempotent: false };
}

/** Read the latest append-only interpretation without changing the Claim or its retrieval eligibility. */
export function ontologyClassificationGet(store: CraftStore, args: JsonObject): JsonObject {
  const claimId = text(args.claim_id, "claim_id");
  const claim = store.get("knowledge_claim", claimId, args.claim_version === undefined ? undefined : Number(args.claim_version));
  const revisions = classificationHistory(store, claimId);
  const latest = revisions.at(-1);
  const receipts = store.list("ontology_classification_receipt", 10_001, (item) => item.claim_id === claimId);
  if (receipts.length > 10_000) throw new Error("Ontology classification receipt history exceeds its read budget");
  const latestReceipt = receipts.sort((left, right) => Number(right.version) - Number(left.version))[0] ?? null;
  const effective = latest
    ? { ontology_version: latest.ontology_version, concept_kind: latest.concept_kind, revision_id: latest.id }
    : { ontology_version: "legacy", concept_kind: typeof claim.concept_kind === "string" && claim.concept_kind.trim() ? claim.concept_kind : text(claim.kind, "claim.kind"), revision_id: null };
  return { claim_id: claimId, claim_version: claim.version, effective_classification: effective,
    unresolved: latestReceipt?.unresolved ?? null, revisions };
}

function classificationHistory(store: CraftStore, claimId: string): ClassificationRevision[] {
  const rows = store.list("ontology_classification_revision", 10_001, (item) => item.record_id === claimId);
  if (rows.length > 10_000) throw new Error("Ontology classification history exceeds its read budget");
  const byPrevious = new Map<string | null, JsonObject[]>();
  for (const row of rows) {
    const key = row.previous_revision_id === null || row.previous_revision_id === undefined ? null : String(row.previous_revision_id);
    byPrevious.set(key, [...(byPrevious.get(key) ?? []), row]);
  }
  const ordered: ClassificationRevision[] = [];
  let previous: string | null = null;
  while (byPrevious.has(previous)) {
    const next = byPrevious.get(previous)!;
    if (next.length !== 1) throw new Error("Ontology classification history has a fork");
    const row = next[0]! as unknown as ClassificationRevision;
    ordered.push(row); previous = row.id;
    if (ordered.length > rows.length) throw new Error("Ontology classification history has a cycle");
  }
  if (ordered.length !== rows.length) throw new Error("Ontology classification history has a disconnected revision");
  return ordered;
}

function sourceRefs(claim: JsonObject): string[] {
  const values = [...(Array.isArray(claim.source_refs) ? claim.source_refs : []), claim.source_id,
    ...(Array.isArray(claim.evidence_ids) ? claim.evidence_ids : [])].filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
  return [...new Set(values.map((item) => item.trim()))].sort();
}

/** Persist only append-only classifications and receipts. The source Claim body is never rewritten. */
export function ontologyClassificationRecord(store: CraftStore, cycles: CycleReader, args: JsonObject, verifier?: EvaluationVerifier): JsonObject {
  const claimId = text(args.claim_id, "claim_id"), ontologyId = text(args.ontology_id, "ontology_id"), cycleId = text(args.evolution_cycle_id, "evolution_cycle_id");
  const requestedClaimVersion = args.claim_version === undefined ? undefined : Number(args.claim_version);
  const claim = store.get("knowledge_claim", claimId, requestedClaimVersion);
  if (requestedClaimVersion !== undefined && requestedClaimVersion !== Number(store.get("knowledge_claim", claimId).version))
    throw new Error("Classification requires the current stable Claim version");
  const ontologyRecord = store.get("ontology_version", ontologyId, args.ontology_record_version === undefined ? undefined : Number(args.ontology_record_version));
  const ontology = ontologyPayload(ontologyRecord);
  const candidate = { kind: "ontology_version", id: String(ontologyRecord.id), version: Number(ontologyRecord.version) };
  const cycle = cycles.get({ cycle_id: cycleId });
  const cycleRecord = object(cycle.cycle, "evolution_cycle");
  if (cycleRecord.project_scope_id === undefined) throw new Error("EvolutionCycle project scope is required");
  if (text(claim.scope, "knowledge_claim.scope") !== `project:${String(cycleRecord.project_scope_id)}`)
    throw new Error("Ontology classification cannot cross the EvolutionCycle project scope");
  const events = (Array.isArray(cycle.events) ? cycle.events as JsonObject[] : []).map((item) =>
    item.payload && typeof item.payload === "object" ? item.payload as JsonObject : item);
  const promotion = [...events].reverse().find((event) => event.stage === "promote");
  if (!promotion || !events.some((event) => event.stage === "evaluate")) throw new Error("Ontology classification requires a completed EvolutionCycle promote stage");
  assertOntologyPromotionAuthority(store, cycleRecord, [candidate], (promotion.authority_refs as JsonObject[] ?? []).map((item) => ref(item, "authority_ref")), verifier);
  const promotedRefs = (cycleRecord.candidate_refs as JsonObject[] | undefined) ?? [];
  if (!promotedRefs.some((item) => item.kind === candidate.kind && item.id === candidate.id && Number(item.version) === candidate.version))
    throw new Error("EvolutionCycle has not promoted this exact Ontology version");
  const proposal = object(args.proposal, "proposal");
  const requestIdentity = { claim_id: claimId, claim_version: claim.version, ontology_id: ontologyId, ontology_digest: ontology.digest,
    cycle_id: cycleId, proposal, minimum_confidence: args.minimum_confidence ?? 0.8 };
  const receiptId = `ontology_classification_receipt_${stableDigest(requestIdentity).slice(-24)}`;
  const existing = store.find("ontology_classification_receipt", receiptId);
  if (existing) return { receipt: existing, decision: existing.decision, idempotent: true };
  const revisions = classificationHistory(store, claimId);
  const prior = revisions.at(-1);
  const priorClass = prior ? { ontology_version: prior.ontology_version, concept_kind: prior.concept_kind, revision_id: prior.id }
    : { ontology_version: "legacy", concept_kind: typeof claim.concept_kind === "string" && claim.concept_kind.trim() ? claim.concept_kind : text(claim.kind, "claim.kind"), revision_id: null };
  const claimSources = sourceRefs(claim);
  if (!claimSources.length) throw new Error("Ontology classification requires existing source references");
  const decision = appendClassificationRevision({ ontology, record: { id: claimId, statement: text(claim.content, "knowledge_claim.content"),
    source_refs: claimSources, current_classification: priorClass }, revisions,
    proposal: { ...proposal, ontology_version: typeof proposal.ontology_version === "string" && proposal.ontology_version.trim() ? proposal.ontology_version : ontology.version,
      created_at: typeof proposal.created_at === "string" && proposal.created_at.trim() ? proposal.created_at : new Date().toISOString() }, minimum_confidence: args.minimum_confidence });
  const receiptIdentity = { ...requestIdentity, status: decision.status, record_digest: decision.record_digest,
    revision_id: decision.revisions.at(-1)?.id ?? null, unresolved: decision.unresolved };
  return store.transaction(() => {
    const duplicate = store.find("ontology_classification_receipt", receiptId);
    if (duplicate) return { receipt: duplicate, decision: duplicate.decision, idempotent: true };
    if (Number(store.get("knowledge_claim", claimId, undefined).version) !== Number(claim.version))
      throw new Error("Knowledge Claim changed while its classification was being appended");
    if (store.get("ontology_version", ontologyId, undefined).identity_digest !== ontologyRecord.identity_digest)
      throw new Error("Ontology version changed while its classification was being appended");
    if (decision.status === "appended") {
      const revision = decision.revisions.at(-1)!;
      if (!store.find("ontology_classification_revision", revision.id)) store.create("ontology_classification_revision", revision.id, revision as unknown as JsonObject);
    }
    const receipt = store.create("ontology_classification_receipt", receiptId, { ...receiptIdentity, decision,
      effective_classification: decision.effective_classification, unresolved: decision.unresolved });
    return { receipt, decision, idempotent: false };
  });
}
