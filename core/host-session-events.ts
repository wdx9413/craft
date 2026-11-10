import { createHash, randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { TraceKernel } from "./trace-kernel.ts";
import { text } from "./validation.ts";
import { digestJson, payload } from "./digest.ts";

const KINDS = new Set(["session.started", "host.dispatched", "host.receipt", "state.observed", "session.paused", "session.resumed", "session.completed", "session.failed", "session.cancelled"]);
const TERMINAL = new Set(["session.completed", "session.failed", "session.cancelled"]);
const SENSITIVE = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]/iu;



function refs(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const result = value.map((item) => text(item, name)); if (new Set(result).size !== result.length) throw new Error(`${name} must be unique`);
  if (result.some((item) => SENSITIVE.test(item))) throw new Error(`${name} must not contain sensitive data`);
  return result.sort();
}
function optionalRef(value: unknown, name: string): string | null { if (value === undefined || value === null) return null; const result = text(value, name); if (SENSITIVE.test(result)) throw new Error(`${name} must not contain sensitive data`); return result; }


/**
 * Host-neutral session protocol. It does not retain chat content: each event
 * becomes a contiguous, digest/reference-only fact in Craft's canonical Trace.
 */
export class HostSessionEventKernel {
  readonly store: CraftStore;
  readonly trace: TraceKernel;
  constructor(store: CraftStore, trace: TraceKernel) { this.store = store; this.trace = trace; }

  open(args: JsonObject): JsonObject {
    const sessionId = String(args.session_id ?? `host_session_${randomUUID().replaceAll("-", "")}`);
    const traceId = String(args.trace_id ?? `host_session_trace_${sessionId}`); const taskId = text(args.task_id, "task_id");
    const identity = { trace_id: traceId, task_id: taskId, host_id: text(args.host_id, "host_id"), environment_fingerprint: text(args.environment_fingerprint, "environment_fingerprint"), policy_fingerprint: text(args.policy_fingerprint, "policy_fingerprint"), capability_fingerprint: text(args.capability_fingerprint, "capability_fingerprint"), model_fingerprint: args.model_fingerprint === undefined ? null : text(args.model_fingerprint, "model_fingerprint"), budget_fingerprint: args.budget_fingerprint === undefined ? null : text(args.budget_fingerprint, "budget_fingerprint") };
    const identityDigest = digestJson(identity); const existing = this.store.find("host_session", sessionId);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Host Session idempotency conflict"); return { session: existing, idempotent: true }; }
    const trace = this.trace.start({ trace_id: traceId, task_id: taskId, environment_fingerprint: identity.environment_fingerprint, policy_fingerprint: identity.policy_fingerprint, capability_fingerprint: identity.capability_fingerprint, metadata: { session_id: sessionId, host_id: identity.host_id } }).trace as JsonObject;
    const session = this.store.create("host_session", sessionId, { ...identity, identity_digest: identityDigest, trace_version: trace.version, status: "running", next_sequence: 0, raw_content_stored: false });
    const opened = this.append({ session_id: session.id, kind: "session.started", event_id: `${session.id}:started` });
    return { session: opened.session, trace_event: opened.trace_event, idempotent: false };
  }

  append(args: JsonObject): JsonObject {
    const session = this.store.get("host_session", text(args.session_id, "session_id"));
    if (session.status !== "running") throw new Error("Host Session is terminal or paused");
    const kind = text(args.kind, "kind"); if (!KINDS.has(kind) || kind === "session.started" && Number(session.next_sequence) !== 0) throw new Error("Host Session event kind is unsupported");
    const requestedEventId = args.event_id === undefined ? null : String(args.event_id);
    const existing = requestedEventId === null ? null : this.store.find("host_session_event", requestedEventId);
    const sequence = existing ? Number(existing.sequence) : args.sequence === undefined ? Number(session.next_sequence) + 1 : Number(args.sequence);
    if (!Number.isInteger(sequence) || !existing && sequence !== Number(session.next_sequence) + 1) throw new Error("Host Session event sequence must be contiguous");
    const identity = { session_id: session.id, sequence, kind, host_id: session.host_id, action_contract_ref: optionalRef(args.action_contract_ref, "action_contract_ref"), state_before_ref: optionalRef(args.state_before_ref, "state_before_ref"), state_after_ref: optionalRef(args.state_after_ref, "state_after_ref"), artifact_refs: refs(args.artifact_refs, "artifact_refs"), evidence_refs: refs(args.evidence_refs, "evidence_refs"), summary_digest: optionalRef(args.summary_digest, "summary_digest") };
    const eventId = requestedEventId ?? `${session.id}:${sequence}`; const eventDigest = digestJson(identity);
    if (existing) { if (existing.event_digest !== eventDigest) throw new Error("Host Session event idempotency conflict"); return { session, event: existing, trace_event: this.store.get("trace_event", String(existing.trace_event_id)), idempotent: true }; }
    const trace = this.trace.append({ trace_id: session.trace_id, event_id: `host_session_trace:${eventId}`, event_kind: kind, actor: session.host_id, source: "host_session", trust: "observed", action_contract: identity.action_contract_ref ? { ref: identity.action_contract_ref } : {}, state_before: identity.state_before_ref ? { ref: identity.state_before_ref } : {}, state_after: identity.state_after_ref ? { ref: identity.state_after_ref } : {}, output_refs: [...identity.artifact_refs, ...identity.evidence_refs], summary: identity.summary_digest, data: { session_id: session.id, session_sequence: sequence, event_digest: eventDigest } }).event as JsonObject;
    const event = this.store.create("host_session_event", eventId, { ...identity, event_digest: eventDigest, trace_event_id: trace.id, trace_event_version: trace.version, raw_content_stored: false });
    const status = TERMINAL.has(kind) ? "terminal" : kind === "session.paused" ? "paused" : "running";
    const saved = this.store.save("host_session", String(session.id), { ...payload(session), status, next_sequence: sequence, trace_version: trace.version });
    return { session: saved, event, trace_event: trace, idempotent: false };
  }

  resume(args: JsonObject): JsonObject {
    const session = this.store.get("host_session", text(args.session_id, "session_id")); if (session.status !== "paused") throw new Error("Host Session is not paused");
    const reason = text(args.reason_digest, "reason_digest"); if (!reason.startsWith("sha256:")) throw new Error("Host Session resume requires a reason digest");
    const running = this.store.save("host_session", String(session.id), { ...payload(session), status: "running" });
    return this.append({ session_id: running.id, kind: "session.resumed", event_id: `${running.id}:resume:${Number(running.next_sequence) + 1}`, summary_digest: reason });
  }

  get(args: JsonObject): JsonObject {
    const session = this.store.get("host_session", text(args.session_id, "session_id"));
    return { session, events: this.store.list("host_session_event", 10_000, (item) => item.session_id === session.id).sort((left, right) => Number(left.sequence) - Number(right.sequence)), trace: this.trace.get({ trace_id: session.trace_id }) };
  }
}
