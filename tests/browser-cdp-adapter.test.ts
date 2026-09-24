import assert from "node:assert/strict";
import test from "node:test";
import { BrowserCdpAdapter, type CdpSession } from "../adapters/browser-cdp.ts";

function fixture() {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const session: CdpSession = { async call(method, params) { calls.push({ method, params }); return method === "Runtime.evaluate" ? { result: { value: { title: "Portal" } } } : { frameId: "main" }; } };
  return { adapter: new BrowserCdpAdapter(session), calls };
}

test("the external browser adapter accepts only bounded selector operations and records no page body", async () => {
  const f = fixture();
  const navigated = await f.adapter.execute({ request_id: "n", operation: "navigate", url: "https://portal.example.test" });
  assert.equal(navigated.result, "succeeded");
  assert.deepEqual(f.calls[0], { method: "Page.navigate", params: { url: "https://portal.example.test" } });
  const observed = await f.adapter.execute({ request_id: "o", operation: "observe" });
  assert.equal(observed.raw_page_content_stored, false);
  const filled = await f.adapter.execute({ request_id: "f", operation: "fill", selector: "#title", value: "draft", human_release: true });
  assert.equal(filled.adapter, "browser_cdp");
  assert.match(String(f.calls[2]?.params?.expression), /querySelector\("#title"\)/);
  await assert.rejects(() => f.adapter.execute({ request_id: "bad", operation: "click", selector: "clickAtCoordinate(1,2)", human_release: true }), /selector/);
  await assert.rejects(() => f.adapter.execute({ request_id: "url", operation: "navigate", url: "file:///secret" }), /http/);
});

test("mutations require a desktop human release before the adapter contacts the browser", async () => {
  const f = fixture();
  const blocked = await f.adapter.execute({ request_id: "c", operation: "click", selector: "#submit" });
  assert.deepEqual(blocked, { request_id: "c", result: "blocked", reason: "desktop_human_release_required", adapter: "browser_cdp" });
  assert.equal(f.calls.length, 0);
  await f.adapter.execute({ request_id: "s", operation: "submit", selector: "#form", human_release: true });
  assert.equal(f.calls[0]?.method, "Runtime.evaluate");
});

test("observation can require visible user login takeover without reading credentials or cookies", async () => {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const adapter = new BrowserCdpAdapter({ async call(method, params) { calls.push({ method, params }); return { result: { value: { login_takeover_required: true } } }; } });
  const observed = await adapter.execute({ request_id: "login", operation: "observe" });
  assert.equal(observed.session_state, "user_login_takeover_required");
  assert.equal(observed.credential_content_stored, false);
  assert.equal(observed.cookie_content_stored, false);
  assert.match(String(calls[0]?.params?.expression), /input\[type=/);
  assert.doesNotMatch(String(calls[0]?.params?.expression), /document\.cookie|\.value/);
});
