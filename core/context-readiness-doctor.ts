import { catalogOwner } from "./infrastructure/owned-catalog.ts";
import { hookVerificationGap, type HookHostReadiness } from "./interfaces/codex-hook-signal-sanitizer.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ActivationProofKernel } from "./activation-proof.ts";
import { buildCapabilityIterationPlan } from "./capability-iteration-plan.ts";
import { contextUsageStatusline } from "./context-usage-statusline.ts";
import { CRAFT_RELEASE_VERSION } from "./version.ts";
import { dataSpaceId } from "./data-space.ts";
import { learningWorkerDiagnostic } from "./learning-worker-diagnostic.ts";
import { PROVIDER_CATALOG } from "./model-gateway.ts";
import { normalizeSettings } from "./settings.ts";
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

function countStatus(store: CraftStore | null, kind: string): { counts: Record<string, number>; status: "available" | "incomplete" | "owner_unavailable" } {
  if (!store) return { counts: {}, status: "owner_unavailable" };
  const counts: Record<string, number> = {};
  try {
    for (const item of store.list(kind, 10_001, undefined, false)) {
      const status = typeof item.status === "string" ? item.status : typeof item.lifecycle === "string" ? item.lifecycle : "unknown";
      counts[status] = (counts[status] ?? 0) + 1;
    }
    return { counts, status: "available" };
  } catch {
    // Readiness is diagnostic. One retired project partition must not make the
    // whole Context Doctor unavailable or turn inaccessible records into zeroes.
    return { counts: {}, status: "incomplete" };
  }
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

function learningModelDiagnostic(store: CraftStore): JsonObject {
  const host = process.env.CRAFT_LEARNING_MODEL_HOST;
  if (host === "codex-cli" || host === "claude-code") {
    const model = PROVIDER_CATALOG.find(provider => provider.provider === host)?.models.small ?? null;
    return { status: "host_declared", host, model, execution: "unverified" };
  }
  if (host) return { status: "blocked", reason: "unsupported_learning_model_host", execution: "unverified" };
  const absent = { status: "blocked", reason: "no_configured_model", execution: "unverified" };
  if (!store.paths.settingsFile) return absent;
  try {
    const settings = normalizeSettings(JSON.parse(readFileSync(store.paths.settingsFile, "utf8").replace(/^\uFEFF/u, "")), store.paths);
    return settings.models.length
      ? { status: "gateway_models_configured", configured_models: settings.models.length, execution: "unverified" }
      : absent;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return absent;
    return { status: "blocked", reason: "invalid_model_configuration", execution: "unverified" };
  }
}

export interface ContextDoctorSources { stores?: ReadonlyMap<string, CraftStore>; readiness?: HookHostReadiness }
function recordCount(store: CraftStore | null, kind: string): number | null {
  if (!store) return null;
  try { return store.count(kind); } catch { return null; }
}

export function contextReadinessDoctor(store: CraftStore, args: JsonObject = {}, sources: ContextDoctorSources = {}): JsonObject {
  const own = catalogOwner(store.paths.databaseDir), owned = sources.stores !== undefined || own !== undefined;
  const owner = (name: string): CraftStore | null => sources.stores?.get(name) ?? (own === name || !owned ? store : null);
  const contextStore = owner("context"), runtimeStore = owner("runtime"), knowledgeStore = owner("knowledge");
  const count = (name: string, kind: string) => recordCount(owner(name), kind);

  const projectRoot = typeof args.project_root === "string" && args.project_root.trim() ? args.project_root.trim() : null;
  const sessionId = typeof args.session_id === "string" && args.session_id.trim() ? args.session_id.trim() : null;
  const correctionStatus = countStatus(contextStore, "context_correction_task");
  let identity: JsonObject | null = null;
  let registryMigration: JsonObject | null = null;
  if (projectRoot !== null && contextStore) {
    const aliases = contextStore.list("scope_alias", 100, item => typeof item.alias === "string" && item.alias === projectRoot, false);
    const canonicalId = aliases[0] ? (aliases[0].scope as JsonObject | undefined)?.id : null;
    try { identity = typeof canonicalId === "string" ? contextStore.get("project_identity", canonicalId) : null; } catch { identity = null; }
    registryMigration = contextStore.list("project_registry_migration", 1, item => item.project_root === projectRoot, false)[0] ?? null;
  }
  const journals = runtimeStore ? runtimeStore.list("codex_hook_turn", 100, item => sessionId === null || item.session_id === sessionId, false) : [];
  const latest = journals.filter(item => item.has_edit === true).at(-1) ?? journals.at(-1) ?? null;
  const proofStores = [contextStore, knowledgeStore, owner("memory"), owner("experience"), runtimeStore].filter((source): source is CraftStore => source !== null);
  const activation = proofStores.length ? new ActivationProofKernel(contextStore ?? proofStores[0]!, proofStores).doctor(sessionId ? { session_id: sessionId } : {}) : { status: "owner_unavailable", components: [] };
  const trustStates = (activation.components as JsonObject[]).map(component => component.hook_trust_status);
  const readiness: HookHostReadiness = { hook_trust: trustStates.includes("untrusted") ? "untrusted" : trustStates.includes("trusted") ? "trusted" : "unknown", ...sources.readiness };
  return {
    release: CRAFT_RELEASE_VERSION,
    surface: typeof args.surface === "string" ? args.surface : null,
    data_space_id: dataSpaceId(store.paths.root),
    project_root: projectRoot,
    session_id: sessionId,
    identity: identity === null ? { status: projectRoot && !contextStore ? "owner_unavailable" : "not_requested" } : { status: "registry_record_observed", id: String(identity.id) },
    migration: registryMigration === null ? { state: "not_observed" } : { state: registryMigration.state ?? "unknown",
      legacy_scope_id: registryMigration.legacy_scope_id ?? null, data_migrated: registryMigration.data_migrated === true },
    activation: { ...activation, data: { context_receipts: count("context", "context_resolution_receipt"),
      memory_ledger: count("memory", "memory_ledger"), experience_observations: count("experience", "workflow_evolution_observation") } },
    verification_gap: { ...hookVerificationGap(latest, readiness), readiness_source: sources.readiness ? "observed_host_readiness_port" : "not_probed" },
    learning_chain: Object.fromEntries([
      ["observations", "experience", "workflow_evolution_observation"], ["legacy_observations", "experience", "experience_observation"], ["candidates", "context", "program_memory_candidate"],
      ["submission_operations", "context", "program_memory_submission"], ["enrollments", "context", "context_learning_enrollment"],
      ["dispatches", "experience", "experience_evaluation_dispatch"], ["releases", "experience", "experience_release"],
      ["contracts", "eval", "evaluation_contract"], ["task_effect_reports", "eval", "task_effect_evaluation"],
    ].map(([stage, owning, kind]) => [stage!, { owner: owning, kind, records: count(owning!, kind!), ...countStatus(owner(owning!), kind!) }])),
    learning_workers: {
      knowledge: runtimeStore ? learningWorkerDiagnostic(runtimeStore.paths.runtimeDir, "knowledge", CRAFT_RELEASE_VERSION) : { status: "owner_unavailable" },
      experience: runtimeStore ? learningWorkerDiagnostic(runtimeStore.paths.runtimeDir, "experience", CRAFT_RELEASE_VERSION) : { status: "owner_unavailable" },
    },
    learning_model: runtimeStore ? learningModelDiagnostic(runtimeStore) : { status: "owner_unavailable", execution: "unverified" },
    learning_state: {
      knowledge: knowledgeStore ? boundedState(knowledgeStore.paths.knowledgeDir, "learning-worker-state.json") : { status: "owner_unavailable" },
      stage_cursor: knowledgeStore ? boundedState(knowledgeStore.paths.knowledgeDir, "learning-stage-cursor.json") : { status: "owner_unavailable" },
      session_adjudication: knowledgeStore ? boundedState(knowledgeStore.paths.knowledgeDir, "session-adjudication-cursor.json") : { status: "owner_unavailable" },
      classification_attempts: knowledgeStore ? boundedState(knowledgeStore.paths.knowledgeDir, "classification-attempts.json") : { status: "owner_unavailable" },
    },
    components: Object.fromEntries(COMPONENTS.map(component => {
      const kind = component === "experience" ? "workflow_evolution_observation" : component === "memory" ? "memory_ledger" : "knowledge_claim";
      const status = countStatus(owner(component), kind);
      return [component, { owner: component, kind, records: count(component, kind), status_counts: status.counts, status_counts_status: status.status }];
    })),
    context: {
      receipts: recordCount(contextStore, "context_resolution_receipt"),
      working_sets: recordCount(contextStore, "context_working_set_receipt"),
      emissions: recordCount(contextStore, "context_emission"),
      feedback: recordCount(contextStore, "context_feedback"),
      feedback_outcomes: contextStore ? feedbackOutcomes(contextStore) : {},
      corrections: correctionStatus.counts,
      correction_status_counts_status: correctionStatus.status,
      correction_states: CORRECTION_STATES,
      resume_snapshots: recordCount(contextStore, "context_resume_snapshot"),
      latest_injected_tokens: contextStore ? latestInjectedTokens(contextStore) : null,
    },
    usage_statusline: contextStore ? contextUsageStatusline(contextStore, { session_id: sessionId ?? undefined }) : { status: "owner_unavailable" },
    iteration_plan: (() => {
      try {
        if (!contextStore) return { status: "owner_unavailable" };
        const plan = buildCapabilityIterationPlan(contextStore, { project_scope_id: String(args.project_scope_id ?? "global") });
        return { ...plan, readiness: { knowledge_claim_statuses: countStatus(knowledgeStore, "knowledge_claim").counts,
          knowledge_evaluation_cases: count("knowledge", "knowledge_evaluation_case"), memory_ledger: count("memory", "memory_ledger"),
          experience_observations: count("experience", "workflow_evolution_observation"), context_emissions: count("context", "context_emission"), context_feedback: count("context", "context_feedback") } };
      }
      catch { return { status: "requires_explicit_project_scope" }; }
    })(),
    execution_context: false,
    config_is_not_execution_proof: true,
  };
}
