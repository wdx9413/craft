import { randomUUID } from "node:crypto";
import type { JsonObject } from "./infrastructure/store.ts";
import { CraftStore } from "./infrastructure/store.ts";
import { TRACE_SCHEMA, TRACE_SCHEMA_REVISION } from "./runtime-truth.ts";
import { LocalTraceArchiveStore, type TraceArchivePointer, type TraceArchiveStore } from "./trace-archive-store.ts";
import { text } from "./validation.ts";
import { canonicalJson, stableDigest, payload } from "./digest.ts";

/** Current write format. Legacy callers may still import this name. */
export const TRACE_SCHEMA_VERSION = TRACE_SCHEMA;
export const LEGACY_TRACE_SCHEMA_VERSION = "craft.trace.v1";
export type TraceStatus = "running" | "completed" | "failed" | "cancelled" | "blocked";
export type TraceTrust = "observed" | "verified" | "human" | "untrusted";

const TERMINAL = new Set<TraceStatus>(["completed", "failed", "cancelled", "blocked"]);
const TRUST = new Set<TraceTrust>(["observed", "verified", "human", "untrusted"]);
const SIGNALS = new Set(["accepted", "rejected", "corrected", "retried", "stopped", "handoff", "rated"]);

function optional(value: unknown): string | null { return value === undefined || value === null ? null : text(value, "reference"); }
function object(value: unknown, name: string, fallback: JsonObject = {}): JsonObject {
  if (value === undefined) return fallback;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}
function strings(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const items = value.map((item) => text(item, name));
  if (new Set(items).size !== items.length) throw new Error(`${name} must contain unique values`);
  return items;
}
function number(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) throw new Error(`${name} must be a non-negative finite number`);
  return result;
}
function safeData(value: unknown, name: string): JsonObject {
  const result = object(value, name);
  if (/["']?(?:api[_-]?key|authorization|cookie|password|secret|token)["']?\s*[:=]/iu.test(JSON.stringify(result))) throw new Error(`${name} must not contain sensitive assignments`);
  return result;
}

/**
 * The canonical, host-neutral event ledger used by every adapter. Raw prompt
 * and business content is never persisted here; callers provide references,
 * digests and bounded state facts instead.
 */
export class TraceKernel {
  readonly store: CraftStore;
  readonly archives: TraceArchiveStore;
  constructor(store: CraftStore, archives: TraceArchiveStore = new LocalTraceArchiveStore(store.paths.logsDir)) { this.store = store; this.archives = archives; }

  start(args: JsonObject): JsonObject {
    const taskId = text(args.task_id, "task_id");
    const traceId = String(args.trace_id ?? `trace_${randomUUID().replaceAll("-", "")}`);
    const identity = { task_id: taskId, launch_id: optional(args.launch_id), run_id: optional(args.run_id), trial_id: optional(args.trial_id), attempt_id: optional(args.attempt_id), operation_id: optional(args.operation_id), model_fingerprint: optional(args.model_fingerprint), environment_fingerprint: optional(args.environment_fingerprint), capability_fingerprint: optional(args.capability_fingerprint), policy_fingerprint: optional(args.policy_fingerprint) };
    const identityDigest = stableDigest(identity);
    const existing = this.store.find("trace", traceId);
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Trace idempotency conflict");
      return { trace: existing, idempotent: true };
    }
    return { trace: this.store.create("trace", traceId, { schema: TRACE_SCHEMA_VERSION, schema_revision: TRACE_SCHEMA_REVISION, ...identity, identity_digest: identityDigest, status: "running", next_sequence: 0, event_count: 0, started_at: new Date().toISOString(), metadata_digest: stableDigest(safeData(args.metadata, "metadata")) }), idempotent: false };
  }

  append(args: JsonObject): JsonObject {
    const traceId = text(args.trace_id, "trace_id");
    const trace = this.store.get("trace", traceId);
    if (TERMINAL.has(String(trace.status) as TraceStatus)) throw new Error("Cannot append to a terminal Trace");
    const eventKind = text(args.event_kind ?? args.event_type, "event_kind");
    const requestedEventId = args.event_id === undefined ? null : String(args.event_id);
    const existingRequested = requestedEventId === null ? null : this.store.find("trace_event", requestedEventId);
    const sequence = existingRequested ? Number(existingRequested.sequence) : args.sequence === undefined ? Number(trace.next_sequence) + 1 : Number(args.sequence);
    if (!Number.isInteger(sequence) || (!existingRequested && sequence !== Number(trace.next_sequence) + 1)) throw new Error("Trace event sequence must be the next contiguous integer");
    const trust = String(args.trust ?? (args.source === "human" ? "human" : "untrusted")) as TraceTrust;
    if (!TRUST.has(trust)) throw new Error("Trace event trust is unsupported");
    const eventId = requestedEventId ?? `${traceId}:${sequence}`;
    const data = safeData(args.data, "data");
    const identity = { trace_id: traceId, sequence, event_kind: eventKind, actor: String(args.actor ?? "system"), source: String(args.source ?? "craft"), trust, span_id: optional(args.span_id) ?? `${traceId}:span:${sequence}`, parent_span_id: optional(args.parent_span_id), operation_id: optional(args.operation_id), action_contract: args.action_contract === undefined ? null : safeData(args.action_contract, "action_contract"), state_before: args.state_before === undefined ? null : safeData(args.state_before, "state_before"), state_after: args.state_after === undefined ? null : safeData(args.state_after, "state_after"), input_refs: strings(args.input_refs, "input_refs"), output_refs: strings(args.output_refs, "output_refs"), capability_revision: optional(args.capability_revision), policy_revision: optional(args.policy_revision), model_fingerprint: optional(args.model_fingerprint), environment_fingerprint: optional(args.environment_fingerprint), workspace_before: optional(args.workspace_before), workspace_after: optional(args.workspace_after), usage: args.usage === undefined ? null : safeData(args.usage, "usage"), cost_usd: number(args.cost_usd, "cost_usd"), duration_ms: number(args.duration_ms, "duration_ms"), error_class: optional(args.error_class), status: optional(args.status), summary: optional(args.summary), data_digest: stableDigest(data), content_stored: false };
    const eventDigest = stableDigest(identity);
    const existing = existingRequested ?? this.store.find("trace_event", eventId);
    if (existing) {
      if (existing.event_digest !== eventDigest) throw new Error("Trace event idempotency conflict");
      return { event: existing, trace, idempotent: true };
    }
    const event = this.store.create("trace_event", eventId, { schema: TRACE_SCHEMA_VERSION, schema_revision: TRACE_SCHEMA_REVISION, ...identity, event_digest: eventDigest, trace_id: traceId });
    this.store.appendEvent(`trace:${traceId}`, eventKind, { event_id: event.id, trace_id: traceId, sequence, event_digest: eventDigest, trust, output_refs: identity.output_refs });
    const savedTrace = this.store.save("trace", traceId, { ...payload(trace), next_sequence: sequence, event_count: Number(trace.event_count) + 1, last_event_id: event.id, last_event_at: event.created_at });
    return { event, trace: savedTrace, idempotent: false };
  }

  observe(args: JsonObject): JsonObject {
    return this.append({ ...args, event_kind: "state.observed", trust: args.trust ?? "observed", actor: args.actor ?? "observer", data: args.data ?? {}, state_before: args.state_before ?? {}, state_after: args.state_after ?? {} });
  }

  feedback(args: JsonObject): JsonObject {
    const traceId = text(args.trace_id, "trace_id"); this.store.get("trace", traceId);
    const signal = text(args.signal, "signal"); if (!SIGNALS.has(signal)) throw new Error("Trace feedback signal is unsupported");
    const summary = text(args.summary, "summary"); const feedbackId = String(args.feedback_id ?? `feedback_${traceId}_${stableDigest({ signal, summary }).slice(-16)}`);
    const existing = this.store.find("trace_feedback", feedbackId);
    if (existing) {
      if (existing.signal !== signal || existing.summary !== summary) throw new Error("Trace feedback idempotency conflict");
      return { feedback: existing, idempotent: true };
    }
    const record = this.store.create("trace_feedback", feedbackId, { trace_id: traceId, signal, actor: String(args.actor ?? "human"), summary, value: args.value === undefined ? null : safeData(args.value, "value"), evidence_ids: strings(args.evidence_ids, "evidence_ids"), outcome: optional(args.outcome), signal_digest: stableDigest({ signal, summary, value: args.value ?? null }) });
    const event = this.append({ trace_id: traceId, event_kind: `feedback.${signal}`, actor: record.actor, source: "feedback", trust: record.actor === "human" ? "human" : "untrusted", summary, data: {}, output_refs: [record.id] });
    return { feedback: record, event, idempotent: event.idempotent === true };
  }

  finalize(args: JsonObject): JsonObject {
    const traceId = text(args.trace_id, "trace_id"); const trace = this.store.get("trace", traceId); const status = text(args.status, "status") as TraceStatus;
    if (!TERMINAL.has(status)) throw new Error("Trace final status is unsupported");
    if (TERMINAL.has(String(trace.status) as TraceStatus)) return { trace, idempotent: true };
    const event = this.append({ trace_id: traceId, event_kind: "trace.finalized", actor: "craft", source: "craft", trust: "verified", summary: text(args.summary, "summary"), status, data: {}, evidence_ids: strings(args.evidence_ids, "evidence_ids") });
    const saved = this.store.save("trace", traceId, { ...payload(event.trace as JsonObject), status, finalized_at: new Date().toISOString(), verdict: optional(args.verdict), final_evidence_ids: strings(args.evidence_ids, "evidence_ids") });
    return { trace: saved, event, idempotent: false };
  }

  get(args: JsonObject): JsonObject {
    const traceId = text(args.trace_id, "trace_id"); const trace = this.store.find("trace", traceId);
    if (trace) return { trace, events: this.store.list("trace_event", Number.MAX_SAFE_INTEGER, (item) => item.trace_id === trace.id).sort((a, b) => Number(a.sequence) - Number(b.sequence)), feedback: this.store.list("trace_feedback", Number.MAX_SAFE_INTEGER, (item) => item.trace_id === trace.id) };
    const archive = this.store.find("trace_archive", traceId); if (!archive) throw new Error(`Unknown trace: ${traceId}`);
    const bundle = this.archives.read(this.archivePointer(archive));
    return { trace: bundle.trace, events: bundle.events, feedback: bundle.feedback, archived: true, archive };
  }

  query(args: JsonObject = {}): JsonObject {
    const limit = args.limit === undefined ? 100 : Number(args.limit); if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error("limit must be an integer between 1 and 10000");
    const traceId = args.trace_id === undefined ? null : text(args.trace_id, "trace_id"); const taskId = args.task_id === undefined ? null : text(args.task_id, "task_id"); const eventKind = args.event_kind === undefined ? null : text(args.event_kind, "event_kind");
    const hot = this.store.list("trace_event", Number.MAX_SAFE_INTEGER, (item) => (traceId === null || item.trace_id === traceId) && (eventKind === null || item.event_kind === eventKind) && (taskId === null || this.store.find("trace", String(item.trace_id))?.task_id === taskId));
    const archived: JsonObject[] = this.store.list("trace_archive", Number.MAX_SAFE_INTEGER, (archive) => (traceId === null || archive.trace_id === traceId) && (taskId === null || archive.task_id === taskId)).flatMap((archive): JsonObject[] => {
      const bundle = this.archives.read(this.archivePointer(archive));
      return bundle.events.filter((event) => eventKind === null || event.event_kind === eventKind).map((event) => ({ ...event, archived: true, archive_uri: archive.archive_uri }));
    });
    const events = [...hot, ...archived].sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""))).slice(0, limit);
    return { schema: TRACE_SCHEMA_VERSION, count: events.length, events };
  }

  replayBundle(args: JsonObject): JsonObject {
    const result = this.get(args); const trace = result.trace as JsonObject; const required = ["model_fingerprint", "environment_fingerprint", "capability_fingerprint", "policy_fingerprint"]; const replayable = required.every((key) => typeof trace[key] === "string" && String(trace[key]).length > 0) && (result.events as JsonObject[]).every((event) => event.event_kind === "trace.finalized" || (event.data_digest && event.action_contract !== null));
    return { schema: TRACE_SCHEMA_VERSION, trace_id: trace.id, replayable, raw_content: false, trace, events: result.events, feedback: result.feedback, replay: { required_fingerprints: required, state_refs: (result.events as JsonObject[]).map((event) => ({ sequence: event.sequence, before: event.workspace_before, after: event.workspace_after })) } };
  }

  compileCase(args: JsonObject): JsonObject {
    const result = this.get({ trace_id: args.trace_id }); const trace = result.trace as JsonObject; if (!TERMINAL.has(String(trace.status) as TraceStatus)) throw new Error("Trace Case requires a terminal Trace");
    const partition = String(args.partition ?? "development"); if (!(new Set(["development", "held_out"]).has(partition))) throw new Error("Trace Case partition is unsupported");
    const approvedBy = args.approved_by === undefined ? null : text(args.approved_by, "approved_by"); if (partition === "held_out" && approvedBy === null) throw new Error("held_out Trace Case requires approved_by");
    const caseId = String(args.case_id ?? `trace_case_${trace.id}`); const eventIds = (result.events as JsonObject[]).map((event) => String(event.id)); const identity = { source_trace_id: trace.id, trace_version: trace.version, event_ids: eventIds, partition, acceptance_contract_ref: optional(args.acceptance_contract_ref), summary: text(args.summary, "summary") }; const caseDigest = stableDigest(identity); const existing = this.store.find("trace_case", caseId);
    if (existing) { if (existing.case_digest !== caseDigest) throw new Error("Trace Case idempotency conflict"); return { case: existing, idempotent: true }; }
    return { case: this.store.create("trace_case", caseId, { ...identity, case_digest: caseDigest, sanitized: true, raw_content_stored: false, contamination_flags: strings(args.contamination_flags, "contamination_flags"), approved_by: approvedBy, status: "candidate" }), idempotent: false };
  }

  retentionPlan(args: JsonObject): JsonObject {
    const policyId = text(args.policy_id ?? "default", "policy_id"); const maxDays = Number(args.max_days ?? 7); const maxEvents = Number(args.max_events ?? 100_000); if (!Number.isInteger(maxDays) || maxDays < 1) throw new Error("max_days must be a positive integer"); if (!Number.isInteger(maxEvents) || maxEvents < 1) throw new Error("max_events must be a positive integer");
    if (args.replace !== undefined && args.replace !== true && args.replace !== false) throw new Error("replace must be a boolean");
    const existing = this.store.find("trace_policy", policyId); const identity = { max_days: maxDays, max_events: maxEvents, pii_mode: String(args.pii_mode ?? "digest_only") }; if (existing) { if (existing.identity_digest === stableDigest(identity)) return { policy: existing, idempotent: true }; if (args.replace !== true) throw new Error("Trace policy idempotency conflict"); return { policy: this.store.save("trace_policy", policyId, { ...payload(existing), ...identity, identity_digest: stableDigest(identity), policy_revision: Number(existing.policy_revision ?? 1) + 1, updated_by: String(args.updated_by ?? "operator") }), idempotent: false }; }
    return { policy: this.store.create("trace_policy", policyId, { ...identity, identity_digest: stableDigest(identity), policy_revision: 1, archive_before_delete: true, automatic_after_archive: true, deletion_requires_review: false }), idempotent: false };
  }

  /** Archive and remove only terminal traces older than the retention window. */
  retentionSweep(args: JsonObject = {}): JsonObject {
    const now = args.now === undefined ? new Date().toISOString() : String(args.now);
    if (Number.isNaN(Date.parse(now))) throw new Error("now must be an ISO timestamp");
    const policy = this.resolveRetentionPolicy(args); const maxDays = policy.maxDays; const limit = Number(args.limit ?? 100);
    if (!Number.isInteger(maxDays) || maxDays < 1) throw new Error("max_days must be a positive integer");
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error("limit must be an integer between 1 and 10000");
    const cutoff = Date.parse(now) - maxDays * 86_400_000;
    const candidates = this.store.list("trace", Number.MAX_SAFE_INTEGER)
      .filter((trace) => TERMINAL.has(String(trace.status) as TraceStatus))
      .filter((trace) => Date.parse(String(trace.last_event_at ?? trace.updated_at ?? trace.started_at)) < cutoff)
      .slice(0, limit);
    const archives: string[] = []; let deleted = 0;
    for (const trace of candidates) {
      const result = this.get({ trace_id: trace.id }); const events = result.events as JsonObject[]; const feedback = result.feedback as JsonObject[];
      const existing = this.store.find("trace_archive", String(trace.id));
      const archive = existing ? this.archivePointer(existing) : this.archives.write({ trace_id: String(trace.id), trace_version: Number(trace.version), archived_at: now, trace, events, feedback });
      if (!existing) this.store.create("trace_archive", String(trace.id), { trace_id: trace.id, trace_version: trace.version, task_id: trace.task_id, status: trace.status, archived_at: now, last_event_at: trace.last_event_at ?? trace.updated_at, event_count: events.length, feedback_count: feedback.length, archive_backend_id: archive.backend_id ?? "local", archive_storage: archive.storage, archive_locator: archive.locator, archive_uri: archive.uri, archive_format: archive.format, content_digest: archive.content_digest, bytes: archive.bytes });
      this.store.removeTraceRecords(String(trace.id), events.map((event) => String(event.id)), feedback.map((item) => String(item.id)));
      archives.push(archive.uri); deleted += 1;
    }
    return { schema: TRACE_SCHEMA_VERSION, now, policy_id: policy.id, policy_revision: policy.revision, policy_source: policy.source, max_days: maxDays, cutoff: new Date(cutoff).toISOString(), scanned: candidates.length, archived: archives.length, deleted, archives };
  }

  appendTrial(args: JsonObject): JsonObject {
    const trialId = text(args.trial_id, "trial_id"); const traceId = `trial:${trialId}`; if (!this.store.find("trace", traceId)) this.start({ trace_id: traceId, task_id: String(this.store.get("trial", trialId).task_id), trial_id: trialId, environment_fingerprint: args.environment_fingerprint });
    return this.append({ ...args, trace_id: traceId, event_kind: args.event_kind ?? args.event_type, actor: args.actor ?? "system", source: args.source ?? "trial", trust: args.trust ?? (args.source === "human_observed" ? "human" : "observed"), data: args.data ?? {}, input_refs: args.input_refs ?? [], output_refs: [...strings(args.artifact_ids, "artifact_ids"), ...strings(args.evidence_ids, "evidence_ids")] });
  }

  private archivePointer(record: JsonObject): TraceArchivePointer {
    return { ...(record.archive_backend_id === undefined ? {} : { backend_id: text(record.archive_backend_id, "archive_backend_id") }), storage: String(record.archive_storage) as TraceArchivePointer["storage"], format: String(record.archive_format) as TraceArchivePointer["format"], locator: text(record.archive_locator, "archive_locator"), uri: text(record.archive_uri, "archive_uri"), content_digest: text(record.content_digest, "archive content_digest"), bytes: Number(record.bytes) };
  }

  private resolveRetentionPolicy(args: JsonObject): { id: string; revision: number; maxDays: number; source: "override" | "stored" | "builtin" } {
    if (args.max_days !== undefined) return { id: "override", revision: 0, maxDays: Number(args.max_days), source: "override" };
    const id = text(args.policy_id ?? "default", "policy_id"); const stored = this.store.find("trace_policy", id);
    if (stored) return { id, revision: Number(stored.policy_revision ?? 1), maxDays: Number(stored.max_days), source: "stored" };
    if (id !== "default") throw new Error("Unknown Trace retention policy");
    return { id: "default", revision: 0, maxDays: 7, source: "builtin" };
  }
}