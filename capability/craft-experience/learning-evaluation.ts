import type { CraftStore, JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { activeProcedure, belongsToRetiredScenario } from "./procedure-release.ts";
import { stableDigest, payload } from "../../common/craft-common-base/src/digest.ts";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ProcedureDefinitionStore, procedureDefinitionRef } from "./procedure-definition.ts";
import { AUTOMATIC_SIGNOFF_POLICY, validateReadOnlyEvaluationSteps, validateScenarioEvaluation } from "./scenario-evaluation.ts";

const STAGES = ["shadow", "held_out", "signoff", "canary"] as const;
type Stage = typeof STAGES[number];
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}

function isScenarioCatalogFailure(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Experience scenario catalog");
}

function retiredForEvaluation(store: CraftStore, procedure: JsonObject): boolean {
  try { return belongsToRetiredScenario(store, procedure); }
  // Dispatch creation is non-executing. Let the evaluator's strict catalog
  // reader report malformed or linked catalogs at the execution boundary.
  catch (error) { if (isScenarioCatalogFailure(error)) return false; throw error; }
}

function currentForEvaluation(store: CraftStore, procedureId: string): JsonObject | null {
  try { return activeProcedure(store, procedureId); }
  catch (error) { if (isScenarioCatalogFailure(error)) return null; throw error; }
}

/** Adapter-neutral, evidence-bound orchestration for Experience qualification. */
export class ExperienceLearningEvaluation {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  listPending(args: JsonObject = {}): JsonObject {
    const limit = args.limit === undefined ? 100 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("limit must be an integer between 1 and 1000");
    const dispatches = this.store.list("experience_evaluation_dispatch", limit, item => item.status === "awaiting_adapter");
    return { dispatches, count: dispatches.length };
  }

  run(args: JsonObject, execute: (input: JsonObject) => JsonObject,
    validateProjectRoot: (root: string, projectId: string) => void,
    recordEvidence: (input: JsonObject) => JsonObject, gate: (input: JsonObject) => JsonObject): JsonObject {
    const id = text(args.dispatch_id, "dispatch_id"), dispatch = this.store.get("experience_evaluation_dispatch", id);
    if (dispatch.status !== "awaiting_adapter") throw new Error("Experience evaluation dispatch is already resolved");
    const procedure = this.store.get("experience_procedure", String(dispatch.procedure_id), Number(dispatch.procedure_version));
    if (retiredForEvaluation(this.store, procedure)) throw new Error("Experience scenario is retired; evaluation cannot execute");
    if (procedure.definition_digest !== dispatch.definition_digest) throw new Error("Experience evaluation candidate definition drifted");
    if (procedure.procedure_kind !== "workflow" || !procedureDefinitionRef(procedure.definition_ref)) return { dispatch, status: "awaiting_adapter", reason: "automatic_evaluator_supports_read_only_workflows_only" };
    const definition = new ProcedureDefinitionStore(this.store.paths).read(procedure.definition_ref);
    if (stableDigest(definition) !== procedure.definition_digest) throw new Error("Experience evaluation definition digest does not match the candidate");
    validateReadOnlyEvaluationSteps(definition.definition.steps);
    let baseline: { procedure: JsonObject; definition: ReturnType<ProcedureDefinitionStore["read"]> } | null = null;
    if (dispatch.stage === "canary" && dispatch.baseline_version !== null && dispatch.baseline_version !== undefined) {
      const current = currentForEvaluation(this.store, String(procedure.id));
      if (!current || current.version !== dispatch.baseline_version) throw new Error("Canary baseline changed after this dispatch was created");
      if (current.procedure_kind !== "workflow" || !procedureDefinitionRef(current.definition_ref)) return { dispatch, status: "awaiting_adapter", reason: "canary_baseline_requires_external_adapter" };
      const baselineDefinition = new ProcedureDefinitionStore(this.store.paths).read(current.definition_ref);
      validateReadOnlyEvaluationSteps(baselineDefinition.definition.steps);
      baseline = { procedure: current, definition: baselineDefinition };
    }
    const signature = procedure.scenario_signature as JsonObject | undefined;
    const scenarioKey = typeof signature?.scenario_key === "string" ? signature.scenario_key : "";
    const project = signature?.project as JsonObject | undefined;
    const projectId = typeof project?.id === "string" ? project.id.replace(/^project:/u, "") : "";
    if (!/^[A-Za-z0-9_-]{1,96}$/u.test(projectId) || !scenarioKey) return { dispatch, status: "awaiting_adapter", reason: "scenario_identity_is_not_evaluable" };
    const evaluation = this.readScenarioEvaluation(projectId, scenarioKey);
    if (!evaluation) return { dispatch, status: "awaiting_adapter", reason: "project_scenario_evaluator_not_configured" };
    const evaluationContractDigest = stableDigest(evaluation);
    const completedStages = Array.isArray(procedure.completed_gates) ? procedure.completed_gates.map(String) : [];
    for (const priorStage of completedStages) {
      const priorGate = this.store.list("experience_procedure_gate", 10_000,
        item => item.procedure_id === procedure.id && item.stage === priorStage)
        .sort((a, b) => Number(b.procedure_version) - Number(a.procedure_version))[0];
      const evidenceIds = Array.isArray(priorGate?.evidence_ids) ? priorGate.evidence_ids.map(String) : [];
      if (!evidenceIds.length || evidenceIds.some(evidenceId =>
        (this.store.get("evidence", evidenceId).metadata as JsonObject | undefined)?.evaluation_contract_digest !== evaluationContractDigest)) {
        throw new Error("Experience scenario evaluation contract changed after an earlier gate");
      }
    }
    const stage = String(dispatch.stage);
    const caseSet = stage === "signoff" ? null : evaluation.stages[stage as "shadow" | "held_out" | "canary"];
    if (stage === "signoff") {
      const completed = Array.isArray(procedure.completed_gates) ? procedure.completed_gates.map(String) : [];
      if (!completed.includes("shadow") || !completed.includes("held_out")) throw new Error("Automatic Signoff requires passed Shadow and Held-out gates");
    }
    const runs: JsonObject[] = [];
    if (caseSet) for (const testCase of caseSet.cases) {
      validateProjectRoot(testCase.project_root, projectId);
      let baselineRun: JsonObject | null = null;
      if (baseline) {
        try { baselineRun = execute({ procedure_id: baseline.procedure.id, procedure_version: baseline.procedure.version,
          definition_digest: baseline.procedure.definition_digest, definition: baseline.definition.definition, project_id: projectId,
          project_root: testCase.project_root, inputs: testCase.inputs, case_id: `${testCase.case_id}:current` }); }
        catch (error) { baselineRun = { passed: false, failure_kind: error instanceof Error ? error.name : "Error" }; }
      }
      try {
        const candidateRun = execute({ procedure_id: procedure.id, procedure_version: procedure.version,
          definition_digest: procedure.definition_digest, definition: definition.definition, project_id: projectId,
          project_root: testCase.project_root, inputs: testCase.inputs, case_id: testCase.case_id });
        runs.push({ ...candidateRun, ...(baselineRun ? { baseline_passed: baselineRun.passed === true,
          baseline_workflow_run_id: baselineRun.workflow_run_id ?? null, baseline_failure_kind: baselineRun.failure_kind ?? null,
          baseline_inputs_match: baselineRun.inputs_digest === candidateRun.inputs_digest,
          baseline_environment_digest: baselineRun.environment_digest ?? null } : {}) });
      } catch (error) { runs.push({ passed: false, failure_kind: error instanceof Error ? error.name : "Error",
        ...(baselineRun ? { baseline_passed: baselineRun.passed === true, baseline_workflow_run_id: baselineRun.workflow_run_id ?? null,
          baseline_failure_kind: baselineRun.failure_kind ?? null, baseline_inputs_match: false,
          baseline_environment_digest: baselineRun.environment_digest ?? null } : {}) }); }
    }
    const passed = stage === "signoff" || runs.length > 0 && runs.every(item => item.passed === true && item.baseline_inputs_match !== false);
    const environmentDigest = stableDigest({ evaluator: "craft-read-only-workflow-evaluator.v1", definition_digest: procedure.definition_digest,
      project_id: projectId, stage, case_set_ref: caseSet?.case_set_ref ?? null,
      case_environment_digests: runs.map(item => ({ candidate: item.environment_digest ?? null, baseline: item.baseline_environment_digest ?? null })), baseline_version: dispatch.baseline_version ?? null });
    const metadata: JsonObject = { experience_evaluation_dispatch_id: id, procedure_id: procedure.id, procedure_version: procedure.version,
      definition_digest: procedure.definition_digest, baseline_version: dispatch.baseline_version ?? null, stage,
      evaluation_contract_digest: evaluationContractDigest,
      status: passed ? "passed" : "failed", evaluator_ref: "craft-read-only-workflow-evaluator.v1", environment_digest: environmentDigest,
      workflow_run_ids: runs.flatMap(item => typeof item.workflow_run_id === "string" ? [item.workflow_run_id] : []),
      baseline_workflow_run_ids: runs.flatMap(item => typeof item.baseline_workflow_run_id === "string" ? [item.baseline_workflow_run_id] : []),
      case_count: runs.length, case_results_digest: stableDigest(runs.map(item => ({ passed: item.passed === true, failure_kind: item.failure_kind ?? null,
        baseline_passed: item.baseline_passed ?? null, baseline_failure_kind: item.baseline_failure_kind ?? null,
        baseline_inputs_match: item.baseline_inputs_match ?? null }))) };
    if (stage === "held_out") { metadata.held_out_set_ref = caseSet!.case_set_ref; metadata.independent_of_training = true; }
    if (stage === "signoff") metadata.signoff_policy_ref = evaluation.signoff_policy_ref;
    const evidenceId = `experience_eval_evidence_${stableDigest({ dispatch: id, metadata }).slice(-20)}`;
    const evidence = recordEvidence({ evidence_id: evidenceId, source_type: "program", confidence: "confirmed",
      claim: `Pinned Experience ${stage} evaluation ${passed ? "passed" : "failed"}.`, metadata });
    return this.result({ dispatch_id: id, evidence_ids: [String(evidence.id)] }, gate);
  }

  private readScenarioEvaluation(projectId: string, scenarioKey: string): ReturnType<typeof validateScenarioEvaluation> | null {
    const directory = join(this.store.paths.experienceDir, "projects", projectId), path = join(directory, "experience-scenarios.json");
    try {
      for (const entry of [this.store.paths.experienceDir, join(this.store.paths.experienceDir, "projects"), directory, path]) {
        if (lstatSync(entry).isSymbolicLink()) throw new Error("Experience scenario catalog must not use symbolic links");
      }
      if (lstatSync(path).size > 16_384) throw new Error("Experience scenario catalog exceeds 16384 bytes");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Experience scenario catalog is invalid");
    const catalog = parsed as JsonObject;
    if (catalog.schema !== "craft.experience-scenario-catalog.v1" || !Array.isArray(catalog.scenarios) || catalog.scenarios.length > 64) throw new Error("Experience scenario catalog is invalid");
    const matches = catalog.scenarios.filter(item => item && typeof item === "object" && !Array.isArray(item) && (item as JsonObject).scenario_key === scenarioKey) as JsonObject[];
    if (!matches.length) return null;
    if (matches.length !== 1) throw new Error("Experience scenario key is ambiguous in the catalog");
    return matches[0]!.evaluation === undefined ? null : validateScenarioEvaluation(matches[0]!.evaluation);
  }

  dispatch(args: JsonObject): JsonObject {
    const procedure = this.store.get("experience_procedure", text(args.procedure_id, "procedure_id"));
    if (retiredForEvaluation(this.store, procedure)) throw new Error("Experience scenario is retired; candidate cannot be evaluated");
    if (procedure.lifecycle !== "candidate" || procedure.routeable === true) throw new Error("Only an unpublished candidate can enter automatic evaluation");
    const completed = Array.isArray(procedure.completed_gates) ? procedure.completed_gates.map(String) : [];
    const stage = STAGES.find(item => !completed.includes(item));
    if (!stage) throw new Error("Experience candidate has no remaining evaluation stage");
    const current = currentForEvaluation(this.store, String(procedure.id));
    const identity = { procedure_id: procedure.id, procedure_version: procedure.version, definition_digest: procedure.definition_digest,
      stage, baseline_version: current?.version ?? null, scenario_signature: procedure.scenario_signature, content_free: true,
      trace_id: `experience-learning:${stableDigest({ procedure_id: procedure.id, definition_digest: procedure.definition_digest, stage, baseline_version: current?.version ?? null }).slice(-20)}`,
      automatic_evaluator_supported: procedure.procedure_kind === "workflow" };
    const id = String(args.dispatch_id ?? `experience_evaluation_dispatch_${stableDigest(identity).slice(-20)}`);
    const prior = this.store.find("experience_evaluation_dispatch", id);
    if (prior) {
      if (prior.identity_digest !== stableDigest(identity)) throw new Error("Experience evaluation dispatch idempotency conflict");
      return { dispatch: prior, idempotent: true };
    }
    const dispatch = this.store.create("experience_evaluation_dispatch", id, { ...identity, identity_digest: stableDigest(identity), status: "awaiting_adapter" });
    this.store.appendEvent(`experience:${procedure.id}`, "experience.evaluation_dispatched", { dispatch_id: id, stage, trace_id: dispatch.trace_id, procedure_version: procedure.version, definition_digest: procedure.definition_digest });
    return { dispatch, idempotent: false };
  }

  result(args: JsonObject, gate: (input: JsonObject) => JsonObject): JsonObject {
    return this.store.transaction(() => this.applyResult(args, gate));
  }

  private applyResult(args: JsonObject, gate: (input: JsonObject) => JsonObject): JsonObject {
    const id = text(args.dispatch_id, "dispatch_id");
    const dispatch = this.store.get("experience_evaluation_dispatch", id);
    if (dispatch.status !== "awaiting_adapter") {
      const replayEvidence = Array.isArray(args.evidence_ids) ? [...new Set(args.evidence_ids.map(value => text(value, "evidence_ids")))].sort() : [];
      if (!["passed", "failed"].includes(String(dispatch.status)) || stableDigest(replayEvidence) !== stableDigest(dispatch.evidence_ids)) throw new Error("Experience evaluation dispatch is already resolved with different evidence");
      const procedure = this.store.get("experience_procedure", String(dispatch.procedure_id));
      const recordedGate = this.store.get("experience_procedure_gate", String(dispatch.gate_id));
      return { dispatch, gate: recordedGate, procedure, next_dispatch: null,
        current: dispatch.stage === "canary" && dispatch.status === "passed" ? activeProcedure(this.store, String(procedure.id)) : null, idempotent: true };
    }
    const procedure = this.store.get("experience_procedure", String(dispatch.procedure_id), Number(dispatch.procedure_version));
    if (belongsToRetiredScenario(this.store, procedure)) throw new Error("Experience scenario is retired; evaluation result cannot qualify");
    if (procedure.definition_digest !== dispatch.definition_digest) throw new Error("Experience evaluation candidate definition drifted");
    if (!Array.isArray(args.evidence_ids) || args.evidence_ids.length === 0 || args.evidence_ids.length > 20) throw new Error("evidence_ids must contain between 1 and 20 values");
    const evidenceIds = [...new Set(args.evidence_ids.map(value => text(value, "evidence_ids")))].sort();
    if (evidenceIds.length !== args.evidence_ids.length) throw new Error("evidence_ids must be unique");
    for (const evidenceId of evidenceIds) {
      const evidence = this.store.get("evidence", evidenceId);
      const metadata = evidence.metadata as JsonObject | undefined;
      if (evidence.source_type !== "program" || evidence.confidence !== "confirmed" || metadata?.experience_evaluation_dispatch_id !== id
        || metadata.procedure_id !== procedure.id || metadata.procedure_version !== procedure.version || metadata.definition_digest !== procedure.definition_digest
        || metadata.baseline_version !== dispatch.baseline_version || metadata.stage !== dispatch.stage || !["passed", "failed"].includes(String(metadata.status))
        || typeof metadata.evaluator_ref !== "string" || typeof metadata.environment_digest !== "string") {
        throw new Error("Experience evaluation Evidence is not confirmed and bound to this dispatch");
      }
      if (dispatch.stage === "held_out" && (typeof metadata.held_out_set_ref !== "string" || !metadata.held_out_set_ref || metadata.independent_of_training !== true)) throw new Error("Held-out gate requires a pinned independent case set");
      if (dispatch.stage === "signoff" && metadata.signoff_policy_ref !== AUTOMATIC_SIGNOFF_POLICY) throw new Error("Signoff gate requires the configured automatic policy Evidence");
    }
    if (dispatch.stage === "canary") {
      const current = activeProcedure(this.store, String(procedure.id));
      if ((current?.version ?? null) !== (dispatch.baseline_version ?? null)) throw new Error("Canary baseline changed after this dispatch was created");
    }
    const passed = evidenceIds.every(id => (this.store.get("evidence", id).metadata as JsonObject).status === "passed");
    const gateResult = gate({ procedure_id: procedure.id, stage: dispatch.stage, passed, verdict: passed ? "adapter_evaluated_pass" : "adapter_evaluated_fail",
      evidence_ids: evidenceIds, expected_version: procedure.version, gate_id: `experience_auto_gate_${stableDigest({ dispatch: id, evidenceIds, passed }).slice(-20)}` });
    const savedDispatch = this.store.save("experience_evaluation_dispatch", id, { ...payload(dispatch), status: passed ? "passed" : "failed", evidence_ids: evidenceIds, gate_id: (gateResult.gate as JsonObject).id });
    const next = passed && dispatch.stage !== "canary" ? this.dispatch({ procedure_id: procedure.id }) : null;
    const updated = gateResult.procedure as JsonObject;
    this.store.appendEvent(`experience:${procedure.id}`, "experience.evaluation_result_recorded", { dispatch_id: id, gate_id: (gateResult.gate as JsonObject).id, stage: dispatch.stage, status: passed ? "passed" : "failed", evidence_ids: evidenceIds, trace_id: dispatch.trace_id });
    return { dispatch: savedDispatch, gate: gateResult.gate, procedure: updated, next_dispatch: next?.dispatch ?? null,
      current: dispatch.stage === "canary" && passed ? activeProcedure(this.store, String(procedure.id)) : null, idempotent: false };
  }
}
