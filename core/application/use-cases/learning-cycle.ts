import type { CraftService } from "../craft-service.ts";
import type { JsonObject } from "../../infrastructure/store.ts";
import { payload, stableDigest } from "../../digest.ts";
import { completeExperienceScenarioClassificationRequest, createExperienceScenarioClassificationRequest, experienceScenarioCanClassify, experienceScenarioIsRetired, getExperienceScenarioClassificationRequest, listExperienceScenarios, proposeExperienceScenarioMigration, recordExperienceScenario, retireExperienceScenario, validateExperienceScenarioDefinition } from "../../../capability/craft-experience/scenario-catalog.ts";
import { projectExperienceDirectory, projectPathAliasDigest } from "../../project-experience-directory.ts";

declare module "../craft-service.ts" {
  interface CraftService { learningCycleFinalize(args: JsonObject): JsonObject; learningCycleRequestGet(args: JsonObject): JsonObject; experienceScenarioList(args: JsonObject): JsonObject; experienceScenarioRetire(args: JsonObject): JsonObject; experienceScenarioMigrationPropose(args: JsonObject): JsonObject; experienceScenarioClassificationRequestGet(args: JsonObject): JsonObject; experienceScenarioClassificationRequestComplete(args: JsonObject): JsonObject; }
}

const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{8,}/iu;

function classificationContext(value: unknown): JsonObject | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("scenario_context must be a bounded object");
  const context = value as JsonObject;
  const field = (name: string): string => {
    const raw = context[name];
    if (typeof raw !== "string" || !raw.trim() || raw.trim().length > 320 || /[\r\n\0]/u.test(raw) || SECRET.test(raw)) {
      throw new Error(`scenario_context.${name} must be a short sanitized summary`);
    }
    return raw.trim();
  };
  if (context.sanitized !== true || context.content_stored !== false) throw new Error("scenario_context must attest sanitized content-free input");
  return { task_goal: field("task_goal"), effect_summary: field("effect_summary"), sanitized: true, content_stored: false };
}

/** MCP/Skill Host completion entry point. Host attestation creates an Observation, never a release. */
export function installLearningCycleMethods(serviceClass: typeof CraftService): void {
  serviceClass.prototype.experienceScenarioList = function (args) {
    const scope = typeof args.scope === "string" ? args.scope.trim()
      : typeof args.scope_kind === "string" && typeof args.scope_id === "string" ? `${args.scope_kind}:${args.scope_id.trim()}` : "";
    const match = /^project:([A-Za-z0-9_-]{1,96})$/u.exec(scope);
    if (!match) throw new Error("Experience scenario catalog requires one explicit project scope");
    const experienceDir = projectExperienceDirectory(this.store, scope, typeof args.project_root === "string" ? args.project_root : undefined);
    return { scope, ...listExperienceScenarios(experienceDir, match[1]!) };
  };
  serviceClass.prototype.experienceScenarioClassificationRequestGet = function (args) {
    const scope = typeof args.scope === "string" ? args.scope.trim() : "";
    const match = /^project:([A-Za-z0-9_-]{1,96})$/u.exec(scope);
    if (!match || typeof args.request_id !== "string" || !args.request_id.trim()) throw new Error("Experience classification request requires an explicit project scope and id");
    const reference = this.store.get("experience_scenario_classification_request_ref", args.request_id);
    if (reference.scope !== scope) throw new Error("Experience classification request reference scope does not match");
    const aliasDigest = typeof reference.project_path_alias_digest === "string" ? reference.project_path_alias_digest : undefined;
    if (aliasDigest !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(aliasDigest)) throw new Error("Experience classification request project alias digest is invalid");
    const experienceDir = projectExperienceDirectory(this.store, scope, typeof args.project_root === "string" ? args.project_root : undefined,
      false, aliasDigest);
    const request = getExperienceScenarioClassificationRequest(experienceDir, args.request_id);
    if (request.scope !== scope) throw new Error("Experience classification request scope does not match");
    return { request, taxonomy: listExperienceScenarios(experienceDir, match[1]!), content_stored: false };
  };
  serviceClass.prototype.experienceScenarioClassificationRequestComplete = function (args) {
    const scope = typeof args.scope === "string" ? args.scope.trim() : "";
    const match = /^project:([A-Za-z0-9_-]{1,96})$/u.exec(scope);
    if (!match || typeof args.request_id !== "string" || !args.request_id.trim()) throw new Error("Experience classification completion requires an explicit project scope and id");
    if (args.status !== "classified" && args.status !== "unclassified") throw new Error("Experience classification status is invalid");
    const ref = this.store.get("experience_scenario_classification_request_ref", args.request_id);
    if (ref.scope !== scope) throw new Error("Experience classification request reference scope does not match");
    const aliasDigest = typeof ref.project_path_alias_digest === "string" ? ref.project_path_alias_digest : undefined;
    if (aliasDigest !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(aliasDigest)) throw new Error("Experience classification request project alias digest is invalid");
    const experienceDir = projectExperienceDirectory(this.store, scope, typeof args.project_root === "string" ? args.project_root : undefined,
      false, aliasDigest);
    const current = getExperienceScenarioClassificationRequest(experienceDir, args.request_id);
    if (current.scope !== scope) throw new Error("Experience classification request scope does not match");
    const completed = completeExperienceScenarioClassificationRequest({ experience_dir: experienceDir, request_id: args.request_id,
      expected_version: Number(args.expected_version), status: args.status, result_digest: String(args.result_digest ?? "") });
    if (ref.status === "awaiting_model") this.store.save("experience_scenario_classification_request_ref", args.request_id,
      { ...payload(ref), status: args.status, result_digest: args.result_digest, request_version: Number((completed.request as JsonObject).version) });
    else if (ref.status !== args.status || ref.result_digest !== args.result_digest) throw new Error("Experience classification request reference conflicts with its prior result");
    return completed;
  };
  serviceClass.prototype.experienceScenarioRetire = function (args) {
    const scope = typeof args.scope === "string" ? args.scope.trim()
      : typeof args.scope_kind === "string" && typeof args.scope_id === "string" ? `${args.scope_kind}:${args.scope_id.trim()}` : "";
    const match = /^project:([A-Za-z0-9_-]{1,96})$/u.exec(scope);
    if (!match) throw new Error("Experience scenario retirement requires an explicit project scope");
    if (!Number.isSafeInteger(args.expected_catalog_version) || Number(args.expected_catalog_version) < 0) throw new Error("expected_catalog_version must be a non-negative integer");
    if (typeof args.request_id !== "string" || !args.request_id.trim() || typeof args.reason !== "string" || !args.reason.trim()) throw new Error("request_id and reason must not be empty");
    const scenarioKey = String(args.scenario_key ?? "");
    if (!/^[a-z0-9][a-z0-9._/-]{0,95}$/u.test(scenarioKey)) throw new Error("Experience scenario retirement request is invalid");
    const experienceDir = projectExperienceDirectory(this.store, scope, typeof args.project_root === "string" ? args.project_root : undefined, true);
    const result = retireExperienceScenario({ experience_dir: experienceDir, project_id: match[1]!, scenario_key: scenarioKey,
      expected_catalog_version: Number(args.expected_catalog_version), request_id: args.request_id, reason: args.reason });
    const transition = result.transition as JsonObject;
    const retirementDigest = String(transition.reason_digest);
    let revokedProcedureCount = 0, cancelledDispatchCount = 0;
    this.store.transaction(() => {
      const procedures = this.store.list("experience_procedure", 10_000, procedure => {
        const signature = procedure.scenario_signature as JsonObject | undefined;
        return procedure.scope === `project:${match[1]}` && signature?.scenario_key === scenarioKey;
      });
      const ids = new Set(procedures.map(procedure => String(procedure.id)));
      for (const procedure of procedures) {
        if (procedure.lifecycle !== "rolled_back" || procedure.scenario_retirement_digest !== retirementDigest) {
          this.store.save("experience_procedure", String(procedure.id), { ...payload(procedure), lifecycle: "rolled_back", routeable: false,
            scenario_retired: true, scenario_retirement_digest: retirementDigest });
          revokedProcedureCount += 1;
        }
        const release = this.store.find("experience_release", String(procedure.id));
        if (release && release.status !== "revoked") this.store.save("experience_release", String(release.id), { ...payload(release), status: "revoked",
          revocation_reason_digest: retirementDigest });
      }
      for (const dispatch of this.store.list("experience_evaluation_dispatch", 10_000,
        item => ids.has(String(item.procedure_id)) && item.status === "awaiting_adapter")) {
        this.store.save("experience_evaluation_dispatch", String(dispatch.id), { ...payload(dispatch), status: "cancelled",
          cancellation_reason_digest: retirementDigest });
        cancelledDispatchCount += 1;
      }
    });
    return { ...result, revoked_procedure_count: revokedProcedureCount, cancelled_dispatch_count: cancelledDispatchCount };
  };
  serviceClass.prototype.experienceScenarioMigrationPropose = function (args) {
    const scope = typeof args.scope === "string" ? args.scope.trim()
      : typeof args.scope_kind === "string" && typeof args.scope_id === "string" ? `${args.scope_kind}:${args.scope_id.trim()}` : "";
    const match = /^project:([A-Za-z0-9_-]{1,96})$/u.exec(scope);
    if (!match) throw new Error("Experience scenario migration requires an explicit project scope");
    if (!Array.isArray(args.source_keys) || !Array.isArray(args.targets)) throw new Error("Experience scenario migration sources and targets must be arrays");
    const mode = String(args.mode);
    const sourceKeys = [...new Set(args.source_keys as string[])], targets = args.targets as Array<{ scenario_key?: string }>;
    if ((mode !== "merge" && mode !== "split") || !Number.isSafeInteger(args.expected_catalog_version) || Number(args.expected_catalog_version) < 0
      || typeof args.request_id !== "string" || !args.request_id.trim() || typeof args.reason !== "string" || !args.reason.trim()
      || sourceKeys.length !== (args.source_keys as unknown[]).length
      || mode === "merge" && (sourceKeys.length < 2 || targets.length !== 1)
      || mode === "split" && (sourceKeys.length !== 1 || targets.length < 2 || targets.length > 8)) {
      throw new Error("Experience scenario migration proposal is invalid");
    }
    const experienceDir = projectExperienceDirectory(this.store, scope, typeof args.project_root === "string" ? args.project_root : undefined, true);
    return proposeExperienceScenarioMigration({ experience_dir: experienceDir, project_id: match[1]!,
      mode: String(args.mode) as "merge" | "split", source_keys: args.source_keys as string[],
      targets: args.targets as Array<{ scenario_key: string; definition: unknown }>,
      expected_catalog_version: Number(args.expected_catalog_version), request_id: args.request_id, reason: args.reason });
  };
  serviceClass.prototype.learningCycleRequestGet = function (args) {
    const id = args.request_id;
    if (typeof id !== "string" || !id.trim()) throw new Error("request_id must not be empty");
    const request = this.store.get("workflow_evolution_request", id.trim());
    const refs = Array.isArray(request.observation_refs) ? request.observation_refs as JsonObject[] : [];
    const observations = refs.map(ref => this.store.get("workflow_evolution_observation", String(ref.id), Number(ref.version)));
    return { request, observations, content_stored: false, execution_authority: false };
  };
  serviceClass.prototype.learningCycleFinalize = function (args) {
    const requiredText = (key: string): string => {
      const value = args[key];
      if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must not be empty`);
      return value.trim();
    };
    const host = requiredText("host");
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(host)) throw new Error("host must be a bounded Host identifier");
    const taskId = requiredText("task_id"), turnId = requiredText("turn_id"), receiptId = requiredText("context_receipt_id");
    const outcome = requiredText("verification_outcome");
    if (outcome !== "passed" && outcome !== "failed") throw new Error("verification_outcome must be passed or failed");
    const verificationRef = requiredText("verification_ref");
    const resolution = this.store.find("context_resolution_receipt", receiptId);
    const pack = resolution ? null : this.store.find("context_pack_receipt", receiptId);
    const receipt = resolution ?? (pack ? this.store.find("context_resolution_receipt", String(pack.context_receipt_id)) : null);
    if (!receipt) throw new Error("context_receipt_id must reference a stored Context receipt");
    if (args.verified !== true) return { status: "ignored", reason: "verification_not_attested", observation: null, request: null, idempotent: false };
    const scope = receipt.scope as JsonObject | undefined;
    if (!scope || typeof scope.kind !== "string" || typeof scope.id !== "string") throw new Error("Context receipt has no usable scope");
    if (receipt.task_id && receipt.task_id !== taskId) throw new Error("task_id does not match the Context receipt");
    const scenarioInput = args.scenario_key;
    if (scenarioInput !== undefined && (typeof scenarioInput !== "string" || !/^[a-z0-9][a-z0-9._/-]{0,95}$/u.test(scenarioInput))) throw new Error("scenario_key must be a bounded stable identifier");
    const projectScope = scope.kind === "project" ? String(scope.id).startsWith("project:") ? String(scope.id) : `project:${scope.id}` : null;
    const observationScope = projectScope ?? `${scope.kind}:${scope.id}`;
    const projectRoot = typeof args.project_root === "string" ? args.project_root : undefined;
    const coarseScenario = args.coarse_scenario_key;
    if (coarseScenario !== undefined && (typeof coarseScenario !== "string" || !/^[a-z0-9][a-z0-9._/-]{0,95}$/u.test(coarseScenario))) throw new Error("coarse_scenario_key must be a bounded stable identifier");
    if (coarseScenario !== undefined && scenarioInput === undefined) throw new Error("coarse_scenario_key requires scenario_key");
    const verifierDigest = args.scenario_verifier_digest;
    if (verifierDigest !== undefined && (typeof verifierDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(verifierDigest))) throw new Error("scenario_verifier_digest must be a SHA-256 digest");
    const scenarioDefinition = args.scenario_definition;
    const coarseScenarioDefinition = args.coarse_scenario_definition;
    const validatedScenarioDefinition = validateExperienceScenarioDefinition(scenarioDefinition);
    const validatedCoarseScenarioDefinition = validateExperienceScenarioDefinition(coarseScenarioDefinition);
    const scenarioContext = classificationContext(args.scenario_context);
    if (validatedCoarseScenarioDefinition && coarseScenario === undefined) throw new Error("coarse scenario definition requires coarse_scenario_key");
    const experienceDir = projectScope && (scenarioInput !== undefined || scenarioContext !== null)
      ? projectExperienceDirectory(this.store, projectScope, projectRoot, true) : null;
    const aliasDigest = projectScope && projectRoot && (scenarioInput !== undefined || scenarioContext !== null)
      ? projectPathAliasDigest(this.store, projectScope, projectRoot) : null;
    const scenario = projectScope && scenarioInput && experienceDir && experienceScenarioCanClassify(experienceDir,
      scope.id.replace(/^project:/u, ""), scenarioInput) ? scenarioInput : undefined;
    if (coarseScenario !== undefined && scenario === undefined) throw new Error("coarse_scenario_key requires scenario_key");
    if (args.expected_scenario_catalog_version !== undefined) {
      if (!experienceDir || !Number.isSafeInteger(args.expected_scenario_catalog_version) || Number(args.expected_scenario_catalog_version) < 0) throw new Error("expected_scenario_catalog_version is invalid");
      const currentCatalog = listExperienceScenarios(experienceDir, scope.id.replace(/^project:/u, ""));
      if (Number(currentCatalog.catalog_version) !== Number(args.expected_scenario_catalog_version)) throw new Error("Experience scenario catalog changed during classification; retry with the current catalog");
    }
    // Taxonomy refinement must not mint a second observation for the same
    // terminal task. The fine key groups learning; coarse parents and verifier
    // digests are catalog metadata, not task evidence identity.
    // A Hook may finalize with its own task id before the Host model supplies
    // semantic classification. Reuse that one unclassified completion when
    // the later call is bound to the same terminal evidence and turn.
    const terminalDigest = stableDigest({ host, turn_id: turnId, context_receipt_id: receipt.id,
      verification_ref_digest: stableDigest(verificationRef), outcome, scope });
    let effectiveTaskId = taskId;
    if (scenarioInput !== undefined || scenarioContext !== null) {
      const evidenceIds = new Set(this.store.list("evidence", 10_000, item => {
        const metadata = item.metadata as JsonObject | undefined;
        return metadata?.provenance === "host_completion_signal" && metadata.host === host && metadata.turn_id === turnId
          && metadata.context_receipt_id === receipt.id && metadata.verification_ref_digest === stableDigest(verificationRef)
          && (metadata.terminal_identity_digest === terminalDigest || metadata.terminal_identity_digest === undefined);
      }).map(item => String(item.id)));
      const priorUnclassified = this.store.list("workflow_evolution_observation", 10_000, item => {
        const signature = item.scenario_signature as JsonObject | undefined;
        const source = item.source as JsonObject | undefined;
        return signature?.source === "unclassified" && item.outcome === outcome && source?.scope === observationScope && Array.isArray(item.evidence_ids)
          && (item.evidence_ids as unknown[]).some(id => evidenceIds.has(String(id)));
      });
      const exact = priorUnclassified.find(item => (item.source as JsonObject | undefined)?.id === taskId);
      const prior = exact ?? (priorUnclassified.length === 1 ? priorUnclassified[0] : null);
      const priorTaskId = (prior?.source as JsonObject | undefined)?.id;
      if (typeof priorTaskId === "string") effectiveTaskId = priorTaskId;
    }
    const identity = { host, task_id: effectiveTaskId, turn_id: turnId, context_receipt_id: receipt.id, verification_ref: verificationRef, outcome, scope };
    const sourceDigest = stableDigest(identity);
    // Outcomes belong to observations, not scenario identity. Otherwise a
    // successful and failed run could never be compared as one procedure.
    const scenarioSignature = scenario ? { schema: "craft.scenario-signature.v1", project: scope, project_path_alias_digest: aliasDigest, scenario_key: scenario,
      target_class: "host_task_completion", host_revision: "craft-learning-cycle-v1" } : null;
    const observationSignature = scenarioSignature ?? (scenarioInput === undefined
      ? { schema: "craft.scenario-signature.v1", project: scope, source: "unclassified" } : null);
    const scenarioKey = scenarioSignature ? `scenario:${stableDigest(scenarioSignature).slice(-24)}` : null;
    const evidenceId = `evidence_learning_cycle_${sourceDigest.slice(-20)}`;
    const evidence = this.store.find("evidence", evidenceId) ?? this.evidenceRecord({ evidence_id: evidenceId, source_type: "host_completion_signal", confidence: "bounded", claim: `Host reported terminal verification ${outcome}.`, locator: `context-receipt:${receipt.id}`, metadata: { provenance: "host_completion_signal", terminal_identity_digest: terminalDigest, host, task_id: effectiveTaskId, turn_id: turnId, verification_ref_digest: stableDigest(verificationRef), context_receipt_id: receipt.id, content_stored: false } });
    const observationId = `workflow_evolution_observation_${sourceDigest.slice(-20)}`;
    const observedPaths = Array.isArray(args.observed_paths) ? args.observed_paths : [];
    const observed = this.workflowEvolutionObserve({ observation_id: observationId, scenario_key: scenarioKey ?? `unclassified:${stableDigest({ scope, host }).slice(-24)}`, source_kind: `host:${host}`, source_id: effectiveTaskId, source_digest: stableDigest({ taskId: effectiveTaskId, turnId, outcome, verificationRef }), outcome, scope: observationScope, ...(observationSignature ? { scenario_signature: observationSignature } : {}), evidence_ids: [evidence.id], observed_paths: observedPaths, sanitized: true, content_stored: false });
    const observationReplay = observed.idempotent === true;
    if (!scenarioKey) {
      let classificationRequest: JsonObject | null = null, ticket: JsonObject | null = null;
      let classificationRequestReplay = false;
      if (projectScope && experienceDir && scenarioContext) {
        if (SECRET.test(verificationRef) || verificationRef.length > 256 || /[\r\n\0]/u.test(verificationRef)) throw new Error("verification_ref is not safe to persist for classification");
        const requestId = `scenario_classification_${stableDigest({ observation_id: observationId }).slice(-24)}`;
        const saved = createExperienceScenarioClassificationRequest({ experience_dir: experienceDir, request_id: requestId, scope: projectScope,
          context: { ...scenarioContext, observed_paths: observedPaths, outcome, host, task_id: effectiveTaskId, turn_id: turnId,
            context_receipt_id: receipt.id, verification_ref: verificationRef, observation_id: observationId,
            ...(typeof verifierDigest === "string" ? { scenario_verifier_digest: verifierDigest } : {}),
            ...(projectRoot ? { project_root: projectRoot } : {}) } });
        classificationRequest = saved.request as JsonObject;
        classificationRequestReplay = saved.idempotent === true;
        const priorRef = this.store.find("experience_scenario_classification_request_ref", requestId);
        if (priorRef) {
          if (priorRef.identity_digest !== classificationRequest.identity_digest || priorRef.scope !== projectScope) throw new Error("Experience classification request reference idempotency conflict");
        } else this.store.create("experience_scenario_classification_request_ref", requestId,
          { scope: projectScope, status: "awaiting_model", request_version: classificationRequest.version,
            identity_digest: classificationRequest.identity_digest, ...(aliasDigest ? { project_path_alias_digest: aliasDigest } : {}) });
        const selectedProfile = this.evaluationModelProfileEnsureSingle({ purpose: "workflow_evolution" });
        const profile = selectedProfile.profile && typeof selectedProfile.profile === "object" ? selectedProfile.profile as JsonObject : null;
        if (profile && classificationRequest.status === "awaiting_model") {
          const issued = this.evaluationModelTicketIssue({ profile_id: profile.id, purpose: "workflow_evolution",
            experience_scenario_classification_request_id: requestId, experience_scenario_classification_scope: projectScope,
            input_ref: `craft-experience://scenario-classification/${requestId}/v${classificationRequest.version}`,
            output_contract_ref: "craft-experience-scenario-classification-v1" });
          ticket = issued.ticket as JsonObject;
        }
      }
      return { status: "observed", observation: observed.observation, evidence, request: null, scenario_catalog: null,
        scenario_classification_request: classificationRequest, model_ticket: ticket,
        next_action: classificationRequest ? ticket?.status === "ready_for_adapter" ? "experience_scenario_classification_queued"
          : "experience_scenario_classification_waiting_for_model_profile"
          : projectScope ? "stable_scenario_key_required_for_cross_task_learning" : "project_scope_required_for_cross_task_learning",
        idempotent: observationReplay && (!classificationRequest || classificationRequestReplay) };
    }
    const observations = this.workflowEvolutionObservations({ scope: observationScope, scenario_key: scenarioKey, limit: 100 }).observations as JsonObject[];
    const distinct = observations.filter(item => (item.source as JsonObject).id !== effectiveTaskId);
    const taxonomy = recordExperienceScenario({ experience_dir: experienceDir!,
      project_id: projectScope!.slice("project:".length), scenario_key: scenario!, ...(coarseScenario ? { coarse_scenario_key: coarseScenario } : {}),
      ...(validatedScenarioDefinition ? { definition: validatedScenarioDefinition } : {}), ...(validatedCoarseScenarioDefinition ? { coarse_definition: validatedCoarseScenarioDefinition } : {}),
      observation_id: observationId, ...(typeof verifierDigest === "string" ? { verifier_digest: verifierDigest } : {}),
      verified_task_id: stableDigest({ host, task_id: taskId }) });
    if (!distinct.length) return { status: "observed", observation: observed.observation, evidence, request: null,
      scenario_catalog: taxonomy, next_action: "await_an_independent_verified_task", idempotent: observationReplay };
    const hypothesis = validatedScenarioDefinition
      ? `Distill a reusable Workflow for this fine scene. Summary: ${validatedScenarioDefinition.summary}. Applies when: ${validatedScenarioDefinition.applies_when}. Excludes: ${validatedScenarioDefinition.excludes}.`
      : "Require a recorded terminal verification before marking a task complete, and preserve failed verification for bounded recovery.";
    const request = this.workflowEvolutionPropose({ scenario_key: scenarioKey, observation_ids: [String(distinct[0]!.id), observationId].sort(), hypothesis, design_axes: ["orchestration"], procedure_kind: "workflow", output_contract_ref: "acceptance:terminal-verification" });
    const evolutionRequest = request.request as JsonObject;
    const selectedProfile = this.evaluationModelProfileEnsureSingle({ purpose: "workflow_evolution" });
    const profile = selectedProfile.profile && typeof selectedProfile.profile === "object"
      ? selectedProfile.profile as JsonObject : null;
    const priorTicket = this.store.list("evaluation_model_ticket", 100, item => item.purpose === "workflow_evolution"
      && (item.target as JsonObject | undefined)?.id === evolutionRequest.id && Number((item.target as JsonObject).version) === Number(evolutionRequest.version))[0];
    let ticket = priorTicket ?? null, ticketWasCreated = false;
    if (!ticket && profile && evolutionRequest.lifecycle === "awaiting_model") {
      const issued = this.evaluationModelTicketIssue({ profile_id: profile.id, purpose: "workflow_evolution", workflow_evolution_request_id: evolutionRequest.id,
        input_ref: `craft-experience://request/${evolutionRequest.id}/v${evolutionRequest.version}`, output_contract_ref: "craft-experience-procedure-draft-v1" });
      ticket = issued.ticket as JsonObject; ticketWasCreated = issued.idempotent !== true;
    }
    const submitted = evolutionRequest.lifecycle === "draft_submitted";
    return { status: submitted ? "candidate_submitted" : "candidate_request", observation: observed.observation, evidence, request: evolutionRequest, model_ticket: ticket, scenario_catalog: taxonomy,
      distillation_mode: submitted ? null : ticket?.status === "ready_for_adapter" ? "configured_model_adapter" : "current_host_model",
      next_action: submitted ? "run_the_pinned_candidate_through_ordered_external_evaluation_gates"
        : ticket?.status === "ready_for_adapter" ? "model_adapter_distills_proposal_then_external_evaluator_runs_ordered_gates"
          : "current_host_model_reads_pinned_request_submits_candidate_then_runs_ordered_evaluation_gates",
      idempotent: observationReplay && request.idempotent === true && !ticketWasCreated };
  };
}
