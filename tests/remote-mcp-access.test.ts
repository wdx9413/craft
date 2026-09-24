import assert from "node:assert/strict";
import test from "node:test";
import { createMcpHttpHandler } from "../core/mcp-http.ts";
import { RemoteMcpAccessError, RemoteMcpAccessPolicy } from "../core/remote-mcp-access.ts";

function policy(overrides: Partial<ConstructorParameters<typeof RemoteMcpAccessPolicy>[0]> = {}) {
  return new RemoteMcpAccessPolicy({
    issuer: "https://issuer.example.test", audience: "https://craft.example.test/mcp", requiredScopes: ["craft.invoke"],
    now: () => "2030-01-01T00:00:00.000Z",
    verifyAccessToken: async (token) => {
      assert.equal(token, "opaque-token");
      return { subject: "user-1", client_id: "client-1", issuer: "https://issuer.example.test", audience: "https://craft.example.test/mcp", scopes: ["craft.invoke", "profile"], expires_at: "2030-01-01T00:01:00.000Z" };
    },
    ...overrides,
  });
}

test("v0.12.29 remote MCP access is HTTPS-only, audience-bound, scope-bound and token-free in receipts", async () => {
  const access = policy();
  const receipt = await access.authorize({ authorization: "Bearer opaque-token", secure_transport: true });
  assert.equal(receipt.status, "accepted");
  assert.equal(receipt.audience, "https://craft.example.test/mcp");
  assert.equal(receipt.token_stored, false);
  assert.match(receipt.subject_digest, /^sha256:/);
  assert.equal(JSON.stringify(receipt).includes("opaque-token"), false);

  await assert.rejects(() => access.authorize({ authorization: "Bearer opaque-token", secure_transport: false }), /secure transport/);
  await assert.rejects(() => access.authorize({ authorization: "Basic opaque-token", secure_transport: true }), /Bearer/);
  await assert.rejects(() => new RemoteMcpAccessPolicy({ issuer: "https://issuer.example.test", audience: "https://craft.example.test/mcp" }).authorize({ authorization: "Bearer opaque-token", secure_transport: true }), /verifier/);
  await assert.rejects(() => policy({ verifyAccessToken: async () => ({ subject: "user", issuer: "wrong", audience: "https://craft.example.test/mcp", scopes: ["craft.invoke"], expires_at: "2030-01-01T00:01:00.000Z" }) }).authorize({ authorization: "Bearer opaque-token", secure_transport: true }), /issuer/);
  await assert.rejects(() => policy({ verifyAccessToken: async () => ({ subject: "user", issuer: "https://issuer.example.test", audience: "wrong", scopes: ["craft.invoke"], expires_at: "2030-01-01T00:01:00.000Z" }) }).authorize({ authorization: "Bearer opaque-token", secure_transport: true }), /audience/);
  await assert.rejects(() => policy({ verifyAccessToken: async () => ({ subject: "user", issuer: "https://issuer.example.test", audience: "https://craft.example.test/mcp", scopes: [], expires_at: "2030-01-01T00:01:00.000Z" }) }).authorize({ authorization: "Bearer opaque-token", secure_transport: true }), /scope/);
  await assert.rejects(() => policy({ verifyAccessToken: async () => ({ subject: "user", issuer: "https://issuer.example.test", audience: "https://craft.example.test/mcp", scopes: ["craft.invoke"], expires_at: "2029-12-31T23:59:00.000Z" }) }).authorize({ authorization: "Bearer opaque-token", secure_transport: true }), /expired/);
});

test("v0.12.29 remote MCP access limits principals and HTTP denies before invoking MCP", async () => {
  const limited = policy({ requestsPerMinute: 1 });
  await limited.authorize({ authorization: "Bearer opaque-token", secure_transport: true });
  await assert.rejects(() => limited.authorize({ authorization: "Bearer opaque-token", secure_transport: true }), (error: unknown) => error instanceof RemoteMcpAccessError && error.statusCode === 429);
  const calls: unknown[] = [];
  const handler = createMcpHttpHandler({ handle: async (message) => { calls.push(message); return { jsonrpc: "2.0", id: 1, result: {} }; } }, { remoteAccess: policy(), secureTransport: () => true });
  const response = { statusCode: 0, headers: new Map<string, string>(), body: "", setHeader(name: string, value: string) { this.headers.set(name, value); }, end(value = "") { this.body = value; } };
  await handler({ url: "/mcp", method: "POST", headers: { accept: "application/json", authorization: "Bearer opaque-token" }, async *[Symbol.asyncIterator]() { yield Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}'); } } as never, response as never);
  assert.equal(response.statusCode, 200); assert.equal(calls.length, 1); assert.equal(response.headers.get("cache-control"), "no-store");
  const denied = { statusCode: 0, setHeader() {}, end() {} };
  await handler({ url: "/mcp", method: "POST", headers: { accept: "application/json" }, async *[Symbol.asyncIterator]() { yield Buffer.from("{}"); } } as never, denied as never);
  assert.equal(denied.statusCode, 401); assert.equal(calls.length, 1);
});

test("v0.12.29 remote MCP access validates configuration, principal shape and rolling rate windows", async () => {
  assert.throws(() => new RemoteMcpAccessPolicy({ issuer: " ", audience: "a" }), /issuer/);
  assert.throws(() => new RemoteMcpAccessPolicy({ issuer: "i", audience: "a", requiredScopes: ["a", "a"] }), /unique/);
  assert.throws(() => new RemoteMcpAccessPolicy({ issuer: "i", audience: "a", requestsPerMinute: 0 }), /positive/);
  const bare = new RemoteMcpAccessPolicy({ issuer: "issuer", audience: "audience", verifyAccessToken: async () => ({ subject: "user", issuer: "issuer", audience: "audience", scopes: [], expires_at: "2099-01-01T00:00:00.000Z" }) });
  const bareReceipt = await bare.authorize({ authorization: "Bearer opaque-token", secure_transport: true });
  assert.equal(bareReceipt.client_id_digest, null); assert.deepEqual(bareReceipt.scopes, []);
  await assert.rejects(() => bare.authorize({ authorization: ["Bearer opaque-token"], secure_transport: true }), /one Bearer/);
  await assert.rejects(() => policy({ verifyAccessToken: async () => ({ subject: "user", issuer: "https://issuer.example.test", audience: "https://craft.example.test/mcp", scopes: "craft.invoke" as never, expires_at: "2030-01-01T00:01:00.000Z" }) }).authorize({ authorization: "Bearer opaque-token", secure_transport: true }), /scope/);
  await assert.rejects(() => policy({ verifyAccessToken: async () => ({ subject: "user", issuer: "https://issuer.example.test", audience: "https://craft.example.test/mcp", scopes: ["craft.invoke"], expires_at: "not-a-date" }) }).authorize({ authorization: "Bearer opaque-token", secure_transport: true }), /expired/);
  let now = "2030-01-01T00:00:00.000Z";
  const rolling = policy({ requestsPerMinute: 1, now: () => now, verifyAccessToken: async () => ({ subject: "user-1", client_id: "client-1", issuer: "https://issuer.example.test", audience: "https://craft.example.test/mcp", scopes: ["craft.invoke"], expires_at: "2031-01-01T00:00:00.000Z" }) });
  await rolling.authorize({ authorization: "Bearer opaque-token", secure_transport: true }); now = "2030-01-01T00:01:00.000Z";
  await rolling.authorize({ authorization: "Bearer opaque-token", secure_transport: true });
  const badClock = policy({ now: () => "not-a-date" });
  await assert.rejects(() => badClock.authorize({ authorization: "Bearer opaque-token", secure_transport: true }), /clock/);
});
