import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { WorkbenchAgentSessionLinks } from "../core/application/use-cases/workbench-agent-session-links.ts";
import { ClaudeWorkbenchAdapter } from "../core/interfaces/claude-workbench-adapter.ts";
import { ClaudeWorkbenchApprovals } from "../core/interfaces/claude-workbench-approvals.ts";
import { ClaudeLinkedTurn } from "../core/interfaces/claude-linked-turn.ts";
import { WorkbenchMessageQueue } from "../core/interfaces/workbench-message-queue.ts";
import { reconcileQueueItem } from "../core/interfaces/workbench-queue-recovery.ts";

test("Claude resumed turn uses the updated session configuration", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-claude-config-"))), store = await new CraftStore(craftPaths(root)).open();
  const id = "12345678-1234-1234-1234-123456789012"; store.create("task", "task", {});
  const links = new WorkbenchAgentSessionLinks(store), link = links.bind({ task_id: "task", provider: "claude", native_session_id: id, workspace: root, model: "old", permission: "ask" }).link as Record<string, unknown>;
  let options: any;
  const adapter = new ClaudeWorkbenchAdapter(args => { options = args.options; return { async *[Symbol.asyncIterator]() { yield { type: "system", subtype: "init", session_id: id, cwd: root, model: "new-model", permissionMode: "bypassPermissions" } as SDKMessage; yield { type: "result", subtype: "success", session_id: id } as SDKMessage; }, close() {} }; });
  try { links.configure("task", link.id, "new-model", "full"); await new ClaudeLinkedTurn(links, adapter, "task", String(link.id)).send("hello", join(root, "claude"), true, new ClaudeWorkbenchApprovals(), () => {}); assert.equal(options.resume, id); assert.equal(options.model, "new-model"); assert.equal(options.permissionMode, "bypassPermissions"); }
  finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Claude turn is reserved before dispatch and completes only on a matching native result", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-claude-linked-"))); const store = await new CraftStore(craftPaths(root)).open();
  const id = "12345678-1234-1234-1234-123456789012"; store.create("task", "task", {});
  const links = new WorkbenchAgentSessionLinks(store); const link = links.bind({ task_id: "task", provider: "claude", native_session_id: id, workspace: root, permission: "ask" }).link as Record<string, unknown>;
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); let wrong = false;
  const adapter = new ClaudeWorkbenchAdapter(() => ({ async *[Symbol.asyncIterator]() {
    yield { type: "system", subtype: "init", session_id: id, cwd: root, permissionMode: "default", model: "model" } as SDKMessage;
    await wait;
    yield { type: "result", subtype: "success", session_id: wrong ? "other" : id } as SDKMessage;
  }, close() {} }));
  try {
    const runner = new ClaudeLinkedTurn(links, adapter, "task", String(link.id)); const observed: string[] = [];
    await assert.rejects(runner.send(" ", join(root, "claude"), false, new ClaudeWorkbenchApprovals(), () => {}), /prompt is invalid/);
    const sending = runner.send("sensitive-prompt-marker", join(root, "claude"), false, new ClaudeWorkbenchApprovals(), event => observed.push(event.type));
    assert.equal(links.get("task", link.id).turn_state, "starting");
    await assert.rejects(runner.send("second", join(root, "claude"), true, new ClaudeWorkbenchApprovals(), () => {}), /unsettled/);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(links.get("task", link.id).turn_state, "running");
    assert.equal(store.list("workbench_claude_submission", 10)[0].status, "reserved", "initialization alone is not prompt acceptance");
    release(); await sending;
    assert.equal(links.get("task", link.id).last_turn_status, "completed"); assert.deepEqual(observed, ["system", "result"]);
    assert.equal(store.list("workbench_claude_submission", 10)[0].status, "accepted");
    assert.equal(store.list("task_message", 100).length, 0); assert.equal(JSON.stringify(links.list("task")).includes("sensitive-prompt-marker"), false);
    wrong = true;
    await assert.rejects(runner.send("another", join(root, "claude"), true, new ClaudeWorkbenchApprovals(), () => {}), /outcome may be unknown/);
    assert.equal(links.get("task", link.id).turn_state, "unknown");
    await assert.rejects(runner.send("retry", join(root, "claude"), true, new ClaudeWorkbenchApprovals(), () => {}), /unsettled/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Claude assistant acknowledgement survives a lost page callback without claiming a completed native turn", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-claude-ack-")));
  const store = await new CraftStore(craftPaths(root)).open(); store.create("task", "task", {});
  const session = "12345678-1234-1234-1234-123456789012";
  const queue = new WorkbenchMessageQueue(store);
  const link = queue.links.bind({ task_id: "task", provider: "claude", native_session_id: session, workspace: root, permission: "ask" }).link as Record<string, unknown>;
  const item = queue.enqueue("task", String(link.id), "private queued prompt");
  queue.claim("task", String(link.id), String(item.id));
  const adapter = new ClaudeWorkbenchAdapter(() => ({ async *[Symbol.asyncIterator]() {
    yield { type: "system", subtype: "init", session_id: session, cwd: root, permissionMode: "default", model: "model" } as SDKMessage;
    yield { type: "assistant", session_id: session } as SDKMessage;
    yield { type: "result", subtype: "success", session_id: session } as SDKMessage;
  }, close() {} }));
  try {
    const start = new ClaudeLinkedTurn(queue.links, adapter, "task", String(link.id)).prepare(String(item.prompt), join(root, "claude"), true, String(item.operation_id));
    await assert.rejects(start(new ClaudeWorkbenchApprovals(), event => { if (event.type === "assistant") throw new Error("page connection lost"); }), /outcome may be unknown/);
    queue.settle("task", String(link.id), String(item.id), false);
    const uncertain = store.get("workbench_message_queue", String(item.id));
    const result = await reconcileQueueItem(store, "task", String(link.id), String(item.id), uncertain.version, "inspect");
    assert.equal(result.outcome, "accepted"); assert.equal(result.session_state, "unknown");
    assert.equal(queue.links.get("task", String(link.id)).turn_state, "unknown");
    assert.doesNotMatch(JSON.stringify(result), /private queued prompt/);
    assert.equal(store.list("task_message", 10).length, 0);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("additional Claude assistant events do not reserve the writer again after the first acknowledgement", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-claude-ack-locks-")));
  const store = await new CraftStore(craftPaths(root)).open(); store.create("task", "task", {});
  const session = "12345678-1234-1234-1234-123456789012", links = new WorkbenchAgentSessionLinks(store);
  const link = links.bind({ task_id: "task", provider: "claude", native_session_id: session, workspace: root, permission: "ask" }).link as Record<string, unknown>;
  const adapter = new ClaudeWorkbenchAdapter(() => ({ async *[Symbol.asyncIterator]() {
    yield { type: "system", subtype: "init", session_id: session, cwd: root, permissionMode: "default", model: "model" } as SDKMessage;
    for (let i = 0; i < 3; i++) yield { type: "assistant", session_id: session } as SDKMessage;
    yield { type: "result", subtype: "success", session_id: session } as SDKMessage;
  }, close() {} }));
  const original = store.transaction; let transactions = 0; const observed: number[] = [];
  store.transaction = function(this: CraftStore, operation) { transactions++; return original.call(this, operation); } as typeof store.transaction;
  try {
    await new ClaudeLinkedTurn(links, adapter, "task", String(link.id)).send("hello", join(root, "claude"), true, new ClaudeWorkbenchApprovals(), event => { if (event.type === "assistant") observed.push(transactions); });
    assert.equal(observed.length, 3); assert.equal(new Set(observed).size, 1);
    assert.equal(store.list("workbench_claude_submission", 10)[0].version, 2);
    assert.equal(links.get("task", link.id).turn_state, "idle");
  } finally { store.transaction = original; store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Claude linked turns reject other providers and record native failure", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-claude-failure-"))); const store = await new CraftStore(craftPaths(root)).open();
  store.create("task", "task", {}); const links = new WorkbenchAgentSessionLinks(store);
  const id = "12345678-1234-1234-1234-123456789012";
  const claude = links.bind({ task_id: "task", provider: "claude", native_session_id: id, workspace: root, permission: "ask" }).link as Record<string, unknown>;
  const codex = links.bind({ task_id: "task", provider: "codex", native_session_id: "other", workspace: root, permission: "ask" }).link as Record<string, unknown>;
  const adapter = new ClaudeWorkbenchAdapter(() => ({ async *[Symbol.asyncIterator]() {
    yield { type: "system", subtype: "init", session_id: id, cwd: root, permissionMode: "default", model: "model" } as SDKMessage;
    yield { type: "result", subtype: "success", is_error: true, session_id: id } as SDKMessage;
  }, close() {} }));
  try {
    assert.throws(() => new ClaudeLinkedTurn(links, adapter, "task", String(codex.id)), /not Claude/);
    const runner = new ClaudeLinkedTurn(links, adapter, "task", String(claude.id));
    await runner.send("hello", join(root, "claude"), false, new ClaudeWorkbenchApprovals(), () => {});
    assert.equal(links.get("task", claude.id).last_turn_status, "failed");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a storage error during uncertainty handling does not claim the turn is safe to retry", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-claude-storage-"))); const store = await new CraftStore(craftPaths(root)).open();
  store.create("task", "task", {}); const links = new WorkbenchAgentSessionLinks(store);
  const link = links.bind({ task_id: "task", provider: "claude", native_session_id: "12345678-1234-1234-1234-123456789012", workspace: root, permission: "ask" }).link as Record<string, unknown>;
  const adapter = new ClaudeWorkbenchAdapter(() => ({ async *[Symbol.asyncIterator]() { throw new Error("transport lost"); }, close() {} }));
  try {
    const runner = new ClaudeLinkedTurn(links, adapter, "task", String(link.id));
    links.markTurnUnknown = () => { throw new Error("store unavailable"); };
    await assert.rejects(runner.send("hello", join(root, "claude"), false, new ClaudeWorkbenchApprovals(), () => {}), /outcome may be unknown/);
    assert.equal(links.get("task", link.id).turn_state, "starting");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("invalid and repeated linked submissions cannot dispatch another native turn", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-claude-input-"))); const store = await new CraftStore(craftPaths(root)).open();
  store.create("task", "task", {}); const links = new WorkbenchAgentSessionLinks(store);
  const id = "12345678-1234-1234-1234-123456789012";
  const link = links.bind({ task_id: "task", provider: "claude", native_session_id: id, workspace: root, permission: "ask" }).link as Record<string, unknown>;
  let launches = 0;
  const adapter = new ClaudeWorkbenchAdapter(() => ({ async *[Symbol.asyncIterator]() {
    launches++;
    yield { type: "system", subtype: "init", session_id: id, cwd: root, permissionMode: "default", model: "model" } as SDKMessage;
    yield { type: "result", subtype: "success", session_id: id } as SDKMessage;
  }, close() {} }));
  const runner = new ClaudeLinkedTurn(links, adapter, "task", String(link.id));
  try {
    for (const prompt of [" ", "a\0b", "x".repeat(60 * 1024 + 1)]) assert.throws(() => runner.prepare(prompt, join(root, "claude"), true, "id"), /prompt/);
    for (const executable of ["relative", `${root}/bad\0`]) assert.throws(() => runner.prepare("hello", executable, true, "id"), /executable/);
    for (const operation of [" ", "x\n", "x".repeat(257)]) assert.throws(() => runner.prepare("hello", join(root, "claude"), true, operation), /operation_id/);
    const readOnly = links.bind({ task_id: "task", provider: "claude", native_session_id: "12345678-1234-1234-1234-123456789013", workspace: root, permission: "read_only" }).link as Record<string, unknown>;
    assert.throws(() => new ClaudeLinkedTurn(links, adapter, "task", String(readOnly.id)).prepare("hello", join(root, "claude"), true, "id"), /read-only/);
    assert.equal(store.list("workbench_claude_submission", 10).length, 0);
    const run = runner.prepare("hello", join(root, "claude"), true, "id");
    await run(new ClaudeWorkbenchApprovals(), () => {});
    assert.throws(() => run(new ClaudeWorkbenchApprovals(), () => {}), /already started/);
    assert.throws(() => runner.prepare("hello", join(root, "claude"), true, "id"), /already used/);
    assert.equal(launches, 1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
