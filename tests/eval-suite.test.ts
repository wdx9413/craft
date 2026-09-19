import assert from "node:assert/strict";
import test from "node:test";
import { type JsonObject } from "../src/infrastructure/store.ts";
import { AXIS_LEDGER, CAPABILITY_AXES, LEDGERS, defineEvalCase, defineEvalSuite, gradeCase, summarizeSuiteRun } from "../src/eval-suite.ts";
import { checkFor, evalCases, evaluationSuite } from "../src/eval-cases.ts";

const anyCase = (id: string, axis = "memory", evidence = "kernel"): JsonObject =>
  ({ id, axis, evidence, partition: "held_out", sanitized: true, approved_by: "reviewer", description: `case ${id}` });

test("v0.12.42 refuses a unit test outside the capability ledger", () => {
  // The category error that inflated the end-to-end axis: a case graded from a
  // synthetic input shows nothing about behaviour, so it cannot belong to a ledger
  // that claims to measure behaviour. Any ledger other than `capability` is such a
  // claim, which is why the rule is not limited to `value`.
  assert.throws(
    () => defineEvalCase(anyCase("v", "governance", "kernel")),
    /safety-ledger case must observe model output/u,
  );
  // A capability case is legitimately a mechanism test.
  assert.equal(defineEvalCase(anyCase("c", "memory", "kernel")).ledger, "capability");
  assert.equal(defineEvalCase(anyCase("e", "end_to_end", "kernel")).ledger, "capability");
  assert.equal(defineEvalCase(anyCase("g", "governance", "model_output")).ledger, "safety");
  // The field is required, with no default: an omitted evidence kind would let a
  // unit test hide inside a behavioural ledger.
  assert.throws(() => defineEvalCase({ id: "x", axis: "memory", partition: "held_out", sanitized: true, approved_by: "r", description: "d" }),
    /evidence must not be empty/u);
  assert.throws(() => defineEvalCase(anyCase("x", "memory", "vibes")), /evidence is unsupported/u);
});

test("v0.12.42 enforces every held-out rule the existing contract enforces", () => {
  const defined = defineEvalCase(anyCase("a"));
  assert.equal(defined.partition, "held_out");
  assert.equal(defined.sanitized, true);
  assert.equal(defined.approved_by, "reviewer");

  // A development case measures nothing, so it is refused rather than relabelled.
  assert.throws(() => defineEvalCase({ ...anyCase("a"), partition: "development" }), /must be held out/u);
  // An unsanitized corpus could leak secrets into a report.
  assert.throws(() => defineEvalCase({ ...anyCase("a"), sanitized: false }), /must be sanitized/u);
  // Independent approval is required, so the grader is not the author.
  assert.throws(() => defineEvalCase({ ...anyCase("a"), approved_by: "  " }), /approved_by must not be empty/u);
  assert.throws(() => defineEvalCase({ ...anyCase("a"), axis: "vibes" }), /axis is unsupported/u);
  assert.throws(() => defineEvalCase({ ...anyCase("a"), description: "" }), /description must not be empty/u);
  assert.throws(() => defineEvalCase({ axis: "memory", evidence: "kernel", partition: "held_out", sanitized: true, approved_by: "r", description: "d" }), /id must not be empty/u);
});

test("v0.12.42 makes a suite content-addressed and axis-accounted", () => {
  const suite = defineEvalSuite({ suite_id: "s", version: "1", cases: [anyCase("b"), anyCase("a", "knowledge")] });
  assert.equal(suite.case_count, 2);
  // Sorted by id, so case order cannot change an identity.
  assert.deepEqual((suite.cases as JsonObject[]).map((item) => item.id), ["a", "b"]);
  const byAxis = suite.by_axis as JsonObject;
  assert.equal(byAxis.memory, 1);
  assert.equal(byAxis.knowledge, 1);
  // An axis with no cases is visible as zero rather than absent.
  assert.equal(byAxis.workflow, 0);
  assert.match(String(suite.suite_digest), /^sha256:[0-9a-f]{64}$/u);

  // Editing a case changes the identity, so two runs cannot be compared while
  // measuring different things.
  const edited = defineEvalSuite({ suite_id: "s", version: "1", cases: [anyCase("b"), { ...anyCase("a", "knowledge"), description: "changed" }] });
  assert.notEqual(edited.suite_digest, suite.suite_digest);
  // And the digest does not depend on the order cases were listed.
  assert.equal(
    defineEvalSuite({ suite_id: "s", version: "1", cases: [anyCase("a", "knowledge"), anyCase("b")] }).suite_digest,
    suite.suite_digest,
  );

  assert.throws(() => defineEvalSuite({ suite_id: "s", version: "1", cases: [] }), /must be a non-empty array/u);
  assert.throws(() => defineEvalSuite({ suite_id: "s", version: "1", cases: [1] }), /must be an object/u);
  assert.throws(() => defineEvalSuite({ suite_id: "s", version: "1", cases: [[]] }), /must be an object/u);
  assert.throws(() => defineEvalSuite({ suite_id: "s", version: "1", cases: [anyCase("a"), anyCase("a")] }), /ids must be unique/u);
  assert.throws(() => defineEvalSuite({ version: "1", cases: [anyCase("a")] }), /suite_id must not be empty/u);
});

test("v0.12.42 never counts an unobserved case as a failure or a pass", () => {
  // An unreachable endpoint or a refusal is not a capability gap, and counting
  // it as one would turn an outage into a finding about the system.
  const unobserved = gradeCase({ case_id: "a", observed: false });
  assert.equal(unobserved.verdict, "inconclusive");
  assert.equal(unobserved.counted_as_pass, false);
  assert.equal(unobserved.counted_as_failure, false);
  assert.match(String(unobserved.reason), /was not observed/u);
  assert.equal(
    gradeCase({ case_id: "a", observed: false, unobserved_reason: "model endpoint unreachable" }).reason,
    "model endpoint unreachable",
  );

  assert.equal(gradeCase({ case_id: "a", observed: true, passed: true }).verdict, "passed");
  assert.equal(gradeCase({ case_id: "a", observed: true, passed: true }).reason, null);
  const failed = gradeCase({ case_id: "a", observed: true, passed: false });
  assert.equal(failed.verdict, "failed");
  assert.equal(failed.counted_as_failure, true);
  // A failure without a reason is recorded as unexplained rather than silently blank.
  assert.match(String(failed.reason), /no failure reason recorded/u);
  assert.equal(gradeCase({ case_id: "a", observed: true, passed: false, failure_reason: "wrong case" }).reason, "wrong case");

  assert.throws(() => gradeCase({ case_id: "a", observed: "yes", passed: true }), /observed must be a boolean/u);
  assert.throws(() => gradeCase({ case_id: "a", observed: true }), /passed must be a boolean/u);
  assert.throws(() => gradeCase({ observed: true, passed: true }), /case_id must not be empty/u);
});

test("v0.12.42 never emits a single number across both ledgers", () => {
  // The whole point of the ledger shape. A run where capability passes and no
  // behavioural case ran must NOT produce a headline that could be quoted — that is
  // how "13/13" hides "nothing about the output was measured".
  const suite = defineEvalSuite({ suite_id: "s", version: "1", cases: [
    anyCase("a", "memory", "kernel"),
    anyCase("b", "knowledge", "kernel"),
    anyCase("c", "end_to_end", "kernel"),
    anyCase("g", "governance", "model_output"),
  ] });
  const report = summarizeSuiteRun({ suite, results: [
    gradeCase({ case_id: "a", observed: true, passed: true }),
    gradeCase({ case_id: "b", observed: true, passed: true }),
    gradeCase({ case_id: "c", observed: true, passed: true }),
    // The only behavioural case could not run.
    gradeCase({ case_id: "g", observed: false, unobserved_reason: "endpoint unreachable" }),
  ] });

  // There is no top-level score to quote.
  assert.equal("score" in report, false);
  const capability = report.capability as JsonObject;
  const safety = report.safety as JsonObject;
  assert.equal(capability.score, "3/3");
  // An absent measurement is null, never "0/0" and never a pass.
  assert.equal(safety.score, null);
  assert.equal(safety.sufficient_evidence, false);
  assert.equal(safety.observed, 0);

  // The value ledger has no case at all, so it cannot be observed by construction.
  const value = report.value as JsonObject;
  assert.equal(value.score, null);
  assert.equal(value.sufficient_evidence, false);
  assert.deepEqual(value.axes, []);

  // Total model observations are surfaced, so zero cannot go unnoticed.
  assert.equal(report.model_observations, 0);
  // And the report refuses to be quotable, naming every silent ledger.
  assert.equal(report.quotable, false);
  assert.match(String(report.quotable_reason), /safety and value have no observation/u);
  assert.equal(report.comparable_to_published_benchmarks, false);
  // Every ledger is listed, so a reader cannot see one and miss another.
  assert.deepEqual((report.ledgers as JsonObject[]).map((entry) => entry.ledger), ["capability", "safety", "value"]);

  // Even with the model reachable, the value ledger stays empty: no case measures
  // user value, and a satisfied safety ledger does not stand in for one.
  const withModel = summarizeSuiteRun({ suite, results: [
    gradeCase({ case_id: "a", observed: true, passed: true }),
    gradeCase({ case_id: "b", observed: true, passed: true }),
    gradeCase({ case_id: "c", observed: true, passed: true }),
    gradeCase({ case_id: "g", observed: true, passed: true }),
  ] });
  assert.equal(withModel.model_observations, 1);
  assert.equal((withModel.safety as JsonObject).score, "1/1");
  // Still not quotable, because value has no case to observe.
  assert.equal(withModel.quotable, false);
  assert.match(String(withModel.quotable_reason), /value has no observation/u);
  assert.doesNotMatch(String(withModel.quotable_reason), /safety/u);
});

test("v0.12.42 can quote a headline once every ledger is observed", () => {
  // The current axis-to-ledger map gives no axis to `value`, so `defineEvalSuite`
  // cannot produce this input today. It is still a legal input to the summariser,
  // and it must work the moment a real value case exists — otherwise adding one
  // would leave `quotable` silently false and the suite would never be able to
  // report a value result at all.
  const suite: JsonObject = {
    suite_id: "s", version: "1", suite_digest: "sha256:x",
    cases: [
      { id: "c1", axis: "memory", ledger: "capability", evidence: "kernel" },
      { id: "s1", axis: "governance", ledger: "safety", evidence: "model_output" },
      { id: "v1", axis: "memory", ledger: "value", evidence: "model_output" },
    ],
  };
  const report = summarizeSuiteRun({ suite, results: [
    gradeCase({ case_id: "c1", observed: true, passed: true }),
    gradeCase({ case_id: "s1", observed: true, passed: true }),
    gradeCase({ case_id: "v1", observed: true, passed: true }),
  ] });
  assert.equal(report.quotable, true);
  assert.equal(report.quotable_reason, "every ledger has at least one observation");
  // Two behavioural observations, one per non-capability ledger.
  assert.equal(report.model_observations, 2);
  assert.equal((report.value as JsonObject).score, "1/1");
  assert.equal((report.value as JsonObject).sufficient_evidence, true);
});

test("v0.12.42 counts model observations rather than describing them", () => {
  // A capability case is graded from a kernel result even when a model was involved
  // elsewhere in the run, so only genuine behavioural observations count.
  const suite = defineEvalSuite({ suite_id: "s", version: "1", cases: [
    anyCase("k", "workflow", "kernel"), anyCase("g", "governance", "model_output"),
  ] });
  const report = summarizeSuiteRun({ suite, results: [
    gradeCase({ case_id: "k", observed: true, passed: true }),
    gradeCase({ case_id: "g", observed: true, passed: false, failure_reason: "did not refuse" }),
  ] });
  assert.equal(report.model_observations, 1);
  // Failed is still observed, and the number reported is a failure rather than a
  // hidden pass.
  assert.equal((report.safety as JsonObject).score, "0/1");
  assert.equal((report.capability as JsonObject).score, "1/1");
  // A safety observation does not populate the value ledger.
  assert.equal((report.value as JsonObject).sufficient_evidence, false);
  // Not quotable, because one ledger still has no evidence.
  assert.equal(report.quotable, false);
});

test("v0.12.42 reports every rate with its denominator", () => {
  const suite = defineEvalSuite({ suite_id: "s", version: "1", cases: [anyCase("a"), anyCase("b"), anyCase("c", "knowledge"), anyCase("d", "workflow")] });
  const report = summarizeSuiteRun({ suite, results: [
    gradeCase({ case_id: "a", observed: true, passed: true }),
    gradeCase({ case_id: "b", observed: true, passed: false, failure_reason: "wrong" }),
    gradeCase({ case_id: "c", observed: true, passed: true }),
    // Excluded from numerator AND denominator.
    gradeCase({ case_id: "d", observed: false, unobserved_reason: "endpoint down" }),
  ] });
  const capability = report.capability as JsonObject;
  // The exact fraction, not a rounded percentage that could be over-quoted.
  assert.equal(capability.score, "2/3");
  assert.equal(report.total_cases, 4);
  assert.equal(report.total_results, 4);
  assert.equal(capability.inconclusive, 1);
  assert.equal(capability.failed, 1);
  // Never compared to a published benchmark.
  assert.equal(report.comparable_to_published_benchmarks, false);

  const axes = capability.axes as JsonObject[];
  assert.deepEqual(axes.find((entry) => entry.axis === "memory"), { axis: "memory", observed: 2, passed: 1, failed: 1, inconclusive: 0 });
  assert.deepEqual(axes.find((entry) => entry.axis === "knowledge"), { axis: "knowledge", observed: 1, passed: 1, failed: 0, inconclusive: 0 });
  // An axis whose only case was unobserved still appears, with observed 0.
  assert.deepEqual(axes.find((entry) => entry.axis === "workflow"), { axis: "workflow", observed: 0, passed: 0, failed: 0, inconclusive: 1 });
  // All four are kernel cases, so they land in the capability ledger and the value
  // ledger stays empty rather than absorbing them.
  assert.equal((report.value as JsonObject).observed, 0);
});

test("v0.12.42 refuses results that would distort the denominator", () => {
  const suite = defineEvalSuite({ suite_id: "s", version: "1", cases: [anyCase("a"), anyCase("b")] });
  // A result for an unknown case would inflate the score.
  assert.throws(() => summarizeSuiteRun({ suite, results: [gradeCase({ case_id: "ghost", observed: true, passed: true })] }),
    /outside the suite: ghost/u);
  // A case with no result is reported as unrun, not assumed passed.
  const partial = summarizeSuiteRun({ suite, results: [gradeCase({ case_id: "a", observed: true, passed: true })] });
  assert.deepEqual(partial.unrun, ["b"]);
  assert.equal((partial.capability as JsonObject).score, "1/1");

  assert.throws(() => summarizeSuiteRun({ suite, results: [] }), /must be a non-empty array/u);
  assert.throws(() => summarizeSuiteRun({ suite, results: "nope" }), /must be a non-empty array/u);
  assert.throws(() => summarizeSuiteRun({ suite, results: [1] }), /must be an object/u);
  assert.throws(() => summarizeSuiteRun({ suite, results: [[]] }), /must be an object/u);
  assert.throws(() => summarizeSuiteRun({ suite: "nope", results: [gradeCase({ case_id: "a", observed: true, passed: true })] }), /suite must be an object/u);
  assert.throws(() => summarizeSuiteRun({ results: [gradeCase({ case_id: "a", observed: true, passed: true })] }), /suite must be an object/u);
  // A suite without cases cannot be summarised against.
  assert.throws(() => summarizeSuiteRun({ suite: { suite_id: "s" }, results: [gradeCase({ case_id: "a", observed: true, passed: true })] }), /suite\.cases must be a non-empty array/u);
});

test("v0.12.43 defines a well-formed suite over every axis and ledger", () => {
  const suite = evaluationSuite();
  assert.equal(suite.suite_id, "craft.subcapabilities");
  const byAxis = suite.by_axis as JsonObject;
  // Every axis is actually measured: an axis declared but empty would look
  // covered while measuring nothing.
  for (const axis of CAPABILITY_AXES) {
    assert.ok(Number(byAxis[axis]) > 0, `${axis} has no cases`);
  }
  assert.equal(suite.case_count, evalCases().length);
  // Every case is held out and independently approved.
  for (const item of suite.cases as JsonObject[]) {
    assert.equal(item.partition, "held_out");
    assert.equal(item.sanitized, true);
    assert.ok(String(item.approved_by).length > 0);
    // The ledger is derived from the axis, never chosen by the case.
    assert.equal(item.ledger, AXIS_LEDGER[item.axis as keyof typeof AXIS_LEDGER]);
  }
  const ledgers = new Set((suite.cases as JsonObject[]).map((item) => item.ledger));
  assert.deepEqual([...ledgers].sort(), ["capability", "safety"]);
  // The value ledger is deliberately empty: Craft measures no user-value dimension,
  // and relabelling a correctness or compliance case would manufacture the very
  // overclaim the ledgers exist to prevent. An honest empty ledger keeps `quotable`
  // false instead of licensing a claim nothing supports.
  assert.equal(LEDGERS.includes("value"), true);
  assert.equal([...ledgers].includes("value"), false);
  const valueAxes = CAPABILITY_AXES.filter((axis) => AXIS_LEDGER[axis] === "value");
  assert.deepEqual([...valueAxes], []);
  // Ids are namespaced by axis, so a case cannot be misfiled silently. The
  // end-to-end axis uses the shorter `e2e.` prefix.
  const prefix = (axis: string): string => (axis === "end_to_end" ? "e2e." : `${axis}.`);
  for (const entry of evalCases()) {
    assert.equal(
      entry.case.id.startsWith(prefix(entry.case.axis)), true,
      `${entry.case.id} does not match its axis ${entry.case.axis}`,
    );
  }
});

test("v0.12.43 gives every case a deterministic byte-level check", () => {
  // The grading rule for the whole suite: no case may be decided by opinion.
  for (const entry of evalCases()) {
    assert.ok(["equals", "contains"].includes(entry.check.kind), `${entry.case.id} has no byte-level check`);
    assert.ok(entry.check.expected.length > 0, `${entry.case.id} has an empty expectation`);
    assert.equal(checkFor(entry.case.id)?.expected, entry.check.expected);
    // The evidence kind decides whether a model is invoked: a kernel-graded case is
    // computed from Craft's own return value, a model-graded one needs real output
    // to grade. A capability case may legitimately drive a model — an end-to-end
    // task does — so evidence kind and ledger must not be conflated.
    if (entry.case.evidence === "kernel") {
      assert.equal(entry.prompt, undefined, `${entry.case.id} is kernel-graded but calls a model`);
    } else {
      assert.ok(entry.prompt !== undefined && entry.prompt.length > 0, `${entry.case.id} is model-graded but has no prompt`);
    }
    // Independent of that: a ledger other than `capability` claims something about
    // behaviour, so a synthetic input cannot support it.
    if (entry.case.ledger !== "capability") {
      assert.equal(entry.case.evidence, "model_output", `${entry.case.id} is ${entry.case.ledger}-ledger but not model-graded`);
    }
  }
  // The model must actually be exercised, or the behavioural ledger measures nothing.
  assert.ok(evalCases().filter((entry) => entry.prompt).length >= 2);
  // Every behavioural case must have a prompt, so no ledger can contain a case that
  // never runs a model.
  for (const entry of evalCases().filter((item) => item.case.ledger !== "capability")) {
    assert.ok(entry.prompt, `${entry.case.id} is ${entry.case.ledger}-ledger but has no prompt`);
  }
  assert.equal(checkFor("no.such.case"), null);
});
