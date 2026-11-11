import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { contextReadinessDoctor } from "./context-readiness-doctor.ts";
import { buildCapabilityIterationPlan } from "./capability-iteration-plan.ts";

const CONTROL_PLANE = ["context_readiness_doctor", "capability_iteration_plan", "context_tools_discover", "correction_status_contract",
  "task_ledger_schema", "migration_dry_run", "activation_profile_plan", "quality_canary_plan", "skill_closeout"] as const;

function missingCapabilities(): string[] { return []; }

function gap(status: "resolved" | "runtime_pending" | "evidence_pending" | "authorization_pending", id: string, reason: string, nextAction: string): JsonObject {
  return { id, status, reason, next_action: nextAction };
}

export function capabilityIterationGaps(store: CraftStore, args: JsonObject = {}): JsonObject {
  const projectScope = typeof args.project_scope_id === "string" && args.project_scope_id.trim() ? args.project_scope_id.trim() : "global";
  const doctor = contextReadinessDoctor(store, { ...args, project_scope_id: projectScope });
  const plan = buildCapabilityIterationPlan(store, { ...args, project_scope_id: projectScope });
  const context = doctor.context as JsonObject;
  const activation = doctor.activation as JsonObject;
  const learning = plan.learning_record as JsonObject;
  const remediation = [
    gap("resolved", "diagnostic_errors", "Dispatch failures now expose stable codes and bounded messages.", "none"),
    gap("resolved", "readiness_doctor", "Doctor separates configured state from observed Host execution and worker state.", "none"),
    gap("resolved", "minimal_sufficient_context", "Context planning keeps refs, versions, digests, constraints and omission reasons first.", "none"),
    gap("resolved", "task_ledger_schema", "Sanitized task-ledger schema and threshold checks are available read-only.", "none"),
    gap("resolved", "governed_quality_plan", "Activation, Quality and Canary stages are explicit without automatic publication.", "none"),
    gap("runtime_pending", "codex_plugin_cache", "The installed Codex plugin cache is an older build until a new marketplace package is installed.",
      "build_and_install_new_marketplace_package_then_restart_host"),
    gap("authorization_pending", "project_identity_migration", "Old project scope is fail-closed and may not enter Context.",
      "backup_then_review_and_explicitly_authorize_apply_migrations"),
  ];
  if ((plan.migration as JsonObject).status === "registry_plan_observed") remediation.push(
    gap("authorization_pending", "business_data_migration", "Registry migration does not import business records or authority.",
      "inventory_then_plan_selected_record_refs_before_explicit_apply"));
  if (Number(context.emissions ?? 0) === 0 || Number(context.feedback ?? 0) === 0) remediation.push(
    gap("evidence_pending", "context_usage", "No durable injection/feedback evidence is present in this data space.",
      "run_real_host_turns_and_record_asset_ref_usage_and_token_measurement"));
  if (learning.outcome === "inconclusive") remediation.push(
    gap("evidence_pending", "controlled_task_effect", "Independent sanitized Host task effects are not available.",
      "collect_at_least_20_records_from_two_sessions_then_run_equal_budget_baseline_candidate_pairs"));
  if ((activation.components as JsonObject[] | undefined)?.some(item => item.status !== "executed")) remediation.push(
    gap("runtime_pending", "hook_execution_proof", "Configuration and installed manifests do not prove a Hook executed in this session.",
      "run_one_real_host_turn_then_recheck_this_session"));
  const unresolved = remediation.filter(item => item.status !== "resolved");
  return {
    status: unresolved.length ? "partial" : "resolved",
    project_scope_id: projectScope,
    control_plane: { implemented: CONTROL_PLANE, missing_subcapabilities: missingCapabilities() },
    capability_boundary: "No fifth Context member, vector store, reranker, autonomous publisher or self-modifying Agent is missing; adding them would widen the governed boundary without evidence.",
    gaps: remediation,
    unresolved_count: unresolved.length,
    automatic_apply_allowed: false,
    execution_context: false,
    generated_without_writes: true,
  };
}
