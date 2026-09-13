import { createHash, randomUUID } from "node:crypto";
import type { JsonObject } from "./store.ts";
import { CraftStore } from "./store.ts";

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}

function list(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const items = value.map((item) => text(item, name));
  if (new Set(items).size !== items.length) throw new Error(`${name} must contain unique values`);
  return items;
}

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function payload(record: JsonObject): JsonObject {
  const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record;
  return rest;
}

function positive(value: unknown, name: string, fallback: number, max: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 1 || result > max) throw new Error(`${name} must be an integer between 1 and ${max}`);
  return result;
}

const MANIFEST_FIELDS = ["knowledge_refs", "capability_refs", "workflow_refs", "excluded_refs"] as const;

/** Unified, digest-pinned context plane for one Work Session. */
export class ContextPlaneKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  save(args: JsonObject): JsonObject {
    const projectId = text(args.project_id, "project_id");
    const taskId = text(args.task_id, "task_id");
    const manifestId = String(args.manifest_id ?? `context_manifest_${randomUUID().replaceAll("-", "")}`);
    const refs = Object.fromEntries(MANIFEST_FIELDS.map((field) => [field, list(args[field], field)]));
    const identity = { project_id: projectId, task_id: taskId, knowledge_refs: refs.knowledge_refs, capability_refs: refs.capability_refs,
      workflow_refs: refs.workflow_refs, excluded_refs: refs.excluded_refs, model: args.model === undefined ? null : text(args.model, "model"),
      host: args.host === undefined ? null : text(args.host, "host"), acceptance_ref: args.acceptance_ref === undefined ? null : text(args.acceptance_ref, "acceptance_ref"),
      selection_rationale: args.selection_rationale === undefined ? null : text(args.selection_rationale, "selection_rationale") };
    const identityDigest = digest(identity);
    const existing = this.store.find("context_manifest", manifestId);
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Context Manifest idempotency conflict");
      return { manifest: existing, idempotent: true };
    }
    return { manifest: this.store.create("context_manifest", manifestId, { ...identity, identity_digest: identityDigest, status: "pinned" }), idempotent: false };
  }

  get(args: JsonObject): JsonObject { return { manifest: this.store.get("context_manifest", text(args.manifest_id, "manifest_id")) }; }

  audit(args: JsonObject): JsonObject {
    const manifest = this.store.get("context_manifest", text(args.manifest_id, "manifest_id"));
    const expected = args.expected_digest === undefined ? String(manifest.identity_digest) : text(args.expected_digest, "expected_digest");
    const drifted = expected !== String(manifest.identity_digest);
    const status = drifted ? "needs_replan" : "ready";
    const saved = drifted && manifest.status !== status
      ? this.store.save("context_manifest", String(manifest.id), { ...payload(manifest), status }) : manifest;
    return { manifest: saved, status, drifted, revalidation_digest: manifest.identity_digest };
  }
}

export type ReplayExecutor = (action: string, contract: JsonObject, sequence: number) => Promise<JsonObject>;

/** Revalidation-gated replay runner. It never runs a stale trace. */
export class ReplayRunnerKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  prepare(args: JsonObject): JsonObject {
    const traceId = text(args.trace_id, "trace_id");
    const trace = this.store.get("trace", traceId);
    if (!["completed", "failed", "cancelled", "blocked"].includes(String(trace.status))) throw new Error("Replay requires a terminal Trace");
    const events = this.store.list("trace_event", 10_000, (item) => item.trace_id === traceId && item.action_contract !== null)
      .sort((left, right) => Number(left.sequence) - Number(right.sequence));
    if (!events.length) throw new Error("Trace has no replayable action contracts");
    const replayId = String(args.replay_id ?? `replay_${randomUUID().replaceAll("-", "")}`);
    const identity = { trace_id: traceId, trace_version: trace.version, event_ids: events.map((event) => event.id), approval_ref: text(args.approval_ref, "approval_ref"), workspace_digest: text(args.workspace_digest, "workspace_digest") };
    const replayDigest = digest(identity);
    const existing = this.store.find("replay_run", replayId);
    if (existing) {
      if (existing.replay_digest !== replayDigest) throw new Error("Replay idempotency conflict");
      return { replay: existing, idempotent: true };
    }
    return { replay: this.store.create("replay_run", replayId, { ...identity, replay_digest: replayDigest, status: "prepared", completed_steps: 0, results: [] }), idempotent: false };
  }

  async execute(args: JsonObject, executor?: ReplayExecutor): Promise<JsonObject> {
    const replay = this.store.get("replay_run", text(args.replay_id, "replay_id"));
    if (replay.status === "completed") return { replay, idempotent: true };
    if (replay.status !== "prepared") throw new Error("Replay is not prepared");
    if (args.approval_ref !== undefined && text(args.approval_ref, "approval_ref") !== replay.approval_ref) throw new Error("Replay approval does not match");
    const trace = this.store.get("trace", String(replay.trace_id));
    if (Number(trace.version) !== Number(replay.trace_version)) throw new Error("Replay source Trace changed; revalidate first");
    const events = (replay.event_ids as string[]).map((id) => this.store.get("trace_event", id));
    const results: JsonObject[] = [];
    for (const event of events) {
      const result = executor ? await executor(String(event.event_kind), event.action_contract as JsonObject, Number(event.sequence)) : { mode: "dry_run", action: event.event_kind, sequence: event.sequence };
      results.push({ sequence: event.sequence, result_digest: digest(result) });
    }
    const saved = this.store.save("replay_run", String(replay.id), { ...payload(replay), status: "completed", completed_steps: results.length, results, finished_at: new Date().toISOString() });
    return { replay: saved, results, idempotent: false };
  }

  get(args: JsonObject): JsonObject { return { replay: this.store.get("replay_run", text(args.replay_id, "replay_id")) }; }
}

/** Persistent local service lifecycle. A host may call tick from a tray, cron, or OS scheduler. */
export class LocalRuntimeServiceKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  configure(args: JsonObject): JsonObject {
    const serviceId = String(args.service_id ?? "craft-local");
    const existing = this.store.find("local_runtime_service", serviceId);
    const record = { service_id: serviceId, schedule: String(args.schedule ?? "on_demand"), startup: String(args.startup ?? "manual"), notification: String(args.notification ?? "disabled"), crash_recovery: args.crash_recovery !== false };
    if (existing) return { service: this.store.save("local_runtime_service", serviceId, { ...payload(existing), ...record }), idempotent: false };
    return { service: this.store.create("local_runtime_service", serviceId, { ...record, status: "stopped", last_tick_at: null }), idempotent: false };
  }

  start(args: JsonObject = {}): JsonObject {
    const serviceId = String(args.service_id ?? "craft-local"); const service = this.store.find("local_runtime_service", serviceId) ?? (this.configure({ service_id: serviceId }).service as JsonObject);
    if (service.status === "running") return { service, idempotent: true };
    return { service: this.store.save("local_runtime_service", serviceId, { ...payload(service), status: "running", started_at: new Date().toISOString() }), idempotent: false };
  }

  stop(args: JsonObject = {}): JsonObject {
    const serviceId = String(args.service_id ?? "craft-local"); const service = this.store.get("local_runtime_service", serviceId);
    if (service.status === "stopped") return { service, idempotent: true };
    return { service: this.store.save("local_runtime_service", serviceId, { ...payload(service), status: "stopped", stopped_at: new Date().toISOString() }), idempotent: false };
  }

  tick(args: JsonObject = {}): JsonObject {
    const serviceId = String(args.service_id ?? "craft-local"); const service = this.store.get("local_runtime_service", serviceId);
    if (service.status !== "running") return { service, processed: [], count: 0, skipped: true };
    const now = args.now === undefined ? new Date().toISOString() : text(args.now, "now");
    const jobs = this.store.list("runtime_wakeup", 500, (item) => item.service_id === serviceId && item.status === "pending");
    const processed = jobs.map((job) => this.store.save("runtime_wakeup", String(job.id), { ...payload(job), status: "dispatched", dispatched_at: now }));
    const saved = this.store.save("local_runtime_service", serviceId, { ...payload(service), last_tick_at: now, processed_count: Number(service.processed_count ?? 0) + processed.length });
    return { service: saved, processed, count: processed.length, skipped: false };
  }

  get(args: JsonObject = {}): JsonObject { return { service: this.store.get("local_runtime_service", String(args.service_id ?? "craft-local")) }; }
}

/** Portable, digest-verified Project Bundle for backup, migration and handoff. */
export class ProjectBundleKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  export(args: JsonObject): JsonObject {
    const projectId = text(args.project_id, "project_id"); const max = positive(args.limit, "limit", 5000, 20_000);
    const kinds = ["project_brain", "project_goal", "project_decision", "project_material", "project_outcome", "project_experience", "task", "work_session", "context_manifest", "trace", "artifact", "evidence"];
    const records = kinds.flatMap((kind) => this.store.list(kind, max, (item) => item.project_id === projectId || item.task_id === projectId || item.workspace_id === projectId));
    const identity = { format: "craft.project-bundle", schema: 1, project_id: projectId, records: records.map((record) => ({ kind: "project_record", ref: `${record.id}@${record.version}`, digest: digest(record) })) };
    const bundle = { ...identity, exported_at: args.exported_at === undefined ? new Date().toISOString() : text(args.exported_at, "exported_at") };
    const id = String(args.bundle_id ?? `project_bundle_${randomUUID().replaceAll("-", "")}`);
    const existing = this.store.find("project_bundle", id);
    if (existing) { if (existing.bundle_digest !== digest(identity)) throw new Error("Project Bundle idempotency conflict"); return { bundle: existing, idempotent: true }; }
    return { bundle: this.store.create("project_bundle", id, { ...bundle, bundle_digest: digest(identity), portable: true }), idempotent: false };
  }

  verify(args: JsonObject): JsonObject {
    const bundle = this.store.get("project_bundle", text(args.bundle_id, "bundle_id"));
    const expected = digest({ format: bundle.format, schema: bundle.schema, project_id: bundle.project_id, records: bundle.records });
    return { bundle, valid: expected === bundle.bundle_digest, expected_digest: expected };
  }
}

/** Records user corrections as bounded learning signals with project scope. */
export class FeedbackLearningKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  record(args: JsonObject): JsonObject {
    const signalId = String(args.signal_id ?? `feedback_signal_${randomUUID().replaceAll("-", "")}`); const scope = String(args.scope ?? "project");
    if (!["task", "project", "global"].includes(scope)) throw new Error("Unsupported feedback scope");
    const identity = { scope, project_id: args.project_id === undefined ? null : text(args.project_id, "project_id"), task_id: args.task_id === undefined ? null : text(args.task_id, "task_id"), outcome_id: args.outcome_id === undefined ? null : text(args.outcome_id, "outcome_id"), action: text(args.action, "action"), diff_digest: text(args.diff_digest, "diff_digest"), reason_digest: digest(text(args.reason, "reason")), accepted: args.accepted === true };
    const existing = this.store.find("feedback_signal", signalId);
    if (existing) { if (existing.identity_digest !== digest(identity)) throw new Error("Feedback signal idempotency conflict"); return { signal: existing, idempotent: true }; }
    return { signal: this.store.create("feedback_signal", signalId, { ...identity, identity_digest: digest(identity), status: "active" }), idempotent: false };
  }

  resolve(args: JsonObject): JsonObject {
    const signal = this.store.get("feedback_signal", text(args.signal_id, "signal_id")); const reusable = signal.scope === "global" || signal.scope === "project" && args.project_id !== undefined && signal.project_id === args.project_id;
    const status = args.stale === true ? "stale" : reusable ? "reusable" : "project_only";
    const saved = status === "stale" && signal.status !== "stale" ? this.store.save("feedback_signal", String(signal.id), { ...payload(signal), status }) : signal;
    return { signal: saved, status, reusable };
  }
}

/** Small domain evaluator registry; actual domain scoring remains user-owned. */
export class DomainEvaluatorKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  save(args: JsonObject): JsonObject {
    const evaluatorId = String(args.evaluator_id ?? `domain_evaluator_${randomUUID().replaceAll("-", "")}`); const domain = text(args.domain, "domain"); const name = text(args.name, "name");
    const criteria = object(args.rules ?? args.criteria, "rules"); const record = { domain, name, criteria, description_digest: digest(args.description ?? ""), status: "active" };
    const existing = this.store.find("domain_evaluator", evaluatorId); if (existing) return { evaluator: this.store.save("domain_evaluator", evaluatorId, { ...payload(existing), ...record }), idempotent: false };
    return { evaluator: this.store.create("domain_evaluator", evaluatorId, record), idempotent: false };
  }

  evaluate(args: JsonObject): JsonObject {
    const evaluator = this.store.get("domain_evaluator", text(args.evaluator_id, "evaluator_id")); const metrics = object(args.metrics, "metrics"); const criteria = evaluator.criteria as JsonObject;
    const checks = Object.entries(criteria).map(([key, rule]) => { const value = Number(metrics[key]); const expected = Number(rule); return { key, value, expected, passed: Number.isFinite(value) && Number.isFinite(expected) && value >= expected }; });
    const passed = checks.length > 0 && checks.every((check) => check.passed);
    return { evaluator, checks, verdict: passed ? "passed" : "failed", evidence_digest: digest({ evaluator_id: evaluator.id, metrics, checks }) };
  }
}

/** Host-neutral handoff manifests preserve context, permissions and outcome references. */
export class HandoffManifestKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  create(args: JsonObject): JsonObject {
    const handoffId = String(args.handoff_id ?? `handoff_manifest_${randomUUID().replaceAll("-", "")}`); const identity = { task_id: text(args.task_id, "task_id"), session_id: args.session_id === undefined ? null : text(args.session_id, "session_id"), context_manifest_id: text(args.context_manifest_id, "context_manifest_id"), host: text(args.host, "host"), model: args.model === undefined ? null : text(args.model, "model"), allowed_effects: list(args.allowed_effects, "allowed_effects"), artifact_ids: list(args.artifact_ids, "artifact_ids"), evidence_ids: list(args.evidence_ids, "evidence_ids"), outcome_id: args.outcome_id === undefined ? null : text(args.outcome_id, "outcome_id") };
    const handoffDigest = digest(identity); const existing = this.store.find("handoff_manifest", handoffId); if (existing) { if (existing.handoff_digest !== handoffDigest) throw new Error("Handoff Manifest idempotency conflict"); return { handoff: existing, idempotent: true }; }
    return { handoff: this.store.create("handoff_manifest", handoffId, { ...identity, handoff_digest: handoffDigest, status: "ready" }), idempotent: false };
  }

  get(args: JsonObject): JsonObject { return { handoff: this.store.get("handoff_manifest", text(args.handoff_id, "handoff_id")) }; }
}

/** Provider price snapshots and actual usage attribution. */
export class CostLedgerKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  priceSave(args: JsonObject): JsonObject {
    const provider = text(args.provider, "provider"); const model = text(args.model, "model"); const input = Number(args.input_per_million); const output = Number(args.output_per_million);
    if (![input, output].every((value) => Number.isFinite(value) && value >= 0)) throw new Error("prices must be non-negative finite numbers");
    const id = String(args.price_id ?? `price_${provider}_${model}`); const record = { provider, model, input_per_million: input, output_per_million: output, effective_at: args.effective_at === undefined ? new Date().toISOString() : text(args.effective_at, "effective_at") };
    const existing = this.store.find("provider_price", id); return { price: existing ? this.store.save("provider_price", id, { ...payload(existing), ...record }) : this.store.create("provider_price", id, record), idempotent: false };
  }

  usageRecord(args: JsonObject): JsonObject {
    const provider = text(args.provider, "provider"); const model = text(args.model, "model"); const input = Number(args.input_tokens ?? 0); const output = Number(args.output_tokens ?? 0);
    if (![input, output].every((value) => Number.isInteger(value) && value >= 0)) throw new Error("token counts must be non-negative integers");
    const price = this.store.list("provider_price", 1000, (item) => item.provider === provider && item.model === model)[0]; if (!price) throw new Error("No provider price snapshot");
    const costUsd = input * Number(price.input_per_million) / 1_000_000 + output * Number(price.output_per_million) / 1_000_000;
    const id = String(args.usage_id ?? `usage_${randomUUID().replaceAll("-", "")}`); return { usage: this.store.create("usage_ledger", id, { provider, model, project_id: args.project_id ?? null, task_id: args.task_id ?? null, input_tokens: input, output_tokens: output, cost_usd: costUsd, price_id: price.id }), idempotent: false };
  }

  report(args: JsonObject = {}): JsonObject { const projectId = args.project_id === undefined ? null : text(args.project_id, "project_id"); const entries = this.store.list("usage_ledger", 10_000, (item) => projectId === null || item.project_id === projectId); return { entries, total_cost_usd: entries.reduce((sum, item) => sum + Number(item.cost_usd ?? 0), 0), total_input_tokens: entries.reduce((sum, item) => sum + Number(item.input_tokens ?? 0), 0), total_output_tokens: entries.reduce((sum, item) => sum + Number(item.output_tokens ?? 0), 0) }; }
}
