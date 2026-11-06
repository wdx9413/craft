import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeWorkbenchApprovals } from "../core/interfaces/claude-workbench-approvals.ts";

const options = (signal: AbortSignal) => ({ signal, toolUseID: "tool", requestId: "request", title: "Run command", blockedPath: "/tmp" });

test("Claude approval displays a stable request and resolves the user's decision once", async () => {
  let changes = 0; const approvals = new ClaudeWorkbenchApprovals(() => changes++); const controller = new AbortController();
  const input = { command: "echo original" }; const pending = approvals.canUseTool("Bash", input, options(controller.signal));
  input.command = "changed";
  const shown = approvals.list(); assert.equal(shown[0].context.blockedPath, "/tmp"); assert.equal(shown[0].input.command, "echo original");
  shown[0].input.command = "tampered";
  assert.throws(() => approvals.decide(shown[0].id, "invalid" as never), /invalid/);
  approvals.decide(shown[0].id, "accept");
  assert.deepEqual(await pending, { behavior: "allow", updatedInput: { command: "echo original" } });
  assert.throws(() => approvals.decide(shown[0].id, "decline"), /not pending/);
  assert.equal(approvals.list().length, 0); assert.equal(changes, 2);
});

test("Claude approval denies cancellation, closure, unsupported and oversized requests", async () => {
  const approvals = new ClaudeWorkbenchApprovals(); const controller = new AbortController();
  const first = approvals.canUseTool("Write", { file: "a" }, options(controller.signal));
  controller.abort(); assert.equal((await first)?.behavior, "deny");
  assert.equal((await approvals.canUseTool("Read", {}, options(controller.signal)))?.behavior, "deny");
  const signal = new AbortController().signal;
  assert.equal((await approvals.canUseTool("AskUserQuestion", {}, options(signal)))?.behavior, "deny");
  assert.equal((await approvals.canUseTool("Write", { data: "x".repeat(257 * 1024) }, options(signal)))?.behavior, "deny");
  const circular: Record<string, unknown> = {}; circular.self = circular;
  assert.equal((await approvals.canUseTool("Write", circular, options(signal)))?.behavior, "deny");
  const pending = approvals.canUseTool("Write", {}, options(signal)); approvals.close(); assert.equal((await pending)?.behavior, "deny");
  assert.equal((await approvals.canUseTool("Read", {}, options(signal)))?.behavior, "deny");
});

test("decline does not grant permission and pending prompts are bounded", async () => {
  const approvals = new ClaudeWorkbenchApprovals(); const signal = new AbortController().signal;
  const requests = Array.from({ length: 32 }, () => approvals.canUseTool("Write", { file: "a" }, options(new AbortController().signal)));
  assert.equal((await approvals.canUseTool("Write", {}, options(signal)))?.behavior, "deny");
  const id = approvals.list()[0].id; approvals.decide(id, "decline");
  assert.deepEqual(await requests[0], { behavior: "deny", message: "User declined" });
  approvals.close(); await Promise.all(requests);
  assert.deepEqual(approvals.list(), []);
});

test("an abort racing with approval registration does not leave a pending request", async () => {
  let reads = 0; let abort: (() => void) | undefined;
  const signal = { get aborted() { return ++reads > 1; }, addEventListener(_type: string, callback: () => void) { abort = callback; }, removeEventListener() {} } as unknown as AbortSignal;
  const approvals = new ClaudeWorkbenchApprovals();
  assert.equal((await approvals.canUseTool("Write", {}, options(signal)))?.behavior, "deny");
  abort?.();
  assert.deepEqual(approvals.list(), []);
});

test("Claude questions require complete answers and resolve once without changing the original input", async () => {
  const approvals = new ClaudeWorkbenchApprovals(); const signal = new AbortController().signal;
  const input = { questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }], multiSelect: true }, { question: "Why?" }] };
  const pending = approvals.canUseTool("AskUserQuestion", input, options(signal));
  const id = approvals.list()[0].id;
  assert.throws(() => approvals.decide(id, "accept"), /answers are invalid/);
  assert.throws(() => approvals.decide(id, "accept", { "Which?": "A" }), /answers are invalid/);
  assert.throws(() => approvals.decide(id, "accept", { "Which?": "A", "Why?": " " }), /answers are invalid/);
  assert.throws(() => approvals.decide(id, "accept", { "Which?": "A", "Why?": "x".repeat(8193) }), /answers are invalid/);
  approvals.decide(id, "accept", { "Which?": "A, B", "Why?": "custom answer" });
  assert.deepEqual(await pending, { behavior: "allow", updatedInput: { ...input, answers: { "Which?": "A, B", "Why?": "custom answer" } } });
  assert.equal("answers" in input, false);
  assert.throws(() => approvals.decide(id, "accept", {}), /not pending/);
  assert.equal((await approvals.canUseTool("AskUserQuestion", { questions: [{ question: "same" }, { question: "same" }] }, options(signal)))?.behavior, "deny");
  assert.equal((await approvals.canUseTool("AskUserQuestion", { questions: [null] }, options(signal)))?.behavior, "deny");
  const cancelled = approvals.canUseTool("AskUserQuestion", input, options(signal));
  approvals.decide(approvals.list()[0].id, "decline");
  assert.equal((await cancelled)?.behavior, "deny");
});
