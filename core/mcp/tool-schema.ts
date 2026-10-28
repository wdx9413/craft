import type { JsonObject } from "../infrastructure/store.ts";
import { DEFAULT_CONTEXT_MAX_CHARS, DEFAULT_CONTEXT_MAX_ITEMS } from "../../common/craft-common-base/src/context-assets.ts";

export type Tool = { name: string; description: string; inputSchema: JsonObject; annotations?: JsonObject };
export type ParamType = "boolean" | "integer" | "number" | "object" | "array" | "string";
export const CONTEXT_TOOL_INTENTS = ["recall", "knowledge", "memory", "experience", "code", "code-analysis"] as const;

/**
 * Parameter types are inferred from the parameter *name*, not declared per tool. That
 * keeps 950+ tool definitions short, but it means the five lists below are a global
 * contract: a name must appear in at most one of them. `capabilities` was once listed
 * as both `object` and `array` (the `object` check won by order) while every handler
 * that validates it demands an array — the advertised schema and the runtime contract
 * disagreed, and nothing caught it. `tests/tool-schema-contract.test.ts` now fails the
 * build if a name is claimed by two lists, and per-tool overrides (`types`) exist for
 * the one genuinely ambiguous name (`requirements` is an object for sandbox planning
 * and an array for signoff policies).
 */
const BOOLEAN_PARAMS = ["scan", "enabled", "allow_execution", "allow_external_write", "require_held_out", "require_outcome_passed", "retryable", "requires_external_effect", "supports_pause_resume", "supports_evidence_receipts", "generated_code", "requires_credential", "has_compensation", "approved", "start_trial", "untrusted_input", "confirmed_original_runner_stopped", "sanitized", "active", "acceptance_required", "trusted", "unattended", "reobserve_required", "compensation_or_handoff", "require_governance", "accepted", "stale", "crash_recovery", "reobserved", "delivered", "allowed", "allow_restricted", "privacy_reviewed", "complete", "content_stored", "candidate_change", "requires_real_host", "verified", "verify_against_archive"];
const INTEGER_PARAMS = ["limit", "max_days", "version", "capacity", "max_concurrency", "size_bytes", "subject_version", "expected_version", "expected_catalog_version", "max_candidates",
  "suite_version", "configuration_version", "harness_configuration_version", "target_version", "profile_version",
  "grader_version", "policy_version", "signoff_policy_version", "lease_ttl_seconds", "ttl_seconds", "trials_per_case", "window_size", "max_attempts", "min_trials", "harness_version", "ir_version", "runtime_adapter_version", "agreed", "total", "expected_state_revision", "expected_revision", "observed_revision", "max_chars", "max_items", "timeout_ms", "output_limit", "max_turns", "after_sequence", "context_profile_version", "activation_profile_version", "budget_account_version", "contract_version", "conformance_version", "max_latency_ms", "dormant_after_days"];
const NUMBER_PARAMS = ["score", "value", "threshold", "confidence", "min_pass_rate_delta", "max_cost_regression_ratio", "max_duration_regression_ratio", "max_budget_ratio", "baseline", "candidate", "minimum_agreement", "max_budget_usd", "input_per_million", "output_per_million", "minimum_recall", "max_cost_usd"];

const OBJECT_PARAMS = ["input", "inputs", "metadata", "policy", "dimensions", "environment", "budget", "data", "scores", "args",
  "costs", "metrics", "configuration", "receipt_requirements", "execution", "rules", "authorization_requests", "notification_refs", "cost_hint", "design_axes", "report",
  "limits", "resources", "actual", "actual_resources", "estimated_resources", "observation", "trial_budget", "policy_fingerprints", "structured_data", "field_sources",
  "observed_capabilities", "requirements", "output", "transform", "entity", "values", "budget_limits", "sandbox_requirements", "eval_suite_ref", "checks", "state", "action_results", "workbench", "runtime", "privacy", "acceptance", "budget", "allocation", "action_contract", "result_schema", "state_before", "state_after", "usage", "model_fingerprint", "environment_fingerprint", "capability_fingerprint", "policy_fingerprint", "metadata", "trace", "scope",
  // Action gate (plan 4.2–6.3.1): `checker` and `receipt` are objects, `guard_values` is
  // the context guard clauses are evaluated against. `guard` is an array of clauses.
  "checker", "receipt", "guard_values",
  // Evidence receipt (plan 10–11.5): both observed states are objects carrying metrics
  // plus a `provenance` block.
  "pre_state", "post_state",
  // Subscription drift (plan 7.4): the authorized `structure` and the incoming `event` are
  // deliberately separate shapes, and neither is accepted where the other belongs.
  "structure", "event",
  // Prepared state (plan 13A.3.2–3.3): the submit payload and the re-stated assertions are
  // both objects; `assertions` is an array of named observations.
  "submit_payload",
  // Authorization (plan 11.4): `effect` is the descriptor whose digest the authorization
  // binds, so it is an object rather than a scalar.
  "effect"];

const ARRAY_PARAMS = ["completed", "pending", "decisions", "artifacts", "steps", "cases", "capabilities",
  "verification_artifacts",
  "allowed_side_effects", "approved_side_effects", "nodes", "artifact_ids", "evidence_ids",
  "trial_ids", "grade_ids", "pattern_ids", "failure_modes", "receipt_ids", "criteria", "acceptance_criteria", "allowed_extensions", "fields", "capability_requirements", "object_schemas", "components", "action_contracts", "bindings", "source_refs", "changes", "tags", "claim_ids", "evidence_ids", "expected_claim_ids", "case_ids",
  "allowed_operations", "allowed_effects", "require_approval_for", "operations", "subjects", "children", "trusted_hosts", "command_allowlist", "path_allowlist", "kinds", "effects", "allowed_kinds", "dependencies", "aliases", "assets", "asset_ids", "connector_ticket_ids", "artifact_ids", "final_artifact_ids", "evidence_ids", "gold_case_ids", "output_contract", "trial_ids", "include_paths", "affected_paths", "object_ids", "depends_on", "source_paths", "applies_to", "patches", "snapshot_refs", "triggers", "allowed_hosts", "allowed_actions", "approval_required_actions", "detected_instructions", "citations", "allowed_fields", "argv", "sources", "providers", "budget_ids", "recovery_item_ids", "memory_kinds", "object_types", "required_memory_ids", "required_object_ids", "benchmark_ids", "memory_ids", "source_ids", "document_ids", "paths", "state_paths", "turns", "messages", "events", "decisions", "constraints", "open_questions", "artifacts", "roles", "changed_paths", "observed_paths", "materials", "non_goals", "input_refs", "output_refs", "evidence_ids", "gold_case_ids", "contamination_flags", "trace_ids", "knowledge_refs", "capability_refs", "workflow_refs", "excluded_refs", "selection_rationale", "change_kinds", "platforms", "permissions", "required", "candidates", "required_artifacts", "required_evidence", "evidence_refs", "criteria",
  "source_evidence_ids", "session_ids", "candidate_claim_refs",
  // Action gate: `guard` is an array of { field, op, value } clauses.
  "guard",
  // Evidence receipt: `proofs` is an array of observed proofs, `cross_checks` an array of
  // independent machine confirmations.
  "proofs", "cross_checks",
  // Prepared state: `assertions` and `observed` are arrays of named observations.
  "assertions", "observed",
  // Adjudication queue: `item_ids` is the batch, `authorizations` one record per effect.
  "item_ids", "authorizations",
  // Object hatching (plan 5.3): `fields` names what is missing, `values` supplies it.
  "values"];


/** The five global name lists, exposed so the contract test can assert they are pairwise disjoint. */
export function toolParamTypeLists(): Readonly<Record<Exclude<ParamType, "string">, readonly string[]>> {
  return { boolean: BOOLEAN_PARAMS, integer: INTEGER_PARAMS, number: NUMBER_PARAMS, object: OBJECT_PARAMS, array: ARRAY_PARAMS };
}

const schemaFor = (name: string): JsonObject => {
  if (BOOLEAN_PARAMS.includes(name)) return { type: "boolean" };
  if (INTEGER_PARAMS.includes(name)) return { type: "integer" };
  if (NUMBER_PARAMS.includes(name)) return { type: "number" };
  if (OBJECT_PARAMS.includes(name)) return { type: "object" };
  if (ARRAY_PARAMS.includes(name)) return { type: "array" };
  return { type: "string" };
};

const ENUMS_BY_TOOL: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  craft_context_tools_discover: { intent: CONTEXT_TOOL_INTENTS },
  craft_context_open: { response_detail: ["compact", "full"] },
};

// Domain contracts override the legacy name heuristic. Keep ambiguous names local
// to their tool so fixing one product cannot change unrelated admin operations.
const TYPES_BY_TOOL: Readonly<Record<string, Readonly<Record<string, ParamType>>>> = {
  craft_info: { include_zero_counts: "boolean" },
  craft_evaluation_model_ticket_issue: { project_root: "string" },
  craft_procedure_configuration_save: { scope: "string", definition: "object", scope_envelope: "object", principal_ids: "array" },
  craft_knowledge_evaluation_run: { expected_relevant_refs: "array", retrieved_refs: "array", citation_judgements: "array", candidate_claim_ids: "array" },
  craft_experience_graph_inspect: { cases: "array", input_keys: "array", scope: "string", configuration: "object", principal_ids: "array" },
  craft_experience_graph_edit: { scope: "string", configuration: "object", scope_envelope: "object", principal_ids: "array", before_version: "integer" },
  craft_knowledge_asset_inspect: { before_version: "integer", principal_ids: "array" },
  craft_knowledge_asset_restore: { principal_ids: "array" },
  craft_memory_asset_inspect: { before_version: "integer", principal_ids: "array" },
  craft_memory_asset_restore: { principal_ids: "array" },
  craft_experience_asset_inspect: { before_version: "integer", principal_ids: "array" },
  craft_experience_asset_restore: { principal_ids: "array" },
  craft_codebase_asset_inspect: { before_version: "integer", principal_ids: "array" },
  craft_codebase_asset_restore: { principal_ids: "array" },

  craft_context_open: { max_tokens: "integer", required_refs: "array", history_refs: "array", state_refs: "array", members: "array", principal_ids: "array", session_host: "string", include_codebase: "boolean", include_global: "boolean", include_working_notes: "boolean" },
  craft_evidence_record: { confidence: "string" },
  craft_component_diagnose: { observed_tool_names: "array" },
  craft_context_resolution_feedback: { injected_tokens: "integer", schema_tokens: "integer", history_tokens: "integer", asset_refs: "array", members: "array", turn_outcome: "string" },
  craft_retrieval_adapter_evaluate: { dataset: "object", metrics: "object" },
  craft_context_working_set_resolve: { required_refs: "array", history_refs: "array", state_refs: "array", members: "array", session_host: "string" },
  craft_context_resolution_resolve: { required_refs: "array", members: "array", principal_ids: "array", session_host: "string", include_global: "boolean", include_working_notes: "boolean", history_view: "boolean" },
  craft_decision_context_gate_open: { members: "array", require_context: "boolean" },
  craft_knowledge_search: { scope: "string", scenario_key: "string", include_candidates: "boolean", include_global: "boolean", principal_ids: "array" },
  craft_knowledge_scenario_list: { scope: "string", scope_kind: "string", scope_id: "string", project_root: "string" },
  craft_experience_scenario_list: { scope: "string", scope_kind: "string", scope_id: "string" },
  craft_knowledge_scenario_retire: { scope: "string", scenario_key: "string", request_id: "string", reason: "string" },
  craft_experience_scenario_retire: { scope: "string", scenario_key: "string", request_id: "string", reason: "string" },
  craft_knowledge_scenario_migration_propose: { scope: "string", mode: "string", source_keys: "array", targets: "array", expected_catalog_version: "integer", request_id: "string", reason: "string" },
  craft_experience_scenario_migration_propose: { scope: "string", mode: "string", source_keys: "array", targets: "array", expected_catalog_version: "integer", request_id: "string", reason: "string" },
  craft_knowledge_claim_save: { scope: "string", scope_envelope: "object", scenario_key: "string", coarse_scenario_key: "string", scenario_definition: "object", coarse_scenario_definition: "object", project_root: "string" },
  craft_knowledge_session_evidence_record: { scope: "string", verification_artifacts: "array" },
  craft_learning_cycle_finalize: { session_id: "string", scenario_key: "string", coarse_scenario_key: "string", scenario_verifier_digest: "string", scenario_definition: "object", coarse_scenario_definition: "object", scenario_context: "object", expected_scenario_catalog_version: "integer", project_root: "string" },
  craft_experience_scenario_classification_request_get: { request_id: "string", scope: "string", project_root: "string" },
  craft_experience_scenario_classification_request_complete: { request_id: "string", scope: "string", expected_version: "integer", status: "string", result_digest: "string", project_root: "string" },
  craft_knowledge_source_register: { scope_envelope: "object" },
  craft_knowledge_source_ingest: { max_files: "integer", max_chars_per_fragment: "integer" },
  craft_knowledge_storage_reconcile: { max_records: "integer", cursor: "string", dry_run: "boolean", summary_only: "boolean" },
  craft_knowledge_auto_review: { scope_kind: "string", scope_id: "string", auto_promote: "boolean" },
  craft_knowledge_memory_bundle: { allow_local_write: "boolean", include_candidates: "boolean", include_global: "boolean" },
  craft_memory_governance: { principal_ids: "array", explicit_consent: "boolean" },
  craft_memory_capture_user_statement: { session_id: "string", session_host: "string", project_scope_id: "string", project_root: "string", scope_envelope: "object" },
  craft_memory_capture_observed_fact: { session_id: "string", session_host: "string", project_scope_id: "string", project_root: "string", scope_envelope: "object" },
  craft_memory_session_finalize: { session_host: "string", candidate_ids: "array" },
  craft_memory_candidate_propose: { confidence: "string", scope_envelope: "object", session_host: "string" },
  craft_memory_ledger_remember: { confidence: "string", scope_envelope: "object", session_host: "string" },
  craft_memory_ledger_get: { principal_ids: "array", session_host: "string" },
  craft_memory_ledger_list: { include_history: "boolean", principal_ids: "array", session_host: "string" },
  craft_memory_maintenance_run: { principal_ids: "array" },
  craft_memory_maintenance_schedule: { budget_available: "boolean", idle: "boolean", model_available: "boolean" },
  craft_experience_observe: { source_session_id: "string", verification: "object", scope: "string", scenario_signature: "object", execution_shape: "array" },
  craft_experience_procedure_draft: { design_axes: "array", observation_ids: "array" },
  craft_experience_procedure_submit: { composition: "object", graph_control: "object", inputs: "array", steps: "array", nodes: "array", edges: "array", outputs: "object", checkpoint_policy: "object" },
  craft_experience_learning_evaluation_run: { dispatch_id: "string" },
  craft_procedure_create: { scenario_signature: "object", preconditions: "array", scope_envelope: "object" },
  craft_host_session_open: { environment_fingerprint: "string", policy_fingerprint: "string", capability_fingerprint: "string", model_fingerprint: "string", budget_fingerprint: "string" },
  craft_outcome_observer_observe: { environment_fingerprint: "string" },
  craft_procedure_host_control: { scope: "string", input: "object", principal_ids: "array" },
  craft_procedure_decision_evaluate: { scope: "string", expected_version: "integer", principal_ids: "array" },
  craft_procedure_invocation_transition: { scope: "string", expected_version: "integer", principal_ids: "array" },
  craft_procedure_invocation_bind: { model_fingerprint: "string", budget_fingerprint: "string", scope: "string", expected_version: "integer", principal_ids: "array", procedure_version: "integer", input_refs: "object", allowed_effects: "array", max_dispatches: "integer", ttl_ms: "integer" },
  craft_procedure_invocation_dispatch: { scope: "string", expected_version: "integer", principal_ids: "array", precondition_evidence: "object" },
  craft_procedure_invocation_report: { scope: "string", expected_version: "integer", principal_ids: "array", output_refs: "object", acceptance_evidence_ids: "array" },
  craft_procedure_invocation_resume: { scope: "string", expected_version: "integer", principal_ids: "array" },
  craft_procedure_invocation_get: { scope: "string", expected_version: "integer", principal_ids: "array" },
  craft_procedure_invocation_evaluate: { scope: "string", expected_version: "integer", principal_ids: "array", baseline_ids: "array", candidate_ids: "array" },
  craft_procedure_plan: { procedure_version: "integer", scope: "string", input_refs: "object", precondition_evidence: "object", principal_ids: "array" },
  craft_procedure_gate: { passed: "boolean" },
  craft_procedure_list: { scope: "string" },
  craft_experience_procedure_gate: { passed: "boolean" },
  craft_experience_learning_evaluation_dispatch: {},
  craft_experience_learning_evaluation_dispatch_list: { limit: "integer" },
  craft_experience_learning_evaluation_result: { evidence_ids: "array" },
  craft_experience_learning_request_get: {},
  craft_evaluation_model_ticket_list: {},
  craft_evaluation_model_ticket_complete: {},
  craft_evaluation_model_profile_ensure_single: {},
  craft_experience_procedure_projection_list: { scope: "string" },
  craft_experience_procedure_projection_draft: { scenario_signature: "object", preconditions: "array" },
  craft_codebase_analysis_import: { analysis: "object" },
  craft_codebase_context_slice: { node_ids: "array" },
  craft_codebase_symbols_overview: { limit: "integer" },
  craft_codebase_symbol_explore: { symbol_limit: "integer", relation_limit: "integer", relation_kinds: "array" },
  craft_codebase_symbol_read: { max_lines: "integer", max_bytes: "integer", continuation: "string" },
  craft_codebase_definition_find: { offset: "integer", limit: "integer" },
  craft_codebase_impact_query: { max_depth: "integer" },
  craft_context_ephemeral_record: { items: "array", session_id: "string", source: "string", ttl_seconds: "integer", now: "string", index_id: "string" },
  craft_context_ephemeral_search: { session_id: "string", source: "string", query: "string", limit: "integer", now: "string", index_id: "string" },
  craft_context_ephemeral_purge: { session_id: "string", source: "string", index_id: "string" },
  craft_context_output_capture: { tool_name: "string", content: "string", session_id: "string", max_chars: "integer", ttl_seconds: "integer" },
  craft_context_compute: { language: "string", code: "string", timeout_ms: "integer", output_limit: "integer", allow_execution: "boolean" },
  craft_context_resume_checkpoint: { session_id: "string", scope: "string", files_touched: "array", tasks: "array", errors: "array", decisions: "array", open_questions: "array", now: "string" },
  craft_context_resume_get: { session_id: "string" },
  craft_context_resume_resolve: { session_id: "string", max_chars: "integer" },
  craft_context_stats: {},
  craft_context_health: {},
  craft_context_routing_render: { client: "string" },
  craft_context_correction_list: { status: "string", member: "string", limit: "integer" },
  craft_context_correction_decide: { task_id: "string", decision: "string", reason: "string", now: "string" },
  craft_codebase_symbol_usage_record: { index_id: "string", symbol_id: "string", outcome: "string", now: "string" },
  craft_codebase_symbol_usage_get: { index_id: "string" },
};

const objectSchema = (toolName: string, required: string[] = [], optional: string[] = []): JsonObject => ({ type: "object",
  properties: Object.fromEntries([...required, ...optional].map((name) => [name, toolName === "craft_context_open" && (name === "max_chars" || name === "max_items")
    ? { type: "integer", description: `Range: 1 to ${name === "max_chars" ? DEFAULT_CONTEXT_MAX_CHARS : DEFAULT_CONTEXT_MAX_ITEMS}; omit to use the default.` }
    : ENUMS_BY_TOOL[toolName]?.[name]
    ? { type: "string", enum: [...ENUMS_BY_TOOL[toolName][name]!] }
    : TYPES_BY_TOOL[toolName]?.[name] ? { type: TYPES_BY_TOOL[toolName][name] } : schemaFor(name)])), required,
  additionalProperties: false });

export const tool = (name: string, description: string, required: string[] = [], readOnly = false,
  optional: string[] = []): Tool => ({
  name, description, inputSchema: objectSchema(name, required, optional), ...(readOnly ? { annotations: { readOnlyHint: true } } : {}),
});
