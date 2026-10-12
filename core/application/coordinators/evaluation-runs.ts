import { createHash, randomUUID } from "node:crypto";
import type { CraftStore, JsonObject } from "../../infrastructure/store.ts";
import { aggregateEvaluation, compareEvaluationAggregates, pairedSignTestProbability, type EvaluationAggregate } from "../../evaluation.ts";
import { payload as recordPayload, stableDigest } from "../../digest.ts";
import { array, finiteInteger, object, text } from "../../validation.ts";

const EVAL_SPLITS = new Set(["search", "development", "held_out"]);
const id = (prefix: string): string => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const fingerprint = (value: JsonObject): string => stableDigest(value).slice("sha256:".length);

function metricMean(aggregate: JsonObject, metric: string): number | null {
  const summary = (aggregate.costs as JsonObject)[metric] as JsonObject | undefined;
  return typeof summary?.mean === "number" && Number.isFinite(summary.mean) ? summary.mean : null;
}

/** Keeps repeated-trial collection, comparison and promotion assessment together. */
export class EvaluationRunCoordinator {
  readonly store: CraftStore;
  readonly workflowTrialRun: (args: JsonObject) => JsonObject;
  readonly gradeRecord: (args: JsonObject) => JsonObject;
  constructor(store: CraftStore, workflowTrialRun: (args: JsonObject) => JsonObject, gradeRecord: (args: JsonObject) => JsonObject) {
    this.store = store; this.workflowTrialRun = workflowTrialRun; this.gradeRecord = gradeRecord;
  }

  evaluationRunRecord(args: JsonObject): JsonObject {
    const suite = this.store.get("evaluation_suite", text(args.suite_id, "suite_id"),
      args.suite_version === undefined ? undefined : finiteInteger(args.suite_version, "suite_version", 1));
    const split = String(args.split);
    if (!EVAL_SPLITS.has(split)) throw new Error(`Unsupported evaluation split: ${split}`);
    const subjectType = text(args.subject_type, "subject_type");
    const subjectId = text(args.subject_id, "subject_id");
    const subjectVersion = finiteInteger(args.subject_version, "subject_version", 1);
    this.store.get(subjectType, subjectId, subjectVersion);
    const trialIds = array(args.trial_ids, "trial_ids").map((value) => text(value, "trial_id"));
    if (!trialIds.length || new Set(trialIds).size !== trialIds.length) {
      throw new Error("trial_ids must contain unique trials");
    }
    const cases = array(suite.cases ?? [], "suite cases") as JsonObject[];
    const allowedCases = new Set(cases.filter((item) => item.split === split).map((item) => String(item.case_id)));
    const outcomes = trialIds.map((trialId) => {
      const trial = this.store.get("trial", trialId);
      if (trial.subject_type !== subjectType || trial.subject_id !== subjectId ||
          Number(trial.subject_version) !== subjectVersion) throw new Error(`Trial subject mismatch: ${trialId}`);
      if (!trial.case_id || !allowedCases.has(String(trial.case_id))) {
        throw new Error(`Trial case is not in the ${split} suite partition: ${trialId}`);
      }
      const outcome = this.store.find("outcome", `outcome_${trialId}`);
      if (!outcome) throw new Error(`Trial has no outcome: ${trialId}`);
      return outcome;
    });
    const verdict = outcomes.every((outcome) => outcome.verdict === "passed") ? "passed" : "failed";
    return this.store.create("evaluation_run", String(args.run_id ?? id("evalrun")), {
      suite_id: suite.id, suite_version: suite.version, split, subject_type: subjectType,
      subject_id: subjectId, subject_version: subjectVersion, trial_ids: trialIds, verdict,
      metrics: object(args.metrics ?? {}, "metrics"),
    });
  }

  evaluationRunAggregate(args: JsonObject): JsonObject {
    const run = this.store.get("evaluation_run", text(args.run_id, "run_id"));
    const trials = (run.trial_ids as string[]).map((trialId) => this.store.get("trial", trialId));
    const outcomes = trials.map((trial) => this.store.get("outcome", `outcome_${trial.id}`));
    return aggregateEvaluation(run, trials, outcomes);
  }

  evaluationCompare(args: JsonObject): JsonObject {
    const baselineId = text(args.baseline_run_id, "baseline_run_id");
    const candidateId = text(args.candidate_run_id, "candidate_run_id");
    if (baselineId === candidateId) throw new Error("Evaluation comparison requires two different runs");
    const baseline = this.evaluationRunAggregate({ run_id: baselineId }) as EvaluationAggregate;
    const candidate = this.evaluationRunAggregate({ run_id: candidateId }) as EvaluationAggregate;
    for (const field of ["suite_id", "suite_version", "split", "subject_type"] as const) {
      if (baseline[field] !== candidate[field]) throw new Error(`Evaluation runs are not comparable: ${field} differs`);
    }
    if (JSON.stringify(baseline.case_ids) !== JSON.stringify(candidate.case_ids)) {
      throw new Error("Evaluation runs are not comparable: case_ids differ");
    }
    return this.store.create("evaluation_comparison", String(args.comparison_id ?? id("comparison")), {
      baseline_run_id: baselineId, candidate_run_id: candidateId,
      suite_id: baseline.suite_id, suite_version: baseline.suite_version, split: baseline.split,
      subject_type: baseline.subject_type, case_ids: baseline.case_ids,
      baseline, candidate, comparison: compareEvaluationAggregates(baseline, candidate),
    });
  }

  evaluationRunnerRun(args: JsonObject): JsonObject {
    const taskId = text(args.task_id, "task_id");
    this.store.get("task", taskId);
    const suite = this.store.get("evaluation_suite", text(args.suite_id, "suite_id"),
      args.suite_version === undefined ? undefined : finiteInteger(args.suite_version, "suite_version", 1));
    const split = text(args.split, "split");
    if (!EVAL_SPLITS.has(split)) throw new Error(`Unsupported evaluation split: ${split}`);
    const projectRoot = text(args.project_root, "project_root");
    const trialsPerCase = finiteInteger(args.trials_per_case, "trials_per_case", 1, 1, 20);
    const subjects = array(args.subjects, "subjects").map((raw, index) => {
      const subject = object(raw, `subjects[${index}]`);
      if (text(subject.subject_type, `subjects[${index}].subject_type`) !== "workflow") {
        throw new Error("Automatic Eval Runner currently executes only workflow subjects; Agent subjects require a Host runtime operation");
      }
      const subjectId = text(subject.subject_id, `subjects[${index}].subject_id`);
      const subjectVersion = finiteInteger(subject.subject_version, `subjects[${index}].subject_version`, 1);
      this.store.get("workflow", subjectId, subjectVersion);
      return { label: text(subject.label, `subjects[${index}].label`), subject_id: subjectId, subject_version: subjectVersion };
    });
    if (subjects.length < 2 || new Set(subjects.map((subject) => subject.label)).size !== subjects.length) {
      throw new Error("Eval Runner requires at least two uniquely labelled subjects");
    }
    const cases = (suite.cases as JsonObject[]).filter((item) => item.split === split);
    if (!cases.length) throw new Error(`Evaluation Suite has no ${split} cases`);
    const runner = this.store.create("evaluation_runner", String(args.runner_id ?? id("eval_runner")), { task_id: taskId,
      suite_id: suite.id, suite_version: suite.version, split, trials_per_case: trialsPerCase, status: "running",
      subjects, environment_fingerprint: fingerprint(object(args.environment ?? {}, "environment")) });
    const evaluationRuns = subjects.map((subject) => {
      const trialIds: string[] = [];
      for (const item of cases) for (let attempt = 1; attempt <= trialsPerCase; attempt += 1) {
        const trial = this.workflowTrialRun({ trial_id: id("trial"), task_id: taskId, workflow_id: subject.subject_id,
          version: subject.subject_version, case_id: item.case_id, project_root: projectRoot,
          inputs: object(item.inputs ?? {}, "case inputs"), environment: args.environment ?? {}, budget: args.budget ?? {} });
        trialIds.push(String((trial.trial as JsonObject).id));
      }
      return this.evaluationRunRecord({ suite_id: suite.id, suite_version: suite.version, split, subject_type: "workflow",
        subject_id: subject.subject_id, subject_version: subject.subject_version, trial_ids: trialIds });
    });
    const comparisons = evaluationRuns.slice(1).map((candidate, index) => this.evaluationCompare({
      baseline_run_id: evaluationRuns[0].id, candidate_run_id: candidate.id,
      comparison_id: `${runner.id}_${index + 1}` }));
    const completed = this.store.save("evaluation_runner", String(runner.id), { ...recordPayload(runner), status: "completed",
      evaluation_run_ids: evaluationRuns.map((run) => run.id), comparison_ids: comparisons.map((comparison) => comparison.id) });
    return { runner: completed, evaluation_runs: evaluationRuns, comparisons, comparison: comparisons[0].comparison,
      aggregate: { baseline_trials: (evaluationRuns[0].trial_ids as string[]).length,
        candidate_trials: (evaluationRuns[1].trial_ids as string[]).length, cases: cases.length, trials_per_case: trialsPerCase } };
  }

  evaluationProgramGrade(args: JsonObject): JsonObject {
    const evaluation = this.store.get("evaluation_run", text(args.evaluation_run_id, "evaluation_run_id"));
    const grader = this.store.get("grader", text(args.grader_id, "grader_id"),
      args.grader_version === undefined ? undefined : finiteInteger(args.grader_version, "grader_version", 1));
    if (grader.grader_type !== "program") throw new Error("Automatic evaluation grading requires a program grader");
    const configuration = object(grader.configuration, "grader configuration");
    const minimumPassRate = configuration.minimum_pass_rate === undefined ? 1 : Number(configuration.minimum_pass_rate);
    const maximumDuration = configuration.maximum_mean_duration_ms === undefined ? Number.POSITIVE_INFINITY
      : Number(configuration.maximum_mean_duration_ms);
    if (!Number.isFinite(minimumPassRate) || minimumPassRate < 0 || minimumPassRate > 1 ||
      (!Number.isFinite(maximumDuration) && maximumDuration !== Number.POSITIVE_INFINITY) || maximumDuration < 0) {
      throw new Error("Program grader configuration is invalid");
    }
    const aggregate = this.evaluationRunAggregate({ run_id: evaluation.id });
    const duration = (aggregate.costs as JsonObject).duration_ms as JsonObject | undefined;
    const passed = Number(aggregate.pass_rate) >= minimumPassRate && (duration?.mean === undefined || Number(duration.mean) <= maximumDuration);
    const grades = (evaluation.trial_ids as string[]).map((trialId) => {
      const gradeId = `grade_${createHash("sha256").update(JSON.stringify([trialId, grader.id, grader.version])).digest("hex")}`;
      const existing = this.store.find("grade", gradeId);
      if (existing) return existing;
      const outcome = this.store.get("outcome", `outcome_${trialId}`);
      return this.gradeRecord({ trial_id: trialId, grader_id: grader.id, grader_version: grader.version,
        verdict: passed ? "passed" : "failed", score: Number(aggregate.pass_rate),
        summary: `Program grader evaluated evaluation run ${evaluation.id}.`, evidence_ids: outcome.evidence_ids,
        metadata: { evaluation_run_id: evaluation.id, pass_rate: aggregate.pass_rate, minimum_pass_rate: minimumPassRate,
          maximum_mean_duration_ms: maximumDuration } });
    });
    return { grades, passed, aggregate };
  }

  private evaluationPairedComparison(baselineRun: JsonObject, candidateRun: JsonObject): JsonObject {
    const indexed = (run: JsonObject) => {
      const occurrences = new Map<string, number>();
      return new Map((run.trial_ids as string[]).map((trialId) => {
        const trial = this.store.get("trial", trialId); const caseId = String(trial.case_id);
        const occurrence = (occurrences.get(caseId) ?? 0) + 1; occurrences.set(caseId, occurrence);
        return [`${caseId}:${occurrence}`, this.store.get("outcome", `outcome_${trialId}`)];
      }));
    };
    const baseline = indexed(baselineRun); const candidate = indexed(candidateRun);
    let candidateWins = 0; let baselineWins = 0; let ties = 0;
    for (const [key, baselineOutcome] of baseline) {
      const candidateOutcome = candidate.get(key);
      if (!candidateOutcome) continue;
      const baselinePassed = baselineOutcome.verdict === "passed"; const candidatePassed = candidateOutcome.verdict === "passed";
      if (candidatePassed && !baselinePassed) candidateWins += 1;
      else if (baselinePassed && !candidatePassed) baselineWins += 1;
      else ties += 1;
    }
    return { matched_trials: candidateWins + baselineWins + ties, candidate_wins: candidateWins,
      baseline_wins: baselineWins, ties, unmatched_baseline_trials: baseline.size - (candidateWins + baselineWins + ties),
      unmatched_candidate_trials: candidate.size - (candidateWins + baselineWins + ties) };
  }

  evaluationPromotionAssess(args: JsonObject): JsonObject {
    const comparison = this.store.get("evaluation_comparison", text(args.comparison_id, "comparison_id"));
    const baselineRun = this.store.get("evaluation_run", String(comparison.baseline_run_id));
    const candidateRun = this.store.get("evaluation_run", String(comparison.candidate_run_id));
    const minTrials = finiteInteger(args.min_trials, "min_trials", 2, 1, 10_000);
    const minimumDelta = args.min_pass_rate_delta === undefined ? 0 : Number(args.min_pass_rate_delta);
    const maximumCostRatio = args.max_cost_regression_ratio === undefined ? Number.POSITIVE_INFINITY : Number(args.max_cost_regression_ratio);
    const maximumDurationRatio = args.max_duration_regression_ratio === undefined ? Number.POSITIVE_INFINITY : Number(args.max_duration_regression_ratio);
    const costMetric = args.cost_metric === undefined ? "tokens" : text(args.cost_metric, "cost_metric");
    if (!Number.isFinite(minimumDelta) || minimumDelta < -1 || minimumDelta > 1 ||
      (!Number.isFinite(maximumCostRatio) && maximumCostRatio !== Number.POSITIVE_INFINITY) || maximumCostRatio < 0 ||
      (!Number.isFinite(maximumDurationRatio) && maximumDurationRatio !== Number.POSITIVE_INFINITY) || maximumDurationRatio < 0) {
      throw new Error("Promotion thresholds are invalid");
    }
    const baseline = comparison.baseline as JsonObject; const candidate = comparison.candidate as JsonObject;
    const paired = this.evaluationPairedComparison(baselineRun, candidateRun);
    const baselineCost = metricMean(baseline, costMetric); const candidateCost = metricMean(candidate, costMetric);
    const baselineDuration = metricMean(baseline, "duration_ms"); const candidateDuration = metricMean(candidate, "duration_ms");
    const costRatio = baselineCost === null || candidateCost === null ? null : candidateCost / Math.max(1, baselineCost);
    const durationRatio = baselineDuration === null || candidateDuration === null ? null : candidateDuration / Math.max(1, baselineDuration);
    const checks = [
      { check: "held_out", passed: comparison.split === "held_out" },
      { check: "minimum_trials", passed: Number(baseline.total) >= minTrials && Number(candidate.total) >= minTrials },
      { check: "pass_rate", passed: Number(candidate.pass_rate) - Number(baseline.pass_rate) >= minimumDelta },
      { check: "cost_regression", passed: maximumCostRatio === Number.POSITIVE_INFINITY || (costRatio !== null && costRatio <= maximumCostRatio) },
      { check: "duration_regression", passed: maximumDurationRatio === Number.POSITIVE_INFINITY || (durationRatio !== null && durationRatio <= maximumDurationRatio) },
      { check: "paired_cases", passed: Number(paired.matched_trials) >= minTrials
        && paired.unmatched_baseline_trials === 0 && paired.unmatched_candidate_trials === 0 },
    ];
    const eligible = checks.every((check) => check.passed);
    const promotion = this.store.create("evaluation_promotion", String(args.promotion_id ?? id("promotion")), {
      comparison_id: comparison.id, baseline_run_id: baselineRun.id, candidate_run_id: candidateRun.id, eligible, checks,
      paired, thresholds: { min_trials: minTrials, min_pass_rate_delta: minimumDelta, cost_metric: costMetric,
        max_cost_regression_ratio: maximumCostRatio, max_duration_regression_ratio: maximumDurationRatio },
    });
    return { eligible, promotion, comparison: { ...comparison, paired, cost_metric: costMetric,
      cost_regression_ratio: costRatio, duration_regression_ratio: durationRatio } };
  }

  evaluationReliabilityAssess(args: JsonObject): JsonObject {
    const comparison = this.store.get("evaluation_comparison", text(args.comparison_id, "comparison_id"));
    const baselineRun = this.store.get("evaluation_run", String(comparison.baseline_run_id)); const candidateRun = this.store.get("evaluation_run", String(comparison.candidate_run_id));
    const minTrials = finiteInteger(args.min_trials, "min_trials", 20, 2, 10_000); const maxBudgetRatio = Number(args.max_budget_ratio ?? 1);
    if (!Number.isFinite(maxBudgetRatio) || maxBudgetRatio < 0) throw new Error("max_budget_ratio must be non-negative");
    const paired = this.evaluationPairedComparison(baselineRun, candidateRun);
    const baselineTrials = (baselineRun.trial_ids as string[]).map((trialId) => this.store.get("trial", trialId));
    const candidateTrials = (candidateRun.trial_ids as string[]).map((trialId) => this.store.get("trial", trialId));
    const baselineEnvironment = object(baselineTrials[0].environment, "baseline environment");
    const environmentsMatch = [...baselineTrials, ...candidateTrials].every((trial) => fingerprint(object(trial.environment, "trial environment")) === fingerprint(baselineEnvironment));
    const budgetsMatch = [...baselineTrials, ...candidateTrials].every((trial) => {
      const baselineBudget = object(baselineTrials[0].budget, "baseline budget"); const ratio = Number(Object.entries(object(trial.budget, "trial budget")).every(([key, value]) => Number(value) <= Number(baselineBudget[key]) * maxBudgetRatio));
      return ratio === 1;
    });
    const pValue = pairedSignTestProbability(Number(paired.candidate_wins), Number(paired.baseline_wins));
    const completePairs = paired.unmatched_baseline_trials === 0 && paired.unmatched_candidate_trials === 0;
    const status = Number(paired.matched_trials) < minTrials || !completePairs || !environmentsMatch || !budgetsMatch ? "inconclusive"
      : pValue <= 0.05 && Number(paired.candidate_wins) > Number(paired.baseline_wins) ? "eligible" : "rejected";
    const assessment = this.store.create("evaluation_reliability", String(args.assessment_id ?? id("reliability")), { comparison_id: comparison.id, status, min_trials: minTrials, max_budget_ratio: maxBudgetRatio, paired, p_value: pValue, environments_match: environmentsMatch, budgets_match: budgetsMatch });
    return { status, assessment };
  }

}
