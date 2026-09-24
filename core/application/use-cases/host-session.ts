import type { CraftService } from "../craft-service.ts";

/** Application boundary for host-neutral session facts and independent observations. */
export function installHostSessionMethods(serviceClass: typeof CraftService): void {
  serviceClass.prototype.hostSessionOpen = function (args) { return this.hostSessions.open(args); };
  serviceClass.prototype.hostSessionAppend = function (args) { return this.hostSessions.append(args); };
  serviceClass.prototype.hostSessionResume = function (args) { return this.hostSessions.resume(args); };
  serviceClass.prototype.hostSessionGet = function (args) { return this.hostSessions.get(args); };
  serviceClass.prototype.outcomeObserverObserve = function (args) { return this.outcomeObservers.observe(args); };
  serviceClass.prototype.outcomeObserverGet = function (args) { return this.outcomeObservers.get(args); };
}
