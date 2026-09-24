import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_INTERNAL_AUTHORIZATION, authorizedTools, classifyTool } from "../core/internal-tool-authorization.ts";
import { DEFAULT_INTERNAL_TOOLS } from "../core/internal-host-driver.ts";
import { McpServer, TOOLS } from "../core/mcp.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { decideExperienceCapture } from "../core/context-retrieval-capture.ts";
import {
  evaluateVerificationCheck,
  runVerification,
  summarizeVerification,
  verificationCaptureSignals
} from "../core/verification-sensor.ts";

test("v0.12.37 passes an exit code check only when the code matches", () => {
  const passed = evaluateVerificationCheck({ kind: "exit_code", name: "tests", expected_exit_code: 0, observed_exit_code: 0 });
  assert.equal(passed.verdict, "passed");
  assert.equal(passed.reason, "exit_code_matched");

  // A non-zero exit is the canonical deterministic failure signal.
  const failed = evaluateVerificationCheck({ kind: "exit_code", name: "tests", expected_exit_code: 0, observed_exit_code: 1 });
  assert.equal(failed.verdict, "failed");
  assert.equal(failed.reason, "exit_code_1_expected_0");

  // A non-zero expectation is expressible, so a failing build can be the
  // expected outcome of a negative test.
  assert.equal(evaluateVerificationCheck({ kind: "exit_code", name: "n", expected_exit_code: 2, observed_exit_code: 2 }).verdict, "passed");
  // The default expectation is success.
  assert.equal(evaluateVerificationCheck({ kind: "exit_code", name: "n", observed_exit_code: 0 }).verdict, "passed");
  assert.throws(() => evaluateVerificationCheck({ kind: "exit_code", name: "n", expected_exit_code: 1.5 }), /expected_exit_code must be an integer/u);
  assert.throws(() => evaluateVerificationCheck({ kind: "exit_code", name: "n", observed_exit_code: "x" }), /observed_exit_code must be an integer/u);
});

test("v0.12.37 blocks a check that never ran instead of failing the work", () => {
  // The distinction that keeps the learning signal honest: a missing
  // observation means "we could not tell", not "it broke".
  const blocked = evaluateVerificationCheck({ kind: "exit_code", name: "tests" });
  assert.equal(blocked.verdict, "blocked");
  assert.equal(blocked.reason, "check_not_executed");
  // The digest is over the null observation, so a blocked check is still
  // reproducible byte-for-byte without storing anything observed.
  assert.match(blocked.observed_digest, /^sha256:[0-9a-f]{64}$/u);

  assert.equal(evaluateVerificationCheck({ kind: "output_contains", name: "n", expected_substring: "ok" }).verdict, "blocked");
  assert.equal(evaluateVerificationCheck({ kind: "file_digest", name: "n", expected_digest: "sha256:a" }).verdict, "blocked");
  assert.equal(evaluateVerificationCheck({ kind: "file_absent", name: "n" }).verdict, "blocked");
  // null is treated as "not observed" rather than as an empty observation.
  assert.equal(evaluateVerificationCheck({ kind: "exit_code", name: "n", observed_exit_code: null }).verdict, "blocked");
  assert.equal(evaluateVerificationCheck({ kind: "observed_present" in {} ? "file_absent" : "file_absent", name: "n", observed_present: null }).verdict, "blocked");
});

test("v0.12.37 matches expected output as substring or pattern", () => {
  const contains = evaluateVerificationCheck({ kind: "output_contains", name: "n", expected_substring: "BUILD OK", observed_output: "step 1\nBUILD OK\n" });
  assert.equal(contains.verdict, "passed");
  assert.equal(contains.reason, "substring_present");
  assert.equal(evaluateVerificationCheck({ kind: "output_contains", name: "n", expected_substring: "BUILD OK", observed_output: "step 1" }).verdict, "failed");
  // Empty output is a real observation, not a missing one.
  assert.equal(evaluateVerificationCheck({ kind: "output_contains", name: "n", expected_substring: "x", observed_output: "" }).verdict, "failed");

  const matched = evaluateVerificationCheck({ kind: "output_matches", name: "n", expected_pattern: "^v\\d+\\.\\d+", observed_output: "v1.2 rest" });
  assert.equal(matched.verdict, "passed");
  assert.equal(matched.reason, "pattern_matched");
  assert.equal(evaluateVerificationCheck({ kind: "output_matches", name: "n", expected_pattern: "^v\\d+", observed_output: "nope" }).verdict, "failed");
  // A pattern that does not compile is a broken check, not a failed task.
  const invalid = evaluateVerificationCheck({ kind: "output_matches", name: "n", expected_pattern: "([", observed_output: "anything" });
  assert.equal(invalid.verdict, "blocked");
  assert.equal(invalid.reason, "pattern_invalid");
});

test("v0.12.37 compares file digests and file absence", () => {
  const digest = "sha256:" + "b".repeat(64);
  assert.equal(evaluateVerificationCheck({ kind: "file_digest", name: "n", expected_digest: digest, observed_digest: digest }).verdict, "passed");
  const mismatch = evaluateVerificationCheck({ kind: "file_digest", name: "n", expected_digest: digest, observed_digest: "sha256:" + "c".repeat(64) });
  assert.equal(mismatch.verdict, "failed");
  assert.equal(mismatch.reason, "digest_mismatched");

  // file_absent is the one kind where absence is success.
  assert.equal(evaluateVerificationCheck({ kind: "file_absent", name: "n", observed_present: false }).verdict, "passed");
  const present = evaluateVerificationCheck({ kind: "file_absent", name: "n", observed_present: true });
  assert.equal(present.verdict, "failed");
  assert.equal(present.reason, "file_present");
});

test("v0.12.37 rejects malformed checks rather than guessing", () => {
  assert.throws(() => evaluateVerificationCheck({ kind: "telepathy", name: "n" }), /kind is unsupported: telepathy/u);
  assert.throws(() => evaluateVerificationCheck({ kind: "exit_code", name: "" }), /name must not be empty/u);
  assert.throws(() => evaluateVerificationCheck({ kind: "output_contains", name: "n", observed_output: "x" }), /expected_substring must not be empty/u);
  assert.throws(() => evaluateVerificationCheck({ kind: "output_matches", name: "n", observed_output: "x" }), /expected_pattern must not be empty/u);
  assert.throws(() => evaluateVerificationCheck({ kind: "file_digest", name: "n", observed_digest: "x" }), /expected_digest must not be empty/u);
  assert.throws(() => evaluateVerificationCheck({ kind: "file_absent", name: "n", observed_present: "yes" }), /observed_present must be a boolean/u);
  // An observation of the wrong type is a broken caller, not a failed task.
  assert.throws(() => evaluateVerificationCheck({ kind: "output_contains", name: "n", expected_substring: "x", observed_output: 42 }), /observed_output must be a string/u);
  assert.throws(() => evaluateVerificationCheck({ kind: "file_digest", name: "n", expected_digest: "d", observed_digest: 42 }), /observed_digest must be a string/u);
});

test("v0.12.37 only persists digests, never observed content", () => {
  // The sensor must be safe to record: raw output can carry secrets, so the
  // result carries a digest and a reason code instead.
  const secret = "token=abcd1234efgh5678";
  const result = evaluateVerificationCheck({ kind: "output_contains", name: "n", expected_substring: "token", observed_output: secret });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.match(result.observed_digest, /^sha256:[0-9a-f]{64}$/u);
});

test("v0.12.37 combines checks conservatively and order-independently", () => {
  const pass = (name: string) => evaluateVerificationCheck({ kind: "exit_code", name, observed_exit_code: 0 });
  const fail = (name: string) => evaluateVerificationCheck({ kind: "exit_code", name, observed_exit_code: 1 });
  const blocked = (name: string) => evaluateVerificationCheck({ kind: "exit_code", name });

  // One real contradiction outweighs any number of passes.
  const failed = summarizeVerification([pass("a"), fail("b"), pass("c")]);
  assert.equal(failed.verdict, "failed");
  assert.equal(failed.is_failure, true);
  assert.deepEqual(failed.failed_checks, ["b"]);
  assert.equal(failed.passed_count, 2);

  // Cannot-verify is never reported as verified.
  const blockedSummary = summarizeVerification([pass("a"), blocked("b")]);
  assert.equal(blockedSummary.verdict, "blocked");
  assert.equal(blockedSummary.is_failure, false);
  assert.equal(blockedSummary.verifiable, false);
  assert.deepEqual(blockedSummary.blocked_checks, ["b"]);

  // "Could not tell" stays distinct from "we know it broke".
  const inconclusive = summarizeVerification([pass("a"), { kind: "exit_code", name: "b", verdict: "inconclusive", reason: "unclear", observed_digest: "sha256:x" }]);
  assert.equal(inconclusive.verdict, "inconclusive");
  assert.deepEqual(inconclusive.inconclusive_checks, ["b"]);

  const allPassed = summarizeVerification([pass("a"), pass("b")]);
  assert.equal(allPassed.verdict, "passed");
  assert.equal(allPassed.verifiable, true);
  assert.deepEqual(allPassed.failed_checks, []);

  // Order does not matter, so the verdict is reproducible.
  assert.deepEqual(summarizeVerification([fail("b"), pass("a")]).verdict, "failed");
});

test("v0.12.37 rejects an unusable verification plan", () => {
  assert.throws(() => summarizeVerification([]), /at least one check/u);
  assert.throws(() => summarizeVerification([evaluateVerificationCheck({ kind: "exit_code", name: "a" }), evaluateVerificationCheck({ kind: "exit_code", name: "a" })]), /names must be unique/u);
  // Deliberately violates the verdict union: the point is that a corrupted or
  // hand-built summary is rejected rather than silently treated as a pass.
  assert.throws(() => summarizeVerification([{ kind: "exit_code", name: "a", verdict: "maybe" as "passed", reason: "r", observed_digest: "d" }]), /verdict is unsupported/u);
  assert.throws(() => runVerification({ checks: [] }), /non-empty array/u);
  assert.throws(() => runVerification({ checks: "nope" }), /non-empty array/u);
  assert.throws(() => runVerification({ checks: ["nope"] }), /check must be an object/u);
  assert.throws(() => runVerification({ checks: [[]] }), /check must be an object/u);
});

test("v0.12.37 turns an observed failure into a capture signal", () => {
  const signals = verificationCaptureSignals({ checks: [{ kind: "exit_code", name: "tests", observed_exit_code: 1 }] });
  assert.equal(signals.outcome, "failed");
  assert.equal(signals.succeeded, false);
  assert.equal(signals.corrections, 1);
  assert.equal(signals.is_failure, true);
  assert.equal(signals.source, "deterministic_verification");

  // The seam that matters: the emitted outcome must be one the capture
  // decision accepts, so the sensor cannot produce a value that throws.
  const decision = decideExperienceCapture({ ...signals, summary: "tests failed", task_id: "t1" });
  assert.equal(decision.capture, true);
  // A failed check is scored as a correction, because the loop had to absorb a
  // contradiction. `correction` outranks `failure_lesson` in the derived kind,
  // and both set requires_review, so the governance outcome is the same.
  assert.equal(decision.kind, "correction");
  // A single deterministically observed failure clears the threshold on its own.
  assert.ok(decision.score >= 25);
  assert.deepEqual(decision.reasons, ["outcome_failed", "corrections_1"]);

  const passing = verificationCaptureSignals({ checks: [{ kind: "exit_code", name: "tests", observed_exit_code: 0 }] });
  assert.equal(passing.outcome, "succeeded");
  assert.equal(decideExperienceCapture({ ...passing, summary: "fine" }).capture, false);

  assert.equal(verificationCaptureSignals({ checks: [{ kind: "exit_code", name: "t" }] }).outcome, "abandoned");
  assert.equal(verificationCaptureSignals({ checks: [{ kind: "exit_code", name: "t", observed_exit_code: 0 }], retries: 3 }).retries, 3);
  assert.throws(() => verificationCaptureSignals({ checks: [{ kind: "exit_code", name: "t" }], retries: -1 }), /retries must be a non-negative integer/u);
  assert.throws(() => verificationCaptureSignals({ checks: [{ kind: "exit_code", name: "t" }], retries: 1.5 }), /retries must be a non-negative integer/u);
});

test("v0.12.37 the loop itself can run verification", () => {
  // The whole point of V1: a tool the loop cannot mount cannot close the loop.
  const names = DEFAULT_INTERNAL_TOOLS.map((definition) => definition.function.name);
  assert.equal(names.includes("verification_evaluate"), true);
  // The canonical action name, not a loop-only alias: `verification_signals_get`
  // was advertised here but answered by nothing, so the loop could be offered a
  // check it could never route.
  assert.equal(names.includes("verification_capture_signals_get"), true);
  const mounted = new Set(DEFAULT_INTERNAL_AUTHORIZATION);
  for (const name of ["craft_verification_check", "craft_verification_evaluate", "craft_verification_capture_signals_get"]) {
    assert.equal(mounted.has(classifyTool(name)), true, `${name} is not in a mounted tier`);
  }
  const projected = authorizedTools(TOOLS, DEFAULT_INTERNAL_AUTHORIZATION).map((tool) => tool.name);
  for (const name of ["craft_verification_check", "craft_verification_evaluate", "craft_verification_capture_signals_get"]) {
    assert.equal(projected.includes(name), true, `${name} missing from the loop projection`);
  }
});

test("v0.12.37 exposes verification over MCP end to end", async (t) => {
  const root = join(tmpdir(), `craft-v01236-mcp-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const store = await new CraftStore(craftPaths(root)).open();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const server = new McpServer(new CraftService(store));

  const call = async (name: string, args: JsonObject): Promise<JsonObject> => {
    const response = await server.handle({ id: 1, method: "tools/call", params: { name, arguments: args } });
    assert.equal(response?.error, undefined, `tool ${name} errored: ${JSON.stringify(response?.error)}`);
    const content = (response?.result as JsonObject).content as Array<{ text: string }>;
    return JSON.parse(content[0]!.text) as JsonObject;
  };

  const listed = ((await server.handle({ id: 1, method: "tools/list" }))?.result as JsonObject).tools as JsonObject[];
  for (const name of ["craft_verification_check", "craft_verification_evaluate", "craft_verification_capture_signals_get"]) {
    assert.equal(listed.some((tool) => tool.name === name), true, `${name} is not advertised`);
  }

  assert.equal((await call("craft_verification_check", { kind: "exit_code", name: "tests", observed_exit_code: 0 })).verdict, "passed");
  const plan = await call("craft_verification_evaluate", { checks: [{ kind: "exit_code", name: "tests", observed_exit_code: 1 }, { kind: "file_absent", name: "tmp", observed_present: false }] });
  assert.equal(plan.verdict, "failed");
  assert.deepEqual(plan.failed_checks, ["tests"]);

  // End to end: a deterministically observed failure becomes a captured lesson
  // with no `outcome` supplied by anyone.
  const signals = await call("craft_verification_capture_signals_get", { checks: [{ kind: "exit_code", name: "tests", observed_exit_code: 1 }] });
  const decision = await call("craft_experience_capture_decide", { ...signals, summary: "the test suite failed" });
  assert.equal(decision.capture, true);
  assert.equal(decision.kind, "correction");
});
