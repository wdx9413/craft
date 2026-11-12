import assert from "node:assert/strict";
import test from "node:test";
import { compareRunReports, type RunReport } from "craft-eval/compare-run-reports";
import { LEDGER_MIN_OBSERVATIONS } from "../core/eval-suite.ts";

const identity = {
  schema: "craft-eval-run-report.v1",
  provider: "local-openai", base_url: "http://127.0.0.1:3425/v1", model: "group/free",
  api_key_env: "OPENAI_API_KEY", suite_id: "craft.subcapabilities", suite_version: "1",
  suite_digest: `sha256:${"a".repeat(64)}`,
};

const ledger = (name: string, passed: number, observed: number) => ({
  ledger: name, score: observed ? `${passed}/${observed}` : null, observed, passed,
  failed: observed - passed, inconclusive: 0, minimum_observations: LEDGER_MIN_OBSERVATIONS[name as keyof typeof LEDGER_MIN_OBSERVATIONS],
  sufficient_evidence: observed >= LEDGER_MIN_OBSERVATIONS[name as keyof typeof LEDGER_MIN_OBSERVATIONS],
  axes: [], model_observations: 0,
});

function report(overrides: Partial<RunReport> = {}): RunReport {
  return {
    ...identity,
    quotable: true, quotable_reason: "every ledger cleared its declared minimum",
    ledgers: [ledger("capability", 18, 18), ledger("safety", 1, 1), ledger("value", 6, 6)],
    model_observations: 9, prompted_turns: 19, minimum_observations: LEDGER_MIN_OBSERVATIONS,
    results: [
      { case_id: "memory.decay_orders_recent_first", verdict: "passed", reason: "" },
      { case_id: "context_supply.supplied_context_replaces_explanation", verdict: "passed", reason: "" },
      { case_id: "governance.pinned_prohibition_survives", verdict: "passed", reason: "" },
    ],
    ...overrides,
  };
}

test("identical runs are comparable with zero deltas", () => {
  const result = compareRunReports(report(), report());
  assert.equal(result.comparable, true);
  assert.equal(result.regressions.length, 0);
  assert.equal(result.improvements.length, 0);
  assert.equal(result.ledgers.length, 3);
  assert.deepEqual(result.ledgers.map((item) => item.passedDelta), [0, 0, 0]);
  assert.equal(result.identity.provider, "local-openai");
});

test("a different gateway or model is refused rather than compared", () => {
  for (const patch of [
    { base_url: "http://other/v1" }, { model: "other-model" },
    { provider: "other-provider" },
  ]) {
    const result = compareRunReports(report(), report(patch));
    assert.equal(result.comparable, false, JSON.stringify(patch));
    assert.match(result.reason, /run identity differs/u);
    assert.deepEqual(result.ledgers, []);
  }
});

test("an evolved suite stays comparable and still detects regressions", () => {
  // The suite gained a held-out axis, so the digest changed by design. The
  // comparison must not go silent: shared cases still grade regressions, and
  // the digest delta is reported as evolution metadata.
  const evolved = report({ suite_digest: `sha256:${"b".repeat(64)}`,
    results: [
      { case_id: "memory.decay_orders_recent_first", verdict: "failed", reason: "stale" },
      { case_id: "context_supply.supplied_context_replaces_explanation", verdict: "passed", reason: "" },
      { case_id: "governance.pinned_prohibition_survives", verdict: "passed", reason: "" },
      { case_id: "knowledge_lineage.refutation_flags_derived_claims", verdict: "passed", reason: "" },
    ],
  });
  const result = compareRunReports(report(), evolved);
  assert.equal(result.comparable, true);
  assert.equal(result.suite_evolution, true);
  assert.deepEqual(result.suite_digest_delta, { baseline: `sha256:${"a".repeat(64)}`, candidate: `sha256:${"b".repeat(64)}` });
  assert.match(result.reason, /suite evolved/u);
  assert.deepEqual(result.regressions, ["memory.decay_orders_recent_first: passed -> failed"]);
  assert.deepEqual(result.newCases, ["knowledge_lineage.refutation_flags_derived_claims"]);
  assert.equal(result.ledgers.length, 3);
});

test("same-suite runs report no evolution and a null digest delta", () => {
  const result = compareRunReports(report(), report());
  assert.equal(result.suite_evolution, false);
  assert.equal(result.suite_digest_delta, null);
  assert.match(result.reason, /same suite/u);
});

test("a passing case that fails in the candidate is a regression", () => {
  const result = compareRunReports(report(), report({
    ledgers: [ledger("capability", 17, 18), ledger("safety", 1, 1), ledger("value", 6, 6)],
    results: [
      { case_id: "memory.decay_orders_recent_first", verdict: "failed", reason: "stale" },
      { case_id: "context_supply.supplied_context_replaces_explanation", verdict: "passed", reason: "" },
      { case_id: "governance.pinned_prohibition_survives", verdict: "passed", reason: "" },
    ],
  }));
  assert.deepEqual(result.regressions, ["memory.decay_orders_recent_first: passed -> failed"]);
  assert.equal(result.ledgers[0]!.passedDelta, -1);
  assert.equal(result.ledgers[0]!.baseline, "18/18");
  assert.equal(result.ledgers[0]!.candidate, "17/18");
});

test("an inconclusive case becoming observed counts as an improvement", () => {
  const result = compareRunReports(report({
    results: [
      { case_id: "memory.decay_orders_recent_first", verdict: "passed", reason: "" },
      { case_id: "governance.pinned_prohibition_survives", verdict: "inconclusive", reason: "endpoint unreachable" },
    ],
    ledgers: [ledger("capability", 18, 18), ledger("safety", 0, 0), ledger("value", 6, 6)],
  }), report());
  assert.deepEqual(result.improvements, ["governance.pinned_prohibition_survives: inconclusive -> passed"]);
  assert.equal(result.ledgers[1]!.passedDelta, 1);
  assert.equal(result.ledgers[1]!.baseline, null);
  assert.equal(result.ledgers[1]!.candidate, "1/1");
});

test("new and removed cases are reported without being mislabelled as regressions", () => {
  const result = compareRunReports(report(), report({
    results: [
      { case_id: "context_supply.supplied_context_replaces_explanation", verdict: "passed", reason: "" },
      { case_id: "context_supply.memory_hit_replaces_repetition", verdict: "passed", reason: "" },
    ],
  }));
  assert.deepEqual(result.removedCases, ["memory.decay_orders_recent_first", "governance.pinned_prohibition_survives"]);
  assert.deepEqual(result.newCases, ["context_supply.memory_hit_replaces_repetition"]);
  assert.equal(result.regressions.length, 0);
});

test("a malformed or wrong-schema artifact is rejected at the trust boundary", () => {
  assert.throws(() => compareRunReports(null, report()), /not a report object/u);
  assert.throws(() => compareRunReports(report({ schema: "other.v9" }), report()), /unsupported report schema/u);
  assert.throws(() => compareRunReports(report(), report({ provider: "" })), /missing run identity field/u);
});

test("isolation level is part of run identity when declared", () => {
  const shared = () => report({ isolation: "shared_local_store_scoped" });
  const isolated = () => report({ isolation: "per_trial_clean_environment" });
  assert.equal(compareRunReports(shared(), shared()).comparable, true);
  const mismatch = compareRunReports(shared(), isolated());
  assert.equal(mismatch.comparable, false);
  assert.match(mismatch.reason, /isolation/u);
  // Legacy reports without the field remain comparable with each other.
  assert.equal(compareRunReports(report(), report()).comparable, true);
  // A legacy report and a declared-isolation report are not the same run shape.
  assert.equal(compareRunReports(report(), shared()).comparable, false);
});

test("a minimal report with missing optional fields fails closed to zero, never invents a score", () => {
  // Legacy/partial artifacts omit ledgers, results and result verdicts. Every
  // absent field must degrade to a neutral value rather than throwing or being
  // counted as a pass.
  const minimal = (): RunReport => ({
    schema: "craft-eval-run-report.v1", provider: "local-openai",
    base_url: "http://127.0.0.1:3425/v1", model: "group/free",
    suite_digest: `sha256:${"a".repeat(64)}`,
    results: [{ case_id: "a" }, { case_id: "b", verdict: "passed" }],
  });
  const result = compareRunReports(minimal(), minimal());
  assert.equal(result.comparable, true);
  assert.equal(result.ledgers.every((item) => item.baseline === null && item.candidate === null), true);
  assert.equal(result.ledgers.every((item) => item.baselineObserved === 0 && item.candidatePassed === 0), true);
  assert.equal(result.regressions.length, 0);
  const noResults = (): RunReport => {
    const value = minimal();
    delete value.results;
    return value;
  };
  const empty = compareRunReports(noResults(), noResults());
  assert.equal(empty.comparable, true);
  assert.equal(empty.regressions.length, 0);
  assert.equal(empty.newCases.length, 0);
});
