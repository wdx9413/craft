import assert from "node:assert/strict";
import test from "node:test";
import { BoundedCdpSession, connectCdp, pinnedCdpTarget, type CdpSocket } from "../adapters/cdp-session.ts";

class Socket extends EventTarget implements CdpSocket {
  sent: string[] = []; closes = 0; throws = false;
  send(data: string): void { if (this.throws) throw new Error("lost"); this.sent.push(data); }
  close(): void { this.closes++; }
  reply(data: unknown): void { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) })); }
}
test("bounded session correlates replies, rejects errors, drains on loss, and closes idempotently", async () => {
  const socket = new Socket(); const session = new BoundedCdpSession(socket);
  const first = session.call("Page.navigate", { url: "https://example.test" });
  socket.reply({ method: "event" }); socket.reply({ id: 1, result: { frameId: "main" } });
  assert.deepEqual(await first, { frameId: "main" });
  const second = session.call("Runtime.evaluate"); socket.reply({ id: 2 }); assert.deepEqual(await second, {});
  const third = session.call("Runtime.evaluate"); socket.reply({ id: 3, error: { message: "do not retain raw content" } });
  await assert.rejects(third, /^Error: CDP request failed$/);
  const interrupted = session.call("Page.navigate"); socket.dispatchEvent(new Event("error"));
  await assert.rejects(interrupted, /effect may be unknown/);
  session.close(); assert.equal(socket.closes, 1); await assert.rejects(session.call("Page.navigate"), /closed/);
});
test("invalid messages, send failure, close and timeout all fail closed", async () => {
  for (const message of ["{", "null"]) {
    const socket = new Socket(); const session = new BoundedCdpSession(socket);
    const result = session.call("Page.navigate"); socket.dispatchEvent(new MessageEvent("message", { data: message }));
    await assert.rejects(result, /interrupted/);
  }
  const socket = new Socket(); socket.throws = true;
  await assert.rejects(new BoundedCdpSession(socket).call("Page.navigate"), /interrupted/);
  const closing = new Socket(); const closed = new BoundedCdpSession(closing).call("Page.navigate"); closing.dispatchEvent(new Event("close")); await assert.rejects(closed);
  await assert.rejects(new BoundedCdpSession(new Socket(), 1).call("Page.navigate"), /interrupted/);
  for (const timeout of [0, 30_001, 1.5]) assert.throws(() => new BoundedCdpSession(new Socket(), timeout), /timeout/);
});
test("CDP discovery pins exactly one target and refuses remote or ambiguous sockets", () => {
  const target = { id: "tab", type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/tab" };
  assert.equal(pinnedCdpTarget([null, { type: "worker" }, target], 9222, "tab"), target.webSocketDebuggerUrl);
  for (const port of [0, 65_536, 1.5]) assert.throws(() => pinnedCdpTarget([], port, "tab"));
  assert.throws(() => pinnedCdpTarget([], 9222, "../x"));
  for (const targets of [null, Array(101).fill(target), [], [target, target]]) assert.throws(() => pinnedCdpTarget(targets, 9222, "tab"));
  for (const url of ["wss://127.0.0.1:9222/devtools/page/tab", "ws://evil.test:9222/devtools/page/tab", "ws://127.0.0.1:9223/devtools/page/tab", "ws://u@127.0.0.1:9222/devtools/page/tab", "ws://u:p@127.0.0.1:9222/devtools/page/tab", "ws://127.0.0.1:9222/devtools/page/tab?x", "ws://127.0.0.1:9222/devtools/page/tab#x", "ws://127.0.0.1:9222/devtools/page/other", "bad"]) assert.throws(() => pinnedCdpTarget([{ ...target, webSocketDebuggerUrl: url }], 9222, "tab"));
});
test("connection uses only pinned local discovery and bounds opening", async (t) => {
  const oldFetch = globalThis.fetch; const oldSocket = globalThis.WebSocket;
  const target = { id: "tab", type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/tab" };
  let mode = "open";
  class OpeningSocket extends Socket {
    constructor(url: string | URL) { super(); assert.equal(String(url), target.webSocketDebuggerUrl); if (mode !== "timeout") queueMicrotask(() => this.dispatchEvent(new Event(mode))); }
  }
  globalThis.WebSocket = OpeningSocket as unknown as typeof WebSocket;
  globalThis.fetch = (async (url, init) => { assert.equal(url, "http://127.0.0.1:9222/json/list"); assert.equal(init?.redirect, "error"); return new Response(JSON.stringify([target])); }) as typeof fetch;
  try {
    const session = await connectCdp(9222, "tab"); session.close();
    for (const state of ["error", "close"]) { mode = state; await assert.rejects(connectCdp(9222, "tab"), /Cannot open/); }
    globalThis.fetch = async () => new Response("", { status: 503 }); await assert.rejects(connectCdp(9222, "tab"), /discovery/);
    globalThis.fetch = async () => new Response(JSON.stringify([target])); mode = "timeout";
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const timed = connectCdp(9222, "tab");
    await new Promise((resolve) => setImmediate(resolve)); t.mock.timers.tick(5_000);
    await assert.rejects(timed, /Cannot open/);
  } finally { globalThis.fetch = oldFetch; globalThis.WebSocket = oldSocket; t.mock.timers.reset(); }
});
