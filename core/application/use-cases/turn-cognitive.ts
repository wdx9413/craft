import type { CraftService } from "../craft-service.ts";

/** Thin application facade over the deterministic turn-cognitive domain kernel. */
export function installTurnCognitiveMethods(serviceClass: typeof CraftService): void {
  serviceClass.prototype.turnPolicySave = function (args) { return this.turnCognitive.policySave(args); };
  serviceClass.prototype.turnPolicyGet = function (args) { return this.turnCognitive.policyGet(args); };
  serviceClass.prototype.turnProposalSubmit = function (args) { return this.turnCognitive.proposalSubmit(args); };
  serviceClass.prototype.turnHostAdapterSave = function (args) { return this.turnCognitive.hostAdapterSave(args); };
  serviceClass.prototype.turnHookPlan = function (args) { return this.turnCognitive.hookPlan(args); };
  serviceClass.prototype.turnIntakeAssess = function (args) { return this.turnCognitive.assess(args); };
  serviceClass.prototype.turnReceiptGet = function (args) { return this.turnCognitive.receiptGet(args); };
  serviceClass.prototype.turnMemoryCandidateList = function (args = {}) { return this.turnCognitive.candidateList(args); };
  serviceClass.prototype.turnMemoryCandidateDecide = function (args) { return this.turnCognitive.candidateDecide(args); };
  serviceClass.prototype.turnEvaluationCaseSave = function (args) { return this.turnCognitive.evaluationCaseSave(args); };
  serviceClass.prototype.turnEvaluationRun = function (args) { return this.turnCognitive.evaluationRun(args); };
}
