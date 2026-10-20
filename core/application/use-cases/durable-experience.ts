import type { CraftService } from "../craft-service.ts";
import type { JsonObject } from "../../infrastructure/store.ts";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { ExperienceLearningEvaluation } from "../../../capability/craft-experience/learning-evaluation.ts";
import { ProcedureDefinitionStore } from "../../../capability/craft-experience/procedure-definition.ts";
import { projectIdentityFromRoot } from "../../scope-identity.ts";
import { realpathSync } from "node:fs";
import { executeSteps, normalizeSteps, resolveInputs, safePath, substitute } from "../../workflow.ts";
import { stableDigest } from "../../digest.ts";

declare module "../craft-service.ts" {
  interface CraftService { experienceLearningEvaluationRun(args: JsonObject): JsonObject; }
}

/** Narrow public delegates for durable long-task progress and diagnostic learning. */
export function installDurableExperienceMethods(serviceClass: typeof CraftService): void {
  serviceClass.prototype.durableActionLoopCreate = function (args) { return this.durableActionLoops.create(args); };
  serviceClass.prototype.durableActionLoopNext = function (args) { return this.durableActionLoops.next(args); };
  serviceClass.prototype.durableActionLoopPropose = function (args) { return this.durableActionLoops.propose(args); };
  serviceClass.prototype.durableActionLoopDispatch = function (args) { return this.durableActionLoops.dispatch(args); };
  serviceClass.prototype.durableActionLoopReport = function (args) { return this.durableActionLoops.report(args); };
  serviceClass.prototype.durableActionLoopResume = function (args) { return this.durableActionLoops.resume(args); };
  serviceClass.prototype.durableActionLoopGet = function (args) { return this.durableActionLoops.get(args); };
  serviceClass.prototype.experienceLedgerObserve = function (args) { return this.experienceLedger.observe(args); };
  serviceClass.prototype.experienceLedgerCompile = function (args) { return this.experienceLedger.compile(args); };
  serviceClass.prototype.experienceLedgerPropose = function (args) { return this.experienceLedger.propose(args); };
  serviceClass.prototype.experienceLedgerEvaluate = function (args) { return this.experienceLedger.evaluate(args); };
  serviceClass.prototype.experienceLedgerDecide = function (args) { return this.experienceLedger.decide(args); };
  serviceClass.prototype.experienceLedgerGet = function (args) { return this.experienceLedger.get(args); };
  serviceClass.prototype.experienceProcedureDraft = function (args) { return this.experienceProcedures.draft(args); };
  serviceClass.prototype.experienceProcedureGate = function (args) { return this.experienceProcedures.gate(args); };
  serviceClass.prototype.experienceLearningEvaluationList = function (args = {}) { return new ExperienceLearningEvaluation(this.store).listPending(args); };
  serviceClass.prototype.experienceLearningEvaluationDispatch = function (args) { return new ExperienceLearningEvaluation(this.store).dispatch(args); };
  serviceClass.prototype.experienceLearningEvaluationResult = function (args) {
    return new ExperienceLearningEvaluation(this.store).result(args, (gateArgs) => this.experienceProcedures.gate(gateArgs));
  };
  serviceClass.prototype.experienceLearningEvaluationRun = function (args) {
    const execute = (input: JsonObject): JsonObject => {
      const procedure = this.store.get("experience_procedure", String(input.procedure_id), Number(input.procedure_version));
      const reference = procedure.definition_ref as JsonObject;
      const definition = new ProcedureDefinitionStore(this.store).read(reference as never);
      if (definition.kind !== "workflow") throw new Error("Experience evaluator supports Workflow Procedures only");
      const sourceProposal = this.store.find("workflow_evolution_proposal", definition.proposal_ref.id, definition.proposal_ref.version);
      if (sourceProposal) {
        const sourceWorkflow = this.store.get("workflow", String(sourceProposal.workflow_id));
        if ((sourceWorkflow.derived_from as JsonObject | undefined)?.workflow_evolution_proposal_id !== sourceProposal.id
          || stableDigest({ inputs: sourceWorkflow.inputs, steps: sourceWorkflow.steps }) !== stableDigest({ inputs: definition.definition.inputs, steps: definition.definition.steps })) {
          throw new Error("Experience candidate Workflow drifted from its pinned Procedure definition");
        }
      }
      const projectRoot = realpathSync(String(input.project_root));
      const identity = projectIdentityFromRoot(projectRoot).canonical_scope as JsonObject;
      if (identity.id !== `project:${String(input.project_id)}`) throw new Error("Evaluation case root does not match the Procedure project");
      const inputValues = { ...(input.inputs as JsonObject) };
      const inputDefinitions = definition.definition.inputs as JsonObject[];
      if (inputDefinitions.some(item => item.name === "project_root") && inputValues.project_root === undefined) inputValues.project_root = projectRoot;
      const inputs = resolveInputs(inputDefinitions, inputValues);
      const steps = normalizeSteps(substitute(definition.definition.steps, inputs) as unknown[]);
      if (steps.some(step => step.side_effect !== "read_only")) throw new Error("Experience evaluator permits read-only Workflow steps only");
      const resourceDigest = (): string => stableDigest(steps.map(step => {
        if (step.type === "assertion" || step.type === "coverage_gate") {
          const relativePath = String(step.type === "coverage_gate" ? step.report ?? "coverage-summary.json" : step.path ?? "");
          const path = safePath(projectRoot, relativePath);
          try {
            const stat = statSync(path);
            return { id: step.id, path: relativePath, exists: true, kind: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
              ...(stat.isFile() ? { digest: `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}` } : {}) };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return { id: step.id, path: relativePath, exists: false };
            throw error;
          }
        }
        return { id: step.id, unsupported: true };
      }));
      const beforeDigest = resourceDigest();
      const rawResults = executeSteps(steps, projectRoot, new Set(["read_only"]));
      const afterDigest = resourceDigest();
      const environmentStable = beforeDigest === afterDigest;
      const results = rawResults.map(result => ({ id: result.id, type: result.type, passed: result.passed === true,
        ...(typeof result.error === "string" ? { error: result.error } : {}) }));
      const passed = environmentStable && results.length === steps.length && results.every(result => result.passed);
      const environmentDigest = stableDigest({ node: process.version, platform: process.platform, project_id: input.project_id,
        resource_digest_before: beforeDigest, resource_digest_after: afterDigest, environment_stable: environmentStable });
      const run = this.store.save("workflow_run", `experience_eval_run_${stableDigest({ dispatch_id: args.dispatch_id, case_id: input.case_id }).slice(-20)}`, {
        workflow_id: procedure.id, workflow_version: procedure.version, procedure_id: procedure.id, procedure_version: procedure.version,
        definition_digest: procedure.definition_digest, project_id: input.project_id, inputs_digest: stableDigest(inputs), environment_digest: environmentDigest,
        environment_stable: environmentStable, results, status: passed ? "passed" : "failed", evaluator_dispatch_id: args.dispatch_id, case_id: input.case_id,
      });
      return { passed, workflow_run_id: run.id, inputs_digest: stableDigest(inputs), environment_digest: environmentDigest };
    };
    return new ExperienceLearningEvaluation(this.store).run(args, execute,
      (root, projectId) => {
        const identity = projectIdentityFromRoot(realpathSync(root)).canonical_scope as JsonObject;
        if (identity.id !== `project:${projectId}`) throw new Error("Evaluation case root does not match the Procedure project");
      }, (evidence) => this.evidenceRecord(evidence), (gateArgs) => this.experienceProcedures.gate(gateArgs));
  };
  serviceClass.prototype.procedureInvocationBind = function (args) { return this.procedureInvocations.bind(args); };
  serviceClass.prototype.procedureInvocationDispatch = function (args) { return this.procedureInvocations.dispatch(args); };
  serviceClass.prototype.procedureInvocationReport = function (args) { return this.procedureInvocations.report(args); };
  serviceClass.prototype.procedureInvocationResume = function (args) { return this.procedureInvocations.resume(args); };
  serviceClass.prototype.procedureInvocationTransition = function (args) { return this.procedureInvocations.transition(args); };
  serviceClass.prototype.procedureInvocationGet = function (args) { return this.procedureInvocations.get(args); };
  serviceClass.prototype.procedureInvocationEvaluate = function (args) { return this.procedureInvocations.evaluate(args); };
  serviceClass.prototype.experienceProcedurePlan = function (args) { return this.experienceProcedures.plan(args); };
  serviceClass.prototype.experienceProcedureGet = function (args) { return this.experienceProcedures.get(args); };
  serviceClass.prototype.experienceProcedureList = function (args = {}) { return this.experienceProcedures.list(args); };
  serviceClass.prototype.experienceProcedureSkillExport = function (args) { return this.experienceProcedures.skillExport(args); };
}
