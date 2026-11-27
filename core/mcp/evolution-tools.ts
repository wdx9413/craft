/** Context tools requiring a project binding issued by the Host hook. */
export const PROJECT_EVOLUTION_TOOLS = [
  "craft_experience_trace_distill",
  "craft_evolution_program_memory_capture", "craft_evolution_program_memory_list", "craft_evolution_program_memory_get",
  "craft_evolution_domain_capture", "craft_evolution_failure_capture",
  "craft_evolution_program_memory_submit", "craft_evolution_program_memory_submission_due", "craft_evolution_program_memory_promote", "craft_evolution_program_memory_feedback",
  "craft_evolution_artifact_lineage_record", "craft_evolution_artifact_lineage_recall",
  "craft_evolution_artifact_lineage_apply", "craft_evolution_artifact_lineage_forget",
  "craft_evolution_prospective_create", "craft_evolution_prospective_fire",
  "craft_evolution_prospective_list", "craft_evolution_prospective_revoke",
  "craft_evolution_research_link", "craft_evolution_research_capture", "craft_evolution_research_recall",
  "craft_evolution_research_impact", "craft_evolution_research_forget", "craft_evolution_replication_propose",
  "craft_evolution_travel_capture", "craft_evolution_travel_recall", "craft_evolution_travel_apply", "craft_evolution_travel_forget",
  "craft_evolution_creation_write", "craft_evolution_creation_recall", "craft_evolution_creation_apply", "craft_evolution_creation_forget",
] as const;

export const PROJECT_EVOLUTION_TOOL_NAMES: ReadonlySet<string> = new Set(PROJECT_EVOLUTION_TOOLS);

/** Existing Context and Experience routes that may address a Program Memory-backed asset. */
export const PROJECT_BOUND_EXPERIENCE_TOOLS = [
  "craft_context_open", "craft_context_resolution_resolve", "craft_context_working_set_resolve",
  "craft_experience_learning_request_get", "craft_experience_procedure_submit", "craft_experience_procedure_get",
  "craft_experience_procedure_projection_get", "craft_experience_procedure_projection_list", "craft_experience_procedure_projection_draft",
  "craft_experience_procedure_gate", "craft_experience_procedure_skill_export",
  "craft_experience_learning_evaluation_dispatch", "craft_experience_learning_evaluation_dispatch_list",
  "craft_experience_learning_evaluation_dispatch_next", "craft_experience_learning_work_item_get",
  "craft_experience_learning_work_item_block", "craft_experience_learning_work_item_resume",
  "craft_experience_learning_work_item_evaluation_contract_bind",
  "craft_experience_learning_evaluation_run", "craft_experience_learning_evaluation_result",
  "craft_experience_asset_inspect", "craft_experience_asset_restore", "craft_experience_graph_edit", "craft_experience_graph_inspect",
  "craft_procedure_plan", "craft_procedure_configuration_save", "craft_procedure_create", "craft_procedure_get", "craft_procedure_list",
  "craft_procedure_export_skill", "craft_procedure_gate", "craft_procedure_host_control", "craft_procedure_decision_evaluate",
  "craft_procedure_invocation_bind", "craft_procedure_invocation_dispatch", "craft_procedure_invocation_report", "craft_procedure_invocation_resume",
  "craft_procedure_invocation_transition", "craft_procedure_invocation_get", "craft_procedure_invocation_evaluate",
] as const;

export const PROJECT_BOUND_EXPERIENCE_TOOL_NAMES: ReadonlySet<string> = new Set(PROJECT_BOUND_EXPERIENCE_TOOLS);
