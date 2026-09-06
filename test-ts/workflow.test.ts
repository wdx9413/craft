import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { approvedEffects, executeSteps, normalizeSteps, redact, resolveInputs, runStep, safePath,
  substitute } from "../src/workflow.ts";

test("workflow inputs, substitution, paths, redaction, and policies are deterministic", () => {
  assert.deepEqual(resolveInputs([{ name: "a", default: 1 }, { name: "b", required: true }], { b: 2 }), { a: 1, b: 2 });
  assert.throws(() => resolveInputs([{ name: "" }], {}), /non-empty/);
  assert.throws(() => resolveInputs([{ name: "x", required: true }], {}), /Missing/);
  assert.deepEqual(substitute(["{{x}}", { v: "hello {{ x }}" }, 3], { x: "world" }), ["world", { v: "hello world" }, 3]);
  assert.throws(() => substitute("{{missing}}", {}), /Unknown/);
  assert.throws(() => substitute("x {{missing}}", {}), /Unknown/);
  assert.equal(safePath(process.cwd()), process.cwd());
  assert.throws(() => safePath(process.cwd(), "../escape"), /escapes/);
  assert.equal(redact("token=abcd value SECRET", ["SECRET", "xx"]), "token=[REDACTED] value [REDACTED]");
  assert.deepEqual(normalizeSteps([{ type: "command" }, { id: "read", type: "assertion" }]).map((x) => x.side_effect), ["local_write", "read_only"]);
  assert.throws(() => normalizeSteps([null]), /must be an object/);
  assert.throws(() => normalizeSteps([{ id: "x" }, { id: "x" }]), /Duplicate/);
  assert.throws(() => normalizeSteps([{ side_effect: "bad" }]), /Unsupported side effect/);
  assert.deepEqual([...approvedEffects(true, ["external_write"])], ["read_only", "local_write", "external_write"]);
  assert.deepEqual([...approvedEffects(false)], ["read_only"]);
  assert.throws(() => approvedEffects(false, ["bad"]), /Unsupported approved/);
});

test("workflow runtime executes commands, assertions, coverage gates, failures, and approvals", async () => {
  const root = join(tmpdir(), `craft-workflow-${process.pid}-${Date.now()}`);
  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "value.json"), JSON.stringify({ a: [{ b: 2 }] }));
  await writeFile(join(root, "coverage.json"), JSON.stringify({ total: {
    lines: { pct: 100 }, branches: { pct: 100 }, functions: { pct: 100 }, statements: { pct: 100 } } }));
  await writeFile(join(root, "coverage-summary.json"), JSON.stringify({
    lines: { pct: 100 }, branches: { pct: 100 }, functions: { pct: 100 }, statements: { pct: 100 } }));
  try {
    const runner = ((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => ({
      pid: 1, output: [], signal: null, status: args.includes("fail") ? 2 : 0,
      stdout: String(options.env?.SECRET_TOKEN ?? "ok"), stderr: "", error: args.includes("missing") ? new Error("missing") : undefined,
    })) as unknown as typeof import("node:child_process").spawnSync;
    const command = runStep({ type: "command", command: [process.execPath, "-e", "console.log(process.env.SECRET_TOKEN)"],
      env: { SECRET_TOKEN: "abcd" }, timeout_seconds: 3, expected_exit_code: 0 }, root, {}, runner);
    assert.equal(command.passed, true);
    assert.match(String(command.stdout), /REDACTED/);
    const failedCommand = runStep({ type: "command", command: [process.execPath, "fail"],
      expected_exit_code: 0, timeout_seconds: 9999 }, root, {}, runner);
    assert.equal(failedCommand.passed, false);
    const missingCommand = runStep({ type: "command", command: ["x", "missing"] }, root, {}, runner);
    assert.equal(typeof missingCommand.error, "string");
    const emptyRunner = (() => ({ pid: 1, output: [], signal: null, status: 0, stdout: null, stderr: null })) as unknown as typeof import("node:child_process").spawnSync;
    assert.equal(runStep({ type: "command", command: ["x"] }, root, {}, emptyRunner).stdout, "");
    assert.throws(() => runStep({ type: "command", command: [] }, root), /non-empty/);
    assert.throws(() => runStep({ type: "command", command: [process.execPath], cwd: "missing" }, root), /does not exist/);
    assert.throws(() => runStep({ type: "command", command: [process.execPath], cwd: "value.json" }, root), /does not exist/);
    assert.throws(() => runStep({ type: "command", command: [process.execPath], env: [] }, root), /env must be an object/);
    assert.equal(runStep({ type: "assertion", evaluator: "file_exists", path: "value.json" }, root).passed, true);
    assert.equal(runStep({ type: "assertion", evaluator: "file_exists", path: "missing", expected: false }, root).passed, true);
    assert.equal(runStep({ type: "assertion", evaluator: "file_exists" }, root).passed, true);
    assert.equal(runStep({ type: "assertion", evaluator: "json_value", path: "value.json", field: "a.0.b", expected: 2 }, root).passed, true);
    assert.equal(runStep({ type: "assertion", evaluator: "json_value", path: "value.json", expected: { a: [] } }, root).passed, false);
    assert.throws(() => runStep({ type: "assertion", evaluator: "json_value" }, root));
    assert.throws(() => runStep({ type: "assertion", evaluator: "bad" }, root), /Unsupported assertion/);
    assert.equal(runStep({ type: "coverage_gate", report: "coverage.json" }, root).passed, true);
    assert.equal(runStep({ type: "coverage_gate", report: "coverage.json", line_threshold: 101 }, root).passed, false);
    assert.equal(runStep({ type: "coverage_gate" }, root).passed, true);
    assert.equal(runStep({ type: "coverage_gate", report: "value.json" }, root).passed, false);
    assert.throws(() => runStep({ type: "other" }, root), /Unsupported workflow/);

    const denied = executeSteps([{ id: "x", type: "assertion", evaluator: "file_exists", path: "value.json",
      side_effect: "external_write" }], root, new Set(["read_only"]));
    assert.equal(denied[0].error, "side_effect_not_approved");
    const continued = executeSteps([
      { id: "x", type: "assertion", evaluator: "file_exists", path: "missing", continue_on_failure: true },
      { id: "y", type: "assertion", evaluator: "file_exists", path: "value.json" },
    ], root, new Set(["read_only"]));
    assert.equal(continued.length, 2);
    const failedStop = executeSteps([{ id: "x", type: "assertion", evaluator: "file_exists", path: "missing" },
      { id: "y", type: "other" }], root, new Set(["read_only"]));
    assert.equal(failedStop.length, 1);
    const stopped = executeSteps([{ id: "x", type: "other" }, { id: "y", type: "other" }], root, new Set(["read_only"]));
    assert.equal(stopped.length, 1);
    const caughtString = { id: "x", type: "other", continue_on_failure: true };
    const two = executeSteps([caughtString, { id: "y", type: "assertion", evaluator: "file_exists", path: "value.json" }], root, new Set(["read_only"]));
    assert.equal(two.length, 2);
    const throwString = (() => { throw "bad"; }) as typeof runStep;
    assert.equal(executeSteps([{ id: "x" }], root, new Set(["read_only"]), throwString)[0].error, "Error");
    assert.equal(executeSteps([{ id: "x", continue_on_failure: true }, { id: "y" }], root,
      new Set(["read_only"]), throwString).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
