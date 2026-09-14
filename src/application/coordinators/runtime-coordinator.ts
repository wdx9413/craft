import type { CraftStore } from "../../store.ts";
import type { ActionGatewayKernel, DurableWorkerKernel, ProviderRouterKernel } from "../../v01213-runtime.ts";
import type { AutonomousRuntimeKernel } from "../../autonomous-runtime.ts";
import type { RuntimeAssuranceKernel } from "../../runtime-assurance.ts";
import type { RuntimeTruthKernel } from "../../runtime-truth-kernel.ts";
import type { LocalRuntimeServiceKernel } from "../../v01211-runtime.ts";

/** Application-owned Runtime context for future orchestration extraction. */
export class RuntimeCoordinator {
  readonly store: CraftStore;
  readonly actionGateway: ActionGatewayKernel;
  readonly durableWorker: DurableWorkerKernel;
  readonly providerRouter: ProviderRouterKernel;
  readonly runtimeTruth: RuntimeTruthKernel;
  readonly runtimeAssurance: RuntimeAssuranceKernel;
  readonly autonomousRuntime: AutonomousRuntimeKernel;
  readonly localRuntimeService: LocalRuntimeServiceKernel;
  constructor(
    store: CraftStore, actionGateway: ActionGatewayKernel, durableWorker: DurableWorkerKernel,
    providerRouter: ProviderRouterKernel, runtimeTruth: RuntimeTruthKernel,
    runtimeAssurance: RuntimeAssuranceKernel, autonomousRuntime: AutonomousRuntimeKernel,
    localRuntimeService: LocalRuntimeServiceKernel,
  ) {
    this.store = store; this.actionGateway = actionGateway; this.durableWorker = durableWorker;
    this.providerRouter = providerRouter; this.runtimeTruth = runtimeTruth;
    this.runtimeAssurance = runtimeAssurance; this.autonomousRuntime = autonomousRuntime;
    this.localRuntimeService = localRuntimeService;
  }
}
