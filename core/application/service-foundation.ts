import { Catalog } from "../catalog.ts";
import { CraftStore, type JsonObject } from "../infrastructure/store.ts";
import type { EmbeddingProvider } from "../semantic.ts";
import { LocalIsolatedAdapter } from "../isolated.ts";
import { WorkspaceState } from "../workspace.ts";
import { TransactionCoordinator } from "../transaction.ts";
import { TrajectoryCompiler } from "../trajectory.ts";
import { VerifiedScriptRunner } from "../script-run.ts";
import { WorkbenchKernel } from "../workbench.ts";
import { ChangeSetKernel } from "../changeset.ts";
import { ControlPlaneKernel } from "../control-plane.ts";
import { SecurityBrokerKernel } from "../security.ts";
import { DataOnlyParserAdapter } from "../untrusted-parser.ts";
import { ParserProcessAdapter } from "../parser-process.ts";
import { SandboxKernel } from "../sandbox.ts";
import { DockerSandboxAdapter } from "../docker-sandbox.ts";
import { TrustedEgressBroker } from "../egress.ts";
import { ExternalEffectKernel } from "../effects.ts";
import { RecoveryQueueKernel } from "../recovery.ts";
import { TriggerKernel } from "../trigger.ts";
import { SpeculativeKernel } from "../speculative.ts";
import { LineageKernel } from "../lineage.ts";
import { HydrationKernel } from "../hydration.ts";
import { AutonomyKernel } from "../autonomy.ts";
import { ContractInferenceKernel } from "../contracts.ts";
import { CapabilityCanaryKernel } from "../capability-canary.ts";
import { CapabilityFederationKernel } from "../federation.ts";
import { HubSyncKernel } from "../hub-sync.ts";
import { MaterializationKernel } from "../materialization.ts";
import { CapabilityCertificationKernel } from "../certification.ts";
import { SupplyChainKernel } from "../supply-chain.ts";
import { AttentionKernel } from "../attention.ts";
import { HomeKernel } from "../home.ts";
import { CodexHostKernel } from "../codex-driver.ts";
import { ClaudeHostKernel } from "../claude-driver.ts";
import { GenericCliHostKernel } from "../generic-driver.ts";
import { HostRunKernel } from "../host-run.ts";
import { type HostProfile, mergeHostProfiles } from "../host-registry.ts";
import { InternalHostDriver } from "../internal-host-driver.ts";
import { canonicalToolCatalog } from "../interfaces/canonical-tools.ts";
import { MetricsKernel } from "../metrics.ts";
import { PROVIDER_CATALOG, specsFromModels, type ModelProviderSpec, type ModelTransport } from "../model-gateway.ts";
import { loadSettingsSync } from "../settings.ts";
import type { HostDriver } from "../host-driver.ts";
import type { KnowledgeBoundLaunchKernel } from "../../capability/craft-knowledge/knowledge-bound-launch.ts";
import type { KnowledgeWorkbenchKernel } from "../../capability/craft-knowledge/knowledge-workbench.ts";
import type { WikiCandidateGovernanceKernel } from "../../capability/craft-knowledge/wiki-candidate-governance.ts";
import { GuidedWorkKernel } from "../guided-work.ts";
import { ExecutionSafetyKernel } from "../execution-safety.ts";
import type { LocalCandidateImportKernel } from "../../capability/craft-knowledge/local-candidate-import.ts";
import { A2ADiscoveryKernel } from "../a2a-discovery.ts";
import { WorkDeliveryKernel } from "../work-delivery.ts";
import { DeliveryEvaluationKernel } from "../delivery-evaluation.ts";
import { PlatformExecutionKernel } from "../platform-execution.ts";
import { DeliveryLoopKernel } from "../delivery-loop.ts";
import { TaskControlKernel } from "../task-control.ts";
import { TaskRunKernel } from "../task-run.ts";
import { TaskBenchmarkKernel } from "../task-benchmark.ts";
import { StateWorkspaceKernel } from "../state-workspace.ts";
import { VerifiedWorkLoopKernel } from "../verified-work-loop.ts";
import { KnowledgeAutoReviewKernel } from "../knowledge-auto-review.ts";
import { DecisionPointContextGate } from "../decision-context-gate.ts";
import { EvalCampaignKernel } from "../eval-campaign.ts";
import type { ProjectKnowledgeKernel } from "../../capability/craft-knowledge/project-knowledge.ts";
import { CapabilityConnectorKernel } from "../capability-connector.ts";
import { CapabilityAccessKernel } from "../capability-access.ts";
import { HostActivationManifestKernel } from "../host-activation-manifest.ts";
import { ExecutionFabricKernel } from "../execution-fabric.ts";
import { HostBridgeKernel } from "../host-bridge.ts";
import { ManagedWriteKernel } from "../managed-write.ts";
import { EvalCampaignReportKernel } from "../eval-campaign-report.ts";
import { AdaptiveHarnessKernel } from "../adaptive-harness.ts";
import { ManagedRunKernel } from "../managed-run.ts";
import { CampaignRunnerKernel } from "../campaign-runner.ts";
import { AutonomyLadderKernel } from "../autonomy-ladder.ts";
import { WorkspaceObserverKernel } from "../workspace-observer.ts";
import { WorkCoordinatorKernel } from "../work-coordinator.ts";
import { AgentEvalLabKernel } from "../agent-eval-lab.ts";
import { EvaluationOperationsKernel } from "../evaluation-operations.ts";
import { EnterpriseAccessKernel } from "../enterprise-access.ts";
import { A2ADelegationKernel } from "../a2a-delegation.ts";
import { AutonomousRuntimeKernel } from "../autonomous-runtime.ts";
import { CapabilityLifecycleKernel } from "../capability-lifecycle.ts";
import { MemoryConsolidationKernel } from "../memory-consolidation.ts";
import { RemoteInteropKernel } from "../remote-interop.ts";
import { PlatformOperationsKernel } from "../platform-operations.ts";
import { UsageKernel } from "../usage.ts";
import { IntentCompilerKernel } from "../intent-compiler.ts";
import { TraceKernel } from "../trace-kernel.ts";
import { TraceArchiveStorageKernel, type TraceArchiveRuntimeBackend } from "../trace-archive-storage.ts";
import { HostSessionEventKernel } from "../host-session-events.ts";
import { OutcomeObserverKernel } from "../outcome-observer.ts";
import { RuntimeTruthKernel } from "../runtime-truth-kernel.ts";
import { OsSecurityKernel } from "../os-security.ts";
import { McpRegistryKernel } from "../mcp-registry.ts";
import { A2ATransportKernel } from "../a2a-transport.ts";
import { RemoteRuntimeKernel } from "../remote-runtime.ts";
import { SupplyChainAttestationKernel } from "../supply-chain-attestation.ts";
import { RuntimeAcceptanceKernel } from "../runtime-acceptance.ts";
import { A2AV1AdapterKernel } from "../a2a-v1-adapter.ts";
import { OrgSyncKernel } from "../org-sync.ts";
import type { ProjectBrainKernel } from "../../capability/craft-knowledge/project-brain.ts";
import { WorkSessionKernel } from "../work-session.ts";
import { WorkbenchExperienceKernel } from "../workbench-experience.ts";
import { LongTaskWorkerKernel } from "../long-task-worker.ts";
import { ContextPlaneKernel } from "../context-plane.ts";
import { CostLedgerKernel } from "../cost-ledger.ts";
import { DomainEvaluatorKernel } from "../domain-evaluator.ts";
import { FeedbackLearningKernel } from "../feedback-learning.ts";
import { HandoffManifestKernel } from "../handoff-manifest.ts";
import { LocalRuntimeServiceKernel } from "../local-runtime-service.ts";
import { ProcedureAutomationKernel } from "../../capability/craft-experience/procedure-automation.ts";
import { ProjectBundleKernel } from "../project-bundle.ts";
import { KnowledgeMemoryBundleKernel } from "../knowledge-memory-bundle.ts";
import { ReplayRunnerKernel } from "../replay-runner.ts";
import { VerifiedAutonomousWorkKernel, SandboxConformanceKernel, TraceExplorerKernel } from "../verified-autonomous-work.ts";
import { ActionGatewayKernel, AcceptanceGateKernel, DurableWorkerKernel, ProviderRouterKernel, A2AProtocolKernel } from "../runtime-completion.ts";
import { RuntimeAssuranceKernel } from "../runtime-assurance.ts";
import { FederatedDelegationKernel } from "../federated-delegation.ts";
import { HarnessTopologyKernel } from "../harness-topology.ts";
import { RuntimeReadinessKernel } from "../runtime-readiness.ts";
import { AssuredPilotKernel } from "../assured-pilot.ts";
import { CapabilityKitRuntime } from "../capability-kit-runtime.ts";
import { EngineeringQualityProfileKernel } from "../../capability/engineering-quality-profile.ts";
import type { KnowledgeSourceRegistry } from "../../capability/craft-knowledge/knowledge-source-registry.ts";
import type { MemoryLedgerKernel } from "../../capability/craft-memory/memory-ledger.ts";
import type { MemorySignalsKernel } from "../../capability/craft-memory/memory-signals-kernel.ts";
import { ContextResolutionKernel } from "../context-resolution.ts";
import { ScopeIdentityKernel } from "../scope-identity.ts";
import { MaintenanceScheduler } from "../maintenance-scheduler.ts";
import { ContextProjectionKernel } from "../context-projection.ts";
import { StateViewKernel } from "../state-view.ts";
import type { KnowledgeRelationKernel } from "../../capability/craft-knowledge/knowledge-relation.ts";
import { WorkRuntimeModeKernel } from "../work-runtime-mode.ts";
import { TurnCognitiveRuntime } from "../turn-cognitive-runtime.ts";
import { ContinualHarnessKernel } from "../continual-harness.ts";
import { StatefulComputeKernel } from "../stateful-compute.ts";
import { UncertaintyPolicyKernel } from "../uncertainty-policy.ts";
import { ActionGateKernel } from "../action-gate.ts";
import { AuthorizationKernel } from "../authorization.ts";
import { ObjectRailKernel } from "../object-rail.ts";
import { SubscriptionAuthorizationKernel } from "../subscription-authorization.ts";
import { DecisionSurfaceKernel } from "../decision-surface.ts";
import { CapabilityBaseKernel } from "../capability-base.ts";
import { BrowserDrivingKernel } from "../browser-driving.ts";
import { WindowsDesktopAutomationKernel } from "../windows-desktop-automation.ts";
import { WindowsDesktopVisionKernel } from "../windows-desktop-vision.ts";
import { HonestClaimsKernel } from "../honest-claims.ts";
import { ObjectModelKernel } from "../object-model.ts";
import { HumanTouchpointKernel } from "../human-touchpoints.ts";
import { ReceiptKernel } from "../receipt.ts";
import { SubscriptionDriftKernel } from "../subscription-drift.ts";
import { PreparedStateKernel } from "../prepared-state.ts";
import { AdjudicationQueueKernel } from "../adjudication-queue.ts";
import { ObjectHatchingKernel } from "../object-hatching.ts";
import { ReleaseQualificationKernel } from "../release-qualification.ts";
import { VerificationPlane } from "../verification-plane.ts";
import type { EvaluationModelProfileKernel } from "../../capability/craft-experience/evaluation-model-profile.ts";
import type { WorkflowEvolutionKernel } from "../../capability/craft-experience/workflow-evolution.ts";
import { TrustProfileKernel } from "../trust-profile.ts";
import { WebOperationKernel } from "../web-operation.ts";
import { WorkCoordinator } from "./coordinators/work-coordinator.ts";
import { RuntimeCoordinator } from "./coordinators/runtime-coordinator.ts";
import { EvaluationCoordinator } from "./coordinators/evaluation-coordinator.ts";
import { WorkspaceCoordinator } from "./coordinators/workspace-coordinator.ts";
import { DurableActionLoopKernel } from "../durable-action-loop.ts";
import type { ExperienceLedgerKernel } from "../../capability/craft-experience/experience-ledger.ts";
import type { ProcedureStore } from "../../capability/craft-experience/procedure-projection.ts";
import { KNOWLEDGE_KERNELS } from "../../capability/craft-knowledge/capability.ts";
import { MEMORY_KERNELS } from "../../capability/craft-memory/capability.ts";
import { EXPERIENCE_KERNELS } from "../../capability/craft-experience/capability.ts";
import { CODEBASE_KERNELS } from "../../capability/craft-codebase/capability.ts";
import type { CodebaseIndexKernel } from "../../capability/craft-codebase/codebase-index.ts";
import { CRAFT_CAPABILITIES } from "../capability-catalog.ts";
import { CORE_KERNELS, buildCapabilityRegistry } from "../capability-protocol.ts";
import { HookPlane } from "../hook-plane.ts";
import { LegacyKnowledgeMigrationKernel } from "../legacy-knowledge-migration.ts";
import { MemoryGovernanceKernel } from "../memory-governance.ts";
import { WorkflowDagKernel } from "../workflow-dag.ts";
import { TaskStateKernel } from "../task-state.ts";
import { McpTaskKernel } from "../mcp-tasks.ts";
import { RuntimeProofKernel } from "../runtime-proof.ts";
import { ContentMigrationKernel } from "../content-migration.ts";
import { TraceReviewKernel } from "../trace-review.ts";
import { MemoryMaintenanceKernel } from "../memory-maintenance.ts";
import { RuntimeModelProbeKernel } from "../runtime-model-probe.ts";
import { EvaluationContractKernel } from "../evaluation-contract.ts";
import { RuntimeExecutionAttemptKernel } from "../runtime-execution-attempt.ts";
import { ContextWorkingSetKernel } from "../context-working-set.ts";
import { GraphCompilerKernel } from "../graph-compiler.ts";
import { CapabilityIntakeKernel } from "../capability-intake.ts";
import { WorkbenchCommandKernel } from "../workbench-command.ts";
import { ActivationProofKernel } from "../activation-proof.ts";
import { ComponentHistoryMigrationKernel } from "../component-history-migration.ts";

/**
 * Stable composition root for the service. Domain behavior stays in focused
 * kernels; CraftService is the backwards-compatible API facade.
 */
export abstract class ServiceFoundation {
  readonly store: CraftStore;
  readonly catalog: Catalog;
  readonly isolatedAdapter: LocalIsolatedAdapter;
  readonly workspace: WorkspaceState;
  readonly transaction: TransactionCoordinator;
  readonly trajectory: TrajectoryCompiler;
  readonly scriptRunner: VerifiedScriptRunner;
  readonly workbench: WorkbenchKernel;
  readonly changeSets: ChangeSetKernel;
  readonly controlPlane: ControlPlaneKernel;
  readonly security: SecurityBrokerKernel;
  readonly dataOnlyParser: DataOnlyParserAdapter;
  readonly parserProcess: ParserProcessAdapter;
  readonly sandbox: SandboxKernel;
  readonly dockerSandbox: DockerSandboxAdapter;
  readonly egressBroker: TrustedEgressBroker;
  readonly effects: ExternalEffectKernel;
  readonly recovery: RecoveryQueueKernel;
  readonly triggers: TriggerKernel;
  readonly speculative: SpeculativeKernel;
  readonly lineage: LineageKernel;
  readonly hydration: HydrationKernel;
  readonly autonomy: AutonomyKernel;
  readonly contracts: ContractInferenceKernel;
  readonly capabilityCanary: CapabilityCanaryKernel;
  readonly federation: CapabilityFederationKernel;
  readonly hubSync: HubSyncKernel;
  readonly materialization: MaterializationKernel;
  readonly certification: CapabilityCertificationKernel;
  readonly supplyChain: SupplyChainKernel;
  readonly attention: AttentionKernel;
  readonly home: HomeKernel;
  readonly codexHost: CodexHostKernel;
  readonly claudeHost: ClaudeHostKernel;
  readonly hostProfiles: readonly HostProfile[];
  readonly hostDrivers: Map<string, HostDriver>;
  readonly hostRuns: HostRunKernel;

  hostDriver(host: string): HostDriver | undefined { return this.hostDrivers.get(host); }
  readonly knowledgeLaunch: KnowledgeBoundLaunchKernel;
  readonly knowledgeWorkbench: KnowledgeWorkbenchKernel;
  readonly wikiCandidateGovernance: WikiCandidateGovernanceKernel;
  readonly guidedWork: GuidedWorkKernel;
  readonly executionSafety: ExecutionSafetyKernel;
  readonly localCandidateImport: LocalCandidateImportKernel;
  readonly legacyKnowledgeMigration: LegacyKnowledgeMigrationKernel;
  readonly a2aDiscovery: A2ADiscoveryKernel;
  readonly workDelivery: WorkDeliveryKernel;
  readonly deliveryEvaluation: DeliveryEvaluationKernel;
  readonly platformExecution: PlatformExecutionKernel;
  readonly deliveryLoop: DeliveryLoopKernel;
  readonly taskControl: TaskControlKernel;
  readonly taskRuns: TaskRunKernel;
  readonly taskBenchmarks: TaskBenchmarkKernel;
  readonly stateWorkspace: StateWorkspaceKernel;
  readonly verifiedWorkLoops: VerifiedWorkLoopKernel;
  readonly knowledgeAutoReviewKernel: KnowledgeAutoReviewKernel;
  readonly decisionContextGate: DecisionPointContextGate;
  readonly evalCampaigns: EvalCampaignKernel;
  readonly projectKnowledge: ProjectKnowledgeKernel;
  readonly capabilityConnectors: CapabilityConnectorKernel;
  readonly capabilityAccess: CapabilityAccessKernel;
  readonly capabilityKits: CapabilityKitRuntime;
  /** Optional, explicit, read-only Workspace structural analysis. */
  readonly codebase: CodebaseIndexKernel;
  /** Explicit opt-in sample; it is not a default Host capability. */
  readonly engineeringQualityProfile: EngineeringQualityProfileKernel;
  /** Host-reported, content-free proof; configuration alone is never evidence. */
  readonly activationProof: ActivationProofKernel;
  /** Explicit compatibility migration plan/apply seam for the three components. */
  readonly componentHistoryMigration: ComponentHistoryMigrationKernel;
  /**
   * The three pieces `KnowledgeMemoryRuntime` used to be one of.
   *
   * Two members' writes and the shared read side, now named after the member each belongs to.
   * A single property could not be owned by either capability package, which is why
   * `craft-memory` could not be declared until this split.
   */
  readonly knowledgeSources: KnowledgeSourceRegistry;
  readonly memoryLedger: MemoryLedgerKernel;
  readonly memorySignals: MemorySignalsKernel;
  readonly contextResolution: ContextResolutionKernel;
  /** Stable cross-device project identity and aliases, shared by all components. */
  readonly scopeIdentity: ScopeIdentityKernel;
  /** The durable projection: what a session omitted, and the ids a later call can bring back. */
  readonly contextProjection: ContextProjectionKernel;
  /** One read-only view of `state`, assembled from the records that carry it. */
  readonly stateView: StateViewKernel;
  readonly knowledgeRelations: KnowledgeRelationKernel;
  readonly memoryGovernance: MemoryGovernanceKernel;
  readonly workflowDag: WorkflowDagKernel;
  readonly taskState: TaskStateKernel;
  readonly workRuntimeModes: WorkRuntimeModeKernel;
  readonly turnCognitive: TurnCognitiveRuntime;
  readonly continualHarness: ContinualHarnessKernel;
  readonly statefulCompute: StatefulComputeKernel;
  readonly uncertaintyPolicies: UncertaintyPolicyKernel;
  /** Which interaction level an action earns, and the record of why (plan 4.2–6.3.1). */
  readonly actionGate: ActionGateKernel;
  /** Acknowledge vs authorize: who granted which effect against which receipt (plan 11.4). */
  readonly authorization: AuthorizationKernel;
  /** The object rail read model behind the plan's three-column screen (plan 8 / 15.3). */
  readonly objectRail: ObjectRailKernel;
  /** Subscription as a time-boxed, revocable authorization (plan 7.1). */
  readonly subscriptionAuthorizations: SubscriptionAuthorizationKernel;
  /** The generative decision surface: shape follows the decision, not the schema (plan 9). */
  readonly decisionSurface: DecisionSurfaceKernel;
  /** The capability base: one Action shape, and the GUI-fallback replacement debt (plan 13). */
  readonly capabilityBase: CapabilityBaseKernel;
  /** Browser driving adjudication: three levels, VLM ban, script hygiene (plan 13A). */
  readonly browserDriving: BrowserDrivingKernel;
  /** Windows UI Automation: allowlisted applications and controls, never arbitrary shell commands. */
  readonly windowsDesktopAutomation: WindowsDesktopAutomationKernel;
  /** Visual/OCR fallback for self-drawn desktop applications; never unattended. */
  readonly windowsDesktopVision: WindowsDesktopVisionKernel;
  /** Honest claims: L1/L2/L3 routing, the paired L1 report, and ledger wording (plan 4.4/4.6/11.3). */
  readonly honestClaims: HonestClaimsKernel;
  /** The nine-field object model and the decision write-back (plan 5.1/5.2). */
  readonly objectModel: ObjectModelKernel;
  /** The core metric: human touchpoints per object, paired with wall-clock (plan 3.1/3.3). */
  readonly humanTouchpoints: HumanTouchpointKernel;
  /** Evidence receipts: recomputable, two-observation, provenance-marked (plan 10–11.5). */
  readonly receipts: ReceiptKernel;
  /** Subscription drift: fingerprint vs dedup key, suspension and dormancy (plan 7.2–7.4). */
  readonly subscriptionDrift: SubscriptionDriftKernel;
  /** Prepared state: what a person approved, re-verified at release (plan 13A.3.2–3.3). */
  readonly preparedStates: PreparedStateKernel;
  /** Adjudication concurrency: one focused card, batched same-kind items (plan 6.4). */
  readonly adjudicationQueue: AdjudicationQueueKernel;
  /** Object hatching: the one job free expression does, and its structured exit (plan 5.3). */
  readonly objectHatching: ObjectHatchingKernel;
  readonly releaseQualifications: ReleaseQualificationKernel;
  readonly verificationPlane: VerificationPlane;
  readonly durableActionLoops: DurableActionLoopKernel;
  readonly experienceLedger: ExperienceLedgerKernel;
  readonly experienceProcedures: ProcedureStore;
  readonly evaluationModelProfiles: EvaluationModelProfileKernel;
  readonly workflowEvolution: WorkflowEvolutionKernel;
  readonly hostActivationManifests: HostActivationManifestKernel;
  readonly executionFabric: ExecutionFabricKernel;
  readonly hostBridge: HostBridgeKernel;
  readonly managedWrites: ManagedWriteKernel;
  readonly evalCampaignReports: EvalCampaignReportKernel;
  readonly adaptiveHarnesses: AdaptiveHarnessKernel;
  readonly managedRuns: ManagedRunKernel;
  readonly campaignRunners: CampaignRunnerKernel;
  readonly runtimeAssurance: RuntimeAssuranceKernel;
  readonly federatedDelegation: FederatedDelegationKernel;
  readonly harnessTopologies: HarnessTopologyKernel;
  readonly runtimeReadiness: RuntimeReadinessKernel;
  readonly assuredPilot: AssuredPilotKernel;
  readonly autonomyLadder: AutonomyLadderKernel;
  readonly workspaceObserver: WorkspaceObserverKernel;
  readonly workCoordinators: WorkCoordinatorKernel;
  readonly agentEvalLab: AgentEvalLabKernel;
  readonly evaluationOperations: EvaluationOperationsKernel;
  readonly enterpriseAccess: EnterpriseAccessKernel;
  readonly a2aDelegation: A2ADelegationKernel;
  readonly autonomousRuntime: AutonomousRuntimeKernel;
  readonly capabilityLifecycle: CapabilityLifecycleKernel;
  readonly memoryConsolidation: MemoryConsolidationKernel;
  readonly contentMigration: ContentMigrationKernel;
  readonly traceReviews: TraceReviewKernel;
  readonly memoryMaintenance: MemoryMaintenanceKernel;
  readonly maintenanceScheduler: MaintenanceScheduler;
  readonly runtimeModelProbe: RuntimeModelProbeKernel;
  readonly mcpTasks: McpTaskKernel;
  readonly runtimeProof: RuntimeProofKernel;
  readonly evaluationContracts: EvaluationContractKernel;
  /** Cross-host execution facts; Hosts only report through this seam. */
  readonly runtimeAttempts: RuntimeExecutionAttemptKernel;
  /** Context selection explanation and content-free receipt. */
  readonly contextWorkingSets: ContextWorkingSetKernel;
  /** Graph lowering is analysis only; VerifiedWorkLoop remains the executor. */
  readonly graphCompiler: GraphCompilerKernel;
  /** Capability source/scanning/conformance gate. */
  readonly capabilityIntake: CapabilityIntakeKernel;
  /** Versioned human commands; command effects stay in the service facade. */
  readonly workbenchCommands: WorkbenchCommandKernel;
  readonly remoteInterop: RemoteInteropKernel;
  readonly platformOperations: PlatformOperationsKernel;
  readonly modelProviders: readonly ModelProviderSpec[];
  readonly internalHost: InternalHostDriver;
  readonly metrics: MetricsKernel;
  readonly usage: UsageKernel;
  readonly intentCompiler: IntentCompilerKernel;
  readonly traceArchiveStorage: TraceArchiveStorageKernel;
  readonly trace: TraceKernel;
  readonly hostSessions: HostSessionEventKernel;
  readonly outcomeObservers: OutcomeObserverKernel;
  readonly runtimeTruth: RuntimeTruthKernel;
  readonly osSecurity: OsSecurityKernel;
  readonly mcpRegistry: McpRegistryKernel;
  readonly a2aTransport: A2ATransportKernel;
  readonly remoteRuntime: RemoteRuntimeKernel;
  readonly supplyChainAttestations: SupplyChainAttestationKernel;
  readonly runtimeAcceptance: RuntimeAcceptanceKernel;
  readonly a2aV1: A2AV1AdapterKernel;
  readonly orgSync: OrgSyncKernel;
  readonly projectBrain: ProjectBrainKernel;
  readonly workSessions: WorkSessionKernel;
  readonly workbenchExperience: WorkbenchExperienceKernel;
  readonly longTaskWorker: LongTaskWorkerKernel;
  readonly contextPlane: ContextPlaneKernel;
  readonly replayRunner: ReplayRunnerKernel;
  readonly localRuntimeService: LocalRuntimeServiceKernel;
  readonly procedureAutomation: ProcedureAutomationKernel;
  readonly projectBundles: ProjectBundleKernel;
  readonly knowledgeMemoryBundles: KnowledgeMemoryBundleKernel;
  readonly feedbackLearning: FeedbackLearningKernel;
  readonly domainEvaluators: DomainEvaluatorKernel;
  readonly handoffManifests: HandoffManifestKernel;
  readonly costLedger: CostLedgerKernel;
  readonly verifiedAutonomousWork: VerifiedAutonomousWorkKernel;
  readonly sandboxConformance: SandboxConformanceKernel;
  readonly traceExplorer: TraceExplorerKernel;
  readonly actionGateway: ActionGatewayKernel;
  readonly acceptanceGates: AcceptanceGateKernel;
  readonly durableWorker: DurableWorkerKernel;
  readonly providerRouter: ProviderRouterKernel;
  readonly a2aProtocol: A2AProtocolKernel;
  readonly trustProfiles: TrustProfileKernel;
  readonly webOperations: WebOperationKernel;
  /** Explicit application contexts; kernels remain the single behavior owners. */
  /**
   * The hooks the assembled capabilities attached to the flow.
   *
   * Built from the same registry result as the kernels, so a hook is only reachable if its
   * capability was declared — which is what keeps "a capability can attach work to the flow" from
   * being a claim nothing checks.
   */
  readonly hookPlane: HookPlane;
  readonly workCoordinator: WorkCoordinator;
  readonly runtimeCoordinator: RuntimeCoordinator;
  readonly evaluationCoordinator: EvaluationCoordinator;
  readonly workspaceCoordinator: WorkspaceCoordinator;

  constructor(store: CraftStore, semanticProvider?: EmbeddingProvider, isolatedAdapter = new LocalIsolatedAdapter(),
    dockerSandbox = new DockerSandboxAdapter(), egressBroker = new TrustedEgressBroker(), hostOwnerId?: string,
    hostProfiles?: readonly HostProfile[], modelProviders?: readonly ModelProviderSpec[],
    modelTransport?: ModelTransport, traceArchiveBackends?: readonly TraceArchiveRuntimeBackend[]) {
    this.store = store; this.catalog = new Catalog(store, semanticProvider); this.isolatedAdapter = isolatedAdapter;
    this.workspace = new WorkspaceState(store, store.paths);
    this.transaction = new TransactionCoordinator(store, this.workspace); this.trajectory = new TrajectoryCompiler(store);
    this.scriptRunner = new VerifiedScriptRunner(store); this.workbench = new WorkbenchKernel(store);
    this.changeSets = new ChangeSetKernel(store, this.workbench); this.controlPlane = new ControlPlaneKernel(store);
    this.security = new SecurityBrokerKernel(store); this.dataOnlyParser = new DataOnlyParserAdapter(this.security);
    this.parserProcess = new ParserProcessAdapter(this.security); this.sandbox = new SandboxKernel(store);
    this.dockerSandbox = dockerSandbox; this.egressBroker = egressBroker; this.effects = new ExternalEffectKernel(store);
    this.recovery = new RecoveryQueueKernel(store); this.triggers = new TriggerKernel(store, egressBroker.env);
    this.speculative = new SpeculativeKernel(store); this.lineage = new LineageKernel(store);
    this.hydration = new HydrationKernel(store); this.autonomy = new AutonomyKernel(store);
    this.contracts = new ContractInferenceKernel(store); this.capabilityCanary = new CapabilityCanaryKernel(store);
    this.federation = new CapabilityFederationKernel(store); this.hubSync = new HubSyncKernel(store);
    this.materialization = new MaterializationKernel(store); this.certification = new CapabilityCertificationKernel(store);
    this.supplyChain = new SupplyChainKernel(store); this.attention = new AttentionKernel(store);
    this.home = new HomeKernel(store, this.attention); this.codexHost = new CodexHostKernel(store);
    this.claudeHost = new ClaudeHostKernel(store);
    this.hostProfiles = mergeHostProfiles([...(hostProfiles ?? [])]);
    const configuredModels = specsFromModels(loadSettingsSync(store.paths).models);
    // The catalog is a safe, keyless discovery fallback. A saved configuration
    // takes precedence after restart, while a first-run Studio can still load
    // far enough to guide the user through adding one.
    this.modelProviders = modelProviders && modelProviders.length ? modelProviders
      : configuredModels.length ? configuredModels : PROVIDER_CATALOG;
    this.internalHost = new InternalHostDriver(store, { providers: this.modelProviders, transport: modelTransport,
      toolCatalog: () => canonicalToolCatalog(),
      dispatchable: () => this.dispatchableInternalActions(),
      invokeAction: (action, args) => this.invokeInternalAction(action, args) });
    const drivers: [string, HostDriver][] = [
      ["codex-cli", this.codexHost],
      ["claude-code", this.claudeHost],
      ["internal", this.internalHost],
      ...this.hostProfiles.filter((profile) => !profile.builtin && profile.kind === "agent-cli")
        .map((profile): [string, HostDriver] => [profile.host, new GenericCliHostKernel(store, profile)]),
    ];
    this.hostDrivers = new Map(drivers);
    // Capabilities are assembled rather than constructed in place. The core contributes the
    // environment they run in, then resolves what they built by name — so a capability
    // missing from `CRAFT_CAPABILITIES` fails here naming the kernel it owed, instead of
    // leaving an undefined property to surface at call time.
    const capabilities = buildCapabilityRegistry(CRAFT_CAPABILITIES, {
      [CORE_KERNELS.store]: store,
      [CORE_KERNELS.modelProviders]: this.modelProviders,
    });
    this.knowledgeLaunch = capabilities.registry.require<KnowledgeBoundLaunchKernel>(KNOWLEDGE_KERNELS.boundLaunch);
    this.knowledgeWorkbench = capabilities.registry.require<KnowledgeWorkbenchKernel>(KNOWLEDGE_KERNELS.workbench);
    this.wikiCandidateGovernance = capabilities.registry.require<WikiCandidateGovernanceKernel>(KNOWLEDGE_KERNELS.wikiCandidates);
    this.guidedWork = new GuidedWorkKernel(store);
    this.executionSafety = new ExecutionSafetyKernel(store, this.sandbox);
    this.localCandidateImport = capabilities.registry.require<LocalCandidateImportKernel>(KNOWLEDGE_KERNELS.localImport);
    this.legacyKnowledgeMigration = new LegacyKnowledgeMigrationKernel(store);
    this.a2aDiscovery = new A2ADiscoveryKernel(store);
    this.workDelivery = new WorkDeliveryKernel(store);
    this.deliveryEvaluation = new DeliveryEvaluationKernel(store);
    this.platformExecution = new PlatformExecutionKernel(store);
    this.deliveryLoop = new DeliveryLoopKernel(store, this.workDelivery);
    this.taskControl = new TaskControlKernel(store, this.deliveryLoop);
    this.taskRuns = new TaskRunKernel(store);
    this.taskBenchmarks = new TaskBenchmarkKernel(store, this.deliveryEvaluation);
    this.stateWorkspace = new StateWorkspaceKernel(store);
    this.verifiedWorkLoops = new VerifiedWorkLoopKernel(store);
    this.knowledgeAutoReviewKernel = new KnowledgeAutoReviewKernel(store);
    this.evalCampaigns = new EvalCampaignKernel(store, this.taskBenchmarks);
    this.projectKnowledge = capabilities.registry.require<ProjectKnowledgeKernel>(KNOWLEDGE_KERNELS.projectKnowledge);
    this.capabilityConnectors = new CapabilityConnectorKernel(store);
    this.capabilityAccess = new CapabilityAccessKernel(store, this.catalog);
    this.capabilityKits = new CapabilityKitRuntime(store);
    this.codebase = capabilities.registry.require<CodebaseIndexKernel>(CODEBASE_KERNELS.index);
    this.engineeringQualityProfile = new EngineeringQualityProfileKernel(store);
    this.activationProof = new ActivationProofKernel(store);
    this.componentHistoryMigration = new ComponentHistoryMigrationKernel(store);
    this.knowledgeSources = capabilities.registry.require<KnowledgeSourceRegistry>(KNOWLEDGE_KERNELS.sources);
    this.memoryLedger = capabilities.registry.require<MemoryLedgerKernel>(MEMORY_KERNELS.ledger);
    this.memorySignals = capabilities.registry.require<MemorySignalsKernel>(MEMORY_KERNELS.signals);
    this.hookPlane = new HookPlane(capabilities.hooks);
    // The context plane stays in the core: `component-knowledge`, `component-memory` and
    // `component-context` all expose `craft_context_resolution_*`, so a Host that loads only one
    // concern still has to be able to resolve what that concern holds.
    this.scopeIdentity = new ScopeIdentityKernel(store);
    this.contextResolution = new ContextResolutionKernel(store, capabilities.contributed);
    this.contextWorkingSets = new ContextWorkingSetKernel(store, this.contextResolution);
    this.contextProjection = new ContextProjectionKernel(store);
    this.decisionContextGate = new DecisionPointContextGate(store, this.contextResolution);
    this.stateView = new StateViewKernel(store);
    this.knowledgeRelations = capabilities.registry.require<KnowledgeRelationKernel>(KNOWLEDGE_KERNELS.relations);
    this.memoryGovernance = new MemoryGovernanceKernel(store, this.memoryLedger);
    this.workflowDag = new WorkflowDagKernel(store);
    this.graphCompiler = new GraphCompilerKernel(this.workflowDag);
    this.capabilityIntake = new CapabilityIntakeKernel(store);
    this.workbenchCommands = new WorkbenchCommandKernel(store);
    this.taskState = new TaskStateKernel(store);
    this.workRuntimeModes = new WorkRuntimeModeKernel(store, this.hostDrivers.keys());
    this.turnCognitive = new TurnCognitiveRuntime(store, this.memoryLedger);
    this.continualHarness = new ContinualHarnessKernel(store);
    this.statefulCompute = new StatefulComputeKernel(store);
    this.uncertaintyPolicies = new UncertaintyPolicyKernel(store);
    this.actionGate = new ActionGateKernel(store);
    this.authorization = new AuthorizationKernel(store);
    this.objectRail = new ObjectRailKernel(store);
    this.subscriptionAuthorizations = new SubscriptionAuthorizationKernel(store);
    this.decisionSurface = new DecisionSurfaceKernel(store);
    this.capabilityBase = new CapabilityBaseKernel(store);
    this.browserDriving = new BrowserDrivingKernel(store);
    this.windowsDesktopAutomation = new WindowsDesktopAutomationKernel(store);
    this.windowsDesktopVision = new WindowsDesktopVisionKernel(store);
    this.honestClaims = new HonestClaimsKernel(store);
    this.objectModel = new ObjectModelKernel(store);
    this.humanTouchpoints = new HumanTouchpointKernel(store);
    this.receipts = new ReceiptKernel(store);
    this.subscriptionDrift = new SubscriptionDriftKernel(store);
    this.preparedStates = new PreparedStateKernel(store);
    this.adjudicationQueue = new AdjudicationQueueKernel(store);
    this.objectHatching = new ObjectHatchingKernel(store);
    this.releaseQualifications = new ReleaseQualificationKernel(store);
    this.verificationPlane = new VerificationPlane(store);
    this.experienceLedger = capabilities.registry.require<ExperienceLedgerKernel>(EXPERIENCE_KERNELS.ledger);
    this.experienceProcedures = capabilities.registry.require<ProcedureStore>(EXPERIENCE_KERNELS.procedures);
    this.evaluationModelProfiles = capabilities.registry.require<EvaluationModelProfileKernel>(EXPERIENCE_KERNELS.modelProfiles);
    this.workflowEvolution = capabilities.registry.require<WorkflowEvolutionKernel>(EXPERIENCE_KERNELS.workflowEvolution);
    this.hostActivationManifests = new HostActivationManifestKernel(store, this.hostProfiles);
    this.executionFabric = new ExecutionFabricKernel(store);
    this.hostBridge = new HostBridgeKernel(store);
    this.managedWrites = new ManagedWriteKernel(store, this.transaction, this.workspace);
    this.evalCampaignReports = new EvalCampaignReportKernel(store);
    this.adaptiveHarnesses = new AdaptiveHarnessKernel(store);
    this.managedRuns = new ManagedRunKernel(store);
    this.campaignRunners = new CampaignRunnerKernel(store, this.evalCampaigns);
    this.runtimeAssurance = new RuntimeAssuranceKernel(store, this.platformExecution, this.campaignRunners);
    this.federatedDelegation = new FederatedDelegationKernel(store);
    this.harnessTopologies = new HarnessTopologyKernel(store);
    this.runtimeReadiness = new RuntimeReadinessKernel(store, this.platformExecution);
    this.assuredPilot = new AssuredPilotKernel(store);
    this.autonomyLadder = new AutonomyLadderKernel(store);
    this.workspaceObserver = new WorkspaceObserverKernel(store, this.stateWorkspace);
    this.workCoordinators = new WorkCoordinatorKernel(store, this.managedRuns);
    this.agentEvalLab = new AgentEvalLabKernel(store);
    this.evaluationOperations = new EvaluationOperationsKernel(store, this.evalCampaigns);
    this.enterpriseAccess = new EnterpriseAccessKernel(store);
    this.a2aDelegation = new A2ADelegationKernel(store);
    this.autonomousRuntime = new AutonomousRuntimeKernel(store);
    this.capabilityLifecycle = new CapabilityLifecycleKernel(store);
    this.memoryConsolidation = new MemoryConsolidationKernel(store);
    this.traceReviews = new TraceReviewKernel(store);
    this.memoryMaintenance = new MemoryMaintenanceKernel(store);
    this.maintenanceScheduler = new MaintenanceScheduler(store, this.memoryMaintenance);
    this.runtimeModelProbe = new RuntimeModelProbeKernel(store, this.modelProviders, modelTransport ?? null);
    this.mcpTasks = new McpTaskKernel(store);
    this.runtimeProof = new RuntimeProofKernel(store);
    this.evaluationContracts = new EvaluationContractKernel(store);
    this.contentMigration = new ContentMigrationKernel(store);
    this.remoteInterop = new RemoteInteropKernel(store);
    this.platformOperations = new PlatformOperationsKernel(store);
    this.metrics = new MetricsKernel(store);
    this.usage = new UsageKernel(store);
    this.intentCompiler = new IntentCompilerKernel(store);
    this.traceArchiveStorage = new TraceArchiveStorageKernel(store, traceArchiveBackends);
    this.trace = new TraceKernel(store, this.traceArchiveStorage);
    this.durableActionLoops = new DurableActionLoopKernel(store, this.trace);
    this.hostSessions = new HostSessionEventKernel(store, this.trace);
    this.outcomeObservers = new OutcomeObserverKernel(store, this.trace);
    this.runtimeTruth = new RuntimeTruthKernel(store);
    this.runtimeAttempts = new RuntimeExecutionAttemptKernel(store);
    this.osSecurity = new OsSecurityKernel(store);
    this.mcpRegistry = new McpRegistryKernel(store);
    this.a2aTransport = new A2ATransportKernel();
    this.remoteRuntime = new RemoteRuntimeKernel(store);
    this.supplyChainAttestations = new SupplyChainAttestationKernel(store);
    this.runtimeAcceptance = new RuntimeAcceptanceKernel(store);
    this.a2aV1 = new A2AV1AdapterKernel(store);
    this.orgSync = new OrgSyncKernel(store);
    this.projectBrain = capabilities.registry.require<ProjectBrainKernel>(KNOWLEDGE_KERNELS.projectBrain);
    this.workSessions = new WorkSessionKernel(store, this.projectBrain);
    this.workbenchExperience = new WorkbenchExperienceKernel(store);
    this.longTaskWorker = new LongTaskWorkerKernel(store);
    this.contextPlane = new ContextPlaneKernel(store);
    this.replayRunner = new ReplayRunnerKernel(store);
    this.localRuntimeService = new LocalRuntimeServiceKernel(store);
    this.procedureAutomation = new ProcedureAutomationKernel(store);
    this.projectBundles = new ProjectBundleKernel(store);
    this.knowledgeMemoryBundles = new KnowledgeMemoryBundleKernel(store);
    this.feedbackLearning = new FeedbackLearningKernel(store);
    this.domainEvaluators = new DomainEvaluatorKernel(store);
    this.handoffManifests = new HandoffManifestKernel(store);
    this.costLedger = new CostLedgerKernel(store);
    this.verifiedAutonomousWork = new VerifiedAutonomousWorkKernel(store);
    this.sandboxConformance = new SandboxConformanceKernel(store);
    this.traceExplorer = new TraceExplorerKernel(store);
    this.actionGateway = new ActionGatewayKernel(store, store.paths.root);
    this.acceptanceGates = new AcceptanceGateKernel(store);
    this.durableWorker = new DurableWorkerKernel(store);
    this.providerRouter = new ProviderRouterKernel(store);
    this.a2aProtocol = new A2AProtocolKernel();
    this.trustProfiles = new TrustProfileKernel(store);
    this.webOperations = new WebOperationKernel(store);
    this.workCoordinator = new WorkCoordinator(store, this.taskControl, this.taskRuns, this.verifiedWorkLoops,
      this.workDelivery, this.deliveryLoop, this.workSessions);
    this.runtimeCoordinator = new RuntimeCoordinator(store, this.actionGateway, this.durableWorker,
      this.providerRouter, this.runtimeTruth, this.runtimeAssurance, this.autonomousRuntime, this.localRuntimeService);
    this.evaluationCoordinator = new EvaluationCoordinator(store, this.evalCampaigns, this.evaluationOperations,
      this.acceptanceGates, this.domainEvaluators, this.evaluationModelProfiles, this.taskBenchmarks,
      this.campaignRunners, this.feedbackLearning, this.costLedger, this.providerRouter);
    this.workspaceCoordinator = new WorkspaceCoordinator(store, this.workspace, this.transaction, this.workbench,
      this.stateWorkspace, this.workspaceObserver, this.changeSets, this.projectBrain, this.lineage, this.hydration);
    this.hostRuns = new HostRunKernel(store, [...this.hostDrivers.values()], hostOwnerId,
      (run, receipt) => this.finalizeWorkLaunch(run, receipt), this.trace);
  }

  // Implemented by the public facade after the corresponding domain method exists.
  protected abstract finalizeWorkLaunch(run: JsonObject, receipt: JsonObject | null): void;

  /**
   * The bounded action surface the internal host may call.
   *
   * This is a whitelist on purpose: a self-hosted loop that can reach any Craft
   * operation would be a privilege escalation relative to the governed host
   * path. Abstract so the facade owns the list, exactly like finalizeWorkLaunch.
   */
  protected abstract invokeInternalAction(action: string, args: JsonObject): JsonObject | Promise<JsonObject>;

  /**
   * The action names the internal loop can actually dispatch.
   *
   * Abstract for the same reason as `invokeInternalAction`: without it a subclass
   * would silently advertise the whole tier-filtered catalog while only a handful
   * of actions resolved, and every attempt to use the rest would end the run. A
   * subclass must therefore state its real surface, and the loop mounts exactly
   * that.
   */
  protected abstract dispatchableInternalActions(): ReadonlySet<string>;
}
