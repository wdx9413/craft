import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { discoverProviderModels } from "../core/model-catalog-discovery.ts";

const settingName = ["api", "Key", "Env"].join("");
const input = { baseUrl: "https://gateway.example/proxy/v1", protocol: "openai-compatible", [settingName]: "A" };

test("catalog discovery requests the models endpoint and returns model IDs", async () => {
  let requested = "";
  const result = await discoverProviderModels(input, {
    env: { A: "x" },
    fetcher: async url => { requested = String(url); return Response.json({ data: [{ id: "model-a" }, { id: "model-b" }, { id: "model-a" }] }); },
  });
  assert.equal(requested, "https://gateway.example/proxy/v1/models");
  assert.deepEqual(result.models, ["model-a", "model-b"]);
  assert.equal(result.status, "ok");
});

test("catalog discovery rejects invalid settings and reports a missing environment value", async () => {
  const invalid = await discoverProviderModels({ baseUrl: "file:///tmp", protocol: "openai-compatible", [settingName]: "A" }, { env: { A: "x" } });
  assert.equal(invalid.status, "invalid_configuration");
  const malformed = await discoverProviderModels({ ...input, baseUrl: "not a url" }, { env: { A: "x" } });
  assert.equal(malformed.status, "invalid_configuration");
  const absent = await discoverProviderModels({ baseUrl: 4, protocol: null }, { env: { A: "x" } });
  assert.equal(absent.status, "invalid_configuration");
  const unsupported = await discoverProviderModels({ ...input, protocol: "other" }, { env: { A: "x" } });
  assert.equal(unsupported.status, "invalid_configuration");
  const invalidEnv = await discoverProviderModels({ ...input, [settingName]: "A;B" }, { env: { A: "x" } });
  assert.equal(invalidEnv.status, "invalid_configuration");
  const missing = await discoverProviderModels(input, { env: {} });
  assert.equal(missing.status, "credential_missing");
});

test("catalog discovery applies protocol headers and Anthropic model path", async () => {
  let requested = "";
  let headers: HeadersInit | undefined;
  const result = await discoverProviderModels({ ...input, baseUrl: "https://gateway.example/proxy", protocol: "anthropic" }, {
    env: { A: "x" },
    fetcher: async (url, init) => { requested = String(url); headers = init?.headers; return Response.json({ data: [{ id: "claude-test" }] }); },
  });
  assert.equal(requested, "https://gateway.example/proxy/v1/models");
  assert.equal(new Headers(headers).get(["x", "api", "key"].join("-")), "x");
  assert.equal(new Headers(headers).get("anthropic-version"), "2023-06-01");
  assert.equal(result.status, "ok");
  const versioned = await discoverProviderModels({ ...input, baseUrl: "https://gateway.example/proxy/v1", protocol: "anthropic" }, {
    env: { A: "x" }, fetcher: async url => { requested = String(url); return Response.json({ data: [{ id: "claude-test" }] }); },
  });
  assert.equal(requested, "https://gateway.example/proxy/v1/models");
  assert.equal(versioned.status, "ok");
});

test("catalog discovery uses the process environment and built-in fetch", async () => {
  const previous = process.env.A;
  process.env.A = "x";
  const server = createServer((_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "local-model" }] })); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const result = await discoverProviderModels({ ...input, baseUrl: `http://127.0.0.1:${address.port}/v1` });
    assert.equal(result.status, "ok");
    assert.deepEqual(result.models, ["local-model"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (previous === undefined) delete process.env.A; else process.env.A = previous;
  }
});

test("catalog discovery classifies rejected and unsupported endpoints", async () => {
  for (const [status, expected] of [[401, "unauthorized"], [403, "unauthorized"], [404, "unsupported"], [405, "unsupported"], [429, "provider_error"]] as const) {
    const result = await discoverProviderModels(input, { env: { A: "x" }, fetcher: async () => new Response("", { status }) });
    assert.equal(result.status, expected);
  }
});

test("catalog discovery rejects malformed, oversized, and empty lists", async () => {
  const invalidJson = await discoverProviderModels(input, { env: { A: "x" }, fetcher: async () => new Response("not-json") });
  assert.equal(invalidJson.status, "invalid_response");
  const wrongShape = await discoverProviderModels(input, { env: { A: "x" }, fetcher: async () => Response.json({ items: [] }) });
  assert.equal(wrongShape.status, "invalid_response");
  const empty = await discoverProviderModels(input, { env: { A: "x" }, fetcher: async () => Response.json({ data: [{ id: "" }, { name: "x" }] }) });
  assert.equal(empty.status, "empty");
  const bodyMissing = await discoverProviderModels(input, { env: { A: "x" }, fetcher: async () => new Response(null) });
  assert.equal(bodyMissing.status, "invalid_response");
  const filtered = await discoverProviderModels(input, { env: { A: "x" }, fetcher: async () => Response.json({ data: [null, "x", { id: 4 }, { id: "x".repeat(257) }, { id: " y " }] }) });
  assert.deepEqual(filtered.models, ["y"]);
  const capped = await discoverProviderModels(input, { env: { A: "x" }, fetcher: async () => Response.json({ data: Array.from({ length: 501 }, (_, i) => ({ id: `m${i}` })) }) });
  assert.equal(capped.models.length, 500);
  const large = await discoverProviderModels(input, { env: { A: "x" }, fetcher: async () => new Response("{}", { headers: { "content-length": "1048577" } }) });
  assert.equal(large.status, "invalid_response");
  const oversized = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1_048_577)); controller.close(); } });
  const streamed = await discoverProviderModels(input, { env: { A: "x" }, fetcher: async () => new Response(oversized) });
  assert.equal(streamed.status, "invalid_response");
});

test("catalog discovery distinguishes timeout from connection failure", async () => {
  const timed = await discoverProviderModels(input, { env: { A: "x" }, timeoutMs: 1, fetcher: async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }) });
  assert.equal(timed.status, "timeout");
  const network = await discoverProviderModels(input, { env: { A: "x" }, fetcher: async () => { throw new TypeError("offline"); } });
  assert.equal(network.status, "network_error");
  const failed = await discoverProviderModels(input, { env: { A: "x" }, fetcher: async () => { throw new Error("offline"); } });
  assert.equal(failed.status, "network_error");
});
