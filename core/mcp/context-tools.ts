import type { JsonObject } from "../infrastructure/store.ts";
import { ACTIVE_TOOLS } from "./tool-catalog.ts";
import { estimateTokens } from "../token-budget.ts";

const TASK_TOOLS: Record<string, string[]> = {
  recall: ["craft_context_open", "craft_context_resolution_feedback"],
  knowledge: ["craft_knowledge_search", "craft_knowledge_claim_save", "craft_knowledge_host_review", "craft_knowledge_source_ingest"],
  memory: ["craft_memory_governance", "craft_memory_capture_user_statement", "craft_memory_conflict_list", "craft_memory_conflict_resolve", "craft_memory_candidate_review", "craft_memory_ledger_remember_approved"],
  experience: ["craft_experience_graph_inspect", "craft_experience_graph_edit", "craft_procedure_plan", "craft_procedure_host_control", "craft_procedure_decision_evaluate", "craft_procedure_invocation_bind", "craft_procedure_invocation_dispatch", "craft_procedure_invocation_report"],
  code: ["craft_codebase_symbol_find", "craft_codebase_callers_find", "craft_codebase_impact_query", "craft_codebase_context_slice"],
};

/** Discovery is a small recommended subset. Existing Host tool registrations stay compatible. */
export function discoverContextTools(args: JsonObject): JsonObject {
  const intent = String(args.intent ?? "recall");
  if (!Object.hasOwn(TASK_TOOLS, intent)) throw new Error("Unsupported Context tool intent");
  const names = new Set([...(TASK_TOOLS.recall!), ...TASK_TOOLS[intent]!]);
  const tools = ACTIVE_TOOLS.filter(tool => names.has(tool.name));
  return { intent, tools, schema_estimated_tokens: estimateTokens(JSON.stringify(tools)), exact: false, changes_host_registration: false };
}
