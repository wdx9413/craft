import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { KeywordRetrievalPort, OpenAiCompatibleEmbeddingRetrievalPort, temporalMemorySelect } from "../core/retrieval-port.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";

const now = new Date("2026-09-27T10:00:00Z");
const memory = (id: string, extra: JsonObject = {}) => ({ id, status: "active", topic: "preference", effective_from: "2026-09-26T00:00:00Z", version: 1, content_digest: id, ...extra });

test("temporal retrieval excludes future and invalid dates without destroying historical events", () => {
  assert.throws(() => temporalMemorySelect([], new Date("invalid"), false), /valid timestamp/);
  const items = [memory("current"), memory("future", { effective_from: "2026-09-28T00:00:00Z" }), memory("bad", { effective_from: "bad" }), memory("bad-expiry", { valid_until: "bad" }), memory("numeric-expiry", { valid_until: 0 }), memory("expired", { valid_until: "2026-01-01" }), memory("revoked", { status: "revoked" })];
  const before = structuredClone(items);
  const result = temporalMemorySelect(items, now, false);
  assert.deepEqual(result.selected.map(x => x.id), ["current"]);
  assert.deepEqual(result.excluded.map(x => x.reason), ["not_yet_effective", "invalid_effective_from", "invalid_valid_until", "invalid_valid_until", "expired", "not_current"]);
  assert.deepEqual(items, before);
  assert.deepEqual(temporalMemorySelect(items, now, true).selected.map(x => x.id), ["future", "current", "expired", "revoked"]);
  assert.deepEqual(temporalMemorySelect([memory("boundary", { effective_from: now.toISOString(), valid_until: now.toISOString() })], now, false).selected.map(x => x.id), ["boundary"]);
});

test("temporal retrieval keeps conflicts explicit and deterministically selects equivalent revisions", () => {
  const three = [memory("a", { content_digest: "same", version: 3 }), memory("b", { content_digest: "same", version: 2 }), memory("c", { content_digest: "different" })];
  for (const order of [three, [...three].reverse()]) {
    const conflict = temporalMemorySelect(order, now, false);
    assert.deepEqual(conflict.selected, []);
    assert.deepEqual(conflict.excluded.map(item => item.memory_id).sort(), ["a", "b", "c"]);
    assert(conflict.excluded.every(item => item.reason === "temporal_conflict_abstain"));
    assert.equal(temporalMemorySelect(order, now, true).selected.length, 3);
  }
  assert.equal(temporalMemorySelect([memory("a"), memory("b")], now, false).excluded[0]!.reason, "temporal_conflict_abstain");
  assert.deepEqual(temporalMemorySelect([memory("a", { content_digest: "same" }), memory("b", { content_digest: "same", version: 2 })], now, false).selected.map(x => x.id), ["b"]);
  const fallback = [{ id: "a", status: "active", topic: "", updated_at: "2026-09-25", version: 1 }, { id: "b", status: "active", version: 1 }, { id: "invalid", status: "active", effective_from: false }];
  assert.deepEqual(temporalMemorySelect(fallback, now, false).selected.map(x => x.id), ["a", "b"]);
  const undated = memory("undated", { effective_from: null, updated_at: null, content_digest: "same", version: 9 });
  const dated = memory("dated", { effective_from: null, updated_at: "1990-01-01T00:00:00Z", content_digest: "same" });
  for (const order of [[undated, dated], [dated, undated]]) assert.deepEqual(temporalMemorySelect(order, now, false).selected.map(x => x.id), ["dated"]);
});

test("keyword retrieval is local, bounded to supplied documents and stable on score ties", async () => {
  const port = new KeywordRetrievalPort();
  assert.deepEqual((await port.search("alpha beta", [{ id: "b", body: "ALPHA beta" }, { id: "a", body: "alpha beta" }, { id: "c", body: "alpha" }, { id: "d", body: "other" }])).hits.map(x => x.id), ["a", "b", "c"]);
  assert.equal((await port.search("", [])).execution.used, "keyword");
});

function provider() { return new OpenAiCompatibleEmbeddingRetrievalPort({ endpoint: `https://fixture.invalid/${randomUUID()}`, model: "fixture", credential_env: "CRAFT_RETRIEVAL_PORT_TEST_KEY" }); }
const documents = [{ id: "a", body: "same" }, { id: "b", body: "other" }];

test("embedding retrieval rejects malformed vectors and never caches a partial invalid response", async (t) => {
  const old = process.env.CRAFT_RETRIEVAL_PORT_TEST_KEY; process.env.CRAFT_RETRIEVAL_PORT_TEST_KEY = "fixture-only";
  try {
    const invalidBody = t.mock.method(globalThis, "fetch", async () => new Response("null"));
    assert.equal((await provider().search("query", documents)).execution.unavailable_reason, "invalid_embedding_response"); invalidBody.mock.restore();
    for (const row of [[], "invalid", { embedding: false }, { embedding: [1e308] }, { index: "0", embedding: [1] }, { index: -1, embedding: [1] }, { index: 0.5, embedding: [1] }]) {
      const invalid = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ data: [row] })));
      assert.equal((await provider().search("query", [])).execution.unavailable_reason, "invalid_embedding_response"); invalid.mock.restore();
    }
    for (const data of [undefined, [], [{ embedding: [] }, { embedding: [1] }, { embedding: [1] }], [{ embedding: [1, 0] }, { embedding: [1] }, { embedding: [0, 1] }], [{ embedding: ["1"] }, { embedding: [1] }, { embedding: [1] }], [null, {}, {}], [{ embedding: [NaN] }, { embedding: [1] }, { embedding: [1] }], [{ embedding: [Infinity] }, { embedding: [1] }, { embedding: [1] }], [{ index: 0, embedding: [1] }, { index: 0, embedding: [1] }, { index: 2, embedding: [1] }], [{ index: 4, embedding: [1] }, { index: 1, embedding: [1] }, { index: 2, embedding: [1] }]]) {
      const port = provider(); let calls = 0;
      const mocked = t.mock.method(globalThis, "fetch", async () => { calls++; return { ok: true, json: async () => ({ data }) } as Response; });
      assert.equal((await port.search("query", documents)).execution.used, "keyword");
      assert.equal((await port.search("query", documents)).execution.used, "keyword");
      assert.equal(calls, 2); mocked.mock.restore();
    }
  } finally { if (old === undefined) delete process.env.CRAFT_RETRIEVAL_PORT_TEST_KEY; else process.env.CRAFT_RETRIEVAL_PORT_TEST_KEY = old; }
});

test("embedding retrieval respects indexed order, deduplicates inputs, caches valid vectors and rejects dimension drift", async (t) => {
  const old = process.env.CRAFT_RETRIEVAL_PORT_TEST_KEY; process.env.CRAFT_RETRIEVAL_PORT_TEST_KEY = "fixture-only";
  try {
    const port = provider(); let calls = 0;
    const mocked = t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      calls++; const input = JSON.parse(String(init.body)).input as string[];
      assert.equal((init.headers as Record<string, string>).authorization, "Bearer fixture-only");
      return new Response(JSON.stringify({ data: input.map((value, index) => ({ index, embedding: value === "same" || value === "query" ? [1, 0] : [0, 1] })).reverse(), usage: { total_tokens: input.length } }));
    });
    const docs = [{ id: "b", body: "same" }, { id: "a", body: "same" }, { id: "c", body: "other" }];
    const result = await port.search("query", docs);
    assert.deepEqual(result.hits.map(x => x.id), ["a", "b"]);
    assert.equal(result.execution.used, "vector"); assert(result.execution.cost_summary);
    assert.equal((await port.search("query", docs)).execution.cost_summary!.billable_units, 0); assert.equal(calls, 1);
    mocked.mock.restore();
    const drift = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ data: [{ embedding: [1] }] })));
    assert.equal((await port.search("same", [{ id: "new", body: "new" }])).execution.used, "keyword");
    drift.mock.restore();
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => new Response(JSON.stringify({ data: (JSON.parse(String(init.body)).input as string[]).map(() => ({ embedding: [0, 0] })) })));
    assert.equal((await provider().search("zero", documents)).hits.length, 0);
    assert.equal((await port.search("same", [{ id: "new", body: "new" }])).execution.used, "vector");
    assert.deepEqual((await port.search("new", [{ id: "a", body: "same" }])).hits, []);
  } finally { if (old === undefined) delete process.env.CRAFT_RETRIEVAL_PORT_TEST_KEY; else process.env.CRAFT_RETRIEVAL_PORT_TEST_KEY = old; }
});

test("embedding unavailability never pretends vector execution or leaks a provider error body", async (t) => {
  assert.equal((await new OpenAiCompatibleEmbeddingRetrievalPort({}).search("x", [])).execution.provider, null);
  assert.equal((await new OpenAiCompatibleEmbeddingRetrievalPort({ endpoint: "https://fixture.invalid" }).search("x", [])).execution.model, null);
  assert.equal((await new OpenAiCompatibleEmbeddingRetrievalPort({ endpoint: "https://fixture.invalid", model: "fixture", credential_env: "CRAFT_MISSING_RETRIEVAL_TEST_KEY" }).search("x", [])).execution.unavailable_reason, "embedding_provider_unavailable");
  const old = process.env.CRAFT_RETRIEVAL_PORT_TEST_KEY; process.env.CRAFT_RETRIEVAL_PORT_TEST_KEY = "fixture-only";
  try {
    const http = t.mock.method(globalThis, "fetch", async () => new Response("", { status: 503 }));
    assert.equal((await provider().search("x", [])).execution.unavailable_reason, "http_503"); http.mock.restore();
    for (const error of [new Error("token=fixture-only"), "raw-private-payload"]) {
      const mock = t.mock.method(globalThis, "fetch", async () => { throw error; });
      assert.equal((await provider().search("x", [])).execution.unavailable_reason, "embedding_request_failed"); mock.mock.restore();
    }
  } finally { if (old === undefined) delete process.env.CRAFT_RETRIEVAL_PORT_TEST_KEY; else process.env.CRAFT_RETRIEVAL_PORT_TEST_KEY = old; }
});
