import type { JsonObject } from "./store.ts";

export type EvaluationAggregate = JsonObject & {
  pass_rate: number;
  scores: JsonObject;
  costs: JsonObject;
  failure_types: JsonObject;
};

function numericValues(records: JsonObject[], field: "scores" | "costs"): Map<string, number[]> {
  const values = new Map<string, number[]>();
  for (const record of records) {
    const metrics = record[field] as JsonObject;
    for (const [name, value] of Object.entries(metrics)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      values.set(name, [...(values.get(name) ?? []), value]);
    }
  }
  return values;
}

function summarize(records: JsonObject[], field: "scores" | "costs", includeSum: boolean): JsonObject {
  return Object.fromEntries([...numericValues(records, field)].sort(([left], [right]) => left.localeCompare(right))
    .map(([name, values]) => {
      const sum = values.reduce((total, value) => total + value, 0);
      return [name, { count: values.length, mean: sum / values.length,
        min: Math.min(...values), max: Math.max(...values), ...(includeSum ? { sum } : {}) }];
    }));
}

export function aggregateEvaluation(run: JsonObject, trials: JsonObject[], outcomes: JsonObject[]): EvaluationAggregate {
  const verdictCounts: Record<string, number> = {};
  const failureTypes: Record<string, number> = {};
  for (const outcome of outcomes) {
    const verdict = String(outcome.verdict);
    verdictCounts[verdict] = (verdictCounts[verdict] ?? 0) + 1;
    if (verdict !== "passed") {
      const failureType = typeof outcome.failure_type === "string" && outcome.failure_type
        ? outcome.failure_type : "unspecified";
      failureTypes[failureType] = (failureTypes[failureType] ?? 0) + 1;
    }
  }
  return {
    evaluation_run_id: run.id,
    suite_id: run.suite_id,
    suite_version: run.suite_version,
    split: run.split,
    subject_type: run.subject_type,
    subject_id: run.subject_id,
    subject_version: run.subject_version,
    trial_ids: trials.map((trial) => trial.id),
    case_ids: trials.map((trial) => trial.case_id).sort(),
    total: outcomes.length,
    verdict_counts: verdictCounts,
    pass_rate: outcomes.filter((outcome) => outcome.verdict === "passed").length / outcomes.length,
    scores: summarize(outcomes, "scores", false),
    costs: summarize(outcomes, "costs", true),
    failure_types: failureTypes,
  };
}

function metricDeltas(baseline: JsonObject, candidate: JsonObject): JsonObject {
  const names = [...new Set([...Object.keys(baseline), ...Object.keys(candidate)])].sort();
  return Object.fromEntries(names.map((name) => {
    const baselineMean = (baseline[name] as JsonObject | undefined)?.mean;
    const candidateMean = (candidate[name] as JsonObject | undefined)?.mean;
    return [name, { baseline: baselineMean ?? null, candidate: candidateMean ?? null,
      delta: typeof baselineMean === "number" && typeof candidateMean === "number"
        ? candidateMean - baselineMean : null }];
  }));
}

function countDeltas(baseline: JsonObject, candidate: JsonObject): JsonObject {
  const names = [...new Set([...Object.keys(baseline), ...Object.keys(candidate)])].sort();
  return Object.fromEntries(names.map((name) => {
    const baselineCount = Number(baseline[name] ?? 0);
    const candidateCount = Number(candidate[name] ?? 0);
    return [name, { baseline: baselineCount, candidate: candidateCount, delta: candidateCount - baselineCount }];
  }));
}

export function compareEvaluationAggregates(baseline: EvaluationAggregate,
  candidate: EvaluationAggregate): JsonObject {
  const scores = metricDeltas(baseline.scores, candidate.scores);
  const costs = metricDeltas(baseline.costs, candidate.costs);
  const signals = [candidate.pass_rate - baseline.pass_rate,
    ...Object.values(scores).map((item) => (item as JsonObject).delta).filter((value): value is number => typeof value === "number"),
    ...Object.values(costs).map((item) => (item as JsonObject).delta).filter((value): value is number => typeof value === "number")
      .map((value) => -value)];
  const improved = signals.some((value) => value > 0);
  const regressed = signals.some((value) => value < 0);
  const assessment = improved && regressed ? "mixed" : improved ? "improved" : regressed ? "regressed" : "equivalent";
  return {
    pass_rate: { baseline: baseline.pass_rate, candidate: candidate.pass_rate,
      delta: candidate.pass_rate - baseline.pass_rate },
    scores,
    costs,
    verdict_counts: countDeltas(baseline.verdict_counts as JsonObject, candidate.verdict_counts as JsonObject),
    failure_types: countDeltas(baseline.failure_types, candidate.failure_types),
    assessment,
  };
}
