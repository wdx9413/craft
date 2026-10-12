import type { CraftStore, JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { activeProcedure } from "./procedure-release.ts";
import { stableDigest, payload } from "../../common/craft-common-base/src/digest.ts";

const STAGES = ["shadow", "held_out", "signoff", "canary"] as const;
type Stage = typeof STAGES[number];
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}

/** Adapter-neutral, evidence-bound orchestration for Experience qualification. */
export class ExperienceLearningEvaluation {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  dispatch(args: JsonObject): JsonObject {
    const procedure = this.store.get("experience_procedure", text(args.procedure_id, "procedure_id"));
    if (procedure.lifecycle !== "candidate" || procedure.routeable === true) throw new Error("Only an unpublished candidate can enter automatic evaluation");
    const completed = Array.isArray(procedure.completed_gates) ? procedure.completed_gates.map(String) : [];
    const stage = STAGES.find(item => !completed.includes(item));
    if (!stage) throw new Error("Experience candidate has no remaining evaluation stage");
    const current = activeProcedure(this.store, String(procedure.id));
    const identity = { procedure_id: procedure.id, procedure_version: procedure.version, definition_digest: procedure.definition_digest,
      stage, baseline_version: current?.version ?? null, scenario_signature: procedure.scenario_signature, content_free: true,
      trace_id: `experience-learning:${stableDigest({ procedure_id: procedure.id, definition_digest: procedure.definition_digest, stage, baseline_version: current?.version ?? null }).slice(-20)}`,
      external_execution_required: true };
    const id = String(args.dispatch_id ?? `experience_evaluation_dispatch_${stableDigest(identity).slice(-20)}`);
    const prior = this.store.find("experience_evaluation_dispatch", id);
    if (prior) {
      if (prior.identity_digest !== stableDigest(identity)) throw new Error("Experience evaluation dispatch idempotency conflict");
      return { dispatch: prior, idempotent: true };
    }
    const dispatch = this.store.create("experience_evaluation_dispatch", id, { ...identity, identity_digest: stableDigest(identity), status: "awaiting_adapter" });
    this.store.appendEvent(`experience:${procedure.id}`, "experience.evaluation_dispatched", { dispatch_id: id, stage, trace_id: dispatch.trace_id, procedure_version: procedure.version, definition_digest: procedure.definition_digest });
    return { dispatch, idempotent: false };
  }

  result(args: JsonObject, gate: (input: JsonObject) => JsonObject): JsonObject {
    return this.store.transaction(() => this.applyResult(args, gate));
  }

  private applyResult(args: JsonObject, gate: (input: JsonObject) => JsonObject): JsonObject {
    const id = text(args.dispatch_id, "dispatch_id");
    const dispatch = this.store.get("experience_evaluation_dispatch", id);
    if (dispatch.status !== "awaiting_adapter") {
      const replayEvidence = Array.isArray(args.evidence_ids) ? [...new Set(args.evidence_ids.map(value => text(value, "evidence_ids")))].sort() : [];
      if (!["passed", "failed"].includes(String(dispatch.status)) || stableDigest(replayEvidence) !== stableDigest(dispatch.evidence_ids)) throw new Error("Experience evaluation dispatch is already resolved with different evidence");
      const procedure = this.store.get("experience_procedure", String(dispatch.procedure_id));
      const recordedGate = this.store.get("experience_procedure_gate", String(dispatch.gate_id));
      return { dispatch, gate: recordedGate, procedure, next_dispatch: null,
        current: dispatch.stage === "canary" && dispatch.status === "passed" ? activeProcedure(this.store, String(procedure.id)) : null, idempotent: true };
    }
    const procedure = this.store.get("experience_procedure", String(dispatch.procedure_id), Number(dispatch.procedure_version));
    if (procedure.definition_digest !== dispatch.definition_digest) throw new Error("Experience evaluation candidate definition drifted");
    if (!Array.isArray(args.evidence_ids) || args.evidence_ids.length === 0 || args.evidence_ids.length > 20) throw new Error("evidence_ids must contain between 1 and 20 values");
    const evidenceIds = [...new Set(args.evidence_ids.map(value => text(value, "evidence_ids")))].sort();
    if (evidenceIds.length !== args.evidence_ids.length) throw new Error("evidence_ids must be unique");
    for (const evidenceId of evidenceIds) {
      const evidence = this.store.get("evidence", evidenceId);
      const metadata = evidence.metadata as JsonObject | undefined;
      if (evidence.source_type !== "program" || evidence.confidence !== "confirmed" || metadata?.experience_evaluation_dispatch_id !== id
        || metadata.procedure_id !== procedure.id || metadata.procedure_version !== procedure.version || metadata.definition_digest !== procedure.definition_digest
        || metadata.baseline_version !== dispatch.baseline_version || metadata.stage !== dispatch.stage || !["passed", "failed"].includes(String(metadata.status))
        || typeof metadata.evaluator_ref !== "string" || typeof metadata.environment_digest !== "string") {
        throw new Error("Experience evaluation Evidence is not confirmed and bound to this dispatch");
      }
      if (dispatch.stage === "held_out" && (typeof metadata.held_out_set_ref !== "string" || !metadata.held_out_set_ref || metadata.independent_of_training !== true)) throw new Error("Held-out gate requires a pinned independent case set");
      if (dispatch.stage === "signoff" && (typeof metadata.signoff_ref !== "string" || !metadata.signoff_ref)) throw new Error("Signoff gate requires a reviewer reference");
    }
    const passed = evidenceIds.every(id => (this.store.get("evidence", id).metadata as JsonObject).status === "passed");
    const gateResult = gate({ procedure_id: procedure.id, stage: dispatch.stage, passed, verdict: passed ? "adapter_evaluated_pass" : "adapter_evaluated_fail",
      evidence_ids: evidenceIds, expected_version: procedure.version, gate_id: `experience_auto_gate_${stableDigest({ dispatch: id, evidenceIds, passed }).slice(-20)}` });
    const savedDispatch = this.store.save("experience_evaluation_dispatch", id, { ...payload(dispatch), status: passed ? "passed" : "failed", evidence_ids: evidenceIds, gate_id: (gateResult.gate as JsonObject).id });
    const next = passed && dispatch.stage !== "canary" ? this.dispatch({ procedure_id: procedure.id }) : null;
    const updated = gateResult.procedure as JsonObject;
    this.store.appendEvent(`experience:${procedure.id}`, "experience.evaluation_result_recorded", { dispatch_id: id, gate_id: (gateResult.gate as JsonObject).id, stage: dispatch.stage, status: passed ? "passed" : "failed", evidence_ids: evidenceIds, trace_id: dispatch.trace_id });
    return { dispatch: savedDispatch, gate: gateResult.gate, procedure: updated, next_dispatch: next?.dispatch ?? null,
      current: dispatch.stage === "canary" && passed ? activeProcedure(this.store, String(procedure.id)) : null, idempotent: false };
  }
}
