import type { CraftService } from "./craft-service.ts";
import type { JsonObject } from "../infrastructure/store.ts";
import { object, text } from "../validation.ts";

/** The embedded Host uses existing session/observation kernels; this never starts a child Host. */
export function procedureHostControl(service: CraftService, args: JsonObject): JsonObject {
  const action = text(args.action, "action"), input = object(args.input, "input");
  if (action === "prepare") return { ...service.verifiedWorkLoopWorkbenchPrepare({ ...input, interaction_mode: "plan", defer_host_start: true }), host_execution_authority: false };
  const state = service.procedureInvocationGet(args), run = object(state.invocation, "invocation");
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
