import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "./store.ts";
import { CraftStore } from "./store.ts";
import { craftPaths } from "./paths.ts";
import { TRACE_SCHEMA, TRACE_SCHEMA_REVISION } from "./runtime-truth.ts";

/** Current write format. Legacy callers may still import this name. */
export const TRACE_SCHEMA_VERSION = TRACE_SCHEMA;
export const LEGACY_TRACE_SCHEMA_VERSION = "craft.trace.v1";
export type TraceStatus = "running" | "completed" | "failed" | "cancelled" | "blocked";
export type TraceTrust = "observed" | "verified" | "human" | "untrusted";

const TERMINAL = new Set<TraceStatus>(["completed", "failed", "cancelled", "blocked"]);
const TRUST = new Set<TraceTrust>(["observed", "verified", "human", "untrusted"]);
const SIGNALS = new Set(["accepted", "rejected", "corrected", "retried", "stopped", "handoff", "rated"]);

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}
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
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as JsonObject).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`; }
function safeData(value: unknown, name: string): JsonObject {
  const result = object(value, name);
  if (/["']?(?:api[_-]?key|authorization|cookie|password|secret|token)["']?\s*[:=]/iu.test(JSON.stringify(result))) throw new Error(`${name} must not contain sensitive assignments`);
  return result;
}
function payload(record: JsonObject): JsonObject {
  const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record;
  return rest;
}

/**
 * The canonical, host-neutral event ledger used by every adapter. Raw prompt
 * and business content is never persisted here; callers provide references,
 * digests and bounded state facts instead.
 */
export class TraceKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  start(args: JsonObject): JsonObject {
    const taskId = text(args.task_id, "task_id");
    const traceId = String(args.trace_id ?? `trace_${randomUUID().replaceAll("-", "")}`);
    const identity = { task_id: taskId, launch_id: optional(args.launch_id), run_id: optional(args.run_id), trial_id: optional(args.trial_id), attempt_id: optional(args.attempt_id), operation_id: optional(args.operation_id), model_fingerprint: optional(args.model_fingerprint), environment_fingerprint: optional(args.environment_fingerprint), capability_fingerprint: optional(args.capability_fingerprint), policy_fingerprint: optional(args.policy_fingerprint) };
    const identityDigest = digest(identity);
    const existing = this.store.find("trace", traceId);
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Trace idempotency conflict");
      return { trace: existing, idempotent: true };
    }
    return { trace: this.store.create("trace", traceId, { schema: TRACE_SCHEMA_VERSION, schema_revision: TRACE_SCHEMA_REVISION, ...identity, identity_digest: identityDigest, status: "running", next_sequence: 0, event_count: 0, started_at: new Date().toISOString(), metadata_digest: digest(safeData(args.metadata, "metadata")) }), idempotent: false };
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
    const identity = { trace_id: traceId, sequence, event_kind: eventKind, actor: String(args.actor ?? "system"), source: String(args.source ?? "craft"), trust, span_id: optional(args.span_id) ?? `${traceId}:span:${sequence}`, parent_span_id: optional(args.parent_span_id), operation_id: optional(args.operation_id), action_contract: args.action_contract === undefined ? null : safeData(args.action_contract, "action_contract"), state_before: args.state_before === undefined ? null : safeData(args.state_before, "state_before"), state_after: args.state_after === undefined ? null : safeData(args.state_after, "state_after"), input_refs: strings(args.input_refs, "input_refs"), output_refs: strings(args.output_refs, "output_refs"), capability_revision: optional(args.capability_revision), policy_revision: optional(args.policy_revision), model_fingerprint: optional(args.model_fingerprint), environment_fingerprint: optional(args.environment_fingerprint), workspace_before: optional(args.workspace_before), workspace_after: optional(args.workspace_after), usage: args.usage === undefined ? null : safeData(args.usage, "usage"), cost_usd: number(args.cost_usd, "cost_usd"), duration_ms: number(args.duration_ms, "duration_ms"), error_class: optional(args.error_class), status: optional(args.status), summary: optional(args.summary), data_digest: digest(data), content_stored: false };
    const eventDigest = digest(identity);
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
    const summary = text(args.summary, "summary"); const feedbackId = String(args.feedback_id ?? `feedback_${traceId}_${digest({ signal, summary }).slice(-16)}`);
    const existing = this.store.find("trace_feedback", feedbackId);
    if (existing) {
      if (existing.signal !== signal || existing.summary !== summary) throw new Error("Trace feedback idempotency conflict");
      return { feedback: existing, idempotent: true };
    }
    const record = this.store.create("trace_feedback", feedbackId, { trace_id: traceId, signal, actor: String(args.actor ?? "human"), summary, value: args.value === undefined ? null : safeData(args.value, "value"), evidence_ids: strings(args.evidence_ids, "evidence_ids"), outcome: optional(args.outcome), signal_digest: digest({ signal, summary, value: args.value ?? null }) });
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

  get(args: JsonObject): JsonObject { const trace = this.store.get("trace", text(args.trace_id, "trace_id")); return { trace, events: this.store.list("trace_event", Number.MAX_SAFE_INTEGER, (item) => item.trace_id === trace.id).sort((a, b) => Number(a.sequence) - Number(b.sequence)), feedback: this.store.list("trace_feedback", Number.MAX_SAFE_INTEGER, (item) => item.trace_id === trace.id) }; }

  query(args: JsonObject = {}): JsonObject {
    const limit = args.limit === undefined ? 100 : Number(args.limit); if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error("limit must be an integer between 1 and 10000");
    const traceId = args.trace_id === undefined ? null : text(args.trace_id, "trace_id"); const taskId = args.task_id === undefined ? null : text(args.task_id, "task_id"); const eventKind = args.event_kind === undefined ? null : text(args.event_kind, "event_kind");
    const events = this.store.list("trace_event", Number.MAX_SAFE_INTEGER, (item) => (traceId === null || item.trace_id === traceId) && (eventKind === null || item.event_kind === eventKind) && (taskId === null || this.store.find("trace", String(item.trace_id))?.task_id === taskId)).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).slice(0, limit);
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
    const caseId = String(args.case_id ?? `trace_case_${trace.id}`); const eventIds = (result.events as JsonObject[]).map((event) => String(event.id)); const identity = { source_trace_id: trace.id, trace_version: trace.version, event_ids: eventIds, partition, acceptance_contract_ref: optional(args.acceptance_contract_ref), summary: text(args.summary, "summary") }; const caseDigest = digest(identity); const existing = this.store.find("trace_case", caseId);
    if (existing) { if (existing.case_digest !== caseDigest) throw new Error("Trace Case idempotency conflict"); return { case: existing, idempotent: true }; }
    return { case: this.store.create("trace_case", caseId, { ...identity, case_digest: caseDigest, sanitized: true, raw_content_stored: false, contamination_flags: strings(args.contamination_flags, "contamination_flags"), approved_by: approvedBy, status: "candidate" }), idempotent: false };
  }

  retentionPlan(args: JsonObject): JsonObject {
    const policyId = String(args.policy_id ?? "default"); const maxDays = Number(args.max_days ?? 7); const maxEvents = Number(args.max_events ?? 100_000); if (!Number.isInteger(maxDays) || maxDays < 1) throw new Error("max_days must be a positive integer"); if (!Number.isInteger(maxEvents) || maxEvents < 1) throw new Error("max_events must be a positive integer");
    const existing = this.store.find("trace_policy", policyId); const identity = { max_days: maxDays, max_events: maxEvents, pii_mode: String(args.pii_mode ?? "digest_only") }; if (existing) { if (existing.identity_digest !== digest(identity)) throw new Error("Trace policy idempotency conflict"); return { policy: existing, idempotent: true }; }
    return { policy: this.store.create("trace_policy", policyId, { ...identity, identity_digest: digest(identity), archive_before_delete: true, automatic_after_archive: true, deletion_requires_review: false }), idempotent: false };
  }

  /** Archive and remove only terminal traces older than the retention window. */
  retentionSweep(args: JsonObject = {}): JsonObject {
    const now = args.now === undefined ? new Date().toISOString() : String(args.now);
    if (Number.isNaN(Date.parse(now))) throw new Error("now must be an ISO timestamp");
    const maxDays = Number(args.max_days ?? 7); const limit = Number(args.limit ?? 100);
    if (!Number.isInteger(maxDays) || maxDays < 1) throw new Error("max_days must be a positive integer");
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error("limit must be an integer between 1 and 10000");
    const cutoff = Date.parse(now) - maxDays * 86_400_000;
    const candidates = this.store.list("trace", Number.MAX_SAFE_INTEGER)
      .filter((trace) => TERMINAL.has(String(trace.status) as TraceStatus))
      .filter((trace) => Date.parse(String(trace.last_event_at ?? trace.updated_at ?? trace.started_at)) < cutoff)
      .slice(0, limit);
    const archives: string[] = []; let deleted = 0;
    const paths = craftPaths(this.store.paths.root); const archiveDir = join(paths.logsDir, "trace-archive"); mkdirSync(archiveDir, { recursive: true });
    for (const trace of candidates) {
      const result = this.get({ trace_id: trace.id }); const events = result.events as JsonObject[]; const feedback = result.feedback as JsonObject[];
      const archiveDigest = digest({ trace, events, feedback });
      const archive = { schema: TRACE_SCHEMA_VERSION, trace_id: trace.id, archived_at: now, cutoff: new Date(cutoff).toISOString(), trace, events, feedback, archive_digest: archiveDigest };
      const path = join(archiveDir, `${trace.id}.${String(trace.version)}.${archiveDigest.slice(7, 23)}.json`);
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(archive, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); renameSync(temporary, path); if (process.platform !== "win32") chmodSync(path, 0o600);
      this.store.removeTraceRecords(String(trace.id), events.map((event) => String(event.id)), feedback.map((item) => String(item.id)));
      archives.push(path); deleted += 1;
    }
    return { schema: TRACE_SCHEMA_VERSION, now, max_days: maxDays, cutoff: new Date(cutoff).toISOString(), scanned: candidates.length, archived: archives.length, deleted, archives };
  }

  appendTrial(args: JsonObject): JsonObject {
    const trialId = text(args.trial_id, "trial_id"); const traceId = `trial:${trialId}`; if (!this.store.find("trace", traceId)) this.start({ trace_id: traceId, task_id: String(this.store.get("trial", trialId).task_id), trial_id: trialId, environment_fingerprint: args.environment_fingerprint });
    return this.append({ ...args, trace_id: traceId, event_kind: args.event_kind ?? args.event_type, actor: args.actor ?? "system", source: args.source ?? "trial", trust: args.trust ?? (args.source === "human_observed" ? "human" : "observed"), data: args.data ?? {}, input_refs: args.input_refs ?? [], output_refs: [...strings(args.artifact_ids, "artifact_ids"), ...strings(args.evidence_ids, "evidence_ids")] });
  }
}
