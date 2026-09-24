import type { JsonObject } from "../infrastructure/store.ts";

export type Tool = { name: string; description: string; inputSchema: JsonObject; annotations?: JsonObject };
export type ParamType = "boolean" | "integer" | "number" | "object" | "array" | "string";

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
const BOOLEAN_PARAMS = ["scan", "enabled", "allow_execution", "allow_external_write", "require_held_out", "require_outcome_passed", "retryable", "requires_external_effect", "supports_pause_resume", "supports_evidence_receipts", "generated_code", "requires_credential", "has_compensation", "approved", "start_trial", "untrusted_input", "confirmed_original_runner_stopped", "sanitized", "active", "acceptance_required", "trusted", "unattended", "reobserve_required", "compensation_or_handoff", "require_governance", "accepted", "stale", "crash_recovery", "reobserved", "delivered", "allowed", "allow_restricted", "privacy_reviewed", "complete", "content_stored", "candidate_change", "requires_real_host"];
const INTEGER_PARAMS = ["limit", "max_days", "version", "capacity", "max_concurrency", "size_bytes", "subject_version", "expected_version", "max_candidates",
  "suite_version", "configuration_version", "harness_configuration_version", "target_version", "profile_version",
  "grader_version", "policy_version", "signoff_policy_version", "lease_ttl_seconds", "ttl_seconds", "trials_per_case", "window_size", "max_attempts", "min_trials", "harness_version", "ir_version", "runtime_adapter_version", "agreed", "total", "expected_state_revision", "expected_revision", "observed_revision", "max_chars", "max_items", "timeout_ms", "output_limit", "max_turns", "after_sequence", "context_profile_version", "activation_profile_version", "budget_account_version", "contract_version", "conformance_version", "max_latency_ms", "dormant_after_days"];
const NUMBER_PARAMS = ["score", "value", "threshold", "confidence", "min_pass_rate_delta", "max_cost_regression_ratio", "max_duration_regression_ratio", "max_budget_ratio", "baseline", "candidate", "minimum_agreement", "max_budget_usd", "input_per_million", "output_per_million", "minimum_recall", "max_cost_usd"];

const OBJECT_PARAMS = ["input", "inputs", "metadata", "policy", "dimensions", "environment", "budget", "data", "scores",
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
  "allowed_side_effects", "approved_side_effects", "nodes", "artifact_ids", "evidence_ids",
  "trial_ids", "grade_ids", "pattern_ids", "failure_modes", "receipt_ids", "criteria", "acceptance_criteria", "allowed_extensions", "fields", "capability_requirements", "object_schemas", "components", "action_contracts", "bindings", "source_refs", "changes", "tags", "claim_ids", "evidence_ids", "expected_claim_ids", "case_ids",
  "allowed_operations", "allowed_effects", "require_approval_for", "operations", "subjects", "children", "trusted_hosts", "command_allowlist", "path_allowlist", "kinds", "effects", "allowed_kinds", "dependencies", "aliases", "assets", "asset_ids", "connector_ticket_ids", "artifact_ids", "final_artifact_ids", "evidence_ids", "gold_case_ids", "output_contract", "trial_ids", "include_paths", "affected_paths", "object_ids", "depends_on", "source_paths", "applies_to", "patches", "snapshot_refs", "triggers", "allowed_hosts", "allowed_actions", "approval_required_actions", "detected_instructions", "citations", "allowed_fields", "argv", "sources", "providers", "budget_ids", "recovery_item_ids", "memory_kinds", "object_types", "required_memory_ids", "required_object_ids", "benchmark_ids", "memory_ids", "source_ids", "paths", "state_paths", "turns", "messages", "events", "decisions", "constraints", "open_questions", "artifacts", "roles", "changed_paths", "materials", "non_goals", "input_refs", "output_refs", "evidence_ids", "gold_case_ids", "contamination_flags", "trace_ids", "knowledge_refs", "capability_refs", "workflow_refs", "excluded_refs", "selection_rationale", "change_kinds", "platforms", "permissions", "required", "candidates", "required_artifacts", "required_evidence", "evidence_refs", "criteria",
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

const objectSchema = (required: string[] = [], optional: string[] = []): JsonObject => ({ type: "object",
  properties: Object.fromEntries([...required, ...optional].map((name) => [name, schemaFor(name)])), required,
  additionalProperties: false });

export const tool = (name: string, description: string, required: string[] = [], readOnly = false,
  optional: string[] = []): Tool => ({
  name, description, inputSchema: objectSchema(required, optional), ...(readOnly ? { annotations: { readOnlyHint: true } } : {}),
});
