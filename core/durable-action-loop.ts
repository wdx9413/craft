import { randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { TraceKernel } from "./trace-kernel.ts";
import { object } from "./validation.ts";
import { canonicalJson, stableDigest, payload } from "./digest.ts";

const ACTION_KINDS = new Set(["observe", "execute", "verify", "wait", "clarify"]);
const EFFECTS = new Set(["read_only", "local_write"]);
const OUTCOMES = new Set(["succeeded", "failed", "waiting", "blocked"]);
const RECEIPT_KINDS = new Set(["verified_work_loop_receipt", "host_session_event", "action_gateway_receipt", "managed_write"]);
const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{8,}/iu;

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  const result = value.trim(); if (SECRET.test(result)) throw new Error(`${name} must not contain credentials or secrets`);
  return result;
}

type WorkItem = JsonObject & { id: string; depends_on: string[]; acceptance_digest: string };

/**
 * A small durable ledger below VerifiedWorkLoop.  It turns a long task into
 * explicit work items and receipts, but never executes a Host action itself.
 */
export class DurableActionLoopKernel {
  readonly store: CraftStore;
  readonly trace: TraceKernel | null;
  constructor(store: CraftStore, trace: TraceKernel | null = null) { this.store = store; this.trace = trace; }

  create(args: JsonObject): JsonObject {
    const workLoop = this.store.get("verified_work_loop", text(args.work_loop_id, "work_loop_id"));
    const snapshot = this.store.get("state_snapshot", String(workLoop.latest_snapshot_id));
    const supplied = Array.isArray(args.work_items) ? args.work_items : [];
    if (!supplied.length) throw new Error("work_items must contain at least one item");
    const items = supplied.map((item, index) => this.item(item, index));
    const ids = new Set(items.map((item) => item.id));
    if (ids.size !== items.length || items.some((item) => item.depends_on.some((dependency) => !ids.has(dependency)))) throw new Error("Work item dependencies must reference unique declared items");
    if (this.hasCycle(items)) throw new Error("Work item dependencies must not contain a cycle");
    const identity = { work_loop_id: workLoop.id, work_loop_version: workLoop.version, task_id: workLoop.task_id, task_run_id: workLoop.task_run_id,
      workspace_id: workLoop.workspace_id, initial_snapshot_id: snapshot.id, initial_snapshot_version: snapshot.version, initial_snapshot_digest: snapshot.snapshot_digest,
      items: items.map((item) => ({ id: item.id, depends_on: item.depends_on, acceptance_digest: item.acceptance_digest })) };
    const loopId = String(args.action_loop_id ?? `durable_action_loop_${stableDigest(identity).slice(-20)}`); const existing = this.store.find("durable_action_loop", loopId); const identityDigest = stableDigest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Durable Action Loop idempotency conflict"); return { loop: existing, idempotent: true }; }
    const traceId = `durable_action_loop:${loopId}`;
    const loop = this.store.create("durable_action_loop", loopId, { ...identity, identity_digest: identityDigest, trace_id: traceId, lifecycle: "active", latest_snapshot_id: snapshot.id, latest_snapshot_version: snapshot.version, latest_snapshot_digest: snapshot.snapshot_digest, needs_replan_reason: null });
    for (const item of items) this.store.create("durable_work_item", `${loop.id}:${item.id}`, { action_loop_id: loop.id, item_key: item.id, depends_on: item.depends_on, acceptance_digest: item.acceptance_digest, status: "pending" });
    this.trace?.start({ trace_id: traceId, task_id: String(loop.task_id), run_id: String(loop.task_run_id), environment_fingerprint: String(snapshot.snapshot_digest), metadata: { durable_action_loop_id: loop.id, verified_work_loop_id: loop.work_loop_id } });
    this.appendTrace(loop, `durable.loop.created`, { work_item_count: items.length, initial_snapshot_ref: snapshot.id }, `durable_action_loop:${loop.id}:created`, null, { ref: snapshot.id });
    return { loop, idempotent: false };
  }

  next(args: JsonObject): JsonObject {
    const loop = this.store.get("durable_action_loop", text(args.action_loop_id, "action_loop_id"));
    const items = this.items(loop.id as string); const pendingAction = this.store.list("durable_action", 10_000, (item) => item.action_loop_id === loop.id && new Set(["proposed", "dispatched"]).has(String(item.lifecycle)))[0];
    if (loop.lifecycle !== "active") return { loop, next_action: loop.lifecycle === "needs_replan" ? "replan" : "none", pending_action: pendingAction ?? null };
    if (pendingAction) return { loop, next_action: "await_receipt", pending_action: pendingAction };
    if (items.every((item) => item.status === "verified")) return { loop: this.complete(loop), next_action: "none", pending_action: null };
    const ready = items.filter((item) => item.status === "pending" && (item.depends_on as string[]).every((dependency) => items.some((candidate) => candidate.item_key === dependency && candidate.status === "verified")));
    return { loop, next_action: ready.length ? "propose_action" : "resolve_blocker", ready_items: ready.map((item) => ({ item_key: item.item_key, acceptance_digest: item.acceptance_digest })) };
  }

  propose(args: JsonObject): JsonObject {
    const loop = this.store.get("durable_action_loop", text(args.action_loop_id, "action_loop_id"));
    const itemKey = text(args.item_key, "item_key");
    const kind = text(args.kind, "kind"); if (!ACTION_KINDS.has(kind)) throw new Error("Durable action kind is unsupported");
    const effect = text(args.effect ?? "read_only", "effect"); if (!EFFECTS.has(effect) || kind !== "execute" && effect !== "read_only") throw new Error("Durable action effect is unsupported");
    const identity = { action_loop_id: loop.id, action_loop_version: loop.version, item_key: itemKey, kind, effect,
      action_digest: text(args.action_digest, "action_digest"), expected_snapshot_id: loop.latest_snapshot_id, expected_snapshot_version: loop.latest_snapshot_version, expected_snapshot_digest: loop.latest_snapshot_digest };
    const actionId = String(args.action_id ?? `durable_action_${randomUUID().replaceAll("-", "")}`); const existing = this.store.find("durable_action", actionId); const identityDigest = stableDigest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Durable action idempotency conflict"); return { action: existing, idempotent: true }; }
    const state = this.next({ action_loop_id: String(loop.id) });
    if (state.next_action !== "propose_action") throw new Error("Durable Action Loop is not ready for a new action");
    const ready = (state.ready_items as JsonObject[]).find((item) => item.item_key === itemKey);
    if (!ready) throw new Error("Work item is not ready");
    const action = this.store.create("durable_action", actionId, { ...identity, identity_digest: identityDigest, lifecycle: "proposed", progress_proved: false, receipt_ref: null, reobservation_snapshot_id: null });
    this.appendTrace(loop, "durable.action.proposed", { action_id: action.id, item_key: itemKey, kind, effect }, `durable_action:${action.id}:proposed`, { ref: action.expected_snapshot_id }, null, { kind, effect, action_digest: action.action_digest });
    return { action, idempotent: false, host_execution_authority: false };
  }

  dispatch(args: JsonObject): JsonObject {
    const action = this.store.get("durable_action", text(args.action_id, "action_id"));
    if (action.lifecycle !== "proposed") throw new Error("Only a proposed Durable action can be dispatched");
    const saved = this.store.save("durable_action", String(action.id), { ...payload(action), lifecycle: "dispatched", dispatch_digest: stableDigest(text(args.dispatch_ref, "dispatch_ref")) });
    const loop = this.store.get("durable_action_loop", String(action.action_loop_id)); this.appendTrace(loop, "durable.action.dispatched", { action_id: action.id, dispatch_digest: saved.dispatch_digest }, `durable_action:${action.id}:dispatched`, { ref: action.expected_snapshot_id });
    return { action: saved };
  }

  report(args: JsonObject): JsonObject {
    const action = this.store.get("durable_action", text(args.action_id, "action_id"));
    if (!new Set(["proposed", "dispatched"]).has(String(action.lifecycle))) throw new Error("Durable action is already terminal");
    const outcome = text(args.outcome, "outcome"); if (!OUTCOMES.has(outcome)) throw new Error("Durable action outcome is unsupported");
    const loop = this.store.get("durable_action_loop", String(action.action_loop_id)); const snapshot = this.store.get("state_snapshot", text(args.snapshot_id, "snapshot_id"));
    if (snapshot.workspace_id !== loop.workspace_id) throw new Error("Durable action reobservation belongs to another Workspace");
    const needsReceipt = action.kind === "execute" || action.kind === "verify";
    const receipt = args.receipt_ref === undefined ? null : this.reference(args.receipt_ref, "receipt_ref");
    if (needsReceipt && receipt === null) throw new Error("Execute and verify actions require a Receipt reference");
    let progressProved = false; let itemStatus: string | null = null;
    if (action.kind === "verify" && outcome === "succeeded") {
      const acceptance = this.reference(args.acceptance_ref, "acceptance_ref");
      if (acceptance.kind !== "acceptance_gate" || String(this.store.get(String(acceptance.kind), String(acceptance.id), Number(acceptance.version)).verdict) !== "passed") throw new Error("Verification requires a passed Acceptance Gate");
      progressProved = true; itemStatus = "verified";
    }
    if (outcome === "blocked") itemStatus = "blocked";
    const lifecycle = outcome === "failed" ? "failed" : outcome === "blocked" ? "blocked" : "observed";
    const savedAction = this.store.save("durable_action", String(action.id), { ...payload(action), lifecycle, outcome, receipt_ref: receipt, reobservation_snapshot_id: snapshot.id, reobservation_snapshot_version: snapshot.version, progress_proved: progressProved });
    if (itemStatus) {
      const item = this.store.get("durable_work_item", `${loop.id}:${action.item_key}`);
      this.store.save("durable_work_item", String(item.id), { ...payload(item), status: itemStatus, verified_by_action_id: progressProved ? savedAction.id : null });
    }
    const changedOutsideAction = args.input_drift === true; const savedLoop = changedOutsideAction ? this.store.save("durable_action_loop", String(loop.id), { ...payload(loop), lifecycle: "needs_replan", needs_replan_reason: text(args.replan_reason ?? "input_drift", "replan_reason"), latest_snapshot_id: snapshot.id, latest_snapshot_version: snapshot.version, latest_snapshot_digest: snapshot.snapshot_digest }) : this.store.save("durable_action_loop", String(loop.id), { ...payload(loop), latest_snapshot_id: snapshot.id, latest_snapshot_version: snapshot.version, latest_snapshot_digest: snapshot.snapshot_digest });
    this.appendTrace(savedLoop, "durable.action.observed", { action_id: savedAction.id, outcome, progress_proved: progressProved, receipt_ref: receipt }, `durable_action:${action.id}:observed`, { ref: action.expected_snapshot_id }, { ref: snapshot.id });
    if (savedLoop.lifecycle === "needs_replan") this.appendTrace(savedLoop, "durable.loop.needs_replan", { reason: savedLoop.needs_replan_reason }, `durable_action_loop:${savedLoop.id}:needs_replan:${savedLoop.version}`, { ref: action.expected_snapshot_id }, { ref: snapshot.id });
    if (outcome === "blocked") this.finalizeTrace(savedLoop, "blocked", "durable action blocked");
    return { action: savedAction, loop: savedLoop, progress_proved: progressProved, next_action: savedLoop.lifecycle === "needs_replan" ? "replan" : this.next({ action_loop_id: savedLoop.id }).next_action };
  }

  resume(args: JsonObject): JsonObject {
    const loop = this.store.get("durable_action_loop", text(args.action_loop_id, "action_loop_id"));
    if (loop.lifecycle !== "active") return { loop, resumed: false, next_action: loop.lifecycle === "needs_replan" ? "replan" : "none" };
    const snapshot = this.store.get("state_snapshot", text(args.snapshot_id, "snapshot_id"));
    if (snapshot.workspace_id !== loop.workspace_id) throw new Error("Resume snapshot belongs to another Workspace");
    if (snapshot.snapshot_digest !== loop.latest_snapshot_digest || snapshot.workspace_state_revision !== this.store.get("state_snapshot", String(loop.latest_snapshot_id), Number(loop.latest_snapshot_version)).workspace_state_revision) {
      const saved = this.store.save("durable_action_loop", String(loop.id), { ...payload(loop), lifecycle: "needs_replan", needs_replan_reason: "workspace_drift_on_resume", latest_snapshot_id: snapshot.id, latest_snapshot_version: snapshot.version, latest_snapshot_digest: snapshot.snapshot_digest });
      this.appendTrace(saved, "durable.loop.needs_replan", { reason: saved.needs_replan_reason }, `durable_action_loop:${saved.id}:needs_replan:${saved.version}`, { ref: loop.latest_snapshot_id }, { ref: snapshot.id });
      return { loop: saved, resumed: false, next_action: "replan" };
    }
    return { loop, resumed: true, ...this.next({ action_loop_id: loop.id }) };
  }

  get(args: JsonObject): JsonObject {
    const loop = this.store.get("durable_action_loop", text(args.action_loop_id, "action_loop_id"));
    return { loop, work_items: this.items(loop.id as string), actions: this.store.list("durable_action", 10_000, (item) => item.action_loop_id === loop.id) };
  }

  private item(value: unknown, index: number): WorkItem {
    const input = object(value, `work_items[${index}]`); const id = text(input.id, `work_items[${index}].id`);
    const depends = input.depends_on === undefined ? [] : input.depends_on;
    if (!Array.isArray(depends)) throw new Error(`work_items[${index}].depends_on must be an array`);
    const dependsOn = depends.map((item) => text(item, `work_items[${index}].depends_on`));
    if (new Set(dependsOn).size !== dependsOn.length || dependsOn.includes(id)) throw new Error("Work item dependencies must be unique and cannot reference itself");
    return { id, depends_on: dependsOn.sort(), acceptance_digest: text(input.acceptance_digest, `work_items[${index}].acceptance_digest`) };
  }
  private hasCycle(items: WorkItem[]): boolean {
    const graph = new Map(items.map((item) => [item.id, item.depends_on])); const visited = new Set<string>(); const stack = new Set<string>();
    const visit = (id: string): boolean => { if (stack.has(id)) return true; if (visited.has(id)) return false; visited.add(id); stack.add(id); const cyclic = graph.get(id)!.some(visit); stack.delete(id); return cyclic; };
    return [...graph.keys()].some(visit);
  }
  private items(loopId: string): JsonObject[] { return this.store.list("durable_work_item", 10_000, (item) => item.action_loop_id === loopId).sort((left, right) => String(left.item_key).localeCompare(String(right.item_key))); }
  private complete(loop: JsonObject): JsonObject {
    const saved = this.store.save("durable_action_loop", String(loop.id), { ...payload(loop), lifecycle: "completed", completed_at: new Date().toISOString() });
    this.appendTrace(saved, "durable.loop.completed", { work_items_verified: true }, `durable_action_loop:${saved.id}:completed`, { ref: saved.latest_snapshot_id }); this.finalizeTrace(saved, "completed", "all durable work items verified"); return saved;
  }
  private appendTrace(loop: JsonObject, eventKind: string, data: JsonObject, eventId: string, stateBefore: JsonObject | null = null, stateAfter: JsonObject | null = null, actionContract: JsonObject | null = null): void {
    if (this.trace === null) return;
    this.trace.append({ trace_id: loop.trace_id, event_id: eventId, event_kind: eventKind, actor: "durable_action_loop", source: "craft", trust: "observed", data, state_before: stateBefore ?? {}, state_after: stateAfter ?? {}, action_contract: actionContract ?? {}, workspace_before: stateBefore?.ref, workspace_after: stateAfter?.ref });
  }
  private finalizeTrace(loop: JsonObject, status: "completed" | "blocked", summary: string): void { if (this.trace !== null) this.trace.finalize({ trace_id: String(loop.trace_id), status, summary }); }
  private reference(value: unknown, name: string): JsonObject {
    const input = object(value, name); const kind = text(input.kind, `${name}.kind`); if (!RECEIPT_KINDS.has(kind) && kind !== "acceptance_gate") throw new Error(`${name}.kind is unsupported`);
    const id = text(input.id, `${name}.id`); const version = Number(input.version); if (!Number.isInteger(version) || version < 1) throw new Error(`${name}.version must be a positive integer`);
    this.store.get(kind, id, version); return { kind, id, version };
  }
}