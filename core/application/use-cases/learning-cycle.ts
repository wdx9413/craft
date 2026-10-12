import type { CraftService } from "../craft-service.ts";
import type { JsonObject } from "../../infrastructure/store.ts";
import { stableDigest } from "../../digest.ts";

declare module "../craft-service.ts" {
  interface CraftService { learningCycleFinalize(args: JsonObject): JsonObject; learningCycleRequestGet(args: JsonObject): JsonObject; }
}

/** MCP/Skill Host completion entry point. Host attestation creates an Observation, never a release. */
export function installLearningCycleMethods(serviceClass: typeof CraftService): void {
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
    const scenario = args.scenario_key;
    if (scenario !== undefined && (typeof scenario !== "string" || !/^[a-z0-9][a-z0-9._/-]{0,95}$/u.test(scenario))) throw new Error("scenario_key must be a bounded stable identifier");
    const identity = { host, task_id: taskId, turn_id: turnId, context_receipt_id: receipt.id, verification_ref: verificationRef, outcome, scope, scenario_key: scenario ?? null };
    const sourceDigest = stableDigest(identity);
    // Outcomes belong to observations, not scenario identity. Otherwise a
    // successful and failed run could never be compared as one procedure.
    const scenarioSignature = scenario ? { schema: "craft.scenario-signature.v1", project: scope, scenario_key: scenario, target_class: "host_task_completion", host_revision: "craft-learning-cycle-v1" } : null;
    const scenarioKey = scenarioSignature ? `scenario:${stableDigest(scenarioSignature).slice(-24)}` : null;
    const evidenceId = `evidence_learning_cycle_${sourceDigest.slice(-20)}`;
    const evidence = this.store.find("evidence", evidenceId) ?? this.evidenceRecord({ evidence_id: evidenceId, source_type: "host_completion_signal", confidence: "bounded", claim: `Host reported terminal verification ${outcome}.`, locator: `context-receipt:${receipt.id}`, metadata: { provenance: "host_completion_signal", host, task_id: taskId, turn_id: turnId, verification_ref_digest: stableDigest(verificationRef), context_receipt_id: receipt.id, content_stored: false } });
    const observationId = `workflow_evolution_observation_${sourceDigest.slice(-20)}`;
    const observed = this.workflowEvolutionObserve({ observation_id: observationId, scenario_key: scenarioKey ?? `unclassified:${stableDigest({ scope, host }).slice(-24)}`, source_kind: `host:${host}`, source_id: taskId, source_digest: stableDigest({ taskId, turnId, outcome, verificationRef }), outcome, scope: `${scope.kind}:${scope.id}`, ...(scenarioSignature ? { scenario_signature: scenarioSignature } : {}), evidence_ids: [evidence.id], sanitized: true, content_stored: false });
    const observationReplay = observed.idempotent === true;
    if (!scenarioKey) return { status: "observed", observation: observed.observation, evidence, request: null, next_action: "stable_scenario_key_required_for_cross_task_learning", idempotent: observationReplay };
    const observations = this.workflowEvolutionObservations({ scenario_key: scenarioKey, limit: 100 }).observations as JsonObject[];
    const distinct = observations.filter(item => (item.source as JsonObject).id !== taskId);
    if (!distinct.length) return { status: "observed", observation: observed.observation, evidence, request: null, next_action: "await_an_independent_verified_task", idempotent: observationReplay };
    const request = this.workflowEvolutionPropose({ scenario_key: scenarioKey, observation_ids: [String(distinct[0]!.id), observationId].sort(), hypothesis: "Require a recorded terminal verification before marking a task complete, and preserve failed verification for bounded recovery.", design_axes: ["orchestration"], procedure_kind: "workflow", output_contract_ref: "acceptance:terminal-verification" });
    const evolutionRequest = request.request as JsonObject;
    const profile = this.store.list("evaluation_model_profile", 100, item => item.lifecycle === "active" && Array.isArray(item.purposes) && (item.purposes as unknown[]).includes("workflow_evolution"))[0];
    const priorTicket = this.store.list("evaluation_model_ticket", 100, item => item.purpose === "workflow_evolution"
      && (item.target as JsonObject | undefined)?.id === evolutionRequest.id && Number((item.target as JsonObject).version) === Number(evolutionRequest.version))[0];
    let ticket = priorTicket ?? null, ticketWasCreated = false;
    if (!ticket && profile && evolutionRequest.lifecycle === "awaiting_model") {
      const issued = this.evaluationModelTicketIssue({ profile_id: profile.id, purpose: "workflow_evolution", workflow_evolution_request_id: evolutionRequest.id,
        input_ref: `craft-experience://request/${evolutionRequest.id}/v${evolutionRequest.version}`, output_contract_ref: "craft-experience-procedure-draft-v1" });
      ticket = issued.ticket as JsonObject; ticketWasCreated = issued.idempotent !== true;
    }
    const submitted = evolutionRequest.lifecycle === "draft_submitted";
    return { status: submitted ? "candidate_submitted" : "candidate_request", observation: observed.observation, evidence, request: evolutionRequest, model_ticket: ticket,
      next_action: submitted ? "run_the_pinned_candidate_through_ordered_external_evaluation_gates"
        : ticket ? "model_adapter_distills_proposal_then_external_evaluator_runs_ordered_gates" : "configure_workflow_evolution_model_profile_then_distill_and_evaluate",
      idempotent: observationReplay && request.idempotent === true && !ticketWasCreated };
  };
}
