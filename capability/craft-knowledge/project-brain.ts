import { createHash, randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "../../src/infrastructure/store.ts";
import { text } from "../../src/validation.ts";
import { digestJson, payload } from "../../src/digest.ts";

function list(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const result = value.map((item) => text(item, name));
  if (new Set(result).size !== result.length) throw new Error(`${name} must contain unique values`);
  return result;
}

function projectId(value: unknown): string { return text(value, "project_id"); }
function brainId(project: string): string { return `project_brain:${digestJson(project).slice(-24)}`; }

/** Durable, content-light projection of one user's continuous project. */
export class ProjectBrainKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  open(args: JsonObject): JsonObject {
    const project = projectId(args.project_id); const id = String(args.brain_id ?? brainId(project));
    const existing = this.store.find("project_brain", id);
    const identity = { project_id: project, name: text(args.name ?? project, "name"), description_digest: digestJson(args.description ?? "") };
    if (existing) {
      if (existing.project_id !== project || existing.description_digest !== identity.description_digest) throw new Error("Project Brain idempotency conflict");
      return { brain: existing, idempotent: true };
    }
    return { brain: this.store.create("project_brain", id, { project_id: project, name: identity.name,
      description_digest: identity.description_digest, status: "active", latest_session_id: null, latest_outcome_id: null }), idempotent: false };
  }

  get(args: JsonObject): JsonObject { const project = projectId(args.project_id); const found = this.store.list("project_brain", 10_000, (item) => item.project_id === project)[0]; if (!found) throw new Error(`Unknown Project Brain: ${project}`); return this.snapshot({ project_id: project, limit: args.limit }); }

  snapshot(args: JsonObject): JsonObject {
    const project = projectId(args.project_id); const brain = this.store.list("project_brain", 10_000, (item) => item.project_id === project)[0];
    if (!brain) throw new Error(`Unknown Project Brain: ${project}`);
    const limit = args.limit === undefined ? 50 : Number(args.limit); if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("limit must be an integer between 1 and 500");
    const tasks = this.store.list("task", 10_000, (item) => item.project_id === project).slice(0, limit);
    const sessions = this.store.list("work_session", 10_000, (item) => item.project_id === project).slice(0, limit);
    const goals = this.store.list("project_goal", 10_000, (item) => item.project_id === project).slice(0, limit);
    const decisions = this.store.list("project_decision", 10_000, (item) => item.project_id === project).slice(0, limit);
    const materials = this.store.list("project_material", 10_000, (item) => item.project_id === project).slice(0, limit);
    const outcomes = this.store.list("project_outcome", 10_000, (item) => item.project_id === project).slice(0, limit);
    const experiences = this.store.list("project_experience", 10_000, (item) => item.project_id === project).slice(0, limit);
    const refs = (items: JsonObject[]) => items.map((item) => ({ id: item.id, version: item.version, status: item.status ?? null, digest: item.content_digest ?? item.identity_digest ?? null }));
    const snapshot = { brain: { id: brain.id, version: brain.version, project_id: project, name: brain.name, status: brain.status },
      goals: refs(goals), decisions: refs(decisions), materials: refs(materials), tasks: refs(tasks), sessions: refs(sessions), outcomes: refs(outcomes), experiences: refs(experiences),
      next_action: sessions.some((item) => item.status === "needs_replan") ? "replan_session" : tasks.some((item) => item.status === "active") ? "continue_task" : "define_goal" };
    return { ...snapshot, snapshot_digest: digestJson(snapshot), content_free: true };
  }

  goalSave(args: JsonObject): JsonObject {
    const project = projectId(args.project_id); this.require(project); const id = String(args.goal_id ?? `goal_${randomUUID().replaceAll("-", "")}`); const previous = this.store.find("project_goal", id);
    const record = { project_id: project, title: text(args.title ?? previous?.title, "title"), status: String(args.status ?? previous?.status ?? "active"), constraint_digests: list(args.constraint_digests ?? previous?.constraint_digests, "constraint_digests"), metric: args.metric === undefined ? previous?.metric ?? null : text(args.metric, "metric"), content_digest: digestJson({ title: args.title ?? previous?.title, constraints: args.constraint_digests ?? previous?.constraint_digests ?? [], metric: args.metric ?? previous?.metric ?? null }) };
    if (previous) return { goal: this.store.save("project_goal", id, { ...payload(previous), ...record }), idempotent: false };
    return { goal: this.store.create("project_goal", id, record), idempotent: false };
  }

  decisionSave(args: JsonObject): JsonObject {
    const project = projectId(args.project_id); this.require(project); const id = String(args.decision_id ?? `decision_${randomUUID().replaceAll("-", "")}`); const previous = this.store.find("project_decision", id);
    const record = { project_id: project, title: text(args.title, "title"), rationale_digest: digestJson(text(args.rationale, "rationale")), chosen_ref: text(args.chosen_ref, "chosen_ref"), excluded_refs: list(args.excluded_refs, "excluded_refs"), status: String(args.status ?? "active") };
    return { decision: previous ? this.store.save("project_decision", id, { ...payload(previous), ...record }) : this.store.create("project_decision", id, record), idempotent: false };
  }

  materialBind(args: JsonObject): JsonObject {
    const project = projectId(args.project_id); this.require(project); const id = String(args.material_id ?? `material_${randomUUID().replaceAll("-", "")}`); const material = { project_id: project, name: text(args.name, "name"), uri: text(args.uri, "uri"), content_digest: text(args.content_digest, "content_digest"), source_type: String(args.source_type ?? "user"), scope: String(args.scope ?? "project"), status: "bound" };
    const previous = this.store.find("project_material", id); return { material: previous ? this.store.save("project_material", id, { ...payload(previous), ...material }) : this.store.create("project_material", id, material), idempotent: false };
  }

  outcomeRecord(args: JsonObject): JsonObject {
    const project = projectId(args.project_id); this.require(project); const id = String(args.outcome_id ?? `project_outcome_${randomUUID().replaceAll("-", "")}`); const outcome = { project_id: project, task_id: args.task_id === undefined ? null : text(args.task_id, "task_id"), session_id: args.session_id === undefined ? null : text(args.session_id, "session_id"), verdict: text(args.verdict, "verdict"), summary_digest: digestJson(text(args.summary, "summary")), evidence_ids: list(args.evidence_ids, "evidence_ids"), artifact_ids: list(args.artifact_ids, "artifact_ids"), status: "recorded" };
    const saved = this.store.create("project_outcome", id, outcome); const brain = this.store.list("project_brain", 10_000, (item) => item.project_id === project)[0]!; this.store.save("project_brain", String(brain.id), { ...payload(brain), latest_outcome_id: saved.id }); return { outcome: saved };
  }

  experienceRecord(args: JsonObject): JsonObject {
    const project = projectId(args.project_id); this.require(project); const id = String(args.experience_id ?? `experience_${randomUUID().replaceAll("-", "")}`); const experience = { project_id: project, name: text(args.name, "name"), pattern_digest: digestJson(text(args.pattern, "pattern")), source_outcome_id: args.source_outcome_id === undefined ? null : text(args.source_outcome_id, "source_outcome_id"), status: "candidate" };
    return { experience: this.store.create("project_experience", id, experience) };
  }

  refresh(args: JsonObject): JsonObject { return this.snapshot(args); }

  private require(project: string): JsonObject { const found = this.store.list("project_brain", 10_000, (item) => item.project_id === project)[0]; if (!found) throw new Error(`Unknown Project Brain: ${project}`); return found; }
}
