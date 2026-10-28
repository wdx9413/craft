import assert from "node:assert/strict";
import test from "node:test";
import { stableDigest } from "../core/digest.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { createCodexSessionVerificationCollector, extractCodexSessionVerificationArtifacts, type CodexTaskTranscriptRecord } from "../core/codex-session-verification.ts";

const call = (id: string, input: unknown, name = "exec"): CodexTaskTranscriptRecord => ({ record_type: "response_item",
  payload: { type: "custom_tool_call", call_id: id, name, input } });
const output = (id: string, text: unknown): CodexTaskTranscriptRecord => ({ record_type: "response_item",
  payload: { type: "custom_tool_call_output", call_id: id, output: text } });
const completedCommand = (id: string, command: unknown, aggregated_output: unknown, overrides: JsonObject = {}): CodexTaskTranscriptRecord => ({
  record_type: "event_msg", payload: { type: "item_completed", turn_id: "turn-a", item: { type: "CommandExecution", id, command,
    aggregated_output, exit_code: 0, status: "completed", ...overrides } },
});
const successfulOutput = (summary: string) => [{ type: "text", text: "Process exited with code 0" }, { type: "text", text: summary }];

test("duplicate call or output identifiers cannot create verification artifacts", () => {
  const passed = successfulOutput("Tests 1 passed (1)");
  assert.deepEqual(extractCodexSessionVerificationArtifacts([
    call("duplicate-call", "pnpm test"), call("duplicate-call", "echo unrelated"), output("duplicate-call", passed),
    call("duplicate-output", "pnpm test"), output("duplicate-output", passed), output("duplicate-output", passed),
    call("empty-first", "pnpm test"), output("empty-first", null), output("empty-first", passed),
    call("invalid-first", "echo unrelated"), call("invalid-first", "pnpm test"), output("invalid-first", passed),
    call("other-tool-first", "pnpm test", "terminal"), call("other-tool-first", "pnpm test"), output("other-tool-first", passed),
  ]), []);
  assert.equal(extractCodexSessionVerificationArtifacts([output("unique", passed), call("unique", "pnpm test")]).length, 1);
});

test("bounds custom call tracking and preserves structured command evidence on overflow", () => {
  const passed = successfulOutput("Tests 1 passed (1)");
  for (const overflowOutputs of [false, true]) {
    const records = [call("match", "pnpm test"), output("match", passed)];
    for (let index = 0; index < 4096; index++) {
      records.push(overflowOutputs ? output(`overflow-${index}`, "unmatched") : call(`overflow-${index}`, "echo unrelated"));
    }
    records.push(call("late", "pnpm test"), output("late", passed), completedCommand("structured", "pnpm test", "Tests 1 passed (1)"));
    const artifacts = extractCodexSessionVerificationArtifacts(records);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]?.call_digest, stableDigest("structured"));
  }
});

test("continues checking overflow after the structured artifact limit", () => {
  const records = Array.from({ length: 8 }, (_, index) => completedCommand(`structured-${index}`, "pnpm test", "Tests 1 passed (1)"));
  assert.equal(extractCodexSessionVerificationArtifacts([...records, call("extra", "pnpm test"),
    output("extra", successfulOutput("Tests 1 passed (1)"))]).length, 8);
  for (let index = 0; index < 4097; index++) records.push(call(`call-${index}`, "echo ok"));
  const collector = createCodexSessionVerificationCollector();
  for (const record of records) collector.add(record);
  assert.equal(collector.finish().length, 8);
  assert.equal(collector.customCallsOverflowed(), true);
});

test("accepts only paired, successful test-runner calls with a passing summary", () => {
  const artifacts = extractCodexSessionVerificationArtifacts([
    call("js", "cd 'packages/core' && pnpm test"), output("js", successfulOutput("Tests 12 passed (12)")),
    call("python", "pytest -q"), output("python", successfulOutput("4 passed in 0.2s")),
    call("go", "go test ./..."), output("go", successfulOutput("ok example/pkg 0.01s")),
    call("rust", "cargo test"), output("rust", successfulOutput("test result: ok. 8 passed; 0 failed")),
    call("maven", "mvn test"), output("maven", successfulOutput("Tests run: 3, Failures: 0, Errors: 0")),
    call("gradle", "./gradlew test"), output("gradle", successfulOutput("> Task :test\nBUILD SUCCESSFUL")),
    call("dotnet", "dotnet test"), output("dotnet", successfulOutput("Passed: 5")),
    call("node", "node --test"), output("node", successfulOutput("# tests 2\n# pass 2")),
  ]);
  assert.deepEqual(artifacts.map(item => item.runner), ["javascript", "python", "go", "rust", "java-maven", "java-gradle", "dotnet", "javascript"]);
  assert(artifacts.every(item => item.exit_code === 0 && item.summary_kind === "tests_passed" && item.content_stored === false));
  assert(artifacts.every(item => typeof item.command_digest === "string" && typeof item.result_digest === "string"));
  assert.equal(JSON.stringify(artifacts).includes("pnpm test"), false);
});

test("rejects non-test calls, unmatched outputs, failures, missing summaries, and unsafe shell commands", () => {
  const artifacts = extractCodexSessionVerificationArtifacts([
    { record_type: "event_msg", payload: { type: "custom_tool_call", call_id: "event", name: "exec", input: "pnpm test" } },
    call("other-tool", "pnpm test", "terminal"), output("other-tool", successfulOutput("Tests 1 passed (1)")),
    call("missing-output", "pnpm test"),
    call("failure", "pnpm test"), output("failure", [{ type: "text", text: "Process exited with code 1" }, { type: "text", text: "Tests 1 passed (1)" }]),
    call("no-summary", "pnpm test"), output("no-summary", successfulOutput("no tests found")),
    call("zero-tests", "pnpm test"), output("zero-tests", successfulOutput("Tests 0 passed (0)")),
    call("mixed-result", "pnpm test"), output("mixed-result", successfulOutput("Tests 3 passed, 1 failed")),
    call("non-test", "echo ok"), output("non-test", successfulOutput("Tests 1 passed (1)")),
    call("unsafe", "pnpm test; echo masked"), output("unsafe", successfulOutput("Tests 1 passed (1)")),
    { record_type: "response_item", payload: { type: "custom_tool_call", call_id: 7, name: "exec", input: "pnpm test" } },
  ]);
  assert.deepEqual(artifacts, []);
  assert.deepEqual(extractCodexSessionVerificationArtifacts([call("x", null), call("y", "  "), call("z", "pnpm test\nfalse"),
    call("long", "x".repeat(16_001)), call("m", "pnpm test"), output("m", [null, {}, { text: "" }]),
    call("non-array-output", "pnpm test"), output("non-array-output", 1)]), []);
});

test("bounds output parsing and limits returned artifacts", () => {
  const records: CodexTaskTranscriptRecord[] = [];
  for (let index = 0; index < 10; index++) {
    records.push(call(`call-${index}`, "pnpm test"), output(`call-${index}`, successfulOutput("Tests 1 passed (1)")));
  }
  records.push(call("capped", "pnpm test"), output("capped", ["ignored", { text: 5 },
    { text: "x".repeat(1_000_000) }, { text: "Tests 1 passed (1)" }]));
  assert.equal(extractCodexSessionVerificationArtifacts(records).length, 8);
  assert.deepEqual(extractCodexSessionVerificationArtifacts([call("text", "pnpm test"),
    output("text", "Process exited with code 0\nTests 1 passed (1)")]).length, 1);
});

test("accepts Codex structured CommandExecution completions without storing command or output text", () => {
  const command = "pnpm test";
  const summary = "Tests 12 passed (12)";
  const artifacts = extractCodexSessionVerificationArtifacts([
    completedCommand("command-1", command, summary),
    completedCommand("ignored-event-id", command, summary, { id: undefined }),
  ]);
  assert.equal(artifacts.length, 2);
  assert.deepEqual(artifacts[0], { runner: "javascript", command_digest: stableDigest(command), result_digest: stableDigest(summary),
    call_digest: stableDigest("command-1"), exit_code: 0, summary_kind: "tests_passed", content_stored: false });
  assert.doesNotMatch(JSON.stringify(artifacts), /pnpm test|Tests 12 passed/u);
  const capped = extractCodexSessionVerificationArtifacts(Array.from({ length: 10 }, (_, index) =>
    completedCommand(`command-${index}`, command, summary)));
  assert.equal(capped.length, 8);
});

test("deduplicates structured command completions and paired records by call identifier", () => {
  const record = completedCommand("same", "pnpm test", "Tests 1 passed (1)");
  const artifacts = extractCodexSessionVerificationArtifacts([record, record, call("same", "pnpm test"),
    output("same", successfulOutput("Tests 1 passed (1)"))]);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.call_digest, stableDigest("same"));
});

test("rejects conflicting or excessive structured command identifiers", () => {
  for (const second of [completedCommand("same", "go test ./...", "ok example/pkg 0.01s"),
    completedCommand("same", "pnpm test", "Tests 1 failed (1)", { exit_code: 1 })]) {
    const collector = createCodexSessionVerificationCollector();
    collector.add(completedCommand("same", "pnpm test", "Tests 1 passed (1)"));
    collector.add(second);
    assert.equal(collector.structuredCallsConflicted(), true);
    assert.deepEqual(collector.finish(), []);
  }
  const collector = createCodexSessionVerificationCollector();
  for (let index = 0; index < 4097; index++) collector.add(completedCommand(`id-${index}`, "echo ok", ""));
  assert.equal(collector.structuredCallsOverflowed(), true);
  assert.deepEqual(collector.finish(), []);
});

test("unwraps only bounded login-shell command arrays used by Codex CommandExecution records", () => {
  const command = "cd '/repo/craft' && pnpm test";
  const summary = "Tests 12 passed (12)";
  const artifacts = extractCodexSessionVerificationArtifacts([
    completedCommand("wrapped-command", ["/bin/zsh", "-lc", command], summary),
    completedCommand("bash-command", ["/bin/bash", "-lc", "go test ./..."], "ok example/pkg 0.01s"),
  ]);
  assert.deepEqual(artifacts.map(item => item.runner), ["javascript", "go"]);
  assert.equal(artifacts[0]?.command_digest, stableDigest(command));
  assert.doesNotMatch(JSON.stringify(artifacts), /\/repo\/craft|pnpm test|Tests 12 passed/u);
});

test("rejects unknown shell wrappers and chained commands after the test runner", () => {
  assert.deepEqual(extractCodexSessionVerificationArtifacts([
    completedCommand("unknown-shell", ["/tmp/zsh", "-lc", "pnpm test"], "Tests 1 passed (1)"),
    completedCommand("chained-command", ["/bin/zsh", "-lc", "pnpm test && echo done"], "Tests 1 passed (1)"),
    completedCommand("wrong-flags", ["/bin/zsh", "-c", "pnpm test"], "Tests 1 passed (1)"),
    completedCommand("extra-argv", ["/bin/zsh", "-lc", "pnpm test", "extra"], "Tests 1 passed (1)"),
  ]), []);
});

test("rejects incomplete, failed, non-test, and unsuccessful structured CommandExecution records", () => {
  assert.deepEqual(extractCodexSessionVerificationArtifacts([
    { record_type: "event_msg", payload: { type: "item_completed", item: null } },
    { record_type: "event_msg", payload: { type: "item_completed", item: { type: "Other", command: "pnpm test",
      aggregated_output: "Tests 1 passed (1)", exit_code: 0, status: "completed" } } },
    completedCommand("non-test", "git status", "Tests 1 passed (1)"),
    completedCommand("non-zero", "pnpm test", "Tests 1 passed (1)", { exit_code: 1 }),
    completedCommand("failed-status", "pnpm test", "Tests 1 passed (1)", { status: "failed" }),
    completedCommand("failed-output", "pnpm test", "Tests 1 failed (1)"),
    completedCommand("missing-output", "pnpm test", null),
    completedCommand("missing-exit", "pnpm test", "Tests 1 passed (1)", { exit_code: undefined }),
  ]), []);
});
