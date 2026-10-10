import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stableDigest } from "../digest.ts";
import { CraftService, VERSION } from "../service.ts";
import { classifyTool } from "../internal-tool-authorization.ts";
import { HookPlane } from "../hook-plane.ts";
import { type JsonObject } from "../infrastructure/store.ts";
import { discoverResult, pingPolicy, readRequestMeta } from "../mcp-forward-compat.ts";
import { negotiateProtocolVersion, MCP_PREFERRED_PROTOCOL_VERSION } from "../distribution-and-first-run.ts";
import { SYSCALL_PASSTHROUGH, SYSCALL_VERBS, buildRegistry, catalogOf, describeEntry, resolveEntry } from "../tool-plane.ts";
import { type Tool, tool } from "../mcp/tool-schema.ts";
import { TOOLS, ACTIVE_TOOLS } from "../mcp/tool-catalog.ts";
import { componentForSurface, surfaceToolNames as resolveSurfaceToolNames } from "./mcp/surface-registry.ts";
import { createActionHandlers } from "../application/actions/action-handlers.ts";
import type { McpHandler } from "./mcp/handler-types.js";
import { ComponentTraceKernel, type ComponentTraceResult } from "../component-trace.ts";
import { validateJsonSchema, type JsonValue } from "../json-schema.ts";
export { COMPONENT_SURFACES, COMPONENT_SURFACE_NAMES, DOMAIN_SURFACE_NAMES, SURFACE_NAMES, SURFACE_RULES, domainSurfaceOf } from "./mcp/surface-registry.ts";

export { TOOLS, ACTIVE_TOOLS } from "../mcp/tool-catalog.ts";

const CORE_TOOL_NAMES = new Set(["craft_info", "craft_source_list", "craft_capability_search", "craft_capability_get", "craft_semantic_status", "craft_execution_policy_decide",
  "craft_first_run_readiness", "craft_credential_resolve", "craft_mcp_protocol_negotiate", "craft_mcp_migration_assess", "craft_isolation_capability_get", "craft_distribution_plan_get",
  "craft_context_project", "craft_context_restore", "craft_bm25_search", "craft_retrieval_fuse", "craft_experience_capture_decide", "craft_experience_capture_build",
  "craft_memory_decay_get", "craft_memory_capture_propose", "craft_memory_promotion_preview", "craft_memory_hybrid_scores", "craft_memory_usage_record",
  "craft_verification_check", "craft_verification_evaluate", "craft_verification_capture_signals_get",
  "craft_trajectory_signature_get", "craft_abstraction_evaluate", "craft_abstraction_build",
  "craft_failure_attribution_get", "craft_failure_attribution_summary_get",
  "craft_mcp_declarations_get", "craft_consistency_check",
  "craft_governance_pin_get", "craft_governance_pin_check", "craft_governance_compaction_evaluate", "craft_governance_constraint_define",
  "craft_mcp_discover_get", "craft_mcp_forward_compat_get",
  "craft_default_route", "craft_default_route_resume", "craft_default_route_find", "craft_task_open", "craft_task_list", "craft_intent_compile", "craft_intent_get", "craft_acceptance_compile", "craft_acceptance_contract_get", "craft_task_checkpoint", "craft_task_control_refresh", "craft_task_control_get", "craft_task_run_refresh", "craft_task_run_get", "craft_verified_work_loop_prepare", "craft_verified_work_loop_advance", "craft_verified_work_loop_decide", "craft_verified_work_loop_resume", "craft_verified_work_loop_get", "craft_evaluation_contract_define", "craft_evaluation_contract_record", "craft_evaluation_contract_get", "craft_host_activation_manifest_prepare", "craft_host_activation_manifest_validate", "craft_host_activation_manifest_consume", "craft_host_activation_manifest_get", "craft_execution_fabric_prepare", "craft_execution_fabric_execute", "craft_execution_fabric_advance", "craft_execution_fabric_consume", "craft_execution_fabric_get", "craft_host_bridge_get", "craft_work_launch_get", "craft_work_delivery_observe", "craft_work_delivery_get", "craft_delivery_loop_refresh", "craft_delivery_loop_get", "craft_delivery_evaluation_compare", "craft_delivery_evaluation_run", "craft_eval_campaign_report", "craft_adaptive_harness_recommend", "craft_managed_write_get", "craft_managed_run_get", "craft_campaign_runner_get", "craft_runtime_assurance_intervene", "craft_runtime_assurance_get", "craft_workspace_observer_get", "craft_autonomy_ladder_get", "craft_work_coordinator_get", "craft_agent_eval_lab_get", "craft_judge_promotion_eligible", "craft_platform_execution_preflight", "craft_platform_execution_probe", "craft_platform_execution_probe_get", "craft_workspace_get", "craft_workspace_diff", "craft_work_object_list", "craft_workspace_impact", "craft_context_assemble", "craft_change_set_preview",
  "craft_artifact_register", "craft_evidence_record", "craft_capability_access_plan", "craft_capability_call_issue", "craft_capability_call_consume", "craft_capability_kit_get", "craft_capability_kit_list", "craft_capability_kit_distribution", "craft_capability_connector_list", "craft_capability_connector_ticket_issue", "craft_capability_connector_ticket_consume", "craft_knowledge_source_list", "craft_context_resolution_resolve", "craft_context_resolution_get", "craft_work_runtime_mode_get", "craft_continual_harness_view_create", "craft_continual_harness_refine", "craft_continual_harness_submit", "craft_continual_harness_signals", "craft_continual_harness_resolve", "craft_continual_harness_get", "craft_stateful_compute_session_prepare", "craft_stateful_compute_dispatch", "craft_stateful_compute_observe", "craft_stateful_compute_delegate", "craft_stateful_compute_report", "craft_stateful_compute_cancel", "craft_stateful_compute_session_get", "craft_uncertainty_resolve", "craft_release_qualification_evaluate", "craft_platform_ideal_state_assess", "craft_verification_get", "craft_evaluation_program_due", "craft_evaluation_program_report", "craft_enterprise_access_ticket_get", "craft_a2a_delegation_get", "craft_federated_delegation_get", "craft_harness_topology_get", "craft_runtime_readiness_get", "craft_runtime_model_status", "craft_assured_pilot_get", "craft_assured_pilot_reassess", "craft_usage_report", "craft_settings_get", "craft_trace_get", "craft_trace_query", "craft_trace_replay_bundle", "craft_trace_review", "craft_trace_review_get", "craft_trace_review_list", "craft_memory_maintenance_signal", "craft_memory_maintenance_run", "craft_memory_maintenance_get", "craft_trust_profile_recommend", "craft_trust_profile_get", "craft_trust_profile_list", "craft_web_fetch", "craft_web_operation_get"]);
// Content diagnostics are safe core reads; migration remains full-surface only.
CORE_TOOL_NAMES.add("craft_content_status").add("craft_content_verify");
// Durable Task and Runtime Proof operations are part of the compact control surface.
for (const name of ["craft_mcp_task_create", "craft_mcp_task_get", "craft_mcp_task_update", "craft_mcp_task_cancel", "craft_mcp_task_expire", "craft_runtime_proof_manifest", "craft_runtime_proof_probe", "craft_runtime_proof_conformance", "craft_runtime_proof_attest", "craft_runtime_proof_rehydrate"]) CORE_TOOL_NAMES.add(name);
export const CORE_TOOLS: Tool[] = ACTIVE_TOOLS.filter((tool) => CORE_TOOL_NAMES.has(tool.name));

/** Backward-compatible one-argument surface lookup for existing callers. */
export function surfaceToolNames(surface: string): string[] {
  return resolveSurfaceToolNames(surface, ACTIVE_TOOLS, CORE_TOOL_NAMES);
}

// The syscall surface. Instead of one tool per operation, a host learns a fixed
// set of verbs and addresses capabilities by (resource, operation). The registry
// is derived from TOOLS, so the 485 operations stay reachable while the mounted
// schema stays O(1): `craft_describe` is what tells the model the exact arguments
// of any operation, on demand, instead of paying for all of them up front.
export const SYSCALL_TOOLS: Tool[] = [
  tool("craft_describe", "Describe Craft operations: with no arguments returns the resource catalog; with resource (and optional operation) returns the exact arguments, effect, risk and approval requirement.", [], true, ["resource", "operation"]),
  tool("craft_list", "List Craft records of one resource, addressed as resource plus an optional operation.", ["resource"], true, ["operation", "limit", "args"]),
  tool("craft_get", "Read one Craft record of a resource by id.", ["resource"], true, ["operation", "args"]),
  tool("craft_create", "Create or record a new Craft object of a resource.", ["resource"], false, ["operation", "args"]),
  tool("craft_update", "Update, advance or decide an existing Craft object of a resource.", ["resource"], false, ["operation", "args"]),
  tool("craft_run", "Run or start a Craft operation that executes work; the operation must be named explicitly.", ["resource", "operation"], false, ["args"]),
  tool("craft_cancel", "Cancel or stop a running Craft operation of a resource.", ["resource"], false, ["operation", "args"]),
  tool("craft_search", "Search indexed capabilities, or another searchable resource when one is named.", [], true, ["query", "resource", "limit"]),
];

export const TOOL_REGISTRY = buildRegistry(ACTIVE_TOOLS);

/**
 * Default operation for each syscall verb, so a caller that omits it still lands
 * on the obvious tool. Exported so a test can assert it stays exhaustive over
 * SYSCALL_VERBS — that is what lets `dispatchSyscall` index it without a
 * defensive fallback that could never be reached or tested.
 */
export const VERB_DEFAULT_OPERATION: Readonly<Record<string, string>> = {
  craft_list: "list", craft_get: "get", craft_create: "create",
  craft_update: "update", craft_run: "run", craft_cancel: "cancel", craft_search: "search",
};

export class McpServer {
  readonly service: CraftService;
  readonly handlers: Record<string, McpHandler>;
  readonly tools: Tool[];
  readonly mode: string;
  /**
   * The assembled capability hooks, when the service has them.
   *
   * Optional because a test may construct a server over a partial service, and because the hook
   * plane is an addition to the flow rather than a precondition for it: `undefined` means the
   * server behaves exactly as it did before hooks existed, which is what keeps this change from
   * being a rewrite of the dispatch path.
   */
  readonly fingerprint: JsonObject;
  readonly componentTrace: ComponentTraceKernel;
  readonly hooks: HookPlane | undefined;
  constructor(service: CraftService, mode: string = "full") {
    this.service = service;
    this.mode = mode;
    this.hooks = (service as { hookPlane?: HookPlane }).hookPlane;
    this.componentTrace = new ComponentTraceKernel(service.trace, `mcp_${randomUUID().replaceAll("-", "")}`);
    const allowed = new Set(surfaceToolNames(mode));
    const mountedComponent = componentForSurface(mode);
    this.tools = [...ACTIVE_TOOLS, ...SYSCALL_TOOLS].filter((tool) => allowed.has(tool.name));
    this.handlers = createActionHandlers(service, mountedComponent);
    let artifactDigest: string | null = null;
    try { artifactDigest = createHash("sha256").update(readFileSync(process.argv[1]!)).digest("hex"); } catch { /* Embedded hosts may have no file entrypoint. */ }
    this.fingerprint = { schema_digest: stableDigest(this.tools), entrypoint_digest: artifactDigest, surface: mode,
      capabilities: ["shared_context_ranking", "diagnostic_memory_history", "retrieval_dataset_execution", "procedure_recovery_evidence", "semantic_analysis_import"],
      release: VERSION, artifact_scope: "process_entrypoint_at_server_creation", host_session_verified: false };
  }

  async handle(message: unknown): Promise<JsonObject | undefined> {
    if (!message || typeof message !== "object" || Array.isArray(message)) return this.error(null, -32600, "Invalid Request");
    const request = message as JsonObject;
    if ((request.jsonrpc !== undefined && request.jsonrpc !== "2.0") || typeof request.method !== "string") {
      return this.error(request.id ?? null, -32600, "Invalid Request");
    }
    if (request.method === "notifications/initialized" || request.id === undefined) return undefined;
    // Forward compatibility: tolerate a peer that sends 2026-07-28 per-request
    // `_meta`. Reading it is additive — a 2025-11-25 client never sends it — and
    // unknown protocol keys are surfaced rather than silently discarded.
    const requestMeta = readRequestMeta(request as JsonObject);
    if (request.method === "server/discover") {
      // Mandated by 2026-07-28 (SEP-2575) and harmless on every earlier
      // revision, so a newer client gets an honest answer instead of
      // `Method not found`.
      return this.ok(request.id, discoverResult({ server_name: "craft", version: VERSION }));
    }
    if (request.method === "initialize") {
      // The supported-revision table lives in one place. This handler used to
      // inline a second copy, so the constant and the code that speaks the
      // protocol could disagree without anything noticing — the exact shape of
      // defect the declaration/implementation check now exists to catch.
      const negotiation = negotiateProtocolVersion((request.params as JsonObject | undefined)?.protocolVersion);
      const base = { protocolVersion: negotiation.negotiated, capabilities: { tools: {}, experimental: { "craft/runtime-fingerprint": this.fingerprint } },
        serverInfo: { name: "craft", version: VERSION } };
      // A downgrade is reported rather than hidden. This build does not speak
      // 2026-07-28, and silently answering 2025-11-25 made "the server does not
      // speak this revision" indistinguishable from "the server pretends to".
      if (!negotiation.downgraded) return this.ok(request.id, base);
      return this.ok(request.id, { ...base, downgraded: true, downgrade_reason: negotiation.reason,
        requested_protocol_version: negotiation.requested, assessed_revision: negotiation.assessed_revision,
        migration_status: negotiation.migration_status });
    }
    // `ping` is retained deliberately: it belongs to every revision this build
    // speaks, and 2026-07-28 removed it only for the revision this build does not
    // speak. Serving it is therefore conditional rather than accidental.
    if (request.method === "ping") {
      const policy = pingPolicy({ protocol_version: requestMeta.protocol_version ?? MCP_PREFERRED_PROTOCOL_VERSION });
      if (policy.serve_ping !== true) return this.error(request.id, -32601, `Method not found: ${request.method}`);
      return this.ok(request.id, {});
    }
    if (request.method === "tools/list") return this.ok(request.id, { tools: this.tools, _meta: { "craft/runtime-fingerprint": this.fingerprint } });
    if (request.method !== "tools/call") return this.error(request.id, -32601, `Method not found: ${request.method}`);
    if (!request.params || typeof request.params !== "object" || Array.isArray(request.params)) {
      return this.reject(request.id, "Tool call params must be an object", request.params);
    }
    const params = request.params as JsonObject;
    const supplied = params.arguments === undefined ? {} : params.arguments;
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
      return this.reject(request.id, "Tool arguments must be an object", supplied);
    }
    const name = String(params.name);
    if (!this.tools.some((tool) => tool.name === name) && (this.mode !== "full" || !this.handlers[name])) {
      return this.reject(request.id, `Unknown tool: ${name}`, supplied);
    }
    // The two hook phases that stand in front of and behind an effect. `tool_before` is a gating
    // phase, so this is the point where "a hook can stop a tool call" stops being a comment: a
    // refusal returns without dispatching, and `tool_after` therefore does not run for it either.
    const context = this.hooks === undefined ? undefined : HookPlane.toolContext(name, supplied, classifyTool);
    const requestId = String(request.id);
    const traced = name !== "craft_info" && name !== "craft_describe" && name !== "craft_list" && name !== "craft_get" && !name.startsWith("craft_trace_");
    const dispatch = async (): Promise<JsonObject> => {
      if (context) {
        const gate = await this.hooks!.run("tool_before", context);
        if (gate.denied) {
          const refusal = gate.outcomes.find((entry) => entry.outcome.kind === "denied")!;
          const reason = refusal.outcome.kind === "denied" ? refusal.outcome.reason : "denied";
          const denied = { denied: true, hook: refusal.hook, capability: refusal.capability ?? null, reason };
          if (traced) return denied;
          const captured = await this.componentTrace.capture({ requestId, component: "craft-mcp", operation: "hook.denied", input: supplied as JsonObject, handler: () => denied });
          return { ...denied, trace_correlation: captured.correlation, ...(captured.telemetry_error ? { telemetry_error: captured.telemetry_error } : {}) };
        }
      }

      // Standalone contracts are checked at the wire boundary, including calls
      // from clients that do not validate JSON Schema themselves.
      if (this.mode.endsWith("-daily") || this.mode === "component-codebase") {
        validateJsonSchema(supplied as JsonValue, this.tools.find((tool) => tool.name === name)!.inputSchema);
      }
      const result = SYSCALL_VERBS.includes(name)
        ? await this.dispatchSyscall(name, supplied as JsonObject)
        : await this.dispatchTool(name, supplied as JsonObject);
      if (result === undefined) throw new Error(`Unknown tool: ${name}`);
      if (["craft_component_readiness_get", "craft_component_diagnose", "craft_codebase_status"].includes(name)) {
        const expected = (supplied as JsonObject).expected_schema_digest;
        return { ...result, runtime_fingerprint: this.fingerprint,
          schema_match: expected === undefined ? null : expected === this.fingerprint.schema_digest };
      }
      return result;
    };
    try {
      const captured: ComponentTraceResult = traced
        ? await this.componentTrace.capture({ requestId, component: "craft-mcp", operation: name, input: supplied as JsonObject, handler: dispatch })
        : { ok: true, result: await dispatch(), correlation: null };
      if (!captured.ok) {
        return this.ok(request.id, { content: [{ type: "text", text: captured.error instanceof Error ? captured.error.message : String(captured.error) }],
          trace_correlation: captured.correlation, ...(captured.telemetry_error ? { telemetry_error: captured.telemetry_error } : {}), isError: true });
      }
      const result: JsonObject = { ...(captured.result ?? {}), ...(captured.correlation === null ? {} : { trace_correlation: captured.correlation }),
        ...(captured.telemetry_error ? { telemetry_error: captured.telemetry_error } : {}) };
      if (result.denied === true) return this.ok(request.id, { content: [{ type: "text", text: `Denied by hook ${String(result.hook)}: ${String(result.reason)}` }], structuredContent: result, isError: true });
      if (context) await this.hooks!.run("tool_after", context);
      return this.ok(request.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result, isError: false });
    } catch (error) {
      return this.ok(request.id, { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true });
    }
  }

  private async reject(requestId: unknown, message: string, input: unknown): Promise<JsonObject> {
    const captured = await this.componentTrace.capture({ requestId: String(requestId), component: "craft-mcp", operation: "protocol.reject",
      input: { envelope: input }, handler: () => { throw Object.assign(new Error(message), { code: "ERR_INVALID_PARAMS" }); } });
    return { jsonrpc: "2.0", id: requestId, error: { code: -32602, message, data: { trace_correlation: captured.correlation,
      ...(captured.telemetry_error ? { telemetry_error: captured.telemetry_error } : {}) } } };
  }

  private dispatchTool(name: string, args: JsonObject): JsonObject | Promise<JsonObject> | undefined {
    const handler = this.handlers[name];
    return handler ? handler(args) : undefined;
  }

  /**
   * Resolve one syscall verb against the registry, then run the legacy handler it
   * points at. The syscall surface therefore never re-implements an operation and
   * can never drift from the named one.
   */
  private async dispatchSyscall(name: string, args: JsonObject): Promise<JsonObject> {
    const resource = typeof args.resource === "string" && args.resource.trim() ? args.resource.trim() : "capability";
    const operation = typeof args.operation === "string" && args.operation.trim() ? args.operation.trim() : undefined;
    if (name === "craft_describe") {
      if (args.resource === undefined) return catalogOf(TOOL_REGISTRY);
      const described = resolveEntry(TOOL_REGISTRY, resource, operation, "info");
      if (!described) {
        return { found: false, resource, operation: operation ?? null,
          hint: "Call craft_describe with no arguments for the full resource catalog." };
      }
      return describeEntry(described);
    }
    // Every verb except craft_describe declares a default operation, and a test
    // pins that exhaustiveness rather than leaving an unreachable `?? "info"`.
    const entry = resolveEntry(TOOL_REGISTRY, resource, operation, VERB_DEFAULT_OPERATION[name] as string);
    if (!entry) throw new Error(`Unknown Craft operation: ${resource}${operation ? `.${operation}` : ""}`);
    const handler = this.handlers[entry.tool];
    if (!handler) throw new Error(`Craft operation is not mounted on this surface: ${entry.tool}`);
    const { resource: _resource, operation: _operation, args: nested, ...rest } = args;
    const forwarded: JsonObject = { ...rest,
      ...(nested && typeof nested === "object" && !Array.isArray(nested) ? nested as JsonObject : {}) };
    return handler(forwarded);
  }
  private ok(requestId: unknown, result: JsonObject): JsonObject { return { jsonrpc: "2.0", id: requestId, result }; }
  private error(requestId: unknown, code: number, message: string): JsonObject {
    return { jsonrpc: "2.0", id: requestId, error: { code, message } };
  }
}
