import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { aggregateEvaluation, compareEvaluationAggregates, pairedSignTestProbability, type EvaluationAggregate } from "../core/evaluation.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";

test("evaluation aggregation summarizes numeric metrics and compares every direction", () => {
  const run = { id: "run", suite_id: "suite", suite_version: 1, split: "held_out",
    subject_type: "workflow", subject_id: "w", subject_version: 1 };
  const aggregate = aggregateEvaluation(run, [{ id: "t2", case_id: "b" }, { id: "t1", case_id: "a" }], [
    { verdict: "passed", scores: { quality: 1, ignored: "x" }, costs: { tokens: 10 } },
    { verdict: "failed", failure_type: "", scores: { quality: 0 }, costs: { tokens: 20, ignored: Infinity } },
  ]);
  assert.deepEqual(aggregate.case_ids, ["a", "b"]);
  assert.equal(aggregate.pass_rate, 0.5);
  assert.deepEqual(aggregate.scores.quality, { count: 2, mean: 0.5, min: 0, max: 1 });
  assert.deepEqual(aggregate.costs.tokens, { count: 2, mean: 15, min: 10, max: 20, sum: 30 });
  assert.deepEqual(aggregate.failure_types, { unspecified: 1 });

  const shaped = (passRate: number, score: JsonObject, costs: JsonObject,
    failureTypes: JsonObject = {}, verdictCounts: JsonObject = {}): EvaluationAggregate => ({
    pass_rate: passRate, scores: score, costs, failure_types: failureTypes, verdict_counts: verdictCounts,
  });
  const improved = compareEvaluationAggregates(shaped(0.5, { q: { mean: 0.5 }, added: { mean: 1 } },
    { latency: { mean: 20 } }, { old: 1 }, { failed: 1 }), shaped(1, { q: { mean: 1 }, missing: { mean: 1 } },
    { latency: { mean: 10 } }, { fixed: 1 }, { passed: 2 }));
  assert.equal(improved.assessment, "improved");
  assert.equal((improved.scores as JsonObject).added instanceof Object, true);
  assert.equal(((improved.scores as JsonObject).added as JsonObject).delta, null);
  const regressed = compareEvaluationAggregates(shaped(1, {}, {}), shaped(0, {}, {}));
  assert.equal(regressed.assessment, "regressed");
  const mixed = compareEvaluationAggregates(shaped(0, {}, { tokens: { mean: 1 } }),
    shaped(1, {}, { tokens: { mean: 2 } }));
  assert.equal(mixed.assessment, "mixed");
  const equal = compareEvaluationAggregates(shaped(1, {}, {}), shaped(1, {}, {}));
  assert.equal(equal.assessment, "equivalent");
});

test("evaluation comparisons enforce a common benchmark and support every subject kind", async () => {
  const root = join(tmpdir(), `craft-comparison-${process.pid}-${Date.now()}`);
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  try {
    const task = (service.taskOpen({ title: "Compare", goal: "Compare versions" }).task as JsonObject);
    const suite = service.evaluationSuiteSave({ suite_id: "suite", name: "Benchmark", cases: [
      { case_id: "a", split: "held_out" }, { case_id: "b", split: "held_out" },
      { case_id: "dev", split: "development" },
    ] });
    const makeSubject = (kind: string, subjectId: string): JsonObject => kind === "workflow"
      ? service.workflowSave({ workflow_id: subjectId, name: subjectId })
      : service.saveVersioned(kind, kind === "agent_profile" ? "profile" : "configuration", {
        [kind === "agent_profile" ? "profile_id" : "configuration_id"]: subjectId,
        name: subjectId, ...(kind === "agent_profile" ? { role: "worker", host: "local", model: "m" }
          : { dimensions: {} }),
      }, ["name"]);
    const makeRun = (runId: string, kind: string, subject: JsonObject, cases = ["a", "b"],
      split = "held_out", suiteId = "suite", suiteVersion?: number): JsonObject => {
      const trialIds = cases.map((caseId, index) => {
        const trial = service.trialStart({ task_id: task.id, case_id: caseId, subject_type: kind,
          subject_id: subject.id, subject_version: subject.version });
        service.outcomeRecord({ trial_id: trial.id, verdict: index ? "passed" : "failed",
          failure_type: index ? undefined : "tool_error", summary: "done",
          scores: { quality: index }, costs: { tokens: 20 - index * 10, duration_ms: 100 - index * 10 } });
        return trial.id;
      });
      return service.evaluationRunRecord({ run_id: runId, suite_id: suiteId, suite_version: suiteVersion,
        split, subject_type: kind, subject_id: subject.id, subject_version: subject.version, trial_ids: trialIds });
    };
    const base = makeRun("base", "workflow", makeSubject("workflow", "w1"));
    const candidate = makeRun("candidate", "workflow", makeSubject("workflow", "w2"));
    const aggregate = service.evaluationRunAggregate({ run_id: base.id });
    assert.equal(aggregate.total, 2);
    assert.deepEqual(aggregate.failure_types, { tool_error: 1 });
    const comparison = service.evaluationCompare({ comparison_id: "comparison", baseline_run_id: base.id,
      candidate_run_id: candidate.id });
    assert.equal((comparison.comparison as JsonObject).assessment, "equivalent");
    assert.equal((service.info().counts as JsonObject).evaluation_comparison, 1);
    assert.throws(() => service.evaluationCompare({ baseline_run_id: base.id, candidate_run_id: base.id }), /different runs/);

    for (const kind of ["agent_profile", "harness_configuration"]) {
      const left = makeRun(`${kind}_left`, kind, makeSubject(kind, `${kind}_left`));
      const right = makeRun(`${kind}_right`, kind, makeSubject(kind, `${kind}_right`));
      assert.equal((service.evaluationCompare({ baseline_run_id: left.id,
        candidate_run_id: right.id }).comparison as JsonObject).assessment, "equivalent");
    }

    const differentCases = makeRun("different_cases", "workflow", makeSubject("workflow", "w3"), ["a"]);
    assert.throws(() => service.evaluationCompare({ baseline_run_id: base.id,
      candidate_run_id: differentCases.id }), /case_ids differ/);
    const otherSuite = service.evaluationSuiteSave({ suite_id: "other_suite", name: "Other", cases: [
      { case_id: "a", split: "held_out" }, { case_id: "b", split: "held_out" },
    ] });
    const otherSuiteRun = makeRun("other_suite_run", "workflow", makeSubject("workflow", "w4"),
      ["a", "b"], "held_out", String(otherSuite.id));
    assert.throws(() => service.evaluationCompare({ baseline_run_id: base.id,
      candidate_run_id: otherSuiteRun.id }), /suite_id differs/);
    const suiteV2 = service.evaluationSuiteSave({ suite_id: "suite", name: "Benchmark v2", cases: [
      { case_id: "a", split: "held_out" }, { case_id: "b", split: "held_out" },
    ] });
    const versionRun = makeRun("version_run", "workflow", makeSubject("workflow", "w5"),
      ["a", "b"], "held_out", "suite", Number(suiteV2.version));
    assert.throws(() => service.evaluationCompare({ baseline_run_id: base.id,
      candidate_run_id: versionRun.id }), /suite_version differs/);
    const devRun = makeRun("dev_run", "workflow", makeSubject("workflow", "w6"), ["dev"], "development",
      "suite", Number(suite.version));
    assert.throws(() => service.evaluationCompare({ baseline_run_id: differentCases.id,
      candidate_run_id: devRun.id }), /split differs/);
    const profileRun = makeRun("profile_mismatch", "agent_profile", makeSubject("agent_profile", "profile_mismatch"),
      ["a", "b"], "held_out", "suite", Number(suite.version));
    assert.throws(() => service.evaluationCompare({ baseline_run_id: base.id,
      candidate_run_id: profileRun.id }), /subject_type differs/);
    const invalidFailure = service.trialStart({ task_id: task.id, case_id: "a", subject_type: "workflow",
      subject_id: base.subject_id, subject_version: base.subject_version });
    assert.throws(() => service.outcomeRecord({ trial_id: invalidFailure.id, verdict: "failed", summary: "x",
      failure_type: "" }), /failure_type must not be empty/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});


test("paired sign probabilities remain finite at scale and agree with exact small cases", () => {
  assert.equal(pairedSignTestProbability(0, 0), 1);
  assert.equal(pairedSignTestProbability(0, 5), 1);
  assert(Math.abs(pairedSignTestProbability(5, 0) - 1 / 32) < 1e-14);
  assert(Math.abs(pairedSignTestProbability(2, 2) - 11 / 16) < 1e-14);
  const balanced = pairedSignTestProbability(5000, 5000);
  assert(Number.isFinite(balanced) && balanced > 0.5 && balanced < 0.51);
  assert.equal(pairedSignTestProbability(10000, 0), 0);
  for (const invalid of [-1, 0.5, Infinity, NaN]) assert.throws(() => pairedSignTestProbability(invalid, 1), /safe integers/);
});

test("legacy comparisons with unmatched repeated trials remain inconclusive and cannot qualify for promotion", async () => {
  const root = join(tmpdir(), `craft-unpaired-${process.pid}-${Date.now()}`);
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const service = new CraftService(store);
    const task = service.taskOpen({ title: "Paired evaluation", goal: "Reject unmatched trials" }).task as JsonObject;
    const workflow = service.workflowSave({ workflow_id: "paired", name: "Paired" });
    const suite = service.evaluationSuiteSave({ suite_id: "paired", name: "Paired", cases: [{ case_id: "a", split: "held_out" }, { case_id: "b", split: "held_out" }] });
    const run = (name: string, cases: string[]) => {
      const trialIds = cases.map((case_id, index) => {
        const trial = service.trialStart({ trial_id: `${name}-${index}`, task_id: task.id, case_id, subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version, environment: {}, budget: {} });
        service.outcomeRecord({ trial_id: trial.id, verdict: "passed", summary: "Fixture passed" });
        return trial.id;
      });
      return service.evaluationRunRecord({ run_id: name, suite_id: suite.id, split: "held_out", subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version, trial_ids: trialIds });
    };
    const baseline = run("baseline", ["a", "a", "b"]), candidate = run("candidate", ["a", "b", "b"]);
    for (const [base, next] of [[baseline, candidate], [candidate, baseline]]) {
      assert.throws(() => service.evaluationCompare({ baseline_run_id: base!.id, candidate_run_id: next!.id }), /case_ids differ/);
      const comparison = store.create("evaluation_comparison", `legacy-${base!.id}`, { baseline_run_id: base!.id, candidate_run_id: next!.id, split: "held_out",
        baseline: service.evaluationRunAggregate({ run_id: base!.id }), candidate: service.evaluationRunAggregate({ run_id: next!.id }) });
      assert.equal(service.evaluationReliabilityAssess({ comparison_id: comparison.id, min_trials: 2 }).status, "inconclusive");
      const promotion = service.evaluationPromotionAssess({ comparison_id: comparison.id, min_trials: 2 });
      assert.equal(promotion.eligible, false);
      const paired = (promotion.promotion as JsonObject).paired as JsonObject;
      assert.equal(paired.matched_trials, 2);
      assert.equal(paired.unmatched_baseline_trials, 1);
      assert.equal(paired.unmatched_candidate_trials, 1);
    }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
