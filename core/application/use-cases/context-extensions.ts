import type { CraftService } from "../craft-service.ts";
import type { JsonObject } from "../../infrastructure/store.ts";
import { ContextExtensionsKernel } from "../../context-extensions.ts";

declare module "../craft-service.ts" {
  interface CraftService {
    contextExtensionsRenderRouting(args: JsonObject): JsonObject;
    contextExtensionsRecordEphemeral(args: JsonObject): JsonObject;
    contextExtensionsSearchEphemeral(args: JsonObject): JsonObject;
    contextExtensionsPurgeEphemeral(args: JsonObject): JsonObject;
    contextExtensionsCaptureOutput(args: JsonObject): JsonObject;
    contextExtensionsCompute(args: JsonObject): JsonObject;
    contextExtensionsCheckpointResume(args: JsonObject): JsonObject;
    contextExtensionsGetResume(args: JsonObject): JsonObject;
    contextExtensionsResolveResume(args: JsonObject): JsonObject;
    contextExtensionsStats(args: JsonObject): JsonObject;
    contextExtensionsHealth(args: JsonObject): JsonObject;
    contextExtensionsListCorrections(args: JsonObject): JsonObject;
    contextExtensionsDecideCorrection(args: JsonObject): JsonObject;
    contextExtensionsRecordCodebaseUsage(args: JsonObject): JsonObject;
    contextExtensionsGetCodebaseUsage(args: JsonObject): JsonObject;
  }
}

/** Thin delegations: one store-scoped kernel, no cross-component state. */
export function installContextExtensionsMethods(serviceClass: typeof CraftService): void {
  const kernel = (service: CraftService): ContextExtensionsKernel => new ContextExtensionsKernel(service.store);
  serviceClass.prototype.contextExtensionsRenderRouting = function (args) { return kernel(this).renderRouting(args); };
  serviceClass.prototype.contextExtensionsRecordEphemeral = function (args) { return kernel(this).recordEphemeral(args); };
  serviceClass.prototype.contextExtensionsSearchEphemeral = function (args) { return kernel(this).searchEphemeral(args); };
  serviceClass.prototype.contextExtensionsPurgeEphemeral = function (args) { return kernel(this).purgeEphemeral(args); };
  serviceClass.prototype.contextExtensionsCaptureOutput = function (args) { return kernel(this).captureOutput(args); };
  serviceClass.prototype.contextExtensionsCompute = function (args) { return kernel(this).compute(args); };
  serviceClass.prototype.contextExtensionsCheckpointResume = function (args) { return kernel(this).checkpointResume(args); };
  serviceClass.prototype.contextExtensionsGetResume = function (args) { return kernel(this).getResume(args); };
  serviceClass.prototype.contextExtensionsResolveResume = function (args) { return kernel(this).resolveResume(args); };
  serviceClass.prototype.contextExtensionsStats = function (args) { return kernel(this).stats(args); };
  serviceClass.prototype.contextExtensionsHealth = function (args) { return kernel(this).health(args); };
  serviceClass.prototype.contextExtensionsListCorrections = function (args) { return kernel(this).listCorrections(args); };
  serviceClass.prototype.contextExtensionsDecideCorrection = function (args) { return kernel(this).decideCorrection(args); };
  serviceClass.prototype.contextExtensionsRecordCodebaseUsage = function (args) { return kernel(this).recordCodebaseUsage(args); };
  serviceClass.prototype.contextExtensionsGetCodebaseUsage = function (args) { return kernel(this).getCodebaseUsage(args); };
}
