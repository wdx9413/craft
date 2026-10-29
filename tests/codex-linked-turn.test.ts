import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { WorkbenchAgentSessionLinks } from "../core/application/use-cases/workbench-agent-session-links.ts";
import { CodexWorkbenchAdapter } from "../core/interfaces/codex-workbench-adapter.ts";
import { CodexLinkedTurn } from "../core/interfaces/codex-linked-turn.ts";
import { CodexAppServerClient } from "../core/interfaces/codex-app-server-client.ts";

async function fixture(provider = "codex") {
  const root = mkdtempSync(join(tmpdir(), "craft-linked-turn-"));
  const store = await new CraftStore(craftPaths(root)).open();
  store.create("task", "t", {});
  const links = new WorkbenchAgentSessionLinks(store);
  const link = links.bind({ task_id: "t", provider, native_session_id: "native", workspace: root, permission: "ask" }).link as Record<string, unknown>;
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const adapter = new CodexWorkbenchAdapter({ request: () => new Promise((yes, no) => { resolve = yes; reject = no; }), respond: () => {} });
  return { root, store, links, link, adapter, resolve: (value: unknown) => resolve(value), reject: (error: Error) => reject(error), cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
const completed = (id = "turn", threadId = "native", status = "completed") => ({ type: "notification" as const, method: "turn/completed", params: { threadId, turn: { id, status } } });

test("a native turn is reserved before dispatch and completed only by its matching event", async () => {
  const f = await fixture();
  try {
    const run = new CodexLinkedTurn(f.links, f.adapter, "t", String(f.link.id));
    await assert.rejects(run.send(" "), /invalid/);
    assert.equal(run.status().link.turn_state, "idle");
    const pending = run.send("hello");
    assert.equal(run.status().link.turn_state, "starting");
    await assert.rejects(run.send("duplicate"), /unsettled/);
    run.observe(completed("other", "other"));
    f.resolve({ turn: { id: "turn" } });
    assert.equal((await pending).link.turn_state, "running");
    run.observe(completed("different")); assert.equal(run.status().link.turn_state, "running");
    run.observe(completed()); assert.equal(run.status().link.turn_state, "idle");
    assert.equal(f.store.list("task_message", 100).length, 0);
  } finally { f.cleanup(); }
});

test("completion before the start response is reconciled without re-opening the turn", async () => {
  const f = await fixture();
  try {
    const run = new CodexLinkedTurn(f.links, f.adapter, "t", String(f.link.id));
    const pending = run.send("hello");
    run.observe(completed("turn", "native", "failed"));
    f.resolve({ turn: { id: "turn" } });
    const result = await pending;
    assert.equal(result.link.turn_state, "idle"); assert.equal(result.link.last_turn_status, "failed");
  } finally { f.cleanup(); }
});

test("disconnect and a late acknowledgement retain uncertainty until matching completion", async () => {
  const f = await fixture();
  try {
    const run = new CodexLinkedTurn(f.links, f.adapter, "t", String(f.link.id));
    const pending = run.send("hello"); run.observe({ type: "closed", error: "lost" });
    assert.equal(run.status().link.turn_state, "unknown");
    f.resolve({ turn: { id: "turn" } });
    assert.equal((await pending).link.turn_state, "unknown");
    run.observe(completed("turn", "native", "interrupted"));
    assert.equal(run.status().link.turn_state, "idle"); assert.equal(run.status().connected, false);
    await assert.rejects(run.send("again"), /closed/);
  } finally { f.cleanup(); }
});

test("disconnect after acknowledgement leaves the identified turn unknown", async () => {
  const f = await fixture();
  try {
    const run = new CodexLinkedTurn(f.links, f.adapter, "t", String(f.link.id));
    const pending = run.send("hello"); f.resolve({ turn: { id: "turn" } }); await pending;
    run.observe({ type: "closed", error: "lost" });
    assert.equal(run.status().link.turn_state, "unknown");
    run.observe(completed()); assert.equal(run.status().link.turn_state, "idle");
  } finally { f.cleanup(); }
});

test("transport failure remains unknown and unrelated or malformed events cannot resolve it", async () => {
  const f = await fixture();
  try {
    const run = new CodexLinkedTurn(f.links, f.adapter, "t", String(f.link.id));
    const pending = run.send("hello"); f.reject(new Error("timeout"));
    await assert.rejects(pending, /outcome is unknown/);
    run.observe({ type: "request", id: 1, method: "approval", params: {} });
    run.observe({ type: "notification", method: "turn/completed", params: null });
    run.observe(completed("turn", "other")); run.observe(completed("turn", "native", "running"));
    assert.equal(run.status().link.turn_state, "unknown");
    await assert.rejects(run.send("again"), /unsettled/);
  } finally { f.cleanup(); }
});

test("rejects a different provider and preserves storage errors as diagnostics", async () => {
  const f = await fixture("claude");
  try { assert.throws(() => new CodexLinkedTurn(f.links, f.adapter, "t", String(f.link.id)), /not a Codex/); }
  finally { f.cleanup(); }
  const g = await fixture();
  try {
    const run = new CodexLinkedTurn(g.links, g.adapter, "t", String(g.link.id));
    const get = g.links.get.bind(g.links);
    g.links.get = (() => { throw "storage unavailable"; }) as typeof g.links.get;
    run.observe(completed()); g.links.get = get;
    assert.match(String(run.status().diagnostic), /storage unavailable/);
    g.links.get = (() => { throw new Error("storage error"); }) as typeof g.links.get;
    run.observe(completed()); g.links.get = get;
    assert.match(String(run.status().diagnostic), /storage error/);
  } finally { g.cleanup(); }
});

test("a storage failure while marking an uncertain dispatch never reports a safe retry", async () => {
  for (const problem of ["storage locked", new Error("storage locked")]) {
    const f = await fixture();
    try {
      const run = new CodexLinkedTurn(f.links, f.adapter, "t", String(f.link.id));
      const pending = run.send("hello");
      const mark = f.links.markTurnUnknown.bind(f.links);
      f.links.markTurnUnknown = (() => { throw problem; }) as typeof f.links.markTurnUnknown;
      f.reject(new Error("transport failed"));
      await assert.rejects(pending, /outcome is unknown/);
      f.links.markTurnUnknown = mark;
      assert.equal(run.status().link.turn_state, "starting");
      assert.match(String(run.status().diagnostic), /storage locked/);
    } finally { f.cleanup(); }
  }
});

test("the linked lifecycle handles a real JSON-RPC subprocess without copying messages to Craft", { timeout: 5000 }, async () => {
  const f = await fixture();
  const script = String.raw`
const rl=require('node:readline').createInterface({input:process.stdin});
const out=x=>process.stdout.write(JSON.stringify(x)+'\n');
rl.on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')out({id:m.id,result:{}});
else if(m.method==='thread/start')out({id:m.id,result:{thread:{id:'native-2',ephemeral:false},cwd:process.argv[1],model:'test-model',sandbox:{type:'workspaceWrite'},approvalPolicy:'on-request',approvalsReviewer:'user'}});
else if(m.method==='turn/start')process.stdout.write(JSON.stringify({id:m.id,result:{turn:{id:'turn-2'}}})+'\n'+JSON.stringify({method:'turn/completed',params:{threadId:'native-2',turn:{id:'turn-2',status:'completed'}}})+'\n');
});`;
  let linked: CodexLinkedTurn | undefined;
  let completedEvent!: () => void;
  const completedObserved = new Promise<void>(resolve => { completedEvent = resolve; });
  const client = new CodexAppServerClient({ start: () => spawn(process.execPath, ["-e", script, f.root], { stdio: "pipe" }), onEvent: event => { linked?.observe(event); if (event.type === "notification" && event.method === "turn/completed") completedEvent(); } });
  try {
    await client.initialize();
    const adapter = new CodexWorkbenchAdapter(client);
    const native = await adapter.start({ workspace: f.root, permission: "ask" });
    const link = f.links.bind({ task_id: "t", provider: "codex", native_session_id: native.thread_id, workspace: native.workspace, model: native.model, permission: "ask" }).link as Record<string, unknown>;
    linked = new CodexLinkedTurn(f.links, adapter, "t", String(link.id));
    await linked.send("private test prompt"); await completedObserved;
    assert.equal(linked.status().link.turn_state, "idle");
    assert.equal(f.store.list("task_message", 100).length, 0);
    assert.equal(JSON.stringify(f.links.list("t")).includes("private test prompt"), false);
  } finally { client.close(); f.cleanup(); }
});
