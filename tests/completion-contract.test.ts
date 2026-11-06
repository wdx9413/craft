import test from "node:test";
import assert from "node:assert/strict";
import { COMPLETION_CASES, COMPLETION_DATASET_DIGEST, completionPrompt, gradeCompletion, compareCompletion } from "../scripts/eval/completion-contract.ts";
const good = { decisions: COMPLETION_CASES.map(item => ({ id: item.id, ...item.expected })) };
const runs = () => Array.from({ length: 3 }, (_, trial) => ["baseline", "candidate"].map(arm => ({ trial, arm, host: "fixture", model: "fixed", budget: "fixed", dataset_digest: COMPLETION_DATASET_DIGEST, output: good }))).flat();

test("completion grader distinguishes acceptance, terminal files, cancellation and unknown effects", () => {
  assert.equal(gradeCompletion(good).passed, 8);
  for (const item of COMPLETION_CASES) {
    const wrong = { decisions: good.decisions.map(d => d.id === item.id ? { ...d, outcome: "invented" } : d) };
    assert.deepEqual(gradeCompletion(wrong).failures, [item.id]);
  }
  for (const answer of [null, undefined, {}, { decisions: [] }, { decisions: Array(8).fill(null) }, { decisions: Array(8).fill(good.decisions[0]) }]) assert.equal(gradeCompletion(answer).status, "invalid");
  assert.equal(gradeCompletion({ decisions: [...good.decisions.slice(1), null] }).status, "failed");
  assert.match(completionPrompt(true), /原任务/); assert(!completionPrompt(false).includes('expected'));
  assert.equal(compareCompletion(runs()).verdict, "no_measured_gain");
  const wrong = { decisions: good.decisions.map(d => ({ ...d, outcome: "wrong" })) };
  const baselineBad = runs().map(r => ({ ...r, output: r.arm === 'baseline' ? wrong : good }));
  assert.equal(compareCompletion(baselineBad).verdict, "improved_on_fixture");
  assert.equal(compareCompletion(runs().map(r => ({ ...r, output: r.arm === 'candidate' ? wrong : good }))).verdict, "regressed");
  assert.equal(compareCompletion(runs().map(r => ({ ...r, output: { decisions: [] } }))).verdict, "inconclusive");
  assert.equal(compareCompletion(runs()).promotion_eligible, false);
  assert.equal(compareCompletion(runs().map(r => ({ ...r, output: undefined }))).verdict, "inconclusive");
  for (const input of [[], runs().slice(1), [...runs(), ...runs()], runs().map(r => ({ ...r, arm: 'other' })), runs().map(r => ({ ...r, trial: -1 })), runs().map(r => ({ ...r, trial: 0.5 })), runs().map((r, i) => ({ ...r, trial: i })), runs().map((r, i) => ({ ...r, model: i ? 'fixed' : 'changed' })), runs().map(r => ({ ...r, host: '' })), runs().map(r => ({ ...r, model: '' })), runs().map(r => ({ ...r, budget: '' })), runs().map(r => ({ ...r, dataset_digest: 'bad' })), Array(202).fill(runs()[0])]) assert.throws(() => compareCompletion(input));
});
