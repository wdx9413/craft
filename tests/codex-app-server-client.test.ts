import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexAppServerClient, type CodexServerEvent } from "../core/interfaces/codex-app-server-client.ts";

const fakeServer = String.raw`
const readline = require('node:readline');
let approval;
function out(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
readline.createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') { process.stdout.write(JSON.stringify({id:m.id,result:{ready:true}})+'\n'+JSON.stringify({method:'ready'})+'\n'); return; }
  if (m.method === 'initialized') { process.stdout.write('\n'); out({method:'thread/started',params:{threadId:'t'}}); return; }
  if (m.method === 'approve') { approval = m.id; out({id:'approval-1',method:'item/commandExecution/requestApproval',params:{command:'read'}}); return; }
  if (m.method === 'duplicate') { out({id:'dup',method:'approval'}); out({id:'dup',method:'approval'}); return; }
  if (m.id === 'approval-1') { out({id:approval,result:m.result}); return; }
  if (m.method === 'error') { out({id:m.id,error:{code:7,message:'no'}}); return; }
  if (m.method === 'bad-json') { process.stdout.write('not-json\n'); return; }
  if (m.method === 'bad-value') { process.stdout.write('[]\n'); return; }
  if (m.method === 'bad-null') { process.stdout.write('null\n'); return; }
  if (m.method === 'bad-message') { out({value:1}); return; }
  if (m.method === 'oversized') { process.stdout.write('x'.repeat(8*1024*1024+1)); return; }
  if (m.method === 'exit') { process.exit(4); return; }
  if (m.method === 'late') { setTimeout(() => out({id:m.id,result:'late'}),100); return; }
  if (m.method === 'never') return;
  out({id:m.id,result:m.params});
});`;

function start() { return spawn(process.execPath, ["-e", fakeServer], { stdio: "pipe" }); }

test("initialization, streaming events and explicit native approval use the same transport", async () => {
  const events: CodexServerEvent[] = [];
  let client!: CodexAppServerClient;
  client = new CodexAppServerClient({ start, onEvent: event => { events.push(event); if (event.type === "request") client.respond(event.id, { decision: "accept" }); } });
  try {
    assert.deepEqual(await client.initialize(), { ready: true });
    assert.deepEqual(await client.request("turn/start", { threadId: "t", input: [] }), { threadId: "t", input: [] });
    assert.deepEqual(await client.request("approve", {}), { decision: "accept" });
    assert.ok(events.some(event => event.type === "notification" && event.method === "thread/started"));
    assert.ok(events.some(event => event.type === "request" && event.id === "approval-1"));
    assert.throws(() => client.respond("approval-1", { decision: "accept" }), /Unknown/);
    await assert.rejects(client.request("error", {}), /request failed/);
  } finally { client.close(); client.close(); }
  await assert.rejects(client.request("after-close", {}), /closed/);
});

test("timeout and late response do not complete a later request", async () => {
  const client = new CodexAppServerClient({ start, timeoutMs: 60, onEvent: () => {} });
  try {
    await assert.rejects(client.request("late", {}), /timed out/);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(await client.request("echo", { n: 2 }), { n: 2 });
  } finally { client.close(); }
});

test("malformed output, oversized output and process exit fail pending requests", async () => {
  for (const [method, expected] of [["bad-json", /invalid JSON/], ["bad-value", /invalid message/], ["bad-null", /invalid message/], ["bad-message", /invalid message/], ["duplicate", /reused/], ["oversized", /exceeds limit/], ["exit", /exited/]] as const) {
    const events: CodexServerEvent[] = [];
    const client = new CodexAppServerClient({ start, onEvent: event => events.push(event) });
    await assert.rejects(client.request(method, {}), expected);
    assert.ok(events.some(event => event.type === "closed"));
    client.close();
  }
});

test("closed and broken input paths cannot send or silently ignore serialization failures", async () => {
  const client = new CodexAppServerClient({ start, onEvent: () => {} });
  await client.initialize();
  const bad = Object.defineProperty({}, "broken", { enumerable: true, get() { throw "broken payload"; } });
  await assert.rejects(client.request("echo", bad), /broken payload/);
  client.process.stdin.end();
  await assert.rejects(client.request("echo", {}), /closed/);
  client.close();
  client.process.stdout.emit("data", "{}\n");
  const inputError = new CodexAppServerClient({ start, onEvent: () => {} });
  const pending = inputError.request("never", {});
  inputError.process.stdin.emit("error", new Error("broken pipe"));
  await assert.rejects(pending, /input error/);
  assert.equal(inputError.process.killed, true);
});

test("closing during initialization rejects the initialized notification", async () => {
  let client!: CodexAppServerClient;
  client = new CodexAppServerClient({ start, onEvent: event => { if (event.type === "notification" && event.method === "ready") client.close(); } });
  await assert.rejects(client.initialize(), /closed/);
});

test("default launcher uses the executable on PATH", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-codex-launch-"));
  const executable = join(root, "codex");
  writeFileSync(executable, `#!${process.execPath}\n${fakeServer}`); chmodSync(executable, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = root;
  let client: CodexAppServerClient | undefined;
  try { client = new CodexAppServerClient({ onEvent: () => {} }); assert.deepEqual(await client.initialize(), { ready: true }); }
  finally { client?.close(); if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; rmSync(root, { recursive: true, force: true }); }
});

test("missing executable fails pending calls and close rejects an in-flight request", async () => {
  const missing = new CodexAppServerClient({ start: () => spawn("/definitely-not-a-codex-executable", [], { stdio: "pipe" }), onEvent: () => {} });
  await assert.rejects(missing.request("initialize", {}), /process error|input error/);
  const client = new CodexAppServerClient({ start, onEvent: () => {} });
  const pending = client.request("never", {}); client.close();
  await assert.rejects(pending, /closed/);
});

test("a POSIX-style owned process group uses the default launcher and negative-pid close", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const savedKill = process.kill;
  const previousExecutable = process.env.CRAFT_CODEX_EXECUTABLE;
  let client: CodexAppServerClient | undefined;
  let fallback: CodexAppServerClient | undefined;
  let signalled = 0;
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    process.env.CRAFT_CODEX_EXECUTABLE = process.execPath;
    process.kill = ((pid: number) => { signalled = pid; return true; }) as typeof process.kill;
    client = new CodexAppServerClient({ onEvent: () => {} });
    // Node receives app-server as a script name and exits; the client must still
    // reject the pending request rather than leave it unresolved.
    await assert.rejects(client.request("never", {}), /exited|process error|input error/u);
    // A spawn error may already have killed the child; force the owned-group close
    // path so its negative-pid signal is observed deterministically.
    const child = client.process as unknown as { killed: boolean; pid: number };
    child.killed = false;
    child.pid = 4321;
    client.close();
    assert.ok(signalled < 0, "close must signal the owned process group");
    // A process group that has already exited falls back to killing the child.
    process.kill = (() => { throw Object.assign(new Error("process group exited"), { code: "ESRCH" }); }) as typeof process.kill;
    fallback = new CodexAppServerClient({ onEvent: () => {} });
    await assert.rejects(fallback.request("never", {}), /exited|process error|input error/u);
    const fallbackChild = fallback.process as unknown as { killed: boolean; pid: number };
    fallbackChild.killed = false;
    fallbackChild.pid = 4322;
    fallback.close();
  } finally {
    Object.defineProperty(process, "platform", platform);
    process.kill = savedKill;
    if (previousExecutable === undefined) delete process.env.CRAFT_CODEX_EXECUTABLE;
    else process.env.CRAFT_CODEX_EXECUTABLE = previousExecutable;
    client?.process.kill();
    fallback?.process.kill();
  }
});

test("a late reply to a timed-out request cannot resolve a later one", async () => {
  const client = new CodexAppServerClient({ start, timeoutMs: 1, onEvent: () => {} });
  try {
    await assert.rejects(client.request("never", {}), /timed out/u);
    client.process.stdout.emit("data", `${JSON.stringify({ id: 1, result: "late" })}\n`);
    (client as unknown as { timeoutMs: number }).timeoutMs = 1_000;
    assert.deepEqual(await client.request("echo", { kept: true }), { kept: true });
  } finally { client.close(); }
});
