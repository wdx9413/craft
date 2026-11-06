import type { CraftService } from "../craft-service.ts";
import type { JsonObject } from "../../infrastructure/store.ts";
import { V01226Runtime, importOpenApiDocument } from "../../generic-adapter-runtime.ts";

function arrayOrEmpty<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function numberOrUndefined(value: unknown): number | undefined {
  return value === undefined ? undefined : Number(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return value === undefined ? undefined : String(value);
}

/**
 * Adapter/runtime use cases live outside the application facade. The facade
 * still exposes the historical method names through this typed installation
 * seam, so MCP, CLI and third-party imports remain unchanged.
 */
declare module "../craft-service.ts" {
  interface CraftService {
    adapterManifestSave(args: JsonObject): JsonObject;
    adapterManifestGet(args: JsonObject): JsonObject;
    adapterManifestList(args?: JsonObject): JsonObject;
    adapterHealth(args: JsonObject): JsonObject;
    adapterConformance(args: JsonObject): JsonObject;
    adapterQuarantine(args: JsonObject): JsonObject;
    adapterRollback(args: JsonObject): JsonObject;
    adapterInstall(args: JsonObject): Promise<JsonObject>;
    commandPlan(args: JsonObject): JsonObject;
    commandRun(args: JsonObject): Promise<JsonObject>;
    commandObserve(args: JsonObject): JsonObject;
    commandCancel(args: JsonObject): JsonObject;
    commandRetry(args: JsonObject): Promise<JsonObject>;
    contextManifestV01226Save(args: JsonObject): JsonObject;
    capabilityProjection(args: JsonObject): JsonObject;
    durableRunStart(args: JsonObject): JsonObject;
    durableRunTick(args?: JsonObject): JsonObject;
    durableRunComplete(args: JsonObject): JsonObject;
    durableRunRecover(args?: JsonObject): JsonObject;
    trustCurveRecord(args: JsonObject): JsonObject;
    modelRouteV01226(args: JsonObject): JsonObject;
    deliveryGateV01226(args: JsonObject): JsonObject;
    taskHandoffManifest(args: JsonObject): JsonObject;
    domainEvaluatorRun(args: JsonObject): JsonObject;
    openApiImport(args: JsonObject): Promise<JsonObject>;
  }
}
export function installAdapterRuntimeMethods(serviceClass: typeof CraftService): void {
  serviceClass.prototype.adapterManifestSave = function (args) { return new V01226Runtime(this.store).adapterRegister(args as never); };
  serviceClass.prototype.adapterManifestGet = function (args) { return { manifest: new V01226Runtime(this.store).adapterGet(String(args.adapter_id)) }; };
  serviceClass.prototype.adapterManifestList = function (args = {}) { return new V01226Runtime(this.store).adapterList(Number(args.limit ?? 50)); };
  serviceClass.prototype.adapterHealth = function (args) { return new V01226Runtime(this.store).adapterHealth(String(args.adapter_id)); };
  serviceClass.prototype.adapterConformance = function (args) { return new V01226Runtime(this.store).adapterConformance(String(args.adapter_id)); };
  serviceClass.prototype.adapterQuarantine = function (args) { return new V01226Runtime(this.store).adapterQuarantine(String(args.adapter_id), String(args.reason)); };
  serviceClass.prototype.adapterRollback = function (args) { return new V01226Runtime(this.store).adapterRollback(String(args.adapter_id)); };
  serviceClass.prototype.adapterInstall = async function (args) { return new V01226Runtime(this.store).adapterInstall(String(args.manifest_path), stringOrUndefined(args.integrity)); };
  serviceClass.prototype.commandPlan = function (args) { return new V01226Runtime(this.store).commandPlan(args as never); };
  serviceClass.prototype.commandRun = async function (args) { return new V01226Runtime(this.store).commandRun(args as never); };
  serviceClass.prototype.commandObserve = function (args) { return { run: new V01226Runtime(this.store).commandObserve(String(args.run_id)) }; };
  serviceClass.prototype.commandCancel = function (args) { return new V01226Runtime(this.store).commandCancel(String(args.run_id)); };
  serviceClass.prototype.commandRetry = async function (args) { return new V01226Runtime(this.store).commandRetry(String(args.run_id)); };
  serviceClass.prototype.contextManifestV01226Save = function (args) { return new V01226Runtime(this.store).contextManifestSave(args); };
  serviceClass.prototype.capabilityProjection = function (args) {
    return new V01226Runtime(this.store).capabilityProject({
      candidates: arrayOrEmpty<JsonObject>(args.candidates),
      required: arrayOrEmpty<string>(args.required),
      token_budget: numberOrUndefined(args.token_budget),
    });
  };
  serviceClass.prototype.durableRunStart = function (args) { return new V01226Runtime(this.store).durableStart(args); };
  serviceClass.prototype.durableRunTick = function (args = {}) { return new V01226Runtime(this.store).durableTick(String(args.owner ?? "local"), Number(args.lease_seconds ?? 30)); };
  serviceClass.prototype.durableRunComplete = function (args) { return new V01226Runtime(this.store).durableComplete(String(args.run_id), String(args.status) as "completed" | "failed" | "cancelled", args.result as JsonObject | undefined); };
  serviceClass.prototype.durableRunRecover = function (args = {}) { return new V01226Runtime(this.store).durableRecover(args.owner === undefined ? undefined : String(args.owner)); };
  serviceClass.prototype.trustCurveRecord = function (args) { return new V01226Runtime(this.store).trustRecord({ scope: String(args.scope), passed: Number(args.passed), failed: Number(args.failed), evidence_refs: arrayOrEmpty<string>(args.evidence_refs) }); };
  serviceClass.prototype.modelRouteV01226 = function (args) { return new V01226Runtime(this.store).modelRoute({ candidates: arrayOrEmpty<JsonObject>(args.candidates), objective: args.objective as "quality" | "cost" | "latency" | undefined, budget: numberOrUndefined(args.budget) }); };
  serviceClass.prototype.deliveryGateV01226 = function (args) { return new V01226Runtime(this.store).deliveryGate({ artifacts: arrayOrEmpty<string>(args.artifacts), evidence: arrayOrEmpty<string>(args.evidence), required_artifacts: arrayOrEmpty<string>(args.required_artifacts), required_evidence: arrayOrEmpty<string>(args.required_evidence) }); };
  serviceClass.prototype.taskHandoffManifest = function (args) { return new V01226Runtime(this.store).handoff(args as never); };
  serviceClass.prototype.domainEvaluatorRun = function (args) { return new V01226Runtime(this.store).evaluatorRun({ evaluator_id: String(args.evaluator_id), observations: args.observations as JsonObject }); };
  serviceClass.prototype.openApiImport = async function (args) { return importOpenApiDocument(new V01226Runtime(this.store), args.document as string | JsonObject); };
}
