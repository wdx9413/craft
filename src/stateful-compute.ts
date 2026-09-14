import { createHash, randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

const HOST_KINDS = new Set(["repl", "notebook", "agent_host", "custom"]);
const CONFIDENCE = new Set(["confirmed", "bounded", "unverified"]);
const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{8,}/iu;
function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); const result = value.trim(); if (SECRET.test(result)) throw new Error(`${name} must not contain credentials or secrets`); return result; }
function strings(value: unknown, name: string, required = false): string[] { if (value === undefined && !required) return []; if (!Array.isArray(value)) throw new Error(`${name} must be an array`); const result = value.map((item) => text(item, name)); if (required && !result.length) throw new Error(`${name} must contain at least one value`); if (new Set(result).size !== result.length) throw new Error(`${name} must contain unique values`); return result.sort(); }
function object(value: unknown, name: string): JsonObject { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`); return value as JsonObject; }
function payload(record: JsonObject): JsonObject { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }

/** Host-neutral persistent compute contracts. Craft records state and receipts; an external Host owns execution. */
export class StatefulComputeKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  hostRegister(args: JsonObject): JsonObject {
    const kind = text(args.kind, "kind"); if (!HOST_KINDS.has(kind)) throw new Error("Stateful compute Host kind is unsupported");
    const trust = text(args.trust ?? "bounded", "trust"); if (!new Set(["bounded", "verified"]).has(trust)) throw new Error("Stateful compute Host must be bounded or verified");
    const generatedCode = args.generated_code === true; const conformanceId = args.conformance_id === undefined ? null : text(args.conformance_id, "conformance_id");
    if (generatedCode) { if (!conformanceId) throw new Error("Generated-code Host requires a verified sandbox conformance profile"); const profile = this.store.get("sandbox_conformance", conformanceId); if (profile.status !== "verified" || profile.isolation !== "verified" || profile.network !== "deny") throw new Error("Generated-code Host conformance is not verified and network-denied"); }
    const identity = { kind, label: text(args.label, "label"), trust, generated_code: generatedCode, conformance_id: conformanceId, capabilities: strings(args.capabilities, "capabilities"), execution_authority: false };
    const hostId = String(args.host_id ?? `stateful_compute_host_${randomUUID().replaceAll("-", "")}`); const identityDigest = digest(identity); const existing = this.store.find("stateful_compute_host", hostId);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Stateful compute Host idempotency conflict"); return { host: existing, idempotent: true }; }
    return { host: this.store.create("stateful_compute_host", hostId, { ...identity, identity_digest: identityDigest, status: "active" }), idempotent: false };
  }

  sessionPrepare(args: JsonObject): JsonObject {
    const task = this.store.get("task", text(args.task_id, "task_id")); const host = this.store.get("stateful_compute_host", text(args.host_id, "host_id")); if (host.status !== "active") throw new Error("Stateful compute Host is not active");
    const context = this.store.get("context_resolution_receipt", text(args.context_receipt_id, "context_receipt_id")); if (context.content_free !== true) throw new Error("Stateful compute requires a content-free Context Resolution Receipt");
    const environmentFingerprint = text(args.environment_fingerprint, "environment_fingerprint");
    const identity = { task_id: task.id, task_version: task.version, host_id: host.id, host_version: host.version, context_receipt_id: context.id, context_receipt_version: context.version, environment_fingerprint: environmentFingerprint, workspace_snapshot_ref: text(args.workspace_snapshot_ref, "workspace_snapshot_ref"), budget_ref: text(args.budget_ref, "budget_ref"), allowed_effect: text(args.allowed_effect ?? "read_only", "allowed_effect") };
    if (identity.allowed_effect !== "read_only" && !host.conformance_id) throw new Error("Stateful compute writes require a verified conformance profile");
    const sessionId = String(args.session_id ?? `stateful_compute_session_${randomUUID().replaceAll("-", "")}`); const identityDigest = digest(identity); const existing = this.store.find("stateful_compute_session", sessionId);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Stateful compute Session idempotency conflict"); return { session: existing, idempotent: true }; }
    return { session: this.store.create("stateful_compute_session", sessionId, { ...identity, identity_digest: identityDigest, status: "prepared", state_revision: 0, execution_authority: false, last_receipt_id: null }), idempotent: false };
  }

  dispatch(args: JsonObject): JsonObject {
    const session = this.store.get("stateful_compute_session", text(args.session_id, "session_id"));
    if (Number(args.expected_revision) !== Number(session.state_revision)) throw new Error("Stateful compute Session revision changed; re-observation is required");
    const action = { operation: text(args.operation, "operation"), input_refs: strings(args.input_refs, "input_refs"), expected_revision: session.state_revision, environment_fingerprint: session.environment_fingerprint };
    const dispatchId = String(args.dispatch_id ?? `stateful_compute_dispatch_${randomUUID().replaceAll("-", "")}`); const existing = this.store.find("stateful_compute_dispatch", dispatchId); const actionDigest = digest(action);
    if (existing) { if (existing.action_digest !== actionDigest) throw new Error("Stateful compute Dispatch idempotency conflict"); return { dispatch: existing, idempotent: true }; }
    if (!new Set(["prepared", "paused"]).has(String(session.status))) throw new Error("Stateful compute Session is not dispatchable");
    const dispatch = this.store.create("stateful_compute_dispatch", dispatchId, { session_id: session.id, ...action, action_digest: actionDigest, status: "issued", execution_authority: false });
    const saved = this.store.save("stateful_compute_session", String(session.id), { ...payload(session), status: "running", active_dispatch_id: dispatch.id }); return { session: saved, dispatch, idempotent: false };
  }

  observe(args: JsonObject): JsonObject {
    const dispatch = this.store.get("stateful_compute_dispatch", text(args.dispatch_id, "dispatch_id")); if (dispatch.status !== "issued") throw new Error("Stateful compute Dispatch is not awaiting a Receipt");
    const session = this.store.get("stateful_compute_session", String(dispatch.session_id)); if (session.active_dispatch_id !== dispatch.id || Number(args.observed_revision) !== Number(session.state_revision) + 1) throw new Error("Stateful compute Receipt has a stale revision");
    if (text(args.environment_fingerprint, "environment_fingerprint") !== session.environment_fingerprint) throw new Error("Stateful compute environment drift requires replanning");
    const status = text(args.status, "status"); if (!new Set(["paused", "completed", "failed"]).has(status)) throw new Error("Stateful compute Receipt status is unsupported");
    const outputRefs = strings(args.output_refs, "output_refs"); const receiptId = `stateful_compute_receipt_${dispatch.id}`; const receipt = this.store.create("stateful_compute_receipt", receiptId, { session_id: session.id, dispatch_id: dispatch.id, observed_revision: args.observed_revision, state_digest: text(args.state_digest, "state_digest"), output_refs: outputRefs, usage: object(args.usage ?? {}, "usage"), status, reobserved: true });
    this.store.save("stateful_compute_dispatch", String(dispatch.id), { ...payload(dispatch), status: "consumed", receipt_id: receipt.id });
    const saved = this.store.save("stateful_compute_session", String(session.id), { ...payload(session), status, state_revision: args.observed_revision, last_receipt_id: receipt.id, active_dispatch_id: null }); return { session: saved, receipt };
  }

  delegate(args: JsonObject): JsonObject {
    const session = this.store.get("stateful_compute_session", text(args.session_id, "session_id")); if (!new Set(["prepared", "running", "paused"]).has(String(session.status))) throw new Error("Stateful compute Session cannot delegate work");
    const identity = { parent_session_id: session.id, task_id: session.task_id, objective: text(args.objective, "objective"), role: text(args.role ?? "diagnostic_research", "role"), context_refs: strings(args.context_refs, "context_refs"), budget_ref: session.budget_ref, allocation: object(args.allocation ?? {}, "allocation"), effect: "read_only", result_schema: object(args.result_schema, "result_schema"), async: true };
    const callId = String(args.call_id ?? `subagent_call_${randomUUID().replaceAll("-", "")}`); const identityDigest = digest(identity); const existing = this.store.find("subagent_function_call", callId);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Sub-agent call idempotency conflict"); return { call: existing, idempotent: true }; }
    const existingCalls = this.store.list("subagent_function_call", 1000, (item) => item.parent_session_id === session.id && item.status !== "cancelled"); if (existingCalls.length >= 5) throw new Error("A parent Session may create at most five Sub-agent calls");
    return { call: this.store.create("subagent_function_call", callId, { ...identity, identity_digest: identityDigest, status: "issued", execution_authority: false }), idempotent: false };
  }

  report(args: JsonObject): JsonObject {
    const call = this.store.get("subagent_function_call", text(args.call_id, "call_id")); if (call.status !== "issued") throw new Error("Sub-agent call is not awaiting a result");
    const evidenceIds = strings(args.evidence_ids, "evidence_ids", true); for (const id of evidenceIds) if (!new Set(["confirmed", "bounded"]).has(String(this.store.get("evidence", id).confidence))) throw new Error("Sub-agent Evidence must be confirmed or bounded");
    const confidence = text(args.confidence, "confidence"); if (!CONFIDENCE.has(confidence)) throw new Error("Sub-agent result confidence is unsupported");
    const result = { hypotheses: strings(args.hypotheses, "hypotheses", true), counterexamples: strings(args.counterexamples, "counterexamples", true), evidence_ids: evidenceIds, confidence, next_action: text(args.next_action, "next_action"), output_refs: strings(args.output_refs, "output_refs") };
    const receipt = this.store.create("subagent_function_receipt", `subagent_function_receipt_${call.id}`, { call_id: call.id, parent_session_id: call.parent_session_id, result_digest: digest(result), ...result, status: "completed" });
    const saved = this.store.save("subagent_function_call", String(call.id), { ...payload(call), status: "completed", receipt_id: receipt.id }); return { call: saved, receipt };
  }

  sessionGet(args: JsonObject): JsonObject { return { session: this.store.get("stateful_compute_session", text(args.session_id, "session_id")) }; }

  cancel(args: JsonObject): JsonObject {
    const session = this.store.get("stateful_compute_session", text(args.session_id, "session_id")); if (new Set(["completed", "failed", "cancelled"]).has(String(session.status))) throw new Error("Stateful compute Session is already terminal");
    const calls = this.store.list("subagent_function_call", 1000, (item) => item.parent_session_id === session.id && item.status === "issued").map((item) => this.store.save("subagent_function_call", String(item.id), { ...payload(item), status: "cancelled", cancellation_reason: text(args.reason, "reason") }));
    const saved = this.store.save("stateful_compute_session", String(session.id), { ...payload(session), status: "cancelled", cancellation_reason: text(args.reason, "reason"), active_dispatch_id: null }); return { session: saved, cancelled_calls: calls.map((item) => ({ id: item.id, version: item.version })) };
  }
}
