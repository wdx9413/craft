import type { JsonObject } from "../infrastructure/store.ts";
import { ACTIVE_TOOLS } from "./tool-catalog.ts";
import { estimateTokens } from "../token-budget.ts";

const TASK_TOOLS: Record<string, string[]> = {
  recall: ["craft_context_open", "craft_context_resolution_feedback"],
  knowledge: ["craft_knowledge_search", "craft_knowledge_bootstrap_install", "craft_knowledge_source_list", "craft_knowledge_source_register", "craft_knowledge_source_ingest", "craft_knowledge_scenario_list", "craft_knowledge_scenario_retire", "craft_knowledge_scenario_migration_propose", "craft_evidence_record", "craft_knowledge_claim_save", "craft_knowledge_claim_get", "craft_knowledge_claim_list", "craft_knowledge_semantic_review_packet", "craft_knowledge_host_review", "craft_knowledge_auto_review", "craft_knowledge_promotion_policy_get", "craft_knowledge_evaluation_case_save", "craft_knowledge_evaluation_case_list", "craft_knowledge_evaluation_run", "craft_knowledge_evaluation_run_get", "craft_knowledge_evaluation_run_list"],
  memory: ["craft_memory_governance", "craft_memory_capture_observed_fact", "craft_memory_capture_user_statement", "craft_memory_candidate_review", "craft_memory_ledger_remember_approved", "craft_memory_ledger_get", "craft_memory_ledger_list", "craft_memory_ledger_transition", "craft_memory_conflict_list", "craft_memory_conflict_resolve", "craft_memory_maintenance_run", "craft_memory_session_finalize"],
  experience: ["craft_experience_scenario_list", "craft_experience_scenario_retire", "craft_experience_scenario_migration_propose", "craft_learning_cycle_finalize", "craft_evaluation_model_profile_get", "craft_evaluation_model_ticket_list", "craft_experience_procedure_submit", "craft_experience_procedure_get", "craft_experience_learning_request_get", "craft_experience_learning_evaluation_dispatch", "craft_experience_learning_evaluation_dispatch_list", "craft_experience_learning_evaluation_run", "craft_experience_learning_evaluation_result", "craft_experience_graph_inspect", "craft_experience_graph_edit", "craft_procedure_plan", "craft_procedure_host_control", "craft_procedure_decision_evaluate", "craft_procedure_invocation_bind", "craft_procedure_invocation_dispatch", "craft_procedure_invocation_report", "craft_procedure_gate", "craft_procedure_invocation_get", "craft_procedure_invocation_transition", "craft_procedure_invocation_resume"],
  code: ["craft_codebase_symbol_find", "craft_codebase_symbol_explore", "craft_codebase_symbol_read", "craft_codebase_symbols_overview", "craft_codebase_callers_find", "craft_codebase_relations_find", "craft_codebase_impact_query", "craft_codebase_context_slice"],
  "code-analysis": ["craft_codebase_symbol_find", "craft_codebase_symbol_explore", "craft_codebase_symbol_read", "craft_codebase_symbols_overview", "craft_codebase_callers_find", "craft_codebase_relations_find", "craft_codebase_definition_find", "craft_codebase_control_flow_query", "craft_codebase_data_flow_query", "craft_codebase_diagnostics_find", "craft_codebase_impact_query", "craft_codebase_context_slice"],
};

/** Discovery is a small recommended subset. Existing Host tool registrations stay compatible. */
export function discoverContextTools(args: JsonObject): JsonObject {
  const intent = String(args.intent ?? "recall");
  if (!Object.hasOwn(TASK_TOOLS, intent)) throw new Error("Unsupported Context tool intent");
  const names = new Set([...(TASK_TOOLS.recall!), ...TASK_TOOLS[intent]!]);
  const tools = ACTIVE_TOOLS.filter(tool => names.has(tool.name));
  return { intent, tools, schema_estimated_tokens: estimateTokens(JSON.stringify(tools)), exact: false, changes_host_registration: false };
}
