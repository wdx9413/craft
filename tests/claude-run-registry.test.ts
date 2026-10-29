import assert from "node:assert/strict";
import test from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeRunRegistry } from "../core/interfaces/claude-run-registry.ts";

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const event = (value: string) => ({ type: "stream_event", session_id: "session", value } as unknown as SDKMessage);

test("unknown runs expose only a safe classified cause", async () => {
  const registry = new ClaudeRunRegistry();
  const id = registry.start("task", async () => { throw new Error("outer", { cause: new Error("Claude effective settings do not match requested settings") }); });
  await settle(); assert.equal(registry.events("task", id, 0).reason, "settings_mismatch");
  const other = registry.start("task", async () => { throw new Error("secret prompt"); });
  await settle(); assert.equal(registry.events("task", other, 0).reason, "unknown");
  assert.equal(JSON.stringify(registry.events("task", other, 0)).includes("secret prompt"), false);
  registry.close();
});

test("Claude run streams bounded events and routes approval only for its task", async () => {
  const registry = new ClaudeRunRegistry(); let decision: unknown;
  const id = registry.start("task", async (approvals, emit, abort) => {
    for (let i = 0; i < 260; i++) emit(event(String(i)));
    decision = await approvals.canUseTool("Bash", { command: "echo hello" }, { signal: abort.signal, toolUseID: "tool", requestId: "request" });
  });
  await settle();
  const page = registry.events("task", id, 0); assert.equal(page.events.length, 256); assert.equal(page.truncated, true); assert.equal(page.approvals.length, 1); assert.equal(page.native_session_id, "session");
  assert.deepEqual(registry.list("task"), [{ run_id: id, state: "running", native_session_id: "session" }]);
  assert.deepEqual(registry.list("other"), []);
  assert.throws(() => registry.events("other", id, 0), /not found/);
  assert.throws(() => registry.decide("other", id, page.approvals[0].id, "accept"), /not found/);
  assert.throws(() => registry.release("task", id), /still active/);
  registry.decide("task", id, page.approvals[0].id, "decline"); await settle();
  assert.deepEqual(decision, { behavior: "deny", message: "User declined" });
  assert.equal(registry.events("task", id, page.last_sequence).state, "completed");
  registry.release("task", id); assert.throws(() => registry.events("task", id, 0), /not found/);
});

test("interrupt and shutdown deny pending approval and preserve uncertain state", async () => {
  const registry = new ClaudeRunRegistry();
  const id = registry.start("task", async (approvals, _emit, abort) => { await approvals.canUseTool("Write", {}, { signal: abort.signal, toolUseID: "tool", requestId: "request" }); });
  await settle(); registry.interrupt("task", id); await settle();
  assert.equal(registry.events("task", id, 0).state, "unknown");
  assert.throws(() => registry.interrupt("task", id), /not active/);
  registry.close(); assert.throws(() => registry.start("task", async () => {}), /closed/);
});

test("invalid cursors, oversized events and too many live runs fail safely", async () => {
  const registry = new ClaudeRunRegistry();
  assert.throws(() => registry.start(" ", async () => {}), /invalid/);
  const id = registry.start("task", async (_approvals, emit) => { emit(event("x".repeat(257 * 1024))); });
  await settle(); assert.equal(registry.events("task", id, 0).state, "unknown");
  assert.throws(() => registry.events("task", id, -1), /cursor/);
  registry.release("task", id);
  const changed = registry.start("task", async (_approvals, emit) => { emit(event("first")); emit({ ...event("second"), session_id: "different" } as SDKMessage); });
  await settle(); assert.equal(registry.events("task", changed, 0).state, "unknown"); registry.release("task", changed);
  const cancelled = registry.start("task", async (_approvals, emit) => { emit(event("late")); });
  registry.interrupt("task", cancelled); await settle();
  assert.equal(registry.events("task", cancelled, 0).state, "unknown"); registry.release("task", cancelled);
  const stuck = new Promise<void>(() => {});
  for (let i = 0; i < 64; i++) registry.start("task", () => stuck);
  assert.throws(() => registry.start("task", async () => {}), /full/);
  registry.close();
});
