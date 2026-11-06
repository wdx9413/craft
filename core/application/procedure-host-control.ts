import type { CraftService } from "./craft-service.ts";
import type { JsonObject } from "../infrastructure/store.ts";
import { object, text } from "../validation.ts";
import { stableDigest } from "../digest.ts";

function procedureEvolutionCycleStart(service: CraftService, run: JsonObject, dispatch: JsonObject, session: JsonObject): JsonObject {
  if (typeof session.evolution_cycle_id === "string") return service.evolutionCycleGet({ cycle_id: session.evolution_cycle_id });
  const workspace = service.store.find("workspace", String(run.workspace_id));
  const checkpointId = workspace?.latest_checkpoint_id;
  if (typeof checkpointId !== "string" || !checkpointId) return { status: "unavailable", reason: "workspace_checkpoint_required" };
  const identity = service.scopeIdentityResolveProject({ project_root: text(workspace?.root_path, "workspace.root_path") }).identity as JsonObject;
  const projectScope = identity.canonical_scope as JsonObject;
  const task = service.store.get("task", text(run.task_id, "task_id"));
  const hostState = service.hostSessionGet({ session_id: session.id });
  const events = hostState.events as JsonObject[];
  const started = events.find(event => event.kind === "session.started");
  if (!started || typeof started.trace_event_id !== "string" || !Number.isSafeInteger(started.trace_event_version) || Number(started.trace_event_version) < 1
    || !Number.isSafeInteger(started.version) || Number(started.version) < 1)
    throw new Error("Evolution Cycle requires the Host Session start Trace");
  const cycleId = `evolution_cycle_procedure_${stableDigest({ task_id: run.task_id, host_session_id: session.id }).slice(-24)}`;
  let cycle = service.evolutionCycleStart({ cycle_id: cycleId, task_id: run.task_id, project_scope_id: text(projectScope.id, "project_scope_id"),
    session_host: text(run.host_id, "host_id"), session_id: text(session.id, "session_id"), workspace_id: text(workspace.id, "workspace_id"),
    checkpoint_id: checkpointId, trigger: "verified_procedure_host_dispatch",
    trigger_refs: [{ kind: "task", id: String(task.id), version: Number(task.version) }, { kind: "host_session_event", id: text(started.id, "Host Session event"), version: Number(started.version) }] }).cycle as JsonObject;
  if (cycle.stage === "observe") cycle = service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version,
    transition_id: `${cycleId}:retrieve`, stage: "retrieve", artifact_refs: [{ kind: "experience_procedure", id: text(run.procedure_id, "procedure_id"), version: Number(run.procedure_version) }] }).cycle as JsonObject;
  if (cycle.stage === "retrieve") cycle = service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version,
    transition_id: `${cycleId}:act`, stage: "act", artifact_refs: [{ kind: "procedure_invocation_dispatch", id: text(dispatch.id, "dispatch_id"), version: Number(dispatch.version) }],
    trace_refs: [{ kind: "trace_event", id: text(started.trace_event_id, "session.started trace event"), version: Number(started.trace_event_version) }] }).cycle as JsonObject;
  const savedSession = service.store.get("host_session", String(session.id));
  if (savedSession.evolution_cycle_id !== cycleId) service.store.save("host_session", String(session.id), { ...savedSession, evolution_cycle_id: cycleId });
  return service.evolutionCycleGet({ cycle_id: cycleId });
}

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
  if (action === "session_open") {
    const opened = service.hostSessionOpen({ session_id: sessionId, task_id: run.task_id, host_id: run.host_id,
    environment_fingerprint: text(input.environment_fingerprint, "environment_fingerprint"), policy_fingerprint: text(input.policy_fingerprint, "policy_fingerprint"),
    capability_fingerprint: dispatch.dispatch_digest, model_fingerprint: run.model_fingerprint, budget_fingerprint: run.budget_fingerprint });
    return { ...opened, evolution_cycle: procedureEvolutionCycleStart(service, run, dispatch, opened.session as JsonObject) };
  }
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
