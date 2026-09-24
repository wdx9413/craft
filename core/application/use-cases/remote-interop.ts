import type { CraftService } from "../craft-service.ts";

export function installRemoteInteropMethods(serviceClass: typeof CraftService): void {
  serviceClass.prototype.remoteInteropPrepare = function (args) { return this.remoteInterop.prepare(args); };
  serviceClass.prototype.remoteInteropReport = function (args) { return this.remoteInterop.report(args); };
  serviceClass.prototype.remoteInteropGet = function (args) { return this.remoteInterop.get(args); };
}
