import type { CraftService } from "../craft-service.ts";

export function installMemoryConsolidationMethods(serviceClass: typeof CraftService): void {
  serviceClass.prototype.memoryConsolidationRemember = function (args) { return this.memoryConsolidation.remember(args); };
  serviceClass.prototype.memoryConsolidationConsolidate = function (args) { return this.memoryConsolidation.consolidate(args); };
  serviceClass.prototype.memoryConsolidationResolve = function (args) { return this.memoryConsolidation.resolve(args); };
  serviceClass.prototype.memoryConsolidationSearch = function (args) { return this.memoryConsolidation.search(args); };
}
