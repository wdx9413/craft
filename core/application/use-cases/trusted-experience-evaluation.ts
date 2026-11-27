import type { CraftService } from "../craft-service.ts";
import type { JsonObject } from "../../infrastructure/store.ts";
import { TrustedExperienceEvaluator } from "../../trusted-experience-evaluator.ts";
import { ExperienceLearningEvaluation } from "@craft/capability-experience/learning-evaluation";
import { stableDigest } from "../../digest.ts";
import { parseTrustedEvaluatorRegistry } from "../../evaluation-contract.ts";
import { ProcedureDefinitionStore } from "@craft/capability-experience/procedure-definition";
import { AUTOMATIC_SIGNOFF_POLICY } from "@craft/capability-experience/scenario-evaluation";

type TrustedEvaluatorEntry = JsonObject & { id: string; version: string; digest: string; public_key_pem: string };

declare module "../craft-service.ts" {
  interface CraftService {
    experienceLearningEvaluationRun(args: JsonObject): JsonObject;
    experienceLearningEvaluationResult(args: JsonObject): JsonObject;
  }
}

function runtimeEvaluator(service: CraftService, projectId: string, stage: string): { evaluator: TrustedExperienceEvaluator; policyId: string } {
  const env = service.serviceEnvironment ?? process.env;
  const entries = parseTrustedEvaluatorRegistry(env.CRAFT_TRUSTED_EVALUATORS) as TrustedEvaluatorEntry[];
  let raw: unknown;
  try { raw = JSON.parse(env.CRAFT_TRUSTED_EVALUATORS ?? "[]"); }
  catch { throw new Error("CRAFT_TRUSTED_EVALUATORS must be a JSON array"); }
  if (!Array.isArray(raw)) throw new Error("CRAFT_TRUSTED_EVALUATORS must be a JSON array");
  const byIdentity = new Map(entries.map(entry => [`${entry.id}@${entry.version}`, entry]));
  const evaluator = new TrustedExperienceEvaluator(service.store);
  const authorized: Array<{ identity: TrustedEvaluatorEntry; policyId: string; revision: number;
    projectIds: string[]; stages: string[] }> = [];
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as JsonObject;
    const id = String(item.id ?? ""), version = String(item.version ?? "");
    const identity = byIdentity.get(`${id}@${version}`);
    if (!identity || identity.digest !== item.digest || identity.public_key_pem !== item.public_key_pem) continue;
    if (item.revoked === true) continue;
    if (!Array.isArray(item.project_ids) || !Array.isArray(item.experience_stages)) continue;
    if (!item.project_ids.includes(projectId) || !item.experience_stages.includes(stage)) continue;
    const revision = Number(item.policy_revision ?? 1);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Trusted evaluator policy_revision is invalid");
    const policyId = `experience_${stableDigest({ id, version, digest: identity.digest }).slice(-24)}`;
    authorized.push({ identity, policyId, revision, projectIds: item.project_ids as string[], stages: item.experience_stages as string[] });
  }
  if (!authorized.length) throw new Error("trusted_experience_evaluator_scope_unavailable");
  if (authorized.length !== 1) throw new Error("trusted_experience_evaluator_scope_ambiguous");
  const configured = authorized[0]!;
  evaluator.importRuntimePolicy({ identity: configured.identity, policy_id: configured.policyId,
    revision: configured.revision, project_ids: configured.projectIds, stages: configured.stages });
  return { evaluator, policyId: configured.policyId };
}

function evaluationBinding(service: CraftService, dispatch: JsonObject, procedure: JsonObject): JsonObject {
  const itemId = String(dispatch.learning_work_item_id ?? "");
  if (!itemId) throw new Error("experience_learning_work_item_unavailable");
  const item = service.store.get("experience_learning_work_item", itemId);
  const ref = item.evaluation_contract_ref as JsonObject | null;
  if (!ref || ref.kind !== "evaluation_contract" || typeof ref.id !== "string" || !Number.isSafeInteger(ref.version)) {
    throw new Error("experience_evaluation_contract_unavailable");
  }
  const evalOwner = service.ownerServices.get("eval") ?? (service.storageOwner === "eval" ? service : null);
  if (!evalOwner) throw new Error("experience_evaluation_owner_unavailable");
  const contract = evalOwner.store.get("evaluation_contract", ref.id, Number(ref.version));
  if (contract.contract_digest !== ref.digest) throw new Error("experience_evaluation_contract_drifted");
  const budget = contract.budget as JsonObject | undefined;
  const evaluation = budget?.experience_evaluation as JsonObject | undefined;
  const stageConfig = evaluation?.stages && typeof evaluation.stages === "object"
    ? (evaluation.stages as JsonObject)[String(dispatch.stage)] as JsonObject | undefined : undefined;
  if (!evaluation || !stageConfig || !Array.isArray(stageConfig.case_bindings) || !stageConfig.case_bindings.length
    || !Array.isArray(evaluation.discovery_case_ids) || !Array.isArray(stageConfig.safety_assertions) || !stageConfig.safety_assertions.length
    || !stageConfig.budget || typeof stageConfig.budget !== "object") {
    throw new Error("experience_evaluation_case_manifest_unavailable");
  }
  const heldOutRefs = ((contract.task_effect as JsonObject | undefined)?.task_set as JsonObject | undefined)?.held_out_task_refs;
  if (!Array.isArray(heldOutRefs)) throw new Error("experience_evaluation_held_out_set_unavailable");
  const discoveryIds = new Set((evaluation.discovery_case_ids as unknown[]).map(String));
  const heldOutIds = new Set((heldOutRefs as JsonObject[]).map(ref => String(ref.id)));
  const caseIds = (stageConfig.case_bindings as JsonObject[]).map(item => String(item.case_id));
  if (new Set(caseIds).size !== caseIds.length || caseIds.some(id => discoveryIds.has(id) || heldOutIds.has(id))) {
    throw new Error("experience_evaluation_case_set_reused");
  }
  const otherStage = (evaluation.stages as JsonObject)[dispatch.stage === "shadow" ? "canary" : "shadow"] as JsonObject | undefined;
  const otherIds = new Set(Array.isArray(otherStage?.case_bindings)
    ? (otherStage!.case_bindings as JsonObject[]).map(item => String(item.case_id)) : []);
  if (caseIds.some(id => otherIds.has(id))) throw new Error("experience_evaluation_stage_case_sets_overlap");
  let candidateDefinition: JsonObject;
  if (procedure.provenance === "explicit_trace_distillation" && procedure.procedure_kind === "prompt") {
    const ref = procedure.content_ref as JsonObject | undefined;
    if (!ref || ref.kind !== "experience" || ref.record_id !== procedure.id
      || ref.version !== (procedure.candidate_version ?? procedure.version) || ref.scope !== procedure.scope
      || ref.digest !== procedure.content_digest) throw new Error("experience_prompt_content_reference_invalid");
    const content = service.store.contentStore.readCompatSync(ref as never, String(procedure.scope));
    candidateDefinition = { body: content.body, scenario_signature: procedure.scenario_signature };
    if (stableDigest(candidateDefinition) !== procedure.definition_digest) throw new Error("experience_prompt_definition_drifted");
  } else {
    const definitionRef = procedure.definition_ref as JsonObject;
    candidateDefinition = new ProcedureDefinitionStore(service.store).read(definitionRef as never).definition;
  }
  return { evaluation_contract_ref: ref, evaluation_contract_digest: String(contract.contract_digest),
    cases: stageConfig.case_bindings as JsonObject[], case_manifest_digest: stableDigest(stageConfig.case_bindings),
    evaluation_case_set_id: String(stageConfig.case_set_id ?? ""), evaluation_budget_digest: stableDigest(stageConfig.budget),
    safety_assertions_digest: stableDigest(stageConfig.safety_assertions), safety_assertions: stageConfig.safety_assertions,
    allow_null_baseline: dispatch.stage === "canary" && stageConfig.allow_null_baseline === true,
    candidate_definition: candidateDefinition };
}

/** Install a signed adapter path around the existing MCP evaluation operations. */
export function installTrustedExperienceEvaluationMethods(serviceClass: typeof CraftService): void {
  const originalRun = serviceClass.prototype.experienceLearningEvaluationRun;
  const originalResult = serviceClass.prototype.experienceLearningEvaluationResult;

  serviceClass.prototype.experienceLearningEvaluationRun = function (this: CraftService, args: JsonObject): JsonObject {
    const dispatch = this.store.get("experience_evaluation_dispatch", String(args.dispatch_id ?? ""));
    const procedure = this.store.get("experience_procedure", String(dispatch.procedure_id), Number(dispatch.procedure_version));
    const definitionRef = procedure.definition_ref as JsonObject | undefined;
    const isPrompt = procedure.procedure_kind === "prompt" || definitionRef?.kind === "prompt";
    if (!isPrompt || !["shadow", "signoff", "canary"].includes(String(dispatch.stage))) {
      return originalRun.call(this, args);
    }
    if (typeof dispatch.learning_work_item_id !== "string") throw new Error("Prompt evaluation requires a Learning Work Item");
    {
      const item = this.store.get("experience_learning_work_item", dispatch.learning_work_item_id);
      const active = item.active_dispatch_ref as JsonObject | undefined;
      if (item.status !== "processing" || args.worker_id !== item.lease_owner || typeof args.lease_token !== "string"
        || args.lease_token !== item.lease_token || stableDigest(args.lease_token) !== dispatch.lease_token_digest
        || active?.id !== dispatch.id || typeof item.lease_expires_at !== "string"
        || !Number.isFinite(Date.parse(item.lease_expires_at)) || Date.parse(item.lease_expires_at) <= Date.now()) {
        throw new Error("Experience evaluation dispatch requires its active Work Item lease");
      }
    }
    if (dispatch.stage === "signoff") {
      try {
        const item = this.store.get("experience_learning_work_item", String(dispatch.learning_work_item_id));
        const contractRef = item.evaluation_contract_ref as JsonObject | null;
        const evalOwner = this.ownerServices.get("eval") ?? (this.storageOwner === "eval" ? this : null);
        if (!contractRef || !evalOwner) throw new Error("experience_evaluation_contract_unavailable");
        const contract = evalOwner.store.get("evaluation_contract", String(contractRef.id), Number(contractRef.version));
        if (contract.contract_digest !== contractRef.digest) throw new Error("experience_evaluation_contract_drifted");
        const completed = Array.isArray(procedure.completed_gates) ? procedure.completed_gates as string[] : [];
        if (!completed.includes("shadow") || !completed.includes("held_out") || !procedure.evaluation_contract_id || !procedure.evaluation_id) {
          throw new Error("experience_signoff_prior_gates_unavailable");
        }
        const gateRefs = Array.isArray(item.completed_gate_refs) ? item.completed_gate_refs as JsonObject[] : [];
        const priorEvidence: string[] = [];
        for (const stage of ["shadow", "held_out"]) {
          const gateRef = gateRefs.find(ref => {
            const gate = this.store.find("experience_procedure_gate", String(ref.id));
            return gate?.stage === stage && gate.passed === true;
          });
          if (!gateRef) throw new Error("experience_signoff_prior_gates_unavailable");
          const gate = this.store.get("experience_procedure_gate", String(gateRef.id));
          for (const id of gate.evidence_ids as string[]) {
            const evidence = this.store.get("evidence", id), metadata = evidence.metadata as JsonObject | undefined;
            if (evidence.record_origin !== "experience_evaluator" || metadata?.status !== "passed"
              || metadata?.procedure_id !== procedure.id || metadata?.definition_digest !== procedure.definition_digest
              || stage === "shadow" && metadata?.evaluation_contract_digest !== contract.contract_digest
              || stage === "held_out" && (metadata?.evaluation_contract_id !== procedure.evaluation_contract_id
                || metadata?.evaluation_id !== procedure.evaluation_id || metadata?.task_effect_contract_digest !== procedure.evaluation_contract_digest)) {
              throw new Error("experience_signoff_prior_evidence_invalid");
            }
            priorEvidence.push(String(evidence.id));
          }
        }
        const evidence = this.evidenceRecord({ source_type: "program", confidence: "confirmed",
          claim: "Prompt Procedure passed Shadow and trusted Held-out; automatic Signoff policy accepted the ordered gates.",
          locator: `experience-signoff:${dispatch.id}`, metadata: { experience_evaluation_dispatch_id: dispatch.id,
            procedure_id: procedure.id, procedure_version: procedure.version, definition_digest: procedure.definition_digest,
            baseline_version: dispatch.baseline_version ?? null, stage: "signoff", status: "passed",
            evaluator_ref: AUTOMATIC_SIGNOFF_POLICY, environment_digest: stableDigest({ contract: contract.contract_digest, priorEvidence }),
            evaluation_contract_ref: contractRef, evaluation_contract_digest: contract.contract_digest,
            signoff_policy_ref: AUTOMATIC_SIGNOFF_POLICY, prior_gate_evidence_ids: [...new Set(priorEvidence)].sort() } });
        const savedEvidence = this.store.save("evidence", String(evidence.id), { ...evidence, record_origin: "experience_evaluator" });
        const evaluation = new ExperienceLearningEvaluation(this.store);
        return evaluation.result({ dispatch_id: dispatch.id, evidence_ids: [String(savedEvidence.id)], worker_id: args.worker_id, lease_token: args.lease_token,
          evaluation_contract_id: procedure.evaluation_contract_id, evaluation_id: procedure.evaluation_id },
        gateArgs => this.experienceProcedures.gate({ ...gateArgs, evaluation_contract_id: procedure.evaluation_contract_id,
          evaluation_id: procedure.evaluation_id }));
      } catch (error) {
        const reason = error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/u.test(error.message) ? error.message : "experience_signoff_unavailable";
        return { dispatch, status: "awaiting_adapter", reason };
      }
    }
    try {
      const projectId = String(procedure.scope ?? "").replace(/^project:/u, "");
      const binding = evaluationBinding(this, dispatch, procedure);
      const trusted = runtimeEvaluator(this, projectId, String(dispatch.stage));
      const issued = trusted.evaluator.request({ dispatch_id: String(dispatch.id), policy_id: trusted.policyId, evaluation_binding: binding });
      return { dispatch, status: "awaiting_adapter", reason: "trusted_prompt_evaluator_required", evaluation_request: issued.request };
    } catch (error) {
      const reason = error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/u.test(error.message) ? error.message : "trusted_prompt_evaluator_unavailable";
      return { dispatch, status: "awaiting_adapter", reason };
    }
  } as typeof serviceClass.prototype.experienceLearningEvaluationRun;

  serviceClass.prototype.experienceLearningEvaluationResult = function (this: CraftService, args: JsonObject): JsonObject {
    if (typeof args.evaluator_request_id !== "string") return originalResult.call(this, args);
    const request = this.store.get("experience_evaluator_request", args.evaluator_request_id);
    if (args.dispatch_id !== request.dispatch_id) throw new Error("Trusted evaluator result dispatch does not match its issued request");
    const trusted = runtimeEvaluator(this, String(request.project_id), String(request.stage));
    if (request.policy_id !== trusted.policyId) throw new Error("Trusted evaluator Runtime configuration changed or was revoked");
    return trusted.evaluator.verifyReceipt({ request_id: args.evaluator_request_id, dispatch_id: args.dispatch_id,
      receipt: args.receipt, signature: args.signature }, gateArgs => {
      if (gateArgs.dispatch_id !== request.dispatch_id) throw new Error("Verified evaluator result dispatch changed");
      const evaluation = new ExperienceLearningEvaluation(this.store);
      const dispatch = this.store.get("experience_evaluation_dispatch", String(args.dispatch_id));
      const procedure = this.store.get("experience_procedure", String(dispatch.procedure_id), Number(dispatch.procedure_version));
      return evaluation.result({ dispatch_id: gateArgs.dispatch_id, evidence_ids: gateArgs.evidence_ids, worker_id: args.worker_id, lease_token: args.lease_token,
        ...(dispatch.stage === "canary" && procedure.evaluation_contract_id ? { evaluation_contract_id: procedure.evaluation_contract_id,
          evaluation_id: procedure.evaluation_id } : {}) }, gateArgs => this.experienceProcedures.gate({ ...gateArgs,
          ...(dispatch.stage === "canary" && procedure.evaluation_contract_id ? { evaluation_contract_id: procedure.evaluation_contract_id,
            evaluation_id: procedure.evaluation_id } : {}) }));
    });
  } as typeof serviceClass.prototype.experienceLearningEvaluationResult;
}
