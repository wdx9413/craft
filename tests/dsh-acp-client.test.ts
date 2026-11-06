import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DshAcpClient, type DshAcpEvent } from "../core/interfaces/dsh-acp-client.ts";

const fixture = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
let pendingPrompt = null;
if (process.env.MALFORMED === "1") {
  send({ bad: true });
  process.stdout.write("{bad\n");
}
rl.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "s1", configOptions: [
    { id: "model", options: [{ group: "provider", name: "Provider", options: [{ value: "provider/model", name: "Model" }] }] },
    { id: "reasoning_effort", options: [{ value: "high", name: "High" }] }
  ] } });
  if (message.method === "session/set_config_option") return send({ jsonrpc: "2.0", id: message.id, result: { configOptions: [] } });
  if (message.method === "session/list") return send({ jsonrpc: "2.0", id: message.id, result: { sessions: [{ sessionId: "old", cwd: "/tmp" }], nextCursor: null } });
  if (message.method === "session/resume") return send({ jsonrpc: "2.0", id: message.id, result: { configOptions: [] } });
  if (message.method === "session/close") return send({ jsonrpc: "2.0", id: message.id, result: {} });
  if (message.method === "session/prompt") {
    pendingPrompt = message.id;
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } } });
    send({ jsonrpc: "2.0", id: "permission-1", method: "session/request_permission", params: { sessionId: "s1", toolCall: { toolCallId: "tool-1", title: "Write" }, options: [{ optionId: "allow-once", kind: "allow_once", name: "Allow" }, { optionId: "reject-once", kind: "reject_once", name: "Reject" }] } });
    return;
  }
  if (message.id === "permission-1" && message.result) {
    send({ jsonrpc: "2.0", id: pendingPrompt, result: { stopReason: "end_turn" } });
    return;
  }
  if (message.method === "session/cancel") {
    if (pendingPrompt !== null) { send({ jsonrpc: "2.0", id: pendingPrompt, result: { stopReason: "cancelled" } }); pendingPrompt = null; }
    return;
  }
  if (message.id !== undefined && message.method) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown" } });
});
`;

async function launch(mode = "") {
  const root = await mkdtemp(join(tmpdir(), "craft-dsh-acp-"));
  const script = join(root, "fixture.cjs");
  await writeFile(script, fixture);
  return {
    root,
    start: () => spawn(process.execPath, [script], { stdio: "pipe", env: { ...process.env, MALFORMED: mode } }),
  };
}

test("DSH ACP negotiates, streams, requests permission and cancels", async () => {
  const f = await launch();
  const events: DshAcpEvent[] = [];
  const client = new DshAcpClient({ start: f.start, onEvent: event => events.push(event) });
  try {
    assert.deepEqual(await client.initialize(), { protocolVersion: 1 });
    const session = await client.newSession("/tmp");
    assert.equal(session.sessionId, "s1");
    assert.equal(session.configOptions?.length, 2);
    assert.deepEqual(await client.listSessions(), { sessions: [{ sessionId: "old", cwd: "/tmp" }], nextCursor: null });
    assert.deepEqual(await client.resumeSession("old", "/tmp"), { sessionId: "old", configOptions: [] });
    await client.setConfigOption("s1", "model", "provider/model");
    const prompt = client.prompt("s1", "hello");
    await new Promise(resolve => setTimeout(resolve, 50));
    const request = events.find(event => event.type === "request" && event.method === "session/request_permission");
    assert.ok(request && request.type === "request");
    client.respond(request.id, { outcome: { outcome: "selected", optionId: "allow-once" } });
    assert.deepEqual(await prompt, { stopReason: "end_turn" });
    assert.ok(events.some(event => event.type === "notification" && event.method === "session/update"));
    await client.closeSession("s1");
    client.close();
    assert.ok(events.some(event => event.type === "closed"));
  } finally {
    client.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("DSH ACP rejects malformed protocol frames and bounded requests", async () => {
  const f = await launch("1");
  const client = new DshAcpClient({ start: f.start, onEvent: () => {}, outputLimit: 64 });
  try {
    await assert.rejects(client.initialize(), /invalid JSON|output exceeds limit|closed|without method or id/u);
  } finally {
    client.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
