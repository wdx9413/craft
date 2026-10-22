import type { JsonObject } from "../../core/infrastructure/store.ts";

export interface LearningTickDependencies {
  run_session_collection?(): Promise<JsonObject>;
  run_experience_pass(): Promise<JsonObject>;
  run_knowledge_pass(): Promise<JsonObject>;
  pass_order?: "experience_first" | "knowledge_first";
}

function failureKind(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  return /^[A-Za-z][A-Za-z0-9]{0,31}$/u.test(name) ? name : "Error";
}

const SAFE_CLASSIFICATION_SKIP_REASONS = new Set([
  "ambiguous", "model_profile_unavailable", "model_profile_not_ready", "multiple_active_profiles_for_purpose",
  "multiple_models_require_explicit_profile", "needs_credential", "needs_enablement", "no_configured_model",
  "provider_unavailable", "unavailable", "explicitly_enable_network_execution",
]);

function classificationSkipReason(classification: JsonObject): string {
  const reason = classification.reason;
  if (typeof reason === "string" && (SAFE_CLASSIFICATION_SKIP_REASONS.has(reason) || /^set_[A-Z][A-Z0-9_]{0,63}$/u.test(reason))) return reason;
  return "configuration_unavailable";
}

/** A poll isolates Experience and Knowledge failures so the next scheduled pass can recover. */
export async function runLearningTick(deps: LearningTickDependencies, syncKnowledge = false): Promise<JsonObject> {
  let sessionCollection: JsonObject | null = null;
  if (deps.run_session_collection) {
    try { sessionCollection = await deps.run_session_collection(); }
    catch (error) { sessionCollection = { status: "failed", failure_kind: failureKind(error) }; }
  }
  let experience: JsonObject = { processed: 0, outcomes: [] }, knowledge: JsonObject | null = null;
  const runExperience = async () => { try { experience = await deps.run_experience_pass(); }
    catch (error) { experience = { processed: 0, outcomes: [], failure_kind: failureKind(error) }; } };
  const runKnowledge = async () => { if (!syncKnowledge) return;
    try { knowledge = await deps.run_knowledge_pass(); }
    catch (error) { knowledge = { status: "failed", failure_kind: failureKind(error) }; } };
  if (deps.pass_order === "knowledge_first") { await runKnowledge(); await runExperience(); }
  else { await runExperience(); await runKnowledge(); }
  return { ...experience, ...(sessionCollection ? { session_collection: sessionCollection } : {}), knowledge };
}

export function learningTickStatus(result: JsonObject, once: boolean): { diagnostics: string; exit_code: number | null } {
  const sessionCollection = result.session_collection && typeof result.session_collection === "object" ? result.session_collection as JsonObject : null;
  const sessionCollectionFailure = typeof sessionCollection?.failure_kind === "string" ? sessionCollection.failure_kind : null;
  const experienceFailure = typeof result.failure_kind === "string" ? result.failure_kind : null;
  const knowledge = result.knowledge && typeof result.knowledge === "object" ? result.knowledge as JsonObject : null;
  const knowledgeFailure = typeof knowledge?.failure_kind === "string" ? knowledge.failure_kind : null;
  const classification = knowledge?.classification && typeof knowledge.classification === "object" ? knowledge.classification as JsonObject : null;
  const classificationFailure = classification?.status === "failed"
    ? typeof classification.failure_kind === "string" && /^[A-Za-z][A-Za-z0-9]{0,31}$/u.test(classification.failure_kind) ? classification.failure_kind : "Error"
    : null;
  const classificationSkipped = classification?.skipped === true;
  const classificationSkip = classificationSkipped ? classificationSkipReason(classification!) : null;
  const failedClassifications = Array.isArray(classification?.outcomes)
    ? (classification.outcomes as unknown[]).filter(value => Boolean(value && typeof value === "object" && !Array.isArray(value)
      && (value as JsonObject).status === "failed")).length : 0;
  const classificationFailureStages = new Map<string, number>();
  if (Array.isArray(classification?.outcomes)) for (const value of classification.outcomes as unknown[]) {
    if (!value || typeof value !== "object" || Array.isArray(value) || (value as JsonObject).status !== "failed") continue;
    const stage = (value as JsonObject).failure_stage;
    const code = (value as JsonObject).failure_code;
    const safeStage = typeof stage === "string" && ["taxonomy_list", "ticket_issue", "model_request", "response_parse", "response_validate",
      "review_packet_validate", "host_review", "claim_review", "claim_save", "result_trace", "ticket_bind", "ticket_complete", "trace_finalize",
      "attempt_state_check", "attempt_state_save"].includes(stage) ? stage : null;
    const safeCode = typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(code) ? code : null;
    if (safeStage) {
      const key = safeCode ? `${safeStage}/${safeCode}` : safeStage;
      classificationFailureStages.set(key, (classificationFailureStages.get(key) ?? 0) + 1);
    }
  }
  const stageSummary = [...classificationFailureStages].sort(([left], [right]) => left.localeCompare(right)).map(([stage, count]) => `${stage}:${count}`).join(",");
  const sourceIssues = Array.isArray(knowledge?.outcomes) ? (knowledge.outcomes as unknown[]).flatMap(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const outcome = value as JsonObject;
    const status = outcome.status;
    if (status !== "failed" && status !== "partial") return [];
    const source = typeof outcome.source_ref === "string" && /^sha256:[a-f0-9]{64}$/u.test(outcome.source_ref)
      ? outcome.source_ref : "unknown_source";
    if (status === "partial") return [`Craft Knowledge source ${source} sync is partial; remaining pages will resume in a later pass.\n`];
    const kind = typeof outcome.failure_kind === "string" && /^[A-Za-z][A-Za-z0-9]{0,31}$/u.test(outcome.failure_kind)
      ? outcome.failure_kind : "Error";
    const code = typeof outcome.failure_code === "string" && /^(?:ERR_[A-Z_]+|[A-Z][A-Z_]{0,63})$/u.test(outcome.failure_code) ? ` [${outcome.failure_code}]` : "";
    return [`Craft Knowledge source ${source} sync failed (${kind})${code}.\n`];
  }) : [];
  const diagnostics = [
    ...(sessionCollectionFailure ? [`Craft Codex session collection failed (${sessionCollectionFailure}).\n`] : []),
    ...(experienceFailure ? [`Craft Experience learning pass failed (${experienceFailure}).\n`] : []),
    ...(knowledgeFailure ? [`Craft Knowledge learning pass failed (${knowledgeFailure}).\n`] : []),
    ...(classificationFailure ? [`Craft Knowledge scenario classification failed (${classificationFailure}).\n`] : []),
    ...(classificationSkip ? [`Craft Knowledge scenario classification skipped (${classificationSkip}); configure one ready model profile to resume.\n`] : []),
    ...(!classificationFailure && failedClassifications ? [`Craft Knowledge scenario classification failed for ${failedClassifications} Claim(s)${stageSummary ? ` at ${stageSummary}` : ""}.\n`] : []),
    ...sourceIssues,
  ].join("");
  return { diagnostics, exit_code: once && (sessionCollectionFailure !== null || experienceFailure !== null || knowledgeFailure !== null || classificationFailure !== null || classificationSkipped || failedClassifications > 0 || sourceIssues.length > 0) ? 1 : null };
}

export function learningFailureKind(error: unknown): string { return failureKind(error); }
