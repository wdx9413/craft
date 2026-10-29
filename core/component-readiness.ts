import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { CRAFT_RELEASE_VERSION } from "./version.ts";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { learningWorkerDiagnostic } from "./learning-worker-diagnostic.ts";
import { knowledgeTaskEffectEvidenceVerified } from "./knowledge-evaluation-provenance.ts";

const COMPONENTS = new Set(["knowledge", "memory", "experience"]);

export type ComponentName = "knowledge" | "memory" | "experience";

function component(value: unknown): ComponentName {
  if (typeof value !== "string" || !COMPONENTS.has(value)) {
    throw new Error("component must be knowledge, memory, or experience");
  }
  return value as ComponentName;
}

function countByStatus(store: CraftStore, kind: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of store.list(kind, 10_000)) {
    const status = typeof item.status === "string" ? item.status : "unknown";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function readDiagnosticState(directory: string, name: string): JsonObject {
  const parent = lstatSync(directory);
  if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error("diagnostic directory is invalid");
  const fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error("diagnostic state is invalid");
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw new Error("diagnostic state changed during read");
    }
    return JSON.parse(buffer.subarray(0, length).toString("utf8")) as JsonObject;
  } finally { closeSync(fd); }
}

/** Summarize persisted recovery state without returning task identifiers. */
function knowledgeCandidateDiagnostic(directory: string): JsonObject {
  try {
    const value = readDiagnosticState(directory, "session-candidate-state.json");
    if (!value || value.schema !== "craft.knowledge-session-candidate-state.v1") return { status: "unavailable" };
    const plain = (input: unknown) => Boolean(input && typeof input === "object" && !Array.isArray(input));
    const skips = value.terminal_skips === undefined ? {} : value.terminal_skips;
    const traces = value.trace_ids_by_task === undefined ? {} : value.trace_ids_by_task;
    const uncertain = value.uncertain_calls === undefined ? {} : value.uncertain_calls;
    if (![skips, traces, uncertain].every(plain) || [skips, traces, uncertain].some(item => Object.keys(item as object).length > 50_000)) return { status: "unavailable" };
    const skipMap = skips as JsonObject, traceMap = traces as JsonObject, uncertainMap = uncertain as JsonObject;
    return { status: "last_recorded", measurement_scope: "persisted_candidate_state",
      uncertain_calls: Object.keys(uncertainMap).length,
      conflicting_skips: Object.keys(skipMap).filter(id => Object.hasOwn(traceMap, id) || Object.hasOwn(uncertainMap, id)).length };
  } catch (error) { return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "not_observed" : "unavailable" }; }
}

/** Read only the bounded, content-free projection of the last evaluation state. */
function knowledgeEvaluationDiagnostic(directory: string): JsonObject {
  try {
    const value = readDiagnosticState(directory, "session-evaluation-state.json");
    if (!value || value.schema !== "craft.knowledge-session-evaluation-state.v1" || value.legacy_unknown_outcomes === undefined)
      return { status: "not_observed" };
    if (!Number.isSafeInteger(value.legacy_unknown_outcomes) || Number(value.legacy_unknown_outcomes) < 0
      || Number(value.legacy_unknown_outcomes) > 50_000 || typeof value.updated_at !== "string"
      || value.legacy_untraced_tasks !== undefined && (!Number.isSafeInteger(value.legacy_untraced_tasks)
        || Number(value.legacy_untraced_tasks) < 0 || Number(value.legacy_untraced_tasks) > 50_000)
      || value.updated_at.length > 64 || !Number.isFinite(Date.parse(value.updated_at))) return { status: "unavailable" };
    return { status: "last_recorded", measurement_scope: "eligible_held_out_batch_only",
      legacy_unknown_outcomes: value.legacy_unknown_outcomes,
      ...(value.legacy_untraced_tasks === undefined ? {} : { legacy_untraced_tasks: value.legacy_untraced_tasks, legacy_untraced_scope: "processed_state" }), updated_at: value.updated_at };
  } catch (error) { return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "not_observed" : "unavailable" }; }
}

/**
 * A content-free first-run projection for the standalone Knowledge, Memory and
 * Experience products.  It deliberately reports prerequisites and record
 * counts, not stored bodies: a component needs to explain why it cannot help
 * yet without turning a status check into a broad context read.
 */
export class ComponentReadinessKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  get(args: JsonObject, mountedComponent?: ComponentName): JsonObject {
    const name = component(args.component);
    ensureMountedComponent(name, mountedComponent);
    switch (name) {
      case "knowledge": return this.knowledge();
      case "memory": return this.memory();
      case "experience": return this.experience();
    }
  }

  /**
   * A component can only diagnose the Host that has actually called it.  This deliberately
   * avoids claiming that an enabled desktop setting means the process was attached to the
   * current conversation.  A Host may supply its visible tool names to turn that fact into a
   * concrete stale-bundle or missing-surface diagnosis.
   */
  diagnose(args: JsonObject, mountedComponent?: ComponentName): JsonObject {
    const name = component(args.component);
    ensureMountedComponent(name, mountedComponent);
    const readiness = this.get({ component: name }, mountedComponent);
    const expected = REQUIRED_TOOLS[name];
    const observed = args.observed_tool_names === undefined ? null : toolNames(args.observed_tool_names);
    const routed = observed !== null && observed.includes("craft_run") && observed.includes("craft_context_tools_discover");
    const missing = observed === null ? [] : expected.filter((tool) => !observed.includes(tool) && !routed);
    const execution = this.executionProof(name, args.session_id);
    return {
      ...readiness,
      runtime_reachable: true,
      verification_level: "tool_call_verified",
      host_session_verified: false,
      expected_product: `craft-${name}`,
      expected_release: CRAFT_RELEASE_VERSION,
      expected_tools: expected,
      observed_tools_supplied: observed !== null,
      tool_access_mode: observed === null ? "unobserved" : routed ? "syscall_discovery" : "direct",
      missing_tools: missing,
      host_attachment: observed === null ? "this_mcp_process_replied; compare this release with the Host cache when another conversation cannot see it"
        : missing.length ? "bundle_or_surface_mismatch" : "surface_matches",
      execution_proof: execution,
      observability: { data_root: this.store.paths.root, ...(name === "knowledge" ? { learning_evaluation: knowledgeEvaluationDiagnostic(this.store.paths.knowledgeDir),
        learning_candidates: knowledgeCandidateDiagnostic(this.store.paths.knowledgeDir) } : {}),
        ...(name === "knowledge" || name === "experience" ? { learning_worker: learningWorkerDiagnostic(this.store.paths.runtimeDir, name, CRAFT_RELEASE_VERSION) } : {}),
        trace_retention: this.store.find("maintenance_component", "trace_retention") ?? { status: "not_observed" },
        telemetry_events: this.store.count("telemetry_event"), usage_records: this.store.count("usage_ledger"),
        usage_measurement: this.store.count("usage_ledger") === 0 ? "unavailable" : "recorded", full_content_logged: false },
      next_action: missing.length ? "reinstall_or_restart_the_host_then_compare_initialize_and_tools_list"
        : execution.status === "not_observed" ? "run_one_real_host_turn_then_recheck_with_session_id" : readiness.next_action,
    };
  }

  private knowledge(): JsonObject {
    const activeSources = this.store.list("knowledge_source", 10_000, (item) => item.status === "active").length;
    const claims = countByStatus(this.store, "knowledge_claim");
    const receipts = this.store.count("context_resolution_receipt");
    const evaluationCases = this.store.count("knowledge_evaluation_case");
    const taskEffectGateAvailable = knowledgeTaskEffectEvidenceVerified();
    const state = activeSources === 0 ? "bootstrap_required"
      : (claims.reviewed ?? 0) === 0 ? "evidence_review_pending" : taskEffectGateAvailable ? "ready" : "effect_evaluation_pending";
    return {
      component: "knowledge", state, counts: { active_sources: activeSources, claims, context_receipts: receipts, evaluation_cases: evaluationCases },
      task_effect_gate: taskEffectGateAvailable ? "available" : "unavailable",
      next_action: state === "bootstrap_required" ? "install_or_register_a_scoped_source"
        : state === "evidence_review_pending" ? "search_or_draft_evidence_backed_claims_then_review_them"
          : state === "effect_evaluation_pending" ? "implement_and_collect_independent_task_effect_evidence"
          : "resolve_a_bounded_context_receipt_for_the_current_scope",
      model_effect_proven: false,
      usage: {
        kind: "readiness_only",
        component_used: false,
        context_resolved: false,
      },
    };
  }

  private memory(): JsonObject {
    const activeSources = this.store.list("knowledge_source", 10_000, (item) => item.status === "active").length;
    const ledger = countByStatus(this.store, "memory_ledger");
    const candidates = countByStatus(this.store, "memory_candidate");
    const signals = this.store.count("memory_usage_signal");
    const feedback = this.store.list("context_feedback", 10_001, item => Array.isArray(item.memory_refs) && item.memory_refs.length > 0);
    const feedbackCount = Math.min(feedback.length, 10_000);
    const verifiedHelpfulFeedback = feedback.slice(0, 10_000).filter(item => item.outcome === "helpful" && item.evidence_verified === true).length;
    const state = activeSources === 0 ? "bootstrap_required"
      : (ledger.active ?? 0) === 0 ? "candidate_or_approval_required" : "ready";
    return {
      component: "memory", state, counts: { active_sources: activeSources, ledger, candidates, usage_signals: signals,
        memory_feedback_records: feedbackCount, verified_helpful_memory_feedback_records: verifiedHelpfulFeedback,
        memory_feedback_records_truncated: feedback.length > 10_000, context_receipts: this.store.count("context_resolution_receipt") },
      next_action: state === "bootstrap_required" ? "install_or_register_a_scoped_source"
        : state === "candidate_or_approval_required" ? "propose_and_review_one_scoped_evidence_linked_memory"
          : "resolve_only_the_current_scope_and_record_outcome_linked_usage",
      model_effect_proven: false,
      usage: {
        kind: "readiness_only",
        component_used: false,
        context_resolved: false,
      },
    };
  }

  private experience(): JsonObject {
    const observations = this.store.count("workflow_evolution_observation") + this.store.count("experience_observation");
    const requests = countByStatus(this.store, "workflow_evolution_request");
    const proposals = countByStatus(this.store, "workflow_evolution_proposal");
    const procedures = countByStatus(this.store, "experience_procedure");
    const patterns = this.store.count("experience_pattern");
    const state = observations < 2 ? "independent_observations_required"
      : (proposals.draft ?? 0) === 0 ? "draft_proposal_available" : "evaluation_required";
    return {
      component: "experience", state, counts: { observations, patterns, requests, draft_proposals: proposals.draft ?? 0, procedures, shadow_experiments: this.store.count("experience_shadow_experiment") },
      next_action: state === "independent_observations_required" ? "record_two_sanitized_evidence_backed_outcomes_for_one_scenario"
        : state === "draft_proposal_available" ? "propose_a_workflow_change_with_at_most_two_design_axes"
          : "evaluate_the_draft_in_shadow_then_use_signoff_and_canary_before_routing",
      model_effect_proven: false,
      usage: {
        kind: "readiness_only",
        component_used: false,
        context_resolved: false,
      },
    };
  }

  private executionProof(name: ComponentName, sessionId: unknown): JsonObject {
    const session = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
    const receipts = this.store.list("activation_proof_receipt", 10_000, (item) => item.component === name && (session === null || item.session_id === session));
    const current = receipts.filter((item) => item.plugin_release === CRAFT_RELEASE_VERSION);
    return { status: current.length ? "executed" : receipts.length ? "stale_plugin_or_receipt" : "not_observed", executions: current.length,
      context_receipt_id: current.find((item) => typeof item.context_receipt_id === "string")?.context_receipt_id ?? null,
      hook_trusted: current.some((item) => item.hook_trusted === true), mcp_reachable: current.some((item) => item.mcp_reachable === true),
      ...(name === "memory" ? { explicit_memory_written: current.some((item) => item.memory_written === true) } : {}),
      ...(name === "experience" ? { verified_observation_written: current.some((item) => item.observation_written === true) } : {}) };
  }
}

const REQUIRED_TOOLS: Readonly<Record<"knowledge" | "memory" | "experience", readonly string[]>> = {
  knowledge: ["craft_component_readiness_get", "craft_knowledge_search", "craft_context_resolution_resolve"],
  memory: ["craft_component_readiness_get", "craft_context_resolution_resolve", "craft_memory_maintenance_run"],
  experience: ["craft_component_readiness_get", "craft_context_resolution_resolve", "craft_scope_identity_resolve_project", "craft_experience_observe", "craft_experience_procedure_draft", "craft_procedure_get", "craft_procedure_gate", "craft_procedure_plan", "craft_procedure_invocation_bind", "craft_procedure_invocation_get"],
};

function ensureMountedComponent(requested: ComponentName, mounted?: ComponentName): void {
  if (mounted !== undefined && requested !== mounted) {
    throw new Error(`The mounted component is ${mounted}; it cannot answer ${requested} readiness. Call the craft-${requested} component instead.`);
  }
}

function toolNames(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("observed_tool_names must be an array");
  const names = value.map((item) => {
    if (typeof item !== "string" || !item.trim()) throw new Error("observed_tool_names must contain non-empty strings");
    const name = item.trim();
    const namespaced = /^mcp__(craft_(?:context|knowledge|memory|experience))__(craft_[a-z0-9_]+)$/u.exec(name);
    return namespaced?.[2] ?? name;
  });
  return [...new Set(names)].sort();
}
