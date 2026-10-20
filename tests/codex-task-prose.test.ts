import assert from "node:assert/strict";
import test from "node:test";
import { codexTaskGoalDigest, sanitizeCodexTaskGoal } from "../core/codex-task-prose.ts";

test("sanitizes one bounded task line and produces a stable content-free identity", () => {
  const source = "# 整理依赖验证流程 https://example.invalid/a `npm test`\n第二行不进入任务摘要";
  assert.equal(sanitizeCodexTaskGoal(source), "整理依赖验证流程");
  assert.match(codexTaskGoalDigest(source) ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert.equal(codexTaskGoalDigest(source), codexTaskGoalDigest("整理依赖验证流程"));
});

test("rejects empty, unsafe, oversized, and too-short task goals", () => {
  for (const value of [undefined, "", "token=abcdefghijk", "短", "x".repeat(8_001)]) {
    assert.equal(sanitizeCodexTaskGoal(value), null);
    assert.equal(codexTaskGoalDigest(value), null);
  }
});
