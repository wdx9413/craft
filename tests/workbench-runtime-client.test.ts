import assert from "node:assert/strict";
import test from "node:test";
// The Workbench transport is browser JavaScript, exercised directly without a DOM.
// @ts-expect-error JavaScript module intentionally ships without generated declarations.
import { createRuntimeClient } from "../workbench/runtime-client.js";

test("browser transport preserves token, body, methods and bounded response errors", async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  let status = 200; let body = '{"value":1}';
  const fetcher = async (path: string, init: RequestInit) => { calls.push({ path, init }); return new Response(body, { status }); };
  const api = createRuntimeClient({ invoke: null, fetch: fetcher, token: () => "trusted" });
  assert.deepEqual(await api("/api/test"), { value: 1 }); assert.equal(calls[0].init.method, "GET");
  assert.deepEqual(calls[0].init.headers, { authorization: "Bearer trusted" });
  await api("/api/test", { method: "POST", body: { value: 2 } }); assert.equal(calls[1].init.body, '{"value":2}');
  assert.deepEqual(calls[1].init.headers, { authorization: "Bearer trusted", "content-type": "application/json" });
  body = ""; assert.deepEqual(await api("/api/test"), {});
  body = "legacy"; assert.deepEqual(await api("/api/test"), { error: "legacy" });
  status = 422; await assert.rejects(api("/api/test"), /legacy/);
  body = "{}"; await assert.rejects(api("/api/test"), /HTTP 422/);
  body = '{"error":"rejected"}'; await assert.rejects(api("/api/test"), /rejected/);
});
test("bundled Desktop uses the native bridge without exposing runtime token to JavaScript", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let status = 200; let body = "{}";
  const api = createRuntimeClient({ invoke: async (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return { status, body }; } });
  await api("/api/test"); await api("/api/test", { method: "PATCH", body: { value: 3 } });
  assert.deepEqual(calls, [{ name: "workbench_request", args: { method: "GET", path: "/api/test", body: "" } }, { name: "workbench_request", args: { method: "PATCH", path: "/api/test", body: '{"value":3}' } }]);
  status = 403; body = '{"error":"scope denied"}'; await assert.rejects(api("/api/test"), /scope denied/);
});
