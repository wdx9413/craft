import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMcpHttpHandler, serveMcpHttp } from "../src/mcp-http.ts";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-v01225-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store, service: new CraftService(store) };
}
async function close(f: Awaited<ReturnType<typeof fixture>>) { f.store.close(); await rm(f.root, { recursive: true, force: true }); }

test("v0.12.26 trust profiles compound scoped evidence without granting authority", async () => {
  const f = await fixture();
  try {
    const scope = { task_class: "unit-test", capability_revision: "cap@1", model_ref: "model@1", host_ref: "host@1", effect: "read_only", data_scope: "project" };
    assert.throws(() => f.service.trustProfileRecord({ scope, passed: 0, failed: 0, evidence_ids: ["e"] }), /passed or failed/);
    const low = f.service.trustProfileRecord({ profile_id: "low", scope, passed: 1, failed: 0, evidence_ids: ["e1"] });
    assert.equal((low.recommendation as JsonObject).recommendation, "human_approval");
    assert.equal((f.service.trustProfileRecord({ profile_id: "low", scope, passed: 1, failed: 0, evidence_ids: ["e1"] }) as JsonObject).idempotent, true);
    assert.throws(() => f.service.trustProfileRecord({ profile_id: "low", scope: { ...scope, effect: "local_write" }, passed: 1, evidence_ids: ["e1"] }), /idempotency/);
    const notify = f.service.trustProfileRecord({ profile_id: "notify", scope, passed: 9, failed: 1, evidence_ids: ["e1", "e2", "e3"] });
    assert.equal((notify.recommendation as JsonObject).recommendation, "notify_only");
    const automatic = f.service.trustProfileRecord({ profile_id: "automatic", scope, passed: 10, failed: 0, interventions: 0, evidence_ids: ["e1"] });
    assert.equal((automatic.recommendation as JsonObject).recommendation, "automatic");
    const expired = f.store.create("trust_profile", "expired", { ...scope, attempts: 10, passed: 10, failed: 0, interventions: 0, evidence_ids: ["e"], identity_digest: "x", valid_until: "2000-01-01T00:00:00.000Z", status: "active" });
    assert.equal((f.service.trustProfileRecommend({ profile_id: expired.id }) as JsonObject).recommendation, "blocked");
    assert.equal((f.service.trustProfileRevoke({ profile_id: "automatic", reason: "test" }).profile as JsonObject).status, "revoked");
    assert.equal((f.service.trustProfileRevoke({ profile_id: "automatic" }) as JsonObject).idempotent, true);
    assert.equal((f.service.trustProfileList({ task_class: "unit-test" }).profiles as JsonObject[]).length, 4);
    assert.equal((f.service.trustProfileGet({ profile_id: "low" }).profile as JsonObject).id, "low");
    assert.throws(() => f.service.trustProfileRecord({ scope, passed: 1, evidence_ids: [] }), /at least one/);
    assert.throws(() => f.service.trustProfileRecord({ scope: "bad", passed: 1, evidence_ids: ["e"] }), /scope/);
    assert.throws(() => f.service.trustProfileRecord({ scope, passed: 2, failed: 0, interventions: 3, evidence_ids: ["e"] }), /inconsistent/);
    const mcp = new McpServer(f.service, "full");
    await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "craft_trust_profile_record", arguments: { profile_id: "mcp-trust", scope, passed: 1, evidence_ids: ["e"] } } });
    await mcp.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "craft_trust_profile_recommend", arguments: { profile_id: "mcp-trust" } } });
    await mcp.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "craft_trust_profile_get", arguments: { profile_id: "mcp-trust" } } });
    await mcp.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "craft_trust_profile_list", arguments: {} } });
    await mcp.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "craft_trust_profile_revoke", arguments: { profile_id: "mcp-trust" } } });
    await mcp.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "craft_web_fetch", arguments: { url: "file:///denied" } } });
    const browserMcp = await mcp.handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "craft_web_action_prepare", arguments: { task_id: "mcp-task", workspace: "mcp-workspace", url: "https://example.com", input_digest: "sha256:mcp", operation_id: "mcp-browser" } } });
    await mcp.handle({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "craft_web_operation_get", arguments: { operation_id: "mcp-browser" } } });
    await mcp.handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "craft_web_action_complete", arguments: { operation_id: "mcp-browser", adapter_id: "mcp-adapter", verdict: "blocked", result_digest: "sha256:blocked" } } });
    assert.ok(browserMcp);
  } finally { await close(f); }
});

test("v0.12.26 web boundary observes GET and prepares adapter-only browser actions", async () => {
  const f = await fixture();
  try {
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => new Response(init?.method === "HEAD" ? null : "hello world", { status: 200, headers: { "content-type": "text/plain" } });
    const fetched = await f.service.webFetch({ operation_id: "fetch-one", url: "https://example.com/data", allowed_hosts: ["example.com"], max_bytes: 5, timeout_ms: 1000, method: "GET" }, fetchImpl);
    assert.equal((fetched.operation as JsonObject).raw_content_stored, false); assert.equal((fetched.observation as JsonObject).body, "hello");
    assert.equal((await f.service.webFetch({ operation_id: "fetch-one", url: "https://example.com/data" }, fetchImpl) as JsonObject).idempotent, true);
    await assert.rejects(() => f.service.webFetch({ url: "https://evil.test", allowed_hosts: ["example.com"] }, fetchImpl), /allowed_hosts/);
    await assert.rejects(() => f.service.webFetch({ url: "file:///etc/passwd" }, fetchImpl), /http or https/);
    await f.service.webFetch({ operation_id: "fetch-head", url: "https://example.com", method: "HEAD" }, fetchImpl);
    await assert.rejects(() => f.service.webFetch({ url: "https://example.com", method: "POST" }, fetchImpl), /GET or HEAD/);
    await assert.rejects(() => f.service.webFetch({ url: "https://example.com", timeout_ms: 100 }, (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })), /aborted/);
    const prepared = f.service.webActionPrepare({ operation_id: "browser-one", task_id: "task", workspace: "workspace", url: "https://example.com", input_digest: "sha256:input", operation: "click" });
    assert.equal((prepared.operation as JsonObject).adapter_required, true); assert.equal((prepared.operation as JsonObject).execution_authority, false);
    assert.equal((f.service.webActionPrepare({ operation_id: "browser-one", task_id: "task", workspace: "workspace", url: "https://example.com", input_digest: "sha256:input", operation: "click" }) as JsonObject).idempotent, true);
    assert.throws(() => f.service.webActionPrepare({ operation_id: "browser-one", task_id: "task", workspace: "workspace", url: "https://example.com", input_digest: "sha256:other", operation: "click" }), /idempotency/);
    assert.throws(() => f.service.webActionPrepare({ task_id: "task", workspace: "workspace", url: "https://example.com", input_digest: "x", operation: "bogus" }), /unsupported browser operation/);
    const completed = f.service.webActionComplete({ operation_id: "browser-one", adapter_id: "browser-adapter", verdict: "passed", result_digest: "sha256:result" });
    assert.equal((completed.receipt as JsonObject).observed, true);
    assert.equal((f.service.webActionComplete({ operation_id: "browser-one", adapter_id: "browser-adapter", verdict: "passed", result_digest: "sha256:result" }) as JsonObject).idempotent, true);
    assert.equal((f.service.webOperationGet({ operation_id: "fetch-one" }).operation as JsonObject).kind, "fetch");
    assert.throws(() => f.service.webActionComplete({ operation_id: "fetch-one", adapter_id: "a", verdict: "passed", result_digest: "x" }), /only browser/);
  } finally { await close(f); }
});

test("v0.12.26 exposes MCP over a bounded HTTP POST boundary", async () => {
  const calls: unknown[] = [];
  const handler = createMcpHttpHandler({ handle: async (message) => { calls.push(message); return { jsonrpc: "2.0", id: 1, result: {} }; } });
  const response = { statusCode: 0, headers: new Map<string, string>(), body: "", setHeader(name: string, value: string) { this.headers.set(name, value); }, end(value = "") { this.body = value; } };
  const request = { url: "/mcp", method: "POST", headers: { accept: "application/json" }, async *[Symbol.asyncIterator]() { yield Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}'); } };
  await handler(request as never, response as never); assert.equal(response.statusCode, 200); assert.equal(calls.length, 1);
  const wrong = { statusCode: 0, setHeader() {}, end() {} }; await handler({ url: "/wrong", method: "POST", headers: {} } as never, wrong as never); assert.equal(wrong.statusCode, 404);
  const method = { statusCode: 0, setHeader() {}, end() {} }; await handler({ url: "/mcp", method: "GET", headers: {} } as never, method as never); assert.equal(method.statusCode, 405);
  const accepted = { statusCode: 0, setHeader() {}, end() {} }; await handler({ url: "/mcp", method: "POST", headers: { accept: "text/plain" } } as never, accepted as never); assert.equal(accepted.statusCode, 406);
  const malformed = { statusCode: 0, setHeader() {}, end() {} }; await handler({ url: "/mcp", method: "POST", headers: { accept: "application/json" }, async *[Symbol.asyncIterator]() { yield Buffer.from("not-json"); } } as never, malformed as never); assert.equal(malformed.statusCode, 400);
  const oversized = { statusCode: 0, setHeader() {}, end() {} }; await handler({ url: "/mcp", method: "POST", headers: { accept: "application/json" }, async *[Symbol.asyncIterator]() { yield Buffer.alloc(4 * 1024 * 1024 + 1); } } as never, oversized as never); assert.equal(oversized.statusCode, 413);
  const started = await serveMcpHttp({ port: 0, start: async () => ({ server: { handle: async () => undefined }, close() {} }) }); started.close();
  const previousDataDir = process.env.CRAFT_DATA_DIR; const temporaryDataDir = await mkdtemp(join(tmpdir(), "craft-http-default-")); process.env.CRAFT_DATA_DIR = temporaryDataDir;
  const defaultStarted = await serveMcpHttp({ port: 0 }); defaultStarted.close(); await rm(temporaryDataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.CRAFT_DATA_DIR; else process.env.CRAFT_DATA_DIR = previousDataDir;
});
