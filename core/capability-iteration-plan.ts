import { stableDigest } from "../common/craft-common-base/src/digest.ts";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";

const TASK_LEDGER_SCHEMA = "craft.governed-learning-task-ledger.v1";
const LEARNING_RECORD_SCHEMA = "craft.governed-learning-record.v1";
const ITERATION_PLAN_SCHEMA = "craft.capability-iteration-plan.v1";
const MAX_ITEMS = 100;
const MAX_STRING_CHARS = 2_000;
const MIN_INDEPENDENT_SESSIONS = 2;
const MIN_TASK_RECORDS = 20;
const MAX_ACTIVATION_TOOLS = 5;

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_STRING_CHARS) throw new Error(`${field} must be a bounded non-empty string`);
  return value.trim();
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return stringValue(value, field);
}

function listValue(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error(`${field} must contain at most ${MAX_ITEMS} items`);
  return value.map((item, index) => stringValue(item, `${field}[${index}]`));
}

function exactVersion(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${field} must be a positive integer`);
  return Number(value);
}

function normaliseTaskRecord(value: unknown, index: number): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`records[${index}] must be an object`);
  const record = value as JsonObject;
  const verificationOutcome = stringValue(record.verification_outcome, `records[${index}].verification_outcome`);
  if (!["passed", "failed", "inconclusive", "abandoned"].includes(verificationOutcome)) throw new Error(`records[${index}].verification_outcome is unsupported`);
  const digest = optionalString(record.verification_digest, `records[${index}].verification_digest`);
  if (digest !== null && !/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new Error(`records[${index}].verification_digest must be a sha256 digest`);
  return {
    task_id: stringValue(record.task_id, `records[${index}].task_id`),
    session_id: stringValue(record.session_id, `records[${index}].session_id`),
    task_goal: stringValue(record.task_goal, `records[${index}].task_goal`),
    changed_paths: listValue(record.changed_paths, `records[${index}].changed_paths`),
    verification_outcome: verificationOutcome,
    verification_digest: digest,
    injected_refs: listValue(record.injected_refs, `records[${index}].injected_refs`),
    used_refs: listValue(record.used_refs, `records[${index}].used_refs`),
    user_corrections: listValue(record.user_corrections, `records[${index}].user_corrections`),
    turn_outcome: optionalString(record.turn_outcome, `records[${index}].turn_outcome`) ?? "unverified",
  };
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function unique(values: readonly string[]): string[] { return [...new Set(values)].sort(); }

function recordDigest(record: JsonObject): string { return stableDigest(record).slice(-32); }

function taskLedgerSample(seed: JsonObject): JsonObject {
  return {
    schema: TASK_LEDGER_SCHEMA,
    project_scope_id: seed.project_scope_id,
    minimum_records: MIN_TASK_RECORDS,
    minimum_independent_sessions: MIN_INDEPENDENT_SESSIONS,
    privacy: { sanitized: true, content_stored: false, raw_conversation_excluded: true, secret_excluded: true },
    records: [{
      task_id: "task:example", session_id: "session:example-A", task_goal: "bounded sanitized goal",
      changed_paths: ["src/example.ts"], verification_outcome: "passed",
      verification_digest: "sha256:" + "0".repeat(64), injected_refs: ["knowledge:claim@example@1"],
      used_refs: ["knowledge:claim@example@1"], user_corrections: [], turn_outcome: "passed",
    }],
    baseline_candidate_contract: {
      fixed_inputs: ["goal", "workspace_snapshot", "host", "model", "budget", "tool_versions"],
      baseline: { context: "omitted" }, candidate: { context: "exact bounded receipt" },
      outcome_measures: ["terminal_success", "first_pass", "rework", "injected_tokens", "duration_ms", "safety_refusals"],
    },
  };
}

function claimStatuses(store: CraftStore): Record<string, number> {
  const claims = store.list("knowledge_claim", 10_001, undefined, false);
  return { candidate: claims.filter(item => item.status === "candidate").length,
    stale: claims.filter(item => item.status === "stale").length,
    reviewed: claims.filter(item => item.status === "reviewed").length, other: claims.filter(item => !["candidate", "stale", "reviewed"].includes(String(item.status))).length };
}

function migrationPlan(store: CraftStore, projectRoot: string | null): JsonObject {
  const migrations = projectRoot === null ? [] : store.list("project_registry_migration", 100, item => item.project_root === projectRoot, false);
  return { status: migrations.length ? "registry_plan_observed" : "registry_migration_not_observed",
    apply_allowed: false, automatic_business_import_allowed: false,
    required_steps: ["diagnose", "plan_registry_migration", "offline_backup", "explicit_apply_authorization", "inventory_project_data",
      "plan_data_migration_with_selected_record_refs", "explicit_apply_data_migration_authorization", "reindex_codebase"],
    known_boundaries: ["old_scope_is_not_auto_context", "business_data_is_not_migrated_by_registry_actions",
      "review_and_execution_authority_do_not_transfer", "procedure_graph_and_task_effect_need_separate_recipes"] };
}

function activationProfile(args: JsonObject): JsonObject {
  const candidates = listValue(args.asset_ids, "asset_ids");
  const allowedEffects = listValue(args.allowed_effects, "allowed_effects");
  const selected = candidates.slice(0, Math.min(MAX_ACTIVATION_TOOLS, candidates.length));
  return { status: candidates.length ? "recommended" : "insufficient_assets",
    selected_asset_ids: selected, omitted_count: candidates.length - selected.length,
    allowed_effects: allowedEffects, discovery_is_activation: false, authorization_granted: false,
    required_gates: ["health", "trust", "effect", "cost", "compatibility", "explicit_host_activation"] };
}

function governedQualityPlan(args: JsonObject): JsonObject {
  const subject = stringValue(args.subject_id, "subject_id");
  const version = exactVersion(args.subject_version, "subject_version");
  const cases = listValue(args.case_ids, "case_ids");
  const baseline = stringValue(args.baseline_id, "baseline_id");
  const candidate = stringValue(args.candidate_id, "candidate_id");
  return { status: cases.length >= 2 ? "trial_plan_ready" : "insufficient_cases", subject: { id: subject, version },
    frozen: { cases, environment_digest: optionalString(args.environment_digest, "environment_digest"),
      budget_digest: optionalString(args.budget_digest, "budget_digest"), grader_version: optionalString(args.grader_version, "grader_version") },
    arms: { baseline, candidate }, equal_budget: true, repeated_trials: true,
    required_stages: ["shadow", "held_out", "signoff", "canary", "rollback_target"], automatic_publication: false };
}

function input(args: JsonObject): JsonObject { return args.input && typeof args.input === "object" && !Array.isArray(args.input) ? args.input as JsonObject : args; }

export function buildCapabilityIterationPlan(store: CraftStore, args: JsonObject = {}): JsonObject {
  const values = input(args);
  // Same default as capabilityIterationGaps: an omitted scope means "global".
  // Two entry points of one family must not disagree about whether it is required.
  const projectScope = values.project_scope_id === undefined || values.project_scope_id === null || values.project_scope_id === ""
    ? "global" : stringValue(values.project_scope_id, "project_scope_id");
  const projectRoot = optionalString(values.project_root, "project_root");
  const suppliedRecords = values.records;
  if (suppliedRecords !== undefined && (!Array.isArray(suppliedRecords) || suppliedRecords.length > MAX_ITEMS)) throw new Error("records must contain at most 100 items");
  const records = Array.isArray(suppliedRecords) ? suppliedRecords.map(normaliseTaskRecord) : [];
  const sessions = unique(records.map(item => String(item.session_id)));
  const verified = records.filter(item => item.verification_outcome === "passed");
  const baselineCandidatePairs = verified.filter(item => Array.isArray(item.injected_refs) && item.injected_refs.length > 0
    && Array.isArray(item.used_refs) && item.used_refs.length > 0).length;
  const evidenceSufficient = records.length >= MIN_TASK_RECORDS && sessions.length >= MIN_INDEPENDENT_SESSIONS && baselineCandidatePairs >= MIN_INDEPENDENT_SESSIONS;
  const outcome = evidenceSufficient ? "eligible_for_controlled_effect_assessment" : "inconclusive";
  const digest = stableDigest({ projectScope, projectRoot, records, outcome });
  const learningRecord: JsonObject = {
    schema: LEARNING_RECORD_SCHEMA, project_scope_id: projectScope,
    record_digests: records.map(recordDigest), independent_sessions: sessions.length,
    verification_outcomes: countBy(records.map(item => String(item.verification_outcome))),
    feedback_outcomes: countBy(records.map(item => String(item.turn_outcome))),
    baseline_candidate_pairs: baselineCandidatePairs,
    evidence_threshold: { minimum_records: MIN_TASK_RECORDS, minimum_independent_sessions: MIN_INDEPENDENT_SESSIONS,
      minimum_baseline_candidate_pairs: MIN_INDEPENDENT_SESSIONS },
    model_effect_proven: false, business_eligible: false, routeable: false,
    outcome, outcome_reason: evidenceSufficient ? "threshold_met; independent controlled task runs still required" : "threshold_not_met",
    sanitized: true, content_stored: false, raw_conversation_excluded: true,
  };
  return {
    schema: ITERATION_PLAN_SCHEMA, plan_digest: digest, project_scope_id: projectScope, project_root: projectRoot,
    generated_without_writes: true, automatic_apply_allowed: false, execution_context: false,
    task_ledger: { schema: TASK_LEDGER_SCHEMA, records_supplied: records.length, record_digests: records.map(recordDigest),
      independent_sessions: sessions.length, verification_outcomes: learningRecord.verification_outcomes,
      baseline_candidate_pairs: baselineCandidatePairs, sample_template: taskLedgerSample({ project_scope_id: projectScope }) },
    learning_record: learningRecord,
    readiness: { knowledge_claim_statuses: claimStatuses(store), knowledge_evaluation_cases: store.count("knowledge_evaluation_case"),
      memory_ledger: store.count("memory_ledger"), experience_observations: store.count("experience_observation"),
      context_emissions: store.count("context_emission"), context_feedback: store.count("context_feedback") },
    migration: migrationPlan(store, projectRoot),
    minimal_sufficient_context: { stage_one: ["bounded_receipt", "typed_refs", "versions", "digests", "constraints", "omission_reasons"],
      stage_two: ["symbol_read", "claim_get", "procedure_read"], large_output: ["craft_context_output_capture", "craft_context_ephemeral_search",
        "craft_context_compute", "craft_context_resume_resolve"], max_chars_is_token_budget: false, required_ref_failure_is_explicit: true },
    capability_activation: activationProfile(values),
    governed_quality: governedQualityPlan({ ...values, subject_id: values.subject_id ?? `${projectScope}:capability-iteration`,
      subject_version: values.subject_version ?? 1, baseline_id: values.baseline_id ?? "baseline:no-context",
      candidate_id: values.candidate_id ?? "candidate:minimal-sufficient-context" }),
    next_safe_actions: outcome === "inconclusive"
      ? ["collect_sanitized_independent_task_records", "freeze_cases_and_equal_budget", "run_controlled_baseline_candidate_tasks", "do_not_promote"]
      : ["attach_exact_controlled_task_effect_evidence", "review_held_out_trials", "obtain_signoff", "canary_with_rollback_target"],
  };
}
