import type { CraftService } from "../craft-service.ts";
import type { JsonObject } from "../../store.ts";
import { installKnowledgeMemoryMethods } from "./knowledge-memory.ts";
import { installTraceMethods } from "./trace.ts";
import { installCapabilityLifecycleMethods } from "./capability-lifecycle.ts";
import { installMemoryConsolidationMethods } from "./memory-consolidation.ts";
import { installRemoteInteropMethods } from "./remote-interop.ts";
import { installPlatformMethods } from "./platform.ts";

/** Thin application use cases that delegate to one owned domain kernel. */
declare module "../craft-service.ts" {
  interface CraftService {
    knowledgeMemoryInstallBuiltins(): JsonObject;
    knowledgeSourceRegister(args: JsonObject): JsonObject;
    knowledgeSourceList(args: JsonObject): JsonObject;
    knowledgeSourceTransition(args: JsonObject): JsonObject;
    memoryLedgerRemember(args: JsonObject): JsonObject;
    memoryLedgerTransition(args: JsonObject): JsonObject;
    memoryLedgerCompatBind(args: JsonObject): JsonObject;
    contextResolutionResolve(args: JsonObject): JsonObject;
    contextResolutionGet(args: JsonObject): JsonObject;
    retrievalAdapterConfigure(args: JsonObject): JsonObject;
    retrievalAdapterEvaluate(args: JsonObject): JsonObject;
    traceStart(args: JsonObject): JsonObject;
    traceAppend(args: JsonObject): JsonObject;
    traceObserve(args: JsonObject): JsonObject;
    traceFeedback(args: JsonObject): JsonObject;
    traceFinalize(args: JsonObject): JsonObject;
    traceGet(args: JsonObject): JsonObject;
    traceQuery(args?: JsonObject): JsonObject;
    traceReplayBundle(args: JsonObject): JsonObject;
    traceCaseCompile(args: JsonObject): JsonObject;
    traceRetentionPlan(args: JsonObject): JsonObject;
    traceRetentionSweep(args?: JsonObject): JsonObject;
    capabilityLifecycleRegister(args: JsonObject): JsonObject;
    capabilityLifecycleInstall(args: JsonObject): JsonObject;
    capabilityLifecycleActivate(args: JsonObject): JsonObject;
    capabilityLifecycleDisable(args: JsonObject): JsonObject;
    capabilityLifecycleUpgrade(args: JsonObject): JsonObject;
    capabilityLifecycleRetire(args: JsonObject): JsonObject;
    capabilityLifecycleResolve(args: JsonObject): JsonObject;
    capabilityLifecycleList(): JsonObject;
    memoryConsolidationRemember(args: JsonObject): JsonObject;
    memoryConsolidationConsolidate(args: JsonObject): JsonObject;
    memoryConsolidationResolve(args: JsonObject): JsonObject;
    memoryConsolidationSearch(args: JsonObject): JsonObject;
    remoteInteropPrepare(args: JsonObject): JsonObject;
    remoteInteropReport(args: JsonObject): JsonObject;
    remoteInteropGet(args: JsonObject): JsonObject;
    platformMemberSave(args: JsonObject): JsonObject;
    platformAuthorize(args: JsonObject): JsonObject;
    platformObserve(args: JsonObject): JsonObject;
    platformObservabilityExport(args: JsonObject): JsonObject;
  }
}

export function installKernelDelegateMethods(serviceClass: typeof CraftService): void {
  installKnowledgeMemoryMethods(serviceClass);
  installTraceMethods(serviceClass);
  installCapabilityLifecycleMethods(serviceClass);
  installMemoryConsolidationMethods(serviceClass);
  installRemoteInteropMethods(serviceClass);
  installPlatformMethods(serviceClass);
}
