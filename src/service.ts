import { createHash, randomUUID } from "node:crypto";
import { Catalog } from "./catalog.ts";
import { CraftStore, type JsonObject } from "./store.ts";
import { approvedEffects, executeSteps, normalizeSteps, resolveInputs, SIDE_EFFECTS, substitute } from "./workflow.ts";
import { addCosts, dispatchNodes, normalizeNodes, orchestrationOutcome, planStatus, recoverExpiredLeases, submitNode,
  type PlanNode } from "./orchestration.ts";
import { aggregateEvaluation, compareEvaluationAggregates, type EvaluationAggregate } from "./evaluation.ts";
import { publishSkill, rollbackSkillPublication } from "./skill-publisher.ts";
import { loadConfig } from "./config.ts";
import { OpenAiCompatibleEmbeddingProvider, type EmbeddingProvider } from "./semantic.ts";
import { LocalIsolatedAdapter } from "./isolated.ts";
import { decideExecution } from "./execution-policy.ts";

export const VERSION = "0.9.9";
const CONFIDENCE = new Set(["confirmed", "bounded", "unverified", "rejected"]);
const TASK_STATUS = new Set(["active", "paused", "completed", "cancelled"]);
const VERSIONED_LIFECYCLE = new Set(["draft", "candidate", "verified", "deprecated"]);
const TRIAL_VERDICTS = new Set(["passed", "failed", "blocked", "cancelled"]);
const EVAL_SPLITS = new Set(["search", "development", "held_out"]);
const HARNESS_DIMENSIONS = new Set(["context", "tools", "generation", "orchestration", "memory", "output"]);
const GRADER_TYPES = new Set(["program", "model", "human", "operational"]);
const GRADE_VERDICTS = new Set(["passed", "failed", "inconclusive"]);
const CAPABILITY_ASSET_TYPES = new Set(["skill", "mcp_server", "tool", "workflow", "adapter", "validator", "grader", "eval_suite"]);
const CAPABILITY_TRUST = new Set(["trusted", "untrusted", "verified"]);
const CAPABILITY_HEALTH = new Set(["healthy", "stale", "failed", "unknown"]);
const EXPERT_TYPES = new Set(["diagnostic_research"]);

function id(prefix: string): string { return `${prefix}_${randomUUID().replaceAll("-", "")}`; }
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}
function document(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value;
}
function finiteInteger(value: unknown, name: string, fallback: number, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return number;
}
function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}
function optionalScore(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  const score = Number(value);
  if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error(`${name} must be between 0 and 1`);
  return score;
}
function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}
function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}
function recordPayload(record: JsonObject): JsonObject {
  const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...payload } = record;
  return payload;
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
const RUNTIME_KINDS = new Set(["agent", "workflow", "grader"]);
const RUNTIME_ADAPTER_HOSTS = new Set(["codex", "claude", "generic"]);
const RUNTIME_RUN_TERMINAL = new Set(["completed", "failed", "cancelled"]);
const SECRET_ASSIGNMENT = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]+/iu;
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

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonObject).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value: JsonObject): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
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

function metricMean(aggregate: JsonObject, metric: string): number | null {
  const summary = (aggregate.costs as JsonObject)[metric] as JsonObject | undefined;
  return typeof summary?.mean === "number" && Number.isFinite(summary.mean) ? summary.mean : null;
}

function binomial(n: number, k: number): number {
  let value = 1;
  for (let index = 1; index <= k; index += 1) value = value * (n - k + index) / index;
  return value;
}

export class CraftService {
  readonly store: CraftStore;
  readonly catalog: Catalog;
  readonly isolatedAdapter: LocalIsolatedAdapter;
  constructor(store: CraftStore, semanticProvider?: EmbeddingProvider, isolatedAdapter = new LocalIsolatedAdapter()) { this.store = store; this.catalog = new Catalog(store, semanticProvider); this.isolatedAdapter = isolatedAdapter; }

  static async open(store: CraftStore): Promise<CraftService> {
    const config = await loadConfig(store.paths);
    const semanticProvider = config?.semanticSearch ? new OpenAiCompatibleEmbeddingProvider(config.semanticSearch.provider) : undefined;
    return new CraftService(store, semanticProvider);
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
      "capability_asset", "activation_profile", "tool_selection_receipt", "capability_call", "expert_profile", "context_capsule",
      "evaluation_reliability", "judge_adapter", "judge_calibration", "adaptation_candidate", "feedback_intake", "feedback_case", "canary"];
    return { version: VERSION, data_root: this.store.paths.root,
      counts: Object.fromEntries(kinds.map((kind) => [kind, this.store.count(kind)])) };
  }

  sourceAdd(args: JsonObject): Promise<JsonObject> {
    const label = args.label === undefined ? undefined : text(args.label, "label");
    return this.catalog.addSource(text(args.path, "path"), label,
      optionalBoolean(args.scan, "scan") ?? true);
  }
  sourceList(): JsonObject { return { sources: this.catalog.listSources() }; }
  sourceUpdate(args: JsonObject): JsonObject {
    return this.catalog.updateSource(text(args.source_id, "source_id"),
      optionalBoolean(args.enabled, "enabled"), args.label === undefined ? undefined : text(args.label, "label"));
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
  semanticSearchStatus(): JsonObject { return this.catalog.semanticStatus(); }
  executionPolicyDecide(args: JsonObject): JsonObject { return decideExecution(args); }
  capabilityGet(args: JsonObject): JsonObject {
    return this.catalog.get(text(args.asset_id, "asset_id"));
  }

  capabilityAssetSave(args: JsonObject): JsonObject {
    const assetType = text(args.asset_type, "asset_type"); const trust = String(args.trust ?? "untrusted");
    const health = String(args.health ?? "unknown"); const effect = text(args.effect, "effect");
    if (!CAPABILITY_ASSET_TYPES.has(assetType) || !CAPABILITY_TRUST.has(trust) || !CAPABILITY_HEALTH.has(health) || !SIDE_EFFECTS.has(effect)) {
      throw new Error("Capability asset type, trust, health, or effect is unsupported");
    }
    const sourceUri = assertNoSecret(text(args.source_uri, "source_uri"), "source_uri");
    const dependencies = optionalTextArray(args.dependencies, "dependencies");
    const aliases = optionalTextArray(args.aliases, "aliases");
    return this.saveVersioned("capability_asset", "asset", { ...args, asset_type: assetType, trust, health, effect, source_uri: sourceUri,
      dependencies, aliases, requires_credential: optionalBoolean(args.requires_credential, "requires_credential") ?? false,
      cost_hint: object(args.cost_hint ?? {}, "cost_hint"), source_digest: args.source_digest ?? fingerprint({ source_uri: sourceUri, asset_type: assetType }) }, ["name", "asset_type", "source_uri", "effect"]);
  }

  capabilityAccessPlan(args: JsonObject): JsonObject {
    const task = this.store.get("task", text(args.task_id, "task_id")); const goal = text(args.goal, "goal");
    const allowedEffects = uniqueTextArray(args.allowed_effects ?? ["read_only"], "allowed_effects");
    if (allowedEffects.some((effect) => !SIDE_EFFECTS.has(effect))) throw new Error("allowed_effects must be supported");
    const tokens = goal.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
    const candidates = this.store.list("capability_asset", 10000).map((asset) => {
      const searchable = `${String(asset.name)} ${(asset.aliases as string[]).join(" ")} ${String(asset.source_uri)}`.toLowerCase();
      const matched = tokens.filter((token) => searchable.includes(token)).length;
      const eligible = (asset.trust === "trusted" || asset.trust === "verified") && asset.health === "healthy" && allowedEffects.includes(String(asset.effect)) && !asset.requires_credential;
      const costHint = asset.cost_hint as JsonObject;
      const historical = Number(asset.historical_success_rate);
      const cost = Number(costHint.tokens); const latency = Number(costHint.latency_ms);
      return { asset, matched, eligible, verified_workflow: asset.asset_type === "workflow" && asset.trust === "verified" ? 1 : 0,
        historical: Number.isFinite(historical) ? historical : -1, cost: Number.isFinite(cost) ? cost : Number.MAX_SAFE_INTEGER,
        latency: Number.isFinite(latency) ? latency : Number.MAX_SAFE_INTEGER,
        reason: eligible ? "eligible" : asset.requires_credential ? "credential_broker_required" : asset.trust === "untrusted" ? "untrusted" : asset.health !== "healthy" ? `health_${asset.health}` : "effect_not_allowed" };
    }).sort((left, right) => right.matched - left.matched || right.verified_workflow - left.verified_workflow || right.historical - left.historical || left.cost - right.cost || left.latency - right.latency || String(left.asset.id).localeCompare(String(right.asset.id)));
    const selected = candidates.filter((item) => item.eligible && item.matched > 0).slice(0, 3);
    if (!selected.length) throw new Error("No eligible capability assets match this task");
    const profile = this.saveVersioned("activation_profile", "profile", { task_id: task.id, goal_fingerprint: fingerprint({ goal }), asset_ids: selected.map((item) => item.asset.id), asset_versions: Object.fromEntries(selected.map((item) => [String(item.asset.id), item.asset.version])), allowed_effects: allowedEffects, activation: "host_mediated", status: "recommended" }, []);
    const receipt = this.store.create("tool_selection_receipt", String(args.receipt_id ?? id("selection_receipt")), { task_id: task.id, profile_id: profile.id, profile_version: profile.version, candidate_asset_ids: candidates.map((item) => item.asset.id), filtered_asset_ids: candidates.filter((item) => !item.eligible).map((item) => ({ id: item.asset.id, reason: item.reason })), selected_asset_ids: selected.map((item) => item.asset.id), order: ["semantic", "effect", "verified_workflow", "history", "cost_latency"] });
    return { profile, receipt, candidates: candidates.map((item) => ({ asset_id: item.asset.id, matched: item.matched, verified_workflow: item.verified_workflow, historical_success_rate: item.historical, cost: item.cost, latency: item.latency, eligible: item.eligible, reason: item.reason })) };
  }

  capabilityCallIssue(args: JsonObject): JsonObject {
    const profile = this.store.get("activation_profile", text(args.profile_id, "profile_id")); const assetId = text(args.asset_id, "asset_id");
    if (!(profile.asset_ids as string[]).includes(assetId)) throw new Error("Capability asset is not in the activation profile");
    const call = this.store.create("capability_call", String(args.call_id ?? id("capability_call")), { profile_id: profile.id, profile_version: profile.version, asset_id: assetId, operation: assertNoSecret(text(args.operation, "operation"), "operation"), status: "issued", expires_at: args.expires_at ?? new Date(Date.now() + 300000).toISOString() });
    return { call_id: call.id, call };
  }

  capabilityCallConsume(args: JsonObject): JsonObject {
    const call = this.store.get("capability_call", text(args.call_id, "call_id"));
    if (call.profile_id !== text(args.profile_id, "profile_id")) throw new Error("Capability call profile does not match");
    if (call.status !== "issued") throw new Error("Capability call was already consumed");
    if (validIsoTime(call.expires_at, "expires_at") < Date.now()) throw new Error("Capability call has expired");
    return { receipt: this.store.save("capability_call", String(call.id), { ...recordPayload(call), status: "consumed", consumed_at: new Date().toISOString() }) };
  }

  expertProfileSave(args: JsonObject): JsonObject {
    const expertType = text(args.expert_type, "expert_type"); const effects = uniqueTextArray(args.allowed_effects, "allowed_effects");
    if (!EXPERT_TYPES.has(expertType) || effects.some((effect) => effect !== "read_only")) throw new Error("Only read-only diagnostic_research Expert is supported");
    return this.saveVersioned("expert_profile", "expert", { ...args, expert_type: expertType, allowed_effects: effects, output_contract: uniqueTextArray(args.output_contract, "output_contract"), max_subagents: 5 }, ["name", "expert_type"]);
  }

  contextCapsuleCreate(args: JsonObject): JsonObject {
    const task = this.store.get("task", text(args.task_id, "task_id")); const profile = this.store.get("expert_profile", text(args.profile_id, "profile_id"));
    const artifactIds = optionalTextArray(args.artifact_ids, "artifact_ids"); const evidenceIds = optionalTextArray(args.evidence_ids, "evidence_ids");
    for (const artifactId of artifactIds) this.store.get("artifact", artifactId); for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    return this.store.create("context_capsule", String(args.capsule_id ?? id("capsule")), { task_id: task.id, expert_id: profile.id, expert_version: profile.version, artifact_ids: artifactIds, evidence_ids: evidenceIds, input_boundary: assertNoSecret(text(args.input_boundary, "input_boundary"), "input_boundary") });
  }

  expertSubagentCreate(args: JsonObject): JsonObject {
    const run = this.store.get("runtime_run", text(args.run_id, "run_id")); const parent = this.store.get("runtime_operation", text(args.parent_operation_id, "parent_operation_id"));
    const expert = this.store.get("expert_profile", text(args.expert_id, "expert_id")); const capsule = this.store.get("context_capsule", text(args.capsule_id, "capsule_id"));
    if (parent.run_id !== run.id || capsule.task_id !== run.task_id || capsule.expert_id !== expert.id) throw new Error("Expert Sub-agent inputs are incompatible");
    if (this.runtimeOperations(String(run.id)).filter((operation) => operation.parent_operation_id === parent.id).length >= Number(expert.max_subagents)) throw new Error("Expert may create at most 5 Sub-agent Runs");
    return this.store.create("runtime_operation", String(args.operation_id ?? id("subagent")), { run_id: run.id, parent_operation_id: parent.id, depends_on: [parent.id], kind: "agent", effect: "read_only", objective: assertNoSecret(text(args.objective, "objective"), "objective"), agent_profile_id: expert.id, expert_id: expert.id, expert_version: expert.version, capsule_id: capsule.id, status: "pending", attempts: 0, submission_receipts: [] });
  }

  expertSubagentReport(args: JsonObject): JsonObject {
    const operation = this.store.get("runtime_operation", text(args.operation_id, "operation_id")); const report = object(args.report, "report");
    const required = ["hypotheses", "counterexamples", "evidence_ids", "confidence", "next_action"];
    if (required.some((key) => report[key] === undefined) || !Array.isArray(report.hypotheses) || !Array.isArray(report.counterexamples)) throw new Error("Expert report violates output contract");
    if (!Array.isArray(report.evidence_ids) || !report.evidence_ids.length) throw new Error("Evidence is required for an Expert report");
    const evidenceIds = uniqueTextArray(report.evidence_ids, "report.evidence_ids"); for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    if (!CONFIDENCE.has(text(report.confidence, "report.confidence"))) throw new Error("Expert report confidence is unsupported");
    return this.runtimeOperationSubmit({ operation_id: operation.id, lease_id: text(args.lease_id, "lease_id"), claimed_by: text(args.claimed_by, "claimed_by"), verdict: text(args.verdict, "verdict"), summary: assertNoSecret(JSON.stringify(report), "report"), evidence_ids: evidenceIds, costs: args.costs ?? {} });
  }

  projectPolicySave(args: JsonObject): JsonObject {
    const projectId = text(args.project_id, "project_id");
    const enforcement = String(args.enforcement ?? "required");
    if (!new Set(["required", "advisory"]).has(enforcement)) throw new Error(`Unsupported policy enforcement: ${enforcement}`);
    const policyId = String(args.policy_id ?? `project_policy_${createHash("sha256").update(projectId).digest("hex").slice(0, 24)}`);
    return this.saveVersioned("project_policy", "policy", { ...args, policy_id: policyId, project_id: projectId,
      enforcement, receipt_requirements: receiptRequirements(args.receipt_requirements, "receipt_requirements"),
    }, ["name"]);
  }

  private projectPolicy(projectId: unknown): JsonObject {
    if (typeof projectId !== "string" || !projectId) return { id: null, version: null, enforcement: "advisory",
      receipt_requirements: receiptRequirements(undefined, "default_receipt_requirements") };
    const policies = this.store.list("project_policy", 1_000, (policy) => policy.project_id === projectId)
      .sort((left, right) => Number(right.version) - Number(left.version) || String(right.id).localeCompare(String(left.id)));
    return policies[0] ?? { id: null, version: null, enforcement: "advisory",
      receipt_requirements: receiptRequirements(undefined, "default_receipt_requirements") };
  }

  runtimePolicySave(args: JsonObject): JsonObject {
    const allowedEffects = uniqueTextArray(args.allowed_effects ?? ["read_only"], "allowed_effects");
    const approvalEffects = args.require_approval_for === undefined ? []
      : uniqueTextArray(args.require_approval_for, "require_approval_for");
    if (allowedEffects.some((effect) => !SIDE_EFFECTS.has(effect)) || approvalEffects.some((effect) => !allowedEffects.includes(effect))) {
      throw new Error("Runtime policy effects must be supported and approval effects must be allowed");
    }
    return this.saveVersioned("runtime_policy", "runtime_policy", { ...args, allowed_effects: allowedEffects,
      require_approval_for: approvalEffects, max_concurrency: finiteInteger(args.max_concurrency, "max_concurrency", 1, 1, 32),
      max_attempts: finiteInteger(args.max_attempts, "max_attempts", 1, 1, 10),
      lease_ttl_seconds: finiteInteger(args.lease_ttl_seconds, "lease_ttl_seconds", 300, 1, 3_600),
      trusted_hosts: optionalTextArray(args.trusted_hosts, "trusted_hosts"),
      command_allowlist: optionalTextArray(args.command_allowlist, "command_allowlist"),
      path_allowlist: optionalTextArray(args.path_allowlist, "path_allowlist", ["."]),
      budget: budgetLimits(object(args.budget ?? {}, "budget")) }, ["name"]);
  }

  private runtimePolicy(args: JsonObject): JsonObject {
    return this.store.get("runtime_policy", text(args.policy_id, "policy_id"),
      args.policy_version === undefined ? undefined : finiteInteger(args.policy_version, "policy_version", 1));
  }

  runtimeAdapterSave(args: JsonObject): JsonObject {
    const host = text(args.host, "host");
    if (!RUNTIME_ADAPTER_HOSTS.has(host)) throw new Error("Runtime adapter host is unsupported");
    const allowedKinds = uniqueTextArray(args.allowed_kinds, "allowed_kinds");
    const allowedEffects = uniqueTextArray(args.allowed_effects, "allowed_effects");
    if (allowedKinds.some((kind) => !RUNTIME_KINDS.has(kind)) || allowedEffects.some((effect) => !SIDE_EFFECTS.has(effect))) {
      throw new Error("Runtime adapter kinds or effects are unsupported");
    }
    const environment = String(args.execution_environment ?? "local");
    if (!new Set(["local", "isolated"]).has(environment)) throw new Error("Runtime adapter execution_environment is unsupported");
    if (environment === "local" && allowedEffects.some((effect) => ["external_write", "destructive"].includes(effect))) {
      throw new Error("Runtime adapter local effects must not include external_write or destructive");
    }
    return this.saveVersioned("runtime_adapter", "runtime_adapter", { ...args, host, allowed_kinds: allowedKinds,
      allowed_effects: allowedEffects, execution_environment: environment,
      max_concurrency: finiteInteger(args.max_concurrency, "max_concurrency", 1, 1, 32),
      supports_pause_resume: optionalBoolean(args.supports_pause_resume, "supports_pause_resume") ?? false,
      supports_evidence_receipts: optionalBoolean(args.supports_evidence_receipts, "supports_evidence_receipts") ?? false,
    }, ["name", "host"]);
  }

  private runtimeAdapterOwner(adapter: JsonObject): string {
    return `runtime_adapter:${adapter.id}:${adapter.version}`;
  }

  runtimeAdapterDispatch(args: JsonObject): JsonObject {
    const adapter = this.store.get("runtime_adapter", text(args.runtime_adapter_id, "runtime_adapter_id"),
      args.runtime_adapter_version === undefined ? undefined : finiteInteger(args.runtime_adapter_version, "runtime_adapter_version", 1));
    const capacity = finiteInteger(args.capacity, "capacity", Number(adapter.max_concurrency), 1, Number(adapter.max_concurrency));
    const dispatch = this.runtimeDispatch({ run_id: text(args.run_id, "run_id"), claimed_by: this.runtimeAdapterOwner(adapter), capacity,
      kinds: adapter.allowed_kinds, effects: adapter.allowed_effects });
    return { adapter, ...dispatch };
  }

  runtimeAdapterReport(args: JsonObject): JsonObject {
    const adapter = this.store.get("runtime_adapter", text(args.runtime_adapter_id, "runtime_adapter_id"),
      args.runtime_adapter_version === undefined ? undefined : finiteInteger(args.runtime_adapter_version, "runtime_adapter_version", 1));
    const operation = this.store.get("runtime_operation", text(args.operation_id, "operation_id"));
    if (!(adapter.allowed_kinds as string[]).includes(String(operation.kind)) ||
        !(adapter.allowed_effects as string[]).includes(String(operation.effect))) {
      throw new Error("Runtime adapter is not authorized for this operation");
    }
    const summary = assertNoSecret(text(args.summary, "summary"), "summary");
    const artifact = this.artifactRegister({ kind: "runtime_adapter_receipt", name: `Runtime adapter ${operation.id}`,
      uri: `craft://runtime-adapter-receipts/${operation.id}/${operation.attempts}`, producer_type: "runtime_adapter",
      producer_id: adapter.id, metadata: { runtime_operation_id: operation.id, runtime_adapter_id: adapter.id,
        runtime_adapter_version: adapter.version, host: adapter.host } });
    const evidence = this.evidenceRecord({ source_type: "runtime_adapter", confidence: "bounded", claim: summary,
      artifact_id: artifact.id, locator: { runtime_operation_id: operation.id, runtime_adapter_id: adapter.id } });
    const submitted = this.runtimeOperationSubmit({ operation_id: operation.id, lease_id: text(args.lease_id, "lease_id"),
      claimed_by: this.runtimeAdapterOwner(adapter), verdict: text(args.verdict, "verdict"), summary,
      costs: args.costs ?? {}, retryable: optionalBoolean(args.retryable, "retryable") ?? false,
      artifact_ids: [...array(args.artifact_ids ?? [], "artifact_ids").map((value) => text(value, "artifact_id")), artifact.id],
      evidence_ids: [...array(args.evidence_ids ?? [], "evidence_ids").map((value) => text(value, "evidence_id")), evidence.id],
      idempotency_key: args.idempotency_key ?? `adapter:${adapter.id}:${operation.id}:${operation.attempts}` });
    return { adapter, artifact, evidence, ...submitted };
  }

  async localIsolatedExecute(args: JsonObject): Promise<JsonObject> {
    const run = this.store.get("runtime_run", text(args.run_id, "run_id")); const operation = this.store.get("runtime_operation", text(args.operation_id, "operation_id"));
    if (operation.run_id !== run.id) throw new Error("Runtime operation does not belong to run");
    const policy = this.runtimePolicy({ policy_id: run.policy_id, policy_version: run.policy_version });
    const command = text(args.command, "command"); const result = await this.isolatedAdapter.execute({ run_id: String(run.id), command,
      args: optionalTextArray(args.args, "args"), runtime_root: this.store.paths.runtimeDir, command_allowlist: policy.command_allowlist as string[],
      path_allowlist: policy.path_allowlist as string[], effect: String(operation.effect), cwd: args.cwd === undefined ? "." : text(args.cwd, "cwd"),
      requires_credential: optionalBoolean(args.requires_credential, "requires_credential") ?? false, compensation: args.compensation === undefined ? null : object(args.compensation, "compensation") });
    const artifact = this.artifactRegister({ kind: "local_isolated_receipt", name: `Local isolated ${operation.id}`, uri: `craft://isolated/${run.id}/${operation.id}`,
      producer_type: "local_isolated_adapter", producer_id: "builtin", metadata: { helper: result.helper, network: result.network, workspace: result.workspace } });
    const evidence = this.evidenceRecord({ source_type: "program", confidence: String(result.status) === "passed" ? "confirmed" : "rejected", claim: `Local isolated execution ${result.status}.`, artifact_id: artifact.id });
    const submitted = this.runtimeOperationSubmit({ operation_id: operation.id, lease_id: text(args.lease_id, "lease_id"), claimed_by: text(args.claimed_by, "claimed_by"),
      verdict: String(result.status) === "passed" ? "passed" : "failed", summary: "Local isolated adapter receipt", artifact_ids: [artifact.id], evidence_ids: [evidence.id], costs: args.costs ?? {}, idempotency_key: args.idempotency_key ?? `isolated:${operation.id}:${operation.attempts}` });
    return { result, artifact, evidence, ...submitted };
  }

  private runtimeOperations(runId: string): JsonObject[] {
    return this.store.list("runtime_operation", 10_000, (operation) => operation.run_id === runId)
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  }

  private runtimeTrace(run: JsonObject, eventType: string, data: JsonObject): void {
    this.store.appendEvent(`runtime:${run.id}`, eventType, data);
    if (typeof run.trial_id === "string" && run.trial_id) {
      this.trialTraceAppend({ trial_id: run.trial_id, event_type: `runtime.${eventType}`, source: "program_verified", data });
    }
  }

  private runtimeRunStatus(operations: JsonObject[]): string {
    if (operations.every((operation) => operation.status === "passed")) return "completed";
    if (operations.some((operation) => ["pending", "leased", "awaiting_approval"].includes(String(operation.status)))) return "running";
    return "failed";
  }

  runtimeRunStart(args: JsonObject): JsonObject {
    const task = this.store.get("task", text(args.task_id, "task_id"));
    const policy = this.runtimePolicy(args);
    const environment = object(args.environment, "environment");
    const requested = array(args.operations, "operations");
    if (!requested.length) throw new Error("operations must not be empty");
    const operationIds = new Set<string>();
    const operations = requested.map((raw, index) => {
      const input = object(raw, `operations[${index}]`);
      const operationId = text(input.operation_id, `operations[${index}].operation_id`);
      if (operationIds.has(operationId)) throw new Error("operation_id must be unique within a run");
      operationIds.add(operationId);
      const kind = text(input.kind, `operations[${index}].kind`);
      const effect = text(input.effect, `operations[${index}].effect`);
      if (!RUNTIME_KINDS.has(kind) || !SIDE_EFFECTS.has(effect) || !(policy.allowed_effects as string[]).includes(effect)) {
        throw new Error("Runtime operation kind or effect is not allowed by policy");
      }
      const parentOperationId = input.parent_operation_id === undefined ? null : text(input.parent_operation_id, `operations[${index}].parent_operation_id`);
      if (parentOperationId === operationId) throw new Error("Runtime operation cannot parent itself");
      const dependencies = input.depends_on === undefined ? (parentOperationId === null ? [] : [parentOperationId])
        : optionalTextArray(input.depends_on, `operations[${index}].depends_on`);
      if (dependencies.includes(operationId)) throw new Error("Runtime operation cannot depend on itself");
      const execution = input.execution === undefined ? null : object(input.execution, `operations[${index}].execution`);
      if (execution !== null) assertNoSecret(canonical(execution), `operations[${index}].execution`);
      return { operation_id: operationId, kind, effect, objective: assertNoSecret(text(input.objective, `operations[${index}].objective`), "objective"),
        agent_profile_id: input.agent_profile_id ?? null, parent_operation_id: parentOperationId,
        depends_on: dependencies, execution, status: "pending",
        attempts: 0, submission_receipts: [] };
    });
    if (operations.some((operation) => operation.depends_on.some((dependency) => !operationIds.has(String(dependency))))) {
      throw new Error("Runtime operation dependencies must belong to the same run");
    }
    for (const operation of operations) {
      if (this.store.find("runtime_operation", operation.operation_id)) {
        throw new Error("Runtime operation already exists");
      }
    }
    const runId = String(args.run_id ?? id("runtime_run"));
    const run = this.store.create("runtime_run", runId, { task_id: task.id, trial_id: args.trial_id ?? null,
      policy_id: policy.id, policy_version: policy.version, policy_fingerprint: fingerprint(recordPayload(policy)),
      environment_fingerprint: fingerprint(environment), status: "running", resource_ledger: {}, budget: policy.budget,
      max_concurrency: policy.max_concurrency });
    for (const operation of operations) this.store.create("runtime_operation", operation.operation_id, { run_id: run.id, ...operation });
    this.runtimeTrace(run, "started", { operation_ids: operations.map((operation) => operation.operation_id),
      environment_fingerprint: run.environment_fingerprint, policy_fingerprint: run.policy_fingerprint });
    return { run, operations: this.runtimeOperations(String(run.id)) };
  }

  runtimeRunGet(args: JsonObject): JsonObject {
    const run = this.store.get("runtime_run", text(args.run_id, "run_id"));
    return { run, operations: this.runtimeOperations(String(run.id)), trace: this.store.events(`runtime:${run.id}`) };
  }

  runtimeDispatch(args: JsonObject): JsonObject {
    const run = this.store.get("runtime_run", text(args.run_id, "run_id"));
    if (RUNTIME_RUN_TERMINAL.has(String(run.status))) return { run, operations: [] };
    if (run.status !== "running") return { run, operations: [], paused: run.status };
    const policy = this.runtimePolicy({ policy_id: run.policy_id, policy_version: run.policy_version });
    const claimedBy = text(args.claimed_by, "claimed_by");
    const capacity = finiteInteger(args.capacity, "capacity", Number(policy.max_concurrency), 1, Number(policy.max_concurrency));
    const kinds = args.kinds === undefined ? undefined : uniqueTextArray(args.kinds, "kinds");
    if (kinds?.some((kind) => !RUNTIME_KINDS.has(kind))) throw new Error("Runtime dispatch kinds must be supported");
    const effects = args.effects === undefined ? undefined : uniqueTextArray(args.effects, "effects");
    if (effects?.some((effect) => !SIDE_EFFECTS.has(effect))) throw new Error("Runtime dispatch effects must be supported");
    const operations = this.runtimeOperations(String(run.id));
    const active = operations.filter((operation) => operation.status === "leased").length;
    const passed = new Set(operations.filter((operation) => operation.status === "passed").map((operation) => String(operation.id)));
    const dispatched: JsonObject[] = [];
    for (const operation of operations) {
      const dependencies = Array.isArray(operation.depends_on) ? operation.depends_on.map(String)
        : operation.parent_operation_id ? [String(operation.parent_operation_id)] : [];
      if (dispatched.length >= Math.max(0, capacity - active) || operation.status !== "pending" ||
        (kinds !== undefined && !kinds.includes(String(operation.kind))) ||
        (effects !== undefined && !effects.includes(String(operation.effect))) || dependencies.some((dependency) => !passed.has(dependency))) continue;
      if ((policy.require_approval_for as string[]).includes(String(operation.effect)) &&
        (operation.approval as JsonObject | undefined)?.decision !== "approve") {
        const waiting = this.store.save("runtime_operation", String(operation.id), { ...recordPayload(operation), status: "awaiting_approval" });
        this.runtimeTrace(run, "awaiting_approval", { operation_id: waiting.id, effect: waiting.effect });
        continue;
      }
      const leaseId = id("runtime_lease");
      const leaseExpiresAt = new Date(Date.now() + Number(policy.lease_ttl_seconds) * 1_000).toISOString();
      const leased = this.store.save("runtime_operation", String(operation.id), { ...recordPayload(operation), status: "leased",
        lease_id: leaseId, claimed_by: claimedBy, lease_expires_at: leaseExpiresAt, attempts: Number(operation.attempts) + 1 });
      dispatched.push({ operation_id: leased.id, lease_id: leaseId, kind: leased.kind, effect: leased.effect,
        objective: leased.objective, agent_profile_id: leased.agent_profile_id, parent_operation_id: leased.parent_operation_id });
      this.runtimeTrace(run, "dispatched", { operation_id: leased.id, lease_id: leaseId, lease_expires_at: leaseExpiresAt, claimed_by: claimedBy });
    }
    return { run: this.store.get("runtime_run", String(run.id)), operations: dispatched };
  }

  runtimeOperationGet(args: JsonObject): JsonObject {
    return { operation: this.store.get("runtime_operation", text(args.operation_id, "operation_id")) };
  }

  runtimeOperationDecision(args: JsonObject): JsonObject {
    const operation = this.store.get("runtime_operation", text(args.operation_id, "operation_id"));
    if (operation.status !== "awaiting_approval") throw new Error("Runtime operation is not awaiting approval");
    const decision = text(args.decision, "decision");
    if (!new Set(["approve", "reject"]).has(decision)) throw new Error("Runtime approval decision must be approve or reject");
    const actor = text(args.actor, "actor");
    const status = decision === "approve" ? "pending" : "rejected";
    const saved = this.store.save("runtime_operation", String(operation.id), { ...recordPayload(operation), status,
      approval: { decision, actor, at: new Date().toISOString() } });
    const run = this.store.get("runtime_run", String(saved.run_id));
    this.runtimeTrace(run, `approval_${decision}`, { operation_id: saved.id, actor });
    if (decision === "reject") this.runtimeUpdateStatus(run);
    return { operation: saved, run: this.store.get("runtime_run", String(run.id)) };
  }

  private runtimeUpdateStatus(run: JsonObject, ledger?: JsonObject): JsonObject {
    const resourceLedger = ledger ?? (run.resource_ledger as JsonObject);
    const budget = run.budget as JsonObject;
    const status = budgetExceeded(resourceLedger, budget) ? "paused_budget" : this.runtimeRunStatus(this.runtimeOperations(String(run.id)));
    return this.store.save("runtime_run", String(run.id), { ...recordPayload(run), status, resource_ledger: resourceLedger });
  }

  runtimeOperationSubmit(args: JsonObject): JsonObject {
    const operation = this.store.get("runtime_operation", text(args.operation_id, "operation_id"));
    const receiptKey = args.idempotency_key === undefined ? null : text(args.idempotency_key, "idempotency_key");
    const receipts = array(operation.submission_receipts, "submission_receipts") as JsonObject[];
    if (receiptKey !== null && receipts.some((receipt) => receipt.idempotency_key === receiptKey)) {
      return this.runtimeRunGet({ run_id: operation.run_id });
    }
    if (operation.status !== "leased" || operation.lease_id !== text(args.lease_id, "lease_id") || operation.claimed_by !== text(args.claimed_by, "claimed_by")) {
      throw new Error("Runtime operation lease does not match");
    }
    const verdict = text(args.verdict, "verdict");
    if (!new Set(["passed", "failed", "cancelled"]).has(verdict)) throw new Error("Unsupported runtime operation verdict");
    const costs = args.costs === undefined ? {} : budgetLimits(object(args.costs, "costs"));
    const run = this.store.get("runtime_run", String(operation.run_id));
    const policy = this.runtimePolicy({ policy_id: run.policy_id, policy_version: run.policy_version });
    const artifactIds = array(args.artifact_ids ?? [], "artifact_ids").map((value) => text(value, "artifact_id"));
    const evidenceIds = array(args.evidence_ids ?? [], "evidence_ids").map((value) => text(value, "evidence_id"));
    for (const artifactId of artifactIds) this.store.get("artifact", artifactId);
    for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    const childIds = new Set<string>();
    const children = (args.children === undefined ? [] : array(args.children, "children")).map((raw, index) => {
      const child = object(raw, `children[${index}]`);
      const childId = text(child.operation_id, `children[${index}].operation_id`);
      if (childIds.has(childId) || this.store.find("runtime_operation", childId)) {
        throw new Error("Runtime child operation already exists");
      }
      childIds.add(childId);
      const kind = text(child.kind, `children[${index}].kind`);
      const effect = text(child.effect, `children[${index}].effect`);
      if (!RUNTIME_KINDS.has(kind) || !SIDE_EFFECTS.has(effect) || !(policy.allowed_effects as string[]).includes(effect)) {
        throw new Error("Runtime child kind or effect is not allowed by policy");
      }
      return { operation_id: childId, kind, effect,
        objective: assertNoSecret(text(child.objective, `children[${index}].objective`), "objective"),
        agent_profile_id: child.agent_profile_id ?? null };
    });
    const retryable = optionalBoolean(args.retryable, "retryable") ?? false;
    const status = verdict === "failed" && retryable && Number(operation.attempts) < Number(policy.max_attempts) ? "pending" : verdict;
    const saved = this.store.save("runtime_operation", String(operation.id), { ...recordPayload(operation), status,
      lease_id: null, lease_expires_at: null, claimed_by: null, artifact_ids: artifactIds, evidence_ids: evidenceIds,
      submission_receipts: receiptKey === null ? receipts : [...receipts, { idempotency_key: receiptKey, verdict, retryable }] });
    const ledger = addCosts(run.resource_ledger as JsonObject, costs);
    for (const child of children) {
      this.store.create("runtime_operation", child.operation_id, { run_id: run.id, ...child,
        parent_operation_id: saved.id, depends_on: [saved.id], status: "pending", attempts: 0, submission_receipts: [] });
    }
    const updatedRun = this.runtimeUpdateStatus(run, ledger);
    this.runtimeTrace(updatedRun, status === "pending" ? "retry_scheduled" : "submitted", { operation_id: saved.id, verdict,
      status, costs, artifact_ids: artifactIds, evidence_ids: evidenceIds, resource_ledger: ledger });
    return { operation: saved, run: updatedRun, operations: this.runtimeOperations(String(run.id)) };
  }

  runtimeLeaseRecover(args: JsonObject): JsonObject {
    const run = this.store.get("runtime_run", text(args.run_id, "run_id"));
    const now = args.now === undefined ? Date.now() : validIsoTime(args.now, "now");
    const policy = this.runtimePolicy({ policy_id: run.policy_id, policy_version: run.policy_version });
    const recovered: string[] = [];
    for (const operation of this.runtimeOperations(String(run.id))) {
      if (operation.status !== "leased" || validIsoTime(operation.lease_expires_at, "lease_expires_at") > now) continue;
      const exhausted = Number(operation.attempts) >= Number(policy.max_attempts);
      this.store.save("runtime_operation", String(operation.id), { ...recordPayload(operation), status: exhausted ? "failed" : "pending",
        lease_id: null, lease_expires_at: null, claimed_by: null });
      recovered.push(String(operation.id));
      this.runtimeTrace(run, exhausted ? "lease_exhausted" : "lease_recovered", { operation_id: operation.id, attempts: operation.attempts });
    }
    return { run: this.runtimeUpdateStatus(run), recovered_operation_ids: recovered };
  }

  private runtimeAuthorizeWorkflow(operation: JsonObject, policy: JsonObject): JsonObject {
    const execution = object(operation.execution, "runtime operation execution");
    const projectRoot = text(execution.project_root, "execution.project_root");
    const plan = this.workflowPlan({ workflow_id: text(execution.workflow_id, "execution.workflow_id"),
      version: execution.workflow_version, inputs: object(execution.inputs, "execution.inputs"),
      approved_side_effects: policy.allowed_effects });
    const paths = policy.path_allowlist as string[];
    const commands = policy.command_allowlist as string[];
    for (const step of plan.steps as JsonObject[]) {
      if (!["read_only", "local_write"].includes(String(step.side_effect))) {
        throw new Error("In-process Runtime Driver requires an isolated Host for external or destructive effects");
      }
      for (const field of ["path", "cwd", "report"]) {
        if (typeof step[field] === "string" && !policyAllowsPath(String(step[field]), paths)) {
          throw new Error(`Runtime policy does not allow workflow ${field}`);
        }
      }
      if (step.type === "command") {
        const command = array(step.command, "workflow command");
        if (!commands.includes(String(command[0]))) throw new Error("Runtime policy does not allow workflow command");
        const env = object(step.env ?? {}, "workflow command env");
        if (Object.keys(env).some((key) => /token|password|secret|key|cookie/iu.test(key))) {
          throw new Error("In-process Runtime Driver does not accept command secrets");
        }
      }
    }
    return { execution, project_root: projectRoot, plan };
  }

  runtimeDriverTick(args: JsonObject): JsonObject {
    const run = this.store.get("runtime_run", text(args.run_id, "run_id"));
    const driverId = text(args.driver_id, "driver_id");
    const policy = this.runtimePolicy({ policy_id: run.policy_id, policy_version: run.policy_version });
    if (!(policy.trusted_hosts as string[]).includes(driverId)) throw new Error("Runtime Driver is not a trusted host for this policy");
    this.runtimeLeaseRecover({ run_id: run.id });
    const dispatch = this.runtimeDispatch({ run_id: run.id, claimed_by: driverId, capacity: args.capacity, kinds: ["workflow"] });
    const executed: JsonObject[] = [];
    for (const leased of dispatch.operations as JsonObject[]) {
      const operation = this.store.get("runtime_operation", String(leased.operation_id));
      const startedAt = Date.now();
      try {
        const authorized = this.runtimeAuthorizeWorkflow(operation, policy);
        const execution = authorized.execution as JsonObject;
        const workflowRun = this.workflowRun({ workflow_id: execution.workflow_id, version: execution.workflow_version,
          project_root: authorized.project_root, inputs: execution.inputs, approved_side_effects: policy.allowed_effects });
        const artifact = this.artifactRegister({ kind: "runtime_workflow_receipt", name: `Runtime workflow ${workflowRun.id}`,
          uri: `craft://workflow-runs/${workflowRun.id}`, producer_type: "runtime_driver", producer_id: driverId,
          metadata: { runtime_run_id: run.id, operation_id: operation.id, workflow_id: workflowRun.workflow_id } });
        const passed = workflowRun.status === "passed";
        const evidence = this.evidenceRecord({ source_type: "program", confidence: "confirmed",
          claim: `Runtime Driver ${passed ? "passed" : "failed"} deterministic workflow checks.`, artifact_id: artifact.id,
          locator: { runtime_run_id: run.id, runtime_operation_id: operation.id, workflow_run_id: workflowRun.id } });
        const submission = this.runtimeOperationSubmit({ operation_id: operation.id, lease_id: leased.lease_id, claimed_by: driverId,
          verdict: passed ? "passed" : "failed", retryable: !passed, costs: { duration_ms: Date.now() - startedAt },
          artifact_ids: [artifact.id], evidence_ids: [evidence.id], idempotency_key: `driver:${operation.id}:${operation.attempts}` });
        executed.push({ operation_id: operation.id, workflow_run_id: workflowRun.id, status: (submission.operation as JsonObject).status });
      } catch {
        const evidence = this.evidenceRecord({ source_type: "program", confidence: "confirmed",
          claim: "Runtime Driver blocked or failed a controlled workflow operation.",
          locator: { runtime_run_id: run.id, runtime_operation_id: operation.id, error_type: "ExecutionError" } });
        const submission = this.runtimeOperationSubmit({ operation_id: operation.id, lease_id: leased.lease_id, claimed_by: driverId,
          verdict: "failed", retryable: false, costs: { duration_ms: Date.now() - startedAt }, evidence_ids: [evidence.id],
          idempotency_key: `driver:${operation.id}:${operation.attempts}` });
        executed.push({ operation_id: operation.id, status: (submission.operation as JsonObject).status, blocked: true });
      }
    }
    return { run: this.store.get("runtime_run", String(run.id)), executed,
      host_operations: this.runtimeOperations(String(run.id)).filter((operation) => operation.status === "pending" && operation.kind !== "workflow") };
  }

  runtimeRunResume(args: JsonObject): JsonObject {
    const run = this.store.get("runtime_run", text(args.run_id, "run_id"));
    const nextAction = RUNTIME_RUN_TERMINAL.has(String(run.status)) ? { kind: "completed", status: run.status }
      : run.status === "paused_budget" ? { kind: "await_budget", status: run.status }
        : { kind: "dispatch", status: run.status };
    return { run, next_action: nextAction };
  }

  runtimePromotionEligibility(args: JsonObject): JsonObject {
    const run = this.store.get("runtime_run", text(args.run_id, "run_id"));
    const policy = this.runtimePolicy(args);
    const policyMatches = run.policy_id === policy.id && Number(run.policy_version) === Number(policy.version) &&
      run.policy_fingerprint === fingerprint(recordPayload(policy));
    const environmentMatches = run.environment_fingerprint === fingerprint(object(args.environment, "environment"));
    return { eligible: policyMatches && environmentMatches, policy_matches: policyMatches,
      environment_matches: environmentMatches, run_id: run.id };
  }

  harnessSelect(args: JsonObject): JsonObject {
    const task = this.store.get("task", text(args.task_id, "task_id"));
    const risk = text(args.risk, "risk");
    if (!new Set(["low", "medium", "high"]).has(risk)) throw new Error("Harness risk must be low, medium, or high");
    const budget = budgetLimits(object(args.budget ?? {}, "budget"));
    const external = optionalBoolean(args.requires_external_effect, "requires_external_effect") ?? false;
    const topology = risk === "high" || external ? "planner_executor_evaluator" : risk === "medium" ? "incremental" : "single";
    const harness = this.harnessConfigurationSave({ configuration_id: String(args.harness_id ?? id("harness")),
      name: `Adaptive ${risk} harness`, dimensions: {
        context: { checkpoint_required: risk !== "low" }, tools: { external_effect_requires_approval: external },
        generation: { budget }, orchestration: { topology }, memory: { structured_handoff: risk === "high" },
        output: { independent_evaluator: topology === "planner_executor_evaluator" },
      } });
    const strategy = this.store.create("adaptive_harness", String(args.strategy_id ?? id("adaptive_harness")), {
      task_id: task.id, risk, budget, requires_external_effect: external, topology,
      harness_configuration_id: harness.id, harness_configuration_version: harness.version,
      next_action: topology === "single" ? "execute minimal verified path" : "create an Agent IR before dispatch",
    });
    return { strategy, harness };
  }

  agentIrCompile(args: JsonObject): JsonObject {
    const task = this.store.get("task", text(args.task_id, "task_id"));
    const harness = this.store.get("harness_configuration", text(args.harness_id, "harness_id"),
      args.harness_version === undefined ? undefined : finiteInteger(args.harness_version, "harness_version", 1));
    const operations = array(args.operations, "operations").map((raw, index) => {
      const item = object(raw, `operations[${index}]`); const operationId = text(item.id, `operations[${index}].id`);
      const kind = text(item.kind, `operations[${index}].kind`); const effect = text(item.effect, `operations[${index}].effect`);
      if (!RUNTIME_KINDS.has(kind) || !SIDE_EFFECTS.has(effect)) throw new Error("Agent IR operation kind or effect is unsupported");
      const dependsOn = optionalTextArray(item.depends_on, `operations[${index}].depends_on`);
      if (dependsOn.includes(operationId)) throw new Error("Agent IR operation cannot depend on itself");
      const execution = item.execution === undefined ? null : object(item.execution, `operations[${index}].execution`);
      if (execution !== null) assertNoSecret(canonical(execution), "Agent IR execution");
      return { id: operationId, kind, effect, objective: assertNoSecret(text(item.objective, `operations[${index}].objective`), "objective"),
        depends_on: dependsOn, agent_profile_id: item.agent_profile_id ?? null, execution };
    });
    if (!operations.length || new Set(operations.map((item) => item.id)).size !== operations.length) {
      throw new Error("Agent IR requires uniquely identified operations");
    }
    const ids = new Set(operations.map((item) => item.id));
    if (operations.some((item) => item.depends_on.some((dependency) => !ids.has(dependency)))) {
      throw new Error("Agent IR dependencies must belong to the same IR");
    }
    return this.store.create("agent_ir", String(args.ir_id ?? id("agent_ir")), { task_id: task.id, goal: text(args.goal, "goal"),
      harness_configuration_id: harness.id, harness_configuration_version: harness.version, operations, lifecycle: "compiled" });
  }

  agentIrLower(args: JsonObject): JsonObject {
    const ir = this.store.get("agent_ir", text(args.ir_id, "ir_id"),
      args.ir_version === undefined ? undefined : finiteInteger(args.ir_version, "ir_version", 1));
    const runId = args.run_id === undefined ? id("runtime_run") : text(args.run_id, "run_id");
    const operations = ir.operations as JsonObject[];
    const operationIds = new Map(operations.map((operation) => [String(operation.id), `${runId}:${operation.id}`]));
    const started = this.runtimeRunStart({ run_id: runId, task_id: ir.task_id, policy_id: text(args.policy_id, "policy_id"),
      policy_version: args.policy_version, trial_id: args.trial_id, environment: object(args.environment, "environment"), operations: operations.map((operation) => ({
        operation_id: operationIds.get(String(operation.id)), kind: operation.kind, effect: operation.effect, objective: operation.objective,
        agent_profile_id: operation.agent_profile_id, ...(operation.execution === null ? {} : { execution: operation.execution }),
        depends_on: (operation.depends_on as string[]).map((dependency) => operationIds.get(dependency)),
      })) });
    return { ir, ...started };
  }

  experienceShadowExperimentCreate(args: JsonObject): JsonObject {
    const task = this.store.get("task", text(args.task_id, "task_id"));
    const candidateId = text(args.mining_candidate_id, "mining_candidate_id");
    const candidate = this.store.find("experience_mining_candidate", candidateId);
    if (!candidate || candidate.lifecycle !== "proposal_only") {
      return { status: "rejected", reason: "Only an existing proposal-only mining candidate can enter shadow evaluation." };
    }
    const experiment = this.store.create("experience_shadow_experiment", String(args.experiment_id ?? id("shadow_experiment")), {
      task_id: task.id, mining_candidate_id: candidate.id, mining_candidate_version: candidate.version, status: "planned",
      rule: "Candidate changes must be evaluated in a separate held-out Suite and pass Promotion/Signoff before publication.",
    });
    return { status: "planned", experiment, candidate };
  }

  private assertShadowWorkflowReadOnly(workflow: JsonObject): void {
    const unsafe = (workflow.steps as JsonObject[] ?? []).find((step) => String(step.side_effect ?? "read_only") !== "read_only");
    if (unsafe) throw new Error("Shadow evaluation accepts read-only Workflow steps only");
  }

  experienceShadowExperimentEvaluate(args: JsonObject): JsonObject {
    const experiment = this.store.get("experience_shadow_experiment", text(args.experiment_id, "experiment_id"));
    if (experiment.status !== "planned") throw new Error("Only a planned shadow experiment can be evaluated");
    const candidate = this.store.get("experience_mining_candidate", String(experiment.mining_candidate_id),
      Number(experiment.mining_candidate_version));
    if (candidate.lifecycle !== "proposal_only") throw new Error("Shadow evaluation requires a proposal-only mining candidate");
    const suite = this.store.get("evaluation_suite", text(args.suite_id, "suite_id"),
      args.suite_version === undefined ? undefined : finiteInteger(args.suite_version, "suite_version", 1));
    if (!(suite.cases as JsonObject[]).some((item) => item.split === "held_out")) {
      throw new Error("Shadow evaluation requires an Evaluation Suite with held_out cases");
    }
    const baseline = this.store.get("workflow", text(args.baseline_workflow_id, "baseline_workflow_id"),
      finiteInteger(args.baseline_workflow_version, "baseline_workflow_version", 1));
    const proposed = this.store.get("workflow", text(args.candidate_workflow_id, "candidate_workflow_id"),
      finiteInteger(args.candidate_workflow_version, "candidate_workflow_version", 1));
    this.assertShadowWorkflowReadOnly(baseline); this.assertShadowWorkflowReadOnly(proposed);
    const policy = this.store.get("signoff_policy", text(args.signoff_policy_id, "signoff_policy_id"),
      finiteInteger(args.signoff_policy_version, "signoff_policy_version", 1));
    const runner = this.evaluationRunnerRun({ task_id: experiment.task_id, suite_id: suite.id, suite_version: suite.version,
      split: "held_out", project_root: text(args.project_root, "project_root"), trials_per_case: args.trials_per_case ?? 1,
      environment: args.environment ?? {}, budget: args.budget ?? {}, subjects: [
        { label: "baseline", subject_type: "workflow", subject_id: baseline.id, subject_version: baseline.version },
        { label: "candidate", subject_type: "workflow", subject_id: proposed.id, subject_version: proposed.version },
      ] });
    const comparison = (runner.comparisons as JsonObject[])[0];
    const promotion = this.evaluationPromotionAssess({ comparison_id: comparison.id, min_trials: args.min_trials,
      min_pass_rate_delta: args.min_pass_rate_delta, cost_metric: args.cost_metric,
      max_cost_regression_ratio: args.max_cost_regression_ratio,
      max_duration_regression_ratio: args.max_duration_regression_ratio });
    const status = promotion.eligible ? "signoff_ready" : "rejected";
    const shadowEvaluation = this.store.create("experience_shadow_evaluation", String(args.shadow_evaluation_id ?? id("shadow_evaluation")), {
      experiment_id: experiment.id, experiment_version: experiment.version, mining_candidate_id: candidate.id,
      mining_candidate_version: candidate.version, suite_id: suite.id, suite_version: suite.version,
      baseline_workflow_id: baseline.id, baseline_workflow_version: baseline.version,
      candidate_workflow_id: proposed.id, candidate_workflow_version: proposed.version,
      evaluation_runner_id: (runner.runner as JsonObject).id, comparison_id: comparison.id,
      promotion_id: (promotion.promotion as JsonObject).id, signoff_policy_id: policy.id,
      signoff_policy_version: policy.version, status,
      next_action: status === "signoff_ready"
        ? "Run the named Signoff Policy with independent Grades; publication remains disabled."
        : "Revise the proposal and create a new shadow experiment; publication remains disabled.",
    });
    const updated = this.store.save("experience_shadow_experiment", String(experiment.id), { ...recordPayload(experiment), status,
      shadow_evaluation_id: shadowEvaluation.id, promotion_id: (promotion.promotion as JsonObject).id });
    return { status, experiment: updated, shadow_evaluation: shadowEvaluation, runner, promotion,
      signoff_preparation: { policy, candidate_evaluation_run_id: (runner.evaluation_runs as JsonObject[])[1].id,
        eligible_promotion_id: promotion.eligible ? (promotion.promotion as JsonObject).id : null },
      publication_allowed: false };
  }

  hostAdapterSave(args: JsonObject): JsonObject {
    const host = text(args.host, "host");
    if (!new Set(["codex", "claude", "generic"]).has(host)) throw new Error(`Unsupported host adapter: ${host}`);
    const operations = uniqueTextArray(args.allowed_operations, "allowed_operations");
    if (operations.some((operation) => !HOST_OPERATIONS.has(operation))) throw new Error("allowed_operations contains an unsupported operation");
    return this.saveVersioned("host_adapter", "host_adapter", { ...args, host, allowed_operations: operations }, ["name", "host"]);
  }

  hostAdapterDispatch(args: JsonObject): JsonObject {
    const adapter = this.store.get("host_adapter", text(args.host_adapter_id, "host_adapter_id"),
      args.host_adapter_version === undefined ? undefined : finiteInteger(args.host_adapter_version, "host_adapter_version", 1));
    const route = this.store.get("route", text(args.route_id, "route_id"));
    const action = this.routeNextAction(route);
    const operation = String(action.kind);
    if (!HOST_OPERATIONS.has(operation) || !(adapter.allowed_operations as string[]).includes(operation)) {
      throw new Error(`Host adapter cannot dispatch route action: ${operation}`);
    }
    const dispatch = this.store.create("host_dispatch", String(args.dispatch_id ?? id("host_dispatch")), {
      host_adapter_id: adapter.id, host_adapter_version: adapter.version, route_id: route.id, action, status: "pending",
    });
    if (route.trial_id) this.trialTraceAppend({ trial_id: String(route.trial_id), event_type: "host.dispatch", source: "craft",
      data: { dispatch_id: dispatch.id, host_adapter_id: adapter.id, action: operation } });
    return { dispatch, action };
  }

  hostAdapterReport(args: JsonObject): JsonObject {
    const dispatch = this.store.get("host_dispatch", text(args.dispatch_id, "dispatch_id"));
    if (dispatch.status !== "pending") throw new Error("Host dispatch is already terminal");
    const status = text(args.status, "status");
    if (!new Set(["completed", "failed", "cancelled"]).has(status)) throw new Error(`Unsupported host dispatch status: ${status}`);
    const summary = assertNoSecret(text(args.summary, "summary"), "summary");
    const updated = this.store.save("host_dispatch", String(dispatch.id), { ...recordPayload(dispatch), status, summary });
    const route = this.store.get("route", String(dispatch.route_id));
    if (route.trial_id) this.trialTraceAppend({ trial_id: String(route.trial_id), event_type: "host.report", source: "host_reported",
      data: { dispatch_id: dispatch.id, status, summary } });
    return { dispatch: updated, next_action: this.routeNextAction(route) };
  }

  routeReceiptRecord(args: JsonObject): JsonObject {
    const route = this.store.get("route", text(args.route_id, "route_id"));
    if (route.workflow_id || ROUTE_TERMINAL.has(String(route.status))) throw new Error("Route receipts require an active safe route");
    const action = this.routeNextAction(route);
    const stageId = text(args.stage_id, "stage_id");
    if (action.kind !== "complete_stage" || action.stage_id !== stageId) throw new Error(`Route next required stage is ${action.stage_id ?? "none"}`);
    const kind = text(args.kind, "kind");
    if (!ROUTE_RECEIPT_KINDS.has(kind)) throw new Error(`Unsupported route receipt kind: ${kind}`);
    const status = text(args.status, "status");
    if (!ROUTE_RECEIPT_STATUS.has(status)) throw new Error(`Unsupported route receipt status: ${status}`);
    const command = assertNoSecret(text(args.command, "command"), "command");
    const summary = assertNoSecret(text(args.summary, "summary"), "summary");
    const receiptId = String(args.receipt_id ?? id("receipt"));
    const artifact = this.artifactRegister({ artifact_id: `artifact_${receiptId}`, kind: "route_receipt", name: `${stageId}:${kind}`,
      uri: args.uri === undefined ? `craft://route-receipt/${receiptId}` : text(args.uri, "uri"), producer_type: "host", producer_id: args.host_adapter_id ?? null,
      metadata: { route_id: route.id, stage_id: stageId, kind, status, command } });
    const evidence = this.evidenceRecord({ evidence_id: `evidence_${receiptId}`, source_type: "program",
      claim: summary, confidence: status === "passed" ? "confirmed" : status === "failed" ? "rejected" : "bounded", artifact_id: artifact.id,
      metadata: { route_id: route.id, stage_id: stageId, kind, status, command } });
    const receipt = this.store.create("route_receipt", receiptId, { route_id: route.id, stage_id: stageId, kind, status, command,
      summary, artifact_id: artifact.id, evidence_id: evidence.id });
    return { receipt, artifact, evidence };
  }

  defaultRoute(args: JsonObject, selectedCapabilities?: JsonObject[]): JsonObject {
    const goal = text(args.goal, "goal");
    const title = args.title === undefined ? goal.slice(0, 120) : text(args.title, "title");
    const mode = String(args.mode ?? "default");
    if (!new Set(["default", "safe_incremental_development"]).has(mode)) {
      throw new Error(`Unsupported route mode: ${mode}`);
    }
    const task = this.taskOpen({ title, goal, project_id: args.project_id ?? null }).task;
    const policy = this.projectPolicy(args.project_id);
    const tokens = goal.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
    const workflows = this.store.list("workflow", 1_000, (workflow) => workflow.lifecycle === "verified")
      .map((workflow) => ({ workflow, score: tokens.filter((token) =>
        JSON.stringify(workflow).toLowerCase().includes(token)).length }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || String(left.workflow.id).localeCompare(String(right.workflow.id)));
    const workflow = mode === "safe_incremental_development" ? null : workflows[0]?.workflow ?? null;
    const capabilities = selectedCapabilities ?? this.catalog.search(goal, 6);
    const developmentPlan = workflow === null ? { stages: SAFE_INCREMENTAL_STAGES.map((stage) => ({ ...stage })) } : null;
    const strategyCapabilities = developmentPlan === null ? [] : capabilities.slice(0, 3).map((capability) => String(capability.id));
    const strategyId = strategyCapabilities.length ? `route_strategy_${createHash("sha256")
      .update(JSON.stringify({ mode: "safe_incremental_development", capability_ids: strategyCapabilities })).digest("hex").slice(0, 24)}` : null;
    const strategy = strategyId === null ? null : this.store.find("route_strategy", strategyId) ?? this.store.create(
      "route_strategy", strategyId, { mode: "safe_incremental_development", capability_ids: strategyCapabilities });
    let route = this.store.create("route", id("route"), { task_id: (task as JsonObject).id, goal, mode,
      workflow_id: workflow?.id ?? null, workflow_version: workflow?.version ?? null,
      capability_ids: capabilities.map((capability) => capability.id), status: workflow ? "ready" : "awaiting_host",
      development_plan: developmentPlan, stage_state: developmentPlan?.stages.map((stage) => ({ id: stage.id, status: "pending" })) ?? [],
      strategy_id: strategy?.id ?? null, strategy_version: strategy?.version ?? null, trial_id: null,
      policy_id: policy.id, policy_version: policy.version, policy_enforcement: policy.enforcement,
      receipt_requirements: policy.receipt_requirements });
    if (developmentPlan !== null) {
      const subject = strategy ?? route;
      const trial = this.trialStart({ task_id: route.task_id, subject_type: strategy ? "route_strategy" : "route",
        subject_id: subject.id, subject_version: subject.version, environment: { route_id: route.id } });
      this.trialTraceAppend({ trial_id: trial.id, event_type: "route_started", source: "craft",
        data: { route_id: route.id, mode, strategy_id: strategy?.id ?? null } });
      route = this.store.save("route", String(route.id), { ...recordPayload(route), trial_id: trial.id });
    }
    return { route_id: route.id, task, workflow, capabilities, development_plan: developmentPlan, policy,
      executable: workflow !== null, next_action: this.routeNextAction(route) };
  }

  async defaultRouteWithSemanticSearch(args: JsonObject): Promise<JsonObject> {
    const goal = text(args.goal, "goal");
    return this.defaultRoute(args, await this.catalog.searchHybrid(goal, 6));
  }

  defaultRouteResume(args: JsonObject): JsonObject {
    const taskId = text(args.task_id, "task_id");
    const task = this.taskPack(taskId);
    const route = this.store.list("route", 1_000, (item) => item.task_id === taskId)[0];
    if (!route) throw new Error(`No route exists for task: ${taskId}`);
    const trial = route.trial_id ? this.trialGet({ trial_id: String(route.trial_id) }) : null;
    return { ...task, route, trial, next_action: this.routeNextAction(route) };
  }

  defaultRouteFind(args: JsonObject): JsonObject {
    const rawQuery = text(args.query, "query").toLowerCase();
    const query = rawQuery.replace(/^(继续|接着|恢复)(上次|之前|刚才|上一个|上回|上轮)?的?[\s,，:：]*/u, "").trim();
    const projectId = args.project_id === undefined ? undefined : text(args.project_id, "project_id");
    const tokens = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
    const candidates = query ? this.store.list("task", 1_000, (task) => {
      if (task.status !== "active" || (projectId !== undefined && task.project_id !== projectId)) return false;
      const searchable = `${task.title}\n${task.goal}`.toLowerCase();
      return searchable.includes(query) || tokens.some((token) => searchable.includes(token));
    }).map((task) => {
      const searchable = `${task.title}\n${task.goal}`.toLowerCase();
      const score = searchable.includes(query) ? 1_000 + query.length : tokens.filter((token) => searchable.includes(token)).length;
      return { task, score };
    }).filter((candidate) => candidate.score > 0) : [];
    const highest = candidates.reduce((score, candidate) => Math.max(score, candidate.score), 0);
    const best = candidates.filter((candidate) => candidate.score === highest)
      .sort((left, right) => String(left.task.id).localeCompare(String(right.task.id)));
    const summaries = best.map((candidate) => ({ task_id: candidate.task.id, title: candidate.task.title,
      goal: candidate.task.goal, project_id: candidate.task.project_id, score: candidate.score }));
    if (!best.length) return { status: "not_found", query, candidates: [] };
    if (best.length > 1) return { status: "ambiguous", query, candidates: summaries };
    return { status: "matched", query, candidates: summaries, ...this.defaultRouteResume({ task_id: best[0].task.id }) };
  }

  routeWorkflowProposalCreate(args: JsonObject): JsonObject {
    const route = this.store.get("route", text(args.route_id, "route_id"));
    if (route.workflow_id || route.status !== "completed") {
      throw new Error("Workflow proposals require a completed safe route");
    }
    const routeTrialId = text(route.trial_id, "route trial_id");
    const routeOutcome = this.store.get("outcome", `outcome_${routeTrialId}`);
    if (routeOutcome.verdict !== "passed" || !route.strategy_id) {
      throw new Error("Workflow proposals require a passed route with a reusable strategy");
    }
    const strategyId = String(route.strategy_id);
    const strategyVersion = Number(route.strategy_version);
    const candidate = (this.experienceCandidateList({}).experience_candidates as JsonObject[]).find((item) =>
      item.subject_type === "route_strategy" && item.subject_id === strategyId && Number(item.subject_version) === strategyVersion);
    const trialIds = (candidate?.passed_trial_ids ?? []) as string[];
    if (candidate?.status !== "ready_for_workflow_draft" || trialIds.length < 2) {
      throw new Error("Workflow proposals require two passed distinct routes with confirmed evidence");
    }
    const evidenceIds = [...new Set(trialIds.flatMap((trialId) =>
      this.store.get("outcome", `outcome_${trialId}`).evidence_ids as string[]))];
    const duplicate = this.store.list("workflow", 1_000, (workflow) => {
      const derived = workflow.derived_from as JsonObject | undefined;
      return workflow.lifecycle !== "deprecated" && derived?.route_strategy_id === strategyId &&
        Number(derived.route_strategy_version) === strategyVersion;
    });
    if (duplicate.length) throw new Error("A non-deprecated Workflow draft already exists for this route strategy");
    const stepsInput = array(args.steps, "steps");
    if (!stepsInput.length) throw new Error("Workflow proposals require at least one step");
    const workflow = this.workflowSave({ workflow_id: args.workflow_id, name: text(args.name, "name"),
      description: args.description === undefined ? "Evidence-backed draft derived from safe routes." : document(args.description, "description"),
      inputs: array(args.inputs ?? [], "inputs"), steps: normalizeSteps(stepsInput), derived_from: {
        route_id: route.id, route_trial_id: routeTrialId, route_strategy_id: strategyId, route_strategy_version: strategyVersion,
        trial_ids: trialIds, evidence_ids: evidenceIds,
      } });
    return { workflow, trial_ids: trialIds, evidence_ids: evidenceIds,
      next_action: "Run development and held-out evaluations before promoting this draft Workflow." };
  }

  defaultRouteUpdate(args: JsonObject): JsonObject {
    const route = this.store.get("route", text(args.route_id, "route_id"));
    if (ROUTE_TERMINAL.has(String(route.status))) throw new Error("Route is already terminal");
    if (route.workflow_id) throw new Error("Verified Workflow routes must use craft_default_route_execute");
    const developmentPlan = object(route.development_plan, "route development_plan");
    const stages = array(developmentPlan.stages, "route development_plan stages") as JsonObject[];
    const states = array(route.stage_state, "route stage_state") as JsonObject[];
    const index = states.findIndex((state) => state.status !== "completed");
    if (index < 0 || !stages[index]) throw new Error("Route has no pending stage");
    const stageId = text(args.stage_id, "stage_id");
    const summary = text(args.summary, "summary");
    if (stageId !== stages[index].id) throw new Error(`Route next required stage is ${stages[index].id}`);
    const receiptIds = array(args.receipt_ids ?? [], "receipt_ids").map((value) => text(value, "receipt_id"));
    if (new Set(receiptIds).size !== receiptIds.length) throw new Error("receipt_ids must be unique");
    const receipts = receiptIds.map((receiptId) => this.store.get("route_receipt", receiptId));
    if (receipts.some((receipt) => receipt.route_id !== route.id || receipt.stage_id !== stageId)) {
      throw new Error("Route receipts must belong to the current route stage");
    }
    const requiredKinds = array((route.receipt_requirements as JsonObject | undefined)?.[stageId] ?? [], "receipt requirements")
      .map((kind) => String(kind));
    if (route.policy_enforcement === "required" && requiredKinds.some((kind) => !receipts.some((receipt) =>
      receipt.kind === kind && receipt.status === "passed"))) {
      throw new Error(`Route stage requires required receipts: ${requiredKinds.join(", ")}`);
    }
    const artifactIds = [...new Set([...array(args.artifact_ids ?? [], "artifact_ids").map((value) => text(value, "artifact_id")),
      ...receipts.map((receipt) => String(receipt.artifact_id))])];
    const evidenceIds = [...new Set([...array(args.evidence_ids ?? [], "evidence_ids").map((value) => text(value, "evidence_id")),
      ...receipts.map((receipt) => String(receipt.evidence_id))])];
    for (const artifactId of artifactIds) this.store.get("artifact", artifactId);
    for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    const isFinal = index === stages.length - 1;
    const verdict = args.verdict === undefined ? undefined : text(args.verdict, "verdict");
    if (!isFinal && verdict !== undefined) throw new Error("verdict is only allowed for the final route stage");
    if (isFinal && verdict === undefined) throw new Error("verdict is required for the final route stage");
    if (verdict !== undefined && !TRIAL_VERDICTS.has(verdict)) throw new Error(`Unsupported trial verdict: ${verdict}`);
    const updatedStates = states.map((state, stateIndex) => stateIndex === index
      ? { ...state, status: "completed", summary, artifact_ids: artifactIds, evidence_ids: evidenceIds }
      : state);
    const taskStatus = verdict === undefined ? "active" : verdict === "passed" ? "completed" : verdict === "cancelled" ? "cancelled" : "paused";
    const task = this.taskCheckpoint({ task_id: route.task_id, summary, status: taskStatus,
      completed: updatedStates.filter((state) => state.status === "completed").map((state) => state.id),
      pending: updatedStates.filter((state) => state.status !== "completed").map((state) => state.id),
      decisions: [`Route ${route.id} completed stage ${stageId}`], artifacts: artifactIds, source: "craft_route" });
    const trialId = text(route.trial_id, "route trial_id");
    this.trialTraceAppend({ trial_id: trialId, event_type: "route_stage_completed", source: "host_reported",
      data: { route_id: route.id, stage_id: stageId, summary, receipt_ids: receiptIds }, artifact_ids: artifactIds, evidence_ids: evidenceIds });
    const outcome = verdict === undefined ? null : this.outcomeRecord({ trial_id: trialId, verdict,
      summary, evidence_ids: evidenceIds, source: "host_reported" });
    const updated = this.store.save("route", String(route.id), { ...recordPayload(route), stage_state: updatedStates,
      status: verdict === undefined ? "awaiting_host" : verdict === "passed" ? "completed" : verdict });
    return { route: updated, task: task.task, checkpoint: (task.checkpoints as JsonObject[])[0], outcome,
      trace: (this.trialGet({ trial_id: trialId }).trace), next_action: this.routeNextAction(updated),
      experience_candidates: verdict === undefined ? [] : this.experienceCandidateList({}).experience_candidates };
  }

  private routeNextAction(route: JsonObject): JsonObject {
    if (ROUTE_TERMINAL.has(String(route.status))) return { kind: "completed", route_id: route.id, status: route.status };
    if (route.workflow_id) return { kind: "execute_verified_workflow", route_id: route.id,
      workflow_id: route.workflow_id, workflow_version: route.workflow_version };
    const plan = object(route.development_plan, "route development_plan");
    const stages = array(plan.stages, "route development plan stages") as JsonObject[];
    const states = array(route.stage_state, "route stage_state") as JsonObject[];
    const index = states.findIndex((state) => state.status !== "completed");
    if (index < 0 || !stages[index]) return { kind: "complete_route", route_id: route.id };
    return { kind: "complete_stage", route_id: route.id, stage_id: stages[index].id,
      constraints: stages[index].constraints, expected_evidence: stages[index].evidence,
      required_receipts: (route.receipt_requirements as JsonObject | undefined)?.[String(stages[index].id)] ?? [] };
  }

  defaultRouteExecute(args: JsonObject): JsonObject {
    const route = this.store.get("route", text(args.route_id, "route_id"));
    if (!route.workflow_id) throw new Error("Route has no verified Workflow to execute; complete the host plan first");
    const workflow = this.store.get("workflow", String(route.workflow_id), Number(route.workflow_version));
    if (workflow.lifecycle !== "verified") throw new Error("Route Workflow is no longer verified");
    const result = this.workflowTrialRun({ ...args, task_id: route.task_id, workflow_id: route.workflow_id,
      version: route.workflow_version });
    const completed = this.store.save("route", String(route.id), { ...recordPayload(route), status: "completed",
      workflow_run_id: (result.workflow_run as JsonObject | null)?.id ?? null,
      trial_id: (result.trial as JsonObject).id });
    return { route: completed, ...result, experience_candidates: this.experienceCandidateList({}).experience_candidates };
  }

  experienceCandidateList(_args: JsonObject): JsonObject {
    const groups = new Map<string, { subject_type: string; subject_id: string; subject_version: number;
      trial_ids: string[]; passed_trial_ids: string[]; task_ids: string[]; evidence_ids: string[]; confirmed_evidence_ids: string[] }>();
    for (const trial of this.store.list("trial", 1_000)) {
      const outcome = this.store.find("outcome", `outcome_${trial.id}`);
      const evidence = outcome?.evidence_ids;
      if (!outcome || !Array.isArray(evidence) || !evidence.length) continue;
      const key = `${trial.subject_type}:${trial.subject_id}:${trial.subject_version}`;
      const group = groups.get(key) ?? { subject_type: String(trial.subject_type), subject_id: String(trial.subject_id),
        subject_version: Number(trial.subject_version), trial_ids: [], passed_trial_ids: [], task_ids: [], evidence_ids: [], confirmed_evidence_ids: [] };
      const confirmed = evidence.map((evidenceId) => this.store.get("evidence", String(evidenceId)))
        .filter((item) => item.confidence === "confirmed" || item.confidence === "bounded").map((item) => String(item.id));
      group.trial_ids.push(String(trial.id));
      group.task_ids.push(String(trial.task_id));
      if (outcome.verdict === "passed" && confirmed.length) group.passed_trial_ids.push(String(trial.id));
      group.evidence_ids.push(...evidence.map((evidenceId) => String(evidenceId)));
      group.confirmed_evidence_ids.push(...confirmed);
      groups.set(key, group);
    }
    const experienceCandidates = [...groups.values()].filter((group) => group.trial_ids.length >= 2).map((group) => {
      const passedTrialIds = [...group.passed_trial_ids].sort();
      const taskIds = [...new Set(group.task_ids)].sort();
      const ready = passedTrialIds.length >= 2 && taskIds.length >= 2;
      return { ...group, trial_ids: [...group.trial_ids].sort(), passed_trial_ids: passedTrialIds, task_ids: taskIds,
        evidence_ids: [...new Set(group.evidence_ids)].sort(), confirmed_evidence_ids: [...new Set(group.confirmed_evidence_ids)].sort(),
        pass_rate: passedTrialIds.length / group.trial_ids.length, status: ready ? "ready_for_workflow_draft" : "insufficient_confirmed_evidence",
        next_action: ready ? "Review applicability and create an Experience Pattern or draft Workflow." :
          "Collect independent passed routes with confirmed or bounded evidence." };
    });
    return { experience_candidates: experienceCandidates };
  }

  taskOpen(args: JsonObject): JsonObject {
    if (args.task_id) return this.taskPack(String(args.task_id));
    const taskId = id("task");
    this.store.save("task", taskId, { title: text(args.title, "title"), goal: text(args.goal, "goal"),
      project_id: args.project_id ?? null, status: "active" });
    return this.taskPack(taskId);
  }
  taskList(args: JsonObject): JsonObject {
    const status = args.status as string | undefined;
    if (status !== undefined && !TASK_STATUS.has(status)) throw new Error(`Unsupported task status: ${status}`);
    return { tasks: this.store.list("task", Number(args.limit ?? 10), (item) =>
      (status === undefined || item.status === status) &&
      (args.project_id === undefined || item.project_id === args.project_id)) };
  }
  taskCheckpoint(args: JsonObject): JsonObject {
    const taskId = text(args.task_id, "task_id");
    const task = this.store.get("task", taskId);
    const status = String(args.status ?? task.status);
    if (!TASK_STATUS.has(status)) throw new Error(`Unsupported task status: ${status}`);
    const checkpointId = id("checkpoint");
    const completed = array(args.completed ?? [], "completed");
    const pending = array(args.pending ?? [], "pending");
    const decisions = array(args.decisions ?? [], "decisions");
    const artifacts = array(args.artifacts ?? [], "artifacts");
    this.store.saveBatch([{ kind: "checkpoint", id: checkpointId, payload: {
      task_id: taskId, summary: text(args.summary, "summary"), completed, pending, decisions, artifacts,
      source: args.source ?? "agent_reported" } }, { kind: "task", id: taskId,
      payload: { ...task, status, latest_checkpoint_id: checkpointId } }]);
    return this.taskPack(taskId);
  }
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
    return this.store.appendEvent(`trial:${trialId}`, text(args.event_type, "event_type"), {
      trial_id: trialId, source: args.source ?? "agent_reported",
      data: object(args.data ?? {}, "data"), artifact_ids: artifactIds, evidence_ids: evidenceIds,
    });
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
    return this.store.create("outcome", `outcome_${trialId}`, {
      trial_id: trialId, verdict, summary: text(args.summary, "summary"),
      failure_type: failureType,
      scores: object(args.scores ?? {}, "scores"), costs: object(args.costs ?? {}, "costs"),
      evidence_ids: evidenceIds, source: args.source ?? "program_verified",
    });
  }

  trialGet(args: JsonObject): JsonObject {
    const trialId = text(args.trial_id, "trial_id");
    const trial = this.store.get("trial", trialId);
    const outcome = this.store.find("outcome", `outcome_${trialId}`);
    return { trial, trace: this.store.events(`trial:${trialId}`), outcome };
  }

  evaluationRunRecord(args: JsonObject): JsonObject {
    const suite = this.store.get("evaluation_suite", text(args.suite_id, "suite_id"),
      args.suite_version === undefined ? undefined : finiteInteger(args.suite_version, "suite_version", 1));
    const split = String(args.split);
    if (!EVAL_SPLITS.has(split)) throw new Error(`Unsupported evaluation split: ${split}`);
    const subjectType = text(args.subject_type, "subject_type");
    const subjectId = text(args.subject_id, "subject_id");
    const subjectVersion = finiteInteger(args.subject_version, "subject_version", 1);
    this.store.get(subjectType, subjectId, subjectVersion);
    const trialIds = array(args.trial_ids, "trial_ids").map((value) => text(value, "trial_id"));
    if (!trialIds.length || new Set(trialIds).size !== trialIds.length) {
      throw new Error("trial_ids must contain unique trials");
    }
    const cases = array(suite.cases ?? [], "suite cases") as JsonObject[];
    const allowedCases = new Set(cases.filter((item) => item.split === split).map((item) => String(item.case_id)));
    const outcomes = trialIds.map((trialId) => {
      const trial = this.store.get("trial", trialId);
      if (trial.subject_type !== subjectType || trial.subject_id !== subjectId ||
          Number(trial.subject_version) !== subjectVersion) throw new Error(`Trial subject mismatch: ${trialId}`);
      if (!trial.case_id || !allowedCases.has(String(trial.case_id))) {
        throw new Error(`Trial case is not in the ${split} suite partition: ${trialId}`);
      }
      const outcome = this.store.find("outcome", `outcome_${trialId}`);
      if (!outcome) throw new Error(`Trial has no outcome: ${trialId}`);
      return outcome;
    });
    const verdict = outcomes.every((outcome) => outcome.verdict === "passed") ? "passed" : "failed";
    return this.store.create("evaluation_run", String(args.run_id ?? id("evalrun")), {
      suite_id: suite.id, suite_version: suite.version, split, subject_type: subjectType,
      subject_id: subjectId, subject_version: subjectVersion, trial_ids: trialIds, verdict,
      metrics: object(args.metrics ?? {}, "metrics"),
    });
  }

  evaluationRunAggregate(args: JsonObject): JsonObject {
    const run = this.store.get("evaluation_run", text(args.run_id, "run_id"));
    const trials = (run.trial_ids as string[]).map((trialId) => this.store.get("trial", trialId));
    const outcomes = trials.map((trial) => this.store.get("outcome", `outcome_${trial.id}`));
    return aggregateEvaluation(run, trials, outcomes);
  }

  evaluationCompare(args: JsonObject): JsonObject {
    const baselineId = text(args.baseline_run_id, "baseline_run_id");
    const candidateId = text(args.candidate_run_id, "candidate_run_id");
    if (baselineId === candidateId) throw new Error("Evaluation comparison requires two different runs");
    const baseline = this.evaluationRunAggregate({ run_id: baselineId }) as EvaluationAggregate;
    const candidate = this.evaluationRunAggregate({ run_id: candidateId }) as EvaluationAggregate;
    for (const field of ["suite_id", "suite_version", "split", "subject_type"] as const) {
      if (baseline[field] !== candidate[field]) throw new Error(`Evaluation runs are not comparable: ${field} differs`);
    }
    if (JSON.stringify(baseline.case_ids) !== JSON.stringify(candidate.case_ids)) {
      throw new Error("Evaluation runs are not comparable: case_ids differ");
    }
    return this.store.create("evaluation_comparison", String(args.comparison_id ?? id("comparison")), {
      baseline_run_id: baselineId, candidate_run_id: candidateId,
      suite_id: baseline.suite_id, suite_version: baseline.suite_version, split: baseline.split,
      subject_type: baseline.subject_type, case_ids: baseline.case_ids,
      baseline, candidate, comparison: compareEvaluationAggregates(baseline, candidate),
    });
  }

  evaluationRunnerRun(args: JsonObject): JsonObject {
    const taskId = text(args.task_id, "task_id");
    this.store.get("task", taskId);
    const suite = this.store.get("evaluation_suite", text(args.suite_id, "suite_id"),
      args.suite_version === undefined ? undefined : finiteInteger(args.suite_version, "suite_version", 1));
    const split = text(args.split, "split");
    if (!EVAL_SPLITS.has(split)) throw new Error(`Unsupported evaluation split: ${split}`);
    const projectRoot = text(args.project_root, "project_root");
    const trialsPerCase = finiteInteger(args.trials_per_case, "trials_per_case", 1, 1, 20);
    const subjects = array(args.subjects, "subjects").map((raw, index) => {
      const subject = object(raw, `subjects[${index}]`);
      if (text(subject.subject_type, `subjects[${index}].subject_type`) !== "workflow") {
        throw new Error("Automatic Eval Runner currently executes only workflow subjects; Agent subjects require a Host runtime operation");
      }
      const subjectId = text(subject.subject_id, `subjects[${index}].subject_id`);
      const subjectVersion = finiteInteger(subject.subject_version, `subjects[${index}].subject_version`, 1);
      this.store.get("workflow", subjectId, subjectVersion);
      return { label: text(subject.label, `subjects[${index}].label`), subject_id: subjectId, subject_version: subjectVersion };
    });
    if (subjects.length < 2 || new Set(subjects.map((subject) => subject.label)).size !== subjects.length) {
      throw new Error("Eval Runner requires at least two uniquely labelled subjects");
    }
    const cases = (suite.cases as JsonObject[]).filter((item) => item.split === split);
    if (!cases.length) throw new Error(`Evaluation Suite has no ${split} cases`);
    const runner = this.store.create("evaluation_runner", String(args.runner_id ?? id("eval_runner")), { task_id: taskId,
      suite_id: suite.id, suite_version: suite.version, split, trials_per_case: trialsPerCase, status: "running",
      subjects, environment_fingerprint: fingerprint(object(args.environment ?? {}, "environment")) });
    const evaluationRuns = subjects.map((subject) => {
      const trialIds: string[] = [];
      for (const item of cases) for (let attempt = 1; attempt <= trialsPerCase; attempt += 1) {
        const trial = this.workflowTrialRun({ trial_id: id("trial"), task_id: taskId, workflow_id: subject.subject_id,
          version: subject.subject_version, case_id: item.case_id, project_root: projectRoot,
          inputs: object(item.inputs ?? {}, "case inputs"), environment: args.environment ?? {}, budget: args.budget ?? {} });
        trialIds.push(String((trial.trial as JsonObject).id));
      }
      return this.evaluationRunRecord({ suite_id: suite.id, suite_version: suite.version, split, subject_type: "workflow",
        subject_id: subject.subject_id, subject_version: subject.subject_version, trial_ids: trialIds });
    });
    const comparisons = evaluationRuns.slice(1).map((candidate, index) => this.evaluationCompare({
      baseline_run_id: evaluationRuns[0].id, candidate_run_id: candidate.id,
      comparison_id: `${runner.id}_${index + 1}` }));
    const completed = this.store.save("evaluation_runner", String(runner.id), { ...recordPayload(runner), status: "completed",
      evaluation_run_ids: evaluationRuns.map((run) => run.id), comparison_ids: comparisons.map((comparison) => comparison.id) });
    return { runner: completed, evaluation_runs: evaluationRuns, comparisons, comparison: comparisons[0].comparison,
      aggregate: { baseline_trials: (evaluationRuns[0].trial_ids as string[]).length,
        candidate_trials: (evaluationRuns[1].trial_ids as string[]).length, cases: cases.length, trials_per_case: trialsPerCase } };
  }

  evaluationProgramGrade(args: JsonObject): JsonObject {
    const evaluation = this.store.get("evaluation_run", text(args.evaluation_run_id, "evaluation_run_id"));
    const grader = this.store.get("grader", text(args.grader_id, "grader_id"),
      args.grader_version === undefined ? undefined : finiteInteger(args.grader_version, "grader_version", 1));
    if (grader.grader_type !== "program") throw new Error("Automatic evaluation grading requires a program grader");
    const configuration = object(grader.configuration, "grader configuration");
    const minimumPassRate = configuration.minimum_pass_rate === undefined ? 1 : Number(configuration.minimum_pass_rate);
    const maximumDuration = configuration.maximum_mean_duration_ms === undefined ? Number.POSITIVE_INFINITY
      : Number(configuration.maximum_mean_duration_ms);
    if (!Number.isFinite(minimumPassRate) || minimumPassRate < 0 || minimumPassRate > 1 ||
      (!Number.isFinite(maximumDuration) && maximumDuration !== Number.POSITIVE_INFINITY) || maximumDuration < 0) {
      throw new Error("Program grader configuration is invalid");
    }
    const aggregate = this.evaluationRunAggregate({ run_id: evaluation.id });
    const duration = (aggregate.costs as JsonObject).duration_ms as JsonObject | undefined;
    const passed = Number(aggregate.pass_rate) >= minimumPassRate && (duration?.mean === undefined || Number(duration.mean) <= maximumDuration);
    const grades = (evaluation.trial_ids as string[]).map((trialId) => {
      const gradeId = `grade_${createHash("sha256").update(JSON.stringify([trialId, grader.id, grader.version])).digest("hex")}`;
      const existing = this.store.find("grade", gradeId);
      if (existing) return existing;
      const outcome = this.store.get("outcome", `outcome_${trialId}`);
      return this.gradeRecord({ trial_id: trialId, grader_id: grader.id, grader_version: grader.version,
        verdict: passed ? "passed" : "failed", score: Number(aggregate.pass_rate),
        summary: `Program grader evaluated evaluation run ${evaluation.id}.`, evidence_ids: outcome.evidence_ids,
        metadata: { evaluation_run_id: evaluation.id, pass_rate: aggregate.pass_rate, minimum_pass_rate: minimumPassRate,
          maximum_mean_duration_ms: maximumDuration } });
    });
    return { grades, passed, aggregate };
  }

  private evaluationPairedComparison(baselineRun: JsonObject, candidateRun: JsonObject): JsonObject {
    const indexed = (run: JsonObject) => {
      const occurrences = new Map<string, number>();
      return new Map((run.trial_ids as string[]).map((trialId) => {
        const trial = this.store.get("trial", trialId); const caseId = String(trial.case_id);
        const occurrence = (occurrences.get(caseId) ?? 0) + 1; occurrences.set(caseId, occurrence);
        return [`${caseId}:${occurrence}`, this.store.get("outcome", `outcome_${trialId}`)];
      }));
    };
    const baseline = indexed(baselineRun); const candidate = indexed(candidateRun);
    let candidateWins = 0; let baselineWins = 0; let ties = 0;
    for (const [key, baselineOutcome] of baseline) {
      const candidateOutcome = candidate.get(key)!;
      const baselinePassed = baselineOutcome.verdict === "passed"; const candidatePassed = candidateOutcome.verdict === "passed";
      if (candidatePassed && !baselinePassed) candidateWins += 1;
      else if (baselinePassed && !candidatePassed) baselineWins += 1;
      else ties += 1;
    }
    return { matched_trials: candidateWins + baselineWins + ties, candidate_wins: candidateWins,
      baseline_wins: baselineWins, ties, unmatched_baseline_trials: baseline.size - (candidateWins + baselineWins + ties),
      unmatched_candidate_trials: candidate.size - (candidateWins + baselineWins + ties) };
  }

  evaluationPromotionAssess(args: JsonObject): JsonObject {
    const comparison = this.store.get("evaluation_comparison", text(args.comparison_id, "comparison_id"));
    const baselineRun = this.store.get("evaluation_run", String(comparison.baseline_run_id));
    const candidateRun = this.store.get("evaluation_run", String(comparison.candidate_run_id));
    const minTrials = finiteInteger(args.min_trials, "min_trials", 2, 1, 10_000);
    const minimumDelta = args.min_pass_rate_delta === undefined ? 0 : Number(args.min_pass_rate_delta);
    const maximumCostRatio = args.max_cost_regression_ratio === undefined ? Number.POSITIVE_INFINITY : Number(args.max_cost_regression_ratio);
    const maximumDurationRatio = args.max_duration_regression_ratio === undefined ? Number.POSITIVE_INFINITY : Number(args.max_duration_regression_ratio);
    const costMetric = args.cost_metric === undefined ? "tokens" : text(args.cost_metric, "cost_metric");
    if (!Number.isFinite(minimumDelta) || minimumDelta < -1 || minimumDelta > 1 ||
      (!Number.isFinite(maximumCostRatio) && maximumCostRatio !== Number.POSITIVE_INFINITY) || maximumCostRatio < 0 ||
      (!Number.isFinite(maximumDurationRatio) && maximumDurationRatio !== Number.POSITIVE_INFINITY) || maximumDurationRatio < 0) {
      throw new Error("Promotion thresholds are invalid");
    }
    const baseline = comparison.baseline as JsonObject; const candidate = comparison.candidate as JsonObject;
    const paired = this.evaluationPairedComparison(baselineRun, candidateRun);
    const baselineCost = metricMean(baseline, costMetric); const candidateCost = metricMean(candidate, costMetric);
    const baselineDuration = metricMean(baseline, "duration_ms"); const candidateDuration = metricMean(candidate, "duration_ms");
    const costRatio = baselineCost === null || candidateCost === null ? null : candidateCost / Math.max(1, baselineCost);
    const durationRatio = baselineDuration === null || candidateDuration === null ? null : candidateDuration / Math.max(1, baselineDuration);
    const checks = [
      { check: "held_out", passed: comparison.split === "held_out" },
      { check: "minimum_trials", passed: Number(baseline.total) >= minTrials && Number(candidate.total) >= minTrials },
      { check: "pass_rate", passed: Number(candidate.pass_rate) - Number(baseline.pass_rate) >= minimumDelta },
      { check: "cost_regression", passed: maximumCostRatio === Number.POSITIVE_INFINITY || (costRatio !== null && costRatio <= maximumCostRatio) },
      { check: "duration_regression", passed: maximumDurationRatio === Number.POSITIVE_INFINITY || (durationRatio !== null && durationRatio <= maximumDurationRatio) },
      { check: "paired_cases", passed: Number(paired.matched_trials) >= minTrials },
    ];
    const eligible = checks.every((check) => check.passed);
    const promotion = this.store.create("evaluation_promotion", String(args.promotion_id ?? id("promotion")), {
      comparison_id: comparison.id, baseline_run_id: baselineRun.id, candidate_run_id: candidateRun.id, eligible, checks,
      paired, thresholds: { min_trials: minTrials, min_pass_rate_delta: minimumDelta, cost_metric: costMetric,
        max_cost_regression_ratio: maximumCostRatio, max_duration_regression_ratio: maximumDurationRatio },
    });
    return { eligible, promotion, comparison: { ...comparison, paired, cost_metric: costMetric,
      cost_regression_ratio: costRatio, duration_regression_ratio: durationRatio } };
  }

  evaluationReliabilityAssess(args: JsonObject): JsonObject {
    const comparison = this.store.get("evaluation_comparison", text(args.comparison_id, "comparison_id"));
    const baselineRun = this.store.get("evaluation_run", String(comparison.baseline_run_id)); const candidateRun = this.store.get("evaluation_run", String(comparison.candidate_run_id));
    const minTrials = finiteInteger(args.min_trials, "min_trials", 20, 2, 10_000); const maxBudgetRatio = Number(args.max_budget_ratio ?? 1);
    if (!Number.isFinite(maxBudgetRatio) || maxBudgetRatio < 0) throw new Error("max_budget_ratio must be non-negative");
    const paired = this.evaluationPairedComparison(baselineRun, candidateRun);
    const baselineTrials = (baselineRun.trial_ids as string[]).map((trialId) => this.store.get("trial", trialId));
    const candidateTrials = (candidateRun.trial_ids as string[]).map((trialId) => this.store.get("trial", trialId));
    const baselineEnvironment = object(baselineTrials[0].environment, "baseline environment");
    const environmentsMatch = [...baselineTrials, ...candidateTrials].every((trial) => fingerprint(object(trial.environment, "trial environment")) === fingerprint(baselineEnvironment));
    const budgetsMatch = [...baselineTrials, ...candidateTrials].every((trial) => {
      const baselineBudget = object(baselineTrials[0].budget, "baseline budget"); const ratio = Number(Object.entries(object(trial.budget, "trial budget")).every(([key, value]) => Number(value) <= Number(baselineBudget[key]) * maxBudgetRatio));
      return ratio === 1;
    });
    const decisive = Number(paired.candidate_wins) + Number(paired.baseline_wins);
    const pValue = decisive === 0 ? 1 : 2 ** -decisive * Array.from({ length: Number(paired.baseline_wins) + 1 }, (_, index) => binomial(decisive, Number(paired.candidate_wins) + index)).reduce((sum, value) => sum + value, 0);
    const status = Number(paired.matched_trials) < minTrials || !environmentsMatch || !budgetsMatch ? "inconclusive" : pValue <= 0.05 && Number(paired.candidate_wins) > Number(paired.baseline_wins) ? "eligible" : "rejected";
    const assessment = this.store.create("evaluation_reliability", String(args.assessment_id ?? id("reliability")), { comparison_id: comparison.id, status, min_trials: minTrials, max_budget_ratio: maxBudgetRatio, paired, p_value: pValue, environments_match: environmentsMatch, budgets_match: budgetsMatch });
    return { status, assessment };
  }

  judgeAdapterSave(args: JsonObject): JsonObject {
    const graderType = text(args.grader_type, "grader_type"); if (!new Set(["model", "human"]).has(graderType)) throw new Error("Judge adapter must be model or human");
    return this.saveVersioned("judge_adapter", "judge", { ...args, grader_type: graderType, status: "uncalibrated" }, ["name", "grader_type"]);
  }

  judgeCalibrationRecord(args: JsonObject): JsonObject {
    const judge = this.store.get("judge_adapter", text(args.judge_id, "judge_id")); const total = finiteInteger(args.total, "total", 1, 1); const agreed = finiteInteger(args.agreed, "agreed", 0, 0, total);
    const minimum = Number(args.minimum_agreement ?? 0.8); if (!Number.isFinite(minimum) || minimum < 0 || minimum > 1) throw new Error("minimum_agreement must be between 0 and 1");
    const agreement = agreed / total; const calibration = this.store.create("judge_calibration", String(args.calibration_id ?? id("calibration")), { judge_id: judge.id, judge_version: judge.version, total, agreed, agreement, minimum_agreement: minimum, status: agreement >= minimum ? "calibrated" : "advisory" });
    this.store.save("judge_adapter", String(judge.id), { ...recordPayload(judge), status: calibration.status, calibration_id: calibration.id });
    return { calibration };
  }

  judgePromotionEligible(args: JsonObject): JsonObject {
    const judge = this.store.get("judge_adapter", text(args.judge_id, "judge_id")); return { eligible: judge.status === "calibrated", judge };
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
    const authorized = this.store.save("adaptation_candidate", String(candidate.id), { ...recordPayload(candidate), lifecycle: "canary_ready", reliability_assessment_id: assessment.id, signoff_id: signoff.id, publication_allowed: false });
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
    return this.saveVersioned("workflow", "workflow", { ...args, lifecycle: "draft" }, ["name"]);
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
}
