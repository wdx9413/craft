import { createHash, randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";
import { ProjectBrainKernel } from "./project-brain.ts";

function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function strings(value: unknown, name: string): string[] { if (value === undefined) return []; if (!Array.isArray(value)) throw new Error(`${name} must be an array`); const result = value.map((item) => text(item, name)); if (new Set(result).size !== result.length) throw new Error(`${name} must contain unique values`); return result; }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function payload(record: JsonObject): JsonObject { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
function refs(value: unknown, name: string): JsonObject[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((raw) => { if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${name} items must be objects`); const item = raw as JsonObject; return { id: text(item.id, `${name}.id`), version: item.version === undefined ? null : Number(item.version), digest: item.digest === undefined ? null : text(item.digest, `${name}.digest`) }; });
}

/** Binds Project Brain, knowledge, capability, workflow, model, Host and acceptance into one resumable session. */
export class WorkSessionKernel {
  readonly store: CraftStore; readonly brain: ProjectBrainKernel;
  constructor(store: CraftStore, brain = new ProjectBrainKernel(store)) { this.store = store; this.brain = brain; }

  prepare(args: JsonObject): JsonObject {
    const projectId = text(args.project_id, "project_id"); this.brain.get({ project_id: projectId }); const task = this.store.get("task", text(args.task_id, "task_id"));
    if (task.project_id !== null && task.project_id !== projectId) throw new Error("Task does not belong to the Project Brain");
    const sessionId = String(args.session_id ?? `work_session_${randomUUID().replaceAll("-", "")}`); const knowledge = refs(args.knowledge_refs, "knowledge_refs"); const capabilities = refs(args.capability_refs, "capability_refs"); const workflows = refs(args.workflow_refs, "workflow_refs"); const excluded = strings(args.excluded_refs, "excluded_refs");
    const selection = { knowledge, capabilities, workflows, excluded, rationale: args.selection_rationale === undefined ? [] : strings(args.selection_rationale, "selection_rationale") };
    const identity = { project_id: projectId, task_id: task.id, goal_digest: digest(text(args.goal ?? task.goal, "goal")), selection_digest: digest(selection), model: args.model === undefined ? null : text(args.model, "model"), host: args.host === undefined ? null : text(args.host, "host"), acceptance_ref: args.acceptance_ref === undefined ? null : text(args.acceptance_ref, "acceptance_ref") };
    const existing = this.store.find("work_session", sessionId); if (existing) { if (existing.identity_digest !== digest(identity)) throw new Error("Work Session idempotency conflict"); return { session: existing, idempotent: true }; }
    const brain = this.store.list("project_brain", 10_000, (item) => item.project_id === projectId)[0]!;
    const session = this.store.create("work_session", sessionId, { ...identity, brain_id: brain.id, brain_version: brain.version, task_version: task.version, status: "prepared", selection, context_digest: digest({ ...identity, selection }), launch_id: null, outcome_id: null, next_action: "bind_work_launch", identity_digest: digest(identity) });
    return { session, idempotent: false };
  }

  get(args: JsonObject): JsonObject { const session = this.store.get("work_session", text(args.session_id, "session_id")); return { session, context: { project_id: session.project_id, task_id: session.task_id, knowledge_refs: (session.selection as JsonObject).knowledge, capability_refs: (session.selection as JsonObject).capabilities, workflow_refs: (session.selection as JsonObject).workflows, excluded_refs: (session.selection as JsonObject).excluded, read_only: true, content_free: true } }; }

  refresh(args: JsonObject): JsonObject {
    const session = this.store.get("work_session", text(args.session_id, "session_id")); const task = this.store.find("task", String(session.task_id)); const brain = this.store.find("project_brain", String(session.brain_id)); const issues: JsonObject[] = [];
    if (!task) issues.push({ component: "task", issue: "missing" }); else if (Number(task.version) !== Number(session.task_version)) issues.push({ component: "task", issue: "version_changed", current_version: task.version });
    if (!brain) issues.push({ component: "project_brain", issue: "missing" }); else if (Number(brain.version) !== Number(session.brain_version ?? 1) && session.status !== "prepared") issues.push({ component: "project_brain", issue: "changed", current_version: brain.version });
    const status = issues.length ? "needs_replan" : session.status; const next = issues.length ? "review_context_drift" : session.launch_id ? "observe_execution" : "bind_work_launch";
    const saved = status === session.status && next === session.next_action ? session : this.store.save("work_session", String(session.id), { ...payload(session), status, next_action: next, last_refresh_issues: issues });
    return { session: saved, issues, next_action: next, ready: issues.length === 0 };
  }

  bindLaunch(args: JsonObject): JsonObject { const session = this.store.get("work_session", text(args.session_id, "session_id")); const launch = this.store.get("work_launch", text(args.launch_id, "launch_id")); if (launch.task_id !== session.task_id) throw new Error("Work Launch does not belong to the session task"); const saved = this.store.save("work_session", String(session.id), { ...payload(session), launch_id: launch.id, status: "running", next_action: "observe_execution" }); return { session: saved, launch }; }

  /** Bind the standalone internal Host dispatch to the same session lineage. */
  bindDispatch(args: JsonObject): JsonObject {
    const session = this.store.get("work_session", text(args.session_id, "session_id"));
    const dispatch = this.store.get("internal_dispatch", text(args.dispatch_id, "dispatch_id"));
    if (dispatch.task_id !== session.task_id) throw new Error("Internal dispatch does not belong to the session task");
    if (dispatch.session_id !== undefined && dispatch.session_id !== session.id) throw new Error("Internal dispatch is bound to another session");
    const savedDispatch = this.store.save("internal_dispatch", String(dispatch.id), { ...payload(dispatch), session_id: session.id, session_version: session.version, context_digest: session.context_digest });
    const saved = this.store.save("work_session", String(session.id), { ...payload(session), dispatch_id: savedDispatch.id, status: "running", next_action: "observe_execution" });
    return { session: saved, dispatch: savedDispatch };
  }

  complete(args: JsonObject): JsonObject { const session = this.store.get("work_session", text(args.session_id, "session_id")); const status = String(args.status ?? "completed"); if (!["completed", "needs_review", "failed"].includes(status)) throw new Error("Work Session status is unsupported"); const saved = this.store.save("work_session", String(session.id), { ...payload(session), status, outcome_id: args.outcome_id === undefined ? session.outcome_id : text(args.outcome_id, "outcome_id"), completion_digest: digest(text(args.summary, "summary")), next_action: status === "completed" ? "record_experience" : "review_result" }); return { session: saved }; }

}
