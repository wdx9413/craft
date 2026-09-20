import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { CRAFT_RELEASE_VERSION } from "./version.ts";

const COMPONENTS = new Set(["knowledge", "memory", "experience"]);

function component(value: unknown): "knowledge" | "memory" | "experience" {
  if (typeof value !== "string" || !COMPONENTS.has(value)) {
    throw new Error("component must be knowledge, memory, or experience");
  }
  return value as "knowledge" | "memory" | "experience";
}

function countByStatus(store: CraftStore, kind: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of store.list(kind, 10_000)) {
    const status = typeof item.status === "string" ? item.status : "unknown";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
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

  get(args: JsonObject): JsonObject {
    switch (component(args.component)) {
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
  diagnose(args: JsonObject): JsonObject {
    const name = component(args.component);
    const readiness = this.get({ component: name });
    const expected = REQUIRED_TOOLS[name];
    const observed = args.observed_tool_names === undefined ? null : toolNames(args.observed_tool_names);
    const missing = observed === null ? [] : expected.filter((tool) => !observed.includes(tool));
    return {
      ...readiness,
      runtime_reachable: true,
      expected_product: `craft-${name}`,
      expected_release: CRAFT_RELEASE_VERSION,
      expected_tools: expected,
      observed_tools_supplied: observed !== null,
      missing_tools: missing,
      host_attachment: observed === null ? "this_mcp_process_replied; compare this release with the Host cache when another conversation cannot see it"
        : missing.length ? "bundle_or_surface_mismatch" : "surface_matches",
      next_action: missing.length ? "reinstall_or_restart_the_host_then_compare_initialize_and_tools_list" : readiness.next_action,
    };
  }

  private knowledge(): JsonObject {
    const activeSources = this.store.list("knowledge_source", 10_000, (item) => item.status === "active").length;
    const claims = countByStatus(this.store, "knowledge_claim");
    const receipts = this.store.count("context_resolution_receipt");
    const evaluationCases = this.store.count("knowledge_evaluation_case");
    const state = activeSources === 0 ? "bootstrap_required"
      : (claims.reviewed ?? 0) === 0 ? "evidence_review_pending" : "ready";
    return {
      component: "knowledge", state, counts: { active_sources: activeSources, claims, context_receipts: receipts, evaluation_cases: evaluationCases },
      next_action: state === "bootstrap_required" ? "install_or_register_a_scoped_source"
        : state === "evidence_review_pending" ? "search_or_draft_evidence_backed_claims_then_review_them"
          : "resolve_a_bounded_context_receipt_for_the_current_scope",
      model_effect_proven: false,
    };
  }

  private memory(): JsonObject {
    const activeSources = this.store.list("knowledge_source", 10_000, (item) => item.status === "active").length;
    const ledger = countByStatus(this.store, "memory_ledger");
    const candidates = countByStatus(this.store, "memory_candidate");
    const signals = this.store.count("memory_usage_signal");
    const state = activeSources === 0 ? "bootstrap_required"
      : (ledger.active ?? 0) === 0 ? "candidate_or_approval_required" : "ready";
    return {
      component: "memory", state, counts: { active_sources: activeSources, ledger, candidates, usage_signals: signals, context_receipts: this.store.count("context_resolution_receipt") },
      next_action: state === "bootstrap_required" ? "install_or_register_a_scoped_source"
        : state === "candidate_or_approval_required" ? "propose_and_review_one_scoped_evidence_linked_memory"
          : "resolve_only_the_current_scope_and_record_outcome_linked_usage",
      model_effect_proven: false,
    };
  }

  private experience(): JsonObject {
    const observations = this.store.count("workflow_evolution_observation");
    const requests = countByStatus(this.store, "workflow_evolution_request");
    const proposals = countByStatus(this.store, "workflow_evolution_proposal");
    const patterns = this.store.count("experience_pattern");
    const state = observations < 2 ? "independent_observations_required"
      : (proposals.draft ?? 0) === 0 ? "draft_proposal_available" : "evaluation_required";
    return {
      component: "experience", state, counts: { observations, patterns, requests, draft_proposals: proposals.draft ?? 0, shadow_experiments: this.store.count("experience_shadow_experiment") },
      next_action: state === "independent_observations_required" ? "record_two_sanitized_evidence_backed_outcomes_for_one_scenario"
        : state === "draft_proposal_available" ? "propose_a_workflow_change_with_at_most_two_design_axes"
          : "evaluate_the_draft_in_shadow_then_use_signoff_and_canary_before_routing",
      model_effect_proven: false,
    };
  }
}

const REQUIRED_TOOLS: Readonly<Record<"knowledge" | "memory" | "experience", readonly string[]>> = {
  knowledge: ["craft_component_readiness_get", "craft_knowledge_search", "craft_context_resolution_resolve"],
  memory: ["craft_component_readiness_get", "craft_context_resolution_resolve", "craft_memory_maintenance_run"],
  experience: ["craft_component_readiness_get", "craft_workflow_evolution_observe", "craft_workflow_evolution_propose"],
};

function toolNames(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("observed_tool_names must be an array");
  const names = value.map((item) => {
    if (typeof item !== "string" || !item.trim()) throw new Error("observed_tool_names must contain non-empty strings");
    return item;
  });
  return [...new Set(names)].sort();
}
