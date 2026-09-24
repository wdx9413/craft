import type { CraftService } from "../craft-service.ts";

export function installPlatformMethods(serviceClass: typeof CraftService): void {
  serviceClass.prototype.platformMemberSave = function (args) { return this.platformOperations.memberSave(args); };
  serviceClass.prototype.platformAuthorize = function (args) { return this.platformOperations.authorize(args); };
  serviceClass.prototype.platformObserve = function (args) { return this.platformOperations.observe(args); };
  serviceClass.prototype.platformObservabilityExport = function (args) { return this.platformOperations.exportObservations(args); };
}
