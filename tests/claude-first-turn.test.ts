import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { ClaudeWorkbenchAdapter } from "../core/interfaces/claude-workbench-adapter.ts";
import { ClaudeWorkbenchApprovals } from "../core/interfaces/claude-workbench-approvals.ts";
import { ClaudeFirstTurn } from "../core/interfaces/claude-first-turn.ts";

test("first Claude prompt is reserved before dispatch and mapped after native initialization", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-claude-first-"))); const store = await new CraftStore(craftPaths(root)).open(); store.create("task", "t", {});
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); let count = 0;
  const adapter = new ClaudeWorkbenchAdapter(({ options }) => ({ async *[Symbol.asyncIterator]() {
    count++; await wait;
    yield { type: "system", subtype: "init", session_id: options.sessionId, cwd: root, permissionMode: "default", model: "model" } as SDKMessage;
    yield { type: "result", subtype: "success", session_id: options.sessionId } as SDKMessage;
  }, close() {} }));
  const first = new ClaudeFirstTurn(store, adapter); const args = { task_id: "t", workspace: root, permission: "ask" as const, operation_id: "once", executable: join(root, "claude"), prompt: "secret-message-marker" };
  try {
    const sending = first.start(args, new ClaudeWorkbenchApprovals(), () => {});
    assert.equal(store.list("workbench_claude_creation", 10).length, 1); assert.equal(first.links.list("t").links instanceof Array, true);
    await assert.rejects(first.start(args, new ClaudeWorkbenchApprovals(), () => {}), /already used/);
    release(); const result = await sending;
    assert.equal((result.link as Record<string, unknown>).last_turn_status, "completed"); assert.equal(count, 1);
    assert.equal(store.list("task_message", 10).length, 0);
    assert.equal(JSON.stringify(store.list("workbench_claude_creation", 10)).includes("secret-message-marker"), false);
    await assert.rejects(first.start(args, new ClaudeWorkbenchApprovals(), () => {}), /already used/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a failed first dispatch retains its key and never claims a native mapping", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-claude-first-"))); const store = await new CraftStore(craftPaths(root)).open(); store.create("task", "t", {});
  const adapter = new ClaudeWorkbenchAdapter(() => ({ async *[Symbol.asyncIterator]() { throw new Error("connection lost"); }, close() {} }));
  const first = new ClaudeFirstTurn(store, adapter); const args = { task_id: "t", workspace: root, permission: "ask" as const, operation_id: "once", executable: join(root, "claude"), prompt: "hello" };
  try {
    await assert.rejects(first.start(args, new ClaudeWorkbenchApprovals(), () => {}), /outcome may be unknown/);
    await assert.rejects(first.start(args, new ClaudeWorkbenchApprovals(), () => {}), /already used/);
    assert.deepEqual(first.links.list("t").links, []);
    assert.equal(store.list("workbench_claude_creation", 10)[0].status, "starting");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a transport ending without an initialization event cannot create a native mapping", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-claude-first-"))); const store = await new CraftStore(craftPaths(root)).open(); store.create("task", "t", {});
  const adapter = new ClaudeWorkbenchAdapter();
  adapter.run = async function* () { yield { type: "result", subtype: "success" } as SDKMessage; };
  const first = new ClaudeFirstTurn(store, adapter);
  try {
    await assert.rejects(first.start({ task_id: "t", workspace: root, permission: "ask", operation_id: "once", executable: join(root, "claude"), prompt: "hello" }, new ClaudeWorkbenchApprovals(), () => {}), (error: Error) => /outcome may be unknown/.test(error.message) && /not established/.test(String(error.cause)));
    assert.deepEqual(first.links.list("t").links, []);
    assert.equal(store.list("workbench_claude_creation", 10)[0].status, "starting");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("disconnect after initialization retains the linked turn as unknown", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-claude-first-"))); const store = await new CraftStore(craftPaths(root)).open(); store.create("task", "t", {});
  const adapter = new ClaudeWorkbenchAdapter(({ options }) => ({ async *[Symbol.asyncIterator]() {
    yield { type: "system", subtype: "init", session_id: options.sessionId, cwd: root, permissionMode: "default", model: "model" } as SDKMessage;
    throw new Error("connection lost");
  }, close() {} }));
  const first = new ClaudeFirstTurn(store, adapter); const args = { task_id: "t", workspace: root, permission: "ask" as const, operation_id: "once", executable: join(root, "claude"), prompt: "hello" };
  try {
    await assert.rejects(first.start(args, new ClaudeWorkbenchApprovals(), () => {}), /outcome may be unknown/);
    const links = first.links.list("t").links as Record<string, unknown>[];
    assert.equal(links.length, 1); assert.equal(links[0].turn_state, "unknown");
    await assert.rejects(first.start(args, new ClaudeWorkbenchApprovals(), () => {}), /already used/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a storage failure while marking an interrupted first turn keeps its reservation", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-claude-first-"))); const store = await new CraftStore(craftPaths(root)).open(); store.create("task", "t", {});
  const adapter = new ClaudeWorkbenchAdapter(({ options }) => ({ async *[Symbol.asyncIterator]() {
    yield { type: "system", subtype: "init", session_id: options.sessionId, cwd: root, permissionMode: "default", model: "model" } as SDKMessage;
    throw new Error("connection lost");
  }, close() {} }));
  const first = new ClaudeFirstTurn(store, adapter); const args = { task_id: "t", workspace: root, permission: "ask" as const, operation_id: "once", executable: join(root, "claude"), prompt: "hello" };
  first.links.markTurnUnknown = () => { throw new Error("storage unavailable"); };
  try {
    await assert.rejects(first.start(args, new ClaudeWorkbenchApprovals(), () => {}), /outcome may be unknown/);
    const links = first.links.list("t").links as Record<string, unknown>[];
    assert.equal(links.length, 1); assert.equal(links[0].turn_state, "running");
    await assert.rejects(first.start(args, new ClaudeWorkbenchApprovals(), () => {}), /already used/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("invalid first-turn input is rejected before a creation key or native process is created", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-claude-first-"))); const store = await new CraftStore(craftPaths(root)).open(); store.create("task", "t", {});
  let invoked = false;
  const first = new ClaudeFirstTurn(store, new ClaudeWorkbenchAdapter(() => { invoked = true; throw new Error("unexpected dispatch"); }));
  const args = { task_id: "t", workspace: root, permission: "ask" as const, operation_id: "once", executable: join(root, "claude"), prompt: "hello" };
  try {
    for (const change of [
      { operation_id: " " }, { operation_id: "x".repeat(257) }, { operation_id: "x\n" },
      { permission: "read_only" as const }, { prompt: " " }, { prompt: "x\0" }, { prompt: "x".repeat(60 * 1024 + 1) },
      { workspace: "relative" }, { executable: "relative" }, { executable: `${root}/bad\0` },
      { model: " " }, { model: "x".repeat(257) }, { model: "x\n" }, { task_id: "missing" },
    ]) assert.throws(() => first.prepare({ ...args, ...change }));
    assert.equal(invoked, false);
    assert.equal(store.list("workbench_claude_creation", 10).length, 0);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a prepared operation dispatches only once and records a native failure", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-claude-first-"))); const store = await new CraftStore(craftPaths(root)).open(); store.create("task", "t", {});
  let count = 0;
  const adapter = new ClaudeWorkbenchAdapter(({ options }) => ({ async *[Symbol.asyncIterator]() {
    count++;
    yield { type: "system", subtype: "init", session_id: options.sessionId, cwd: root, permissionMode: "default", model: "model" } as SDKMessage;
    yield { type: "result", subtype: "error_during_execution", is_error: true, session_id: options.sessionId } as SDKMessage;
  }, close() {} }));
  const first = new ClaudeFirstTurn(store, adapter);
  const execute = first.prepare({ task_id: "t", workspace: root, permission: "ask", operation_id: "once", executable: join(root, "claude"), prompt: "hello" });
  try {
    const result = await execute(new ClaudeWorkbenchApprovals(), () => {});
    assert.equal((result.link as Record<string, unknown>).last_turn_status, "failed");
    assert.throws(() => execute(new ClaudeWorkbenchApprovals(), () => {}), /already started/);
    assert.equal(count, 1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("reservation failure never starts Claude and distinguishes a competing key from a storage error", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-claude-first-"))); const store = await new CraftStore(craftPaths(root)).open(); store.create("task", "t", {});
  const first = new ClaudeFirstTurn(store, new ClaudeWorkbenchAdapter(() => { throw new Error("unexpected launch"); }));
  const args = { task_id: "t", workspace: root, permission: "ask" as const, operation_id: "once", executable: join(root, "claude"), prompt: "hello" };
  const create = store.create.bind(store);
  try {
    store.create = ((kind: string, id: string, value: Record<string, unknown>) => {
      if (kind === "workbench_claude_creation") { create(kind, id, value); throw new Error("simulated competing insert"); }
      return create(kind, id, value);
    }) as typeof store.create;
    assert.throws(() => first.prepare(args), /already used/);
    store.create = ((kind: string, id: string, value: Record<string, unknown>) => {
      if (kind === "workbench_claude_creation") throw new Error("storage unavailable");
      return create(kind, id, value);
    }) as typeof store.create;
    assert.throws(() => first.prepare({ ...args, operation_id: "other" }), /storage unavailable/);
    assert.deepEqual(first.links.list("t").links, []);
  } finally { store.create = create; store.close(); rmSync(root, { recursive: true, force: true }); }
});
