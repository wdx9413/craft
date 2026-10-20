import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { extractCodexSessionVerificationArtifacts, type CodexTaskTranscriptRecord } from "../core/codex-session-verification.ts";

const call = (id: string, input: unknown, name = "exec"): CodexTaskTranscriptRecord => ({ record_type: "response_item",
  payload: { type: "custom_tool_call", call_id: id, name, input } });
const output = (id: string, text: unknown): CodexTaskTranscriptRecord => ({ record_type: "response_item",
  payload: { type: "custom_tool_call_output", call_id: id, output: text } });
const successfulOutput = (summary: string) => [{ type: "text", text: "Process exited with code 0" }, { type: "text", text: summary }];

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
