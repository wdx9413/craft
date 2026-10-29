import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClaudeWorkbenchAdapter } from "../core/interfaces/claude-workbench-adapter.ts";
import { ClaudeWorkbenchApprovals } from "../core/interfaces/claude-workbench-approvals.ts";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

test("Claude accepts the CLI normalized context suffix on the selected model", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-claude-model-case-")));
  const id = "12345678-1234-1234-1234-123456789012";
  const adapter = new ClaudeWorkbenchAdapter(() => ({ async *[Symbol.asyncIterator]() {
    yield { type: "system", subtype: "init", session_id: id, cwd: root, permissionMode: "default", model: "deepseek-v4-flash[1m]" } as SDKMessage;
    yield { type: "result", subtype: "success", session_id: id } as SDKMessage;
  }, close() {} }));
  try {
    const events = []; for await (const event of adapter.run({ sessionId: id, workspace: root, prompt: "test", model: "deepseek-v4-flash[1M]", resume: false, permission: "ask", executable: join(root, "claude") }, new ClaudeWorkbenchApprovals())) events.push(event);
    assert.equal(events.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Claude plan mode is passed to the CLI and checked on initialization", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-claude-plan-"))), id = "12345678-1234-1234-1234-123456789012"; let options: Options | undefined;
  const adapter = new ClaudeWorkbenchAdapter(args => { options = args.options; return { async *[Symbol.asyncIterator]() { yield { type: "system", subtype: "init", session_id: id, cwd: root, permissionMode: "plan", model: "model" } as SDKMessage; yield { type: "result", subtype: "success", session_id: id } as SDKMessage; }, close() {} }; });
  try {
    for await (const _ of adapter.run({ sessionId: id, workspace: root, prompt: "plan", model: "model", resume: false, permission: "full", workMode: "plan", executable: join(root, "claude") }, new ClaudeWorkbenchApprovals())) {}
    assert.equal(options?.permissionMode, "plan"); assert.equal(options?.allowDangerouslySkipPermissions, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Claude adapter streams one native session with default permissions and closes its transport", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-claude-adapter-")));
  const id = "12345678-1234-1234-1234-123456789012"; let closed = 0; let received: Options | undefined;
  const events = [{ type: "system", subtype: "init", session_id: id, cwd: root, permissionMode: "default", model: "model" }, { type: "stream_event", session_id: id }, { type: "result", subtype: "success", session_id: id }] as SDKMessage[];
  const adapter = new ClaudeWorkbenchAdapter(({ options }) => { received = options; return { async *[Symbol.asyncIterator]() { yield* events; }, close() { closed++; } }; });
  const turn = { sessionId: id, workspace: root, prompt: "hello", model: "model", resume: false, permission: "ask" as const, executable: join(root, "claude") };
  try {
    const result = []; for await (const event of adapter.run(turn, new ClaudeWorkbenchApprovals())) result.push(event);
    assert.equal(result.length, 3); assert.equal(closed, 1); assert.equal(received?.sessionId, id); assert.equal(received?.resume, undefined);
    assert.equal(received?.permissionMode, "default"); assert.deepEqual(received?.settingSources, ["user", "project", "local"]); assert.equal(received?.persistSession, true);
    for await (const _ of adapter.run({ ...turn, resume: true }, new ClaudeWorkbenchApprovals())) { /* consume */ }
    assert.equal(received?.resume, id); assert.equal(received?.sessionId, undefined);
    for await (const _ of adapter.run({ ...turn, model: null }, new ClaudeWorkbenchApprovals())) { /* default model */ }
    await assert.rejects(async () => { for await (const _ of adapter.run({ ...turn, permission: "read_only" }, new ClaudeWorkbenchApprovals())) {} }, /not yet verified/);
    events[0] = { ...events[0], session_id: "wrong" } as SDKMessage;
    await assert.rejects(async () => { for await (const _ of adapter.run(turn, new ClaudeWorkbenchApprovals())) {} }, /different session/);
    assert.equal(closed, 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Claude adapter rejects invalid inputs and incomplete or mismatched native events", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-claude-invalid-")));
  const id = "12345678-1234-1234-1234-123456789012";
  const turn = { sessionId: id, workspace: root, prompt: "hello", model: "model", resume: false, permission: "ask" as const, executable: join(root, "claude") };
  const init = { type: "system", subtype: "init", session_id: id, cwd: root, permissionMode: "default", model: "model" };
  let events: unknown[] = []; let closed = 0;
  const adapter = new ClaudeWorkbenchAdapter(() => ({ async *[Symbol.asyncIterator]() { yield* events as SDKMessage[]; }, close() { closed++; } }));
  const run = async (args = turn) => { for await (const _ of adapter.run(args, new ClaudeWorkbenchApprovals())) {} };
  try {
    for (const [change, error] of [
      [{ sessionId: "invalid" }, /session id/], [{ workspace: "relative" }, /absolute/], [{ workspace: join(root, "file") }, /directory/],
      [{ executable: "claude" }, /absolute/], [{ prompt: "" }, /prompt/], [{ model: "bad\nmodel" }, /model/],
    ] as Array<[Record<string, string>, RegExp]>) {
      if (change.workspace?.endsWith("file")) { const { writeFileSync } = await import("node:fs"); writeFileSync(change.workspace, ""); }
      await assert.rejects(run({ ...turn, ...change }), error);
    }
    events = [{ type: "stream_event", session_id: id }]; await assert.rejects(run(), /initialization event/);
    events = [{ ...init, permissionMode: "bypassPermissions" }]; await assert.rejects(run(), /effective settings/);
    events = [{ ...init, model: "other" }]; await assert.rejects(run(), /effective settings/);
    events = [init]; await assert.rejects(run(), /outcome is unknown/);
    events = []; await assert.rejects(run(), /outcome is unknown/);
    events = ["hook_started", "hook_progress", "hook_response"].map(subtype => ({ type: "system", subtype, session_id: id }));
    events.push(init, { type: "result", subtype: "success", session_id: id }); await run();
    events = [{ type: "system", subtype: "hook_started", session_id: "wrong" }]; await assert.rejects(run(), /different session/);
    assert.equal(closed, 7);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('full access explicitly requests and verifies Claude bypass permissions', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'craft-claude-full-')));
  const id = '12345678-1234-1234-1234-123456789012'; let received: Options | undefined; let mode = 'bypassPermissions';
  const adapter = new ClaudeWorkbenchAdapter(({ options }) => { received = options; return { async *[Symbol.asyncIterator]() { yield { type: 'system', subtype: 'init', session_id: id, cwd: root, permissionMode: mode, model: 'model' } as SDKMessage; yield { type: 'result', subtype: 'success', session_id: id } as SDKMessage; }, close() {} }; });
  const turn = { sessionId: id, workspace: root, prompt: 'hello', model: 'model', resume: false, permission: 'full' as const, executable: join(root, 'claude') };
  const run = async () => { for await (const _ of adapter.run(turn, new ClaudeWorkbenchApprovals())) {} };
  try {
    await run(); assert.equal(received?.permissionMode, 'bypassPermissions'); assert.equal(received?.allowDangerouslySkipPermissions, true);
    mode = 'default'; await assert.rejects(run(), /effective settings/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('automatic mode requests and verifies Claude classifier and accepts CLI model aliases', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'craft-claude-auto-')));
  const id = '12345678-1234-1234-1234-123456789012'; let received: Options | undefined; let mode = 'auto';
  const adapter = new ClaudeWorkbenchAdapter(({ options }) => { received = options; return { async *[Symbol.asyncIterator]() { yield { type:'system', subtype:'init', session_id:id, cwd:root, permissionMode:mode, model:'actual-model' } as SDKMessage; yield { type:'result', subtype:'success', session_id:id } as SDKMessage; }, close() {} }; });
  const turn = { sessionId:id, workspace:root, prompt:'hello', model:'sonnet', resume:false, permission:'auto' as const, executable:join(root,'claude') };
  const run = async () => { for await (const _ of adapter.run(turn, new ClaudeWorkbenchApprovals())) {} };
  try { await run(); assert.equal(received?.permissionMode, 'auto'); mode = 'default'; await assert.rejects(run(), /effective settings/); }
  finally { rmSync(root, {recursive:true,force:true}); }
});
