import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { stableDigest } from "./digest.ts";
import { object, text } from "./validation.ts";
import { ontologyActivationResolve } from "./ontology-activation.ts";
import { ontologyClassificationGet } from "./ontology-classification.ts";

/** Freeze already recorded classifications for an exact candidate and scope. */
export function ontologyClassificationProjectionBuild(store: CraftStore, args: JsonObject): JsonObject {
  const ontologyId = text(args.ontology_id, "ontology_id");
  const ontology = store.get("ontology_version", ontologyId, args.ontology_record_version === undefined ? undefined : Number(args.ontology_record_version));
  const scope = object(args.scope, "scope"), scopeKind = text(scope.kind, "scope.kind"), scopeId = text(scope.id, "scope.id");
  if (scopeKind !== "project" && scopeKind !== "global") throw new Error("scope.kind must be project or global");
  const claims = store.list("knowledge_claim", 100_000, (claim) => scopeKind === "global"
    ? claim.scope === "global" : claim.scope === `project:${scopeId}` || claim.scope === "global");
  const classifications: JsonObject[] = [];
  for (const claim of claims) {
    const history = ontologyClassificationGet(store, { claim_id: String(claim.id) }).revisions as JsonObject[];
    const revision = history.findLast((item) => item.ontology_digest === ontology.ontology_digest);
    if (revision) classifications.push({ claim_id: String(claim.id), claim_version: Number(claim.version), revision_id: revision.id });
  }
  classifications.sort((left, right) => String(left.claim_id).localeCompare(String(right.claim_id)));
  const identity = { ontology_id: String(ontology.id), ontology_version: Number(ontology.version), ontology_digest: String(ontology.identity_digest),
    scope: { kind: scopeKind, id: scopeId }, classifications };
  const projectionDigest = stableDigest(identity), id = `ontology_projection_${projectionDigest.slice(-24)}`;
  const existing = store.find("ontology_classification_projection", id);
  if (existing) return { projection: existing, idempotent: true };
  const projection = store.create("ontology_classification_projection", id, { ...identity, projection_digest: projectionDigest,
    raw_content_stored: false, created_at: args.created_at === undefined ? new Date().toISOString() : text(args.created_at, "created_at") });
  return { projection, idempotent: false };
}

/** Read the query-visible classification selected by the active scoped pointer. */
export function ontologyClassificationGetActive(store: CraftStore, args: JsonObject): JsonObject {
  const baseline = ontologyClassificationGet(store, args);
  const activation = ontologyActivationResolve(store, { project_scope_id: text(args.project_scope_id, "project_scope_id"),
    ...(args.cohort_id === undefined ? {} : { cohort_id: text(args.cohort_id, "cohort_id") }),
    ...(args.global_scope_id === undefined ? {} : { global_scope_id: text(args.global_scope_id, "global_scope_id") }) });
  const claimId = text(args.claim_id, "claim_id"), claimVersion = Number(baseline.claim_version);
  if (activation.status !== "active" || !activation.projection_ref || typeof activation.projection_ref !== "object") {
    const claim = store.get("knowledge_claim", claimId, args.claim_version === undefined ? undefined : Number(args.claim_version));
    return { ...baseline, effective_classification: { ontology_version: "legacy",
      concept_kind: typeof claim.concept_kind === "string" && claim.concept_kind.trim() ? claim.concept_kind : text(claim.kind, "claim.kind"), revision_id: null },
      activation: { status: "compatibility_baseline", selected_stage: null, pointer_id: null, pointer_revision: null, pointer_ref: null, projection_ref: null } };
  }
  const projectionRef = activation.projection_ref as JsonObject;
  const projection = store.get(String(projectionRef.kind), String(projectionRef.id), Number(projectionRef.version));
  const expectedDigest = String(projection.projection_digest ?? projection.identity_digest ?? "");
  if (expectedDigest !== projectionRef.digest) throw new Error("Active Ontology classification projection digest changed");
  const entries = Array.isArray(projection.classifications) ? projection.classifications as JsonObject[] : [];
  const entry = entries.find((item) => item.claim_id === claimId && Number(item.claim_version) === claimVersion);
  const revisionId = entry && typeof entry.revision_id === "string" ? entry.revision_id : null;
  const revision = revisionId ? (baseline.revisions as JsonObject[]).find((item) => item.id === revisionId) : undefined;
  const claim = store.get("knowledge_claim", claimId, args.claim_version === undefined ? undefined : Number(args.claim_version));
  return { ...baseline, effective_classification: revision
    ? { ontology_version: revision.ontology_version, concept_kind: revision.concept_kind, revision_id: revision.id }
    : { ontology_version: "legacy", concept_kind: typeof claim.concept_kind === "string" && claim.concept_kind.trim() ? claim.concept_kind : text(claim.kind, "claim.kind"), revision_id: null },
  activation: { status: activation.status, selected_stage: activation.selected_stage,
    pointer_id: (activation.pointer as JsonObject).id, pointer_revision: Number((activation.pointer as JsonObject).pointer_revision),
    pointer_ref: { kind: "ontology_activation_pointer", id: String((activation.pointer as JsonObject).id), version: Number((activation.pointer as JsonObject).version),
      digest: String((activation.pointer as JsonObject).identity_digest) }, projection_ref: activation.projection_ref } };
}
