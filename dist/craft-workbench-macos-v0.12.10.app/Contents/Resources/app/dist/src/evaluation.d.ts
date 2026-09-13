import type { JsonObject } from "./store.ts";
export type EvaluationAggregate = JsonObject & {
    pass_rate: number;
    scores: JsonObject;
    costs: JsonObject;
    failure_types: JsonObject;
};
export declare function aggregateEvaluation(run: JsonObject, trials: JsonObject[], outcomes: JsonObject[]): EvaluationAggregate;
export declare function compareEvaluationAggregates(baseline: EvaluationAggregate, candidate: EvaluationAggregate): JsonObject;
