import assert from "node:assert/strict";
import test from "node:test";
import { CraftService } from "../core/application/craft-service.ts";
import { WorkbenchEvaluations } from "../core/workbench-evaluations.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";

const evaluationId = "a".repeat(64);
const learningBinding = { host: "codex", task_id: "task-1", turn_id: "turn-1", context_receipt_id: "receipt-1", session_id: "session-1",
  host_evidence_id: "evidence-host", verification_ref: "test-run:host" };
const passingReport = { status: "complete", expected: 1, recorded: 1, passed: 1, failed: 0, inconclusive: 0, invalid: 0, missing: 0,
  results: [{ verdict: "passed" }] };
const record = (): JsonObject => ({ state: "completed", result_evidence: "worker_ipc_v1", input_digest: "inputs", report_digest: "report",
  learning_binding: learningBinding });

function harness(options: { initial?: JsonObject | null; after?: JsonObject | null; storageOwner?: string; finalizeStatus?: string; hostEvidence?: JsonObject | null } = {}) {
  let current = options.initial === undefined ? record() : options.initial;
  let finds = 0;
  const evalStore = { find: () => { finds += 1; return finds === 1 ? current : options.after === undefined ? current : options.after; } };
  const finalized: JsonObject[] = [];
  const experience = { serviceEnvironment: {}, store: { paths: { root: "/tmp/craft-learning-cycle-unit" }, find: () => options.hostEvidence ?? null },
    learningCycleFinalize: (args: JsonObject) => { finalized.push(args); return { status: options.finalizeStatus ?? "observed" }; } };
  const service = Object.create(CraftService.prototype) as CraftService;
  Object.assign(service, { storageOwner: options.storageOwner ?? "context", ownerServices: new Map<string, unknown>([
    ["experience", experience], ["eval", { store: evalStore }],
  ]) });
  return { service, evalStore, experience, finalized, update: (value: JsonObject) => { current = value; } };
}

async function withReport<T>(report: JsonObject, work: () => Promise<T>, integrity = "verified_against_controlled_run"): Promise<T> {
  const original = WorkbenchEvaluations.prototype.report;
  WorkbenchEvaluations.prototype.report = async () => ({ integrity, report });
  try { return await work(); } finally { WorkbenchEvaluations.prototype.report = original; }
}

test("controlled learning finalizer rejects missing owners, invalid ids, missing records and uncompleted evaluations", async () => {
  const method = CraftService.prototype.learningCycleFinalizeEvaluation;
  const noExperience = Object.create(CraftService.prototype) as CraftService;
  Object.assign(noExperience, { ownerServices: new Map(), storageOwner: undefined });
  await assert.rejects(method.call(noExperience, { evaluation_id: evaluationId }), /Experience owner is unavailable/u);

  const noEval = harness({ storageOwner: "experience" });
  Object.assign(noEval.service, { ownerServices: new Map([["experience", noEval.service]]) });
  await assert.rejects(method.call(noEval.service, { evaluation_id: evaluationId }), /Evaluation owner is unavailable/u);

  const h = harness();
  for (const evaluation_id of [undefined, "bad-id"]) await assert.rejects(method.call(h.service, { evaluation_id }), /evaluation_id/u);
  const missing = harness({ initial: null });
  await assert.rejects(method.call(missing.service, { evaluation_id: evaluationId }), /not found/u);
  const incomplete = harness({ initial: { ...record(), state: "running" } });
  assert.deepEqual(await method.call(incomplete.service, { evaluation_id: evaluationId }),
    { status: "rejected", reason: "evaluation_not_completed_or_controlled", observation_created: false });
});

test("controlled learning finalizer rejects bad reports and detects binding races", async () => {
  const method = CraftService.prototype.learningCycleFinalizeEvaluation;
  const invalidBinding = harness(); invalidBinding.update({ ...record(), learning_binding: undefined });
  await assert.rejects(method.call(invalidBinding.service, { evaluation_id: evaluationId }), /learning_binding must be an object/u);

  await withReport({ ...passingReport, failed: 1, passed: 0 }, async () => {
    const h = harness();
    assert.deepEqual(await method.call(h.service, { evaluation_id: evaluationId }),
      { status: "rejected", reason: "evaluation_report_not_fully_passing", observation_created: false });
  });
  await withReport(passingReport, async () => {
    const h = harness();
    assert.deepEqual(await method.call(h.service, { evaluation_id: evaluationId }),
      { status: "rejected", reason: "evaluation_report_not_fully_passing", observation_created: false });
  }, "legacy_unverified");
  await withReport(passingReport, async () => {
    const changes = [null, { ...record(), state: "failed" }, { ...record(), result_evidence: "legacy" },
      { ...record(), input_digest: "changed" }, { ...record(), report_digest: "changed" },
      { ...record(), learning_binding: { ...learningBinding, task_id: "changed" } }];
    for (const after of changes) {
      const h = harness({ after });
      await assert.rejects(method.call(h.service, { evaluation_id: evaluationId }), /binding changed during finalization/u);
    }
  });
});

test("controlled learning finalizer requires Host completion evidence and a current archive match", async () => {
  const method = CraftService.prototype.learningCycleFinalizeEvaluation;
  const evalOwned = harness({ storageOwner: "eval" });
  Object.assign(evalOwned.service, { store: evalOwned.evalStore });
  await withReport(passingReport, () => assert.rejects(method.call(evalOwned.service, { evaluation_id: evaluationId }), /Host completion evidence was not found/u));
  await withReport(passingReport, async () => {
    const missing = harness();
    await assert.rejects(method.call(missing.service, { evaluation_id: evaluationId }), /Host completion evidence was not found/u);
    const unindexed = harness({ hostEvidence: { id: learningBinding.host_evidence_id, source_type: "host_completion_signal", metadata: {} } });
    assert.deepEqual(await method.call(unindexed.service, { evaluation_id: evaluationId }),
      { status: "rejected", reason: "host_completion_evidence_not_current_or_mismatched", mismatched_fields: ["current_archive", "host", "task_id", "session_id", "turn_id", "context_receipt_id", "verification_ref", "terminal_outcome"], observation_created: false });
    assert.equal(unindexed.finalized.length, 0);
  });
});
