export type ImpactSetScore = {
  readonly expected_nodes: readonly string[];
  readonly observed_nodes: readonly string[];
  readonly true_positives: number;
  readonly false_positives: number;
  readonly false_negatives: number;
  readonly precision: number;
  readonly recall: number;
};

export type ImpactCaseScore = ImpactSetScore & {
  readonly target_found: boolean;
  readonly truncated: boolean;
};

export function scoreImpactSet(expectedNodes: readonly string[], observedNodes: readonly string[]): ImpactSetScore {
  const expected = new Set(expectedNodes);
  const observed = new Set(observedNodes);
  const truePositives = [...observed].filter(node => expected.has(node)).length;
  const falsePositives = observed.size - truePositives;
  const falseNegatives = expected.size - truePositives;
  const precision = observed.size === 0 ? (expected.size === 0 ? 1 : 0) : truePositives / observed.size;
  const recall = expected.size === 0 ? (observed.size === 0 ? 1 : 0) : truePositives / expected.size;
  return {
    expected_nodes: [...expected].sort(),
    observed_nodes: [...observed].sort(),
    true_positives: truePositives,
    false_positives: falsePositives,
    false_negatives: falseNegatives,
    precision,
    recall,
  };
}

export function summarizeImpactCases(rows: readonly ImpactCaseScore[]) {
  const truePositives = rows.reduce((sum, row) => sum + row.true_positives, 0);
  const falsePositives = rows.reduce((sum, row) => sum + row.false_positives, 0);
  const falseNegatives = rows.reduce((sum, row) => sum + row.false_negatives, 0);
  const precision = falsePositives + truePositives === 0 ? (falseNegatives === 0 ? 1 : 0) : truePositives / (truePositives + falsePositives);
  const recall = falseNegatives + truePositives === 0 ? (falsePositives === 0 ? 1 : 0) : truePositives / (truePositives + falseNegatives);
  return {
    case_count: rows.length,
    target_found_count: rows.filter(row => row.target_found).length,
    truncated_case_count: rows.filter(row => row.truncated).length,
    true_positives: truePositives,
    false_positives: falsePositives,
    false_negatives: falseNegatives,
    precision,
    recall,
  };
}
