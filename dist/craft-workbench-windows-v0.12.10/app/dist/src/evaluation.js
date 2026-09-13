function numericValues(records, field) {
    const values = new Map();
    for (const record of records) {
        const metrics = record[field];
        for (const [name, value] of Object.entries(metrics)) {
            if (typeof value !== "number" || !Number.isFinite(value))
                continue;
            values.set(name, [...(values.get(name) ?? []), value]);
        }
    }
    return values;
}
function summarize(records, field, includeSum) {
    return Object.fromEntries([...numericValues(records, field)].sort(([left], [right]) => left.localeCompare(right))
        .map(([name, values]) => {
        const sum = values.reduce((total, value) => total + value, 0);
        return [name, { count: values.length, mean: sum / values.length,
                min: Math.min(...values), max: Math.max(...values), ...(includeSum ? { sum } : {}) }];
    }));
}
export function aggregateEvaluation(run, trials, outcomes) {
    const verdictCounts = {};
    const failureTypes = {};
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
function metricDeltas(baseline, candidate) {
    const names = [...new Set([...Object.keys(baseline), ...Object.keys(candidate)])].sort();
    return Object.fromEntries(names.map((name) => {
        const baselineMean = baseline[name]?.mean;
        const candidateMean = candidate[name]?.mean;
        return [name, { baseline: baselineMean ?? null, candidate: candidateMean ?? null,
                delta: typeof baselineMean === "number" && typeof candidateMean === "number"
                    ? candidateMean - baselineMean : null }];
    }));
}
function countDeltas(baseline, candidate) {
    const names = [...new Set([...Object.keys(baseline), ...Object.keys(candidate)])].sort();
    return Object.fromEntries(names.map((name) => {
        const baselineCount = Number(baseline[name] ?? 0);
        const candidateCount = Number(candidate[name] ?? 0);
        return [name, { baseline: baselineCount, candidate: candidateCount, delta: candidateCount - baselineCount }];
    }));
}
export function compareEvaluationAggregates(baseline, candidate) {
    const scores = metricDeltas(baseline.scores, candidate.scores);
    const costs = metricDeltas(baseline.costs, candidate.costs);
    const signals = [candidate.pass_rate - baseline.pass_rate,
        ...Object.values(scores).map((item) => item.delta).filter((value) => typeof value === "number"),
        ...Object.values(costs).map((item) => item.delta).filter((value) => typeof value === "number")
            .map((value) => -value)];
    const improved = signals.some((value) => value > 0);
    const regressed = signals.some((value) => value < 0);
    const assessment = improved && regressed ? "mixed" : improved ? "improved" : regressed ? "regressed" : "equivalent";
    return {
        pass_rate: { baseline: baseline.pass_rate, candidate: candidate.pass_rate,
            delta: candidate.pass_rate - baseline.pass_rate },
        scores,
        costs,
        verdict_counts: countDeltas(baseline.verdict_counts, candidate.verdict_counts),
        failure_types: countDeltas(baseline.failure_types, candidate.failure_types),
        assessment,
    };
}
//# sourceMappingURL=evaluation.js.map