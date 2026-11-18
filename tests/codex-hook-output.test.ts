import assert from "node:assert/strict";
import test from "node:test";
import { formatCodexHookOutput } from "../core/interfaces/codex-hook-output.ts";

test("UserPromptSubmit additional context uses Codex hookSpecificOutput schema", () => {
  assert.deepEqual(formatCodexHookOutput("UserPromptSubmit", { additionalContext: "scoped context" }), {
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "scoped context" },
  });
});

test("UserPromptSubmit formatting preserves other valid fields and an existing event payload", () => {
  assert.deepEqual(formatCodexHookOutput("UserPromptSubmit", {
    decision: "allow",
    additionalContext: "scoped context",
    hookSpecificOutput: { custom: "preserved" },
  }), {
    decision: "allow",
    hookSpecificOutput: { custom: "preserved", hookEventName: "UserPromptSubmit", additionalContext: "scoped context" },
  });
});

test("UserPromptSubmit replaces malformed array event payloads", () => {
  assert.deepEqual(formatCodexHookOutput("UserPromptSubmit", {
    additionalContext: "scoped context",
    hookSpecificOutput: ["invalid"],
  }), {
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "scoped context" },
  });
});

test("events without UserPromptSubmit context keep their existing output", () => {
  const output = { systemMessage: "turn ended" };
  assert.equal(formatCodexHookOutput("Stop", output), output);
  const empty = {};
  assert.equal(formatCodexHookOutput("UserPromptSubmit", empty), empty);
});
