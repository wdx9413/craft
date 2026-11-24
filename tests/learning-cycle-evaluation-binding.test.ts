import assert from "node:assert/strict";
import test from "node:test";
import { isCompletePassingControlledReport, normalizeLearningEvaluationBinding } from "../core/learning-cycle-evaluation-binding.ts";

const binding = () => ({ host: "codex", task_id: "task-1", turn_id: "turn-1", context_receipt_id: "receipt-1", session_id: "session-1",
  host_evidence_id: "evidence-host-1", verification_ref: "test-run:unit" });

test("learning evaluation binding keeps bounded, sanitized task identity and optional paths", () => {
  const result = normalizeLearningEvaluationBinding({ ...binding(), session_id: " session-1 ", project_root: "/tmp/project",
    observed_paths: [" src/a.ts ", "src/a.ts", " README.md "], scenario_context: {
      task_goal: "Fix parser", effect_summary: "Parser tests pass", sanitized: true, content_stored: false, extra: "discarded",
    }, extra: "discarded" });
  assert.deepEqual(result, { ...binding(), session_id: "session-1", project_root: "/tmp/project",
    observed_paths: ["src/a.ts", "README.md"], scenario_context: { task_goal: "Fix parser", effect_summary: "Parser tests pass", sanitized: true, content_stored: false } });
});

test("learning evaluation binding rejects malformed identity, optional fields, paths and context", () => {
  for (const value of [null, [], "text"]) assert.throws(() => normalizeLearningEvaluationBinding(value), /must be an object/u);
  for (const key of ["host", "task_id", "turn_id", "context_receipt_id", "session_id", "host_evidence_id", "verification_ref"]) {
    for (const bad of [undefined, "", "x\n", "x".repeat(257)]) assert.throws(() => normalizeLearningEvaluationBinding({ ...binding(), [key]: bad }), new RegExp(`learning_binding\\.${key}`));
  }
  for (const bad of ["Codex", "1codex"]) assert.throws(() => normalizeLearningEvaluationBinding({ ...binding(), host: bad }), /host is invalid/u);
  for (const key of ["project_root"]) {
    for (const bad of ["", "x\0", "x".repeat(1025), 1]) assert.throws(() => normalizeLearningEvaluationBinding({ ...binding(), [key]: bad }), new RegExp(`learning_binding\\.${key}`));
  }
  for (const paths of ["src/a.ts", Array(65).fill("a"), [""], ["x".repeat(513)], ["bad\npath"]]) {
    assert.throws(() => normalizeLearningEvaluationBinding({ ...binding(), observed_paths: paths }), /observed_paths/u);
  }
  for (const context of [null, [], { task_goal: "x", effect_summary: "y", sanitized: false, content_stored: false },
    { task_goal: "", effect_summary: "y", sanitized: true, content_stored: false },
    { task_goal: "x".repeat(321), effect_summary: "y", sanitized: true, content_stored: false },
    { task_goal: "x\ny", effect_summary: "y", sanitized: true, content_stored: false },
    { task_goal: "api_key=abcdefgh12345678", effect_summary: "y", sanitized: true, content_stored: false },
    { task_goal: "x", effect_summary: "password:abcdefgh12345678", sanitized: true, content_stored: false }]) {
    assert.throws(() => normalizeLearningEvaluationBinding({ ...binding(), scenario_context: context }), /scenario_context/u);
  }
  assert.throws(() => normalizeLearningEvaluationBinding({ ...binding(), verification_ref: "api_key=abcdefgh12345678" }), /learning_binding\./u);
  for (const key of ["task_id", "turn_id", "context_receipt_id", "session_id", "host_evidence_id", "verification_ref"]) {
    assert.throws(() => normalizeLearningEvaluationBinding({ ...binding(), [key]: "token=abcdefgh12345678" }), /learning_binding\./u);
  }
  assert.throws(() => normalizeLearningEvaluationBinding({ ...binding(), project_root: "/tmp/token=abcdefgh12345678" }), /project_root/u);
  assert.throws(() => normalizeLearningEvaluationBinding({ ...binding(), observed_paths: ["src/token=abcdefgh12345678"] }), /observed_paths/u);
  assert.deepEqual(normalizeLearningEvaluationBinding({ ...binding(), observed_paths: [] }).observed_paths, []);
});

test("only complete, fully recorded, all-passing controlled reports qualify", () => {
  const good = { status: "complete", expected: 2, recorded: 2, passed: 2, failed: 0, inconclusive: 0, invalid: 0, missing: 0,
    not_applicable: 0, results: [{ verdict: "passed" }, { verdict: "passed" }] };
  assert.equal(isCompletePassingControlledReport(good), true);
  for (const value of [null, [], { ...good, status: "incomplete" }, { ...good, expected: 0 }, { ...good, expected: 1.5 },
    { ...good, recorded: 1 }, { ...good, passed: 1 }, { ...good, failed: 1 }, { ...good, inconclusive: 1 },
    { ...good, invalid: 1 }, { ...good, missing: 1 }, { ...good, not_applicable: 1 }, { ...good, results: [] },
    { ...good, results: [{ verdict: "passed" }, { verdict: "failed" }] }, { ...good, results: [{ verdict: "passed" }, null] }]) {
    assert.equal(isCompletePassingControlledReport(value), false);
  }
});
