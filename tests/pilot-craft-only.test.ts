import assert from "node:assert/strict";
import test from "node:test";
import { assertPilotCraftOnly, enforcePilotSplitCraftOnly, pilotPolicyViolation } from "../core/pilot-policy.ts";

test("领航员执行器只接受 craft / craft-internal 并统一归一为 craft", () => {
  assert.equal(assertPilotCraftOnly("craft"), "craft");
  assert.equal(assertPilotCraftOnly("craft-internal"), "craft");
  assert.equal(assertPilotCraftOnly(undefined), "craft");
  assert.equal(assertPilotCraftOnly(""), "craft");
});

test("领航员拒绝 Codex / Claude / DSH / agent-desktop，错误带稳定码", () => {
  for (const host of ["codex", "codex-cli", "claude", "claude-code", "dsh", "agent-desktop"]) {
    assert.throws(() => assertPilotCraftOnly(host), (error: unknown) => {
      const violation = error as Error & { code?: string; requested?: string };
      assert.equal(violation.code, "PILOT_CRAFT_ONLY");
      assert.equal(violation.requested, host);
      assert.match(violation.message, /只允许使用 Craft/u);
      return true;
    });
  }
  assert.deepEqual(pilotPolicyViolation("claude").allowed_hosts, ["craft", "craft-internal"]);
});

test("领航员 task split 强制改写为 craft，外部 CLI 显式写入也 fail-closed", () => {
  const split = enforcePilotSplitCraftOnly([
    { title: "A", goal: "do a", executor_template: "craft-internal" },
    { title: "B", goal: "do b" },
  ]);
  assert.deepEqual(split.map((item) => item.executor_template), ["craft", "craft"]);
  assert.throws(() => enforcePilotSplitCraftOnly([{ title: "C", goal: "do c", executor_template: "codex" }]), /PILOT_CRAFT_ONLY|只允许使用 Craft/u);
  assert.throws(() => enforcePilotSplitCraftOnly({ tasks: [] }), /must be an array/u);
});
