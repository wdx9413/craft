import type { CraftService } from "../application/craft-service.ts";
import type { JsonObject } from "../infrastructure/store.ts";
import { createHash } from "node:crypto";
import { stableDigest } from "../digest.ts";
import { isVerifiedCodexCommandCompletion } from "./codex-hook-command-result.ts";
import { HookSignalSanitizer } from "./codex-hook-signal-sanitizer.ts";

type HookInput = Record<string, unknown>;
type ProjectScope = { kind: "project"; id: string };
type ToolDefinition = { operation_id: string; tool_category: string; action: string; summary: string; recordToolName?: boolean };
type ToolResult = { status: "succeeded" | "failed" | "unknown"; error_class?: string };

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const TOOL_DEFINITIONS: Readonly<Record<string, ToolDefinition>> = {
  Bash: { operation_id: "codex_tool_bash", tool_category: "script", action: "execute", summary: "Codex script operation observed" },
  apply_patch: { operation_id: "codex_tool_apply_patch", tool_category: "file_edit", action: "patch", summary: "Codex file edit operation observed" },
  Edit: { operation_id: "codex_tool_edit", tool_category: "file_edit", action: "edit", summary: "Codex file edit operation observed" },
  Write: { operation_id: "codex_tool_write", tool_category: "file_edit", action: "write", summary: "Codex file edit operation observed" },
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function digest(value: unknown): string {
  return stableDigest(value).slice(-32);
}

function traceIdentity(input: HookInput, scope: ProjectScope): { taskId: string; traceId: string; sessionId: string; turnId: string } | null {
  const sessionId = text(input.session_id), turnId = text(input.turn_id);
  if (!sessionId || !turnId || !SAFE_ID.test(sessionId) || !SAFE_ID.test(turnId)) return null;
  const journalIdentity = { scope, session_host: "codex", session_id: sessionId, turn: turnId };
  const taskId = `codex_hook_turn_${createHash("sha256").update(JSON.stringify(journalIdentity)).digest("hex").slice(-20)}`;
  const traceDigest = digest({ host: "codex", project_scope: scope, session_id: sessionId, turn_id: turnId });
  return { taskId, traceId: `codex_host_trace_${traceDigest}`, sessionId, turnId };
}

function normalizedToolResult(value: unknown, nativeCompletion: boolean): ToolResult {
  if (!nativeCompletion || !value || typeof value !== "object" || Array.isArray(value))
    return { status: "unknown", error_class: "host_result_not_semantic" };
  const result = value as Record<string, unknown>;
  const exitCode = result.exit_code;
  if (typeof exitCode === "number" && Number.isSafeInteger(exitCode) && exitCode >= 0)
    return exitCode === 0 ? { status: "succeeded" } : { status: "failed", error_class: "host_tool_reported_failure" };
  return { status: "unknown", error_class: "host_result_not_semantic" };
}

function projectScope(value: ProjectScope | null | undefined): ProjectScope | null {
  if (!value || value.kind !== "project" || typeof value.id !== "string" || !SAFE_ID.test(value.id)) return null;
  return { kind: "project", id: value.id };
}

function captureResult(fields: Record<string, unknown>): JsonObject {
  return fields as JsonObject;
}

function eventMatches(existing: JsonObject, expected: {
  traceId: string; eventKind: string; operationId: string; status: string; inputRefs: string[]; source: string; trust: string;
  actionContract?: JsonObject;
}): boolean {
  const refs = Array.isArray(existing.input_refs) ? existing.input_refs.map(String) : [];
  return existing.trace_id === expected.traceId && existing.event_kind === expected.eventKind
    && existing.operation_id === expected.operationId && existing.status === expected.status
    && existing.source === expected.source && existing.trust === expected.trust
    && refs.length === expected.inputRefs.length && refs.every((ref, index) => ref === expected.inputRefs[index])
    && (expected.actionContract === undefined || stableDigest(existing.action_contract) === stableDigest(expected.actionContract));
}

function toolDefinition(value: unknown): ToolDefinition | undefined {
  if (typeof value !== "string") return undefined;
  const registered = TOOL_DEFINITIONS[value];
  if (registered) return registered;
  if (/^mcp__[A-Za-z0-9_.-]{1,64}__[A-Za-z0-9_.-]{1,96}$/u.test(value)) {
    return { operation_id: "codex_tool_mcp", tool_category: "api_mcp", action: "invoke",
      summary: "Codex MCP tool operation observed", recordToolName: true };
  }
  return undefined;
}

export function isCodexHostTraceToolEvent(input: HookInput): boolean {
  return input.session_host === "codex" && input.hook_event_name === "PostToolUse"
    && toolDefinition(input.tool_name) !== undefined;
}

/** Capability claims remain separate from hook registration and runtime evidence. */
export function codexHostTraceCapabilities(): JsonObject[] {
  return [
    { host: "codex", tool_category: "script", tools: ["Bash"], status: "configured_unverified", reason_code: "host_runtime_receipt_pending" },
    { host: "codex", tool_category: "file_edit", tools: ["apply_patch"], matcher_aliases: ["Edit", "Write"], status: "configured_unverified", reason_code: "host_runtime_receipt_pending" },
    { host: "codex", tool_category: "browser", tools: [], status: "unsupported", reason_code: "hosted_tools_not_in_local_hook_path" },
    { host: "codex", tool_category: "api_mcp", tools: [], tool_patterns: ["^mcp__[A-Za-z0-9_.-]{1,64}__[A-Za-z0-9_.-]{1,96}$"],
      status: "configured_unverified", reason_code: "host_runtime_receipt_pending" },
    { host: "codex", tool_category: "recovery_linkage", tools: [], status: "unsupported", reason_code: "native_post_tool_use_has_no_recovery_relation" },
  ];
}

export class CodexHostTraceCapture {
  readonly service: CraftService;

  constructor(service: CraftService) {
    this.service = service;
  }

  private traceStore() {
    const runtime = this.service.capabilityOwned && this.service.storageOwner !== "runtime"
      ? this.service.ownerServices.get("runtime") : undefined;
    if (this.service.capabilityOwned && this.service.storageOwner !== "runtime" && !runtime)
      throw new Error("Codex Host Trace owner is unavailable");
    return runtime?.store ?? this.service.store;
  }

  private experienceStore() {
    const experience = this.service.capabilityOwned && this.service.storageOwner !== "experience"
      ? this.service.ownerServices.get("experience") : undefined;
    if (this.service.capabilityOwned && this.service.storageOwner !== "experience" && !experience)
      throw new Error("Experience ticket owner is unavailable");
    return experience?.store ?? this.service.store;
  }

  ensureTurnTrace(input: HookInput, project: ProjectScope | null): JsonObject {
    if (input.session_host !== "codex") return captureResult({ status: "rejected", reason_code: "unsupported_host" });
    const canonicalScope = projectScope(project);
    if (!canonicalScope) return captureResult({ status: "rejected", reason_code: "project_scope_unavailable" });
    const identity = traceIdentity(input, canonicalScope);
    if (!identity) return captureResult({ status: "rejected", reason_code: "missing_task_identity" });
    const started = this.service.traceStart({ trace_id: identity.traceId, task_id: identity.taskId, host: "codex",
      project_scope: canonicalScope as unknown as JsonObject, session_id: identity.sessionId, turn_id: identity.turnId });
    return captureResult({ status: "captured", trace_id: identity.traceId, task_id: identity.taskId,
      idempotent: started.idempotent === true });
  }

  captureTool(input: HookInput, project: ProjectScope | null): JsonObject {
    if (input.session_host !== "codex") return captureResult({ status: "rejected", reason_code: "unsupported_host" });
    if (input.hook_event_name !== "PostToolUse") return captureResult({ status: "rejected", reason_code: "unsupported_host_event" });
    const toolName = text(input.tool_name);
    const tool = toolName ? toolDefinition(toolName) : undefined;
    if (!tool) return captureResult({ status: "rejected", reason_code: "unsupported_tool_category" });
    const canonicalScope = projectScope(project);
    if (!canonicalScope) return captureResult({ status: "rejected", reason_code: "project_scope_unavailable" });
    const identity = traceIdentity(input, canonicalScope);
    if (!identity) return captureResult({ status: "rejected", reason_code: "missing_task_identity" });
    const toolCallId = text(input.tool_use_id);
    if (!toolCallId || !SAFE_ID.test(toolCallId)) return captureResult({ status: "rejected", reason_code: "missing_tool_call_reference" });

    const eventRef = `codex_host_event_${digest({ project_scope: canonicalScope, session_id: identity.sessionId,
      turn_id: identity.turnId, tool_use_id: toolCallId })}`;
    const eventKind = "host.tool.completed";
    const result = normalizedToolResult(input.tool_response,
      tool.tool_category === "script" && isVerifiedCodexCommandCompletion(input));
    const verificationSignal = tool.tool_category === "script" && isVerifiedCodexCommandCompletion(input)
      ? new HookSignalSanitizer().signal(input) : null;
    const actionContract: JsonObject = { kind: "host_tool_operation", tool_category: tool.tool_category, action: tool.action,
      ...(verificationSignal?.kind === "verification" && verificationSignal.verifier ? { verification_digest: verificationSignal.verifier } : {}),
      ...(tool.recordToolName ? { tool_name: toolName } : {}) };
    const started = this.service.traceStart({ trace_id: identity.traceId, task_id: identity.taskId, host: "codex",
      project_scope: canonicalScope as unknown as JsonObject, session_id: identity.sessionId, turn_id: identity.turnId });
    const trace = started.trace as JsonObject;
    // PostToolUse does not define a recovery relation. Ignore extra payload keys
    // instead of treating caller-supplied references as Host evidence.
    const inputRefs = [eventRef];
    const traceStore = this.traceStore();
    const existingEvent = traceStore.find("trace_event", eventRef);
    if (existingEvent) {
      const expected = { traceId: identity.traceId, eventKind, operationId: tool.operation_id, status: result.status,
        inputRefs, source: "codex", trust: "observed", actionContract };
      return eventMatches(existingEvent, expected)
        ? captureResult({ status: "captured", trace_id: identity.traceId, task_id: identity.taskId, event_ref: eventRef,
          sequence: Number(existingEvent.sequence), call_result: result.status, idempotent: true })
        : captureResult({ status: "rejected", reason_code: "event_identity_conflict" });
    }
    if (["completed", "failed", "cancelled", "blocked"].includes(String(trace.status)))
      return captureResult({ status: "rejected", reason_code: "trace_terminal" });
    const appended = this.service.traceAppend({ trace_id: identity.traceId, event_id: eventRef, event_kind: eventKind,
      actor: "host", source: "codex", trust: "observed", operation_id: tool.operation_id, status: result.status,
      action_contract: actionContract,
      ...(result.error_class ? { error_class: result.error_class } : {}), input_refs: inputRefs, data: {}, summary: tool.summary });
    const event = appended.event as JsonObject;
    return captureResult({ status: "captured", trace_id: identity.traceId, task_id: identity.taskId, event_ref: eventRef,
      sequence: Number(event.sequence), call_result: result.status, idempotent: appended.idempotent === true });
  }

  captureAutomaticRecoveryCandidate(input: HookInput, project: ProjectScope | null, terminalCapture: JsonObject | null): JsonObject {
    if (input.session_host !== "codex" || input.hook_event_name !== "Stop") return captureResult({ status: "skipped", reason_code: "unsupported_host_event" });
    const retryScope = projectScope(project), retryIdentity = retryScope ? traceIdentity(input, retryScope) : null;
    if (retryScope && retryIdentity) {
      const experienceStore = this.experienceStore();
      const stranded = experienceStore.list("experience_trace_distillation_ticket", 100, ticket =>
        ticket.project_scope_id === retryScope.id && ticket.continuation_session_id === retryIdentity.sessionId
        && (ticket.source_turn_id !== retryIdentity.turnId || input.stop_hook_active === true)
        && ["pending_continuation", "continuation_claimed"].includes(String(ticket.status))
        && Number(ticket.expires_at_ms) > Date.now())[0];
      if (stranded) {
        const saved = experienceStore.updateIfVersion("experience_trace_distillation_ticket", String(stranded.id), Number(stranded.version), {
          ...stranded, status: "retryable", retry_reason: "continuation_ended_without_resolution", retryable_at_ms: Date.now(),
        });
        return captureResult({ status: "retryable", ticket_id: String(saved.id), reason_code: "continuation_ended_without_resolution" });
      }
    }
    if (input.stop_hook_active === true) return captureResult({ status: "skipped", reason_code: "continuation_already_active" });
    if (terminalCapture?.status !== "verified" || terminalCapture.outcome !== "passed" || typeof terminalCapture.trace_id !== "string")
      return captureResult({ status: "skipped", reason_code: "terminal_verification_not_passed" });
    const canonicalScope = retryScope;
    const identity = retryIdentity;
    if (!canonicalScope || !identity || identity.traceId !== terminalCapture.trace_id)
      return captureResult({ status: "skipped", reason_code: "trace_identity_unavailable" });
    const traceStore = this.traceStore();
    const experienceStore = this.experienceStore();
    const trace = traceStore.find("trace", identity.traceId);
    if (!trace || trace.status !== "completed" || trace.host !== "codex" || trace.session_id !== identity.sessionId
      || trace.turn_id !== identity.turnId || stableDigest(trace.project_scope) !== stableDigest(canonicalScope))
      return captureResult({ status: "skipped", reason_code: "trace_not_verified" });
    const events = traceStore.list("trace_event", 10_000, event => event.trace_id === identity.traceId)
      .sort((left, right) => Number(left.sequence) - Number(right.sequence));
    const terminal = events.find(event => event.event_kind === "task.terminal_verification"
      && event.operation_id === "codex_task_terminal_verification" && event.status === "passed"
      && event.source === "experience" && event.trust === "verified");
    const verificationEvents = events.filter(event => event.event_kind === "host.tool.completed"
      && event.source === "codex" && event.trust === "observed"
      && typeof (event.action_contract as JsonObject | undefined)?.verification_digest === "string");
    const failedVerification = verificationEvents.filter(event => event.status === "failed");
    const recoveredVerifier = failedVerification.find(failed => verificationEvents.some(passed => passed.status === "succeeded"
      && (passed.action_contract as JsonObject).verification_digest === (failed.action_contract as JsonObject).verification_digest
      && Number(failed.sequence) < Number(passed.sequence) && Number(passed.sequence) < Number(terminal?.sequence ?? 0)));
    if (!terminal || !recoveredVerifier)
      return captureResult({ status: "skipped", reason_code: "no_failed_verification_before_pass" });

    const verifierDigest = (recoveredVerifier.action_contract as JsonObject).verification_digest;
    const sourceEvents = events.filter(event => {
      if (event.event_kind === "host.tool.completed") {
        const action = event.action_contract as JsonObject | undefined;
        return event.actor === "host" && event.source === "codex" && event.trust === "observed"
          && action?.kind === "host_tool_operation" && ["succeeded", "failed", "unknown"].includes(String(event.status))
          && (action.tool_category === "api_mcp" && event.operation_id === "codex_tool_mcp"
            || ["script", "file_edit"].includes(String(action.tool_category))
              && ["codex_tool_bash", "codex_tool_apply_patch", "codex_tool_edit", "codex_tool_write"].includes(String(event.operation_id)));
      }
      return event.event_kind === "task.terminal_verification" && event.operation_id === "codex_task_terminal_verification"
          && event.source === "experience" && event.trust === "verified" && ["passed", "failed"].includes(String(event.status))
        || event.event_kind === "task.terminal_verification.unavailable" && event.operation_id === "codex_task_terminal_verification"
          && event.source === "codex" && event.trust === "observed" && event.status === "unknown";
    });
    const eventRefs = sourceEvents.map(event => ({ kind: "trace_event", id: String(event.id), version: Number(event.version),
      digest: String(event.event_digest), sequence: Number(event.sequence), event_kind: String(event.event_kind),
      operation_id: String(event.operation_id), status: String(event.status),
      ...(typeof (event.action_contract as JsonObject | undefined)?.verification_digest === "string"
        ? { verification_digest: String((event.action_contract as JsonObject).verification_digest) } : {}),
      ...((event.action_contract as JsonObject | undefined)?.tool_category === "api_mcp"
        ? { tool_category: "api_mcp", tool_name: String((event.action_contract as JsonObject).tool_name) } : {}) }));
    const observationId = Array.isArray(terminal.output_refs) ? terminal.output_refs.find(value => typeof value === "string") : undefined;
    const observation = typeof observationId === "string" ? experienceStore.find("workflow_evolution_observation", observationId) : null;
    if (!observation || observation.lifecycle !== "accepted" || observation.outcome !== "passed")
      return captureResult({ status: "skipped", reason_code: "verified_observation_unavailable" });
    const evidenceRefs: JsonObject[] = [];
    for (const rawId of Array.isArray(observation.evidence_ids) ? observation.evidence_ids : []) {
      const evidence = experienceStore.find("evidence", String(rawId));
      if (!evidence) return captureResult({ status: "skipped", reason_code: "verified_evidence_unavailable" });
      evidenceRefs.push({ kind: "evidence", id: String(evidence.id), version: Number(evidence.version), digest: stableDigest(evidence) });
    }
    if (!evidenceRefs.length) return captureResult({ status: "skipped", reason_code: "verified_evidence_unavailable" });
    const observationRef = { kind: "workflow_evolution_observation", id: String(observation.id), version: Number(observation.version), digest: stableDigest(observation) };
    const traceRef = { kind: "trace", id: String(trace.id), version: Number(trace.version), digest: stableDigest(trace) };
    const ticketId = `experience_trace_distillation_${digest({ trace_id: trace.id, terminal_event: terminal.id }).slice(-24)}`;
    const authorization = { host: "codex", project_scope_id: canonicalScope.id, task_id: identity.taskId,
      session_id: identity.sessionId, source_turn_id: identity.turnId, trace_ref: traceRef,
      event_refs: eventRefs, observation_refs: [observationRef], evidence_refs: evidenceRefs, recovery_verifier_digest: verifierDigest };
    const authorizationDigest = stableDigest(authorization);
    const existing = experienceStore.find("experience_trace_distillation_ticket", ticketId);
    if (existing) {
      if (existing.authorization_digest !== authorizationDigest) return captureResult({ status: "rejected", reason_code: "ticket_authorization_conflict" });
      return captureResult({ status: "candidate_request", ticket_id: ticketId, idempotent: true,
        authorized_trace_id: trace.id, expires_at_ms: existing.expires_at_ms });
    }
    const ticket = experienceStore.create("experience_trace_distillation_ticket", ticketId, {
      ...authorization, authorization_digest: authorizationDigest, status: "pending_continuation",
      created_at_ms: Date.now(), expires_at_ms: Date.now() + 15 * 60_000,
      continuation_session_id: identity.sessionId, continuation_turn_id: null, candidate_ref: null, work_item_ref: null,
      content_stored: false,
    });
    return captureResult({ status: "candidate_request", ticket_id: ticketId, idempotent: false,
      authorized_trace_id: trace.id, expires_at_ms: ticket.expires_at_ms });
  }

  recordTerminalVerification(input: HookInput, project: ProjectScope | null, finalized: JsonObject | null): JsonObject {
    if (input.session_host !== "codex") return captureResult({ status: "rejected", reason_code: "unsupported_host" });
    if (input.hook_event_name !== "Stop") return captureResult({ status: "rejected", reason_code: "unsupported_host_event" });
    const canonicalScope = projectScope(project);
    if (!canonicalScope) return captureResult({ status: "rejected", reason_code: "project_scope_unavailable" });
    const identity = traceIdentity(input, canonicalScope);
    if (!identity) return captureResult({ status: "rejected", reason_code: "missing_task_identity" });
    const traceStore = this.traceStore();
    const trace = traceStore.find("trace", identity.traceId);
    if (!trace) return captureResult({ status: "skipped", reason_code: "trace_not_found" });
    if (trace.host !== "codex" || stableDigest(trace.project_scope) !== stableDigest(canonicalScope)
      || trace.session_id !== identity.sessionId || trace.turn_id !== identity.turnId)
      return captureResult({ status: "rejected", reason_code: "trace_identity_conflict" });
    if (["completed", "failed", "cancelled", "blocked"].includes(String(trace.status))) {
      const prior = traceStore.list("trace_event", 10_000, event => event.trace_id === identity.traceId
        && ["task.terminal_verification", "task.terminal_verification.unavailable"].includes(String(event.event_kind)))
        .sort((a, b) => Number(b.sequence) - Number(a.sequence))[0];
      if (!prior) return captureResult({ status: "rejected", reason_code: "trace_terminal" });
      if (prior.event_kind === "task.terminal_verification" && prior.operation_id === "codex_task_terminal_verification"
        && prior.source === "experience" && prior.trust === "verified" && ["passed", "failed"].includes(String(prior.status))) {
        return captureResult({ status: "verified", trace_id: identity.traceId, task_id: identity.taskId, event_ref: prior.id,
          sequence: Number(prior.sequence), idempotent: true, outcome: prior.status });
      }
      if (prior.event_kind === "task.terminal_verification.unavailable" && prior.operation_id === "codex_task_terminal_verification"
        && prior.source === "codex" && prior.trust === "observed" && prior.status === "unknown") {
        return captureResult({ status: "unverified", trace_id: identity.traceId, task_id: identity.taskId, event_ref: prior.id,
          sequence: Number(prior.sequence), idempotent: true, reason_code: "accepted_terminal_verification_unavailable" });
      }
      return captureResult({ status: "rejected", reason_code: "terminal_event_identity_conflict" });
    }

    const observation = finalized?.observation && typeof finalized.observation === "object" && !Array.isArray(finalized.observation)
      ? finalized.observation as JsonObject : null;
    const outcome = observation?.outcome === "passed" || observation?.outcome === "failed" ? observation.outcome : null;
    const accepted = typeof observation?.id === "string" && SAFE_ID.test(observation.id) && outcome !== null;
    const eventKind = accepted ? "task.terminal_verification" : "task.terminal_verification.unavailable";
    const eventRef = `codex_host_terminal_${digest({ trace_id: identity.traceId, event_kind: eventKind,
      observation_id: accepted ? observation!.id : null })}`;
    const status = accepted ? outcome! : "unknown";
    const existing = traceStore.find("trace_event", eventRef);
    if (existing) {
      const expected = { traceId: identity.traceId, eventKind, operationId: "codex_task_terminal_verification", status,
        inputRefs: [eventRef], source: accepted ? "experience" : "codex", trust: accepted ? "verified" : "observed" };
      if (!eventMatches(existing, expected)) return captureResult({ status: "rejected", reason_code: "event_identity_conflict" });
      if (accepted)
        this.service.traceFinalize({ trace_id: identity.traceId, status: outcome === "passed" ? "completed" : "failed",
          summary: "Accepted task terminal verification", verdict: `task_verification_${outcome}`, evidence_ids: [String(observation!.id)] });
      return captureResult({ status: accepted ? "verified" : "unverified", trace_id: identity.traceId,
        task_id: identity.taskId, event_ref: eventRef, sequence: Number(existing.sequence), idempotent: true,
        ...(accepted ? { outcome } : { reason_code: "accepted_terminal_verification_unavailable" }) });
    }
    const appended = this.service.traceAppend({ trace_id: identity.traceId, event_id: eventRef, event_kind: eventKind,
      actor: accepted ? "experience" : "host", source: accepted ? "experience" : "codex", trust: accepted ? "verified" : "observed",
      operation_id: "codex_task_terminal_verification", status,
      input_refs: [eventRef],
      ...(accepted ? { output_refs: [String(observation!.id)], evidence_ids: [String(observation!.id)] }
        : { error_class: "accepted_terminal_verification_unavailable" }),
      data: {}, summary: accepted ? "Accepted task terminal verification" : "Accepted task terminal verification unavailable" });
    const event = appended.event as JsonObject;
    if (accepted) this.service.traceFinalize({ trace_id: identity.traceId, status: outcome === "passed" ? "completed" : "failed",
      summary: "Accepted task terminal verification", verdict: `task_verification_${outcome}`, evidence_ids: [String(observation!.id)] });
    return captureResult({ status: accepted ? "verified" : "unverified", trace_id: identity.traceId, task_id: identity.taskId,
      event_ref: eventRef, sequence: Number(event.sequence), idempotent: appended.idempotent === true,
      ...(accepted ? { outcome } : { reason_code: "accepted_terminal_verification_unavailable" }) });
  }
}
