import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { text } from "./validation.ts";
import { digestJson, payload } from "./digest.ts";




type ProtocolPhase = "define" | "prepare" | "act" | "deliver" | "learn";
function phaseFor(status: string, decision?: string): ProtocolPhase {
  if (["needs_replan", "blocked", "recovery"].includes(status) || ["replan", "human_change", "reject"].includes(String(decision))) return "define";
  if (decision === "approve" || status === "running") return "act";
  if (decision === "accept") return "learn";
  if (["ready_for_delivery", "awaiting_acceptance"].includes(status)) return "deliver";
  return "prepare";
}

/** A single durable facade over existing launch, receipt, acceptance and state facts. */
export class VerifiedWorkLoopKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  create(args: JsonObject): JsonObject {
    const task = this.store.get("task", text(args.task_id, "task_id")); const contract = this.store.get("task_control_contract", text(args.contract_id, "contract_id")); const run = this.store.get("task_run", text(args.task_run_id, "task_run_id")); const snapshot = this.store.get("state_snapshot", text(args.snapshot_id, "snapshot_id"));
    if (contract.task_id !== task.id || run.contract_id !== contract.id) throw new Error("Verified Work Loop facts are not bound to one Task");
    const identity = { task_id: task.id, contract_id: contract.id, contract_version: contract.version, task_run_id: run.id, task_run_version: run.version, workspace_id: snapshot.workspace_id, initial_snapshot_id: snapshot.id, initial_snapshot_digest: snapshot.snapshot_digest };
    const loopId = String(args.work_loop_id ?? `work_loop_${run.id}`); const existing = this.store.find("verified_work_loop", loopId); const identityDigest = digestJson(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Verified Work Loop idempotency conflict"); return { loop: existing, idempotent: true }; }
    const phaseHistory = [{ phase: "define", fact: "task_control_contract", version: contract.version }, { phase: "prepare", fact: "initial_state_snapshot", version: snapshot.version }];
    return { loop: this.store.create("verified_work_loop", loopId, { ...identity, identity_digest: identityDigest, lifecycle: "active", phase: "prepare", phase_history: phaseHistory, latest_snapshot_id: snapshot.id, latest_task_run_state_id: null, needs_replan_reason: null }), idempotent: false };
  }

  advance(args: JsonObject): JsonObject {
    const loop = this.store.get("verified_work_loop", text(args.work_loop_id, "work_loop_id")); const state = this.store.get("task_run_state", text(args.task_run_state_id, "task_run_state_id")); const snapshot = this.store.get("state_snapshot", text(args.snapshot_id, "snapshot_id"));
    if (state.task_run_id !== loop.task_run_id || snapshot.workspace_id !== loop.workspace_id) throw new Error("Verified Work Loop observation does not belong to this Run");
    const previous = this.store.get("state_snapshot", String(loop.latest_snapshot_id)); const changed = previous.snapshot_digest !== snapshot.snapshot_digest || previous.workspace_state_revision !== snapshot.workspace_state_revision;
    const hostTerminal = ["ready_for_delivery", "awaiting_acceptance", "recovery", "blocked"].includes(String(state.status));
    const status = loop.lifecycle === "needs_replan" || (changed && !hostTerminal) || state.status === "needs_replan" ? "needs_replan" : state.status;
    // An explicit human decision is the first and most specific cause of a replan,
    // so a later observation must not overwrite it with a derived one.
    const priorReason = loop.lifecycle === "needs_replan" ? String(loop.needs_replan_reason) : null;
    const reason = status === "needs_replan" ? (priorReason ?? (changed ? "workspace_changed_without_terminal_receipt" : "task_run_drift")) : null;
    const phase = phaseFor(String(status)); const history = [...((loop.phase_history as JsonObject[] | undefined) ?? [])];
    if (history.at(-1)?.phase !== phase) history.push({ phase, fact: "task_run_state", version: state.version });
    const saved = this.store.save("verified_work_loop", String(loop.id), { ...payload(loop), latest_snapshot_id: snapshot.id, latest_task_run_state_id: state.id, lifecycle: status === "needs_replan" ? "needs_replan" : loop.lifecycle, phase, phase_history: history, needs_replan_reason: reason });
    const identity = { work_loop_id: saved.id, work_loop_version: saved.version, task_run_state_id: state.id, task_run_state_version: state.version, snapshot_id: snapshot.id, snapshot_version: snapshot.version, status, reason };
    // A receipt must describe exactly one observation. Record versions repeat across
    // observations, so the default id is derived from the observation itself: replaying
    // the same state and snapshot stays idempotent, while a new snapshot, status or
    // reason can never reuse an older receipt.
    const observation = { task_run_state_id: state.id, snapshot_id: snapshot.id, status, reason };
    const receiptId = String(args.receipt_id ?? `work_loop_receipt_${saved.id}_${digestJson(observation).slice(-16)}`);
    const receipt = this.store.find("verified_work_loop_receipt", receiptId) ?? this.store.create("verified_work_loop_receipt", receiptId, { ...identity, receipt_digest: digestJson(identity) });
    return { loop: saved, state: { status, action: status === "needs_replan" ? "replan" : state.action, actor: status === "needs_replan" ? "human" : state.actor }, receipt };
  }

  decide(args: JsonObject): JsonObject {
    const loop = this.store.get("verified_work_loop", text(args.work_loop_id, "work_loop_id")); const decision = text(args.decision, "decision");
    if (!["approve", "replan", "accept", "reject", "human_change"].includes(decision)) throw new Error("Verified Work Loop decision is unsupported");
    // A retried human decision must remain idempotent even though the first
    // attempt may itself advance the Loop version.
    const identity = { work_loop_id: loop.id, decision, actor: text(args.actor, "actor"), summary_digest: digestJson(text(args.summary, "summary")) };
    const decisionId = String(args.decision_id ?? `work_loop_decision_${loop.id}_${digestJson(identity).slice(-16)}`); const existing = this.store.find("verified_work_loop_decision", decisionId); const decisionDigest = digestJson(identity);
    if (existing) { if (existing.decision_digest !== decisionDigest) throw new Error("Verified Work Loop decision idempotency conflict"); return { decision: existing, idempotent: true }; }
    const saved = this.store.create("verified_work_loop_decision", decisionId, { ...identity, work_loop_version: loop.version, decision_digest: decisionDigest });
    const phase = phaseFor(String(loop.lifecycle), decision); const history = [...((loop.phase_history as JsonObject[] | undefined) ?? [])];
    if (history.at(-1)?.phase !== phase) history.push({ phase, fact: "human_decision", decision, version: loop.version });
    if (["human_change", "replan", "reject"].includes(decision)) this.store.save("verified_work_loop", String(loop.id), { ...payload(loop), lifecycle: "needs_replan", phase, phase_history: history, needs_replan_reason: decision });
    else this.store.save("verified_work_loop", String(loop.id), { ...payload(loop), phase, phase_history: history });
    return { decision: saved, idempotent: false };
  }

  get(args: JsonObject): JsonObject { const loop = this.store.get("verified_work_loop", text(args.work_loop_id, "work_loop_id")); return { loop, protocol: { phases: ["define", "prepare", "act", "deliver", "learn"], current_phase: loop.phase ?? "prepare", conditional: true }, receipts: this.store.list("verified_work_loop_receipt", 1000, (item) => item.work_loop_id === loop.id), decisions: this.store.list("verified_work_loop_decision", 1000, (item) => item.work_loop_id === loop.id) }; }
}
