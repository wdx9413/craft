import assert from "node:assert/strict";
import test from "node:test";
import { fixture, scope, spec } from "./helpers/procedure-invocation-fixture.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { stableDigest } from "../core/digest.ts";
import { AUTOMATIC_SIGNOFF_POLICY } from "../capability/craft-experience/scenario-evaluation.ts";

function evidence(f: Awaited<ReturnType<typeof fixture>>, dispatch: JsonObject, status = "passed", extra: JsonObject = {}): string {
  const id = `proof-${String(dispatch.id)}-${stableDigest({ status, extra }).slice(-8)}`;
  const procedure = f.store.get("experience_procedure", String(dispatch.procedure_id), Number(dispatch.procedure_version));
  const entry = (procedure.entrypoints as JsonObject[] | undefined)?.[0];
  const route = entry && (entry.routes as JsonObject[])[0];
  f.store.create("evidence", id, { source_type: "program", confidence: "confirmed", metadata: {
    experience_evaluation_dispatch_id: dispatch.id, procedure_id: dispatch.procedure_id,
    procedure_version: dispatch.procedure_version, definition_digest: dispatch.definition_digest,
    procedure_definition_digest: dispatch.definition_digest,
    baseline_version: dispatch.baseline_version, stage: dispatch.stage, status, evaluator_ref: "adapter:test", environment_digest: "sha256:environment",
    ...(entry && route ? { entry_id: entry.id, exit_id: route.exit_id, subscenario_id: route.subscenario_id } : {}), ...extra,
  } });
  return id;
}

async function candidate(f: Awaited<ReturnType<typeof fixture>>, id: string): Promise<JsonObject> {
  f.service.evidenceRecord({ evidence_id: `source-${id}`, source_type: "program", confidence: "confirmed", claim: "verified source" });
  return f.service.procedureConfigurationSave({ procedure_id: id, scope, title: "Verified workflow", scenario_id: id,
    procedure_kind: "workflow", definition: spec(), evidence_ids: [`source-${id}`] }).procedure as JsonObject;
}

test("evaluation adapter can poll only bounded pending dispatches and resolved work leaves the queue", async () => {
  const f = await fixture();
  try {
    const cand = await candidate(f, "pending-queue");
    const shadow = f.service.experienceLearningEvaluationDispatch({ procedure_id: cand.id }).dispatch as JsonObject;
    const pending = f.service.experienceLearningEvaluationList({}) as JsonObject;
    assert.equal(pending.count, 1);
    assert.equal((pending.dispatches as JsonObject[])[0]?.id, shadow.id);
    assert.throws(() => f.service.experienceLearningEvaluationList({ limit: 0 }), /between 1 and 1000/u);
    assert.throws(() => f.service.experienceLearningEvaluationList({ limit: 1.5 }), /between 1 and 1000/u);
    assert.throws(() => f.service.experienceLearningEvaluationList({ limit: 1_001 }), /between 1 and 1000/u);

    const passedShadow = evidence(f, shadow);
    const heldOut = f.service.experienceLearningEvaluationResult({ dispatch_id: shadow.id, evidence_ids: [passedShadow] }).next_dispatch as JsonObject;
    const afterShadow = f.service.experienceLearningEvaluationList({ limit: 1 }) as JsonObject;
    assert.equal(afterShadow.count, 1);
    assert.equal((afterShadow.dispatches as JsonObject[])[0]?.id, heldOut.id);

    const failedHeldOut = evidence(f, heldOut, "failed", { held_out_set_ref: "held-out:v1", independent_of_training: true });
    f.service.experienceLearningEvaluationResult({ dispatch_id: heldOut.id, evidence_ids: [failedHeldOut] });
    assert.deepEqual(f.service.experienceLearningEvaluationList({}), { dispatches: [], count: 0 });
  } finally { await f.close(); }
});

test("Experience evaluation queues ordered gates and publishes only after Canary evidence", async () => {
  const f = await fixture();
  try {
    const p = await candidate(f, "auto-publish");
    let dispatch = f.service.experienceLearningEvaluationDispatch({ procedure_id: p.id }).dispatch as JsonObject;
    assert.equal(dispatch.stage, "shadow");
    assert.equal(f.service.experienceLearningEvaluationDispatch({ procedure_id: p.id }).idempotent, true);
    for (const stage of ["shadow", "held_out", "signoff", "canary"]) {
      assert.equal(dispatch.stage, stage);
      const extra = stage === "held_out" ? { held_out_set_ref: "dataset:independent-v1", independent_of_training: true } : stage === "signoff" ? { signoff_policy_ref: AUTOMATIC_SIGNOFF_POLICY } : {};
      const id = evidence(f, dispatch, "passed", extra);
      const result = f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch.id, evidence_ids: [id] });
      assert.equal(f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch.id, evidence_ids: [id] }).idempotent, true);
      assert.throws(() => f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch.id, evidence_ids: ["different-proof"] }), /already resolved with different evidence/u);
      if (stage !== "canary") dispatch = result.next_dispatch as JsonObject;
      else {
        assert.equal((result.procedure as JsonObject).routeable, true);
        assert.equal((result.current as JsonObject).id, p.id);
        assert.equal(result.next_dispatch, null);
      }
    }
  } finally { await f.close(); }
});

test("Experience evaluation rejects unbound, weak, duplicate and out-of-order evidence", async () => {
  const f = await fixture();
  try {
    const p = await candidate(f, "reject-unbound");
    const dispatch = f.service.experienceLearningEvaluationDispatch({ procedure_id: p.id }).dispatch as JsonObject;
    assert.throws(() => f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch.id, evidence_ids: [] }), /between 1 and 20/u);
    const weak = `weak-${String(dispatch.id)}`;
    f.store.create("evidence", weak, { source_type: "program", confidence: "bounded", metadata: { experience_evaluation_dispatch_id: dispatch.id } });
    assert.throws(() => f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch.id, evidence_ids: [weak] }), /not confirmed and bound/u);
    const valid = evidence(f, dispatch);
    assert.throws(() => f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch.id, evidence_ids: [valid, valid] }), /unique/u);
    const failed = evidence(f, dispatch, "failed");
    const result = f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch.id, evidence_ids: [failed] });
    assert.equal((result.procedure as JsonObject).lifecycle, "rejected");
    assert.equal(result.next_dispatch, null);
    assert.throws(() => f.service.experienceLearningEvaluationDispatch({ procedure_id: p.id }), /unpublished candidate/u);
    assert.throws(() => f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch.id, evidence_ids: [valid] }), /already resolved/u);
    assert.throws(() => f.service.experienceLearningEvaluationDispatch({ procedure_id: "missing" }), /Unknown experience_procedure/u);
  } finally { await f.close(); }
});

test("Held-out and Signoff require their distinct independent records", async () => {
  const f = await fixture();
  try {
    const p = await candidate(f, "require-gates");
    let dispatch = f.service.experienceLearningEvaluationDispatch({ procedure_id: p.id }).dispatch as JsonObject;
    const wrongBaseline = evidence(f, dispatch, "passed", { baseline_version: 999 });
    assert.throws(() => f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch.id, evidence_ids: [wrongBaseline] }), /not confirmed and bound/u);
    for (const stage of ["shadow", "held_out"] as const) {
      const id = evidence(f, dispatch, "passed");
      if (stage === "held_out") {
        assert.throws(() => f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch.id, evidence_ids: [id] }), /independent case set/u);
        const nonIndependent = evidence(f, dispatch, "passed", { held_out_set_ref: "training-set:v1", independent_of_training: false });
        assert.throws(() => f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch.id, evidence_ids: [nonIndependent] }), /independent case set/u);
      }
      else dispatch = f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch.id, evidence_ids: [id] }).next_dispatch as JsonObject;
      if (stage === "held_out") {
        const proof = evidence(f, dispatch, "passed", { held_out_set_ref: "held-out:v1", independent_of_training: true });
        dispatch = f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch.id, evidence_ids: [proof] }).next_dispatch as JsonObject;
      }
    }
    const missingSignoff = evidence(f, dispatch);
    assert.throws(() => f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch.id, evidence_ids: [missingSignoff] }), /automatic policy Evidence/u);
  } finally { await f.close(); }
});

test("dispatch enforces candidate state, full qualification, current baseline pinning and identity conflicts", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.service.experienceLearningEvaluationDispatch({ procedure_id: " " }), /must not be empty/u);
    const routeable = f.create();
    assert.throws(() => f.service.experienceLearningEvaluationDispatch({ procedure_id: routeable.id }), /unpublished candidate/u);

    const baseline = f.create();
    const cand = f.service.procedureConfigurationSave({ procedure_id: baseline.id, expected_version: baseline.version,
      scope, title: "Revised workflow", scenario_id: "revised", procedure_kind: "workflow", definition: spec(["fresh context"]) }).procedure as JsonObject;
    const pinned = f.service.experienceLearningEvaluationDispatch({ procedure_id: cand.id, dispatch_id: "baseline-pinned" }).dispatch as JsonObject;
    assert.equal(pinned.baseline_version, baseline.version);

    const other = await candidate(f, "dispatch-conflict");
    f.service.experienceLearningEvaluationDispatch({ procedure_id: other.id, dispatch_id: "shared-dispatch-id" });
    const third = await candidate(f, "dispatch-conflict-2");
    assert.throws(() => f.service.experienceLearningEvaluationDispatch({ procedure_id: third.id, dispatch_id: "shared-dispatch-id" }), /idempotency conflict/u);

    const noGateHistory = await candidate(f, "no-gate-history");
    const noHistoryRecord = f.store.get("experience_procedure", String(noGateHistory.id));
    f.store.save("experience_procedure", String(noGateHistory.id), { ...noHistoryRecord, completed_gates: null });
    assert.equal((f.service.experienceLearningEvaluationDispatch({ procedure_id: noGateHistory.id }).dispatch as JsonObject).stage, "shadow");

    const fullyQualified = await candidate(f, "fully-qualified");
    const qualified = f.store.get("experience_procedure", String(fullyQualified.id));
    f.store.save("experience_procedure", String(qualified.id), { ...qualified, completed_gates: ["shadow", "held_out", "signoff", "canary"] });
    assert.throws(() => f.service.experienceLearningEvaluationDispatch({ procedure_id: fullyQualified.id }), /no remaining evaluation stage/u);
  } finally { await f.close(); }
});

test("candidate digest drift blocks result application and unresolved replay input is rejected", async () => {
  const f = await fixture();
  try {
    const p = await candidate(f, "digest-drift");
    const dispatch = f.service.experienceLearningEvaluationDispatch({ procedure_id: p.id }).dispatch as JsonObject;
    f.store.save("experience_evaluation_dispatch", String(dispatch.id), { ...dispatch, definition_digest: "sha256:tampered" });
    assert.throws(() => f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch.id, evidence_ids: ["unused"] }), /definition drifted/u);

    const p2 = await candidate(f, "missing-replay-list");
    const dispatch2 = f.service.experienceLearningEvaluationDispatch({ procedure_id: p2.id }).dispatch as JsonObject;
    const proof = evidence(f, dispatch2);
    f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch2.id, evidence_ids: [proof] });
    assert.throws(() => f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch2.id }), /already resolved with different evidence/u);
  } finally { await f.close(); }
});
