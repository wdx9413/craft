import type { CraftService } from "../craft-service.ts";

/**
 * The three delegations that used to reach one class.
 *
 * `KnowledgeMemoryRuntime` served two context members plus the shared context plane from a
 * single object, so every method here went through `this.knowledgeMemory`. Now each method
 * names the **owner of the member it belongs to**: Sources to the knowledge package's registry,
 * Ledger writes to the memory package's kernel, and resolution to the core context plane. The
 * split is therefore visible in the delegation, not only in the directory layout — which is what
 * makes the ownership declarations in each package's `ownership.ts` checkable rather than
 * aspirational.
 */
export function installKnowledgeMemoryMethods(serviceClass: typeof CraftService): void {
  serviceClass.prototype.knowledgeMemoryInstallBuiltins = function () { return this.knowledgeSources.installBuiltins(); };
  serviceClass.prototype.knowledgeSourceRegister = function (args) { return this.knowledgeSources.sourceRegister(args); };
  serviceClass.prototype.knowledgeSourceList = function (args) { return this.knowledgeSources.sourceList(args); };
  serviceClass.prototype.knowledgeSourceTransition = function (args) { return this.knowledgeSources.sourceTransition(args); };
  serviceClass.prototype.knowledgeSourceIngest = function (args) { return this.knowledgeSources.sourceIngest(args); };
  serviceClass.prototype.memoryLedgerRemember = function (args) { return this.memoryLedger.remember(args); };
  serviceClass.prototype.memoryLedgerGet = function (args) { return this.memoryLedger.get(args); };
  serviceClass.prototype.memoryLedgerList = function (args) { return this.memoryLedger.list(args); };
  serviceClass.prototype.memoryLedgerTransition = function (args) { return this.memoryLedger.transition(args); };
  serviceClass.prototype.memoryLedgerCompatBind = function (args) { return this.memoryLedger.compatBind(args); };
  serviceClass.prototype.contextResolutionResolve = function (args) { return this.contextResolution.resolve(args); };
  serviceClass.prototype.contextResolutionGet = function (args) { return this.contextResolution.receiptGet(args); };
  serviceClass.prototype.retrievalAdapterConfigure = function (args) { return this.contextResolution.retrievalConfigure(args); };
  serviceClass.prototype.retrievalAdapterEvaluate = function (args) { return this.contextResolution.retrievalEvaluate(args); };
  serviceClass.prototype.scopeIdentityResolveProject = function (args) { return this.scopeIdentity.resolveProject(args); };
  serviceClass.prototype.scopeAliasBind = function (args) { return this.scopeIdentity.bindAlias(args); };
  serviceClass.prototype.scopeAliasMigrate = function (args) { return this.scopeIdentity.migrateAlias(args); };
  serviceClass.prototype.memoryMaintenanceSchedule = function (args) { return this.maintenanceScheduler.tick(args); };
}
