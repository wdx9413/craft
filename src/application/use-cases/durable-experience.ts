import type { CraftService } from "../craft-service.ts";

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
  serviceClass.prototype.experienceProcedureGet = function (args) { return this.experienceProcedures.get(args); };
  serviceClass.prototype.experienceProcedureList = function (args = {}) { return this.experienceProcedures.list(args); };
  serviceClass.prototype.experienceProcedureSkillExport = function (args) { return this.experienceProcedures.skillExport(args); };
}
