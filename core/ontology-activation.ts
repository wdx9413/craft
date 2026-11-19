import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { stableDigest } from "./digest.ts";
import { object, text } from "./validation.ts";

type ExactRef = { kind: string; id: string; version: number; digest: string };
type ActivationStage = "shadow" | "small-scope" | "project" | "global";
type ActivationScope = { kind: "project" | "global"; id: string };
type Verifier = { verify(input: JsonObject): JsonObject };
type ControlAuthorizer = { authorize(input: JsonObject): boolean };

const POINTER_KIND = "ontology_activation_pointer";
const STAGES = new Set<ActivationStage>(["shadow", "small-scope", "project", "global"]);

function positiveVersion(value: unknown, name: string): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error(`${name} must be a positive integer`);
  return version;
}

function scope(value: unknown): ActivationScope {
  const input = object(value, "scope"), kind = text(input.kind, "scope.kind"), id = text(input.id, "scope.id");
  if (kind !== "project" && kind !== "global") throw new Error("scope.kind must be project or global");
  return { kind, id };
}

function ref(value: unknown, name: string, kind: string): ExactRef {
  const input = object(value, name), actualKind = text(input.kind, `${name}.kind`), id = text(input.id, `${name}.id`);
  const version = positiveVersion(input.version, `${name}.version`), digest = text(input.digest, `${name}.digest`);
  if (actualKind !== kind) throw new Error(`${name}.kind must be ${kind}`);
  return { kind: actualKind, id, version, digest };
}

function recordDigest(record: JsonObject, fields: string[], name: string): string {
  for (const field of fields) if (typeof record[field] === "string" && String(record[field]).length > 0) return String(record[field]);
  throw new Error(`${name} has no immutable digest`);
}

function exactRecord(store: CraftStore, reference: ExactRef, digestFields: string[], name: string): JsonObject {
  const record = store.get(reference.kind, reference.id, reference.version);
  if (recordDigest(record, digestFields, name) !== reference.digest) throw new Error(`${name} digest does not match its immutable record`);
  return record;
}

function stage(value: unknown): ActivationStage {
  const result = text(value, "stage") as ActivationStage;
  if (!STAGES.has(result)) throw new Error("stage is unsupported");
  return result;
}

function streamKey(target: ActivationScope, rolloutStage: ActivationStage, cohortId: string | null): string {
  if (rolloutStage === "small-scope") return `${target.kind}:${target.id}:cohort:${cohortId}`;
  return `${target.kind}:${target.id}:${rolloutStage}`;
}

function history(store: CraftStore, key: string): JsonObject[] {
  const entries = store.list(POINTER_KIND, 100_000, (entry) => entry.stream_key === key)
    .sort((left, right) => Number(left.pointer_revision) - Number(right.pointer_revision));
  let previous: string | null = null;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (Number(entry.pointer_revision) !== index + 1 || entry.previous_event_id !== previous
      || typeof entry.identity_digest !== "string" || entry.identity_digest !== stableDigest(pointerIdentity(entry))) {
      throw new Error("Ontology activation pointer history is corrupt");
    }
    previous = String(entry.id);
  }
  return entries;
}

function pointerIdentity(record: JsonObject): JsonObject {
  const keys = ["stream_key", "pointer_revision", "previous_event_id", "previous_effective_pointer_id", "action", "stage", "scope",
    "cohort_id", "candidate_ref", "classification_projection_ref", "evaluation_contract_ref", "evaluation_result_ref",
    "target_pointer_id", "reason", "verified", "verification_receipt"];
  const result: JsonObject = {};
  for (const key of keys) if (record[key] !== undefined) result[key] = record[key];
  return result;
}

function effectiveFromEvent(store: CraftStore, event: JsonObject | undefined): JsonObject | null {
  if (!event) return null;
  if (event.action === "activate" && event.verified === true && event.stage !== "shadow") return event;
  if (event.action !== "rollback" && event.action !== "revoke") return null;
  if (typeof event.target_pointer_id !== "string") return null;
  const target = store.find(POINTER_KIND, event.target_pointer_id);
  return target?.action === "activate" && target.verified === true && target.stream_key === event.stream_key ? target : null;
}

function currentEffective(store: CraftStore, entries: JsonObject[]): JsonObject | null {
  return effectiveFromEvent(store, entries.at(-1));
}

function requestedStream(store: CraftStore, target: ActivationScope, rolloutStage: ActivationStage, cohortId: string | null): JsonObject[] {
  return history(store, streamKey(target, rolloutStage, cohortId));
}

function verifyActivation(verifier: Verifier | undefined, input: JsonObject, rolloutStage: ActivationStage,
  target: ActivationScope, cohortId: string | null): JsonObject {
  if (!verifier || typeof verifier.verify !== "function") throw new Error("Ontology activation requires a trusted evaluation verifier");
  const result = object(verifier.verify(input), "evaluation_verification");
  const candidate = object(input.candidate_ref, "candidate_ref"), contract = object(input.evaluation_contract_ref, "evaluation_contract_ref");
  const proofCandidate = object(result.candidate_ref, "evaluation_verification.candidate_ref");
  const proofContract = object(result.evaluation_contract_ref, "evaluation_verification.evaluation_contract_ref");
  const proofScope = object(result.scope, "evaluation_verification.scope");
  const proof = text(result.verification_receipt, "evaluation_verification.verification_receipt");
  if (result.verified !== true || result.verdict !== "passed" || result.evaluation_digest !== (input.evaluation_result_ref as JsonObject).digest
    || proofCandidate.kind !== candidate.kind || proofCandidate.id !== candidate.id || Number(proofCandidate.version) !== Number(candidate.version)
    || proofCandidate.digest !== candidate.digest || proofContract.id !== contract.id || Number(proofContract.version) !== Number(contract.version)
    || proofContract.digest !== contract.digest || proofScope.kind !== target.kind || proofScope.id !== target.id) {
    throw new Error("Ontology activation evaluation receipt does not bind the exact candidate, contract, report and scope");
  }
  if (rolloutStage !== "shadow" && (result.eligible !== true || result.routeable !== true))
    throw new Error("Only eligible routeable Ontology evaluations can affect a live projection");
  if (rolloutStage === "global" && result.global_authorized !== true)
    throw new Error("Global Ontology activation requires an independently authorized global evaluation");
  if (rolloutStage === "small-scope" && (result.cohort_authorized !== true || result.cohort_id !== cohortId))
    throw new Error("Small-scope Ontology activation requires an authorized exact cohort");
  return { verified: true, verification_receipt: proof };
}

function append(store: CraftStore, args: JsonObject, action: string, extras: JsonObject = {}): JsonObject {
  return store.transaction(() => {
    const target = scope(args.scope), rolloutStage = stage(args.stage), cohortId = args.cohort_id === undefined ? null : text(args.cohort_id, "cohort_id");
    const key = streamKey(target, rolloutStage, cohortId), entries = history(store, key), last = entries.at(-1);
    const expected = args.expected_pointer_revision === undefined ? Number(last?.pointer_revision ?? 0) : Number(args.expected_pointer_revision);
    if (!Number.isSafeInteger(expected) || expected !== Number(last?.pointer_revision ?? 0)) throw new Error("Ontology activation pointer revision changed; reload before retrying");
    const requestId = text(args.request_id, "request_id"), id = `ontology_pointer_${requestId}`;
    const candidate = args.candidate_ref === undefined ? null : ref(args.candidate_ref, "candidate_ref", "ontology_version");
    const projection = args.classification_projection_ref === undefined ? null : ref(args.classification_projection_ref, "classification_projection_ref", "ontology_classification_projection");
    const contract = args.evaluation_contract_ref === undefined ? null : ref(args.evaluation_contract_ref, "evaluation_contract_ref", "evaluation_contract");
    const report = args.evaluation_result_ref === undefined ? null : ref(args.evaluation_result_ref, "evaluation_result_ref", "task_effect_evaluation");
    const existing = store.find(POINTER_KIND, id);
    if (existing) {
      if (existing.request_digest !== stableDigest({ action, args, extras })) throw new Error("Ontology activation request id was reused with different content");
      return { ...existing, idempotent: true };
    }
    const current = currentEffective(store, entries);
    const identity = { stream_key: key, pointer_revision: entries.length + 1, previous_event_id: last ? String(last.id) : null,
      previous_effective_pointer_id: current ? String(current.id) : null, action, stage: rolloutStage, scope: target,
      cohort_id: cohortId, ...(candidate ? { candidate_ref: candidate } : {}), ...(projection ? { classification_projection_ref: projection } : {}),
      ...(contract ? { evaluation_contract_ref: contract } : {}), ...(report ? { evaluation_result_ref: report } : {}),
      target_pointer_id: extras.target_pointer_id ?? null, reason: extras.reason ?? null,
      verified: extras.verified === true, verification_receipt: extras.verification_receipt as string };
    const identityDigest = stableDigest(identity), requestDigest = typeof extras.request_digest_override === "string"
      ? extras.request_digest_override : stableDigest({ action, args, extras });
    const createdAt = args.created_at === undefined ? new Date().toISOString() : text(args.created_at, "created_at");
    const created = store.create(POINTER_KIND, id, { ...identity, identity_digest: identityDigest, request_digest: requestDigest,
      raw_content_stored: false, created_at: createdAt });
    return { ...created, idempotent: false };
  });
}

/** Append a shadow or active pointer after exact candidate/evaluation verification. */
export function ontologyActivationSet(store: CraftStore, args: JsonObject, verifier?: Verifier): JsonObject {
  const target = scope(args.scope), rolloutStage = stage(args.stage);
  const cohortId = args.cohort_id === undefined ? null : text(args.cohort_id, "cohort_id");
  if (rolloutStage === "small-scope" && (target.kind !== "project" || cohortId === null))
    throw new Error("Small-scope activation requires a project scope and cohort_id");
  if (rolloutStage === "project" && target.kind !== "project") throw new Error("Project activation requires a project scope");
  if (rolloutStage === "global" && target.kind !== "global") throw new Error("Global activation requires a global scope");
  if (rolloutStage !== "small-scope" && cohortId !== null) throw new Error("cohort_id is valid only for small-scope activation");
  const candidateRef = ref(args.candidate_ref, "candidate_ref", "ontology_version");
  const projectionRef = ref(args.classification_projection_ref, "classification_projection_ref", "ontology_classification_projection");
  const contractRef = ref(args.evaluation_contract_ref, "evaluation_contract_ref", "evaluation_contract");
  const reportRef = ref(args.evaluation_result_ref, "evaluation_result_ref", "task_effect_evaluation");
  const candidate = exactRecord(store, candidateRef, ["identity_digest", "ontology_digest"], "Ontology candidate");
  const projection = exactRecord(store, projectionRef, ["projection_digest", "identity_digest"], "Ontology classification projection");
  const contract = exactRecord(store, contractRef, ["contract_digest", "identity_digest"], "Ontology Evaluation Contract");
  const report = exactRecord(store, reportRef, ["evaluation_digest"], "Ontology task-effect report");
  if (report.contract_id !== contract.id || report.candidate_ref === undefined) throw new Error("Ontology report does not bind its exact contract and candidate");
  const reportCandidate = object(report.candidate_ref, "evaluation_result.candidate_ref");
  if (reportCandidate.kind !== candidateRef.kind || reportCandidate.id !== candidateRef.id || Number(reportCandidate.version) !== candidateRef.version
    || reportCandidate.digest !== candidateRef.digest) throw new Error("Ontology report candidate binding is not exact");
  const contractScope = object(contract.scope, "evaluation_contract.scope");
  if (contractScope.kind !== target.kind || contractScope.id !== target.id) throw new Error("Ontology Evaluation Contract does not match the activation scope");
  const projectionScope = object(projection.scope, "classification_projection.scope");
  if (projectionScope.kind !== target.kind || projectionScope.id !== target.id || projection.ontology_digest !== candidateRef.digest)
    throw new Error("Ontology classification projection does not bind the candidate and exact activation scope");
  const verificationInput = { scope: target, stage: rolloutStage, cohort_id: cohortId, candidate_ref: candidateRef,
    classification_projection_ref: projectionRef, evaluation_contract_ref: contractRef, evaluation_result_ref: reportRef };
  const verification = verifyActivation(verifier, verificationInput, rolloutStage, target, cohortId);
  return append(store, { ...args, scope: target, stage: rolloutStage, cohort_id: cohortId ?? undefined,
    candidate_ref: candidateRef, classification_projection_ref: projectionRef, evaluation_contract_ref: contractRef,
    evaluation_result_ref: reportRef }, "activate", verification);
}

function authorizeControl(authorizer: ControlAuthorizer | undefined, input: JsonObject): void {
  if (!authorizer || typeof authorizer.authorize !== "function" || authorizer.authorize(input) !== true)
    throw new Error("Ontology pointer rollback or revocation requires trusted Runtime authorization");
}

function control(store: CraftStore, args: JsonObject, action: "rollback" | "revoke", authorizer?: ControlAuthorizer): JsonObject {
  const activeId = text(args.active_pointer_id, "active_pointer_id"), active = store.get(POINTER_KIND, activeId);
  if (active.action !== "activate" || active.verified !== true || active.stage === "shadow") throw new Error("Only a verified active Ontology pointer can be rolled back or revoked");
  const target = scope(active.scope), rolloutStage = stage(active.stage), cohortId = active.cohort_id === null ? null : text(active.cohort_id, "pointer.cohort_id");
  const requestId = text(args.request_id, "request_id"), reason = text(args.reason, "reason"), actor = text(args.actor, "actor");
  const targetId = args.target_pointer_id === undefined ? active.previous_effective_pointer_id : text(args.target_pointer_id, "target_pointer_id");
  const verificationReceipt = args.verification_receipt === undefined ? `runtime-control:${actor}` : text(args.verification_receipt, "verification_receipt");
  const expectedRevision = args.expected_pointer_revision === undefined ? Number(active.pointer_revision) : Number(args.expected_pointer_revision);
  const requestDigest = stableDigest({ action, active_pointer_id: active.id, target_pointer_id: targetId ?? null, reason, actor,
    scope: target, expected_pointer_revision: expectedRevision, verification_receipt: verificationReceipt });
  const existing = store.find(POINTER_KIND, `ontology_pointer_${requestId}`);
  if (existing) {
    if (existing.request_digest !== requestDigest) throw new Error("Ontology activation request id was reused with different content");
    return { ...existing, idempotent: true };
  }
  const entries = requestedStream(store, target, rolloutStage, cohortId), latest = currentEffective(store, entries);
  if (latest?.id !== active.id) throw new Error("Ontology pointer is no longer active");
  const targetPointer = targetId === null || targetId === undefined ? null : store.get(POINTER_KIND, String(targetId));
  if (targetPointer && (targetPointer.action !== "activate" || targetPointer.verified !== true || targetPointer.stream_key !== active.stream_key))
    throw new Error("Rollback target must be a previously verified pointer in the same activation scope");
  if (action === "rollback" && !targetPointer) throw new Error("Ontology rollback requires a previously verified pointer target");
  authorizeControl(authorizer, { action, actor, active_pointer_id: active.id, target_pointer_id: targetPointer?.id ?? null, scope: target,
    stage: rolloutStage, cohort_id: cohortId, reason, request_id: requestId, expected_pointer_revision: expectedRevision });
  const revision = Number(entries.at(-1)!.pointer_revision);
  return append(store, { request_id: args.request_id, scope: target, stage: rolloutStage, cohort_id: cohortId ?? undefined,
    expected_pointer_revision: args.expected_pointer_revision ?? revision, created_at: args.created_at }, action,
  { target_pointer_id: targetPointer?.id ?? null, reason, verified: true, verification_receipt: verificationReceipt,
    request_digest_override: requestDigest });
}

/** Append a control revision pointing at a previous verified projection. */
export function ontologyActivationRollback(store: CraftStore, args: JsonObject, authorizer?: ControlAuthorizer): JsonObject {
  return control(store, args, "rollback", authorizer);
}

/** Revoke the exact active pointer and fall back to its previous verified pointer or compatibility baseline. */
export function ontologyActivationRevoke(store: CraftStore, args: JsonObject, authorizer?: ControlAuthorizer): JsonObject {
  return control(store, args, "revoke", authorizer);
}

/** Resolve the live classification projection for one read without changing historical classifications. */
export function ontologyActivationResolve(store: CraftStore, args: JsonObject): JsonObject {
  const projectId = text(args.project_scope_id, "project_scope_id");
  const cohortId = args.cohort_id === undefined ? null : text(args.cohort_id, "cohort_id");
  const projectCohort = cohortId === null ? null : currentEffective(store,
    requestedStream(store, { kind: "project", id: projectId }, "small-scope", cohortId));
  const project = currentEffective(store, requestedStream(store, { kind: "project", id: projectId }, "project", null));
  const globalId = args.global_scope_id === undefined ? "craft" : text(args.global_scope_id, "global_scope_id");
  const global = currentEffective(store, requestedStream(store, { kind: "global", id: globalId }, "global", null));
  const selected = projectCohort ?? project ?? global;
  if (!selected) return { status: "compatibility_baseline", pointer: null, projection_ref: null, scope: { kind: "project", id: projectId } };
  return { status: "active", pointer: selected, projection_ref: selected.classification_projection_ref,
    scope: selected.scope, selected_stage: selected.stage };
}
