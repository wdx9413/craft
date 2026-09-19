import type { JsonObject } from "../infrastructure/store.ts";

export type Tool = { name: string; description: string; inputSchema: JsonObject; annotations?: JsonObject };

const schemaFor = (name: string): JsonObject => {
  if (["scan", "enabled", "allow_execution", "allow_external_write", "require_held_out", "require_outcome_passed", "retryable", "requires_external_effect", "supports_pause_resume", "supports_evidence_receipts", "generated_code", "requires_credential", "has_compensation", "approved", "start_trial", "untrusted_input", "confirmed_original_runner_stopped", "sanitized", "active", "acceptance_required", "trusted", "unattended", "reobserve_required", "compensation_or_handoff", "require_governance", "accepted", "stale", "crash_recovery", "reobserved", "delivered", "allowed", "allow_restricted", "privacy_reviewed", "complete", "content_stored", "candidate_change", "requires_real_host"].includes(name)) return { type: "boolean" };
  if (["limit", "max_days", "version", "capacity", "max_concurrency", "size_bytes", "subject_version", "expected_version", "max_candidates",
    "suite_version", "configuration_version", "harness_configuration_version", "target_version", "profile_version",
    "grader_version", "policy_version", "signoff_policy_version", "lease_ttl_seconds", "ttl_seconds", "trials_per_case", "window_size", "max_attempts", "min_trials", "harness_version", "ir_version", "runtime_adapter_version", "agreed", "total", "expected_state_revision", "expected_revision", "observed_revision", "max_chars", "max_items", "timeout_ms", "output_limit", "max_turns", "after_sequence", "context_profile_version", "activation_profile_version", "budget_account_version", "contract_version", "conformance_version", "max_latency_ms"].includes(name)) return { type: "integer" };
  if (["score", "value", "threshold", "confidence", "min_pass_rate_delta", "max_cost_regression_ratio", "max_duration_regression_ratio", "max_budget_ratio", "baseline", "candidate", "minimum_agreement", "max_budget_usd", "input_per_million", "output_per_million", "minimum_recall", "max_cost_usd"].includes(name)) return { type: "number" };
  if (["input", "inputs", "metadata", "policy", "dimensions", "environment", "budget", "data", "scores",
    "costs", "metrics", "configuration", "receipt_requirements", "execution", "rules", "authorization_requests", "notification_refs", "cost_hint", "design_axes", "report",
    "limits", "resources", "actual", "actual_resources", "estimated_resources", "observation", "trial_budget", "policy_fingerprints", "structured_data", "field_sources",
    "capabilities", "observed_capabilities", "requirements", "output", "transform", "entity", "values", "budget_limits", "sandbox_requirements", "eval_suite_ref", "checks", "state", "action_results", "workbench", "runtime", "privacy", "acceptance", "budget", "allocation", "action_contract", "result_schema", "state_before", "state_after", "usage", "value", "model_fingerprint", "environment_fingerprint", "capability_fingerprint", "policy_fingerprint", "metadata", "trace", "scope"].includes(name)) return { type: "object" };
  if (["completed", "pending", "decisions", "artifacts", "steps", "cases", "capabilities",
    "allowed_side_effects", "approved_side_effects", "nodes", "artifact_ids", "evidence_ids",
    "trial_ids", "requirements", "grade_ids", "pattern_ids", "failure_modes", "receipt_ids", "criteria", "acceptance_criteria", "allowed_extensions", "fields", "capability_requirements", "object_schemas", "components", "action_contracts", "bindings", "source_refs", "changes", "tags", "claim_ids", "evidence_ids", "expected_claim_ids", "case_ids",
    "allowed_operations", "allowed_effects", "require_approval_for", "operations", "subjects", "children", "trusted_hosts", "command_allowlist", "path_allowlist", "kinds", "effects", "allowed_kinds", "dependencies", "aliases", "assets", "asset_ids", "connector_ticket_ids", "artifact_ids", "final_artifact_ids", "evidence_ids", "gold_case_ids", "output_contract", "trial_ids", "include_paths", "affected_paths", "object_ids", "depends_on", "source_paths", "applies_to", "patches", "snapshot_refs", "triggers", "allowed_hosts", "allowed_actions", "approval_required_actions", "detected_instructions", "citations", "allowed_fields", "argv", "sources", "providers", "budget_ids", "recovery_item_ids", "memory_kinds", "object_types", "required_memory_ids", "required_object_ids", "benchmark_ids", "memory_ids", "source_ids", "paths", "state_paths", "turns", "messages", "events", "decisions", "constraints", "open_questions", "artifacts", "roles", "changed_paths", "materials", "non_goals", "input_refs", "output_refs", "evidence_ids", "gold_case_ids", "contamination_flags", "trace_ids", "knowledge_refs", "capability_refs", "workflow_refs", "excluded_refs", "selection_rationale", "change_kinds", "platforms", "permissions", "required", "candidates", "required_artifacts", "required_evidence", "evidence_refs", "criteria"].includes(name)) return { type: "array" };
  return { type: "string" };
};

const objectSchema = (required: string[] = [], optional: string[] = []): JsonObject => ({ type: "object",
  properties: Object.fromEntries([...required, ...optional].map((name) => [name, schemaFor(name)])), required,
  additionalProperties: false });

export const tool = (name: string, description: string, required: string[] = [], readOnly = false,
  optional: string[] = []): Tool => ({
  name, description, inputSchema: objectSchema(required, optional), ...(readOnly ? { annotations: { readOnlyHint: true } } : {}),
});
