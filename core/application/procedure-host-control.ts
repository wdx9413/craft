import type { CraftService } from "./craft-service.ts";
import type { JsonObject } from "../infrastructure/store.ts";
import { object, text } from "../validation.ts";

/** The embedded Host uses existing session/observation kernels; this never starts a child Host. */
export function procedureHostControl(service: CraftService, args: JsonObject): JsonObject {
  const action = text(args.action, "action"), input = object(args.input, "input");
  if (action === "prepare") return { ...service.verifiedWorkLoopWorkbenchPrepare({ ...input, interaction_mode: "plan", defer_host_start: true }), host_execution_authority: false };
  if (action === "start") return service.store.transaction(() => {
    // Reuse the same planner and bind contract; no alternate authority or execution path.
    const binding = { ...input };
    for (const key of ["principal_id", "principal_ids", "tenant_id", "cognitive_purpose"]) delete binding[key];
    for (const key of ["scope", "principal_id", "principal_ids", "tenant_id", "cognitive_purpose"]) if (args[key] !== undefined) binding[key] = args[key];
    const plan = service.experienceProcedurePlan(binding);
    const state = service.procedureInvocationBind(binding);
    return { ...state, plan, usage_status: "bound", next_tool: "craft_procedure_host_control", next_action: "next", host_execution_authority: false };
  });
  const state = service.procedureInvocationGet(args), run = object(state.invocation, "invocation");
  if (action === "next") {
    const dispatches = state.dispatches as JsonObject[], receipts = state.receipts as JsonObject[];
    const pending = dispatches.filter(dispatch => !receipts.some(receipt => receipt.id === dispatch.id));
    if (pending.length) return { ...state, usage_status: "awaiting_receipt", next_tool: "craft_procedure_invocation_report", pending_dispatch_ids: pending.map(dispatch => dispatch.id), host_execution_authority: false };
    const items = state.work_items as JsonObject[];
    const ready = items.filter(item => run.lifecycle === "active" && (state.loop as JsonObject).lifecycle === "active" && item.status === "pending" && (item.depends_on as string[]).every(id => items.some(other => other.item_key === id && other.status === "verified")));
    return { ...state, usage_status: run.lifecycle, next_tool: run.lifecycle === "completed" ? null : ready.length ? "craft_procedure_invocation_dispatch" : run.graph ? "craft_procedure_invocation_transition" : "craft_procedure_invocation_resume",
      ready_item_keys: ready.map(item => item.item_key), expected_version: run.version, snapshot_id: (state.loop as JsonObject).latest_snapshot_id, host_execution_authority: false };
  }
  if (action === "snapshot") return service.stateWorkspaceObserve({ workspace_id: run.workspace_id });
  if (!["session_open", "session_close", "observe"].includes(action)) throw new Error("Unsupported Procedure Host operation");
  const dispatch = service.store.get("procedure_invocation_dispatch", text(input.dispatch_id, "dispatch_id"));
  if (dispatch.invocation_id !== run.id) throw new Error("Host dispatch belongs to another Invocation");
  const sessionId = `procedure_host:${dispatch.id}`;
  if (action === "session_open") return service.hostSessionOpen({ session_id: sessionId, task_id: run.task_id, host_id: run.host_id,
    environment_fingerprint: text(input.environment_fingerprint, "environment_fingerprint"), policy_fingerprint: text(input.policy_fingerprint, "policy_fingerprint"),
    capability_fingerprint: dispatch.dispatch_digest, model_fingerprint: run.model_fingerprint, budget_fingerprint: run.budget_fingerprint });
  const session = service.store.get("host_session", sessionId);
  const snapshot = service.store.get("state_snapshot", text(input.snapshot_id, "snapshot_id"));
  if (snapshot.workspace_id !== run.workspace_id) throw new Error("Host snapshot belongs to another workspace");
  if (action === "session_close") {
    const kind = text(input.kind, "kind");
    if (!["session.completed", "session.failed", "session.cancelled"].includes(kind)) throw new Error("A terminal Host event is required");
    return service.hostSessionAppend({ session_id: sessionId, kind, state_after_ref: snapshot.id });
  }
  const observer = text(input.observer_id, "observer_id");
  if (observer === run.host_id) throw new Error("The executing Host cannot be its program observer");
  return { ...service.outcomeObserverObserve({ observation_id: input.observation_id, trace_id: session.trace_id, host_id: run.host_id,
    observer_id: observer, observer_kind: "program", environment_fingerprint: session.environment_fingerprint, verdict: input.verdict,
    state_snapshot_ref: snapshot.id, evidence_ids: input.evidence_ids }), verification_provenance: "host_attested", promotion_eligible: false };
}
