import type { CraftService } from "../craft-service.ts";

export function installKnowledgeMemoryMethods(serviceClass: typeof CraftService): void {
  serviceClass.prototype.knowledgeMemoryInstallBuiltins = function () { return this.knowledgeMemory.installBuiltins(); };
  serviceClass.prototype.knowledgeSourceRegister = function (args) { return this.knowledgeMemory.sourceRegister(args); };
  serviceClass.prototype.knowledgeSourceList = function (args) { return this.knowledgeMemory.sourceList(args); };
  serviceClass.prototype.knowledgeSourceTransition = function (args) { return this.knowledgeMemory.sourceTransition(args); };
  serviceClass.prototype.memoryLedgerRemember = function (args) { return this.knowledgeMemory.remember(args); };
  serviceClass.prototype.memoryLedgerTransition = function (args) { return this.knowledgeMemory.transition(args); };
  serviceClass.prototype.memoryLedgerCompatBind = function (args) { return this.knowledgeMemory.compatBind(args); };
  serviceClass.prototype.contextResolutionResolve = function (args) { return this.knowledgeMemory.resolve(args); };
  serviceClass.prototype.contextResolutionGet = function (args) { return this.knowledgeMemory.receiptGet(args); };
  serviceClass.prototype.retrievalAdapterConfigure = function (args) { return this.knowledgeMemory.retrievalConfigure(args); };
  serviceClass.prototype.retrievalAdapterEvaluate = function (args) { return this.knowledgeMemory.retrievalEvaluate(args); };
}
