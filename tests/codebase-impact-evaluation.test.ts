import assert from "node:assert/strict";
import test from "node:test";
import { scoreImpactSet, summarizeImpactCases } from "../scripts/eval/codebase-impact-evaluation.ts";

test("impact set scoring reports exact matches, extra nodes, and missing nodes", () => {
  assert.deepEqual(scoreImpactSet(["a", "b"], ["a", "c"]), {
    expected_nodes: ["a", "b"], observed_nodes: ["a", "c"], true_positives: 1,
    false_positives: 1, false_negatives: 1, precision: 0.5, recall: 0.5,
  });
  assert.equal(scoreImpactSet(["a"], ["a", "a"]).precision, 1);
  assert.deepEqual(scoreImpactSet([], []), {
    expected_nodes: [], observed_nodes: [], true_positives: 0, false_positives: 0,
    false_negatives: 0, precision: 1, recall: 1,
  });
  assert.equal(scoreImpactSet(["a"], []).precision, 0);
  assert.equal(scoreImpactSet([], ["a"]).recall, 0);
});

test("impact case summary aggregates quality and reports missing targets and truncation", () => {
  const first = { ...scoreImpactSet(["a", "b"], ["a"]), target_found: true, truncated: false };
  const second = { ...scoreImpactSet(["c"], ["c", "extra"]), target_found: false, truncated: true };
  assert.deepEqual(summarizeImpactCases([first, second]), {
    case_count: 2, target_found_count: 1, truncated_case_count: 1, true_positives: 2,
    false_positives: 1, false_negatives: 1, precision: 2 / 3, recall: 2 / 3,
  });
  assert.deepEqual(summarizeImpactCases([]), {
    case_count: 0, target_found_count: 0, truncated_case_count: 0, true_positives: 0,
    false_positives: 0, false_negatives: 0, precision: 1, recall: 1,
  });
  assert.equal(summarizeImpactCases([{ ...scoreImpactSet(["missing"], []), target_found: true, truncated: false }]).precision, 0);
  assert.equal(summarizeImpactCases([{ ...scoreImpactSet([], ["unexpected"]), target_found: true, truncated: false }]).recall, 0);
});
