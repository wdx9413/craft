import { Catalog } from "./catalog.ts";
import { CraftStore, type JsonObject } from "./store.ts";
import type { EmbeddingProvider } from "./semantic.ts";
import { LocalIsolatedAdapter } from "./isolated.ts";
import { WorkspaceState } from "./workspace.ts";
import { TransactionCoordinator } from "./transaction.ts";
import { TrajectoryCompiler } from "./trajectory.ts";
import { VerifiedScriptRunner } from "./script-run.ts";
import { WorkbenchKernel } from "./workbench.ts";
import { ChangeSetKernel } from "./changeset.ts";
import { ControlPlaneKernel } from "./control-plane.ts";
import { SecurityBrokerKernel } from "./security.ts";
import { DataOnlyParserAdapter } from "./untrusted-parser.ts";
import { ParserProcessAdapter } from "./parser-process.ts";
import { SandboxKernel } from "./sandbox.ts";
import { DockerSandboxAdapter } from "./docker-sandbox.ts";
import { TrustedEgressBroker } from "./egress.ts";
import { ExternalEffectKernel } from "./effects.ts";
import { RecoveryQueueKernel } from "./recovery.ts";
import { TriggerKernel } from "./trigger.ts";
import { SpeculativeKernel } from "./speculative.ts";
import { LineageKernel } from "./lineage.ts";
import { HydrationKernel } from "./hydration.ts";
import { AutonomyKernel } from "./autonomy.ts";
import { ContractInferenceKernel } from "./contracts.ts";
import { CapabilityCanaryKernel } from "./capability-canary.ts";
import { CapabilityFederationKernel } from "./federation.ts";
import { HubSyncKernel } from "./hub-sync.ts";
import { MaterializationKernel } from "./materialization.ts";
import { CapabilityCertificationKernel } from "./certification.ts";
import { SupplyChainKernel } from "./supply-chain.ts";
import { AttentionKernel } from "./attention.ts";
import { HomeKernel } from "./home.ts";
import { CodexHostKernel } from "./codex-driver.ts";
import { ClaudeHostKernel } from "./claude-driver.ts";
import { HostRunKernel } from "./host-run.ts";
import { KnowledgeBoundLaunchKernel } from "./knowledge-bound-launch.ts";
import { KnowledgeWorkbenchKernel } from "./knowledge-workbench.ts";
import { WikiCandidateGovernanceKernel } from "./wiki-candidate-governance.ts";
import { GuidedWorkKernel } from "./guided-work.ts";
import { ExecutionSafetyKernel } from "./execution-safety.ts";
import { LocalCandidateImportKernel } from "./local-candidate-import.ts";
import { A2ADiscoveryKernel } from "./a2a-discovery.ts";
import { WorkDeliveryKernel } from "./work-delivery.ts";

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
  readonly hostRuns: HostRunKernel;
  readonly knowledgeLaunch: KnowledgeBoundLaunchKernel;
  readonly knowledgeWorkbench: KnowledgeWorkbenchKernel;
  readonly wikiCandidateGovernance: WikiCandidateGovernanceKernel;
  readonly guidedWork: GuidedWorkKernel;
  readonly executionSafety: ExecutionSafetyKernel;
  readonly localCandidateImport: LocalCandidateImportKernel;
  readonly a2aDiscovery: A2ADiscoveryKernel;
  readonly workDelivery: WorkDeliveryKernel;

  constructor(store: CraftStore, semanticProvider?: EmbeddingProvider, isolatedAdapter = new LocalIsolatedAdapter(),
    dockerSandbox = new DockerSandboxAdapter(), egressBroker = new TrustedEgressBroker(), hostOwnerId?: string) {
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
    this.knowledgeLaunch = new KnowledgeBoundLaunchKernel(store);
    this.knowledgeWorkbench = new KnowledgeWorkbenchKernel(store);
    this.wikiCandidateGovernance = new WikiCandidateGovernanceKernel(store);
    this.guidedWork = new GuidedWorkKernel(store);
    this.executionSafety = new ExecutionSafetyKernel(store, this.sandbox);
    this.localCandidateImport = new LocalCandidateImportKernel(store);
    this.a2aDiscovery = new A2ADiscoveryKernel(store);
    this.workDelivery = new WorkDeliveryKernel(store);
    this.hostRuns = new HostRunKernel(store, [this.codexHost, this.claudeHost], hostOwnerId,
      (run, receipt) => this.finalizeWorkLaunch(run, receipt));
  }

  // Implemented by the public facade after the corresponding domain method exists.
  protected abstract finalizeWorkLaunch(run: JsonObject, receipt: JsonObject | null): void;
}
