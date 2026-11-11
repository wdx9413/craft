import type { JsonObject } from "../infrastructure/store.ts";
import { CraftOperationError } from "../operation-error.ts";
import { CONTEXT_TOOL_INTENTS } from "./tool-schema.ts";
import { ACTIVE_TOOLS } from "./tool-catalog.ts";
import { estimateTokens } from "../token-budget.ts";
import { parseToolName } from "../tool-plane.ts";

type ContextToolIntent = typeof CONTEXT_TOOL_INTENTS[number];
const DISCOVERY_TOOL_NAMES = ["craft_context_open", "craft_context_tools_discover", "craft_info"] as const;
const MAX_DISCOVERY_LIMIT = 5;
const TASK_TOOLS: Record<ContextToolIntent, string[]> = {
  recall: ["craft_context_directory_resolve", "craft_context_open", "craft_context_resolution_resolve", "craft_context_resolution_feedback",
    "craft_context_routing_render", "craft_context_ephemeral_record", "craft_context_ephemeral_search", "craft_context_ephemeral_purge",
    "craft_context_output_capture", "craft_context_compute", "craft_context_resume_checkpoint", "craft_context_resume_get",
    "craft_context_resume_resolve", "craft_context_stats", "craft_context_health", "craft_context_doctor", "craft_context_usage_statusline", "craft_capability_iteration_plan", "craft_capability_iteration_gaps", "craft_activation_proof_doctor",
    "craft_context_correction_list", "craft_context_correction_decide"],
  knowledge: ["craft_knowledge_search", "craft_knowledge_bootstrap_install", "craft_knowledge_source_list", "craft_knowledge_source_register", "craft_knowledge_source_ingest", "craft_knowledge_storage_reconcile", "craft_knowledge_scenario_list", "craft_knowledge_scenario_retire", "craft_knowledge_scenario_migration_propose", "craft_evidence_record", "craft_knowledge_claim_save", "craft_knowledge_session_evidence_record", "craft_knowledge_claim_get", "craft_knowledge_claim_list", "craft_knowledge_semantic_review_packet", "craft_knowledge_host_review", "craft_knowledge_auto_review", "craft_knowledge_promotion_policy_get", "craft_knowledge_evaluation_case_save", "craft_knowledge_evaluation_case_list", "craft_knowledge_evaluation_run", "craft_knowledge_evaluation_run_get", "craft_knowledge_evaluation_run_list", "craft_knowledge_task_effect_context", "craft_knowledge_task_effect_assess"],
  memory: ["craft_memory_governance", "craft_memory_capture_observed_fact", "craft_memory_capture_user_statement", "craft_memory_candidate_review", "craft_memory_ledger_remember_approved", "craft_memory_ledger_get", "craft_memory_ledger_list", "craft_memory_ledger_transition", "craft_memory_conflict_list", "craft_memory_conflict_resolve", "craft_memory_maintenance_run", "craft_memory_session_finalize"],
  experience: ["craft_experience_scenario_list", "craft_experience_scenario_retire", "craft_experience_scenario_migration_propose", "craft_learning_cycle_finalize", "craft_experience_observe", "craft_scope_identity_resolve_project", "craft_evaluation_model_profile_get", "craft_evaluation_model_ticket_list", "craft_experience_procedure_submit", "craft_experience_procedure_get", "craft_experience_learning_request_get", "craft_experience_learning_evaluation_dispatch", "craft_experience_learning_evaluation_dispatch_list", "craft_experience_learning_evaluation_run", "craft_experience_learning_evaluation_result", "craft_experience_graph_inspect", "craft_experience_graph_edit", "craft_procedure_plan", "craft_procedure_host_control", "craft_procedure_decision_evaluate", "craft_procedure_invocation_bind", "craft_procedure_invocation_dispatch", "craft_procedure_invocation_report", "craft_procedure_gate", "craft_procedure_invocation_get", "craft_procedure_invocation_transition", "craft_procedure_invocation_resume"],
  code: ["craft_codebase_symbol_find", "craft_codebase_symbol_explore", "craft_codebase_symbol_read", "craft_codebase_symbols_overview", "craft_codebase_callers_find", "craft_codebase_callers_query", "craft_codebase_relations_find", "craft_codebase_impact_query", "craft_codebase_change_impact", "craft_codebase_trace", "craft_codebase_context_slice"],
  "code-analysis": ["craft_codebase_symbol_find", "craft_codebase_symbol_explore", "craft_codebase_symbol_read", "craft_codebase_symbols_overview", "craft_codebase_callers_find", "craft_codebase_callers_query", "craft_codebase_relations_find", "craft_codebase_definition_find", "craft_codebase_control_flow_query", "craft_codebase_data_flow_query", "craft_codebase_diagnostics_find", "craft_lsp_readiness", "craft_codebase_impact_query", "craft_codebase_change_impact", "craft_codebase_trace", "craft_codebase_context_slice"],
};

export const CONTEXT_ROUTED_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...Object.values(TASK_TOOLS).flat(),
  "craft_activation_proof_doctor", "craft_context_doctor", "craft_context_usage_statusline", "craft_capability_iteration_plan", "craft_capability_iteration_gaps", "craft_lsp_readiness",
  ...ACTIVE_TOOLS.filter(tool => tool.name.startsWith("craft_codebase_")).map(tool => tool.name),
]);

/** Discovery returns schemas that compact Hosts can invoke through craft_run. */
export function discoverContextTools(args: JsonObject): JsonObject {
  const intent = String(args.intent ?? "recall");
  if (!Object.hasOwn(TASK_TOOLS, intent)) throw new CraftOperationError("INVALID_INPUT", "input_validation",
    "Unsupported Context tool intent", { field: "intent", allowed: [...CONTEXT_TOOL_INTENTS] });
  const selectedIntent = intent as ContextToolIntent;
  const requestedLimit = args.limit;
  const bounded = requestedLimit !== undefined;
  const limit = bounded ? Number(requestedLimit) : Number.POSITIVE_INFINITY;
  if (bounded && (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DISCOVERY_LIMIT)) throw new CraftOperationError("INVALID_INPUT", "input_validation",
    "Context tool discovery limit is invalid", { field: "limit", minimum: 1, maximum: MAX_DISCOVERY_LIMIT });
  const names = new Set([...(TASK_TOOLS.recall!), ...TASK_TOOLS[selectedIntent]!]);
  const candidates = ACTIVE_TOOLS.filter(tool => names.has(tool.name));
  const preferred = candidates.filter(tool => (DISCOVERY_TOOL_NAMES as readonly string[]).includes(tool.name));
  const ordered = bounded ? [...preferred, ...candidates.filter(tool => !preferred.includes(tool))] : candidates;
  const tools = ordered.slice(0, limit).map(tool => {
    const { resource, operation } = parseToolName(tool.name);
    return { ...tool, syscall_route: { tool: "craft_run", arguments: { resource, operation, args: {} } } };
  });
  return { intent, ...(bounded ? { limit } : {}), total_candidates: candidates.length, omitted_count: candidates.length - tools.length,
    tools, schema_estimated_tokens: estimateTokens(JSON.stringify(tools)), exact: false,
    changes_host_registration: false, route_contract: "Call craft_run with the returned resource and operation; put operation arguments under args." };
}
