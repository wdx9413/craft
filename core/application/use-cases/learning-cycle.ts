import type { CraftService } from "../craft-service.ts";
import type { JsonObject } from "../../infrastructure/store.ts";
import { payload, stableDigest } from "../../digest.ts";
import { experienceScenarioCanClassify, experienceScenarioIsRetired, listExperienceScenarios, proposeExperienceScenarioMigration, recordExperienceScenario, retireExperienceScenario, validateExperienceScenarioDefinition } from "../../../capability/craft-experience/scenario-catalog.ts";

declare module "../craft-service.ts" {
  interface CraftService { learningCycleFinalize(args: JsonObject): JsonObject; learningCycleRequestGet(args: JsonObject): JsonObject; experienceScenarioList(args: JsonObject): JsonObject; experienceScenarioRetire(args: JsonObject): JsonObject; experienceScenarioMigrationPropose(args: JsonObject): JsonObject; }
}

/** MCP/Skill Host completion entry point. Host attestation creates an Observation, never a release. */
export function installLearningCycleMethods(serviceClass: typeof CraftService): void {
  serviceClass.prototype.experienceScenarioList = function (args) {
    const scope = typeof args.scope === "string" ? args.scope.trim()
      : typeof args.scope_kind === "string" && typeof args.scope_id === "string" ? `${args.scope_kind}:${args.scope_id.trim()}` : "";
    const match = /^project:([A-Za-z0-9_-]{1,96})$/u.exec(scope);
    if (!match) throw new Error("Experience scenario catalog requires one explicit project scope");
    return { scope, ...listExperienceScenarios(this.store.paths.experienceDir, match[1]!) };
  };
  serviceClass.prototype.experienceScenarioRetire = function (args) {
    const scope = typeof args.scope === "string" ? args.scope.trim()
      : typeof args.scope_kind === "string" && typeof args.scope_id === "string" ? `${args.scope_kind}:${args.scope_id.trim()}` : "";
    const match = /^project:([A-Za-z0-9_-]{1,96})$/u.exec(scope);
    if (!match) throw new Error("Experience scenario retirement requires an explicit project scope");
    if (!Number.isSafeInteger(args.expected_catalog_version) || Number(args.expected_catalog_version) < 0) throw new Error("expected_catalog_version must be a non-negative integer");
    if (typeof args.request_id !== "string" || !args.request_id.trim() || typeof args.reason !== "string" || !args.reason.trim()) throw new Error("request_id and reason must not be empty");
    const scenarioKey = String(args.scenario_key ?? "");
    const result = retireExperienceScenario({ experience_dir: this.store.paths.experienceDir, project_id: match[1]!, scenario_key: scenarioKey,
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
    return proposeExperienceScenarioMigration({ experience_dir: this.store.paths.experienceDir, project_id: match[1]!,
      mode: String(args.mode) as "merge" | "split", source_keys: args.source_keys as string[],
      targets: args.targets as Array<{ scenario_key: string; definition: unknown }>,
      expected_catalog_version: Number(args.expected_catalog_version), request_id: String(args.request_id ?? ""), reason: String(args.reason ?? "") });
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
    const scenario = scenarioInput && scope.kind === "project" && !experienceScenarioCanClassify(this.store.paths.experienceDir,
      scope.id.replace(/^project:/u, ""), scenarioInput) ? undefined : scenarioInput;
    const coarseScenario = args.coarse_scenario_key;
    if (coarseScenario !== undefined && (typeof coarseScenario !== "string" || !/^[a-z0-9][a-z0-9._/-]{0,95}$/u.test(coarseScenario))) throw new Error("coarse_scenario_key must be a bounded stable identifier");
    if (coarseScenario !== undefined && scenario === undefined) throw new Error("coarse_scenario_key requires scenario_key");
    const verifierDigest = args.scenario_verifier_digest;
    if (verifierDigest !== undefined && (typeof verifierDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(verifierDigest))) throw new Error("scenario_verifier_digest must be a SHA-256 digest");
    const scenarioDefinition = args.scenario_definition;
    const coarseScenarioDefinition = args.coarse_scenario_definition;
    const validatedScenarioDefinition = validateExperienceScenarioDefinition(scenarioDefinition);
    const validatedCoarseScenarioDefinition = validateExperienceScenarioDefinition(coarseScenarioDefinition);
    if (validatedCoarseScenarioDefinition && coarseScenario === undefined) throw new Error("coarse scenario definition requires coarse_scenario_key");
    // Taxonomy refinement must not mint a second observation for the same
    // terminal task. The fine key groups learning; coarse parents and verifier
    // digests are catalog metadata, not task evidence identity.
    const identity = { host, task_id: taskId, turn_id: turnId, context_receipt_id: receipt.id, verification_ref: verificationRef, outcome, scope,
      scenario_key: scenario ?? null };
    const sourceDigest = stableDigest(identity);
    // Outcomes belong to observations, not scenario identity. Otherwise a
    // successful and failed run could never be compared as one procedure.
    const scenarioSignature = scenario ? { schema: "craft.scenario-signature.v1", project: scope, scenario_key: scenario,
      target_class: "host_task_completion", host_revision: "craft-learning-cycle-v1" } : null;
    const scenarioKey = scenarioSignature ? `scenario:${stableDigest(scenarioSignature).slice(-24)}` : null;
    const evidenceId = `evidence_learning_cycle_${sourceDigest.slice(-20)}`;
    const evidence = this.store.find("evidence", evidenceId) ?? this.evidenceRecord({ evidence_id: evidenceId, source_type: "host_completion_signal", confidence: "bounded", claim: `Host reported terminal verification ${outcome}.`, locator: `context-receipt:${receipt.id}`, metadata: { provenance: "host_completion_signal", host, task_id: taskId, turn_id: turnId, verification_ref_digest: stableDigest(verificationRef), context_receipt_id: receipt.id, content_stored: false } });
    const observationId = `workflow_evolution_observation_${sourceDigest.slice(-20)}`;
    const observed = this.workflowEvolutionObserve({ observation_id: observationId, scenario_key: scenarioKey ?? `unclassified:${stableDigest({ scope, host }).slice(-24)}`, source_kind: `host:${host}`, source_id: taskId, source_digest: stableDigest({ taskId, turnId, outcome, verificationRef }), outcome, scope: `${scope.kind}:${scope.id}`, ...(scenarioSignature ? { scenario_signature: scenarioSignature } : {}), evidence_ids: [evidence.id], sanitized: true, content_stored: false });
    const observationReplay = observed.idempotent === true;
    if (!scenarioKey) return { status: "observed", observation: observed.observation, evidence, request: null, next_action: "stable_scenario_key_required_for_cross_task_learning", idempotent: observationReplay };
    const observations = this.workflowEvolutionObservations({ scenario_key: scenarioKey, limit: 100 }).observations as JsonObject[];
    const distinct = observations.filter(item => (item.source as JsonObject).id !== taskId);
    const taxonomy = scope.kind === "project" ? recordExperienceScenario({ experience_dir: this.store.paths.experienceDir,
      project_id: scope.id.replace(/^project:/u, ""), scenario_key: scenario!, ...(coarseScenario ? { coarse_scenario_key: coarseScenario } : {}),
      ...(validatedScenarioDefinition ? { definition: validatedScenarioDefinition } : {}), ...(validatedCoarseScenarioDefinition ? { coarse_definition: validatedCoarseScenarioDefinition } : {}),
      observation_id: observationId, ...(typeof verifierDigest === "string" ? { verifier_digest: verifierDigest } : {}),
      verified_task_id: stableDigest({ host, task_id: taskId }) }) : null;
    if (!distinct.length) return { status: "observed", observation: observed.observation, evidence, request: null,
      scenario_catalog: taxonomy, next_action: "await_an_independent_verified_task", idempotent: observationReplay };
    const hypothesis = validatedScenarioDefinition
      ? `Distill a reusable Workflow for this fine scene. Summary: ${validatedScenarioDefinition.summary}. Applies when: ${validatedScenarioDefinition.applies_when}. Excludes: ${validatedScenarioDefinition.excludes}.`
      : "Require a recorded terminal verification before marking a task complete, and preserve failed verification for bounded recovery.";
    const request = this.workflowEvolutionPropose({ scenario_key: scenarioKey, observation_ids: [String(distinct[0]!.id), observationId].sort(), hypothesis, design_axes: ["orchestration"], procedure_kind: "workflow", output_contract_ref: "acceptance:terminal-verification" });
    const evolutionRequest = request.request as JsonObject;
    const configuredProfiles = this.evaluationModelProfileList({ limit: 100 }).profiles as JsonObject[];
    const activeProfiles = configuredProfiles.filter(item => item.lifecycle === "active" && Array.isArray(item.purposes)
      && (item.purposes as unknown[]).includes("workflow_evolution"));
    let profile = activeProfiles.find(item => (item.readiness as JsonObject | undefined)?.status === "ready_for_adapter")
      ?? activeProfiles[0];
    if (!profile && activeProfiles.length === 0) {
      const configuredModels = this.modelList().models as JsonObject[];
      if (configuredModels.length === 1) {
        const model = configuredModels[0]!;
        const identity = { provider: model.id, model: model.model, base_url: model.baseUrl, api_key_env: model.apiKeyEnv };
        profile = this.evaluationModelProfileSave({
          profile_id: `evaluation_model_profile_auto_${stableDigest(identity).slice(-24)}`,
          provider: model.id,
          model: model.model,
          purposes: ["workflow_evolution"],
          network_execution_enabled: true,
          max_attempts: 1,
          max_output_tokens: 2_048,
        }).profile as JsonObject;
      }
    }
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
      next_action: submitted ? "run_the_pinned_candidate_through_ordered_external_evaluation_gates"
        : ticket?.status === "ready_for_adapter" ? "model_adapter_distills_proposal_then_external_evaluator_runs_ordered_gates"
          : ticket ? String(ticket.next_action ?? "configure_workflow_evolution_model_profile_then_distill_and_evaluate")
            : "configure_workflow_evolution_model_profile_then_distill_and_evaluate",
      idempotent: observationReplay && request.idempotent === true && !ticketWasCreated };
  };
}
