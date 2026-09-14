import { createHash, randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

const BINDING_KINDS = new Set(["prompt_note", "memory_ledger", "capability", "workflow", "expert_profile", "harness_topology", "work_runtime_plan", "context_resolution_receipt", "activation_profile"]);
const SOURCE_KINDS = new Set(["trial", "outcome", "acceptance_gate", "verified_work_loop", "trace", "work_session"]);
const CHANGE_KINDS = new Set(["prompt_note", "memory", "skill", "workflow", "subagent_spec"]);
const CHANGE_ACTIONS = new Set(["create", "update", "delete"]);
const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{8,}/iu;

function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); const result = value.trim(); if (SECRET.test(result)) throw new Error(`${name} must not contain credentials or secrets`); return result; }
function strings(value: unknown, name: string): string[] { if (!Array.isArray(value)) throw new Error(`${name} must be an array`); const result = value.map((item) => text(item, name)); if (!result.length) throw new Error(`${name} must contain at least one value`); if (new Set(result).size !== result.length) throw new Error(`${name} must contain unique values`); return result.sort(); }
function object(value: unknown, name: string): JsonObject { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`); return value as JsonObject; }
function payload(record: JsonObject): JsonObject { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as JsonObject).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`; return JSON.stringify(value); }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`; }
function reference(store: CraftStore, raw: unknown, name: string, allowed: Set<string>): JsonObject {
  const input = object(raw, name); const kind = text(input.kind, `${name}.kind`); if (!allowed.has(kind)) throw new Error(`${name}.kind is unsupported`);
  const id = text(input.id, `${name}.id`); const version = input.version === undefined ? undefined : Number(input.version);
  if (version !== undefined && (!Number.isInteger(version) || version < 1)) throw new Error(`${name}.version must be a positive integer`);
  const record = store.get(kind, id, version); return { kind, id: record.id, version: record.version };
}
function evidence(store: CraftStore, value: unknown): string[] { const ids = strings(value, "evidence_ids"); for (const id of ids) if (!new Set(["confirmed", "bounded"]).has(String(store.get("evidence", id).confidence))) throw new Error("Refinement Evidence must be confirmed or bounded"); return ids; }

/** A content-free, version-pinned projection over the Harness actually used by one task. */
export class ContinualHarnessKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  viewCreate(args: JsonObject): JsonObject {
    const task = this.store.get("task", text(args.task_id, "task_id")); const inputs = Array.isArray(args.bindings) ? args.bindings : [];
    const bindings = inputs.map((item, index) => reference(this.store, item, `bindings[${index}]`, BINDING_KINDS)).sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
    if (new Set(bindings.map((item) => `${item.kind}:${item.id}`)).size !== bindings.length) throw new Error("Harness bindings must be unique");
    const identity = { task_id: task.id, task_version: task.version, bindings, content_free: true, execution_authority: false };
    const viewId = String(args.view_id ?? `continual_harness_view_${digest(identity).slice(-16)}`); const identityDigest = digest(identity); const existing = this.store.find("continual_harness_view", viewId);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Continual Harness view idempotency conflict"); return { view: existing, idempotent: true }; }
    return { view: this.store.create("continual_harness_view", viewId, { ...identity, identity_digest: identityDigest }), idempotent: false };
  }

  refine(args: JsonObject): JsonObject {
    const task = this.store.get("task", text(args.task_id, "task_id")); const view = this.store.get("continual_harness_view", text(args.view_id, "view_id"));
    if (view.task_id !== task.id) throw new Error("Harness view does not belong to the task");
    const sourceInputs = Array.isArray(args.source_refs) ? args.source_refs : []; if (!sourceInputs.length) throw new Error("source_refs must contain at least one source");
    const sourceRefs = sourceInputs.map((item, index) => reference(this.store, item, `source_refs[${index}]`, SOURCE_KINDS));
    const evidenceIds = evidence(this.store, args.evidence_ids); const rawChanges = Array.isArray(args.changes) ? args.changes : [];
    if (!rawChanges.length || rawChanges.length > 4) throw new Error("changes must contain between one and four focused updates");
    const changes = rawChanges.map((raw, index) => this.change(raw, index)); const axes = [...new Set(changes.map((change) => String(change.kind)))];
    if (axes.length > 2) throw new Error("A refinement may change at most two Harness design axes");
    const local = changes.every((change) => change.scope === "session" && new Set(["prompt_note", "memory"]).has(String(change.kind)) && change.action !== "delete");
    for (const source of sourceRefs) this.assertTaskSource(task.id as string, source);
    const sessionId = local ? text(args.session_id, "session_id") : null;
    const identity = { task_id: task.id, task_version: task.version, view_id: view.id, view_version: view.version, session_id: sessionId, source_refs: sourceRefs, evidence_ids: evidenceIds, hypothesis: text(args.hypothesis, "hypothesis"), changes, design_axes: axes.sort(), risk: local ? "low" : "governed" };
    const refinementId = String(args.refinement_id ?? `harness_refinement_${randomUUID().replaceAll("-", "")}`); const identityDigest = digest(identity); const existing = this.store.find("harness_refinement", refinementId);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Harness refinement idempotency conflict"); return { refinement: existing, idempotent: true }; }
    return { refinement: this.store.create("harness_refinement", refinementId, { ...identity, identity_digest: identityDigest, before_snapshot: digest(view.bindings), after_snapshot: digest({ bindings: view.bindings, changes }), lifecycle: "draft", publication_allowed: false }), idempotent: false };
  }

  submit(args: JsonObject): JsonObject {
    const refinement = this.store.get("harness_refinement", text(args.refinement_id, "refinement_id")); if (refinement.lifecycle !== "draft") throw new Error("Only a draft refinement can be submitted");
    const isLocal = refinement.risk === "low"; let expiresAt: string | null = null;
    if (isLocal) { if (args.privacy_reviewed !== true) throw new Error("Session refinement requires an explicit privacy review"); const ttl = Number(args.ttl_seconds ?? 3600); if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) throw new Error("ttl_seconds must be between 60 and 86400"); expiresAt = new Date(Date.now() + ttl * 1000).toISOString(); }
    const lifecycle = isLocal ? "bounded_active" : "evaluation_required"; const saved = this.store.save("harness_refinement", String(refinement.id), { ...payload(refinement), lifecycle, activated_scope: isLocal ? "session" : null, expires_at: expiresAt, publication_allowed: false });
    return { refinement: saved, lifecycle, next_action: isLocal ? "apply_to_next_session_turn" : "run_shadow_evaluation" };
  }

  shadow(args: JsonObject): JsonObject {
    const refinement = this.store.get("harness_refinement", text(args.refinement_id, "refinement_id")); if (refinement.lifecycle !== "evaluation_required") throw new Error("Refinement is not awaiting shadow evaluation");
    const assessment = this.store.get("evaluation_reliability", text(args.assessment_id, "assessment_id")); if (assessment.status !== "eligible") throw new Error("Refinement requires an eligible shadow reliability assessment");
    const saved = this.store.save("harness_refinement", String(refinement.id), { ...payload(refinement), lifecycle: "signoff_ready", assessment_id: assessment.id, assessment_version: assessment.version });
    return { refinement: saved };
  }

  authorizeCanary(args: JsonObject): JsonObject {
    const refinement = this.store.get("harness_refinement", text(args.refinement_id, "refinement_id")); if (refinement.lifecycle !== "signoff_ready") throw new Error("Refinement is not ready for Signoff");
    const signoff = this.store.get("signoff", text(args.signoff_id, "signoff_id")); if (signoff.decision !== "passed" || signoff.subject_type !== "harness_refinement" || signoff.subject_id !== refinement.id || Number(signoff.subject_version) !== Number(refinement.version)) throw new Error("Refinement requires Signoff for its exact version");
    const canaryId = String(args.canary_id ?? `harness_refinement_canary_${randomUUID().replaceAll("-", "")}`); const canary = this.store.create("harness_refinement_canary", canaryId, { refinement_id: refinement.id, refinement_version: refinement.version, baseline_snapshot: refinement.before_snapshot, candidate_snapshot: refinement.after_snapshot, status: "running" });
    const saved = this.store.save("harness_refinement", String(refinement.id), { ...payload(refinement), lifecycle: "canary_running", signoff_id: signoff.id, canary_id: canary.id });
    return { refinement: saved, canary };
  }

  observeCanary(args: JsonObject): JsonObject {
    const canary = this.store.get("harness_refinement_canary", text(args.canary_id, "canary_id")); if (canary.status !== "running") throw new Error("Canary is not running");
    const baseline = Number(args.baseline); const candidate = Number(args.candidate); const threshold = Number(args.threshold ?? 0); if (![baseline, candidate, threshold].every((item) => Number.isFinite(item) && item >= 0)) throw new Error("Canary metrics must be non-negative finite numbers");
    const direction = text(args.direction ?? "lower_is_better", "direction"); if (!new Set(["lower_is_better", "higher_is_better"]).has(direction)) throw new Error("Canary metric direction is unsupported");
    const regression = direction === "lower_is_better" ? candidate - baseline > threshold : baseline - candidate > threshold; const completed = args.complete === true; const status = regression ? "rolled_back" : completed ? "passed" : "running";
    const savedCanary = this.store.save("harness_refinement_canary", String(canary.id), { ...payload(canary), status, metric: text(args.metric, "metric"), direction, baseline, candidate, threshold });
    const refinement = this.store.get("harness_refinement", String(canary.refinement_id)); const lifecycle = regression ? "rolled_back" : completed ? "active" : "canary_running";
    const saved = lifecycle === refinement.lifecycle ? refinement : this.store.save("harness_refinement", String(refinement.id), { ...payload(refinement), lifecycle, publication_allowed: lifecycle === "active", rollback_snapshot: regression ? refinement.before_snapshot : null });
    return { refinement: saved, canary: savedCanary, lifecycle };
  }

  rollback(args: JsonObject): JsonObject {
    const refinement = this.store.get("harness_refinement", text(args.refinement_id, "refinement_id")); if (!new Set(["bounded_active", "active", "canary_running"]).has(String(refinement.lifecycle))) throw new Error("Refinement is not active or running");
    const evidenceIds = evidence(this.store, args.evidence_ids); const saved = this.store.save("harness_refinement", String(refinement.id), { ...payload(refinement), lifecycle: "rolled_back", publication_allowed: false, rollback_snapshot: refinement.before_snapshot, rollback_reason: text(args.reason, "reason"), rollback_evidence_ids: evidenceIds });
    return { refinement: saved, restored_snapshot: refinement.before_snapshot };
  }

  signals(args: JsonObject): JsonObject {
    const task = this.store.get("task", text(args.task_id, "task_id")); const sources: JsonObject[] = [];
    for (const gate of this.store.list("acceptance_gate", 10_000, (item) => item.task_id === task.id && item.verdict === "failed")) sources.push({ kind: "acceptance_gate", id: gate.id, version: gate.version, trigger: "acceptance_failed" });
    for (const trial of this.store.list("trial", 10_000, (item) => item.task_id === task.id)) { const outcome = this.store.find("outcome", `outcome_${trial.id}`); if (outcome?.verdict === "passed") sources.push({ kind: "outcome", id: outcome.id, version: outcome.version, trigger: "verified_success" }); }
    return { task_id: task.id, sources: sources.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)), refinement_automatic: false, next_action: sources.length ? "review_and_propose_small_diff" : "none" };
  }

  resolve(args: JsonObject): JsonObject {
    const view = this.store.get("continual_harness_view", text(args.view_id, "view_id")); const sessionId = text(args.session_id, "session_id"); const now = args.now === undefined ? new Date() : new Date(text(args.now, "now")); if (Number.isNaN(now.valueOf())) throw new Error("now must be an ISO timestamp");
    const all = this.store.list("harness_refinement", 10_000, (item) => item.view_id === view.id && new Set(["bounded_active", "active"]).has(String(item.lifecycle)));
    const selected = all.filter((item) => item.lifecycle === "active" || (item.session_id === sessionId && Date.parse(String(item.expires_at)) > now.valueOf())).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const expired = all.filter((item) => item.lifecycle === "bounded_active" && item.session_id === sessionId && Date.parse(String(item.expires_at)) <= now.valueOf()).map((item) => ({ id: item.id, version: item.version }));
    const refs = selected.map((item) => ({ id: item.id, version: item.version, after_snapshot: item.after_snapshot })); const identity = { view_id: view.id, view_version: view.version, session_id: sessionId, base_bindings: view.bindings, refinement_refs: refs, effective_snapshot: digest({ base: view.bindings, refinements: refs }), content_free: true, execution_authority: false };
    const receiptId = String(args.receipt_id ?? `harness_resolution_receipt_${digest(identity).slice(-16)}`); const identityDigest = digest(identity); const existing = this.store.find("harness_resolution_receipt", receiptId);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Harness resolution Receipt idempotency conflict"); return { receipt: existing, expired, idempotent: true }; }
    return { receipt: this.store.create("harness_resolution_receipt", receiptId, { ...identity, identity_digest: identityDigest }), expired, idempotent: false };
  }

  get(args: JsonObject): JsonObject { return { refinement: this.store.get("harness_refinement", text(args.refinement_id, "refinement_id")) }; }

  private assertTaskSource(taskId: string, source: JsonObject): void {
    const record = this.store.get(String(source.kind), String(source.id), Number(source.version)); let owner = record.task_id;
    if (source.kind === "outcome") owner = this.store.get("trial", String(record.trial_id)).task_id;
    if (owner !== taskId) throw new Error("Harness refinement source does not belong to the task");
  }

  private change(raw: unknown, index: number): JsonObject {
    const input = object(raw, `changes[${index}]`); const kind = text(input.kind, `changes[${index}].kind`); const action = text(input.action, `changes[${index}].action`); const scope = text(input.scope, `changes[${index}].scope`);
    if (!CHANGE_KINDS.has(kind) || !CHANGE_ACTIONS.has(action) || !new Set(["session", "project", "user"]).has(scope)) throw new Error("Harness refinement change is unsupported");
    return { kind, action, scope, target_id: input.target_id === undefined ? null : text(input.target_id, `changes[${index}].target_id`), summary: text(input.summary, `changes[${index}].summary`) };
  }
}
