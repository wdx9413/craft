import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function limit(value: unknown): number { const n = value === undefined ? 100 : Number(value); if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error("limit must be an integer between 1 and 1000"); return n; }

/** Read-only Workbench projection: timeline, outcome, evidence, versions and the next safe action. */
export class WorkbenchExperienceKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  query(args: JsonObject = {}): JsonObject {
    const n = limit(args.limit); const projectId = args.project_id === undefined ? null : text(args.project_id, "project_id"); const taskId = args.task_id === undefined ? null : text(args.task_id, "task_id"); const sessionId = args.session_id === undefined ? null : text(args.session_id, "session_id");
    const sessions = this.store.list("work_session", 10_000, (item) => (projectId === null || item.project_id === projectId) && (taskId === null || item.task_id === taskId) && (sessionId === null || item.id === sessionId)).slice(0, n);
    const taskIds = new Set(sessions.map((item) => String(item.task_id))); if (taskId) taskIds.add(taskId);
    const launches = this.store.list("work_launch", 10_000, (item) => taskIds.has(String(item.task_id))).slice(0, n); const traces = this.store.list("trace", 10_000, (item) => taskIds.has(String(item.task_id))).slice(0, n);
    const outcomes = this.store.list("outcome", 10_000, (item) => { const trial = this.store.find("trial", String(item.trial_id)); return Boolean(trial && taskIds.has(String(trial.task_id))); }).slice(0, n);
    const artifacts = this.store.list("artifact", n, (item) => taskIds.has(String(item.task_id)));
    const timeline = traces.flatMap((trace) => this.store.list("trace_event", 10_000, (event) => event.trace_id === trace.id).map((event) => ({ trace_id: trace.id, sequence: event.sequence, event_kind: event.event_kind, status: event.status, created_at: event.created_at, output_refs: event.output_refs }))).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).slice(0, n);
    const nextAction = sessions.some((item) => item.status === "needs_replan") ? "review_context_drift" : sessions.some((item) => item.status === "running") ? "observe_execution" : launches.some((item) => item.status === "awaiting_approval") ? "approve_or_deny" : "start_or_prepare_work";
    const projection = { filters: { project_id: projectId, task_id: taskId, session_id: sessionId }, sessions: sessions.map(this.ref), launches: launches.map(this.ref), traces: traces.map(this.ref), outcomes: outcomes.map(this.ref), artifacts: artifacts.map(this.ref), timeline, next_action: nextAction };
    return { ...projection, projection_digest: digest(projection), content_free: true };
  }

  get(args: JsonObject): JsonObject { return this.query({ ...args, session_id: text(args.session_id, "session_id") }); }

  replayPlan(args: JsonObject): JsonObject {
    const traceId = text(args.trace_id, "trace_id"); const trace = this.store.get("trace", traceId); const events = this.store.list("trace_event", 10_000, (item) => item.trace_id === traceId).sort((a, b) => Number(a.sequence) - Number(b.sequence));
    const steps = events.filter((event) => event.action_contract !== null).map((event) => ({ sequence: event.sequence, event_kind: event.event_kind, action_digest: digest(event.action_contract), input_refs: event.input_refs, output_refs: event.output_refs }));
    return { trace_id: traceId, trace_version: trace.version, replayable: steps.length > 0 && Boolean(trace.model_fingerprint && trace.environment_fingerprint), steps, requires_revalidation: true, executes: false, raw_content: false };
  }

  review(args: JsonObject): JsonObject { const result = this.query(args); return { ...result, review_digest: digest(result), recommendations: [result.next_action], evidence_required: true }; }

  private ref(item: JsonObject): JsonObject { return { id: item.id, version: item.version, status: item.status ?? null, digest: item.content_digest ?? item.identity_digest ?? item.summary_digest ?? null }; }
}
