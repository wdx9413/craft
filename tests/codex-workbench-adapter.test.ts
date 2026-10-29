import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexWorkbenchAdapter } from "../core/interfaces/codex-workbench-adapter.ts";

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "craft-codex-adapter-")));
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const answers: Record<string, unknown> = {
    "thread/start": { thread: { id: "thread", ephemeral: false }, cwd: dir, model: "model", sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false }, approvalPolicy: "on-request", approvalsReviewer: "user" },
    "thread/resume": { thread: { id: "thread", ephemeral: false }, cwd: dir, model: "model", sandbox: { type: "workspaceWrite" }, approvalPolicy: "on-request", approvalsReviewer: "user" },
    "turn/start": { turn: { id: "turn" } }, "thread/read": { thread: { id: "thread", turns: [{ items: [] }] } }, "turn/interrupt": {},
  };
  const decisions: unknown[] = [];
  const rpc = { request: async (method: string, params: Record<string, unknown>) => { calls.push({ method, params }); return answers[method]; }, respond: (id: string | number, value: Record<string, unknown>) => { decisions.push({ id, value }); } };
  return { dir, calls, answers, decisions, adapter: new CodexWorkbenchAdapter(rpc), options: { workspace: dir, model: "model", permission: "ask" as const } };
}

test("creates and resumes a persistent native thread, starts turns and returns native history", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.adapter.start(f.options), { thread_id: "thread", model: "model", workspace: f.dir, sandbox: "workspace-write", approval_policy: "on-request" });
    assert.equal((await f.adapter.resume("thread", f.options)).thread_id, "thread");
    assert.deepEqual(await f.adapter.send("thread", "hello\nworld"), { turn_id: "turn" });
    assert.deepEqual(await f.adapter.history("thread"), { id: "thread", turns: [{ items: [] }] });
    await f.adapter.interrupt("thread", "turn");
    f.adapter.decide("approval", "accept"); f.adapter.decide(2, "decline");
    assert.deepEqual(f.decisions, [{ id: "approval", value: { decision: "accept" } }, { id: 2, value: { decision: "decline" } }]);
    assert.deepEqual(f.calls[0].params, { cwd: f.dir, model: "model", sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "user", ephemeral: false });
    assert.deepEqual(f.calls[2].params, { threadId: "thread", input: [{ type: "text", text: "hello\nworld" }] });
    assert.deepEqual(f.calls[4].params, { threadId: "thread", turnId: "turn" });
    (f.answers["thread/start"] as Record<string, unknown>).approvalPolicy = "never";
    (f.answers["thread/start"] as Record<string, unknown>).sandbox = { type: "readOnly" };
    assert.equal((await f.adapter.start({ workspace: f.dir, permission: "read_only" })).approval_policy, "never");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("rejects invalid input and provider permission, identity, workspace or persistence drift", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, "file"), "x");
    for (const patch of [{ workspace: "relative" }, { workspace: join(f.dir, "file") }, { model: " " }, { permission: "other" }]) await assert.rejects(f.adapter.start({ ...f.options, ...patch } as typeof f.options));
    for (const value of [null, [], {}, { thread: null }, { thread: { id: "", ephemeral: false } }]) { f.answers["thread/start"] = value; await assert.rejects(f.adapter.start(f.options)); }
    const good = { thread: { id: "thread", ephemeral: false }, cwd: f.dir, model: "model", sandbox: { type: "workspaceWrite" }, approvalPolicy: "on-request", approvalsReviewer: "user" };
    for (const patch of [{ thread: { id: "thread", ephemeral: true } }, { sandbox: null }, { sandbox: { type: "readOnly" } }, { sandbox: { type: "workspaceWrite", networkAccess: true } }, { sandbox: { type: "workspaceWrite", networkAccess: "unknown" } }, { sandbox: { type: "workspaceWrite", writableRoots: [tmpdir()] } }, { sandbox: { type: "workspaceWrite", writableRoots: "invalid" } }, { approvalPolicy: "never" }, { cwd: 1 }, { cwd: tmpdir() }, { model: "" }, { model: "different" }]) { f.answers["thread/start"] = { ...good, ...patch }; await assert.rejects(f.adapter.start(f.options)); }
    f.answers["thread/resume"] = { ...good, thread: { id: "different", ephemeral: false } };
    await assert.rejects(f.adapter.resume("thread", f.options), /different thread/);
    await assert.rejects(f.adapter.resume("", f.options));
    for (const prompt of [" ", "bad\0text", "x".repeat(61441)]) await assert.rejects(f.adapter.send("thread", prompt));
    await assert.rejects(f.adapter.send("", "hello"));
    f.answers["turn/start"] = { turn: {} }; await assert.rejects(f.adapter.send("thread", "hello"));
    f.answers["thread/read"] = { thread: { id: "other" } }; await assert.rejects(f.adapter.history("thread"), /different thread/);
    await assert.rejects(f.adapter.interrupt("thread", ""));
    assert.throws(() => f.adapter.decide("id", "other" as "accept"), /Unsupported/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('full access is explicit, persisted by the provider, and rejects permission drift', async () => {
  const f = fixture();
  try {
    const full = { ...f.options, permission: 'full' as const };
    f.answers['thread/start'] = { thread: { id: 'thread', ephemeral: false }, cwd: f.dir, model: 'model', sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'never' };
    assert.equal((await f.adapter.start(full)).sandbox, 'danger-full-access');
    assert.equal(f.calls[0].params.sandbox, 'danger-full-access'); assert.equal(f.calls[0].params.approvalPolicy, 'never');
    (f.answers['thread/start'] as any).sandbox = { type: 'workspaceWrite' };
    await assert.rejects(f.adapter.start(full), /permissions do not match/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('automatic approval uses Codex auto review and verifies the effective reviewer', async () => {
  const f = fixture();
  try {
    f.answers['thread/start'] = { thread: { id: 'thread', ephemeral: false }, cwd: f.dir, model: 'model', sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false }, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' };
    const result = await f.adapter.start({ ...f.options, permission: 'auto' });
    assert.equal(result.sandbox, 'workspace-write'); assert.equal(result.approval_policy, 'on-request');
    assert.equal(f.calls[0].params.approvalsReviewer, 'auto_review');
    (f.answers['thread/start'] as any).approvalsReviewer = 'user';
    await assert.rejects(f.adapter.start({ ...f.options, permission: 'auto' }), /permissions do not match/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
