import { CraftService, VERSION } from "./service.ts";
import { type JsonObject } from "./store.ts";

type Tool = { name: string; description: string; inputSchema: JsonObject; annotations?: JsonObject };
const schemaFor = (name: string): JsonObject => {
  if (["scan", "enabled", "allow_execution", "allow_external_write", "require_held_out", "require_outcome_passed"].includes(name)) return { type: "boolean" };
  if (["limit", "version", "capacity", "max_concurrency", "size_bytes", "subject_version",
    "suite_version", "configuration_version", "harness_configuration_version", "target_version",
    "grader_version", "policy_version", "lease_ttl_seconds"].includes(name)) return { type: "integer" };
  if (["score"].includes(name)) return { type: "number" };
  if (["inputs", "metadata", "policy", "dimensions", "environment", "budget", "data", "scores",
    "costs", "metrics", "configuration"].includes(name)) return { type: "object" };
  if (["completed", "pending", "decisions", "artifacts", "steps", "cases", "capabilities",
    "allowed_side_effects", "approved_side_effects", "nodes", "artifact_ids", "evidence_ids",
    "trial_ids", "requirements", "grade_ids", "pattern_ids", "failure_modes"].includes(name)) return { type: "array" };
  return { type: "string" };
};
const objectSchema = (required: string[] = [], optional: string[] = []): JsonObject => ({ type: "object",
  properties: Object.fromEntries([...required, ...optional].map((name) => [name, schemaFor(name)])), required,
  additionalProperties: false });
const tool = (name: string, description: string, required: string[] = [], readOnly = false,
  optional: string[] = []): Tool => ({
  name, description, inputSchema: objectSchema(required, optional), ...(readOnly ? { annotations: { readOnlyHint: true } } : {}),
});

export const TOOLS: Tool[] = [
  tool("craft_info", "Show the Craft version, data location, and record counts.", [], true),
  tool("craft_source_add", "Add and optionally scan a local capability directory.", ["path"], false, ["label", "scan"]),
  tool("craft_source_list", "List configured capability sources and resolved paths.", [], true),
  tool("craft_source_update", "Enable, disable, or relabel a source.", ["source_id"], false, ["enabled", "label"]),
  tool("craft_source_remove", "Remove a source index without deleting its files.", ["source_id"]),
  tool("craft_source_scan", "Incrementally scan one or all enabled sources.", [], false, ["source_id"]),
  tool("craft_capability_search", "Return a small ranked set of matching capabilities.", ["query"], true, ["limit"]),
  tool("craft_capability_get", "Read one indexed capability.", ["asset_id"], true),
  tool("craft_default_route", "Create a durable route that prefers matching verified Workflows and otherwise returns the shortest safe host plan.",
    ["goal"], false, ["title", "project_id", "mode"]),
  tool("craft_default_route_execute", "Run the exact verified Workflow selected by a route and capture its Trial lifecycle.",
    ["route_id", "project_root"], false, ["inputs", "allow_execution", "approved_side_effects", "case_id",
      "harness_configuration_id", "harness_configuration_version", "environment", "budget"]),
  tool("craft_default_route_resume", "Resume a durable default route and return only its next safe action.", ["task_id"], true),
  tool("craft_default_route_find", "Find one uniquely matching active default route for a natural-language continuation; never guess on a tie.",
    ["query"], true, ["project_id"]),
  tool("craft_route_workflow_proposal_create", "Create only a draft Workflow from two or more passed evidence-backed safe routes; promotion still requires evaluation.",
    ["route_id", "name", "steps"], false, ["workflow_id", "description", "inputs"]),
  tool("craft_default_route_update", "Record one required safe-plan stage with real evidence; the final stage records the route Outcome.",
    ["route_id", "stage_id", "summary"], false, ["artifact_ids", "evidence_ids", "verdict"]),
  tool("craft_task_open", "Create a durable task or resume one by ID.", [], false, ["task_id", "title", "goal", "project_id"]),
  tool("craft_task_list", "List durable tasks.", [], true, ["limit", "status", "project_id"]),
  tool("craft_task_checkpoint", "Persist task progress, evidence references, and pending work.", ["task_id", "summary"], false, ["completed", "pending", "decisions", "artifacts", "status", "source"]),
  tool("craft_feedback_record", "Record an explicit scoped correction or preference.", ["corrected"], false, ["kind", "scope", "task_id", "original", "applies_to", "source"]),
  tool("craft_artifact_register", "Register a portable artifact reference.", ["kind", "name", "uri"], false, ["artifact_id", "media_type", "digest", "size_bytes", "producer_type", "producer_id", "metadata"]),
  tool("craft_artifact_get", "Read an artifact reference.", ["artifact_id"], true),
  tool("craft_artifact_list", "List artifact references.", [], true, ["limit", "query"]),
  tool("craft_evidence_record", "Record a claim with source and confidence.", ["source_type", "claim"], false, ["evidence_id", "confidence", "artifact_id", "locator", "observed_at", "metadata"]),
  tool("craft_evidence_get", "Read an evidence record.", ["evidence_id"], true),
  tool("craft_evidence_list", "List evidence records.", [], true, ["limit", "query"]),
  tool("craft_workflow_save", "Save a new draft workflow version.", ["name"], false, ["workflow_id", "inputs", "steps", "description"]),
  tool("craft_workflow_get", "Read a workflow version.", ["workflow_id"], true, ["version"]),
  tool("craft_workflow_search", "Search reusable workflows.", [], true, ["limit", "query"]),
  tool("craft_workflow_plan", "Resolve inputs and side-effect approvals without executing.", ["workflow_id"], true, ["version", "inputs", "allow_execution", "approved_side_effects"]),
  tool("craft_workflow_run", "Execute deterministic Workflow steps with explicit side-effect approval.", ["workflow_id", "project_root"], false, ["version", "inputs", "allow_execution", "approved_side_effects"]),
  tool("craft_workflow_trial_run", "Execute a Workflow and automatically capture its Trial, Trace, Artifact, Evidence, and Outcome.",
    ["task_id", "workflow_id", "project_root"], false, ["trial_id", "case_id", "version", "inputs",
      "allow_execution", "approved_side_effects", "harness_configuration_id",
      "harness_configuration_version", "environment", "budget"]),
  tool("craft_workflow_run_get", "Read a durable Workflow execution receipt.", ["run_id"], true),
  tool("craft_workflow_transition", "Move a workflow through draft, candidate, verified, or deprecated with evidence gates.",
    ["workflow_id", "target", "reason"], false, ["evaluation_run_id", "signoff_id"]),
  tool("craft_workflow_rollback", "Restore a previously verified workflow version as the latest version.",
    ["workflow_id", "target_version", "reason"]),
  tool("craft_experience_pattern_create", "Derive a reusable experience pattern from at least two completed Trials and their Evidence references.",
    ["task_id", "summary", "success_strategy", "applicability", "trial_ids", "evidence_ids", "failure_modes"], false,
    ["pattern_id"]),
  tool("craft_experience_pattern_get", "Read an experience pattern.", ["pattern_id"], true, ["version"]),
  tool("craft_experience_pattern_list", "List reusable experience patterns.", [], true, ["limit", "query"]),
  tool("craft_experience_candidate_list", "List automatic Experience Pattern candidates backed by at least two completed Trials with Evidence.", [], true),
  tool("craft_skill_proposal_create", "Save a versioned SKILL.md candidate derived from Experience Patterns; this does not change any source file.",
    ["name", "summary", "skill_markdown", "pattern_ids"], false, ["proposal_id"]),
  tool("craft_skill_proposal_get", "Read a versioned Skill candidate.", ["proposal_id"], true, ["version"]),
  tool("craft_skill_proposal_list", "List Skill candidates.", [], true, ["limit", "query"]),
  tool("craft_skill_proposal_transition", "Move a Skill candidate through the existing held-out Evaluation and Signoff Gate.",
    ["proposal_id", "target", "reason"], false, ["evaluation_run_id", "signoff_id"]),
  tool("craft_skill_proposal_rollback", "Restore a previously verified Skill candidate version as the latest version.",
    ["proposal_id", "target_version", "reason"]),
  tool("craft_skill_proposal_publish", "Write only a verified Skill candidate to an existing SKILL.md with explicit authorization, digest protection, and backup.",
    ["proposal_id", "source_id", "target_path", "expected_digest", "allow_external_write"], false,
    ["publication_id"]),
  tool("craft_skill_publication_get", "Read a Skill publication receipt.", ["publication_id"], true, ["version"]),
  tool("craft_skill_publication_list", "List Skill publication receipts.", [], true, ["limit", "query"]),
  tool("craft_skill_publication_rollback", "Restore a published SKILL.md only when its digest still matches the published candidate.",
    ["publication_id", "expected_digest", "allow_external_write"]),
  tool("craft_eval_suite_save", "Save an immutable evaluation suite.", ["name"], false, ["suite_id", "cases", "description", "scope"]),
  tool("craft_eval_suite_get", "Read an evaluation suite.", ["suite_id"], true, ["version"]),
  tool("craft_eval_suite_list", "Search evaluation suites.", [], true, ["limit", "query"]),
  tool("craft_harness_configuration_save", "Save a versioned six-dimensional harness configuration.",
    ["name", "dimensions"], false, ["configuration_id", "description"]),
  tool("craft_harness_configuration_get", "Read a harness configuration version.",
    ["configuration_id"], true, ["version"]),
  tool("craft_harness_configuration_list", "List harness configurations.", [], true, ["limit", "query"]),
  tool("craft_trial_start", "Create an immutable execution trial linked to a task and exact subject version.",
    ["task_id", "subject_type", "subject_id", "subject_version"], false,
    ["trial_id", "case_id", "harness_configuration_id", "harness_configuration_version", "environment", "budget"]),
  tool("craft_trial_trace_append", "Append an immutable trace event to a trial.", ["trial_id", "event_type"],
    false, ["source", "data", "artifact_ids", "evidence_ids"]),
  tool("craft_trial_get", "Read a trial with its trace and outcome.", ["trial_id"], true),
  tool("craft_trial_list", "List immutable trials.", [], true, ["limit", "query"]),
  tool("craft_outcome_record", "Record the single immutable outcome for a trial.",
    ["trial_id", "verdict", "summary"], false, ["failure_type", "scores", "costs", "evidence_ids", "source"]),
  tool("craft_evaluation_run_record", "Record a reproducible evaluation from completed trials in one suite partition.",
    ["suite_id", "split", "subject_type", "subject_id", "subject_version", "trial_ids"], false,
    ["run_id", "suite_version", "metrics"]),
  tool("craft_evaluation_run_get", "Read an immutable evaluation run.", ["run_id"], true),
  tool("craft_evaluation_run_list", "List evaluation runs.", [], true, ["limit", "query"]),
  tool("craft_evaluation_run_aggregate", "Compute reproducible quality, score, cost, duration, and failure aggregates for an evaluation run.", ["run_id"], true),
  tool("craft_evaluation_compare", "Compare two runs only when suite version, split, subject type, and case set match.",
    ["baseline_run_id", "candidate_run_id"], false, ["comparison_id"]),
  tool("craft_evaluation_comparison_get", "Read an immutable evaluation comparison.", ["comparison_id"], true),
  tool("craft_evaluation_comparison_list", "List immutable evaluation comparisons.", [], true, ["limit", "query"]),
  tool("craft_grader_save", "Save a versioned program, model, human, or operational grader.",
    ["name", "grader_type"], false, ["grader_id", "description", "configuration"]),
  tool("craft_grader_get", "Read an exact grader version.", ["grader_id"], true, ["version"]),
  tool("craft_grader_list", "List graders.", [], true, ["limit", "query"]),
  tool("craft_grade_record", "Record one immutable grade for a Trial and exact Grader version.",
    ["trial_id", "grader_id", "grader_version", "verdict", "summary"], false,
    ["score", "evidence_ids", "metadata"]),
  tool("craft_grade_get", "Read an immutable grade.", ["grade_id"], true),
  tool("craft_grade_list", "List grades.", [], true, ["limit", "query"]),
  tool("craft_signoff_policy_save", "Save a versioned policy for evaluation and grader requirements.",
    ["name"], false, ["policy_id", "description", "requirements", "require_held_out", "require_outcome_passed"]),
  tool("craft_signoff_policy_get", "Read a signoff policy version.", ["policy_id"], true, ["version"]),
  tool("craft_signoff_policy_list", "List signoff policies.", [], true, ["limit", "query"]),
  tool("craft_signoff_evaluate", "Evaluate an immutable signoff decision from an Evaluation Run and explicit Grades.",
    ["policy_id", "evaluation_run_id"], false, ["signoff_id", "policy_version", "grade_ids"]),
  tool("craft_signoff_get", "Read an immutable signoff decision.", ["signoff_id"], true),
  tool("craft_signoff_list", "List signoff decisions.", [], true, ["limit", "query"]),
  tool("craft_agent_profile_save", "Save a versioned cross-host agent profile.", ["name", "role", "host", "model"], false, ["profile_id", "provider", "reasoning_effort", "capabilities", "allowed_side_effects", "metadata"]),
  tool("craft_agent_profile_get", "Read an agent profile.", ["profile_id"], true, ["version"]),
  tool("craft_agent_profile_list", "List agent profiles.", [], true, ["limit", "query"]),
  tool("craft_orchestration_plan_create", "Create a dependency-aware multi-Agent plan with pinned Agent Profile versions.", ["goal", "nodes"], false, ["plan_id", "task_id", "max_concurrency", "lease_ttl_seconds", "budget", "policy"]),
  tool("craft_orchestration_trial_start", "Create an orchestration plan and automatically capture its Trial lifecycle.",
    ["task_id", "goal", "nodes"], false, ["plan_id", "trial_id", "case_id", "max_concurrency", "lease_ttl_seconds", "policy",
      "harness_configuration_id", "harness_configuration_version", "environment", "budget"]),
  tool("craft_orchestration_plan_get", "Read a multi-Agent plan and node states.", ["plan_id"], true),
  tool("craft_orchestration_plan_list", "List multi-Agent plans.", [], true, ["limit", "query"]),
  tool("craft_orchestration_dispatch", "Lease ready nodes to a host within concurrency limits.", ["plan_id", "claimed_by"], false, ["capacity"]),
  tool("craft_orchestration_renew", "Renew an owned orchestration lease before its TTL expires.",
    ["plan_id", "lease_id", "claimed_by"]),
  tool("craft_orchestration_submit", "Submit a leased node result; trial-backed plans capture trace, cost, evidence, and terminal outcome automatically.",
    ["plan_id", "lease_id", "verdict"], false,
    ["provenance", "claimed_by", "summary", "costs", "artifact_ids", "evidence_ids", "idempotency_key"]),
  tool("craft_orchestration_trial_finalize", "Idempotently reconcile a terminal trial-backed plan into its receipt, evidence, and outcome.",
    ["plan_id"], false),
];

export class McpServer {
  readonly service: CraftService;
  readonly handlers: Record<string, (args: JsonObject) => JsonObject | Promise<JsonObject>>;
  constructor(service: CraftService) {
    this.service = service;
    this.handlers = {
      craft_info: () => service.info(), craft_source_add: (a) => service.sourceAdd(a),
      craft_source_list: () => service.sourceList(), craft_source_update: (a) => service.sourceUpdate(a),
      craft_source_remove: (a) => service.sourceRemove(a), craft_source_scan: (a) => service.sourceScan(a),
      craft_capability_search: (a) => service.capabilitySearch(a), craft_capability_get: (a) => service.capabilityGet(a),
      craft_default_route: (a) => service.defaultRoute(a), craft_default_route_execute: (a) => service.defaultRouteExecute(a),
      craft_default_route_resume: (a) => service.defaultRouteResume(a), craft_default_route_find: (a) => service.defaultRouteFind(a),
      craft_route_workflow_proposal_create: (a) => service.routeWorkflowProposalCreate(a),
      craft_default_route_update: (a) => service.defaultRouteUpdate(a),
      craft_task_open: (a) => service.taskOpen(a), craft_task_list: (a) => service.taskList(a),
      craft_task_checkpoint: (a) => service.taskCheckpoint(a), craft_feedback_record: (a) => service.feedbackRecord(a),
      craft_artifact_register: (a) => service.artifactRegister(a),
      craft_artifact_get: (a) => service.get("artifact", "artifact_id", a),
      craft_artifact_list: (a) => service.list("artifact", "artifacts", a),
      craft_evidence_record: (a) => service.evidenceRecord(a),
      craft_evidence_get: (a) => service.get("evidence", "evidence_id", a),
      craft_evidence_list: (a) => service.list("evidence", "evidence", a),
      craft_workflow_save: (a) => service.workflowSave(a),
      craft_workflow_get: (a) => service.get("workflow", "workflow_id", a),
      craft_workflow_search: (a) => service.list("workflow", "workflows", a),
      craft_workflow_plan: (a) => service.workflowPlan(a), craft_workflow_run: (a) => service.workflowRun(a),
      craft_workflow_trial_run: (a) => service.workflowTrialRun(a),
      craft_workflow_run_get: (a) => service.get("workflow_run", "run_id", a),
      craft_workflow_transition: (a) => service.workflowTransition(a),
      craft_workflow_rollback: (a) => service.workflowRollback(a),
      craft_experience_pattern_create: (a) => service.experiencePatternCreate(a),
      craft_experience_pattern_get: (a) => service.get("experience_pattern", "pattern_id", a),
      craft_experience_pattern_list: (a) => service.list("experience_pattern", "patterns", a),
      craft_experience_candidate_list: (a) => service.experienceCandidateList(a),
      craft_skill_proposal_create: (a) => service.skillProposalCreate(a),
      craft_skill_proposal_get: (a) => service.get("skill_proposal", "proposal_id", a),
      craft_skill_proposal_list: (a) => service.list("skill_proposal", "proposals", a),
      craft_skill_proposal_transition: (a) => service.skillProposalTransition(a),
      craft_skill_proposal_rollback: (a) => service.skillProposalRollback(a),
      craft_skill_proposal_publish: (a) => service.skillProposalPublish(a),
      craft_skill_publication_get: (a) => service.get("skill_publication", "publication_id", a),
      craft_skill_publication_list: (a) => service.list("skill_publication", "publications", a),
      craft_skill_publication_rollback: (a) => service.skillPublicationRollback(a),
      craft_eval_suite_save: (a) => service.evaluationSuiteSave(a),
      craft_eval_suite_get: (a) => service.get("evaluation_suite", "suite_id", a),
      craft_eval_suite_list: (a) => service.list("evaluation_suite", "suites", a),
      craft_harness_configuration_save: (a) => service.harnessConfigurationSave(a),
      craft_harness_configuration_get: (a) => service.get("harness_configuration", "configuration_id", a),
      craft_harness_configuration_list: (a) => service.list("harness_configuration", "configurations", a),
      craft_trial_start: (a) => service.trialStart(a),
      craft_trial_trace_append: (a) => service.trialTraceAppend(a),
      craft_trial_get: (a) => service.trialGet(a),
      craft_trial_list: (a) => service.list("trial", "trials", a),
      craft_outcome_record: (a) => service.outcomeRecord(a),
      craft_evaluation_run_record: (a) => service.evaluationRunRecord(a),
      craft_evaluation_run_get: (a) => service.get("evaluation_run", "run_id", a),
      craft_evaluation_run_list: (a) => service.list("evaluation_run", "runs", a),
      craft_evaluation_run_aggregate: (a) => service.evaluationRunAggregate(a),
      craft_evaluation_compare: (a) => service.evaluationCompare(a),
      craft_evaluation_comparison_get: (a) => service.get("evaluation_comparison", "comparison_id", a),
      craft_evaluation_comparison_list: (a) => service.list("evaluation_comparison", "comparisons", a),
      craft_grader_save: (a) => service.graderSave(a),
      craft_grader_get: (a) => service.get("grader", "grader_id", a),
      craft_grader_list: (a) => service.list("grader", "graders", a),
      craft_grade_record: (a) => service.gradeRecord(a),
      craft_grade_get: (a) => service.get("grade", "grade_id", a),
      craft_grade_list: (a) => service.list("grade", "grades", a),
      craft_signoff_policy_save: (a) => service.signoffPolicySave(a),
      craft_signoff_policy_get: (a) => service.get("signoff_policy", "policy_id", a),
      craft_signoff_policy_list: (a) => service.list("signoff_policy", "policies", a),
      craft_signoff_evaluate: (a) => service.signoffEvaluate(a),
      craft_signoff_get: (a) => service.get("signoff", "signoff_id", a),
      craft_signoff_list: (a) => service.list("signoff", "signoffs", a),
      craft_agent_profile_save: (a) => service.saveVersioned("agent_profile", "profile", a,
        ["name", "role", "host", "model"]),
      craft_agent_profile_get: (a) => service.get("agent_profile", "profile_id", a),
      craft_agent_profile_list: (a) => service.list("agent_profile", "profiles", a),
      craft_orchestration_plan_create: (a) => service.orchestrationCreate(a),
      craft_orchestration_trial_start: (a) => service.orchestrationTrialStart(a),
      craft_orchestration_plan_get: (a) => service.get("orchestration_plan", "plan_id", a),
      craft_orchestration_plan_list: (a) => service.list("orchestration_plan", "plans", a),
      craft_orchestration_dispatch: (a) => service.orchestrationDispatch(a),
      craft_orchestration_renew: (a) => service.orchestrationRenew(a),
      craft_orchestration_submit: (a) => service.orchestrationSubmit(a),
      craft_orchestration_trial_finalize: (a) => service.orchestrationTrialFinalize(a),
    };
  }

  async handle(message: unknown): Promise<JsonObject | undefined> {
    if (!message || typeof message !== "object" || Array.isArray(message)) return this.error(null, -32600, "Invalid Request");
    const request = message as JsonObject;
    if ((request.jsonrpc !== undefined && request.jsonrpc !== "2.0") || typeof request.method !== "string") {
      return this.error(request.id ?? null, -32600, "Invalid Request");
    }
    if (request.method === "notifications/initialized" || request.id === undefined) return undefined;
    if (request.method === "initialize") {
      const requested = (request.params as JsonObject | undefined)?.protocolVersion;
      const version = ["2025-03-26", "2025-06-18", "2025-11-25"].includes(String(requested))
        ? requested : "2025-11-25";
      return this.ok(request.id, { protocolVersion: version, capabilities: { tools: {} },
        serverInfo: { name: "craft", version: VERSION } });
    }
    if (request.method === "ping") return this.ok(request.id, {});
    if (request.method === "tools/list") return this.ok(request.id, { tools: TOOLS });
    if (request.method !== "tools/call") return this.error(request.id, -32601, `Method not found: ${request.method}`);
    if (!request.params || typeof request.params !== "object" || Array.isArray(request.params)) {
      return this.error(request.id, -32602, "Tool call params must be an object");
    }
    const params = request.params as JsonObject;
    const handler = this.handlers[String(params.name)];
    if (!handler) return this.error(request.id, -32602, `Unknown tool: ${params.name}`);
    try {
      const supplied = params.arguments ?? {};
      if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
        return this.error(request.id, -32602, "Tool arguments must be an object");
      }
      const result = await handler(supplied as JsonObject);
      return this.ok(request.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result, isError: false });
    } catch (error) {
      return this.ok(request.id, { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true });
    }
  }
  private ok(requestId: unknown, result: JsonObject): JsonObject { return { jsonrpc: "2.0", id: requestId, result }; }
  private error(requestId: unknown, code: number, message: string): JsonObject {
    return { jsonrpc: "2.0", id: requestId, error: { code, message } };
  }
}
