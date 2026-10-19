Warning: truncated output (original token count: 107142)
Total output lines: 4481

import { ComponentTraceKernel } from "../component-trace.ts";
import { observeMethods } from "../../common/craft-common-log/src/index.ts";
import { createHash, randomUUID } from "node:crypto";
import { ContextHostEvaluation } from "../context-host-evaluation.ts";
import { assessKnowledgeEvaluationProvenance, knowledgeEvaluationEvidence } from "../knowledge-evaluation-provenance.ts";
import { procedureHostControl } from "./procedure-host-control.ts";
import { procedureDecisionEvaluate } from "./procedure-decision.ts";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { validateJsonSchema, type JsonValue } from "../json-schema.ts";
import { CraftStore, type JsonObject } from "../infrastructure/store.ts";
import { approvedEffects, executeSteps, normalizeSteps, resolveInputs, SIDE_EFFECTS, substitute } from "../workflow.ts";
import { addCosts, dispatchNodes, normalizeNodes, orchestrationOutcome, planStatus, recoverExpiredLeases, submitNode,
  type PlanNode } from "../orchestration.ts";
import { publishSkill, rollbackSkillPublication } from "../skill-publisher.ts";
import { loadConfig } from "../config.ts";
import { loadSettingsSync, publicSettings, resetSettingsSync, saveSettingsSync, type CraftSettingsPatch, type CraftModelConfig, type ModelProtocol } from "../settings.ts";
import { buildChatRequest, createFetchTransport, publicModel, specFromConfig, type ChatMessage } from "../model-gateway.ts";
import { hostProfilesFromConfig, resolveHostProfile } from "../host-registry.ts";
import { actionDigest, beginLoop, budgetBand, defineLoopLimits } from "../agent-loop.ts";
import { assetRef, defineAsset, routeAssets } from "../assets.ts";
import { compareAcrossModels, defineTrials } from "../model-independence.ts";
import { credentialStatus, publicProvider, selectModel, unconfiguredTransport } from "../model-gateway.ts";
import { OpenAiCompatibleEmbeddingProvider, type EmbeddingProvider } from "../semantic.ts";
import { discoverWorkflows, diffWorkflowCatalog, planWorkflowRetirement, type WorkflowUsage } from "../workflow-registry.ts";
import { classifyComplexity, createBudgetState, estimatePromptTokens, estimateTokens, routeModel, spendTokens, truncateToBudget } from "../token-budget.ts";
import { defaultHooks, defineHooks, runHooks, type HookSpec } from "../hooks.ts";
import { decideExecution } from "../execution-policy.ts";
import { assessMcpMigration, createCredentialResolver, distributionPlan, firstRunReadiness, isolationCapability, negotiateProtocolVersion, readCredentialFile } from "../distribution-and-first-run.ts";
import { Bm25Index, buildExperienceRecord, decideExperienceCapture, fuseRankings } from "../context-retrieval-capture.ts";
import { belongsToRetiredScenario } from "../../capability/craft-experience/procedure-release.ts";

import { evaluateVerificationCheck, runVerification, verificationCaptureSignals } from "../verification-sensor.ts";
import { abstractAcrossTrajectories, buildAbstraction, trajectoryFailureSignature } from "../trajectory-abstraction.ts";
import { attributeFailure, summarizeAttributions } from "../failure-attribution.ts";
import { checkConsistency, mcpDeclarations } from "../declaration-consistency.ts";
import {
  compactionPlan, defineConstraint, pinConstraints, verifyPinIntact
} from "../governance-pinning.ts";
import { discoverResult, forwardCompatibility } from "../mcp-forward-compat.ts";
import { discoverContextTools } from "../mcp/context-tools.ts";
import { dockerRequestDigest } from "../docker-sandbox.ts";
import { egressRequestDigest } from "../egress.ts";
import { ServiceFoundation } from "./service-foundation.ts";
import { ProcedureConfiguration } from "../../capability/craft-experience/procedure-configuration.ts";
import { ExperienceGraphAssets } from "../../capability/craft-experience/graph-assets.ts";
import { ComponentAssets } from "./coordinators/component-assets.ts";
import { ContextUsageWorkbench } from "./coordinators/context-usage.ts";
import { WorkflowDesignWorkbench } from "./coordinators/workflow-design.ts";
import { CognitiveWorkbenchCoordinator } from "./coordinators/cognitive-workbench.ts";
import { EvaluationRunCoordinator } from "./coordinators/evaluation-runs.ts";
import { CognitiveSearchCoordinator } from "./coordinators/cognitive-search.ts";
import { CognitiveWriteCoordinator } from "./coordinators/cognitive-write.ts";
import { workbenchWorkflowInput } from "./use-cases/workbench-workflow-input.ts";
import type { TraceArchiveRuntimeBackend } from "../trace-archive-storage.ts";
import { dataSpaceId } from "../data-space.ts";
import { classifyTool } from "../internal-tool-authorization.ts";
import { createActionHandlers } from "./actions/action-handlers.ts";
import { executeSubagent, planSubagentExecution } from "../subagent-execution.ts";
import { installAdapterRuntimeMethods } from "./use-cases/adapter-runtime.ts";
import { installKernelDelegateMethods } from "./use-cases/kernel-delegates.ts";
import { array, finiteInteger, object, text } from "../validation.ts";
import { canonicalJson, payload as recordPayload, stableDigest } from "../digest.ts";
import { CRAFT_RELEASE_VERSION } from "../version.ts";
import type { EvaluationContractInput, EvaluationStage } from "../evaluation-contract.ts";
import { WorkControl } from "./coordinators/work-control.ts";
import { ForgeDispatchCoordinator } from "./coordinators/forge-dispatch.ts";
import { scopeEnvelope, scopeFromKey } from "../scope-policy.ts";

export const VERSION = CRAFT_RELEASE_VERSION;
const CONFIDENCE = new Set(["confirmed", "bounded", "unverified", "rejected"]);
const TASK_STATUS = new Set(["active", "paused", "completed", "cancelled"]);
const TASK_PERMISSION_MODES = new Set(["human_approval", "assisted_approval", "full_access"]);
const VERSIONED_LIFECYCLE = new Set(["draft", "candidate", "verified", "deprecated"]);
const TRIAL_VERDICTS = new Set(["passed", "failed", "blocked", "cancelled"]);
const EVAL_SPLITS = new Set(["search", "development", "held_out"]);
const HARNESS_DIMENSIONS = new Set(["context", "tools", "generation", "orchestration", "memory", "output"]);
const GRADER_TYPES = new Set(["program", "model", "human", "operational"]);
const GRADE_VERDICTS = new Set(["passed", "failed", "inconclusive"]);
const EXPERT_TYPES = new Set(["diagnostic_research"]);
const ACCEPTANCE_METHODS = new Set(["program", "model", "human", "business_signal"]);
const ACCEPTANCE_RESULTS = new Set(["passed", "failed", "blocked"]);
const DOMAIN_FIELD_TYPES = new Set(["text", "path", "integer", "boolean", "choice"]);
const KNOWLEDGE_RELATIONS = new Set(["supports", "contradicts", "supersedes", "applies_to", "depends_on"]);

function id(prefix: string): string { return `${prefix}_${randomUUID().replaceAll("-", "")}`; }
function valueDigest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }

function document(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value;
}
function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}
function optionalText(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : text(value, name);
}
function firstDefined<T>(...values: (T | undefined)[]): T | undefined {
  return values.find((value) => value !== undefined);
}
function optionalScore(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  const score = Number(value);
  if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error(`${name} must be between 0 and 1`);
  return score;
}
function uniqueTextArray(value: unknown, name: string, minimum = 1): string[] {
  const values = array(value, name).map((item) => text(item, name));
  if (values.length < minimum || new Set(values).size !== values.length) {
    throw new Error(`${name} must contain at least ${minimum} unique values`);
  }
  return values;
}
function optionalTextArray(value: unknown, name: string, fallback: string[] = []): string[] {
  if (value === undefined) return fallback;
  const values = array(value, name).map((item) => text(item, name));
  if (new Set(values).size !== values.length) throw new Error(`${name} must contain unique values`);
  return values;
}
function budgetLimits(value: JsonObject): JsonObject {
  for (const [key, limit] of Object.entries(value)) {
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) {
      throw new Error(`budget limit ${key} must be a non-negative finite number`);
    }
  }
  return value;
}
function budgetExceeded(costs: JsonObject, budget: JsonObject): boolean {
  return Object.entries(budget).some(([key, limit]) => Number(costs[key] ?? 0) > Number(limit));
}
const SAFE_INCREMENTAL_STAGES = [
  { id: "baseline", constraints: "先检查 Git 增量并为原有逻辑补充或运行聚焦单元测试；不得先改业务逻辑。",
    evidence: ["git diff --check", "baseline focused test receipt"] },
  { id: "minimal_change", constraints: "只做满足目标的最小增量改动，保留既有接口、数据与未涉及路径。",
    evidence: ["changed files", "decision note"] },
  { id: "verification", constraints: "运行受影响测试、覆盖率门禁和必要静态检查；增量覆盖率阈值由已选 Workflow 的确定性命令计算。",
    evidence: ["test receipt", "coverage report"] },
  { id: "review", constraints: "复查 Git diff、失败类型和未验证风险；仅有真实证据的结论才能沉淀为经验。",
    evidence: ["git diff --check", "review evidence"] },
] as const;
const ROUTE_TERMINAL = new Set(["completed", "failed", "cancelled"]);
const ROUTE_RECEIPT_KINDS = new Set(["git_diff", "focused_test", "coverage", "static_check", "review"]);
const ROUTE_RECEIPT_STATUS = new Set(["passed", "failed", "skipped"]);
const HOST_OPERATIONS = new Set(["complete_stage", "execute_verified_workflow"]);
const RUNTIME_KINDS = new Set(["agent", "workflow", "grader", "computer_use"]);
const RUNTIME_ADAPTER_HOSTS = new Set(["codex", "claude", "generic"]);
const RUNTIME_RUN_TERMINAL = new Set(["completed", "failed", "cancelled"]);
const SECRET_ASSIGNMENT = /(?:api[_-]?key|authorization|cookie|password|secret|token)["']?\s*[:=]\s*[^\s]+/iu;
const DEFAULT_RECEIPT_REQUIREMENTS: JsonObject = {
  baseline: ["git_diff", "focused_test"], minimal_change: [],
  verification: ["focused_test", "coverage"], review: ["git_diff", "review"],
};

function receiptRequirements(value: unknown, name: string): JsonObject {
  const requirements = object(value ?? DEFAULT_RECEIPT_REQUIREMENTS, name);
  const normalized: JsonObject = {};
  for (const [stage, kinds] of Object.entries(requirements)) {
    if (!Object.hasOwn(DEFAULT_RECEIPT_REQUIREMENTS, stage)) throw new Error(`Unsupported receipt stage: ${stage}`);
    const values = array(kinds, `${name}.${stage}`).map((kind) => text(kind, `${name}.${stage}`));
    if (values.some((kind) => !ROUTE_RECEIPT_KINDS.has(kind)) || new Set(values).size !== values.length) {
      throw new Error(`${name}.${stage} must contain supported unique receipt kinds`);
    }
    normalized[stage] = values;
  }
  return Object.fromEntries(Object.keys(DEFAULT_RECEIPT_REQUIREMENTS).map((stage) => [stage, normalized[stage] ?? []]));
}

function assertNoSecret(value: string, name: string): string {
  if (SECRET_ASSIGNMENT.test(value)) throw new Error(`${name} must not contain sensitive assignments`);
  return value;
}

function fingerprint(value: JsonObject): string {
  // The same serialization every other kernel now shares, with a different public shape: bare
  // hex rather than a `sha256:`-prefixed value, and callers that want the prefix add it
  // themselves (`request_digest: \`sha256:${fingerprint(...)}\``). That difference is why this
  // is not `stableDigest` — merging it would change the shape of every fingerprint this facade
  // stores, and a stored fingerprint is an identity.
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function runtimeAuthorization(runId: string, operation: JsonObject): JsonObject {
  const kind = String(operation.kind); const effect = String(operation.effect);
  const action = kind === "computer_use" ? "computer_use" : ({ read_only: "read", local_write: "sandbox_write",
    external_write: "external_write", destructive: "destructive" } as Record<string, string>)[effect];
  const target = operation.target === undefined ? `runtime:${runId}:${String(operation.operation_id)}` : String(operation.target);
  return { autonomy_action: action, authorization_target: target,
    request_digest: `sha256:${fingerprint({ operation_id: operation.operation_id, kind, effect,
      objective: operation.objective, target, execution: operation.execution ?? null })}` };
}

function policyAllowsPath(value: string, prefixes: string[]): boolean {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) return false;
  return prefixes.some((prefix) => {
    const normalizedPrefix = prefix.replaceAll("\\", "/").replace(/^\.\//u, "");
    return normalizedPrefix === "." || normalized === normalizedPrefix || normalized.startsWith(`${normalizedPrefix}/`);
  });
}

function validIsoTime(value: unknown, name: string): number {
  const parsed = Date.parse(text(value, name));
  if (Number.isNaN(parsed)) throw new Error(`${name} must be an ISO timestamp`);
  return parsed;
}

function validateModelInput(args: JsonObject, id: string): CraftModelConfig {
  const name = text(args.name, "name");
  const protocol = (args.protocol === "anthropic" || args.protocol === "openai-compatible"
    ? args.protocol : "openai-compatible") as ModelProtocol;
  const baseUrl = text(args.baseUrl, "baseUrl").replace(/\/+$/, "");
  const model = text(args.model, "model");
  const apiKeyEnv = text(args.apiKeyEnv, "apiKeyEnv");
  const supportsTools = args.supportsTools === true;
  if (!/^https?:\/\//.test(baseUrl)) throw new Error("baseUrl must start with http:// or https://");
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(apiKeyEnv)) throw new Error("apiKeyEnv must be a valid environment variable name");
  return { id, name, protocol, baseUrl, model, apiKeyEnv, supportsTools };
}

export class CraftService extends ServiceFoundation {
  contextToolsDiscover(args: JsonObject): JsonObject { return discoverContextTools(args); }
  readonly workControl: WorkControl;
  readonly forgeDispatch: ForgeDispatchCoordinator;
  readonly cognitiveWorkbench: CognitiveWorkbenchCoordinator;
  readonly cognitiveWrites: CognitiveWriteCoordinator;
  readonly cognitiveSearch: CognitiveSearchCoordinator;
  readonly evaluationRuns: EvaluationRunCoordinator;

  constructor(store: CraftStore, semanticProvider?: EmbeddingProvider, isolatedAdapter?: unknown,
    dockerSandbox?: unknown, egressBroker?: unknown, hostOwnerId?: string, hostProfiles?: readonly import("../host-registry.ts").HostProfile[],
    modelProviders?: readonly import("../model-gateway.ts").ModelProviderSpec[],
    modelTransport?: import("../model-gateway.ts").ModelTransport, traceArchiveBackends?: readonly TraceArchiveRuntimeBackend[]) {
    super(store, semanticProvider, isolatedAdapter as never, dockerSandbox as never, egressBroker as never, hostOwnerId,
      hostProfiles, modelProviders, modelTransport, traceArchiveBackends);
    this.workControl = new WorkControl(store, {
      prepare: (args) => this.verifiedWorkLoopPrepareInternal(args),
      advance: (args) => this.verifiedWorkLoopAdvanceInternal(args),
      decide: (args) => this.verifiedWorkLoopDecideInternal(args),
      resume: (args) => this.verifiedWorkLoopResumeInternal(args),
      get: (args) => this.verifiedWorkLoopGetInternal(args),
    });
    this.evaluationRuns = new EvaluationRunCoordinator(store, args => this.workflowTrialRun(args), args => this.gradeRecord(args));
    this.forgeDispatch = new ForgeDispatchCoordinator(store);
    this.cognitiveSearch = new CognitiveSearchCoordinator(store, this.contextResolution, this.knowledgeRelations);
    this.cognitiveWrites = new CognitiveWriteCoordinator(store, this.knowledgeSources, this.memoryGovernance,
      (args) => this.evidenceRecord(args), (args) => this.knowledgeClaimReview(args));
    this.cognitiveWorkbench = new CognitiveWorkbenchCoordinator({
      store, resourceCatalog: (args) => this.workbenchResourceCatalogView(args),
      registerSource: (args) => this.knowledgeSourceRegister(args),
      proposeMemory: (args) => this.memoryCandidatePropose(args),
      recordEvidence: (args) => this.evidenceRecord(args), saveClaim: (args) => this.knowledgeClaimSave(args),
    });
    const calls = new ComponentTraceKernel(this.trace, "sdk");
    observeMethods(this, store, name => {
      const member = /^(knowledge|memory|experience|procedure|workflowEvolution|codebase|context)[A-Z]/u.exec(name)?.[1];
      return member === "procedure" || member === "workflowEvolution" ? "experience" : member ?? null;
    }, (component, operation, input, handler) => calls.run({ requestId: randomUUID(), component, operation, input: { args: input }, handler }));
  }

  procedureHostControl(args: JsonObject): JsonObject { return procedureHostControl(this, args); }
  procedureDecisionEvaluate(args: JsonObject): JsonObject { return procedureDecisionEvaluate(this, args); }
  procedureConfigurationSave(args: JsonObject): JsonObject { return new ProcedureConfiguration(this.store).save(args); }
  experienceGraphInspect(args: JsonObject): JsonObject {
    const graphs = new ExperienceGraphAssets(this.store);
    if (args.action === "evaluate_applicability") return new ContextHostEvaluation(this.store).evaluateGraphApplicability(args, input => graphs.inspect(input));
    return graphs.inspect(args);
  }
  experienceGraphEdit(args: JsonObject): JsonObject {
    const evaluation = new ContextHostEvaluation(this.store);
    if (args.action === "improvement_propose") return evaluation.proposeGraphImprovement(args);
    if (args.action === "improvement_save" || args.action === "improvement_submit") return evaluation.submitGraphImprovement({ ...args, action: args.action === "improvement_save" ? "save" : "submit" }, new ExperienceGraphAssets(this.store));
    return new ExperienceGraphAssets(this.store).edit(args);
  }
  componentAssetInspect(member: string, args: JsonObject): JsonObject { return new ComponentAssets(this.store).inspect(member, args); }
  componentAssetRestore(member: string, args: JsonObject): JsonObject { return new ComponentAssets(this.store).restore(member, args, {
    memory: a => this.memoryCandidatePropose({ ...a, proposal_only: true }), knowledge: a => this.knowledgeClaimSave(a), experience: a => this.procedureConfigurationSave(a), codebase: a => this.codebaseIndexBuild(a),
  }); }
  workbenchContextUsage(args: JsonObject): JsonObject { return new ContextUsageWorkbench(this.store).get(args); }
  workbenchContextRetire(args: JsonObject): JsonObject {
    return new ContextUsageWorkbench(this.store).retire(args, (member, id, version) => member === "memory"
      ? this.memoryLedgerTransition({ memory_id: id, expected_version: version, status: "revoked", reason: "Retired from scoped usage view" })
      : this.knowledgeClaimReview({ claim_id: id, status: "expired", reviewer: "studio-user", reason: "Retired from scoped usage view" }));
  }
  workbenchWorkflowDesignSave(args: JsonObject): JsonObject { return new WorkflowDesignWorkbench(this.store).save(args); }
  workbenchWorkflowDesignGet(args: JsonObject): JsonObject { return new WorkflowDesignWorkbench(this.store).get(args); }
  workbenchWorkflowDesignList(args: JsonObject): JsonObject { return new WorkflowDesignWorkbench(this.store).list(args); }
  workbenchResourceView(args: JsonObject = {}): JsonObject { return this.cognitiveWorkbench.resources(args); }
  workbenchMemorySave(args: JsonObject): JsonObject { return this.cognitiveWorkbench.saveMemory(args); }
  workbenchMemoryReview(args: JsonObject): JsonObject { return this.memoryCandidateReview(args); }
  /**
   * Capture an explicit user-authored memory without turning the whole chat into
   * durable storage. The user statement becomes bounded Evidence; automatic
   * acceptance is available only because the user explicitly requested recall.
   */
  memoryCaptureUserStatement(args: JsonObject): JsonObject { return this.cognitiveWrites.captureUserStatement(args); }
  /** Internal Host Hook path for bounded, automatically classified stable facts. */
  memoryCaptureObservedFact(args: JsonObject): JsonObject { return this.cognitiveWrites.captureObservedFact(args); }
  workbenchKnowledgeClaimSave(args: JsonObject): JsonObject { return this.cognitiveWorkbench.saveClaim(args); }
  workbenchWorkflowSave(args: JsonObject): JsonObject { return this.workflowDagSave(workbenchWorkflowInput(args)); }
  knowledgeExpirySweep(args: JsonObject = {}): JsonObject { return this.cognitiveWrites.sweepExpiredClaims(args); }
  knowledgeConflictResolve(args: JsonObject): JsonObject { return this.cognitiveWrites.resolveClaimConflict(args); }

  /** Application dispatch belongs to the use cases, never to a mounted transport. */
  private canonicalHandlers: Record<string, (input: JsonObject) => JsonObject | Promise<JsonObject>> | null = null;

  /** Compatibility injection for existing application callers; MCP does not mutate it. */
  registerCanonicalHandlers(handlers: Record<string, (input: JsonObject) => JsonObject | Promise<JsonObject>>): void {
    this.canonicalHandlers = handlers;
  }

  /**
   * The operations the internal host may invoke.
   *
   * Two gates, both fail-closed. The first is the *tier gate*: the action's
   * canonical tool name is classified (read / candidate / governed / forbidden)
   * and must be inside the tiers this host mounted -- by default read and
   * candidate, so "Craft works on its own" can observe and propose but cannot
   * approve its own work. The second is dispatch: the action is resolved
   * against the application handler table, plus the existing bounded local
   * aliases. Mounting a transport grants no additional authorization.
   */
  protected async invokeInternalAction(action: string, args: JsonObject): Promise<JsonObject> {
    const tier = classifyTool(`craft_${action}`);
    if (!this.internalHost.authorization.includes(tier)) {
      throw new Error(`Internal host action is not permitted: ${action} (tier ${tier} is outside the mounted authorization)`);
    }
    this.canonicalHandlers ??= createActionHandlers(this);
    const canonicalHandler = this.canonicalHandlers[`craft_${action}`];
    if (canonicalHandler) return canonicalHandler(args);
    const handler = this.internalFallbackActions()[action];
    if (!handler) throw new Error(`Internal host action is not permitted: ${action} (not a known operation)`);
    return handler(args);
  }

  /**
   * The stable bounded surface advertised to the internal loop.
   *
   * This is the read-and-record core the internal host was originally built
   * around; local workspace aliases remain here. Application dispatch is
   * available independently of transports, without widening advertised authority.
   */
  private internalFallbackActions(): Record<string, (input: JsonObject) => JsonObject | Promise<JsonObject>> {
    return {
      capability_search: (input) => this.capabilitySearch(input),
      knowledge_search: (input) => this.knowledgeSearch(input),
      knowledge_scenario_list: (input) => this.knowledgeScenarioList(input),
      // v0.12.35: the read half of memory access, plus a candidate-only write.
      // `memory_capture_propose` deliberately routes to the governed candidate
      // path rather than the ledger write, so a loop tool call cannot create a
      // durable memory on its own. The key must equal the canonical action name,
      // because that name is what the loop is offered: an alias here is a tool
      // the model can see and never reach.
      memory_search: (input) => this.memorySearch(input),
      memory_capture_propose: (input) => this.knowledgeMemoryCandidatePropose(input),
      // v0.12.36: the loop verifies its own work here. Both are pure
      // comparisons over facts the caller already observed, so they execute
      // nothing and grant no new authority.
      verification_evaluate: (input) => this.verificationRun(input),
      verification_capture_signals_get: (input) => this.verificationCaptureSignals(input),
      // The loop may look across past trajectories to see recurrence; it may
      // not mint an abstraction, which stays governed.
      abstraction_evaluate: (input) => this.abstractionEvaluate(input),
      // The loop names the cause of its own failure, but never invents one:
      // `unattributed` is returned rather than guessed.
      failure_attribution_get: (input) => this.failureAttributionGet(input),
      // The loop checks a claim against the implementation instead of assuming
      // the declaration is true.
      consistency_check: (input) => this.consistencyCheck(input),
      // The loop verifies its own guardrail but cannot author one.
      governance_pin_check: (input) => this.governancePinCheck(input),
      task_checkpoint: (input) => this.taskCheckpoint(input),
      evidence_record: (input) => this.evidenceRecord(input),
      artifact_register: (input) => this.artifactRegister(input),
      workspace_read: async (input) => {
        const prepared = this.actionGatewayPrepare({ action_id: `internal-read-${valueDigest(input).slice(7, 23)}`, task_id: text(input.task_id, "task_id"), workspace: text(input.workspace, "workspace"), operation: "workspace_read", effect: "read_only", input_digest: valueDigest(input) });
        return this.actionGatewayExecute({ action_id: (prepared.action as JsonObject).id, relative_path: text(input.relative_path, "relative_path") });
      },
      workspace_write: async (input) => {
        const prepared = this.actionGatewayPrepare({ action_id: `internal-write-${valueDigest(input).slice(7, 23)}`, task_id: text(input.task_id, "task_id"), workspace: text(input.workspace, "workspace"), operation: "workspace_write", effect: "local_write", input_digest: valueDigest(input), ...(input.approval_ref === undefined ? {} : { approval_ref: input.approval_ref }) });
        return this.actionGatewayExecute({ action_id: (prepared.action as JsonObject).id, relative_path: text(input.relative_path, "relative_path"), content: text(input.content, "content"), approved: input.approved === true });
      },
    };
  }

  /**
   * Preserve the standalone loop's minimal advertised surface. Every offered
   * action routes through the application table/local aliases; mounting MCP or
   * Workbench cannot inflate model input or alter this selection policy.
   */
  protected dispatchableInternalActions(): ReadonlySet<string> {
    const names = new Set(Object.keys(this.internalFallbackActions()));
    return names;
  }

  modelProviderList(): JsonObject {
    return { count: this.modelProviders.length,
      configured: this.modelProviders.filter((spec) => credentialStatus(spec).configured).length,
      providers: this.modelProviders.map((spec) => publicProvider(spec)) };
  }

  modelProviderGet(args: JsonObject): JsonObject {
    const provider = text(args.provider, "provider");
    const spec = this.modelProviders.find((item) => item.provider === provider);
    if (!spec) throw new Error(`Unknown model provider: ${provider}`);
    const tier = args.tier === undefined ? undefined : String(args.tier) as import("../model-gateway.ts").ModelTier;
    return { provider: publicProvider(spec),
      ...(tier === undefined ? {} : { selection: selectModel(spec, tier) }),
      transport_installed: this.internalHost.transport !== unconfiguredTransport };
  }

  evaluationModelProfileSave(args: JsonObject): JsonObject { return this.evaluationModelProfiles.save(args); }
  evaluationModelProfileEnsureSingle(args: JsonObject): JsonObject {
    const purpose = text(args.purpose, "purpose");
    this.evaluationModelTicketList({ purpose, limit: 1 }); // Reuse the profile kernel's canonical purpose validator before any setup work.
    const active = (this.evaluationModelProfileList({ limit: 1_000 }).profiles as JsonObject[])
      .filter(profile => profile.lifecycle === "active" && Array.isArray(profile.purposes) && (profile.purposes as unknown[]).includes(purpose));
    if (process.env.CRAFT_LEARNING_MODEL_HOST === "codex-cli") {
      const codexProfiles = active.filter(profile => profile.provider === "codex-cli");
      if (codexProfiles.length > 1) return { status: "ambiguous", reason: "multiple_active_profiles_for_purpose", profile_count: codexProfiles.length, profile: null };
      if (codexProfiles.length === 1) {
        const profile = codexProfiles[0]!;
        return { status: (profile.readiness as JsonObject | undefined)?.status ?? "unavailable", profile, idempotent: true };
      }
      const profileId = `evaluation_model_profile_auto_codex_${stableDigest({ purpose, model: "gpt-6-luna" }).slice(-16)}`;
      const created = this.evaluationModelProfileSave({ profile_id: profileId, provider: "codex-cli", model: "gpt-6-luna", purposes: [purpose],
        network_execution_enabled: true, max_attempts: 1, max_output_tokens: 2_048 });
      const profile = created.profile as JsonObject;
      return { status: (created.readiness as JsonObject | undefined)?.status ?? "unavailable", profile, idempotent: created.idempotent === true };
    }
    if (active.length > 1) return { status: "ambiguous", reason: "multiple_active_profiles_for_purpose", profile_count: active.length, profile: null };
    if (active.length === 1) {
      const profile = active[0]!;
      return { status: (profile.readiness as JsonObject | undefined)?.status ?? "unavailable", profile, idempotent: true };
    }
    const configured = this.modelList().models as JsonObject[];
    if (configured.length !== 1) return { status: "unavailable", reason: configured.length ? "multiple_models_require_explicit_profile" : "no_configured_model", profile: null };
    const model = configured[0]!;
    const modelIdentity = { provider: model.id, model: model.model, base_url: model.baseUrl, api_key_env: model.apiKeyEnv };
    const profileId = `evaluation_model_profile_auto_${stableDigest({ purpose, model: modelIdentity }).slice(-24)}`;
    const created = this.evaluationModelProfileSave({ profile_id: profileId, provider: model.id, model: model.model, purposes: [purpose],
      network_execution_enabled: true, max_attempts: 1, max_output_tokens: 2_048 });
    const profile = created.profile as JsonObject;
    return { status: (created.readiness as JsonObject | undefined)?.status ?? "unavailable", profile, idempotent: created.idempotent === true };
  }
  evaluationModelProfileGet(args: JsonObject): JsonObject { return this.evaluationModelProfiles.get(args); }
  evaluationModelProfileList(args: JsonObject): JsonObject { return this.evaluationModelProfiles.list(args); }
  evaluationModelTicketIssue(args: JsonObject): JsonObject { return this.evaluationModelProfiles.issue(args); }
  evaluationModelTicketList(args: JsonObject): JsonObject { return this.evaluationModelProfiles.ticketList(args); }
  evaluationModelTicketComplete(args: JsonObject): JsonObject { return this.evaluationModelProfiles.ticketComplete(args); }

  workflowEvolutionObserve(args: JsonObject): JsonObject { return this.workflowEvolution.observe(args); }
  workflowEvolutionPropose(args: JsonObject): JsonObject { return this.workflowEvolution.propose(args); }
  workflowEvolutionObservations(args: JsonObject): JsonObject { return this.workflowEvolution.observations(args); }
  workflowEvolutionProposalGet(args: JsonObject): JsonObject { return this.workflowEvolution.get(args); }
  workflowEvolutionProposalSubmit(args: JsonObject): JsonObject {
    const request = this.store.get("workflow_evolution_request", String(args.request_id));
    const signature = request.scenario_signature as JsonObject | undefined;
    const project = signature?.project as JsonObject | undefined;
    const projectId = typeof project?.id === "string" ? project.id.replace(/^project:/u, "") : "";
    if (projectId && typeof signature?.scenario_key === "string"
      && belongsToRetiredScenario(this.store, { scope: `project:${projectId}`, scenario_signature: signature })) {
      throw new Error("Experience scenario is retired; proposal submission is blocked");
    }
    const procedureKind = String(request.procedure_kind ?? "workflow");
    const firstObservation = (request.observation_refs as JsonObject[] | undefined)?.[0];
    const source = firstObservation?.source as JsonObject | undefined;
    const scope = typeof source?.scope === "string" ? source.scope : "project:unresolved";
    const scenarioProcedureId = String(args.procedure_id ?? `experience_procedure_${stableDigest({ scope, procedure_kind: procedureKind, scenario_signature: request.scenario_signature }).slice(-20)}`);
    const revisionArgs = { procedure_id: scenarioProcedureId, evolve: true };
    // Validate a graph before it becomes a proposal record.  This is deliberately an asset
    // validation, not execution: a valid graph still needs the existing evaluation, Signoff
    // and Canary gates before Core may route it to the VerifiedWorkLoop.
    if (procedureKind === "graph" && args.graph_control === undefined) this.workflowDagValidate({ nodes: args.nodes, edges: args.edges ?? [], inputs: args.inputs ?? [], outputs: args.outputs ?? {}, checkpoint_policy: args.checkpoint_policy ?? { mode: "step" } });
    const submitted = this.workflowEvolution.submit(args); const proposal = submitted.proposal as JsonObject;
    const nextAction = "Run shadow and held-out evaluation, then use the existing Signoff and Canary gates before this Procedure can be selected.";
    if (proposal.composition !== undefined || (proposal.graph as JsonObject | null)?.graph_control !== undefined) {
      const procedure = this.experienceProcedures.draft({ proposal_id: proposal.id, ...revisionArgs });
      return { ...submitted, workflow: null, procedure: procedure.procedure, next_action: nextAction };
    }
    if (procedureKind === "prompt") {
      const procedure = this.experienceProcedures.draft({ proposal_id: proposal.id, ...revisionArgs, procedure_kind: "prompt", title: proposal.name,
        description: proposal.prompt ?? proposal.description, trigger: args.trigger ?? request.scenario_key,
        acceptance_ref: args.acceptance_ref ?? request.output_contract_ref, evidence_ids: args.evidence_ids ?? (request.observation_refs as JsonObject[]).flatMap((item) => item.evidence_ids as string[]) });
      return { ...submitted, procedure: procedure.procedure, next_action: nextAction };
    }
    if (submitted.idempotent === true) {
      const kind = String(proposal.procedure_kind ?? "workflow") === "graph" ? "workflow_dag" : "workflow";
      const procedure = this.experienceProcedures.draft({ proposal_id: proposal.id, ...revisionArgs, procedure_kind: proposal.procedure_kind,
        title: proposal.name, description: proposal.description, trigger: args.trigger ?? request.scenario_key,
        acceptance_ref: args.acceptance_ref ?? request.output_contract_ref, evidence_ids: args.evidence_ids ?? (request.observation_refs as JsonObject[]).flatMap((item) => item.evidence_ids as string[]) });
      return { ...submitted, workflow: this.store.get(kind, String(proposal.workflow_id)), procedure: procedure.procedure, next_action: nextAction };
    }
    const derivedFrom = { workflow_evolution_proposal_id: proposal.id, workflow_evolution_proposal_version: proposal.version,
      request_id: proposal.request_id, request_version: proposal.request_version, model_ticket_id: proposal.model_ticket_id,
      replaces_workflow: proposal.replaces_workflow, design_axes: this.store.get("workflow_evolution_request", String(proposal.request_id), Number(proposal.request_version)).design_axes };
    const workflow = procedureKind === "graph"
      ? (this.workflowDagSave({ workflow_id: proposal.workflow_id, name: proposal.name, description: proposal.description,
        nodes: (proposal.graph as JsonObject).nodes, edges: (proposal.graph as JsonObject).edges, inputs: proposal.inputs,
        outputs: (proposal.graph as JsonObject).outputs, checkpoint_policy: (proposal.graph as JsonObject).checkpoint_policy, derived_from: derivedFrom }).workflow as JsonObject)
      : this.workflowSave({ workflow_id: proposal.workflow_id, name: proposal.name, description: proposal.description,
        inputs: (proposal.inputs as unknown[]).map(input => typeof input === "string" ? { name: input, required: true } : input), steps: proposal.steps, derived_from: derivedFrom });
    const procedure = this.experienceProcedures.draft({ proposal_id: proposal.id, ...revisionArgs, procedure_kind: proposal.procedure_kind,
      title: proposal.name, description: proposal.description, trigger: args.trigger ?? request.scenario_key,
      acceptance_ref: args.acceptance_ref ?? request.output_contract_ref, evidence_ids: args.evidence_ids ?? (request.observation_refs as JsonObject[]).flatMap((item) => item.evidence_ids as string[]) });
    return { ...submitted, workflow, procedure: procedure.procedure, next_action: nextAction };
  }

  /** Where the circuit breakers would sit for a given plan, without running anything. */
  agentLoopPlan(args: JsonObject): JsonObject {
    const limits = defineLoopLimits((args.limits ?? {}) as JsonObject);
    const state = beginLoop(0);
    return { limits, band: budgetBand(state, limits), action_digest_example: actionDigest("capability_search", { query: "x" }),
      guards: ["step_limit", "token_limit", "wall_clock", "no_progress", "repeated_action", "budget_fuse"] };
  }

  /** Route one task to the smallest credible set of declared assets. Read-only: it selects, it does not activate. */
  assetRoute(args: JsonObject): JsonObject {
    const assets = Array.isArray(args.assets) ? args.assets.map((item) => defineAsset(item as JsonObject)) : [];
    // A missing declaration is a mistake, not an empty catalog.
    if (!Array.isArray(args.assets)) throw new Error("asset_route requires an assets array");
    const signals = args.signals as import("../assets.ts").TaskSignals;
    const decision = routeAssets(signals, assets);
    return { ...decision, selected: decision.selected.map((asset) => ({ ...asset, ref: assetRef(asset) })),
      baseline: decision.baseline ? assetRef(decision.baseline) : null };
  }

  /** Compare one subject's trials across models; a single model is reported inconclusive rather than passed. */
  modelIndependenceCompare(args: JsonObject): JsonObject {
    const trials = defineTrials(args.trials);
    const invariants = Array.isArray(args.invariants) ? args.invariants.map((item) => String(item)) : [];
    if (!Array.isArray(args.invariants)) throw new Error("model_independence_compare requires an invariants array");
    return { ...compareAcrossModels(trials, invariants) };
  }

  /** Record bounded evidence for a scoped trust recommendation. It never grants authority. */
  trustProfileRecord(args: JsonObject): JsonObject { return this.trustProfiles.record(args); }
  trustProfileRecommend(args: JsonObject): JsonObject { return this.trustProfiles.recommend(args); }
  trustProfileRevoke(args: JsonObject): JsonObject { return this.trustProfiles.revoke(args); }
  trustProfileList(args: JsonObject): JsonObject { return this.trustProfiles.list(args); }
  trustProfileGet(args: JsonObject): JsonObject { return this.trustProfiles.get(args); }

  async webFetch(args: JsonObject, fetchImpl?: typeof globalThis.fetch): Promise<JsonObject> { return this.webOperations.fetch(args, fetchImpl); }
  webActionPrepare(args: JsonObject): JsonObject { return this.webOperations.prepare(args); }
  webActionComplete(args: JsonObject): JsonObject { return this.webOperations.complete(args); }
  webOperationGet(args: JsonObject): JsonObject { return this.webOperations.get(args); }

  static async open(store: CraftStore, hostOwnerId?: string): Promise<CraftService> {
    const config = await loadConfig(store.paths);
    const semanticProvider = config?.semanticSearch ? new OpenAiCompatibleEmbeddingProvider(config.semanticSearch.provider) : undefined;
    const declared = hostProfilesFromConfig(config?.hostProfiles);
    const service = new CraftService(store, semanticProvider, undefined, undefined, undefined, hostOwnerId, declared);
    try { service.trace.maintain(); } catch { /* Call capture reports telemetry failures without blocking business work. */ }
    return service;
  }

  info(): JsonObject {
    const kinds = ["source", "capability", "task", "checkpoint", "feedback", "artifact",
      "evidence", "workflow", "workflow_run", "evaluation_suite", "evaluation_run",
      "evaluation_comparison",
      "agent_profile", "orchestration_plan", "harness_configuration", "trial", "outcome",
      "grader", "grade", "signoff_policy", "signoff", "experience_pattern", "skill_proposal",
      "skill_publication", "budget", "model_provider", "agent_session", "route", "route_strategy",
      "project_policy", "route_receipt", "host_adapter", "host_dispatch", "runtime_policy", "runtime_run",
      "runtime_operation", "runtime_adapter", "evaluation_runner", "evaluation_promotion", "experience_mining_candidate",
      "experience_shadow_experiment", "adaptive_harness", "agent_ir", "operational_signal", "operational_alert",
      "capability_asset", "activation_profile", "tool_selection_receipt", "capability_call", "capability_connector", "capability_connector_asset", "capability_connector_ticket", "capability_connector_health", "capability_connector_revocation", "logical_activation_plan", "logical_activation_audit", "logical_activation_resolution", "expert_profile", "context_capsule",
      "evaluation_reliability", "judge_adapter", "judge_calibration", "adaptation_candidate", "feedback_intake", "feedback_case", "canary",
      "capability_kit", "capability_kit_activation", "capability_kit_contribution", "capability_kit_conformance", "knowledge_source", "memory_ledger", "memory_compat_binding", "context_resolution_receipt", "retrieval_adapter", "retrieval_evaluation", "work_runtime_mode", "work_runtime_plan",
      "uncertainty_policy", "uncertainty_resolution", "adjudication", "reference_pilot", "release_qualification", "release_qualification_slot",
      "workspace", "workspace_checkpoint", "workspace_change", "workspace_transaction", "work_object", "memory_item", "memory_policy", "memory_usage_signal", "memory_maintenance_run", "memory_maintenance_candidate", "context_profile", "task_graph", "change_set", "os_security_plan", "os_security_receipt", "mcp_registry_source", "mcp_registry_server", "mcp_registry_health", "org_sync_manifest", "trace_otlp_export", "trace_review",
      "budget_account", "budget_reservation", "durable_wait", "external_event", "fallback_contract", "fallback_event",
      "credential_handle", "credential_lease", "egress_authorization", "egress_execution", "parser_security_evaluation", "parser_process_receipt", "mcp_task", "runtime_manifest", "runtime_probe", "runtime_conformance", "runtime_attestation",
      "sandbox_profile", "sandbox_assessment", "sandbox_ticket", "sandbox_receipt", "sandbox_egress_binding",
      "external_effect", "external_effect_receipt", "effect_compensation", "effect_reconciliation", "effect_saga", "recovery_item",
      "trigger_subscription", "trigger_event", "speculative_policy", "speculative_candidate", "preference_signal", "lineage_edge", "dehydration_snapshot",
      "autonomy_policy", "autonomy_request", "autonomy_consumption", "trace_policy", "trace_archive", "trace_archive_storage", "trace_archive_storage_active",
      "contract_observation", "contract_candidate", "task_intent", "acceptance_contract",
      "contract_publication",
      "capability_canary", "capability_canary_sample",
      "capability_bundle", "capability_release", "capability_subscription",
      "hub_source", "hub_catalog_entry", "hub_sync_receipt",
      "capability_materialization",
      "capability_certification",
      "supply_chain_advisory",
      "maintenance_status",
      "maintenance_tick",
      "maintenance_component", "maintenance_failure", "attention_item", "work_launch", "work_delivery", "delivery_loop", "delivery_evaluation_case", "delivery_evaluation_comparison", "delivery_evaluation_run", "platform_execution_profile", "platform_execution_preflight", "platform_execution_probe", "platform_execution_conformance", "task_run", "task_run_state", "task_run_handoff", "task_benchmark", "task_benchmark_pair", "task_benchmark_canary_sample", "state_snapshot", "verified_work_loop", "verified_work_loop_receipt", "verified_work_loop_decision", "human_state_event", "work_loop_invalidation", "eval_campaign", "eval_campaign_slot", "eval_campaign_report", "managed_write_guard", "managed_write_settlement", "adaptive_harness_recommendation", "project_knowledge_discovery", "project_knowledge_resolution", "project_knowledge_proposal", "acceptance_plan", "acceptance_check", "acceptance_assessment", "acceptance_evaluator", "acceptance_evaluation_job", "verified_iteration", "iteration_attempt", "strategy_recommendation", "runtime_assurance_attestation", "runtime_intervention", "runtime_assurance_campaign",
      "trajectory_script_proposal", "verified_script_run", "knowledge_claim", "wiki_page", "knowledge_relation", "wiki_context_bundle", "wiki_skill_candidate", "knowledge_evaluation_case", "knowledge_evaluation_run", "wiki_candidate_evaluation_attestation", "wiki_candidate_publication_authorization", "wiki_candidate_publication_package", "guided_work_brief", "execution_safety_preflight", "wiki_candidate_local_import", "autonomy_ladder_decision", "workspace_observation", "work_coordinator", "agent_eval_lab", "agent_eval_attempt", "evaluation_program", "evaluation_program_run", "enterprise_identity_provider", "enterprise_principal", "enterprise_adapter_binding", "enterprise_access_ticket", "a2a_agent_trust", "a2a_collaboration_session", "a2a_delegation", "a2a_delegation_receipt", "federated_agent_health", "federated_delegation_grant", "federated_artifact_grant", "federated_remote_receipt", "federated_remote_incident", "harness_topology", "harness_topology_selection", "runtime_readiness_assessment", "sealed_evaluation_case", "sealed_evaluation_access", "runtime_recovery_drill", "assured_work_pilot", "project_brain", "project_goal", "project_decision", "project_material", "project_outcome", "project_experience", "work_session", "long_task_checkpoint", "trust_profile", "web_operation", "web_operation_receipt"];
    kinds.push("untrusted_content", "untrusted_extraction", "decision_projection");
    return { version: VERSION, data_root: this.store.paths.root,
      // Components compare this content-free identity before assuming they
      // share one local ledger. It identifies only the configured data space.
      data_space_id: dataSpaceId(this.store.paths.root),
      counts: Object.fromEntries(kinds.map((kind) => [kind, this.store.count(kind)])) };
  }

  sourceAdd(args: JsonObject): Promise<JsonObject> {
    const label = args.label === undefined ? undefined : text(args.label, "label");
    return this.catalog.addSource(text(args.path, "path"), label,
      optionalBoolean(args.scan, "scan") ?? true, args.priority === undefined ? 0 : finiteInteger(args.priority, "priority", 0, -1000, 1000));
  }
  sourceList(): JsonObject { return { sources: this.catalog.listSources() }; }
  logicalCapabilityList(): JsonObject { return { capabilities: this.catalog.listLogicalCapabilities() }; }
  sourceUpdate(args: JsonObject): JsonObject {
    return this.catalog.updateSource(text(args.source_id, "source_id"),
      optionalBoolean(args.enabled, "enabled"), args.label === undefined ? undefined : text(args.label, "label"), args.priority === undefined ? undefined : finiteInteger(args.priority, "priority", 0, -1000, 1000));
  }
  sourceRemove(args: JsonObject): JsonObject {
    return this.catalog.removeSource(text(args.source_id, "source_id"));
  }
  sourceScan(args: JsonObject): Promise<JsonObject> {
    return this.catalog.scan(args.source_id === undefined ? undefined : text(args.source_id, "source_id"));
  }
  async capabilitySearch(args: JsonObject): Promise<JsonObject> {
    return { capabilities: await this.catalog.searchHybrid(text(args.query, "query"), finiteInteger(args.limit, "limit", 6, 1, 20)),
      semantic_search: this.catalog.semanticStatus() };
  }
  logicalActivationPlan(args: JsonObject): Promise<JsonObject> { return this.capabilityAccess.logicalActivationPlan(args); }
  logicalActivationAudit(args: JsonObject): JsonObject { return this.capabilityAccess.logicalActivationAudit(args); }
  logicalActivationResolve(args: JsonObject): Promise<JsonObject> { return this.capabilityAccess.logicalActivationResolve(args); }
  semanticSearchStatus(): JsonObject { return this.catalog.semanticStatus(); }
  executionPolicyDecide(args: JsonObject): JsonObject { return decideExecution(args); }
  // v0.12.33: first-run readiness, credential resolution, protocol negotiation,
  // honest platform isolation reporting and the user-facing download plan.
  firstRunReadiness(args: JsonObject): JsonObject {
    // "Right now" means the real environment, not an echo: the caller may
    // override, but omitting the inputs must not report "no models" when the
    // process or settings actually have them. The gateway reads settings the same
    // way the rest of the service does, so the answer reflects this install.
    const models = Array.isArray(args.models) && args.models.length
      ? args.models as JsonObject[]
      : loadSettingsSync(this.store.paths).models.map((model) => model as unknown as JsonObject);
    const env = args.env && typeof args.env === "object" && Object.keys(args.env as object).length
      ? args.env as NodeJS.ProcessEnv
      : process.env;
    return firstRunReadiness({ ...args, models, env });
  }
  credentialResolve(args: JsonObject): JsonObject {
    const sources: NodeJS.ProcessEnv[] = [process.env];
    // A desktop launcher writes the pasted key to a file and points here, so the
    // user never has to touch the process environment themselves.
    if (typeof args.credential_file === "string") {
      const overlay = readCredentialFile(args.credential_file);
      if (!overlay.found) throw new Error(`Credential file ${String(overlay.path)} does not exist`);
      sources.push(overlay.env as NodeJS.ProcessEnv);
    }
    if (args.env && typeof args.env === "object") sources.push(args.env as NodeJS.ProcessEnv);
    const resolved = createCredentialResolver(sources).env;
    return { names: Object.keys(resolved).filter((name) => resolved[name]).sort(), credential_source: args.credential_file ? "desktop_launcher" : "process_environment" };
  }
  mcpProtocolNegotiate(args: JsonObject): JsonObject { return negotiateProtocolVersion(args.protocolVersion); }
  mcpMigrationAssess(args: JsonObject): JsonObject { return assessMcpMigration(args); }
  isolationCapabilityGet(args: JsonObject): JsonObject { return isolationCapability(String(args.platform ?? process.platform)); }
  distributionPlanGet(args: JsonObject): JsonObject {
    return distributionPlan({ version: VERSION, repository: "wdx9413/craft", release_assets_available: args.release_assets_available === true });
  }
  // v0.12.34: the three ideal-state gaps. Reversible context projection (so a
  // dropped segment can come back), BM25 over identifier-heavy records, and a
  // deterministic experience-capture gate that does not depend on the model
  // choosing to call a memory tool.
  // The projection is durable now, so an omitted segment really can come back in a later call. The
  // two methods used to build a throwaway `ReversibleContext` from the arguments on every call,
  // which is why `restore` needed the original segments re-supplied and why the tool's own promise
  // ("omitted segments are named and can be restored") could not be kept.
  contextProject(args: JsonObject): JsonObject { return this.contextProjection.project(args); }
  contextRestore(args: JsonObject): JsonObject { return this.contextProjection.restore(args); }
  contextProjectionGet(args: JsonObject): JsonObject { return this.contextProjection.get(args); }
  /**
   * The unified `state` view.
   *
   * A read of five records with one precedence, so a caller asking "where is this task" gets an
   * answer instead of an assembly. It writes nothing: the status is derived, so there is no second
   * source of truth to drift.
   */
  stateViewGet(args: JsonObject): JsonObject { return this.stateView.get(args); }
  bm25Search(args: JsonObject): JsonObject {
    const index = new Bm25Index();
    for (const item of (args.documents as JsonObject[] | undefined) ?? []) {
      index.add(String(item.id), String(item.value));
    }
    const ranked = index.score(String(args.query));
    return {
      results: ranked.map((item, position) => ({ ...item, rank: position + 1 })),
      count: ranked.length,
      indexed: index.size,
    };
  }
  retrievalFuse(args: JsonObject): JsonObject {
    const rankings = ((args.rankings as JsonObject[][] | undefined) ?? []).map((ranking) =>
      ranking.map((item) => ({ id: String(item.id) })));
    const fused = fuseRankings(rankings, args.k === undefined ? 60 : Number(args.k));
    return { fused, count: fused.length };
  }
  experienceCaptureDecide(args: JsonObject): JsonObject { return decideExperienceCapture(args) as unknown as JsonObject; }
  experienceCaptureBuild(args: JsonObject): JsonObject { return buildExperienceRecord(args); }
  // v0.12.36: the deterministic verification sensor. It produces the failure
  // signal the self-evolution loop consumes, so a lesson can be learned from an
  // observed result instead of from an `outcome` the caller supplied.
  verificationCheck(args: JsonObject): JsonObject { return evaluateVerificationCheck(args) as unknown as JsonObject; }
  verificationRun(args: JsonObject): JsonObject { return runVerification(args); }
  verificationCaptureSignals(args: JsonObject): JsonObject { return verificationCaptureSignals(args); }
  // v0.12.37: cross-trajectory abstraction. This is the Experience stage the
  // per-run capture path never reached — it reads across many trajectories and
  // generalises only when recurrence is demonstrated.
  // Wrapped in an object rather than returned bare: an MCP handler must answer
  // with an object, and the signature is clearer next to its inputs.
  trajectorySignatureGet(args: JsonObject): JsonObject {
    return { signature: trajectoryFailureSignature(args), failed_checks: [...new Set(((args.failed_checks as unknown[] | undefined) ?? []).map(String))].sort() };
  }
  abstractionEvaluate(args: JsonObject): JsonObject { return abstractAcrossTrajectories(args); }
  // v0.12.40: governance pinning. The loop may check its own guardrail and
  // simulate compaction; defining a constraint stays governed, because a guard
  // the loop can redefine is not a guard.
  governancePinGet(args: JsonObject): JsonObject { return pinConstraints((args.constraints as JsonObject[]) ?? []); }
  governancePinCheck(args: JsonObject): JsonObject { return verifyPinIntact(args); }
  governanceCompactionEvaluate(args: JsonObject): JsonObject { return compactionPlan(args); }
  governanceConstraintDefine(args: JsonObject): JsonObject { return defineConstraint(args); }
  // v0.12.41: MCP 2026-07-28 forward compatibility. Reporting readiness is read;
  // it never claims compliance.
  mcpDiscoverGet(args: JsonObject): JsonObject { return discoverResult(args); }
  mcpForwardCompatGet(args: JsonObject): JsonObject { return forwardCompatibility(args); }
  abstractionBuild(args: JsonObject): JsonObject { return buildAbstraction(args); }
  // v0.12.39: declaration/implementation consistency. Declarations are data, so
  // the comparison is mechanical rather than a matter of care.
  consistencyCheck(args: JsonObject): JsonObject { return checkConsistency(args); }
  mcpDeclarationsGet(): JsonObject { return { declarations: mcpDeclarations() }; }
  // v0.12.38: failure attribution. V1 produces the observations; this names the
  // cause, so a lesson can be checked against the layer it claims.
  failureAttributionGet(args: JsonObject): JsonObject { return attributeFailure(args); }
  failureAttributionSummaryGet(args: JsonObject): JsonObject { return summarizeAttributions(args); }
  // v0.12.35: the memory read path, decay weighting, capture policy, legacy
  // promotion planning, hybrid (vector+keyword) memory scoring, and the usage
  // evidence that makes "the agent did better because it remembered" checkable.
  memoryDecayWeightGet(args: JsonObject): JsonObject {
    // Wrapped rather than returned bare: an MCP handler must answer with an
    // object, and the weight is more useful alongside the inputs it came from.
    return { weight: this.memorySignals.decayWeight(args), confirmed_at: String(args.confirmed_at), now: String(args.now) };
  }
  memoryProposePolicy(args: JsonObject): JsonObject { return this.memorySignals.shouldPropose(args); }
  memoryLegacyPromote(args: JsonObject): JsonObject { return this.memorySignals.planLegacyPromotion(args); }
  memoryHybridScores(args: JsonObject): JsonObject {
    const candidates = ((args.candidates as JsonObject[] | undefined) ?? []).map((item) => ({
      id: String(item.id),
      similarity: item.similarity === null || item.similarity === undefined ? null : Number(item.similarity),
      keyword_score: Number(item.keyword_score ?? 0)
    }));
    const results = this.memorySignals.hybridScores(candidates, {
      vectorEligible: args.vector_eligible === true,
      ...(args.k === undefined ? {} : { k: Number(args.k) })
    });
    return { results, count: results.length, vector_eligible: args.vector_eligible === true };
  }
  memoryUsageEvidenceRecord(args: JsonObject): JsonObject { return this.memorySignals.usageEvidence(args); }

  /**
   * The loop's candidate-only memory write.
   *
   * A loop tool call must not be able to create a durable memory, so this
   * records a *turn proposal* carrying a memory candidate and stops there. The
   * candidate still has to pass `candidateDecide` before anything reaches the
   * ledger, which keeps the governance identical to a host-initiated proposal
   * while letting the agent ask for something to be remembered.
   */
  knowledgeMemoryCandidatePropose(args: JsonObject): JsonObject {
    const source = this.store.get("knowledge_source", text(args.source_id ?? "craft.internal", "source_id"));
    const kind = text(args.kind, "kind");
    const content = text(args.content, "content");
    // Content is validated before scope: a proposal carrying a credential must
    // be refused for that reason, not for a missing scope field, or the caller
    // would learn the wrong thing about why it was rejected.
    assertNoSecret(content, "content");
    const scope = text(args.scope, "scope");
    // A craft_agent proposal must name the active Agent Work Runtime mode, so
    // the gate in proposalSubmit is a real precondition rather than a lookup
    // that can never succeed. The caller may pin one explicitly.
    const activeMode = args.work_runtime_mode_id === undefined
      ? this.store.list("work_runtime_mode", 100).find((profile) => profile.mode === "agent" && profile.status === "active")
      : this.store.get("work_runtime_mode", text(args.work_runtime_mode_id, "work_runtime_mode_id"));
    if (!activeMode) throw new Error("Memory proposal requires an active Agent Work Runtime mode");
    const proposal = this.turnCognitive.proposalSubmit({
      scope_kind: scope,
      scope_id: text(args.scope_id ?? "internal", "scope_id"),
      semantic_owner: "craft_agent",
      work_runtime_mode_id: String(activeMode.id),
      input_digest: valueDigest({ content, kind, scope }),
      // `learning` is the intent that covers "something worth remembering"; the
      // candidate itself is what carries the content.
      intents: ["learning"],
      signals: ["durable_value"],
      memory_candidate: { source_id: String(source.id), kind, content, sensitivity: args.sensitivity ?? "internal" }
    });
    const recorded = proposal.proposal as JsonObject;
    return {
      proposal_id: recorded.id,
      kind,
      scope,
      // Stated explicitly so a caller cannot mistake this for a durable write.
      durable: false,
      requires_approval: true,
      execution_authority: false
    };
  }
  capabilityGet(args: JsonObject): JsonObject {
    return this.catalog.get(text(args.asset_id, "asset_id"));
  }

  capabilityAssetSave(args: JsonObject): JsonObject { return this.capabilityAccess.assetSave(args); }
  capabilityAccessPlan(args: JsonObject): JsonObject { return this.capabilityAccess.accessPlan(args); }
  capabilityCallIssue(args: JsonObject): JsonObject { return this.capabilityAccess.callIssue(args); }
  capabilityCallConsume(args: JsonObject): JsonObject { return this.capabilityAccess.callConsume(args); }

  capabilityConnectorRegister(args: JsonObject): JsonObject { return this.capabilityConnectors.register(args); }
  capabilityConnectorDiscover(args: JsonObject): JsonObject { return this.capabilityConnectors.discover(args); }
  capabilityConnectorUpdate(args: JsonObject): JsonObject { return this.capabilityConnectors.update(args); }
  capabilityConnectorHealthRecord(args: JsonObject): JsonObject { return this.capabilityConnectors.healthRecord(args); }
  capabilityConnectorRevoke(args: JsonObject): JsonObject { return this.capabilityConnectors.revoke(args); }
  capabilityConnectorApprove(args: JsonObject): JsonObject { return this.capabilityConnectors.approve(args); }
  capabilityConnectorList(args: JsonObject): JsonObject { return this.capabilityConnectors.list(args); }
  capabilityConnectorTicketIssue(args: JsonObject): JsonObject { return this.capabilityConnectors.ticketIssue(args); }
  capabilityConnectorTicketConsume(args: JsonObject): JsonObject { return this.capabilityConnectors.ticketConsume(args); }

  capabilityKitInstall(args: JsonObject): JsonObject { return this.capabilityKits.install(args); }
  capabilityKitInstallBuiltins(): JsonObject { return this.capabilityKits.installBuiltins(); }
  capabilityKitGet(args: JsonObject): JsonObject { return this.capabilityKits.get(args); }
  capabilityKitList(args: JsonObject): JsonObject { return this.capabilityKits.list(args); }
  capabilityKitActivate(args: JsonObject): JsonObject { return this.capabilityKits.activate(args); }
  capabilityKitContributionRecord(args: JsonObject): JsonObject { return this.capabilityKits.contributionRecord(args); }
  capabilityKitSetState(args: JsonObject): JsonObject { return this.capabilityKits.setState(args); }
  capabilityKitConformance(args: JsonObject): JsonObject { return this.capabilityKits.conformance(args); }
  capabilityKitDistribution(args: JsonObject): JsonObject { return this.capabilityKits.distribution(args); }
  workRuntimeModeConfigure(args: JsonObject): JsonObject { return this.workRuntimeModes.configure(args); }
  workRuntimeModePrepare(args: JsonObject): JsonObject { return this.workRuntimeModes.prepare(args); }
  workRuntimeModeGet(args: JsonObject): JsonObject { return this.workRuntimeModes.get(args); }
  continualHarnessViewCreate(args: JsonObject): JsonObject { return this.continualHarness.viewCreate(args); }
  continualHarnessRefine(args: JsonObject): JsonObject { return this.continualHarness.refine(args); }
  continualHarnessSubmit(args: JsonObject): JsonObject { return this.continualHarness.submit(args); }
  continualHarnessShadow(args: JsonObject): JsonObject { return this.continualHarness.shadow(args); }
  continualHarnessAuthorizeCanary(args: JsonObject): JsonObject { return this.continualHarness.authorizeCanary(args); }
  continualHarnessObserveCanary(args: JsonObject): JsonObject { return this.continualHarness.observeCanary(args); }
  continualHarnessRollback(args: JsonObject): JsonObject { return this.continualHarness.rollback(args); }
  continualHarnessSignals(args: JsonObject): JsonObject { return this.continualHarness.signals(args); }
  continualHarnessResolve(args: JsonObject): JsonObject { return this.continualHarness.resolve(args); }
  continualHarnessGet(args: JsonObject): JsonObject { return this.continualHarness.get(args); }
  statefulComputeHostRegister(args: JsonObject): JsonObject { return this.statefulCompute.hostRegister(args); }
  statefulComputeSessionPrepare(args: JsonObject): JsonObject { return this.statefulCompute.sessionPrepare(args); }
  statefulComputeDispatch(args: JsonObject): JsonObject { return this.statefulCompute.dispatch(args); }
  statefulComputeObserve(args: JsonObject): JsonObject { return this.statefulCompute.observe(args); }
  statefulComputeDelegate(args: JsonObject): JsonObject { return this.statefulCompute.delegate(args); }
  statefulComputeReport(args: JsonObject): JsonObject { return this.statefulCompute.report(args); }
  statefulComputeCancel(args: JsonObject): JsonObject { return this.statefulCompute.cancel(args); }
  statefulComputeSessionGet(args: JsonObject): JsonObject { return this.statefulCompute.sessionGet(args); }
  uncertaintyPolicySave(args: JsonObject): JsonObject { return this.uncertaintyPolicies.save(args); }
  uncertaintyResolve(args: JsonObject): JsonObject { return this.uncertaintyPolicies.resolve(args); }
  uncertaintyAdjudicate(args: JsonObject): JsonObject { return this.uncertaintyPolicies.adjudicate(args); }
  /** Decide which interaction level an action earns; L1 requires a deterministic independent checker. */
  actionGateDecide(args: JsonObject): JsonObject { return this.actionGate.decide(args); }
  actionGateRecordApproval(args: JsonObject): JsonObject { return this.actionGate.recordApproval(args); }
  actionGateAcceptProposal(args: JsonObject): JsonObject { return this.actionGate.acceptProposal(args); }
  actionGateRuleGet(args: JsonObject): JsonObject { return this.actionGate.getRule(args); }
  actionGateRuleList(args: JsonObject): JsonObject { return this.actionGate.listRules(args); }
  /** Authorization (plan 11.4): acknowledge is "I saw it", authorize is "I grant this effect". */
  authorizationAcknowledge(args: JsonObject): JsonObject { return this.authorization.acknowledge(args); }
  authorizationAuthorize(args: JsonObject): JsonObject { return this.authorization.authorize(args); }
  authorizationCheck(args: JsonObject): JsonObject { return this.authorization.check(args); }
  authorizationConsume(args: JsonObject): JsonObject { return this.authorization.consume(args); }
  authorizationRevoke(args: JsonObject): JsonObject { return this.authorization.revoke(args); }
  authorizationGet(args: JsonObject): JsonObject { return this.authorization.get(args); }
  authorizationList(args: JsonObject): JsonObject { return this.authorization.list(args); }
  authorizationTrail(args: JsonObject): JsonObject { return this.authorization.trail(args); }
  /** The object rail read model behind the plan's three-column screen (plan 8 / 15.3). */
  objectRailView(args: JsonObject): JsonObject { return this.objectRail.view(args); }
  /** The phone projection: one decision, no rail (plan 12). */
  objectMobileProjection(args: JsonObject): JsonObject { return this.objectRail.mobileProjection(args); }
  objectReceipts(args: JsonObject): JsonObject {
    // One endpoint serves both the right column and a single receipt's recomputation path,
    // because they are the same question at two levels of detail (10.1).
    if (args.receipt_id !== undefined && args.metric !== undefined) return this.receipts.trend(args);
    if (args.receipt_id !== undefined) return this.objectRail.receiptDetail(args);
    return this.objectRail.evidence(args);
  }
  objectAuthorize(args: JsonObject): JsonObject { return this.authorization.authorize(args); }
  objectAcknowledge(args: JsonObject): JsonObject { return this.authorization.acknowledge(args); }
  /**
   * L3: express one intention and hatch one object, then close the session (plan 5.3).
   *
   * The session is opened and closed inside this call rather than exposed as two steps,
   * because a session left open is exactly the free-expression area that would be used for
   * a second turn. The caller supplies a session id only so a retry is idempotent.
   */
  objectHatch(args: JsonObject): JsonObject {
    const sessionId = text(args.session_id, "session_id");
    this.objectHatching.openSession({ session_id: sessionId, opened_at: text(args.hatched_at, "hatched_at") });
    const hatched = this.objectHatching.hatch(args);
    return { ...hatched, session_closed: true, conversation_turns_allowed: 0 };
  }
  objectRequestFields(args: JsonObject): JsonObject { return this.objectHatching.requestFields(args); }
  objectCompleteFields(args: JsonObject): JsonObject { return this.objectHatching.complete(args); }
  /** Subscription as authorization (plan 7.1): explicit, time-boxed, auditable, revocable. */
  subscriptionAuthorize(args: JsonObject): JsonObject { return this.subscriptionAuthorizations.authorize(args); }
  subscriptionCheck(args: JsonObject): JsonObject { return this.subscriptionAuthorizations.check(args); }
  subscriptionReconfirm(args: JsonObject): JsonObject { return this.subscriptionAuthorizations.reconfirm(args); }
  subscriptionRecordDispatch(args: JsonObject): JsonObject { return this.subscriptionAuthorizations.recordDispatch(args); }
  subscriptionRevoke(args: JsonObject): JsonObject { return this.subscriptionAuthorizations.revoke(args); }
  subscriptionAudit(args: JsonObject): JsonObject { return this.subscriptionAuthorizations.audit(args); }
  subscriptionAuthorizationGet(args: JsonObject): JsonObject { return this.subscriptionAuthorizations.get(args); }
  subscriptionAuthorizationList(args: JsonObject): JsonObject { return this.subscriptionAuthorizations.list(args); }
  subscriptionSweep(args: JsonObject): JsonObject { return this.subscriptionAuthorizations.sweep(args); }
  /** The generative decision surface (plan 9): the card's shape follows the decision type. */
  decisionSurfaceCompose(args: JsonObject): JsonObject { return this.decisionSurface.compose(args); }
  decisionSurfaceShapes(args: JsonObject): JsonObject { return this.decisionSurface.shapes(); }
  decisionSurfaceGet(args: JsonObject): JsonObject { return this.decisionSurface.get(args); }
  decisionSurfaceDiscard(args: JsonObject): JsonObject { return this.decisionSurface.discard(args); }
  /** The capability base (plan 13): one Action shape, plus the GUI-fallback debt 13A.7 tracks. */
  capabilityBaseRegister(args: JsonObject): JsonObject { return this.capabilityBase.register(args); }
  capabilityBaseCheckAccess(args: JsonObject): JsonObject { return this.capabilityBase.checkAccess(args); }
  capabilityBaseReplaceAdapter(args: JsonObject): JsonObject { return this.capabilityBase.replaceAdapter(args); }
  capabilityBaseDebt(args: JsonObject): JsonObject { return this.capabilityBase.debt(args); }
  capabilityBaseGet(args: JsonObject): JsonObject { return this.capabilityBase.get(args); }
  capabilityBaseList(args: JsonObject): JsonObject { return this.capabilityBase.list(args); }
  capabilityBaseProject(args: JsonObject): JsonObject { return this.capabilityBase.project(args); }
  /** Browser driving (plan 13A): the three-level formula, VLM ban and script hygiene. */
  browserDrivingSiteRegister(args: JsonObject): JsonObject { return this.browserDriving.registerSite(args); }
  browserDrivingScriptRegister(args: JsonObject): JsonObject { return this.browserDriving.registerScript(args); }
  browserDrivingAdjudicate(args: JsonObject): JsonObject { return this.browserDriving.adjudicate(args); }
  browserDrivingRecordReceipt(args: JsonObject): JsonObject { return this.browserDriving.recordReceipt(args); }
  browserDrivingSurface(args: JsonObject): JsonObject { return this.browserDriving.surface(args); }
  browserDrivingReceipts(args: JsonObject): JsonObject { return this.browserDriving.receipts(args); }
  /** Windows desktop UIA (not a generic command runner): explicit target, control and action contracts. */
  windowsDesktopApplicationRegister(args: JsonObject): JsonObject { return this.windowsDesktopAutomation.registerApplication(args); }
  windowsDesktopControlRegister(args: JsonObject): JsonObject { return this.windowsDesktopAutomation.registerControl(args); }
  windowsDesktopActionRegister(args: JsonObject): JsonObject { return this.windowsDesktopAutomation.registerAction(args); }
  windowsDesktopAdjudicate(args: JsonObject): JsonObject { return this.windowsDesktopAutomation.adjudicate(args); }
  windowsDesktopPrepare(args: JsonObject): JsonObject { return this.windowsDesktopAutomation.prepareExecution(args); }
  windowsDesktopReceiptRecord(args: JsonObject): JsonObject { return this.windowsDesktopAutomation.recordReceipt(args); }
  windowsDesktopSurface(args: JsonObject): JsonObject { return this.windowsDesktopAutomation.surface(args); }
  /** Windows screenshot/OCR fallback: observations and exact-match clicks only, always human-released. */
  windowsDesktopVisionSessionBegin(args: JsonObject): JsonObject { return this.windowsDesktopVision.beginSession(args); }
  windowsDesktopVisionObservationRecord(args: JsonObject): JsonObject { return this.windowsDesktopVision.recordObservation(args); }
  windowsDesktopVisionClickPrepare(args: JsonObject): JsonObject { return this.windowsDesktopVision.prepareClick(args); }
  windowsDesktopVisionReceiptRecord(args: JsonObject): JsonObject { return this.windowsDesktopVision.recordReceipt(args); }
  windowsDesktopVisionSurface(args: JsonObject): JsonObject { return this.windowsDesktopVision.surface(args); }
  /** Honest claims (plan 4.4/4.6/11.3): three-way routing, paired L1 report, ledger wording. */
  claimRoute(args: JsonObject): JsonObject { return this.honestClaims.route(args); }
  claimRecord(args: JsonObject): JsonObject { return this.honestClaims.record(args); }
  claimL1Report(args: JsonObject): JsonObject { return this.honestClaims.l1Report(args); }
  claimLedgerWording(args: JsonObject): JsonObject { return this.honestClaims.ledgerWording(args); }
  /** The object model (plan 5.1/5.2): nine fields, a machine-checkable state, decision write-back. */
  objectKindDefine(args: JsonObject): JsonObject { return this.objectModel.defineKind(args); }
  objectCreate(args: JsonObject): JsonObject { return this.objectModel.create(args); }
  objectGet(args: JsonObject): JsonObject { return this.objectModel.get(args); }
  objectList(args: JsonObject): JsonObject { return this.objectModel.list(args); }
  objectStateCheck(args: JsonObject): JsonObject { return this.objectModel.checkState(args); }
  objectTransition(args: JsonObject): JsonObject { return this.objectModel.transition(args); }
  objectRecordDecision(args: JsonObject): JsonObject { return this.objectModel.recordDecision(args); }
  objectHistory(args: JsonObject): JsonObject { return this.objectModel.historyOf(args); }
  objectCompleteness(args: JsonObject): JsonObject { return this.objectModel.completeness(args); }
  /** The core metric (plan 3.1/3.3): touchpoints per object, always paired with wall-clock. */
  humanTouchpointRecord(args: JsonObject): JsonObject { return this.humanTouchpoints.record(args); }
  humanTouchpointObjectReport(args: JsonObject): JsonObject { return this.humanTouchpoints.objectReport(args); }
  humanTouchpointReport(args: JsonObject): JsonObject { return this.humanTouchpoints.report(args); }
  /** Evidence receipt (plan 10–11.5): recomputable, two-observation, provenance-marked. */
  receiptIssue(args: JsonObject): JsonObject { return this.receipts.issue(args); }
  receiptGet(args: JsonObject): JsonObject { return this.receipts.get(args); }
  receiptList(args: JsonObject): JsonObject { return this.receipts.list(args); }
  receiptAssess(args: JsonObject): JsonObject { return this.receipts.assess(args); }
  receiptTrend(args: JsonObject): JsonObject { return this.receipts.trend(args); }
  receiptRemediation(args: JsonObject): JsonObject { return this.receipts.remediation(args); }
  /** Subscription drift (plan 7.2–7.4): structure fingerprint vs event dedup key. */
  subscriptionDriftRegister(args: JsonObject): JsonObject { return this.subscriptionDrift.register(args); }
  subscriptionDriftCheck(args: JsonObject): JsonObject { return this.subscriptionDrift.checkDrift(args); }
  subscriptionDriftIngest(args: JsonObject): JsonObject { return this.subscriptionDrift.ingest(args); }
  subscriptionDriftReactivate(args: JsonObject): JsonObject { return this.subscriptionDrift.reactivate(args); }
  subscriptionDriftSweep(args: JsonObject): JsonObject { return this.subscriptionDrift.sweep(args); }
  subscriptionDriftGet(args: JsonObject): JsonObject { return this.subscriptionDrift.get(args); }
  subscriptionDriftList(args: JsonObject): JsonObject { return this.subscriptionDrift.list(args); }
  /** Prepared state (plan 13A.3.2–3.3): what a person approved, re-verified at release. */
  preparedStatePrepare(args: JsonObject): JsonObject { return this.preparedStates.prepare(args); }
  preparedStateGet(args: JsonObject): JsonObject { return this.preparedStates.get(args); }
  preparedStateRelease(args: JsonObject): JsonObject { return this.preparedStates.release(args); }
  /** Adjudication concurrency (plan 6.4): one focused card; a batch keeps N authorizations. */
  adjudicationEnqueue(args: JsonObject): JsonObject { return this.adjudicationQueue.enqueue(args); }
  adjudicationView(args: JsonObject): JsonObject { return this.adjudicationQueue.view(args); }
  adjudicationResolve(args: JsonObject): JsonObject { return this.adjudicationQueue.resolve(args); }
  adjudicationAuthorizations(args: JsonObject): JsonObject { return this.adjudicationQueue.authorizations(args); }
  /** Object hatching (plan 5.3): free expression creates one object and closes. */
  hatchSessionOpen(args: JsonObject): JsonObject { return this.objectHatching.openSession(args); }
  hatchSessionGet(args: JsonObject): JsonObject { return this.objectHatching.getSession(args); }
  hatchObject(args: JsonObject): JsonObject { return this.objectHatching.hatch(args); }
  hatchObjectGet(args: JsonObject): JsonObject { return this.objectHatching.getObject(args); }
  hatchObjectList(args: JsonObject): JsonObject { return this.objectHatching.list(args); }
  hatchFieldsRequest(args: JsonObject): JsonObject { return this.objectHatching.requestFields(args); }
  hatchFieldsComplete(args: JsonObject): JsonObject { return this.objectHatching.complete(args); }
  referencePilotSave(args: JsonObject): JsonObject { return this.releaseQualifications.pilotSave(args); }
  releaseQualificationPlan(args: JsonObject): JsonObject { return this.releaseQualifications.plan(args); }
  releaseQualificationRecord(args: JsonObject): JsonObject { return this.releaseQualifications.record(args); }
  releaseQualificationEvaluate(args: JsonObject): JsonObject { return this.releaseQualifications.evaluate(args); }
  platformIdealStateAssess(args: JsonObject): JsonObject { return this.releaseQualifications.platformAssess(args); }
  verificationPlan(args: JsonObject): JsonObject { return this.verificationPlane.plan(args); }
  verificationReceiptRecord(args: JsonObject): JsonObject { return this.verificationPlane.record(args); }
  verificationAssess(args: JsonObject): JsonObject { return this.verificationPlane.assess(args); }
  verificationGet(args: J…67142 tokens truncated…his.store.find("outcome", `outcome_${launch.trial_id}`)) { this.settleManagedWrite(run); this.finishFabricHostBridge(run); return; }
    const artifact = this.artifactRegister({ artifact_id: `artifact_${run.id}`, kind: "host_run_receipt", name: `Host run ${run.id}`, uri: receipt?.uri ?? `craft://host-run/${run.id}`, digest: receipt?.digest ?? null, producer_type: "host_run", producer_id: run.id, metadata: { host: run.host, dispatch_id: run.dispatch_id, receipt_id: run.receipt_id ?? null } });
    const confidence = run.status === "interrupted" ? "bounded" : "confirmed"; const evidence = this.evidenceRecord({ evidence_id: `evidence_${run.id}`, source_type: "program", confidence, claim: `Host execution ended with status ${run.status}.`, artifact_id: artifact.id, locator: `host-run:${run.id}`, observed_at: run.finished_at });
    const started = Date.parse(String(run.started_at)); const finished = Date.parse(String(run.finished_at)); const durationMs = Math.max(0, finished - started); const verdict = run.status === "completed" ? "passed" : run.status === "cancelled" ? "cancelled" : run.status === "interrupted" ? "blocked" : "failed";
    this.trialTraceAppend({ trial_id: launch.trial_id, event_type: `work_launch.${run.status}`, source: "craft_runtime", data: { launch_id: launch.id, run_id: run.id, receipt_id: run.receipt_id ?? null, duration_ms: durationMs }, artifact_ids: [artifact.id], evidence_ids: [evidence.id] });
    const costs: JsonObject = { duration_ms: durationMs }; if (typeof receipt?.cost_usd === "number") costs.cost_usd = receipt.cost_usd; if (receipt?.usage && typeof receipt.usage === "object" && !Array.isArray(receipt.usage)) costs.usage = receipt.usage;
    this.outcomeRecord({ trial_id: launch.trial_id, verdict, summary: `Host execution ${run.status}.`, failure_type: verdict === "passed" ? undefined : run.error_class ?? `host_${run.status}`, scores: { host_execution_success: verdict === "passed" ? 1 : 0 }, costs, evidence_ids: [evidence.id], source: "program_verified", ...(launch.knowledge_binding === undefined ? {} : { knowledge_binding: launch.knowledge_binding }) }); this.deliveryLoop.refresh({ launch_id: launch.id }); this.refreshTaskControlForLaunch(launch.id); this.refreshTaskRunForLaunch(launch.id); this.settleManagedWrite(run); this.finishFabricHostBridge(run);
  }
  private settleManagedWrite(run: JsonObject): void { try { const settled = this.managedWrites.settleForRun(run); if (settled) this.store.appendEvent(`host-run:${run.id}`, "managed_write.settled", { guard_id: (settled.guard as JsonObject).id, status: (settled.guard as JsonObject).status }); } catch (error) { this.store.appendEvent(`host-run:${run.id}`, "managed_write.settlement_failed", { error_class: error instanceof Error ? error.name : "UnknownError" }); } }
  private finishFabricHostBridge(run: JsonObject): void {
    for (const invocation of this.store.list("host_bridge_invocation", 10_000, (item) => item.run_id === run.id)) {
      try {
        const finished = this.hostBridge.finish({ invocation_id: invocation.id, run_id: run.id }).invocation as JsonObject;
        const advanced = this.executionFabricAdvance({ fabric_id: finished.fabric_id, activation_receipt_id: finished.activation_receipt_id });
        const coordinator = this.store.list("work_coordinator", 2, (item) => item.fabric_id === finished.fabric_id)[0] ?? null; const loop = advanced.work_loop as JsonObject; const receipt = loop.receipt as JsonObject;
        if (coordinator) this.workCoordinatorObserve({ coordinator_id: coordinator.id, task_run_state_id: receipt.task_run_state_id, snapshot_id: receipt.snapshot_id, work_loop_receipt_id: receipt.id });
        this.store.appendEvent(`execution-fabric:${finished.fabric_id}`, "fabric.host_observed", { invocation_id: finished.id, run_id: run.id, advance_id: (advanced.advance as JsonObject).id, status: run.status });
      } catch (error) {
        this.store.appendEvent(`host-run:${run.id}`, "fabric.projection_failed", { error_class: error instanceof Error ? error.name : "UnknownError" });
      }
    }
  }
  private refreshTaskControlForLaunch(launchId: unknown): void { for (const contract of this.store.list("task_control_contract", 10_000, (item) => item.launch_id === launchId)) this.taskControl.refresh({ contract_id: contract.id }); }
  private refreshTaskRunForLaunch(launchId: unknown): void { for (const taskRun of this.store.list("task_run", 10_000, (item) => item.launch_id === launchId)) this.taskRuns.refresh({ task_run_id: taskRun.id }); }
  private effectTrace(effect: JsonObject, eventType: string): void {
    if (effect.trial_id) this.trialTraceAppend({ trial_id: effect.trial_id, event_type: eventType, source: "craft",
      data: { effect_id: effect.id, status: effect.status, remote_operation_id: effect.remote_operation_id ?? null } });
  }
  untrustedContentRegister(args: JsonObject): JsonObject { return this.security.contentRegister(args); }
  untrustedExtractionRecord(args: JsonObject): JsonObject { return this.security.extractionRecord(args); }
  decisionProjectionRelease(args: JsonObject): JsonObject { return this.security.projectionRelease(args); }
  decisionProjectionExplain(args: JsonObject): JsonObject { return this.security.projectionExplain(args); }
  untrustedContentParse(args: JsonObject): JsonObject { return this.dataOnlyParser.parse(args); }
  parserSecurityEvaluate(args: JsonObject): JsonObject { return this.dataOnlyParser.evaluate(args); }
  untrustedContentParseProcess(args: JsonObject): Promise<JsonObject> { return this.parserProcess.parse(args); }
  sandboxProfileSave(args: JsonObject): JsonObject { return this.sandbox.profileSave(args); }
  sandboxProfileVerify(args: JsonObject): JsonObject { return this.sandbox.profileVerify(args); }
  sandboxPlan(args: JsonObject): JsonObject { return this.sandbox.plan(args); }
  sandboxReceipt(args: JsonObject): JsonObject { return this.sandbox.receipt(args); }
  dockerSandboxRequestDigest(args: JsonObject): JsonObject {
    return { request_digest: dockerRequestDigest(text(args.image, "image"),
      array(args.argv, "argv").map((item) => text(item, "argv"))) };
  }
  async dockerSandboxProbe(args: JsonObject): Promise<JsonObject> {
    const profile = this.store.get("sandbox_profile", text(args.profile_id, "profile_id"), finiteInteger(args.profile_version, "profile_version", 0));
    if (profile.lifecycle !== "declared" || profile.backend !== "container" || profile.adapter_id !== "docker") {
      throw new Error("Docker probe requires an exact declared container profile for adapter docker");
    }
    const probe = await this.dockerSandbox.probe(args.image, profile.capabilities as JsonObject);
    const artifact = this.artifactRegister({ kind: "docker_sandbox_probe", name: `Docker probe ${profile.id} v${profile.version}`,
      uri: `craft://sandbox-probes/${profile.id}/${profile.version}`, producer_type: "sandbox_adapter", producer_id: "docker",
      metadata: { profile_id: profile.id, profile_version: profile.version, image: probe.image, probe_digest: probe.probe_digest } });
    const evidence = this.evidenceRecord({ source_type: "program", confidence: "bounded", claim: "Docker Sandbox boundary probe passed.",
      artifact_id: artifact.id, locator: { profile_id: profile.id, profile_version: profile.version } });
    return { probe, artifact, evidence, profile };
  }
  async dockerSandboxConformance(args: JsonObject): Promise<JsonObject> {
    const profile = this.store.get("sandbox_profile", text(args.profile_id, "profile_id"), finiteInteger(args.profile_version, "profile_version", 0));
    if (profile.lifecycle !== "declared" || profile.backend !== "container" || profile.adapter_id !== "docker") {
      throw new Error("Docker conformance requires an exact declared container profile for adapter docker");
    }
    const conformance = await this.dockerSandbox.conformance(String(args.probe_id ?? `probe_${id("docker")}`), args.image,
      profile.capabilities as JsonObject, this.store.paths.runtimeDir);
    const artifact = this.artifactRegister({ kind: "docker_sandbox_conformance", name: `Docker conformance ${profile.id} v${profile.version}`,
      uri: `craft://sandbox-conformance/${profile.id}/${profile.version}`, producer_type: "sandbox_adapter", producer_id: "docker",
      metadata: { profile_id: profile.id, profile_version: profile.version, image: conformance.image,
        conformance_version: conformance.conformance_version, checks: conformance.checks } });
    const evidence = this.evidenceRecord({ source_type: "program", confidence: "bounded", claim: "Docker Sandbox conformance passed.",
      artifact_id: artifact.id, locator: { profile_id: profile.id, profile_version: profile.version } });
    const verification = this.sandbox.profileVerify({ profile_id: profile.id, profile_version: profile.version,
      observed_capabilities: conformance.observed_capabilities, evidence_ids: [evidence.id], verifier: "docker-conformance-v1" });
    return { conformance, artifact, evidence, ...verification };
  }
  async dockerSandboxExecute(args: JsonObject): Promise<JsonObject> {
    const ticket = this.store.get("sandbox_ticket", text(args.ticket_id, "ticket_id"));
    const profile = this.store.get("sandbox_profile", String(ticket.profile_id), Number(ticket.profile_version));
    if (profile.backend !== "container" || profile.adapter_id !== "docker") throw new Error("Sandbox ticket is not assigned to Docker");
    const result = await this.dockerSandbox.execute({ ticket_id: ticket.id, runtime_root: this.store.paths.runtimeDir,
      image: args.image, command: args.argv, request_digest: ticket.request_digest, capabilities: profile.capabilities });
    const artifact = this.artifactRegister({ kind: "docker_sandbox_receipt", name: `Docker execution ${ticket.id}`,
      uri: `craft://docker-sandbox/${ticket.id}`, producer_type: "sandbox_adapter", producer_id: "docker",
      metadata: { ticket_id: ticket.id, image: result.image, command_digest: result.command_digest,
        exit_code: result.exit_code, output_limited: result.output_limited } });
    const evidence = this.evidenceRecord({ source_type: "program", confidence: result.status === "passed" ? "confirmed" : "rejected",
      claim: `Docker Sandbox execution ${result.status}.`, artifact_id: artifact.id, locator: { ticket_id: ticket.id } });
    const receipt = this.sandbox.receipt({ ticket_id: ticket.id, receipt_id: text(args.receipt_id, "receipt_id"), adapter_id: "docker",
      profile_version: profile.version, status: result.status, observed_capabilities: result.observed_capabilities,
      evidence_ids: [evidence.id] });
    return { result, artifact, evidence, ...receipt };
  }
  workspaceTransactionBegin(args: JsonObject): JsonObject { return this.transaction.begin(args); }
  workspaceTransactionCommit(args: JsonObject): JsonObject { return this.transaction.commit(args); }
  workspaceTransactionRollback(args: JsonObject): JsonObject { return this.transaction.rollback(args); }
  trajectoryScriptCompile(args: JsonObject): JsonObject { return this.trajectory.compile(args); }
  trajectoryScriptAuthorize(args: JsonObject): JsonObject { return this.trajectory.authorize(args); }
  verifiedScriptIssue(args: JsonObject): JsonObject { return this.scriptRunner.issue(args); }
  verifiedScriptReceipt(args: JsonObject): JsonObject { return this.scriptRunner.receipt(args); }
  private taskPack(taskId: string): JsonObject {
    return { task: this.store.get("task", taskId), checkpoints: this.store.list("checkpoint", 100,
      (item) => item.task_id === taskId), feedback: this.store.list("feedback", 100,
      (item) => item.task_id === taskId) };
  }

  feedbackRecord(args: JsonObject): JsonObject {
    const scope = String(args.scope ?? "task");
    if (!new Set(["task", "project", "user"]).has(scope)) throw new Error(`Unsupported feedback scope: ${scope}`);
    if (scope === "task" && !args.task_id) throw new Error("task_id is required for task feedback");
    return this.store.save("feedback", id("feedback"), { corrected: text(args.corrected, "corrected"),
      original: args.original ?? null, kind: args.kind ?? "correction", scope,
      task_id: args.task_id ?? null, applies_to: args.applies_to ?? null,
      source: args.source ?? "user_explicit" });
  }

  artifactRegister(args: JsonObject): JsonObject {
    return this.store.save("artifact", String(args.artifact_id ?? id("artifact")), {
      kind: text(args.kind, "kind"), name: text(args.name, "name"), uri: text(args.uri, "uri"),
      media_type: args.media_type ?? null, digest: args.digest ?? null, size_bytes: args.size_bytes ?? null,
      producer_type: args.producer_type ?? null, producer_id: args.producer_id ?? null,
      metadata: args.metadata ?? {} });
  }
  evidenceRecord(args: JsonObject): JsonObject {
    const confidence = String(args.confidence ?? "unverified");
    if (!CONFIDENCE.has(confidence)) throw new Error(`Unsupported confidence: ${confidence}`);
    if (args.artifact_id) this.store.get("artifact", String(args.artifact_id));
    return this.store.save("evidence", String(args.evidence_id ?? id("evidence")), {
      source_type: text(args.source_type, "source_type"), claim: text(args.claim, "claim"), confidence,
      artifact_id: args.artifact_id ?? null, locator: args.locator ?? null,
      observed_at: args.observed_at ?? new Date().toISOString(), metadata: args.metadata ?? {} });
  }

  saveVersioned(kind: string, prefix: string, args: JsonObject, required: string[]): JsonObject {
    for (const key of required) text(args[key], key);
    const recordId = String(args[`${prefix}_id`] ?? id(prefix));
    const payload = { ...args };
    delete payload[`${prefix}_id`];
    return this.store.save(kind, recordId, payload);
  }
  list(kind: string, key: string, args: JsonObject): JsonObject {
    const query = String(args.query ?? "").toLowerCase();
    return { [key]: this.store.list(kind, finiteInteger(args.limit, "limit", 20, 1, 1_000), (item) =>
      !query || JSON.stringify(item).toLowerCase().includes(query)) };
  }
  get(kind: string, idKey: string, args: JsonObject): JsonObject {
    const version = args.version === undefined ? undefined : finiteInteger(args.version, "version", 1);
    return this.store.get(kind, text(args[idKey], idKey), version);
  }

  harnessConfigurationSave(args: JsonObject): JsonObject {
    const dimensions = object(args.dimensions, "dimensions");
    for (const key of Object.keys(dimensions)) {
      if (!HARNESS_DIMENSIONS.has(key)) throw new Error(`Unsupported harness dimension: ${key}`);
      object(dimensions[key], `dimensions.${key}`);
    }
    return this.saveVersioned("harness_configuration", "configuration", {
      ...args, name: text(args.name, "name"), dimensions,
    }, ["name"]);
  }

  evaluationSuiteSave(args: JsonObject): JsonObject {
    const cases = array(args.cases ?? [], "cases").map((value, index) => {
      const item = object(value, `cases[${index}]`);
      const caseId = text(item.case_id, `cases[${index}].case_id`);
      const split = String(item.split ?? "development");
      if (!EVAL_SPLITS.has(split)) throw new Error(`Unsupported evaluation split: ${split}`);
      return { ...item, case_id: caseId, split };
    });
    if (new Set(cases.map((item) => item.case_id)).size !== cases.length) {
      throw new Error("Evaluation case_id values must be unique");
    }
    return this.saveVersioned("evaluation_suite", "suite", { ...args, cases }, ["name"]);
  }

  graderSave(args: JsonObject): JsonObject {
    const graderType = text(args.grader_type, "grader_type");
    if (!GRADER_TYPES.has(graderType)) throw new Error(`Unsupported grader type: ${graderType}`);
    return this.saveVersioned("grader", "grader", { ...args, grader_type: graderType,
      configuration: object(args.configuration ?? args.rules ?? {}, "configuration") }, ["name", "grader_type"]);
  }

  gradeRecord(args: JsonObject): JsonObject {
    const trialId = text(args.trial_id, "trial_id");
    this.store.get("trial", trialId);
    const grader = this.store.get("grader", text(args.grader_id, "grader_id"),
      finiteInteger(args.grader_version, "grader_version", 1));
    const verdict = text(args.verdict, "verdict");
    if (!GRADE_VERDICTS.has(verdict)) throw new Error(`Unsupported grade verdict: ${verdict}`);
    const evidenceIds = array(args.evidence_ids ?? [], "evidence_ids").map((value) => text(value, "evidence_id"));
    for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    const gradeId = `grade_${createHash("sha256").update(JSON.stringify(
      [trialId, grader.id, grader.version])).digest("hex")}`;
    return this.store.create("grade", gradeId, { trial_id: trialId, grader_id: grader.id,
      grader_version: grader.version, grader_type: grader.grader_type, verdict,
      score: optionalScore(args.score, "score"), summary: text(args.summary, "summary"), evidence_ids: evidenceIds,
      metadata: object(args.metadata ?? {}, "metadata") });
  }

  signoffPolicySave(args: JsonObject): JsonObject {
    const requirements = array(args.requirements ?? [], "requirements").map((value, index) => {
      const requirement = object(value, `requirements[${index}]`);
      const graderType = text(requirement.grader_type, `requirements[${index}].grader_type`);
      if (!GRADER_TYPES.has(graderType)) throw new Error(`Unsupported grader type: ${graderType}`);
      return { grader_type: graderType, minimum_score: optionalScore(requirement.minimum_score,
        `requirements[${index}].minimum_score`) };
    });
    if (new Set(requirements.map((item) => item.grader_type)).size !== requirements.length) {
      throw new Error("Signoff grader_type requirements must be unique");
    }
    return this.saveVersioned("signoff_policy", "policy", { ...args, requirements,
      require_held_out: optionalBoolean(args.require_held_out, "require_held_out") ?? true,
      require_outcome_passed: optionalBoolean(args.require_outcome_passed, "require_outcome_passed") ?? true,
    }, ["name"]);
  }

  signoffEvaluate(args: JsonObject): JsonObject {
    const policy = this.store.get("signoff_policy", text(args.policy_id, "policy_id"),
      args.policy_version === undefined ? undefined : finiteInteger(args.policy_version, "policy_version", 1));
    const evaluation = this.store.get("evaluation_run", text(args.evaluation_run_id, "evaluation_run_id"));
    const gradeIds = array(args.grade_ids ?? [], "grade_ids").map((value) => text(value, "grade_id"));
    if (new Set(gradeIds).size !== gradeIds.length) throw new Error("grade_ids must be unique");
    const trialIds = evaluation.trial_ids as string[];
    const grades = gradeIds.map((gradeId) => {
      const grade = this.store.get("grade", gradeId);
      if (!trialIds.includes(String(grade.trial_id))) throw new Error(`Grade is outside the evaluation run: ${gradeId}`);
      return grade;
    });
    const checks: JsonObject[] = [];
    if (policy.require_held_out) checks.push({ check: "held_out", passed: evaluation.split === "held_out" });
    if (policy.require_outcome_passed) checks.push({ check: "outcome", passed: evaluation.verdict === "passed" });
    for (const requirement of policy.requirements as JsonObject[]) {
      const graderType = String(requirement.grader_type);
      const minimumScore = requirement.minimum_score as number | null;
      for (const trialId of trialIds) {
        const matching = grades.filter((grade) => grade.trial_id === trialId && grade.grader_type === graderType);
        checks.push({ check: "grader", trial_id: trialId, grader_type: graderType,
          passed: matching.some((grade) => grade.verdict === "passed" &&
            (minimumScore === null || (grade.score !== null && Number(grade.score) >= minimumScore))),
          grade_ids: matching.map((grade) => grade.id), minimum_score: minimumScore });
      }
    }
    const decision = checks.every((check) => check.passed) ? "passed" : "failed";
    return this.store.create("signoff", String(args.signoff_id ?? id("signoff")), {
      policy_id: policy.id, policy_version: policy.version, evaluation_run_id: evaluation.id,
      subject_type: evaluation.subject_type, subject_id: evaluation.subject_id,
      subject_version: evaluation.subject_version, grade_ids: gradeIds, checks, decision,
    });
  }

  trialStart(args: JsonObject): JsonObject {
    const taskId = text(args.task_id, "task_id");
    this.store.get("task", taskId);
    const subjectType = text(args.subject_type, "subject_type");
    const subjectId = text(args.subject_id, "subject_id");
    const subjectVersion = finiteInteger(args.subject_version, "subject_version", 1);
    this.store.get(subjectType, subjectId, subjectVersion);
    let harness: JsonObject | undefined;
    if (args.harness_configuration_id !== undefined) {
      harness = this.store.get("harness_configuration", text(args.harness_configuration_id,
        "harness_configuration_id"), args.harness_configuration_version === undefined ? undefined
          : finiteInteger(args.harness_configuration_version, "harness_configuration_version", 1));
    }
    return this.store.create("trial", String(args.trial_id ?? id("trial")), {
      task_id: taskId, case_id: args.case_id === undefined ? null : text(args.case_id, "case_id"),
      subject_type: subjectType, subject_id: subjectId, subject_version: subjectVersion,
      harness_configuration_id: harness?.id ?? null,
      harness_configuration_version: harness?.version ?? null,
      environment: object(args.environment ?? {}, "environment"),
      budget: object(args.budget ?? {}, "budget"), status: "started",
    });
  }

  trialTraceAppend(args: JsonObject): JsonObject {
    const trialId = text(args.trial_id, "trial_id");
    this.store.get("trial", trialId);
    const artifactIds = array(args.artifact_ids ?? [], "artifact_ids").map((value) => text(value, "artifact_id"));
    const evidenceIds = array(args.evidence_ids ?? [], "evidence_ids").map((value) => text(value, "evidence_id"));
    for (const artifactId of artifactIds) this.store.get("artifact", artifactId);
    for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    const result = this.store.appendEvent(`trial:${trialId}`, text(args.event_type, "event_type"), {
      trial_id: trialId, source: args.source ?? "agent_reported",
      data: object(args.data ?? {}, "data"), artifact_ids: artifactIds, evidence_ids: evidenceIds,
    });
    this.trace.appendTrial({ ...args, event_id: `${trialId}:${result.sequence}`, event_type: args.event_type, artifact_ids: artifactIds, evidence_ids: evidenceIds });
    return result;
  }

  outcomeRecord(args: JsonObject): JsonObject {
    const trialId = text(args.trial_id, "trial_id");
    this.store.get("trial", trialId);
    const verdict = String(args.verdict);
    if (!TRIAL_VERDICTS.has(verdict)) throw new Error(`Unsupported trial verdict: ${verdict}`);
    const evidenceIds = array(args.evidence_ids ?? [], "evidence_ids").map((value) => text(value, "evidence_id"));
    for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    const failureType = args.failure_type === undefined ? (verdict === "passed" ? null : "unspecified")
      : text(args.failure_type, "failure_type");
    const outcome = this.store.create("outcome", `outcome_${trialId}`, {
      trial_id: trialId, verdict, summary: text(args.summary, "summary"),
      failure_type: failureType,
      scores: object(args.scores ?? {}, "scores"), costs: object(args.costs ?? {}, "costs"),
      evidence_ids: evidenceIds, source: args.source ?? "program_verified",
      ...(args.knowledge_binding === undefined ? {} : { knowledge_binding: object(args.knowledge_binding, "knowledge_binding") }),
    });
    this.trace.appendTrial({ trial_id: trialId, event_type: "outcome.recorded", source: "program_verified", trust: "verified", summary: outcome.summary, data: { verdict, failure_type: failureType }, evidence_ids: evidenceIds });
    const traceStatus = verdict === "passed" ? "completed" : verdict as "failed" | "blocked" | "cancelled";
    this.trace.finalize({ trace_id: `trial:${trialId}`, status: traceStatus, verdict,
      summary: `Trial outcome ${verdict}.`, evidence_ids: evidenceIds });
    return outcome;
  }

  runtimeTruthStandardize(args: JsonObject): JsonObject { return this.runtimeTruth.standardize(args); }
  runtimeTruthOtlp(args: JsonObject): JsonObject { return this.runtimeTruth.otlp(args); }
  async runtimeTruthExport(args: JsonObject): Promise<JsonObject> { return this.runtimeTruth.export(args); }
  runtimeTruthCompact(args: JsonObject): JsonObject { return this.runtimeTruth.compact(args); }
  runtimeTruthCompactionGet(args: JsonObject): JsonObject { return this.runtimeTruth.compactionGet(args); }
  runtimeTruthCompactionList(args: JsonObject = {}): JsonObject { return this.runtimeTruth.compactionList(args); }
  runtimeTruthWorkNote(args: JsonObject): JsonObject { return this.runtimeTruth.workNote(args); }
  runtimeTruthWorkNoteGet(args: JsonObject): JsonObject { return this.runtimeTruth.workNoteGet(args); }
  osSecurityPlan(args: JsonObject): JsonObject { return this.osSecurity.plan(args); }
  osSecurityVerify(args: JsonObject): JsonObject { return this.osSecurity.verify(args); }
  mcpRegistrySourceRegister(args: JsonObject): JsonObject { return this.mcpRegistry.sourceRegister(args); }
  mcpRegistryServerIngest(args: JsonObject): JsonObject { return this.mcpRegistry.serverIngest(args); }
  mcpRegistryHealthRecord(args: JsonObject): JsonObject { return this.mcpRegistry.health(args); }
  mcpRegistryRevoke(args: JsonObject): JsonObject { return this.mcpRegistry.revoke(args); }
  async mcpRegistrySync(args: JsonObject): Promise<JsonObject> { return this.mcpRegistry.sync(args); }
  async a2aTransportDispatch(args: JsonObject): Promise<JsonObject> { return this.a2aTransport.dispatch(args); }
  async a2aTransportTaskGet(args: JsonObject): Promise<JsonObject> { return this.a2aTransport.taskGet(args); }
  async a2aTransportTaskCancel(args: JsonObject): Promise<JsonObject> { return this.a2aTransport.taskCancel(args); }
  remoteTenantRegister(args: JsonObject): JsonObject { return this.remoteRuntime.tenantRegister(args); }
  remoteTaskBind(args: JsonObject): JsonObject { return this.remoteRuntime.bind(args); }
  remoteTaskAuthorize(args: JsonObject): JsonObject { return this.remoteRuntime.authorize(args); }
  remoteTaskRevoke(args: JsonObject): JsonObject { return this.remoteRuntime.revoke(args); }
  remoteTaskGet(args: JsonObject): JsonObject { return this.remoteRuntime.get(args); }
  supplyChainPublisherRegister(args: JsonObject): JsonObject { return this.supplyChainAttestations.publisherRegister(args); }
  supplyChainAttest(args: JsonObject): JsonObject { return this.supplyChainAttestations.attest(args); }
  supplyChainAttestationAssert(args: JsonObject): JsonObject { return this.supplyChainAttestations.assertCurrent(args); }
  supplyChainAttestationRevoke(args: JsonObject): JsonObject { return this.supplyChainAttestations.revoke(args); }
  runtimeAcceptancePlan(args: JsonObject): JsonObject { return this.runtimeAcceptance.plan(args); }
  runtimeAcceptanceRecord(args: JsonObject): JsonObject { return this.runtimeAcceptance.record(args); }
  runtimeAcceptanceEvaluate(args: JsonObject): JsonObject { return this.runtimeAcceptance.evaluate(args); }
  runtimeAcceptanceGet(args: JsonObject): JsonObject { return this.runtimeAcceptance.get(args); }
  async a2aV1Discover(args: JsonObject): Promise<JsonObject> { return this.a2aV1.discover(args); }
  async a2aV1Submit(args: JsonObject): Promise<JsonObject> { return this.a2aV1.submit(args); }
  async a2aV1TaskGet(args: JsonObject): Promise<JsonObject> { return this.a2aV1.taskGet(args); }
  async a2aV1Cancel(args: JsonObject): Promise<JsonObject> { return this.a2aV1.cancel(args); }
  orgSyncPrepare(args: JsonObject): JsonObject { return this.orgSync.prepare(args); }
  orgSyncApply(args: JsonObject): JsonObject { return this.orgSync.apply(args); }

  projectBrainOpen(args: JsonObject): JsonObject { return this.projectBrain.open(args); }
  projectBrainGet(args: JsonObject): JsonObject { return this.projectBrain.get(args); }
  projectBrainRefresh(args: JsonObject): JsonObject { return this.projectBrain.refresh(args); }
  projectBrainGoalSave(args: JsonObject): JsonObject { return this.projectBrain.goalSave(args); }
  projectBrainDecisionSave(args: JsonObject): JsonObject { return this.projectBrain.decisionSave(args); }
  projectBrainMaterialBind(args: JsonObject): JsonObject { return this.projectBrain.materialBind(args); }
  projectBrainOutcomeRecord(args: JsonObject): JsonObject { return this.projectBrain.outcomeRecord(args); }
  projectBrainExperienceRecord(args: JsonObject): JsonObject { return this.projectBrain.experienceRecord(args); }
  contextManifestSave(args: JsonObject): JsonObject { return this.contextPlane.save(args); }
  contextManifestGet(args: JsonObject): JsonObject { return this.contextPlane.get(args); }
  contextManifestAudit(args: JsonObject): JsonObject { return this.contextPlane.audit(args); }
  replayRunnerPrepare(args: JsonObject): JsonObject { return this.replayRunner.prepare(args); }
  async replayRunnerExecute(args: JsonObject): Promise<JsonObject> { return this.replayRunner.execute(args); }
  replayRunnerGet(args: JsonObject): JsonObject { return this.replayRunner.get(args); }
  localRuntimeServiceConfigure(args: JsonObject): JsonObject { return this.localRuntimeService.configure(args); }
  localRuntimeServiceStart(args: JsonObject = {}): JsonObject { return this.localRuntimeService.start(args); }
  localRuntimeServiceStop(args: JsonObject = {}): JsonObject { return this.localRuntimeService.stop(args); }
  localRuntimeServiceTick(args: JsonObject = {}): JsonObject {
    // A Local Runtime tick is the only scheduler integration point.  It first
    // advances due, routeable Workflow jobs, then preserves the older wakeup
    // queue semantics for Hosts that do not install Procedure Automation.
    const automation = this.procedureAutomation.tick(args);
    const runtime = this.localRuntimeService.tick(args);
    return { ...runtime, automation };
  }
  localRuntimeServiceGet(args: JsonObject = {}): JsonObject { return this.localRuntimeService.get(args); }
  procedureAutomationSave(args: JsonObject): JsonObject { return this.procedureAutomation.save(args); }
  procedureAutomationPause(args: JsonObject): JsonObject { return this.procedureAutomation.pause(args); }
  procedureAutomationRun(args: JsonObject): JsonObject { return this.procedureAutomation.run(args); }
  procedureAutomationReceiptRecord(args: JsonObject): JsonObject { return this.procedureAutomation.receiptRecord(args); }
  procedureAutomationTick(args: JsonObject = {}): JsonObject { return this.procedureAutomation.tick(args); }
  procedureAutomationGet(args: JsonObject): JsonObject { return this.procedureAutomation.get(args); }
  procedureAutomationEligibility(args: JsonObject): JsonObject { return this.procedureAutomation.eligibility(args); }
  ticketDispatchScan(args: JsonObject): JsonObject { return this.forgeDispatch.scan(args); }
  ticketDispatchEvaluate(args: JsonObject): JsonObject { return this.forgeDispatch.evaluate(args); }
  forgePolicySave(args: JsonObject): JsonObject { return this.forgeDispatch.policySave(args); }
  forgeActionPrepare(args: JsonObject): JsonObject { return this.forgeDispatch.actionPrepare(args); }
  forgeActionGet(args: JsonObject): JsonObject { return this.forgeDispatch.get(args); }
  projectBundleExport(args: JsonObject): JsonObject { return this.projectBundles.export(args); }
  projectBundleVerify(args: JsonObject): JsonObject { return this.projectBundles.verify(args); }
  knowledgeMemoryBundleExport(args: JsonObject): JsonObject { return this.knowledgeMemoryBundles.export(args); }
  knowledgeMemoryBundleVerify(args: JsonObject): JsonObject { return this.knowledgeMemoryBundles.verify(args); }
  knowledgeMemoryBundleImportPlan(args: JsonObject): JsonObject { return this.knowledgeMemoryBundles.importPlan(args); }
  knowledgeMemoryBundleImportApply(args: JsonObject): JsonObject { return this.knowledgeMemoryBundles.importApply(args); }
  knowledgeMemoryBundleTransport(args: JsonObject): JsonObject { return this.knowledgeMemoryBundles.transport(args); }
  knowledgeMemoryBundleManage(args: JsonObject): JsonObject {
    const operation = text(args.operation, "operation");
    const request = { ...args }; delete request.operation;
    if (operation === "export") return this.knowledgeMemoryBundleExport(request);
    if (operation === "verify") return this.knowledgeMemoryBundleVerify(request);
    if (operation === "import_plan") return this.knowledgeMemoryBundleImportPlan(request);
    if (operation === "import_apply") return this.knowledgeMemoryBundleImportApply(request);
    if (operation === "transport_write") return this.knowledgeMemoryBundleTransport({ ...request, operation: "write" });
    if (operation === "transport_read") return this.knowledgeMemoryBundleTransport({ ...request, operation: "read" });
    throw new Error("Knowledge/Memory Bundle operation is unsupported");
  }
  feedbackLearningRecord(args: JsonObject): JsonObject { return this.feedbackLearning.record(args); }
  feedbackLearningResolve(args: JsonObject): JsonObject { return this.feedbackLearning.resolve(args); }
  domainEvaluatorSave(args: JsonObject): JsonObject { return this.domainEvaluators.save(args); }
  domainEvaluatorEvaluate(args: JsonObject): JsonObject { return this.domainEvaluators.evaluate(args); }
  handoffManifestCreate(args: JsonObject): JsonObject { return this.handoffManifests.create(args); }
  handoffManifestGet(args: JsonObject): JsonObject { return this.handoffManifests.get(args); }
  costPriceSave(args: JsonObject): JsonObject { return this.costLedger.priceSave(args); }
  costUsageRecord(args: JsonObject): JsonObject { return this.costLedger.usageRecord(args); }
  costLedgerReport(args: JsonObject = {}): JsonObject { return this.costLedger.report(args); }
  verifiedWorkPrepare(args: JsonObject): JsonObject { return this.verifiedAutonomousWork.prepare(args); }
  verifiedWorkAuthorize(args: JsonObject): JsonObject { return this.verifiedAutonomousWork.authorize(args); }
  verifiedWorkAction(args: JsonObject): JsonObject { return this.verifiedAutonomousWork.recordAction(args); }
  verifiedWorkReobserve(args: JsonObject): JsonObject { return this.verifiedAutonomousWork.reobserve(args); }
  verifiedWorkDeliver(args: JsonObject): JsonObject { return this.verifiedAutonomousWork.deliver(args); }
  verifiedWorkResume(args: JsonObject): JsonObject { return this.verifiedAutonomousWork.resume(args); }
  verifiedWorkHandoff(args: JsonObject): JsonObject { return this.verifiedAutonomousWork.handoff(args); }
  verifiedWorkGet(args: JsonObject): JsonObject { return this.verifiedAutonomousWork.get(args); }
  sandboxConformanceSave(args: JsonObject): JsonObject { return this.sandboxConformance.save(args); }
  sandboxConformanceAdmit(args: JsonObject): JsonObject { return this.sandboxConformance.admit(args); }
  sandboxConformanceGet(args: JsonObject): JsonObject { return this.sandboxConformance.get(args); }
  traceExplorerQuery(args: JsonObject = {}): JsonObject { return this.traceExplorer.query(args); }
  actionGatewayPrepare(args: JsonObject): JsonObject { return this.actionGateway.prepare(args); }
  actionGatewayExecute(args: JsonObject): Promise<JsonObject> { return this.actionGateway.execute(args); }
  actionGatewayGet(args: JsonObject): JsonObject { return this.actionGateway.get(args); }
  acceptanceGatePrepare(args: JsonObject): JsonObject { return this.acceptanceGates.prepare(args); }
  acceptanceGateAssess(args: JsonObject): JsonObject { return this.acceptanceGates.assess(args); }
  acceptanceGateOutcome(args: JsonObject): JsonObject { return this.acceptanceGates.outcome(args); }
  acceptanceGateGet(args: JsonObject): JsonObject { return this.acceptanceGates.get(args); }
  durableWorkerConfigure(args: JsonObject = {}): JsonObject { return this.durableWorker.configure(args); }
  durableWorkerStart(args: JsonObject = {}): JsonObject { return this.durableWorker.start(args); }
  durableWorkerStop(args: JsonObject = {}): JsonObject { return this.durableWorker.stop(args); }
  durableWorkerEnqueue(args: JsonObject): JsonObject { return this.durableWorker.enqueue(args); }
  durableWorkerTick(args: JsonObject = {}): JsonObject { return this.durableWorker.tick(args); }
  durableWorkerRecover(args: JsonObject = {}): JsonObject { return this.durableWorker.recover(args); }
  durableWorkerGet(args: JsonObject = {}): JsonObject { return this.durableWorker.get(args); }
  providerRoutePlan(args: JsonObject): JsonObject { return this.providerRouter.plan(args); }
  providerRouteRecord(args: JsonObject): JsonObject { return this.providerRouter.record(args); }
  providerRouteGet(args: JsonObject): JsonObject { return this.providerRouter.get(args); }
  a2aMessageSend(args: JsonObject): Promise<JsonObject> { return this.a2aProtocol.sendMessage(args); }
  a2aMessageStream(args: JsonObject): Promise<JsonObject> { return this.a2aProtocol.streamMessage(args); }
  a2aTaskList(args: JsonObject): Promise<JsonObject> { return this.a2aProtocol.listTasks(args); }
  workSessionPrepare(args: JsonObject): JsonObject { return this.workSessions.prepare(args); }
  workSessionGet(args: JsonObject): JsonObject { return this.workSessions.get(args); }
  workSessionRefresh(args: JsonObject): JsonObject { return this.workSessions.refresh(args); }
  workSessionBindLaunch(args: JsonObject): JsonObject { return this.workSessions.bindLaunch(args); }
  workSessionBindDispatch(args: JsonObject): JsonObject { return this.workSessions.bindDispatch(args); }
  workSessionComplete(args: JsonObject): JsonObject { return this.workSessions.complete(args); }
  workbenchExperienceQuery(args: JsonObject = {}): JsonObject { return this.workbenchExperience.query(args); }
  workbenchExperienceGet(args: JsonObject): JsonObject { return this.workbenchExperience.get(args); }
  workbenchExperienceReview(args: JsonObject = {}): JsonObject { return this.workbenchExperience.review(args); }
  workbenchTraceReplayPlan(args: JsonObject): JsonObject { return this.workbenchExperience.replayPlan(args); }
  longTaskSuspend(args: JsonObject): JsonObject { return this.longTaskWorker.suspend(args); }
  longTaskWake(args: JsonObject): JsonObject { return this.longTaskWorker.wake(args); }
  longTaskResume(args: JsonObject): JsonObject { return this.longTaskWorker.resume(args); }
  longTaskGet(args: JsonObject): JsonObject { return this.longTaskWorker.get(args); }
  longTaskList(args: JsonObject = {}): JsonObject { return this.longTaskWorker.list(args); }
  longTaskTick(args: JsonObject = {}): JsonObject { return this.longTaskWorker.tick(args); }

  trialGet(args: JsonObject): JsonObject {
    const trialId = text(args.trial_id, "trial_id");
    const trial = this.store.get("trial", trialId);
    const outcome = this.store.find("outcome", `outcome_${trialId}`);
    return { trial, trace: this.store.events(`trial:${trialId}`), outcome };
  }

  evaluationRunRecord(args: JsonObject): JsonObject { return this.evaluationRuns.evaluationRunRecord(args); }
  evaluationRunAggregate(args: JsonObject): JsonObject { return this.evaluationRuns.evaluationRunAggregate(args); }
  evaluationCompare(args: JsonObject): JsonObject { return this.evaluationRuns.evaluationCompare(args); }
  evaluationRunnerRun(args: JsonObject): JsonObject { return this.evaluationRuns.evaluationRunnerRun(args); }
  evaluationProgramGrade(args: JsonObject): JsonObject { return this.evaluationRuns.evaluationProgramGrade(args); }
  evaluationPromotionAssess(args: JsonObject): JsonObject { return this.evaluationRuns.evaluationPromotionAssess(args); }
  evaluationReliabilityAssess(args: JsonObject): JsonObject { return this.evaluationRuns.evaluationReliabilityAssess(args); }

  judgeAdapterSave(args: JsonObject): JsonObject {
    const graderType = text(args.grader_type, "grader_type"); if (!new Set(["model", "human"]).has(graderType)) throw new Error("Judge adapter must be model or human");
    return this.saveVersioned("judge_adapter", "judge", { ...args, grader_type: graderType, status: "uncalibrated" }, ["name", "grader_type"]);
  }

  judgeCalibrationRecord(args: JsonObject): JsonObject {
    const judge = this.store.get("judge_adapter", text(args.judge_id, "judge_id")); const total = finiteInteger(args.total, "total", 1, 1); const agreed = finiteInteger(args.agreed, "agreed", 0, 0, total);
    const minimum = Number(args.minimum_agreement ?? 0.8); if (!Number.isFinite(minimum) || minimum < 0 || minimum > 1) throw new Error("minimum_agreement must be between 0 and 1");
    const goldCaseIds = optionalTextArray(args.gold_case_ids, "gold_case_ids"); const evidenceIds = optionalTextArray(args.evidence_ids, "evidence_ids");
    if (goldCaseIds.length && goldCaseIds.length !== total) throw new Error("gold_case_ids must match total calibration examples"); for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    const agreement = agreed / total; const calibration = this.store.create("judge_calibration", String(args.calibration_id ?? id("calibration")), { judge_id: judge.id, judge_version: judge.version, total, agreed, agreement, minimum_agreement: minimum, gold_case_ids: goldCaseIds, evidence_ids: evidenceIds, status: agreement >= minimum ? "calibrated" : "advisory" });
    this.store.save("judge_adapter", String(judge.id), { ...recordPayload(judge), status: calibration.status, calibration_id: calibration.id });
    return { calibration };
  }

  judgePromotionEligible(args: JsonObject): JsonObject {
    const judge = this.store.get("judge_adapter", text(args.judge_id, "judge_id")); return { eligible: judge.status === "calibrated", judge };
  }

  evaluationJudgeGate(args: JsonObject): JsonObject {
    const assessment = this.store.get("evaluation_reliability", text(args.assessment_id, "assessment_id")); const judge = this.store.get("judge_adapter", text(args.judge_id, "judge_id"));
    const evidenceIds = optionalTextArray(args.evidence_ids, "evidence_ids"); for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    const eligible = assessment.status === "eligible" && judge.status === "calibrated";
    const identity = { assessment_id: assessment.id, assessment_version: assessment.version, judge_id: judge.id, judge_version: judge.version, calibration_id: judge.calibration_id ?? null, evidence_ids: evidenceIds, eligible };
    const gateId = String(args.gate_id ?? `evaluation_judge_gate_${valueDigest(identity).slice(-16)}`); const existing = this.store.find("evaluation_judge_gate", gateId); const gateDigest = valueDigest(identity);
    if (existing) { if (existing.gate_digest !== gateDigest) throw new Error("Evaluation Judge Gate idempotency conflict"); return { gate: existing, idempotent: true }; }
    return { gate: this.store.create("evaluation_judge_gate", gateId, { ...identity, gate_digest: gateDigest, status: eligible ? "eligible" : "inconclusive" }), idempotent: false };
  }

  adaptationCandidateCreate(args: JsonObject): JsonObject {
    const task = this.store.get("task", text(args.task_id, "task_id")); const trialIds = uniqueTextArray(args.trial_ids, "trial_ids", 2); const evidenceIds = uniqueTextArray(args.evidence_ids, "evidence_ids");
    for (const trialId of trialIds) this.store.get("trial", trialId); for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    const axes = object(args.design_axes, "design_axes"); if (!Object.keys(axes).length || Object.keys(axes).length > 2 || Object.keys(axes).some((key) => !HARNESS_DIMENSIONS.has(key))) throw new Error("Adaptation Candidate changes at most two supported design axes");
    const candidate = this.store.create("adaptation_candidate", String(args.candidate_id ?? id("adaptation")), { task_id: task.id, trial_ids: trialIds, evidence_ids: evidenceIds, hypothesis: assertNoSecret(text(args.hypothesis, "hypothesis"), "hypothesis"), applicability: assertNoSecret(text(args.applicability, "applicability"), "applicability"), design_axes: axes, lifecycle: "draft", publication_allowed: false });
    return { candidate };
  }

  adaptationCandidateAuthorizeCanary(args: JsonObject): JsonObject {
    const candidate = this.store.get("adaptation_candidate", text(args.candidate_id, "candidate_id"));
    const assessment = this.store.get("evaluation_reliability", text(args.assessment_id, "assessment_id"));
    if (assessment.status !== "eligible") throw new Error("Adaptation Candidate requires an eligible reliability assessment");
    const comparison = this.store.get("evaluation_comparison", String(assessment.comparison_id));
    const signoff = this.store.get("signoff", text(args.signoff_id, "signoff_id"));
    if (signoff.decision !== "passed" || signoff.evaluation_run_id !== comparison.candidate_run_id) {
      throw new Error("Adaptation Candidate requires a passed Signoff for the compared candidate run");
    }
    const judgeGateId = args.judge_gate_id === undefined ? null : text(args.judge_gate_id, "judge_gate_id");
    if (judgeGateId && this.store.get("evaluation_judge_gate", judgeGateId).status !== "eligible") throw new Error("Adaptation Candidate requires an eligible calibrated Judge Gate");
    const authorized = this.store.save("adaptation_candidate", String(candidate.id), { ...recordPayload(candidate), lifecycle: "canary_ready", reliability_assessment_id: assessment.id, signoff_id: signoff.id, judge_gate_id: judgeGateId, publication_allowed: false });
    return { candidate: authorized };
  }

  feedbackIntakeCreate(args: JsonObject): JsonObject {
    const task = this.store.get("task", text(args.task_id, "task_id")); const summary = assertNoSecret(text(args.summary, "summary"), "summary");
    const intake = this.store.create("feedback_intake", String(args.intake_id ?? id("feedback_intake")), { task_id: task.id, source_uri: assertNoSecret(text(args.source_uri, "source_uri"), "source_uri"), summary, metric: args.metric === undefined ? null : text(args.metric, "metric"), status: "pending_review" });
    return { intake };
  }

  feedbackCaseApprove(args: JsonObject): JsonObject {
    const intake = this.store.get("feedback_intake", text(args.intake_id, "intake_id")); const split = text(args.split, "split");
    if (split !== "development") throw new Error("Feedback intake may only create development cases; held-out requires an independent curator");
    const reviewer = assertNoSecret(text(args.reviewer, "reviewer"), "reviewer");
    const caseRecord = this.store.create("feedback_case", String(args.case_id ?? id("feedback_case")), { intake_id: intake.id, task_id: intake.task_id, split, reviewer, source_uri: intake.source_uri, summary: intake.summary, immutable: true });
    this.store.save("feedback_intake", String(intake.id), { ...recordPayload(intake), status: "approved", feedback_case_id: caseRecord.id, reviewer });
    return { case: caseRecord };
  }

  canaryStart(args: JsonObject): JsonObject {
    const candidate = this.store.get("adaptation_candidate", text(args.candidate_id, "candidate_id"));
    if (candidate.lifecycle !== "canary_ready") throw new Error("Adaptation Candidate must pass shadow reliability and Signoff before Canary");
    const canary = this.store.create("canary", String(args.canary_id ?? id("canary")), { candidate_id: candidate.id, candidate_version: candidate.version, baseline_id: text(args.baseline_id, "baseline_id"), environment_fingerprint: fingerprint(object(args.environment, "environment")), status: "running" });
    return { canary };
  }

  canaryObserve(args: JsonObject): JsonObject {
    const canary = this.store.get("canary", text(args.canary_id, "canary_id")); const baseline = Number(args.baseline); const candidate = Number(args.candidate); const threshold = Number(args.threshold);
    if (![baseline, candidate, threshold].every((value) => Number.isFinite(value) && value >= 0)) throw new Error("Canary metrics must be non-negative finite numbers");
    const regression = candidate - baseline > threshold; const status = regression ? "rolled_back" : "running";
    const saved = this.store.save("canary", String(canary.id), { ...recordPayload(canary), status, metric: text(args.metric, "metric"), baseline, candidate, threshold, rollback_to: regression ? canary.baseline_id : null });
    return { status, canary: saved };
  }

  experienceMine(args: JsonObject): JsonObject {
    const subjectType = text(args.subject_type, "subject_type");
    const subjectId = text(args.subject_id, "subject_id");
    const subjectVersion = finiteInteger(args.subject_version, "subject_version", 1);
    const groups = new Map<string, { pattern_kind: "failure" | "success"; failure_type: string | null; trial_ids: string[]; evidence_ids: string[]; event_types: string[] }>();
    for (const trial of this.store.list("trial", 10_000, (item) => item.subject_type === subjectType && item.subject_id === subjectId &&
      Number(item.subject_version) === subjectVersion)) {
      const outcome = this.store.find("outcome", `outcome_${trial.id}`);
      if (!outcome || !Array.isArray(outcome.evidence_ids) || !outcome.evidence_ids.length) continue;
      const patternKind = outcome.verdict === "passed" ? "success" : "failure";
      const failureType = patternKind === "failure" ? String(outcome.failure_type ?? "unspecified") : null;
      const key = `${patternKind}:${failureType ?? "evidence_backed_strategy"}`;
      const group = groups.get(key) ?? { pattern_kind: patternKind, failure_type: failureType, trial_ids: [], evidence_ids: [], event_types: [] };
      group.trial_ids.push(String(trial.id)); group.evidence_ids.push(...outcome.evidence_ids.map(String));
      group.event_types.push(...this.store.events(`trial:${trial.id}`).map((event) => String(event.event_type)));
      groups.set(key, group);
    }
    const candidates = [...groups.values()].filter((group) => group.trial_ids.length >= 2).map((group) => {
      const trialIds = [...group.trial_ids].sort(); const evidenceIds = [...new Set(group.evidence_ids)].sort();
      const candidateId = `experience_mining_${createHash("sha256").update(`${subjectType}:${subjectId}:${subjectVersion}:${group.pattern_kind}:${group.failure_type}:${trialIds.join(",")}`).digest("hex")}`;
      const payload = { subject_type: subjectType, subject_id: subjectId, subject_version: subjectVersion, lifecycle: "proposal_only",
        pattern_kind: group.pattern_kind, failure_type: group.failure_type, trial_ids: trialIds, evidence_ids: evidenceIds,
        event_types: [...new Set(group.event_types)].sort(), next_action: "Generate a bounded proposal, then compare it in an isolated held-out evaluation before Signoff." };
      return this.store.find("experience_mining_candidate", candidateId) ?? this.store.create("experience_mining_candidate", candidateId, payload);
    });
    return { candidates };
  }

  operationalSignalRecord(args: JsonObject): JsonObject {
    const taskId = args.task_id === undefined ? null : text(args.task_id, "task_id");
    if (taskId) this.store.get("task", taskId);
    const value = Number(args.value);
    if (!Number.isFinite(value) || value < 0) throw new Error("value must be a non-negative finite number");
    const subjectType = text(args.subject_type, "subject_type"); const subjectId = text(args.subject_id, "subject_id");
    const metric = text(args.metric, "metric");
    const sequence = this.store.list("operational_signal", 10_000, (signal) => signal.subject_type === subjectType &&
      signal.subject_id === subjectId && signal.metric === metric).length + 1;
    return this.store.create("operational_signal", String(args.signal_id ?? id("signal")), { task_id: taskId,
      subject_type: subjectType, subject_id: subjectId, metric, sequence,
      value });
  }

  operationalDriftEvaluate(args: JsonObject): JsonObject {
    const subjectType = text(args.subject_type, "subject_type"); const subjectId = text(args.subject_id, "subject_id");
    const metric = text(args.metric, "metric"); const windowSize = finiteInteger(args.window_size, "window_size", 10, 1, 1_000);
    const direction = text(args.direction, "direction"); if (!new Set(["lower", "higher"]).has(direction)) throw new Error("direction must be lower or higher");
    const threshold = Number(args.threshold); if (!Number.isFinite(threshold) || threshold < 0) throw new Error("threshold must be non-negative");
    const values = this.store.list("operational_signal", 10_000, (signal) => signal.subject_type === subjectType &&
      signal.subject_id === subjectId && signal.metric === metric).sort((left, right) => Number(left.sequence) - Number(right.sequence));
    if (values.length < windowSize * 2) return { alert: false, reason: "insufficient_samples", samples: values.length };
    const mean = (items: JsonObject[]): number => items.reduce((sum, item) => sum + Number(item.value), 0) / items.length;
    const baseline = mean(values.slice(-windowSize * 2, -windowSize)); const current = mean(values.slice(-windowSize));
    const relative_change = (current - baseline) / Math.max(Math.abs(baseline), 1);
    const alert = direction === "lower" ? relative_change > threshold : relative_change < -threshold;
    const result = { alert, baseline, current, relative_change, samples: values.length, direction, threshold };
    if (alert) this.store.create("operational_alert", String(args.alert_id ?? id("alert")), { subject_type: subjectType,
      subject_id: subjectId, metric, ...result });
    return result;
  }

  workflowSave(args: JsonObject): JsonObject {
    if (args.steps !== undefined) {
      if (!Array.isArray(args.steps)) throw new Error("steps must be an array");
      const normalized = normalizeSteps(args.steps);
      const identityDigest = valueDigest({ name: args.name, description: args.description ?? "", inputs: args.inputs ?? {}, steps: normalized });
      return this.saveVersioned("workflow", "workflow", { ...args, steps: normalized, workflow_digest: identityDigest, lifecycle: "draft" }, ["name"]);
    }
    return this.saveVersioned("workflow", "workflow", { ...args, workflow_digest: valueDigest({ name: args.name, description: args.description ?? "", inputs: args.inputs ?? {}, steps: [] }), lifecycle: "draft" }, ["name"]);
  }

  workflowTransition(args: JsonObject): JsonObject {
    return this.transitionVersionedSubject("workflow", "workflow_id", "workflow", args);
  }

  private verificationGate(subjectType: string, subject: JsonObject, args: JsonObject): JsonObject {
    if (args.signoff_id !== undefined) {
      const signoff = this.store.get("signoff", text(args.signoff_id, "signoff_id"));
      const run = this.store.get("evaluation_run", String(signoff.evaluation_run_id));
      if (signoff.decision !== "passed" || signoff.subject_type !== subjectType ||
          signoff.subject_id !== subject.id || Number(signoff.subject_version) !== Number(subject.version) ||
          run.verdict !== "passed" || run.split !== "held_out") {
        throw new Error(`Verification requires a passed signoff for this exact ${subjectType} version`);
      }
      return { evaluation_run_id: run.id, signoff_id: signoff.id, promotion_id: null };
    }
    const run = this.store.get("evaluation_run", text(args.evaluation_run_id, "evaluation_run_id"));
    if (run.verdict !== "passed" || run.split !== "held_out" || run.subject_type !== subjectType ||
        run.subject_id !== subject.id || Number(run.subject_version) !== Number(subject.version)) {
      throw new Error(`Verification requires a passed held-out evaluation for this exact ${subjectType} version`);
    }
    const promotion = this.store.get("evaluation_promotion", text(args.promotion_id, "promotion_id"));
    if (!promotion.eligible || promotion.candidate_run_id !== run.id) {
      throw new Error(`Verification requires an eligible promotion for this exact ${subjectType} evaluation`);
    }
    return { evaluation_run_id: run.id, signoff_id: null, promotion_id: promotion.id };
  }

  private transitionVersionedSubject(kind: string, idKey: string, subjectType: string, args: JsonObject): JsonObject {
    const subject = this.store.get(kind, text(args[idKey], idKey));
    const current = String(subject.lifecycle ?? "draft");
    const target = text(args.target, "target");
    if (!VERSIONED_LIFECYCLE.has(target)) throw new Error(`Unsupported ${subjectType} lifecycle: ${target}`);
    const allowed: Record<string, string[]> = {
      draft: ["candidate", "deprecated"], candidate: ["verified", "deprecated"],
      verified: ["deprecated"], deprecated: [],
    };
    if (!allowed[current]?.includes(target)) throw new Error(`Invalid ${subjectType} transition: ${current} -> ${target}`);
    const verification = target === "verified" ? this.verificationGate(subjectType, subject, args)
      : { evaluation_run_id: null, signoff_id: null, promotion_id: null };
    return this.store.save(kind, String(subject.id), { ...recordPayload(subject), lifecycle: target,
      previous_version: subject.version, transition_reason: text(args.reason, "reason"), ...verification });
  }

  workflowRollback(args: JsonObject): JsonObject {
    return this.rollbackVersionedSubject("workflow", "workflow_id", "workflow", args);
  }

  private rollbackVersionedSubject(kind: string, idKey: string, subjectType: string, args: JsonObject): JsonObject {
    const subjectId = text(args[idKey], idKey);
    const current = this.store.get(kind, subjectId);
    const target = this.store.get(kind, subjectId, finiteInteger(args.target_version, "target_version", 1));
    if (target.lifecycle !== "verified") throw new Error(`Rollback target must be a verified ${subjectType} version`);
    return this.store.save(kind, subjectId, { ...recordPayload(target), lifecycle: "verified",
      rollback_from_version: current.version, rollback_to_version: target.version,
      rollback_reason: text(args.reason, "reason") });
  }

  experiencePatternCreate(args: JsonObject): JsonObject {
    const taskId = text(args.task_id, "task_id");
    this.store.get("task", taskId);
    const trialIds = uniqueTextArray(args.trial_ids, "trial_ids", 2);
    const evidenceIds = uniqueTextArray(args.evidence_ids, "evidence_ids");
    for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    const outcomes = trialIds.map((trialId) => {
      this.store.get("trial", trialId);
      const outcome = this.store.get("outcome", `outcome_${trialId}`);
      return { trial_id: trialId, verdict: outcome.verdict, failure_type: outcome.failure_type };
    });
    return this.saveVersioned("experience_pattern", "pattern", { ...args, task_id: taskId, trial_ids: trialIds,
      evidence_ids: evidenceIds, outcomes, success_strategy: text(args.success_strategy, "success_strategy"),
      failure_modes: array(args.failure_modes, "failure_modes").map((item) => text(item, "failure_mode")),
      applicability: text(args.applicability, "applicability") }, ["summary"]);
  }

  skillProposalCreate(args: JsonObject): JsonObject {
    const patternIds = uniqueTextArray(args.pattern_ids, "pattern_ids");
    for (const patternId of patternIds) this.store.get("experience_pattern", patternId);
    return this.saveVersioned("skill_proposal", "proposal", { ...args, lifecycle: "draft", pattern_ids: patternIds,
      skill_markdown: document(args.skill_markdown, "skill_markdown") }, ["name", "summary"]);
  }

  skillProposalTransition(args: JsonObject): JsonObject {
    return this.transitionVersionedSubject("skill_proposal", "proposal_id", "skill_proposal", args);
  }

  skillProposalRollback(args: JsonObject): JsonObject {
    return this.rollbackVersionedSubject("skill_proposal", "proposal_id", "skill_proposal", args);
  }

  async skillProposalPublish(args: JsonObject): Promise<JsonObject> {
    const proposal = this.store.get("skill_proposal", text(args.proposal_id, "proposal_id"));
    if (proposal.lifecycle !== "verified") throw new Error("Skill proposal must be verified before publication");
    const source = this.catalog.getSource(text(args.source_id, "source_id"));
    const publication = await publishSkill({ sourceRoot: String(source.real_path), targetPath: text(args.target_path, "target_path"),
      expectedDigest: text(args.expected_digest, "expected_digest"), content: String(proposal.skill_markdown),
      backupsDir: this.store.paths.backupsDir, proposalId: String(proposal.id), allowExternalWrite: args.allow_external_write });
    const record = this.store.create("skill_publication", String(args.publication_id ?? id("publication")), {
      proposal_id: proposal.id, proposal_version: proposal.version, source_id: source.id, status: "published", ...publication,
    });
    await this.catalog.scanSource(String(source.id));
    return record;
  }

  async skillPublicationRollback(args: JsonObject): Promise<JsonObject> {
    const publication = this.store.get("skill_publication", text(args.publication_id, "publication_id"));
    if (publication.status !== "published") throw new Error("Only a published Skill publication can be rolled back");
    await rollbackSkillPublication({ targetPath: String(publication.target_path), expectedDigest: text(args.expected_digest, "expected_digest"),
      publishedDigest: String(publication.published_digest), backupPath: String(publication.backup_path),
      allowExternalWrite: args.allow_external_write });
    const restored = this.store.save("skill_publication", String(publication.id), { ...recordPayload(publication), status: "rolled_back" });
    await this.catalog.scanSource(String(publication.source_id));
    return restored;
  }

  workflowPlan(args: JsonObject): JsonObject {
    const workflow = this.get("workflow", "workflow_id", args);
    const definitions = array(workflow.inputs ?? [], "workflow inputs") as JsonObject[];
    if (typeof (args.inputs ?? {}) !== "object" || Array.isArray(args.inputs)) {
      throw new Error("inputs must be an object");
    }
    const inputs = resolveInputs(definitions, (args.inputs ?? {}) as JsonObject);
    const stepDefinitions = array(workflow.steps ?? [], "workflow steps");
    const steps = normalizeSteps(substitute(stepDefinitions, inputs) as unknown[]);
    const allowExecution = optionalBoolean(args.allow_execution, "allow_execution") ?? false;
    const sideEffects = array(args.approved_side_effects ?? [], "approved_side_effects");
    const approved = approvedEffects(allowExecution, sideEffects);
    return { workflow_id: workflow.id, workflow_version: workflow.version, inputs, steps,
      approved_side_effects: [...approved], executable: steps.every((step) => approved.has(String(step.side_effect))) };
  }
  workflowRun(args: JsonObject): JsonObject {
    const plan = this.workflowPlan(args);
    const root = text(args.project_root, "project_root");
    const results = executeSteps(plan.steps as JsonObject[], root,
      new Set(plan.approved_side_effects as string[]));
    const passed = results.length === (plan.steps as unknown[]).length && results.every((item) => item.passed);
    return this.store.save("workflow_run", id("run"), { workflow_id: plan.workflow_id,
      workflow_version: plan.workflow_version, project_root: root, inputs: plan.inputs, results,
      status: passed ? "passed" : "failed" });
  }

  workflowTrialRun(args: JsonObject): JsonObject {
    const plan = this.workflowPlan(args);
    const trial = this.trialStart({
      trial_id: args.trial_id,
      task_id: args.task_id,
      case_id: args.case_id,
      subject_type: "workflow",
      subject_id: plan.workflow_id,
      subject_version: plan.workflow_version,
      harness_configuration_id: args.harness_configuration_id,
      harness_configuration_version: args.harness_configuration_version,
      environment: args.environment ?? {},
      budget: args.budget ?? {},
    });
    const trialId = String(trial.id);
    this.trialTraceAppend({ trial_id: trialId, event_type: "workflow.started", source: "program_verified",
      data: { workflow_id: plan.workflow_id, workflow_version: plan.workflow_version } });

    const startedAt = Date.now();
    let run: JsonObject;
    try {
      run = this.workflowRun({ ...args, version: plan.workflow_version });
    } catch {
      const evidence = this.evidenceRecord({ source_type: "program", confidence: "confirmed",
        claim: "Workflow execution crashed before a durable run receipt was produced.",
        locator: { workflow_id: plan.workflow_id, workflow_version: plan.workflow_version } });
      this.trialTraceAppend({ trial_id: trialId, event_type: "workflow.crashed", source: "program_verified",
        data: { error_type: "ExecutionError" }, evidence_ids: [evidence.id] });
      this.outcomeRecord({ trial_id: trialId, verdict: "failed",
        summary: "Workflow execution crashed before completion.", failure_type: "execution_error",
        scores: {}, costs: { duration_ms: Date.now() - startedAt },
        evidence_ids: [evidence.id], source: "program_verified" });
      return { workflow_run: null, artifact: null, evidence, ...this.trialGet({ trial_id: trialId }) };
    }
    const artifact = this.artifactRegister({ kind: "workflow_receipt", name: `Workflow run ${run.id}`,
      uri: `craft://workflow-runs/${run.id}`, media_type: "application/json",
      producer_type: "workflow_run", producer_id: run.id,
      metadata: { workflow_id: plan.workflow_id, workflow_version: plan.workflow_version } });
    const passed = run.status === "passed";
    const evidence = this.evidenceRecord({ source_type: "program", confidence: "confirmed",
      claim: `Workflow run ${run.id} ${passed ? "passed" : "failed"} deterministic checks.`,
      artifact_id: artifact.id, locator: { workflow_run_id: run.id } });
    this.trialTraceAppend({ trial_id: trialId, event_type: "workflow.completed", source: "program_verified",
      data: { status: run.status, workflow_run_id: run.id }, artifact_ids: [artifact.id],
      evidence_ids: [evidence.id] });
    const results = run.results as JsonObject[];
    this.outcomeRecord({ trial_id: trialId, verdict: passed ? "passed" : "failed",
      summary: passed ? "Workflow passed deterministic checks." : "Workflow failed deterministic checks.",
      ...(passed ? {} : { failure_type: "deterministic_check_failed" }),
      scores: { passed_steps: results.filter((item) => item.passed).length, total_steps: results.length },
      costs: { duration_ms: Date.now() - startedAt }, evidence_ids: [evidence.id], source: "program_verified" });
    return { workflow_run: run, artifact, evidence, ...this.trialGet({ trial_id: trialId }) };
  }

  orchestrationCreate(args: JsonObject): JsonObject {
    const nodes = normalizeNodes((args.nodes ?? []) as unknown[]).map((node) => ({ ...node,
      profile_versions: node.profile_ids.map((profileId) => Number(this.store.get("agent_profile", profileId).version)),
    }));
    const max = Number(args.max_concurrency ?? 4);
    if (!Number.isInteger(max) || max < 1 || max > 32) throw new Error("max_concurrency must be between 1 and 32");
    const leaseTtl = finiteInteger(args.lease_ttl_seconds, "lease_ttl_seconds", 300, 1, 3_600);
    const budget = budgetLimits(object(args.budget ?? {}, "budget"));
    const planId = args.plan_id === undefined ? id("plan") : text(args.plan_id, "plan_id");
    return this.store.create("orchestration_plan", planId, { goal: text(args.goal, "goal"),
      task_id: args.task_id ?? null, trial_id: args.trial_id ?? null,
      trial_started_at: args.trial_started_at ?? null, accumulated_costs: {},
      submission_receipts: [], budget, lease_ttl_seconds: leaseTtl,
      max_concurrency: max, status: "running", nodes, policy: object(args.policy ?? {}, "policy") });
  }
  orchestrationTrialStart(args: JsonObject): JsonObject {
    const taskId = text(args.task_id, "task_id");
    this.store.get("task", taskId);
    const trialId = args.trial_id === undefined ? id("trial") : text(args.trial_id, "trial_id");
    if (this.store.find("trial", trialId)) throw new Error(`Trial already exists: ${trialId}`);
    const caseId = args.case_id === undefined ? undefined : text(args.case_id, "case_id");
    const environment = object(args.environment ?? {}, "environment");
    const budget = object(args.budget ?? {}, "budget");
    if (args.harness_configuration_id !== undefined) {
      this.store.get("harness_configuration", text(args.harness_configuration_id, "harness_configuration_id"),
        args.harness_configuration_version === undefined ? undefined
          : finiteInteger(args.harness_configuration_version, "harness_configuration_version", 1));
    }
    const plan = this.orchestrationCreate({ ...args, task_id: taskId, trial_id: trialId,
      trial_started_at: new Date().toISOString() });
    const trial = this.trialStart({ trial_id: trialId, task_id: taskId, case_id: caseId,
      subject_type: "orchestration_plan", subject_id: plan.id, subject_version: plan.version,
      harness_configuration_id: args.harness_configuration_id,
      harness_configuration_version: args.harness_configuration_version,
      environment, budget });
    this.trialTraceAppend({ trial_id: trial.id, event_type: "orchestration.started", source: "program_verified",
      data: { plan_id: plan.id, plan_version: plan.version } });
    return { plan, ...this.trialGet({ trial_id: trial.id }) };
  }
  orchestrationDispatch(args: JsonObject): JsonObject {
    const plan = this.get("orchestration_plan", "plan_id", args);
    if (plan.status !== "running") throw new Error(`Plan is not running: ${plan.status}`);
    const owner = text(args.claimed_by, "claimed_by");
    const maximum = finiteInteger(plan.max_concurrency, "plan max_concurrency", 4, 1, 32);
    const requested = finiteInteger(args.capacity, "capacity", maximum, 1);
    const capacity = Math.min(requested, maximum);
    const recovered = recoverExpiredLeases(plan.nodes as PlanNode[]);
    const result = dispatchNodes(recovered.nodes, capacity, owner,
      finiteInteger(plan.lease_ttl_seconds, "plan lease_ttl_seconds", 300, 1, 3_600));
    const saved = this.store.updateIfVersion("orchestration_plan", String(plan.id), Number(plan.version), { ...plan, nodes: result.nodes,
      status: planStatus(result.nodes) });
    if (plan.trial_id && result.leases.length) {
      this.trialTraceAppend({ trial_id: plan.trial_id, event_type: "orchestration.dispatched",
        source: "program_verified", data: { leases: result.leases } });
    }
    return { plan: saved, leases: result.leases };
  }
  orchestrationRenew(args: JsonObject): JsonObject {
    const plan = this.get("orchestration_plan", "plan_id", args);
    if (plan.status !== "running") throw new Error(`Plan is not running: ${plan.status}`);
    const leaseId = text(args.lease_id, "lease_id");
    const owner = text(args.claimed_by, "claimed_by");
    const ttl = finiteInteger(plan.lease_ttl_seconds, "plan lease_ttl_seconds", 300, 1, 3_600);
    let found = false;
    const nodes = (plan.nodes as PlanNode[]).map((node) => {
      if (node.lease_id !== leaseId) return node;
      found = true;
      if (node.status !== "leased" || node.claimed_by !== owner) throw new Error("Lease owner does not match");
      return { ...node, lease_expires_at: new Date(Date.now() + ttl * 1_000).toISOString() } as PlanNode;
    });
    if (!found) throw new Error(`Unknown lease: ${leaseId}`);
    return this.store.updateIfVersion("orchestration_plan", String(plan.id), Number(plan.version), { ...plan, nodes });
  }
  orchestrationSubmit(args: JsonObject): JsonObject {
    const plan = this.get("orchestration_plan", "plan_id", args);
    const leaseId = text(args.lease_id, "lease_id");
    const idempotencyKey = args.idempotency_key === undefined ? null : text(args.idempotency_key, "idempotency_key");
    const receipts = array(plan.submission_receipts ?? [], "submission_receipts") as JsonObject[];
    const existing = idempotencyKey === null ? undefined : receipts.find((receipt) => receipt.idempotency_key === idempotencyKey);
    if (existing) {
      if (existing.lease_id !== leaseId || existing.verdict !== args.verdict) {
        throw new Error("idempotency_key belongs to a different submission");
      }
      return plan;
    }
    const leased = (plan.nodes as PlanNode[]).find((node) => node.lease_id === leaseId);
    if (!leased) throw new Error(`Unknown lease: ${leaseId}`);
    if (args.claimed_by !== undefined) {
      if (leased.claimed_by !== text(args.claimed_by, "claimed_by")) throw new Error("Lease owner does not match");
    }
    const provenance = String(args.provenance ?? "agent_reported");
    const verdict = text(args.verdict, "verdict");
    const costs = object(args.costs ?? {}, "costs");
    const accumulatedCosts = addCosts(object(plan.accumulated_costs ?? {}, "accumulated costs"), costs);
    const exceedsBudget = budgetExceeded(accumulatedCosts, budgetLimits(object(plan.budget ?? {}, "plan budget")));
    const artifactIds = array(args.artifact_ids ?? [], "artifact_ids").map((value) => text(value, "artifact_id"));
    const evidenceIds = array(args.evidence_ids ?? [], "evidence_ids").map((value) => text(value, "evidence_id"));
    for (const artifactId of artifactIds) this.store.get("artifact", artifactId);
    for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    const summary = args.summary === undefined ? null : text(args.summary, "summary");
    const submitted = submitNode(plan.nodes as PlanNode[], leaseId, verdict, provenance);
    const nodes = exceedsBudget ? submitted.map((node) => node.status === "pending"
      ? { ...node, status: "blocked", last_provenance: "budget_exceeded" } as PlanNode : node) : submitted;
    const status = planStatus(nodes);
    const saved = this.store.updateIfVersion("orchestration_plan", String(plan.id), Number(plan.version),
      { ...plan, nodes, status, accumulated_costs: accumulatedCosts, budget_exceeded: exceedsBudget,
        submission_receipts: idempotencyKey === null ? receipts : [...receipts, { idempotency_key: idempotencyKey,
          lease_id: leaseId, verdict }] });
    if (plan.trial_id) {
      this.trialTraceAppend({ trial_id: plan.trial_id, event_type: "orchestration.node_submitted",
        source: provenance, data: { node_id: leased.id,
          profile_id: leased.profile_ids[Number(leased.route_index)],
          profile_version: leased.profile_versions![Number(leased.route_index)],
          verdict, summary, costs }, artifact_ids: artifactIds, evidence_ids: evidenceIds });
      if (status !== "running") this.orchestrationTrialFinalize({ plan_id: saved.id });
    }
    return saved;
  }
  orchestrationTrialFinalize(args: JsonObject): JsonObject {
    const plan = this.get("orchestration_plan", "plan_id", args);
    if (!plan.trial_id) throw new Error("Orchestration plan is not linked to a Trial");
    if (plan.status === "running") throw new Error("Orchestration plan is still running");
    const trialId = String(plan.trial_id);
    if (this.store.find("outcome", `outcome_${trialId}`)) {
      return { plan, ...this.trialGet({ trial_id: trialId }) };
    }
    const result = orchestrationOutcome(plan.nodes as PlanNode[], Boolean(plan.budget_exceeded));
    const stableKey = createHash("sha256").update(`${plan.id}:${trialId}`).digest("hex");
    const artifactId = `artifact_${stableKey}`;
    const artifact = this.store.find("artifact", artifactId) ?? this.artifactRegister({ artifact_id: artifactId,
      kind: "orchestration_receipt",
      name: `Orchestration plan ${plan.id}`, uri: `craft://orchestration-plans/${plan.id}/versions/${plan.version}`,
      media_type: "application/json", producer_type: "orchestration_plan", producer_id: plan.id,
      metadata: { plan_version: plan.version } });
    const evidenceId = `evidence_${stableKey}`;
    const evidence = this.store.find("evidence", evidenceId) ?? this.evidenceRecord({ evidence_id: evidenceId,
      source_type: "orchestration", confidence: "confirmed",
      claim: `Orchestration plan ${plan.id} reached ${plan.status} from recorded node submissions.`,
      artifact_id: artifact.id, locator: { plan_id: plan.id, plan_version: plan.version } });
    const events = this.store.events(`trial:${trialId}`);
    if (!events.some((event) => event.event_type === "orchestration.completed")) {
      this.trialTraceAppend({ trial_id: trialId, event_type: "orchestration.completed", source: "program_verified",
        data: { status: plan.status, plan_version: plan.version }, artifact_ids: [artifact.id],
        evidence_ids: [evidence.id] });
    }
    const traceEvidence = this.store.events(`trial:${trialId}`).flatMap((event) =>
      (((event.payload as JsonObject).evidence_ids as string[] | undefined) ?? []));
    const startedAt = Date.parse(String(plan.trial_started_at));
    this.outcomeRecord({ trial_id: trialId, verdict: result.verdict, failure_type: result.failure_type ?? undefined,
      summary: result.verdict === "passed" ? "Orchestration completed all nodes." : "Orchestration did not complete all nodes.",
      scores: result.scores, costs: { ...(plan.accumulated_costs as JsonObject),
        wall_duration_ms: Math.max(0, Date.now() - startedAt) },
      evidence_ids: [...new Set(traceEvidence)], source: "orchestration_aggregated" });
    return { plan, ...this.trialGet({ trial_id: trialId }) };
  }

  contentStatus(): JsonObject { return this.contentMigration.status(); }
  contentVerify(args: JsonObject = {}): JsonObject { return this.contentMigration.verify(args); }
  contentMigrate(args: JsonObject = {}): JsonObject { return this.contentMigration.migrate(args) as unknown as JsonObject; }

  autonomousRuntimePrepare(args: JsonObject): JsonObject { return this.autonomousRuntime.prepare(args); }
  autonomousRuntimeCheckpoint(args: JsonObject): JsonObject { return this.autonomousRuntime.checkpoint(args); }
  autonomousRuntimeResume(args: JsonObject): JsonObject { return this.autonomousRuntime.resume(args); }
  autonomousRuntimeCancel(args: JsonObject): JsonObject { return this.autonomousRuntime.cancel(args); }
  autonomousRuntimeGet(args: JsonObject): JsonObject { return this.autonomousRuntime.get(args); }
  async autonomousRuntimeRun(args: JsonObject): Promise<JsonObject> {
    const turns = Array.isArray(args.turns) ? args.turns.map((turn) => object(turn, "turn")) : [];
    if (!turns.length) throw new Error("turns must contain at least one turn");
    let index = 0;
    const actionResults = object(args.action_results ?? {}, "action_results");
    const model = { next: async () => {
      const turn = turns[index] ?? { kind: "final", message: "No more scripted turns" };
      index += 1;
      return turn as import("../autonomous-runtime.ts").RuntimeTurn;
    } };
    const executor = async (action: string, input: JsonObject) => {
      const result = actionResults[action];
      return result && typeof result === "object" && !Array.isArray(result) ? result as JsonObject : { action, args: input, recorded: true };
    };
    return this.autonomousRuntime.run(args, model, executor);
  }

  async remoteInteropDispatch(args: JsonObject): Promise<JsonObject> {
    const status = String(args.status ?? "accepted") as "accepted" | "completed" | "failed";
    if (!new Set(["accepted", "completed", "failed"]).has(status)) throw new Error("Unsupported remote status");
    return this.remoteInterop.dispatch(args, { dispatch: async () => ({ remote_id: text(args.remote_id ?? `remote_${randomUUID().replaceAll("-", "")}`, "remote_id"), status, ...(args.result_digest === undefined ? {} : { result_digest: text(args.result_digest, "result_digest") }) }) });
  }
}

installAdapterRuntimeMethods(CraftService);
installKernelDelegateMethods(CraftService);
