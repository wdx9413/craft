import type { CraftService } from "../craft-service.ts";
import type { JsonObject } from "../../infrastructure/store.ts";

export function installDecisionContextGateMethods(serviceClass: typeof CraftService): void {
  serviceClass.prototype.decisionContextGateOpen = function (args) { return this.decisionContextGate.open(args); };
  serviceClass.prototype.decisionContextGateGet = function (args) { return this.decisionContextGate.get(args); };
}
