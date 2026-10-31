import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { codexGroupHasSessionFile, codexProcessIdentity, externalCodexOwner, isCraftCodexCommand } from "../core/interfaces/codex-process-owner.ts";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { CodexWorkbenchSessions } from "../core/interfaces/codex-workbench-sessions.ts";
import { type CodexServerEvent } from "../core/interfaces/codex-app-server-client.ts";

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-sessions-")));
  const store = await new CraftStore(craftPaths(root)).open(); store.create("task", "task", {}); store.create("task", "other", {});
  const clients: Array<{ emit: (event: CodexServerEvent) => void; resolve: (value: unknown) => void; reject: (error: Error) => void; decisions: unknown[]; closed: boolean; calls: string[] }> = [];
  const sessions = new CodexWorkbenchSessions(store, emit => {
    const fake = { emit, resolve: (_value: unknown) => {}, reject: (_error: Error) => {}, decisions: [] as unknown[], closed: false, calls: [] as string[] };
    clients.push(fake);
    return { initialize: async () => ({}), close: () => { if (!fake.closed) { fake.closed = true; emit({ type: "closed", error: "closed" }); } },
      respond: (id, result) => { fake.decisions.push({ id, result }); },
      request: async (method, params) => { fake.calls.push(method);
        if (method === "skills/list") return { data: [{ cwd: root, skills: [{ name: "inspect", path: join(root, "SKILL.md"), enabled: true, description: "inspect" }] }] };
        if (method === "thread/list") return { data: [{ id: "old-native", cwd: root, name: "Earlier work", preview: "private", ephemeral: false, updatedAt: 10 }], nextCursor: "next" };
        if (method === "thread/read" && params.includeTurns === false) return { thread: { id: params.threadId, cwd: root, model: "model", ephemeral: false } };
        if (method === "thread/start" || method === "thread/resume") return { thread: { id: "native", ephemeral: false }, cwd: root, model: "model", sandbox: { type: params.sandbox === "workspace-write" ? "workspaceWrite" : "readOnly" }, approvalPolicy: params.approvalPolicy, approvalsReviewer: params.approvalsReviewer };
        if (method === "turn/start") return new Promise((resolve, reject) => { fake.resolve = resolve; fake.reject = reject; });
        if (method === "account/rateLimits/read") return { accountId: "private-account", rateLimits: { primary: { usedPercent: 30 } }, rateLimitsByLimitId: null };
        return {};
      } };
  });
  return { root, store, sessions, clients, options: { task_id: "task", workspace: root, model: "model", permission: "ask" as const, operation_id: "create-1" }, cleanup: () => { sessions.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}
const notification = (method: string, params: unknown): CodexServerEvent => ({ type: "notification", method, params });
const approval = (id: string, turnId = "turn"): CodexServerEvent => ({ type: "request", id, method: "item/commandExecution/requestApproval", params: { threadId: "native", turnId, command: "echo ok" } });

test("Craft app-server commands are distinguishable from other Codex CLI listeners", () => {
  assert.equal(isCraftCodexCommand("codex.exe app-server --listen stdio://"), true);
  assert.equal(isCraftCodexCommand("/usr/local/bin/codex app-server --listen unix:///tmp/craft.sock"), true);
  assert.equal(isCraftCodexCommand("C:\\codex.exe -c features.code_mode_host=true app-server --analytics-default-enabled"), false);
  assert.equal(isCraftCodexCommand("codex app-server"), false);
  assert.equal(isCraftCodexCommand(null), false);
});

test("discovers and verifies native sessions before linking them", async () => {
  const f = await fixture();
  try {
    const first = await f.sessions.nativeSessions();
    assert.equal((first.threads as any[])[0].title, "Earlier work"); assert.equal(first.next_cursor, "next");
    assert.equal(f.clients[0].closed, true);
    await assert.rejects(f.sessions.nativeSessions("\n"), /cursor is invalid/);
    await assert.rejects(f.sessions.importNative("task", "../other"), /thread id is invalid/);
    await assert.rejects(f.sessions.importNative("missing", "old-native"));
    const linked = (await f.sessions.importNative("task", "old-native")).link as Record<string, unknown>;
    assert.equal(linked.native_session_id, "old-native"); assert.equal(linked.permission, "ask");
    const listed = await f.sessions.nativeSessions("next");
    assert.equal((listed.threads as any[])[0].linked_id, linked.id);
    await assert.rejects(f.sessions.importNative("other", "old-native"), /already linked/);
  } finally { f.cleanup(); }
});

test("selected Codex skill is sent as a native structured input", async () => {
  const f = await fixture();
  try {
    const link = (await f.sessions.create(f.options)).link as Record<string, unknown>;
    const live = (f.sessions as any).live.get(String(link.id)); const original = live.client.request;
    let sent: any;
    live.client.request = (method: string, params: any) => { if (method === 'turn/start') sent = params; return original(method, params); };
    const pending = f.sessions.send('task', String(link.id), '$inspect check', 'skill-send');
    while (!sent) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(sent.input[1], { type: 'skill', name: 'inspect', path: join(f.root, 'SKILL.md') });
    f.clients[0].resolve({ turn: { id: 'turn' } }); await pending;
  } finally { f.cleanup(); }
});

test("Codex work mode is sent per turn using the session model", async () => {
  const f = await fixture();
  try {
    const link = (await f.sessions.create(f.options)).link as Record<string, unknown>, live = (f.sessions as any).live.get(String(link.id)), original = live.client.request;
    let params: any; live.client.request = (method: string, value: any) => { if (method === "turn/start") params = value; return original(method, value); };
    await assert.rejects(f.sessions.send("task", String(link.id), "test", "bad", "unsafe"), /mode/);
    f.sessions.links.configure("task", String(link.id), "model-two", "full");
    const sending = f.sessions.send("task", String(link.id), "plan", "plan", "plan");
    assert.deepEqual(params.collaborationMode, { mode: "plan", settings: { model: "model-two" } });
    assert.equal(params.model, "model-two"); assert.deepEqual(params.sandboxPolicy, { type: "dangerFullAccess" }); assert.equal(params.approvalPolicy, "never");
    f.clients[0].resolve({ turn: { id: "turn" } }); await sending;
  } finally { f.cleanup(); }
});

test("external takeover rechecks process identity and reported session count", { skip: process.platform !== "darwin" && process.platform !== "linux" }, async () => {
  const f = await fixture(); const oldHome = process.env.CODEX_HOME; process.env.CODEX_HOME = f.root;
  const locks = join(f.root, "thread-writer-locks"); mkdirSync(locks); const lock = join(locks, "external.lock"); writeFileSync(lock, "");
  const executable = join(f.root, "codex"); symlinkSync(process.execPath, executable);
  const child = spawn(executable, ["-e", "require('fs').openSync(process.argv[1], 'r'); setInterval(() => {}, 1000)", lock], { stdio: "ignore" });
  try {
    let owner: Record<string, unknown> | null = null;
    for (let i = 0; i < 40 && !owner; i++) { await new Promise(resolve => setTimeout(resolve, 25)); owner = externalCodexOwner("external"); }
    assert.ok(owner); assert.equal(owner.pid, child.pid); assert.equal(owner.session_count, 1);
    const link = (await f.sessions.importNative("task", "external")).link as Record<string, unknown>;
    const candidate = f.sessions.takeoverCandidate("task", String(link.id)); assert.equal(candidate.source, "external");
    await assert.rejects(f.sessions.takeover("task", String(link.id), candidate.pid, candidate.started, 2), /数量已变化/);
    assert.deepEqual(await f.sessions.takeover("task", String(link.id), candidate.pid, candidate.started, 1), { stopped: true });
  } finally { child.kill("SIGKILL"); if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome; f.cleanup(); }
});

test("takeover checks the recorded Craft process identity and stops only its process group", { skip: process.platform !== "darwin" && process.platform !== "linux" }, async () => {
  const f = await fixture();
  const oldHome = process.env.CODEX_HOME; process.env.CODEX_HOME = f.root;
  const locks = join(f.root, "thread-writer-locks"); mkdirSync(locks); const lock = join(locks, "native.lock"); writeFileSync(lock, "");
  const child = spawn(process.execPath, ["-e", "require('fs').openSync(process.argv[1], 'r'); setInterval(() => {}, 1000)", lock, "codex", "app-server"], { detached: true, stdio: "ignore" });
  try {
    const id = String(((await f.sessions.create(f.options)).link as Record<string, unknown>).id);
    f.clients[0].emit({ type: "closed", error: "lost" });
    const identity = codexProcessIdentity(child.pid); assert.ok(identity);
    for (let i = 0; i < 30 && !codexGroupHasSessionFile(identity, "native"); i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(codexGroupHasSessionFile(identity, "native"), true);
    const internal = f.sessions as unknown as { live: Map<string, { client: { process: typeof child } }>; rememberOwner: (live: unknown) => void };
    const live = internal.live.get(id)!; live.client.process = child; internal.rememberOwner(live);
    const candidate = f.sessions.takeoverCandidate("task", id);
    assert.equal(candidate.available, true); assert.equal(candidate.pid, child.pid);
    await assert.rejects(f.sessions.takeover("task", id, child.pid, "wrong start time"), /身份已变化/);
    assert.throws(() => f.sessions.takeoverCandidate("other", id), /does not belong/);
    assert.deepEqual(await f.sessions.takeover("task", id, candidate.pid, candidate.started), { stopped: true });
    assert.equal(f.sessions.takeoverCandidate("task", id).available, false);
  } finally { if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome; try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch {} f.cleanup(); }
});

test("usage reads native limits without returning account identity", async () => {
  const f = await fixture();
  try {
    const usage = await f.sessions.usage();
    assert.deepEqual(usage.rate_limits, { primary: { usedPercent: 30 } });
    assert.equal(JSON.stringify(usage).includes("private-account"), false);
    assert.equal(f.clients[0].closed, true);
  } finally { f.cleanup(); }
});

test("goal actions use the connected task and reject invalid objectives", async () => {
  const f = await fixture();
  try {
    const id = String(((await f.sessions.create(f.options)).link as Record<string, unknown>).id);
    await f.sessions.goal("task", id); await f.sessions.goal("task", id, "finish the task");
    assert.ok(f.clients[0].calls.includes("thread/goal/get"));
    assert.ok(f.clients[0].calls.includes("thread/goal/set"));
    await assert.rejects(f.sessions.goal("other", id), /does not belong/);
    await assert.rejects(f.sessions.goal("task", id, " "), /invalid/);
  } finally { f.cleanup(); }
});

test("Codex questions are tied to the active turn and answered once", async () => {
  const f = await fixture();
  try {
    const id = String(((await f.sessions.create(f.options)).link as Record<string, unknown>).id);
    const sending = f.sessions.send("task", id, "hello", "question-send");
    f.clients[0].resolve({ turn: { id: "turn" } }); await sending;
    f.clients[0].emit({ type: "request", id: "q", method: "item/tool/requestUserInput", params: { threadId: "native", turnId: "turn", itemId: "i", isBlocking: true, questions: [{ id: "choice", header: "Pick", question: "Which?", options: [{ label: "A", description: "first" }] }] } });
    assert.equal((f.sessions.events("task", id, null, 0).approvals as unknown[]).length, 1);
    assert.throws(() => f.sessions.decide("task", id, "q", "accept"), /not pending/);
    assert.throws(() => f.sessions.answer("task", id, "q", {}), /invalid/);
    assert.throws(() => f.sessions.answer("other", id, "q", { choice: ["A"] }), /does not belong/);
    f.sessions.answer("task", id, "q", { choice: ["A"] });
    assert.deepEqual(JSON.parse(JSON.stringify(f.clients[0].decisions)), [{ id: "q", result: { answers: { choice: { answers: ["A"] } } } }]);
    assert.throws(() => f.sessions.answer("task", id, "q", { choice: ["A"] }), /not pending/);
  } finally { f.cleanup(); }
});

test("creates and reconnects mapped native sessions, streams events and routes explicit approvals", async () => {
  const f = await fixture();
  try {
    const created = await f.sessions.create(f.options); const id = String((created.link as Record<string, unknown>).id); const client = f.clients[0];
    assert.equal((await f.sessions.create(f.options)).idempotent, true);
    await assert.rejects(f.sessions.create({ ...f.options, model: "other" }), /conflicts/);
    assert.equal((await f.sessions.resume("task", id)).connected, true);
    await assert.rejects(f.sessions.resume("other", id), /does not belong/);
    const sending = f.sessions.send("task", id, "private prompt", "send-1");
    await assert.rejects(f.sessions.send("task", id, "private prompt", "send-1"), /already used/);
    client.emit(approval("a"));
    assert.throws(() => f.sessions.decide("task", id, "a", "accept"), /not pending/);
    client.resolve({ turn: { id: "turn" } }); await sending;
    await assert.rejects(f.sessions.send("task", id, "private prompt", "send-1"), /already used/);
    client.emit(notification("turn/completed", { threadId: "native", turn: { id: "old", status: "completed" } }));
    f.sessions.decide("task", id, "a", "accept");
    assert.deepEqual(client.decisions, [{ id: "a", result: { decision: "accept" } }]);
    assert.throws(() => f.sessions.decide("task", id, "a", "accept"), /not pending/);
    client.emit(notification("item/agentMessage/delta", { threadId: "native", delta: "hello" }));
    await f.sessions.interrupt("task", id);
    client.emit(notification("turn/completed", { threadId: "native", turn: { id: "turn", status: "interrupted" } }));
    await assert.rejects(f.sessions.interrupt("task", id), /no interruptible/);
    const events = f.sessions.events("task", id, null, 0);
    assert.equal((events.events as unknown[]).length, 4); assert.equal((events.status as { link: { turn_state: string } }).link.turn_state, "idle");
    assert.equal(f.store.list("task_message", 100).length, 0);
    assert.equal(JSON.stringify(f.sessions.links.list("task")).includes("private prompt"), false);
    assert.throws(() => f.sessions.events("task", id, String(events.generation), -1), /cursor/);
    assert.throws(() => f.sessions.events("task", id, "stale", 0), /stream changed/);
    assert.throws(() => f.sessions.events("task", id, null, 1), /stream changed/);
    client.emit({ type: "closed", error: "transport lost" });
    assert.equal((f.sessions.events("task", id, String(events.generation), 0).status as { connected: boolean }).connected, false);
    await f.sessions.resume("task", id);
    assert.throws(() => f.sessions.events("task", id, String(events.generation), 0), /stream changed/);
    await assert.rejects(f.sessions.send("task", id, "private prompt", "send-1"), /already used/);
    f.sessions.unlink("task", id);
    assert.equal(f.clients[1].closed, true);
    assert.throws(() => f.sessions.links.get("task", id), /Unknown/);
  } finally { f.cleanup(); }
});

test("submission keys are retained on failure and store no prompt", async () => {
  const f = await fixture();
  try {
    const id = String(((await f.sessions.create(f.options)).link as Record<string, unknown>).id);
    await assert.rejects(f.sessions.send("task", id, "hello", ""), /operation_id/);
    await assert.rejects(f.sessions.send("task", id, "", "invalid"), /prompt/);
    const pending = f.sessions.send("task", id, "secret prompt", "submission");
    f.clients[0].reject(new Error("lost response"));
    await assert.rejects(pending, /outcome may be unknown/);
    await assert.rejects(f.sessions.send("task", id, "secret prompt", "submission"), /already used/);
    const records = f.store.list("workbench_agent_session_submission", 100);
    assert.equal(records.length, 1);
    assert.equal(JSON.stringify(records).includes("secret prompt"), false);
    assert.equal((f.sessions.links.get("task", id)).turn_state, "unknown");
  } finally { f.cleanup(); }
});

test("steering targets the active turn and rejects reused operations", async () => {
  const f = await fixture();
  try {
    const id = String(((await f.sessions.create(f.options)).link as Record<string, unknown>).id);
    await assert.rejects(f.sessions.steer("task", id, "hello", "one"), /no active turn/);
    const sending = f.sessions.send("task", id, "hello", "send-steer");
    f.clients[0].resolve({ turn: { id: "turn" } }); await sending;
    await assert.rejects(f.sessions.steer("task", id, "hello", ""), /operation_id/);
    await assert.rejects(f.sessions.steer("task", id, "", "one"), /prompt/);
    assert.deepEqual(await f.sessions.steer("task", id, "private steering", "one"), { accepted: true });
    await assert.rejects(f.sessions.steer("task", id, "private steering", "one"), /already used/);
    assert.ok(f.clients[0].calls.includes("turn/steer"));
    assert.equal(JSON.stringify(f.store.list("workbench_codex_steer", 100)).includes("private steering"), false);
    await assert.rejects(f.sessions.steer("other", id, "hello", "two"), /does not belong/);
  } finally { f.cleanup(); }
});

test("reconciliation requires the exact native turn and a terminal status", async () => {
  const f = await fixture();
  try {
    const id = String(((await f.sessions.create(f.options)).link as Record<string, unknown>).id);
    const client = f.clients[0];
    await assert.rejects(f.sessions.reconcile("task", id), /no identifiable/);
    const sending = f.sessions.send("task", id, "hello", "reconcile-send");
    client.resolve({ turn: { id: "turn" } }); await sending;
    const original = f.sessions.links.get("task", id);
    f.sessions.links.markTurnUnknown("task", id, original.operation_id);
    let turns: unknown[] = [];
    const nativeClient = (f.sessions as unknown as { live: Map<string, { client: { request: (method: string, params: unknown) => Promise<unknown> } }> }).live.get(id)!.client;
    const request = nativeClient.request;
    nativeClient.request = async (method, params) => method === "thread/read" ? { thread: { id: "native", turns } } : request(method, params);
    for (const sample of [[], [{ id: "other", status: "completed" }], [{ id: "turn", status: "inProgress" }], [{ id: "turn", status: "completed" }, { id: "turn", status: "completed" }]]) {
      turns = sample;
      await assert.rejects(f.sessions.reconcile("task", id), /does not prove/);
      assert.equal(f.sessions.links.get("task", id).turn_state, "unknown");
    }
    await assert.rejects(f.sessions.reconcile("other", id), /does not belong/);
    turns = [{ id: "turn", status: "completed" }];
    const result = await f.sessions.reconcile("task", id);
    assert.equal((result.link as Record<string, unknown>).last_turn_status, "completed");
    assert.equal(f.sessions.links.get("task", id).turn_state, "idle");
  } finally { f.cleanup(); }
});

test("creation keys prevent repeated native starts when a result is unknown", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.sessions.create({ ...f.options, operation_id: "" }), /operation_id/);
    await assert.rejects(f.sessions.create({ ...f.options, task_id: "missing" }), /Unknown/);
    const failing = new CodexWorkbenchSessions(f.store, () => { throw new Error("launcher failed"); });
    await assert.rejects(failing.create(f.options), /launcher failed/);
    await assert.rejects(failing.create(f.options), /outcome is unknown/);
    await assert.rejects(failing.create({ ...f.options, model: "different" }), /conflicts/);
    assert.equal(f.clients.length, 0);
  } finally { f.cleanup(); }
});

test("unexpected approvals fail closed and bounded event history indicates loss", async () => {
  const f = await fixture();
  try {
    const id = String(((await f.sessions.create(f.options)).link as Record<string, unknown>).id); const client = f.clients[0];
    for (let i = 0; i < 260; i++) client.emit(notification("delta", { threadId: "native", n: i }));
    const result = f.sessions.events("task", id, null, 0);
    assert.equal(result.truncated, true); assert.equal((result.events as unknown[]).length, 256);
    client.emit({ type: "request", id: "bad", method: "unsupported", params: { threadId: "native", turnId: "turn" } });
    assert.equal(client.closed, true);
    await assert.rejects(f.sessions.send("task", id, "x", "send-1"), /not connected/);
  } finally { f.cleanup(); }
});

test("early completion removes approvals once the matching turn is acknowledged", async () => {
  const f = await fixture();
  try {
    const id = String(((await f.sessions.create(f.options)).link as Record<string, unknown>).id);
    const client = f.clients[0];
    const sending = f.sessions.send("task", id, "hello", "send-1");
    client.emit(approval("pending"));
    client.emit(notification("turn/completed", { threadId: "native", turn: { id: "turn", status: "completed" } }));
    client.resolve({ turn: { id: "turn" } });
    await sending;
    assert.deepEqual(f.sessions.events("task", id, null, 0).approvals, []);
    assert.throws(() => f.sessions.decide("task", id, "pending", "accept"), /not pending/);
  } finally { f.cleanup(); }
});

test("foreign approvals and oversized native output close their transports", async () => {
  for (const event of [
    { type: "request", id: "foreign", method: "item/commandExecution/requestApproval", params: { threadId: "another", turnId: "turn" } } as CodexServerEvent,
    notification("delta", { threadId: "native", text: "x".repeat(257 * 1024) }),
  ]) {
    const f = await fixture();
    try {
      const id = String(((await f.sessions.create(f.options)).link as Record<string, unknown>).id);
      f.clients[0].emit(notification("delta", { threadId: "another", text: "ignored" }));
      assert.deepEqual(f.sessions.events("task", id, null, 0).events, []);
      f.clients[0].emit(event);
      assert.equal(f.clients[0].closed, true);
      await assert.rejects(f.sessions.send("task", id, "hello", "send"), /not connected/);
    } finally { f.cleanup(); }
  }
});

test("closing the manager stops pending initialization before starting a native thread", async () => {
  const f = await fixture();
  try {
    let finish!: () => void; let closed = false; let starts = 0;
    const sessions = new CodexWorkbenchSessions(f.store, () => ({
      initialize: () => new Promise(resolve => { finish = () => resolve({}); }),
      request: async () => { starts++; return {}; }, respond: () => {}, close: () => { closed = true; },
    }));
    const creation = sessions.create(f.options);
    sessions.close(); finish();
    await assert.rejects(creation, /outcome may be unknown/);
    await assert.rejects(sessions.create({ ...f.options, operation_id: "new" }), /manager is closed/);
    assert.equal(closed, true); assert.equal(starts, 0);
  } finally { f.cleanup(); }
});

test("model discovery filters hidden and invalid entries, reports truncation and closes the process", async () => {
  const f = await fixture();
  try {
    let response: unknown = { data: [null, { model: "alpha" }, { model: "beta", displayName: "Beta", isDefault: true }, { model: "hidden", hidden: true }, { model: "" }], nextCursor: "more" };
    let closes = 0;
    const sessions = new CodexWorkbenchSessions(f.store, () => ({ initialize: async () => ({}), request: async () => response, respond: () => {}, close: () => { closes++; } }));
    assert.deepEqual(await sessions.models(), { models: [{ id: "alpha", name: "alpha", is_default: false }, { id: "beta", name: "Beta", is_default: true }], truncated: true });
    response = {};
    await assert.rejects(sessions.models(), /Invalid Codex model list/);
    response = { data: Array.from({ length: 101 }, () => ({})) };
    await assert.rejects(sessions.models(), /exceeds limit/);
    assert.equal(closes, 3);
    sessions.close();
    await assert.rejects(sessions.models(), /manager is closed/);
  } finally { f.cleanup(); }
});
