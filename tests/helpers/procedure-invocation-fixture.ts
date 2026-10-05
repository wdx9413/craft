import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftStore, type JsonObject } from "../../core/infrastructure/store.ts";
import { craftPaths } from "../../core/infrastructure/paths.ts";
import { CraftService } from "../../core/service.ts";
import { payload, stableDigest } from "../../core/digest.ts";
import { ProcedureDefinitionStore } from "../../capability/craft-experience/procedure-definition.ts";

export const scope = "project:invocation";
export const spec = (preconditions: string[] = []): JsonObject => ({
  steps: [{ id: "review", type: "instruction", side_effect: "read_only", requires: ["diff"], provides: ["report"], instruction: "Review diff" }],
  composition: { entries: [{ id: "review", title: "Review", required_inputs: ["diff"], preconditions, routes: [{ exit_id: "reviewed", step_ids: ["review"] }] }],
    exits: [{ id: "reviewed", title: "Reviewed", required_outputs: ["report"], acceptance_ref: "review-contract" }] },
});
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-invocation-"));
  const store = await new CraftStore(craftPaths(root)).open();
  let service = new CraftService(store), n = 0;
  store.create("task", "task", { status: "active" });
  store.create("task_control_contract", "contract", { task_id: "task", allowed_effects: ["read_only", "local_write"] });
  store.create("task_run", "run", { contract_id: "contract" });
  store.create("state_snapshot", "before", { workspace_id: "workspace", workspace_state_revision: 1, snapshot_digest: stableDigest("before") });
  service.verifiedWorkLoops.create({ work_loop_id: "work", task_id: "task", task_run_id: "run", contract_id: "contract", snapshot_id: "before", goal: "Review changes" });
  function create(value = spec(), failureDisposition = "checkpoint_and_handoff"): JsonObject {
    const id = `p${++n}`;
    const definition = new ProcedureDefinitionStore(store.paths).write({ schema_version: "craft.procedure.v1", procedure_id: id, procedure_version: 1, kind: "workflow", scope,
      trigger: "coding", preconditions: [], allowed_effects: ["read", "local_write"], acceptance_ref: "review-contract", failure_disposition: failureDisposition,
      scenario_signature: { domain: "coding" }, evidence_ids: ["source"], proposal_ref: { id: "proposal", version: 1 }, definition: value }, id);
    return store.create("experience_procedure", id, { scope, procedure_kind: "workflow", routeable: true, lifecycle: "routeable", definition_ref: definition, definition_digest: definition.digest });
  }
  function args(p: JsonObject, id = "invoke"): JsonObject { return { invocation_id: id, work_loop_id: "work", procedure_id: p.id, procedure_version: p.version, scope,
    entry_id: "review", exit_id: "reviewed", input_refs: { diff: "artifact:diff" }, allowed_effects: ["read_only", "local_write"], host_id: "host", model_fingerprint: "model-v1", budget_fingerprint: "budget-v1", max_dispatches: 30, ttl_ms: 60_000 }; }
  function params(id = "invoke"): JsonObject { return { invocation_id: id, scope, expected_version: store.get("procedure_invocation", id).version }; }
  function dispatch(id = "invoke", extra: JsonObject = {}): JsonObject {
    const state = service.procedureInvocationGet(params(id));
    const items = state.work_items as JsonObject[];
    const ready = items.find(item => item.status === "pending" && (item.depends_on as string[]).every(key => items.some(other => other.item_key === key && other.status === "verified")))!;
    return service.procedureInvocationDispatch({ ...params(id), snapshot_id: (state.loop as JsonObject).latest_snapshot_id, item_key: ready.item_key, ...extra });
  }
  function proof(prepared: JsonObject, verdict = "passed", snapshotId = "before", measured = false): JsonObject {
    const dispatch = prepared.dispatch as JsonObject, item = prepared.work_item as JsonObject;
    const id = String(dispatch.id), snapshot = store.get("state_snapshot", snapshotId);
    const outputs = item.kind === "exit" ? dispatch.input_refs : Object.fromEntries(Object.keys(item.output_keys as JsonObject).map(key => [key, `artifact:${id}:${key}`]));
    const evidenceId = `e:${id}`, sessionId = `s:${id}`;
    store.create("evidence", evidenceId, { source_type: "program", confidence: "confirmed", metadata: { dispatch_digest: dispatch.dispatch_digest, acceptance_digest: item.acceptance_digest, output_digest: stableDigest(outputs), state_after_digest: snapshot.snapshot_digest, status: verdict, ...(measured ? { metrics: { cost_units: 1, latency_ms: 10, retry_count: 0 } } : {}) } });
    const session = service.hostSessionOpen({ session_id: sessionId, task_id: "task", host_id: "host", environment_fingerprint: "env", policy_fingerprint: "policy", capability_fingerprint: dispatch.dispatch_digest, model_fingerprint: "model-v1", budget_fingerprint: "budget-v1" }).session as JsonObject;
    service.hostSessionAppend({ session_id: sessionId, kind: verdict === "passed" ? "session.completed" : "session.failed", state_after_ref: snapshotId });
    service.outcomeObserverObserve({ observation_id: `o:${id}`, trace_id: session.trace_id, host_id: "host", observer_id: "verifier", observer_kind: "program", environment_fingerprint: "env", verdict, state_snapshot_ref: snapshotId, evidence_ids: [evidenceId] });
    return { ...params(String(dispatch.invocation_id)), dispatch_id: id, host_session_id: sessionId, observation_id: `o:${id}`, snapshot_id: snapshotId, output_refs: outputs, acceptance_evidence_ids: [evidenceId] };
  }
  function precondition(id: string, path: string, inputRefs: JsonObject, snapshotId = "before"): string {
    const snapshot = store.get("state_snapshot", snapshotId), evidenceId = `pre:${id}:${path}`;
    store.create("evidence", evidenceId, { confidence: "confirmed", metadata: { scope, invocation_id: id, call_path: path, task_id: "task", condition_ref: "approved", input_digest: stableDigest(inputRefs), snapshot_digest: snapshot.snapshot_digest, workspace_state_revision: snapshot.workspace_state_revision, expires_at: new Date(Date.now() + 60_000).toISOString() } });
    return evidenceId;
  }
  return { root, store, get service() { return service; }, create, args, params, dispatch, proof, precondition,
    async reopen() { store.close(); await store.open(); service = new CraftService(store); }, async close() { store.close(); await rm(root, { recursive: true, force: true }); } };
}
