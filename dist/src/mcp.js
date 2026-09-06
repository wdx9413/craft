import { CraftService, VERSION } from "./service.js";
import {} from "./store.js";
const schemaFor = (name) => {
    if (["scan", "enabled", "allow_execution"].includes(name))
        return { type: "boolean" };
    if (["limit", "version", "capacity", "max_concurrency", "size_bytes"].includes(name))
        return { type: "integer" };
    if (["inputs", "metadata", "policy"].includes(name))
        return { type: "object" };
    if (["completed", "pending", "decisions", "artifacts", "steps", "cases", "capabilities",
        "allowed_side_effects", "approved_side_effects", "nodes"].includes(name))
        return { type: "array" };
    return { type: "string" };
};
const objectSchema = (required = [], optional = []) => ({ type: "object",
    properties: Object.fromEntries([...required, ...optional].map((name) => [name, schemaFor(name)])), required,
    additionalProperties: false });
const tool = (name, description, required = [], readOnly = false, optional = []) => ({
    name, description, inputSchema: objectSchema(required, optional), ...(readOnly ? { annotations: { readOnlyHint: true } } : {}),
});
export const TOOLS = [
    tool("craft_info", "Show the Craft version, data location, and record counts.", [], true),
    tool("craft_source_add", "Add and optionally scan a local capability directory.", ["path"], false, ["label", "scan"]),
    tool("craft_source_list", "List configured capability sources and resolved paths.", [], true),
    tool("craft_source_update", "Enable, disable, or relabel a source.", ["source_id"], false, ["enabled", "label"]),
    tool("craft_source_remove", "Remove a source index without deleting its files.", ["source_id"]),
    tool("craft_source_scan", "Incrementally scan one or all enabled sources.", [], false, ["source_id"]),
    tool("craft_capability_search", "Return a small ranked set of matching capabilities.", ["query"], true, ["limit"]),
    tool("craft_capability_get", "Read one indexed capability.", ["asset_id"], true),
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
    tool("craft_workflow_save", "Save an immutable workflow version.", ["name"], false, ["workflow_id", "inputs", "steps", "description"]),
    tool("craft_workflow_get", "Read a workflow version.", ["workflow_id"], true, ["version"]),
    tool("craft_workflow_search", "Search reusable workflows.", [], true, ["limit", "query"]),
    tool("craft_workflow_plan", "Resolve inputs and side-effect approvals without executing.", ["workflow_id"], true, ["version", "inputs", "allow_execution", "approved_side_effects"]),
    tool("craft_workflow_run", "Execute deterministic Workflow steps with explicit side-effect approval.", ["workflow_id", "project_root"], false, ["version", "inputs", "allow_execution", "approved_side_effects"]),
    tool("craft_workflow_run_get", "Read a durable Workflow execution receipt.", ["run_id"], true),
    tool("craft_eval_suite_save", "Save an immutable evaluation suite.", ["name"], false, ["suite_id", "cases", "description", "scope"]),
    tool("craft_eval_suite_get", "Read an evaluation suite.", ["suite_id"], true, ["version"]),
    tool("craft_eval_suite_list", "Search evaluation suites.", [], true, ["limit", "query"]),
    tool("craft_agent_profile_save", "Save a versioned cross-host agent profile.", ["name", "role", "host", "model"], false, ["profile_id", "provider", "reasoning_effort", "capabilities", "allowed_side_effects", "metadata"]),
    tool("craft_agent_profile_get", "Read an agent profile.", ["profile_id"], true, ["version"]),
    tool("craft_agent_profile_list", "List agent profiles.", [], true, ["limit", "query"]),
    tool("craft_orchestration_plan_create", "Create a dependency-aware multi-Agent plan.", ["goal", "nodes"], false, ["task_id", "max_concurrency", "policy"]),
    tool("craft_orchestration_plan_get", "Read a multi-Agent plan and node states.", ["plan_id"], true),
    tool("craft_orchestration_plan_list", "List multi-Agent plans.", [], true, ["limit", "query"]),
    tool("craft_orchestration_dispatch", "Lease ready nodes to a host within concurrency limits.", ["plan_id", "claimed_by"], false, ["capacity"]),
    tool("craft_orchestration_submit", "Submit a leased node result with provenance.", ["plan_id", "lease_id", "verdict"], false, ["provenance", "claimed_by"]),
];
export class McpServer {
    service;
    handlers;
    constructor(service) {
        this.service = service;
        this.handlers = {
            craft_info: () => service.info(), craft_source_add: (a) => service.sourceAdd(a),
            craft_source_list: () => service.sourceList(), craft_source_update: (a) => service.sourceUpdate(a),
            craft_source_remove: (a) => service.sourceRemove(a), craft_source_scan: (a) => service.sourceScan(a),
            craft_capability_search: (a) => service.capabilitySearch(a), craft_capability_get: (a) => service.capabilityGet(a),
            craft_task_open: (a) => service.taskOpen(a), craft_task_list: (a) => service.taskList(a),
            craft_task_checkpoint: (a) => service.taskCheckpoint(a), craft_feedback_record: (a) => service.feedbackRecord(a),
            craft_artifact_register: (a) => service.artifactRegister(a),
            craft_artifact_get: (a) => service.get("artifact", "artifact_id", a),
            craft_artifact_list: (a) => service.list("artifact", "artifacts", a),
            craft_evidence_record: (a) => service.evidenceRecord(a),
            craft_evidence_get: (a) => service.get("evidence", "evidence_id", a),
            craft_evidence_list: (a) => service.list("evidence", "evidence", a),
            craft_workflow_save: (a) => service.saveVersioned("workflow", "workflow", a, ["name"]),
            craft_workflow_get: (a) => service.get("workflow", "workflow_id", a),
            craft_workflow_search: (a) => service.list("workflow", "workflows", a),
            craft_workflow_plan: (a) => service.workflowPlan(a), craft_workflow_run: (a) => service.workflowRun(a),
            craft_workflow_run_get: (a) => service.get("workflow_run", "run_id", a),
            craft_eval_suite_save: (a) => service.saveVersioned("evaluation_suite", "suite", a, ["name"]),
            craft_eval_suite_get: (a) => service.get("evaluation_suite", "suite_id", a),
            craft_eval_suite_list: (a) => service.list("evaluation_suite", "suites", a),
            craft_agent_profile_save: (a) => service.saveVersioned("agent_profile", "profile", a, ["name", "role", "host", "model"]),
            craft_agent_profile_get: (a) => service.get("agent_profile", "profile_id", a),
            craft_agent_profile_list: (a) => service.list("agent_profile", "profiles", a),
            craft_orchestration_plan_create: (a) => service.orchestrationCreate(a),
            craft_orchestration_plan_get: (a) => service.get("orchestration_plan", "plan_id", a),
            craft_orchestration_plan_list: (a) => service.list("orchestration_plan", "plans", a),
            craft_orchestration_dispatch: (a) => service.orchestrationDispatch(a),
            craft_orchestration_submit: (a) => service.orchestrationSubmit(a),
        };
    }
    async handle(message) {
        if (!message || typeof message !== "object" || Array.isArray(message))
            return this.error(null, -32600, "Invalid Request");
        const request = message;
        if ((request.jsonrpc !== undefined && request.jsonrpc !== "2.0") || typeof request.method !== "string") {
            return this.error(request.id ?? null, -32600, "Invalid Request");
        }
        if (request.method === "notifications/initialized" || request.id === undefined)
            return undefined;
        if (request.method === "initialize") {
            const requested = request.params?.protocolVersion;
            const version = ["2025-03-26", "2025-06-18", "2025-11-25"].includes(String(requested))
                ? requested : "2025-11-25";
            return this.ok(request.id, { protocolVersion: version, capabilities: { tools: {} },
                serverInfo: { name: "craft", version: VERSION } });
        }
        if (request.method === "ping")
            return this.ok(request.id, {});
        if (request.method === "tools/list")
            return this.ok(request.id, { tools: TOOLS });
        if (request.method !== "tools/call")
            return this.error(request.id, -32601, `Method not found: ${request.method}`);
        if (!request.params || typeof request.params !== "object" || Array.isArray(request.params)) {
            return this.error(request.id, -32602, "Tool call params must be an object");
        }
        const params = request.params;
        const handler = this.handlers[String(params.name)];
        if (!handler)
            return this.error(request.id, -32602, `Unknown tool: ${params.name}`);
        try {
            const supplied = params.arguments ?? {};
            if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
                return this.error(request.id, -32602, "Tool arguments must be an object");
            }
            const result = await handler(supplied);
            return this.ok(request.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                structuredContent: result, isError: false });
        }
        catch (error) {
            return this.ok(request.id, { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
                isError: true });
        }
    }
    ok(requestId, result) { return { jsonrpc: "2.0", id: requestId, result }; }
    error(requestId, code, message) {
        return { jsonrpc: "2.0", id: requestId, error: { code, message } };
    }
}
//# sourceMappingURL=mcp.js.map