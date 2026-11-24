import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { catalogOwner } from "./infrastructure/owned-catalog.ts";
import { contextReadinessDoctor, type ContextDoctorSources } from "./context-readiness-doctor.ts";
import { buildCapabilityIterationPlan } from "./capability-iteration-plan.ts";
import type { EvaluationContractKernel } from "./evaluation-contract.ts";
import { validateJsonSchema, type JsonValue } from "./json-schema.ts";
import { projectIdentityFromRoot, ScopeIdentityKernel } from "./scope-identity.ts";
import { text } from "./validation.ts";

const CONTROL_PLANE = ["context_readiness_doctor", "capability_iteration_plan", "context_tools_discover", "correction_status_contract",
  "task_ledger_schema", "migration_dry_run", "activation_profile_plan", "quality_canary_plan", "skill_closeout"] as const;
const SAFETY = { automatic_apply_allowed: false, execution_context: false, generated_without_writes: true, content_free: true };

const refText = { type: "string", minLength: 1, maxLength: 2_000 };
export const EFFECT_EVALUATION_REF_SCHEMA = {
  type: "object", required: ["contract_id", "evaluation_id", "candidate_ref"], additionalProperties: false,
  properties: {
    contract_id: refText, evaluation_id: refText,
    candidate_ref: {
      type: "object", required: ["kind", "id", "version", "digest"], additionalProperties: false,
      properties: { kind: refText, id: refText, version: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, digest: refText },
    },
  },
};

type EffectEvaluationRef = Required<Parameters<EvaluationContractKernel["verifyTaskEffectEvaluation"]>[0]>;
interface GapSources extends ContextDoctorSources { evaluation?: EvaluationContractKernel }
type GapStatus = "resolved" | "runtime_pending" | "evidence_pending" | "authorization_pending" | "owner_unavailable";

function gap(status: GapStatus, id: string, reason: string, nextAction: string): JsonObject {
  return { id, status, reason, next_action: nextAction };
}

function identityFailure(status: string, issue?: JsonObject): JsonObject {
  return { status, project_scope_id: null, gaps: issue ? [issue] : [], unresolved_count: 1, ...SAFETY };
}

function effectGap(scope: JsonObject, raw: unknown, evaluation: GapSources["evaluation"]): JsonObject | null {
  if (!evaluation) return gap("owner_unavailable", "controlled_task_effect", "The Eval owner is unavailable.", "mount_eval_owner");
  if (raw !== undefined) {
    try {
      validateJsonSchema(raw as JsonValue, EFFECT_EVALUATION_REF_SCHEMA);
      const ref = raw as EffectEvaluationRef;
      const contract = evaluation.store.get("evaluation_contract", ref.contract_id);
      const contractScope = contract.scope as JsonObject | undefined;
      if (contractScope?.kind === scope.kind && contractScope?.id === scope.id) {
        const verified = evaluation.verifyTaskEffectEvaluation(ref);
        if (verified.eligible === true) return null;
      }
    } catch {
      // Unknown, malformed or inaccessible evidence leaves the effect unverified.
    }
  }
  return gap("evidence_pending", "controlled_task_effect", "An eligible candidate-bound evaluation in this scope is required.",
    "freeze_contract_then_run_three_pair_screening_and_at_least_five_pairs_for_effect_decision");
}

function contextUsageGap(contextStore: CraftStore | null, scope: JsonObject, context: JsonObject): JsonObject | null {
  const unavailable = () => gap("owner_unavailable", "context_usage", "The Context owner data is unavailable.", "restore_context_owner_access");
  if (!contextStore || context.emissions === null || context.feedback === null) return unavailable();
  const matches = (record: JsonObject) => {
    const recordScope = record.scope as JsonObject | undefined;
    return recordScope?.kind === scope.kind && recordScope?.id === scope.id;
  };
  try {
    const present = scope.kind === "global"
      ? Number(context.emissions) > 0 && Number(context.feedback) > 0
      : contextStore.list("context_emission", 1, matches, false).length > 0
        && contextStore.list("context_feedback", 1, matches, false).length > 0;
    if (present) return null;
  } catch { return unavailable(); }
  return gap("evidence_pending", "context_usage", "Durable injection or feedback evidence is missing for this scope.",
    "run_real_host_turns_and_record_asset_ref_usage_and_token_measurement");
}

export function capabilityIterationGaps(store: CraftStore, args: JsonObject = {}, sources: GapSources = {}): JsonObject {
  const requestedScope = args.project_scope_id === undefined ? null : text(args.project_scope_id, "project_scope_id");
  let projectScope = requestedScope ?? "global";
  let projectRoot: string | undefined;
  let identity: JsonObject | undefined;
  if (args.project_root !== undefined) {
    try {
      identity = projectIdentityFromRoot(text(args.project_root, "project_root"));
    } catch { return identityFailure("identity_unresolved"); }
    projectScope = String((identity.canonical_scope as JsonObject).id);
    if (requestedScope !== null && requestedScope !== projectScope) return identityFailure("identity_conflict");
    projectRoot = String(identity.local_path_alias);
  }

  const own = catalogOwner(store.paths.databaseDir);
  const contextStore = sources.stores?.get("context") ?? (own === "context" || (sources.stores === undefined && own === undefined) ? store : null);
  if (identity) {
    if (!contextStore) return identityFailure("owner_unavailable");
    let diagnosis: JsonObject;
    try { diagnosis = new ScopeIdentityKernel(contextStore).diagnoseProject(identity); }
    catch { return identityFailure("owner_unavailable"); }
    if (diagnosis.status === "migration_required") return identityFailure("identity_unresolved",
      gap("authorization_pending", "project_identity_migration", "A legacy project identity requires migration review.",
        "backup_then_review_and_explicitly_authorize_apply_migrations"));
    if (diagnosis.status !== "current") return identityFailure("identity_unresolved");
  }

  const scope = { kind: projectScope === "global" ? "global" : "project", id: projectScope };
  const doctor = contextReadinessDoctor(store, { ...args, project_root: projectRoot, project_scope_id: projectScope }, sources);
  const activation = doctor.activation as JsonObject;
  const migration = doctor.migration as JsonObject;
  const remediation = [
    gap("resolved", "diagnostic_errors", "Dispatch failures now expose stable codes and bounded messages.", "none"),
    gap("resolved", "readiness_doctor", "Doctor separates configured state from observed Host execution and worker state.", "none"),
    gap("resolved", "minimal_sufficient_context", "Context planning keeps refs, versions, digests, constraints and omission reasons first.", "none"),
    gap("resolved", "task_ledger_schema", "Sanitized task-ledger schema and threshold checks are available read-only.", "none"),
    gap("resolved", "governed_quality_plan", "Activation, Quality and Canary stages are explicit without automatic publication.", "none"),
  ];
  if (migration.state === "applied" && migration.data_migrated !== true) remediation.push(
    gap("authorization_pending", "business_data_migration", "Registry migration does not import business records or authority.",
      "inventory_then_plan_selected_record_refs_before_explicit_apply"));
  const usage = contextUsageGap(contextStore, scope, doctor.context as JsonObject);
  if (usage) remediation.push(usage);
  if (!contextStore) remediation.push(gap("owner_unavailable", "project_asset_recurrence", "The Context owner is unavailable.", "mount_context_owner"));
  else {
    const plan = args.records === undefined
      ? doctor.iteration_plan as JsonObject
      : buildCapabilityIterationPlan(contextStore, { project_scope_id: projectScope, records: args.records });
    const learning = plan.learning_record as JsonObject | undefined;
    if (learning?.outcome !== "project_candidate_ready_for_paired_assessment") remediation.push(
      gap("evidence_pending", "project_asset_recurrence", "No exact asset has verified use across two independent sessions.",
        "capture_two_verified_uses_of_the_same_asset_across_independent_sessions"));
  }
  const effect = effectGap(scope, args.effect_evaluation_ref, sources.evaluation);
  if (effect) remediation.push(effect);
  if (activation.status === "owner_unavailable") remediation.push(
    gap("owner_unavailable", "hook_execution_proof", "The Hook proof owners are unavailable.", "mount_hook_proof_owners"));
  else if ((activation.components as JsonObject[]).some(item => item.status !== "executed")) remediation.push(
    gap("runtime_pending", "hook_execution_proof", "Configuration and installed manifests do not prove a Hook executed in this session.",
      "run_one_real_host_turn_then_recheck_this_session"));

  const workers = doctor.learning_workers as Record<string, JsonObject>;
  const learningWorkers = Object.fromEntries(Object.entries(workers).map(([component, worker]) => [component, {
    status: worker.status, owner_version: worker.owner_version ?? null, version_relation: worker.version_relation ?? "unknown",
    liveness: worker.liveness ?? "unverified",
  }]));
  const unresolved = remediation.filter(item => item.status !== "resolved");
  return {
    status: unresolved.length ? "partial" : "resolved",
    project_scope_id: projectScope,
    runtime: { version: doctor.release, source: "mcp_runtime", learning_workers: learningWorkers },
    control_plane: { implemented: CONTROL_PLANE, missing_subcapabilities: [] },
    capability_boundary: "No fifth Context member, vector store, reranker, autonomous publisher or self-modifying Agent is missing; adding them would widen the governed boundary without evidence.",
    gaps: remediation,
    unresolved_count: unresolved.length,
    ...SAFETY,
  };
}
