import type { CraftService } from "../craft-service.ts";

export function installCapabilityLifecycleMethods(serviceClass: typeof CraftService): void {
  serviceClass.prototype.capabilityLifecycleRegister = function (args) { return this.capabilityLifecycle.register(args); };
  serviceClass.prototype.capabilityLifecycleInstall = function (args) { return this.capabilityLifecycle.install(args); };
  serviceClass.prototype.capabilityLifecycleActivate = function (args) { return this.capabilityLifecycle.activate(args); };
  serviceClass.prototype.capabilityLifecycleDisable = function (args) { return this.capabilityLifecycle.disable(args); };
  serviceClass.prototype.capabilityLifecycleUpgrade = function (args) { return this.capabilityLifecycle.upgrade(args); };
  serviceClass.prototype.capabilityLifecycleRetire = function (args) { return this.capabilityLifecycle.retire(args); };
  serviceClass.prototype.capabilityLifecycleResolve = function (args) { return this.capabilityLifecycle.resolve(args); };
  serviceClass.prototype.capabilityLifecycleList = function () { return this.capabilityLifecycle.list(); };
}
