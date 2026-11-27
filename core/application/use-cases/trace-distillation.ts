import type { CraftService } from "../craft-service.ts";
import type { JsonObject } from "../../infrastructure/store.ts";
import { projectIdentityFromRoot } from "../../scope-identity.ts";
import { realpathSync } from "node:fs";
import { stableDigest } from "../../digest.ts";
import { DEFAULT_RULES, Sanitizer } from "@craft/capability-datasec/rules";

declare module "../craft-service.ts" {
  interface CraftService { experienceTraceDistill(args: JsonObject): JsonObject; }
}

const MAX_SOURCES = 8;
const SAFE_TRACE_EVENT_KINDS = new Set(["host.tool.completed", "task.terminal_verification", "task.terminal_verification.unavailable"]);
const SAFE_TOOL_OPERATIONS = new Set(["codex_tool_bash", "codex_tool_apply_patch", "codex_tool_edit", "codex_tool_write"]);
const SAFE_MCP_TOOL_NAME = /^mcp__[A-Za-z0-9_.-]{1,64}__[A-Za-z0-9_.-]{1,96}$/u;
const DISTILLATION_SANITIZER = new Sanitizer(DEFAULT_RULES.map(rule => ({ ...rule, enabled: true })), () => "[REDACTED]");

function id(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,192}$/u.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function recordTraceEvents(store: CraftService["store"], trace: JsonObject): JsonObject[] {
  const rows = store.list("trace_event", 10_001, event => event.trace_id === trace.id)
    .sort((left, right) => Number(left.sequence) - Number(right.sequence));
  if (rows.length > 10_000) throw new Error("Trace source exceeds the supported event limit");
  return rows.filter(event => {
    if (!SAFE_TRACE_EVENT_KINDS.has(String(event.event_kind))) return false;
    if (event.event_kind === "host.tool.completed") {
      const action = event.action_contract as JsonObject | null;
      if (event.actor !== "host" || event.source !== "codex" || event.trust !== "observed"
        || action?.kind !== "host_tool_operation" || !["succeeded", "failed", "unknown"].includes(String(event.status))) return false;
      if (action.tool_category === "api_mcp") {
        return event.operation_id === "codex_tool_mcp" && typeof action.tool_name === "string"
          && SAFE_MCP_TOOL_NAME.test(action.tool_name);
      }
      return ["script", "file_edit"].includes(String(action.tool_category)) && SAFE_TOOL_OPERATIONS.has(String(event.operation_id));
    }
    if (event.event_kind === "task.terminal_verification") {
      return event.operation_id === "codex_task_terminal_verification" && event.source === "experience" && event.trust === "verified"
        && ["passed", "failed"].includes(String(event.status));
    }
    return event.event_kind === "task.terminal_verification.unavailable" && event.operation_id === "codex_task_terminal_verification"
      && event.source === "codex" && event.trust === "observed" && event.status === "unknown";
  }).map(event => ({
    kind: "trace_event", id: String(event.id), version: Number(event.version), digest: String(event.event_digest),
    sequence: Number(event.sequence), event_kind: String(event.event_kind), operation_id: String(event.operation_id), status: String(event.status),
    ...(event.event_kind === "host.tool.completed" && (event.action_contract as JsonObject | null)?.tool_category === "api_mcp"
      ? { tool_category: "api_mcp", tool_name: String((event.action_contract as JsonObject).tool_name) } : {}),
    ...(typeof (event.action_contract as JsonObject | null)?.verification_digest === "string"
      ? { verification_digest: String((event.action_contract as JsonObject).verification_digest) } : {}),
    output_refs: Array.isArray(event.output_refs) ? event.output_refs.filter(ref => typeof ref === "string" && /^[A-Za-z0-9._:-]{1,192}$/u.test(ref)) : [],
  }));
}

function terminalObservation(experience: CraftService, events: JsonObject[], trace: JsonObject): {
  outcome: "verified_passed" | "verified_failed" | "unverified" | "not_observed";
  observations: JsonObject[]; evidence: JsonObject[];
} {
  const terminal = events.find(event => event.event_kind === "task.terminal_verification"
    || event.event_kind === "task.terminal_verification.unavailable");
  if (!terminal) return { outcome: "not_observed", observations: [], evidence: [] };
  if (terminal.event_kind !== "task.terminal_verification") return { outcome: "unverified", observations: [], evidence: [] };
  const outputRefs = terminal.output_refs as string[];
  const finalRefs = Array.isArray(trace.final_evidence_ids) ? trace.final_evidence_ids : [];
  const observationId = [...outputRefs, ...finalRefs].find(ref => typeof ref === "string" && /^[A-Za-z0-9._:-]{1,192}$/u.test(ref));
  if (typeof observationId !== "string") throw new Error("Verified Trace terminal has no Observation reference");
  const observation = experience.store.get("workflow_evolution_observation", observationId);
  const source = observation.source as JsonObject | undefined;
  if (observation.lifecycle !== "accepted" || observation.outcome !== terminal.status || source?.kind !== "host:codex"
    || source.id !== trace.task_id || source.session_id !== trace.session_id || source.scope !== `project:${String((trace.project_scope as JsonObject).id).replace(/^project:/u, "")}`) {
    throw new Error("Verified Trace terminal does not match its Experience Observation");
  }
  const observationRef = { kind: "workflow_evolution_observation", id: String(observation.id), version: Number(observation.version), digest: stableDigest(observation) };
  if (!Array.isArray(observation.evidence_ids) || observation.evidence_ids.length === 0) {
    throw new Error("Verified Trace Observation has no Evidence references");
  }
  const evidenceIds = observation.evidence_ids;
  const evidence = evidenceIds.map(evidenceId => {
    const record = experience.store.get("evidence", String(evidenceId));
    return { kind: "evidence", id: String(record.id), version: Number(record.version), digest: stableDigest(record) };
  });
  return { outcome: terminal.status === "passed" ? "verified_passed" : "verified_failed", observations: [observationRef], evidence };
}

function traceProjectScope(trace: JsonObject): JsonObject | null {
  const scope = trace.project_scope as JsonObject | undefined;
  return scope?.kind === "project" && typeof scope.id === "string" ? scope : null;
}

function sourceForTrace(experience: CraftService, traceStore: CraftService["store"], trace: JsonObject, scope: JsonObject, host: string): JsonObject | null {
  const traceScope = traceProjectScope(trace);
  if (trace.host !== host || !traceScope || traceScope.id !== scope.id || typeof trace.task_id !== "string" || !trace.task_id
    || typeof trace.session_id !== "string" || !trace.session_id || typeof trace.turn_id !== "string" || !trace.turn_id) return null;
  const events = recordTraceEvents(traceStore, trace);
  if (!events.length) return null;
  const terminal = terminalObservation(experience, events, trace);
  const eventRefs = events.map(({ output_refs: _outputRefs, ...event }) => event);
  return {
    host, project_scope_id: String(scope.id), task_id: String(trace.task_id), session_id: String(trace.session_id), turn_id: String(trace.turn_id),
    trace_status: String(trace.status), terminal_outcome: terminal.outcome,
    trace_ref: { kind: "trace", id: String(trace.id), version: Number(trace.version), digest: stableDigest(trace) },
    event_refs: eventRefs, observation_refs: terminal.observations, evidence_refs: terminal.evidence,
  };
}

function selectedTraces(experience: CraftService, traceStore: CraftService["store"], args: JsonObject, scope: JsonObject,
  host: string, sessionId: string, turnId: string): JsonObject[] | JsonObject {
  if (args.ticket_id !== undefined) {
    const ticketId = id(args.ticket_id, "ticket_id");
    const ticket = experience.store.find("experience_trace_distillation_ticket", ticketId);
    const retrying = ticket?.status === "retryable" && args.decision === "retry";
    if (!ticket || ticket.host !== host || ticket.project_scope_id !== scope.id
      || ticket.continuation_session_id !== sessionId
      || Number(ticket.expires_at_ms) <= Date.now()
      || !["pending_continuation", "continuation_claimed"].includes(String(ticket.status)) && !retrying
      || args.decision === "retry" && !retrying) {
      throw new Error("Trace distillation ticket is unavailable for this Host continuation");
    }
    if (!retrying && ticket.continuation_turn_id !== null && ticket.continuation_turn_id !== turnId)
      throw new Error("Trace distillation ticket is already bound to another Host turn");
    const traceRef = ticket.trace_ref as JsonObject | undefined;
    const trace = traceRef && traceStore.find("trace", String(traceRef.id), Number(traceRef.version));
    if (!trace || stableDigest(trace) !== traceRef?.digest) throw new Error("Authorized Trace source is unavailable or changed");
    const source = sourceForTrace(experience, traceStore, trace, scope, host);
    const sourceEvents = Array.isArray(source?.event_refs) ? source.event_refs as JsonObject[] : [];
    const terminal = sourceEvents.find(event => event.event_kind === "task.terminal_verification"
      && event.operation_id === "codex_task_terminal_verification" && event.status === "passed");
    const verifierDigest = ticket.recovery_verifier_digest;
    const hasVerifiedRecovery = typeof verifierDigest === "string" && sourceEvents.some(event => event.event_kind === "host.tool.completed"
      && event.status === "failed" && event.verification_digest === verifierDigest)
      && sourceEvents.some(event => event.event_kind === "host.tool.completed" && event.status === "succeeded"
        && event.verification_digest === verifierDigest && Number(event.sequence) < Number(terminal?.sequence ?? 0));
    if (!hasVerifiedRecovery) throw new Error("Trace distillation ticket no longer proves a failed and then passed identical verifier");
    if (!source || stableDigest({
      host: source.host, project_scope_id: source.project_scope_id, session_id: source.session_id,
      task_id: source.task_id, source_turn_id: source.turn_id, trace_ref: source.trace_ref, event_refs: source.event_refs,
      observation_refs: source.observation_refs, evidence_refs: source.evidence_refs, recovery_verifier_digest: verifierDigest,
    }) !== ticket.authorization_digest) throw new Error("Authorized Trace source no longer matches its ticket");
    if (retrying || ticket.continuation_turn_id === null) {
      experience.store.updateIfVersion("experience_trace_distillation_ticket", ticketId, Number(ticket.version), {
        ...ticket, status: "continuation_claimed", continuation_turn_id: turnId, claimed_at_ms: Date.now(), retry_reason: null,
      });
    }
    return [source];
  }
  if (args.trace_ids !== undefined) {
    if (!Array.isArray(args.trace_ids) || args.trace_ids.length < 1 || args.trace_ids.length > MAX_SOURCES) throw new Error(`trace_ids must contain one to ${MAX_SOURCES} values`);
    const ids = args.trace_ids.map((value, index) => id(value, `trace_ids[${index}]`));
    if (new Set(ids).size !== ids.length) throw new Error("trace_ids must be unique");
    const sources = ids.map(traceId => {
      const trace = traceStore.find("trace", traceId);
      if (!trace) throw new Error("Selected Trace is unavailable; archived sessions require an authorized replay");
      if (trace.session_id !== sessionId || trace.turn_id !== turnId) {
        throw new Error("Selected Trace is not from the current task; archived sessions require an authorized replay");
      }
      const source = sourceForTrace(experience, traceStore, trace, scope, host);
      if (!source) throw new Error("Selected Trace does not match the authorized Host and project scope");
      return source;
    });
    return sources;
  }
  const matches = traceStore.list("trace", 10_001, trace => {
    const traceScope = traceProjectScope(trace);
    return trace.host === host && trace.session_id === sessionId && trace.turn_id === turnId
      && trace.status === "running" && traceScope?.id === scope.id;
  });
  if (matches.length > 10_000) throw new Error("Current Trace lookup exceeds the supported limit");
  const sources = matches.map(trace => sourceForTrace(experience, traceStore, trace, scope, host)).filter((item): item is JsonObject => item !== null);
  if (!sources.length) return { status: "source_unavailable", reason_code: matches.length ? "no_supported_host_events" : "current_trace_not_found", sources: [] };
  if (sources.length > 1) return { status: "source_selection_required", reason_code: "multiple_current_traces", sources };
  return sources;
}

function installDistillationMethod(serviceClass: typeof CraftService): void {
  serviceClass.prototype.experienceTraceDistill = function (args) {
    const host = args.host;
    const sessionId = id(args.session_id, "session_id"), turnId = id(args.turn_id, "turn_id");
    if (host !== "codex") throw new Error("Trace distillation currently supports Codex Hook traces only");
    const scope = args.scope as JsonObject | undefined;
    const projectRoot = typeof args.project_root === "string" ? realpathSync(args.project_root) : "";
    if (!scope || scope.kind !== "project" || typeof scope.id !== "string" || !projectRoot) throw new Error("Trace distillation requires an active Host project binding");
    const canonical = projectIdentityFromRoot(projectRoot).canonical_scope as JsonObject;
    if (canonical.id !== scope.id) throw new Error("Trace distillation project scope does not match the active Host binding");

    const traceOwner = this.capabilityOwned ? this.ownerServices.get("runtime") : this;
    if (!traceOwner) throw new Error("Trace owner is unavailable");
    const ticketId = typeof args.ticket_id === "string" ? id(args.ticket_id, "ticket_id") : null;
    if (args.decision !== undefined && (!["skip", "retry"].includes(String(args.decision)) || !ticketId
      || args.decision === "skip" && args.candidate !== undefined))
      throw new Error("Trace distillation decision requires an eligible ticket_id and consistent candidate fields");
    if (ticketId) {
      const priorTicket = this.store.find("experience_trace_distillation_ticket", ticketId);
      if (priorTicket && priorTicket.host === host && priorTicket.project_scope_id === scope.id
        && priorTicket.continuation_session_id === sessionId && priorTicket.continuation_turn_id === turnId
        && priorTicket.status === "submitted" && priorTicket.candidate_ref && priorTicket.work_item_ref) {
        return { status: "captured", ticket_id: ticketId, candidate_ref: priorTicket.candidate_ref,
          learning_work_item_ref: priorTicket.work_item_ref, idempotent: true };
      }
      if (priorTicket && priorTicket.host === host && priorTicket.project_scope_id === scope.id
        && priorTicket.continuation_session_id === sessionId && priorTicket.continuation_turn_id === turnId
        && priorTicket.status === "skipped") return { status: "skipped", ticket_id: ticketId, candidate_created: false, idempotent: true };
    }
    const captured = selectedTraces(this, traceOwner.store, args, scope, host, sessionId, turnId);
    if (!Array.isArray(captured)) return captured;
    if (ticketId && args.decision === "skip") {
      const ticket = this.store.find("experience_trace_distillation_ticket", ticketId);
      if (!ticket || ticket.continuation_turn_id !== turnId || ticket.status !== "continuation_claimed")
        throw new Error("Trace distillation ticket cannot be skipped from this Host turn");
      const saved = this.store.updateIfVersion("experience_trace_distillation_ticket", ticketId, Number(ticket.version), {
        ...ticket, status: "skipped", closed_at_ms: Date.now(), skip_reason: "no_reusable_learning",
      });
      return { status: "skipped", ticket_id: ticketId, ticket_version: saved.version, candidate_created: false };
    }
    if (args.candidate === undefined) return { status: "sources_ready", sources: captured, candidate_created: false };
    const candidateJson = JSON.stringify(args.candidate);
    if (DISTILLATION_SANITIZER.text(candidateJson) !== candidateJson) throw new Error("Trace distillation candidate contains DataSec-sensitive content");

    try {
      return this.store.transaction(() => {
        const procedures = this.experienceProcedures as unknown as { traceDistillationCapture(input: JsonObject): JsonObject };
        const saved = procedures.traceDistillationCapture({ scope: String(scope.id), sources: captured, candidate: args.candidate,
          ...(ticketId ? { request_id: ticketId } : args.request_id === undefined ? {} : { request_id: args.request_id }) });
        const procedure = saved.procedure as JsonObject | undefined;
        const workItem = saved.learning_work_item as JsonObject | undefined;
        if (!procedure || !workItem) throw new Error("Experience owner did not return a Candidate and Learning Work Item");

        const candidateRef = {
          kind: "experience_procedure",
          id: id(procedure.id, "candidate.id"),
          version: Number(procedure.candidate_version ?? procedure.version),
          digest: String(procedure.definition_digest ?? procedure.content_digest ?? procedure.identity_digest),
        };
        const workItemCandidateRef = workItem.candidate_ref as JsonObject | undefined;
        if (!Number.isSafeInteger(candidateRef.version) || candidateRef.version < 1
          || !/^sha256:[a-f0-9]{64}$/iu.test(candidateRef.digest)
          || !workItemCandidateRef || stableDigest(workItemCandidateRef) !== stableDigest(candidateRef)
          || workItem.scope !== scope.id) {
          throw new Error("Experience owner returned a mismatched Candidate and Learning Work Item");
        }
        const workItemId = id(workItem.id, "learning_work_item.id");
        const workItemVersion = Number(workItem.version);
        if (!Number.isSafeInteger(workItemVersion) || workItemVersion < 1
          || typeof workItem.stage !== "string" || typeof workItem.status !== "string") {
          throw new Error("Experience owner returned an incomplete Learning Work Item");
        }
        const blockedReason = workItem.blocked_reason;
        if (blockedReason !== null && typeof blockedReason !== "string") {
          throw new Error("Experience owner returned an invalid Learning Work Item state");
        }
        if (ticketId) {
          const ticket = this.store.get("experience_trace_distillation_ticket", ticketId);
          if (ticket.status !== "continuation_claimed" || ticket.continuation_turn_id !== turnId)
            throw new Error("Trace distillation ticket is not claimed by this Host turn");
          this.store.updateIfVersion("experience_trace_distillation_ticket", ticketId, Number(ticket.version), {
            ...ticket, status: "submitted", closed_at_ms: Date.now(),
            candidate_ref: candidateRef, work_item_ref: { kind: "experience_learning_work_item", id: workItemId, version: workItemVersion },
          });
        }
        return {
          status: "captured",
          candidate_ref: candidateRef,
          learning_work_item_ref: { kind: "experience_learning_work_item", id: workItemId, version: workItemVersion },
          current_stage: workItem.stage,
          learning_work_item_stage: workItem.stage,
          learning_work_item_status: workItem.status,
          blocked_reason: blockedReason,
          idempotent: saved.idempotent === true && saved.work_item_idempotent === true,
        };
      });
    } catch {
      return {
        status: "blocked",
        reason_code: "learning_work_item_unavailable",
        blocked_reason: "learning_work_item_unavailable",
        candidate_created: false,
      };
    }
  };
}

export function installTraceDistillationMethods(serviceClass: typeof CraftService): void {
  installDistillationMethod(serviceClass);
}
