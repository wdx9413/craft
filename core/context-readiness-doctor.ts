import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ActivationProofKernel } from "./activation-proof.ts";
import { buildCapabilityIterationPlan } from "./capability-iteration-plan.ts";
import { contextUsageStatusline } from "./context-usage-statusline.ts";
import { CRAFT_RELEASE_VERSION } from "./version.ts";
import { dataSpaceId } from "./data-space.ts";
import { learningWorkerDiagnostic } from "./learning-worker-diagnostic.ts";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";

const COMPONENTS = ["knowledge", "memory", "experience"] as const;
const CORRECTION_STATES = ["pending_review", "confirmed", "dismissed", "resolved", "decided"];

function boundedState(directory: string, name: string): JsonObject {
  try {
    const raw = readFileSync(join(directory, name), "utf8");
    if (Buffer.byteLength(raw, "utf8") > 4096) return { status: "unavailable" };
    const value = JSON.parse(raw) as JsonObject;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return { status: "unavailable" };
    return { status: "observed", schema: typeof value.schema === "string" ? value.schema : null,
      updated_at: typeof value.updated_at === "string" ? value.updated_at : null };
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "not_observed" : "unavailable" };
  }
}

function countStatus(store: CraftStore, kind: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of store.list(kind, 10_001, undefined, false)) {
    const status = typeof item.status === "string" ? item.status : "unknown";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function feedbackOutcomes(store: CraftStore): Record<string, number> {
  const outcomes: Record<string, number> = {};
  for (const item of store.list("context_feedback", 10_001, undefined, false)) {
    const outcome = typeof item.outcome === "string" ? item.outcome : "unknown";
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }
  return outcomes;
}

function latestInjectedTokens(store: CraftStore): number | null {
  const feedback = store.list("context_feedback", 100, undefined, false);
  for (let index = feedback.length - 1; index >= 0; index -= 1) {
    const measurement = feedback[index]!.token_measurement as JsonObject | undefined;
    const value = measurement?.injected_tokens;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  }
  return null;
}

export function contextReadinessDoctor(store: CraftStore, args: JsonObject = {}): JsonObject {
  const projectRoot = typeof args.project_root === "string" && args.project_root.trim() ? args.project_root.trim() : null;
  const sessionId = typeof args.session_id === "string" && args.session_id.trim() ? args.session_id.trim() : null;
  let identity: JsonObject | null = null;
  let registryMigration: JsonObject | null = null;
  if (projectRoot !== null) {
    const aliases = store.list("scope_alias", 100, item => typeof item.alias === "string" && item.alias === projectRoot, false);
    const canonicalId = aliases[0] ? (aliases[0].scope as JsonObject | undefined)?.id : null;
    try { identity = typeof canonicalId === "string" ? store.get("project_identity", canonicalId) : null; } catch { identity = null; }
    registryMigration = store.list("project_registry_migration", 1, item => item.project_root === projectRoot, false)[0] ?? null;
  }
  return {
    release: CRAFT_RELEASE_VERSION,
    surface: typeof args.surface === "string" ? args.surface : null,
    data_space_id: dataSpaceId(store.paths.root),
    project_root: projectRoot,
    session_id: sessionId,
    identity: identity === null ? { status: "not_requested" } : { status: "registry_record_observed", id: String(identity.id) },
    migration: registryMigration === null ? { state: "not_observed" } : { state: registryMigration.state ?? "unknown",
      legacy_scope_id: registryMigration.legacy_scope_id ?? null, data_migrated: registryMigration.data_migrated === true },
    activation: new ActivationProofKernel(store).doctor(sessionId ? { session_id: sessionId } : {}),
    learning_workers: {
      knowledge: learningWorkerDiagnostic(store.paths.runtimeDir, "knowledge", CRAFT_RELEASE_VERSION),
      experience: learningWorkerDiagnostic(store.paths.runtimeDir, "experience", CRAFT_RELEASE_VERSION),
    },
    learning_state: {
      knowledge: boundedState(store.paths.knowledgeDir, "learning-worker-state.json"),
      stage_cursor: boundedState(store.paths.knowledgeDir, "learning-stage-cursor.json"),
      session_adjudication: boundedState(store.paths.knowledgeDir, "session-adjudication-cursor.json"),
      classification_attempts: boundedState(store.paths.knowledgeDir, "classification-attempts.json"),
    },
    components: Object.fromEntries(COMPONENTS.map(component => [component, {
      records: store.count(component === "experience" ? "experience_observation" : component === "memory" ? "memory_ledger" : "knowledge_claim"),
      status_counts: countStatus(store, component === "experience" ? "experience_observation" : component === "memory" ? "memory_ledger" : "knowledge_claim"),
    }])),
    context: {
      receipts: store.count("context_resolution_receipt"),
      working_sets: store.count("context_working_set_receipt"),
      emissions: store.count("context_emission"),
      feedback: store.count("context_feedback"),
      feedback_outcomes: feedbackOutcomes(store),
      corrections: countStatus(store, "context_correction_task"),
      correction_states: CORRECTION_STATES,
      resume_snapshots: store.count("context_resume_snapshot"),
      latest_injected_tokens: latestInjectedTokens(store),
    },
    usage_statusline: contextUsageStatusline(store, { session_id: sessionId ?? undefined }),
    iteration_plan: (() => {
      try { return buildCapabilityIterationPlan(store, { project_scope_id: String(args.project_scope_id ?? "global") }); }
      catch { return { status: "requires_explicit_project_scope" }; }
    })(),
    execution_context: false,
    config_is_not_execution_proof: true,
  };
}
