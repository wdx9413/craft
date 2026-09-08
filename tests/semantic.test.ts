import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Catalog } from "../src/catalog.ts";
import { initializeConfig } from "../src/config.ts";
import { craftPaths } from "../src/paths.ts";
import { cosine, embeddingFingerprint, OpenAiCompatibleEmbeddingProvider, sanitizeEmbeddingText, semanticFailureReason,
  type EmbeddingProvider } from "../src/semantic.ts";
import { CraftStore } from "../src/store.ts";
import { CraftService } from "../src/service.ts";

class StubEmbeddings implements EmbeddingProvider {
  readonly fingerprint: string;
  readonly label = { name: "stub", model: "v1" };
  calls = 0;
  readonly vectors: Record<string, number[]>;
  readonly failure?: Error;
  constructor(vectors: Record<string, number[]>, failure?: Error, fingerprint = "stub-v1") {
    this.vectors = vectors; this.failure = failure; this.fingerprint = fingerprint;
  }
  async embed(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    if (this.failure) throw this.failure;
    return texts.map((text) => this.vectors[text] || [0, 1]);
  }
}

async function fixture(): Promise<{ root: string; library: string; store: CraftStore; catalog: Catalog }> {
  const root = join(tmpdir(), `craft-semantic-${process.pid}-${Date.now()}-${Math.random()}`);
  const library = join(root, "library");
  await mkdir(join(library, "billing"), { recursive: true });
  await mkdir(join(library, "incident"), { recursive: true });
  await writeFile(join(library, "billing", "SKILL.md"), "---\nname: billing\ndescription: payment checkout\n---\nprivate body token=do-not-upload");
  await writeFile(join(library, "incident", "SKILL.md"), "---\nname: incident\ndescription: production outage\n---\ntrace");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const catalog = new Catalog(store);
  await catalog.addSource(library);
  return { root, library, store, catalog };
}

test("semantic catalog is opt-in, cached, hybrid-ranked, and safely degrades", async () => {
  const current = await fixture();
  try {
    assert.deepEqual(current.catalog.semanticStatus(), { mode: "disabled", reason: "not_configured", indexed_capabilities: 0 });
    assert.equal((await current.catalog.searchHybrid("production"))[0].name, "incident");
    const provider = new StubEmbeddings({
      "billing\npayment checkout": [0, 1], "incident\nproduction outage": [1, 0], "checkout failure": [0, 1],
    });
    const catalog = new Catalog(current.store, provider);
    assert.equal((await catalog.searchHybrid("checkout failure"))[0].name, "billing");
    assert.equal(catalog.semanticStatus().mode, "ready");
    assert.equal(provider.calls, 2);
    await catalog.searchHybrid("checkout failure");
    assert.equal(provider.calls, 3);
    await writeFile(join(current.library, "billing", "SKILL.md"), "---\nname: billing\ndescription: changed checkout\n---\nbody");
    await catalog.scan();
    await catalog.searchHybrid("checkout failure");
    assert.equal(provider.calls, 5);

    const broken = new StubEmbeddings({}, new Error("offline"));
    const fallback = new Catalog(current.store, broken);
    assert.equal((await fallback.searchHybrid("production"))[0].name, "incident");
    assert.equal(fallback.semanticStatus().reason, "provider_error");
    const calls = broken.calls;
    await fallback.searchHybrid("production");
    assert.equal(broken.calls, calls);
    assert.equal(fallback.semanticStatus().reason, "cooldown");
  } finally { current.store.close(); await rm(current.root, { recursive: true, force: true }); }
});

test("semantic catalog handles empty indexes and invalid embedding dimensions without changing keyword results", async () => {
  const root = join(tmpdir(), `craft-semantic-empty-${process.pid}-${Date.now()}`);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const empty = new Catalog(store, new StubEmbeddings({}));
    assert.deepEqual(await empty.searchHybrid("anything"), []);
    const library = join(root, "library");
    await mkdir(library, { recursive: true });
    await writeFile(join(library, "SKILL.md"), "---\nname: alpha\ndescription: keyword\n---\nbody");
    const invalid = new Catalog(store, new StubEmbeddings({ "alpha\nkeyword": [1], keyword: [1, 2] }));
    await invalid.addSource(library);
    assert.equal((await invalid.searchHybrid("keyword"))[0].name, "alpha");
    assert.equal(invalid.semanticStatus().reason, "invalid_response");
    const noDimension = new Catalog(store, new StubEmbeddings({ "alpha\nkeyword": [] }));
    assert.equal((await noDimension.searchHybrid("keyword"))[0].name, "alpha");
    assert.equal(noDimension.semanticStatus().reason, "invalid_response");
    const wrongCount = new Catalog(store, { fingerprint: "wrong-count", label: { name: "wrong", model: "count" },
      async embed() { return []; } });
    assert.equal((await wrongCount.searchHybrid("keyword"))[0].name, "alpha");
    assert.equal(wrongCount.semanticStatus().reason, "invalid_response");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("hybrid ranking resolves semantic ties and legacy alias fallback deterministically", async () => {
  const root = join(tmpdir(), `craft-semantic-tie-${process.pid}-${Date.now()}`);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    store.save("capability", "legacy-alias", { name: "legacy", description: "none", body: "body", search_text: "body", metadata: { aliases: ["only-alias"] } });
    const lexical = new Catalog(store);
    assert.equal(lexical.search("only-alias")[0].name, "legacy");
    store.save("capability", "one", { name: "one", description: "first", body: "", search_text: "", metadata: {} });
    store.save("capability", "two", { name: "two", description: "second", body: "", search_text: "", metadata: {} });
    const tied = new Catalog(store, new StubEmbeddings({ "legacy\nnone\nonly-alias": [1], "one\nfirst": [1], "two\nsecond": [1], nowhere: [1] }));
    assert.deepEqual((await tied.searchHybrid("nowhere")).map((item) => item.name), ["legacy", "one", "two"]);
    const mismatched = new Catalog(store, new StubEmbeddings({ "legacy\nnone\nonly-alias": [1], "one\nfirst": [1, 0], "two\nsecond": [1], nowhere: [1] }, undefined, "stub-v2"));
    assert.deepEqual(await mismatched.searchHybrid("nowhere"), []);
    assert.equal(mismatched.semanticStatus().reason, "invalid_response");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("service loads semantic retrieval only from explicit local configuration", async () => {
  const root = join(tmpdir(), `craft-semantic-service-${process.pid}-${Date.now()}`);
  const paths = craftPaths(join(root, "data"));
  const store = await new CraftStore(paths).open();
  try {
    assert.equal((await CraftService.open(store)).semanticSearchStatus().mode, "disabled");
    await initializeConfig({ mode: "provider", semanticSearch: { provider: {
      protocol: "openai-compatible", name: "configured", baseUrl: "https://embed.example/v1", model: "model",
    } } }, paths);
    const service = await CraftService.open(store);
    assert.equal(service.semanticSearchStatus().mode, "configured");
    assert.deepEqual(service.semanticSearchStatus().provider, { name: "configured", model: "model" });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("OpenAI-compatible embeddings validate responses, redact assignments, and classify failures", async () => {
  const originalFetch = globalThis.fetch;
  const oldKey = process.env.CRAFT_EMBED_TEST_KEY;
  process.env.CRAFT_EMBED_TEST_KEY = "actual-secret";
  try {
    let request: RequestInit | undefined;
    globalThis.fetch = (async (_url, init) => {
      request = init;
      return new Response(JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }), { status: 200 });
    }) as typeof fetch;
    const provider = new OpenAiCompatibleEmbeddingProvider({ protocol: "openai-compatible", name: "local", baseUrl: "https://example.test/v1/",
      model: "embed", apiKeyEnv: "CRAFT_EMBED_TEST_KEY", timeoutMs: 100 });
    assert.deepEqual(await provider.embed(["one", "two"]), [[1, 0], [0, 1]]);
    assert.equal((request?.headers as Record<string, string>).authorization, "Bearer actual-secret");
    assert.deepEqual(await provider.embed([]), []);
    assert.ok(embeddingFingerprint(provider.config));
    assert.equal(provider.label.name, "local");
    assert.equal(sanitizeEmbeddingText("token=abc api-key: xyz ok"), "[redacted] [redacted] ok");
    assert.equal(cosine([1, 0], [1, 0]), 1);
    assert.equal(cosine([0, 0], [1, 0]), 0);
    assert.throws(() => cosine([1], [1, 0]), /dimensions/);

    globalThis.fetch = (async () => new Response("", { status: 401 })) as typeof fetch;
    await assert.rejects(() => provider.embed(["one"]), /HTTP 401/);
    assert.equal(semanticFailureReason(new Error("HTTP 401")), "authentication");
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{}] }), { status: 200 })) as typeof fetch;
    await assert.rejects(() => provider.embed(["one"]), /Invalid embedding response/);
    assert.equal(semanticFailureReason(new Error("Invalid embedding response")), "invalid_response");
    assert.equal(semanticFailureReason(new Error("other")), "provider_error");
    assert.equal(semanticFailureReason(null), "provider_error");
    assert.equal(semanticFailureReason(new DOMException("", "AbortError")), "timeout");
    assert.equal(semanticFailureReason(new DOMException("", "TimeoutError")), "timeout");
    globalThis.fetch = (async () => new Response(JSON.stringify([]), { status: 200 })) as typeof fetch;
    await assert.rejects(() => provider.embed(["one"]), /Invalid embedding response/);
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;
    await assert.rejects(() => provider.embed(["one"]), /Invalid embedding response/);
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [] }] }), { status: 200 })) as typeof fetch;
    await assert.rejects(() => provider.embed(["one"]), /Invalid embedding response/);
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [null] }), { status: 200 })) as typeof fetch;
    await assert.rejects(() => provider.embed(["one"]), /Invalid embedding response/);
    const noKey = new OpenAiCompatibleEmbeddingProvider({ protocol: "openai-compatible", name: "none", baseUrl: "https://example.test/v1", model: "embed" });
    globalThis.fetch = (async (_url, init) => {
      assert.equal((init?.headers as Record<string, string>).authorization, undefined);
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }), { status: 200 });
    }) as typeof fetch;
    assert.deepEqual(await noKey.embed(["one"]), [[1]]);
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }, { index: 1, embedding: [1, 0] }] }), { status: 200 })) as typeof fetch;
    await assert.rejects(() => noKey.embed(["one", "two"]), /dimensions differ/);
    globalThis.fetch = ((_url, init) => new Promise((_resolve, reject) => {
      (init?.signal as AbortSignal).addEventListener("abort", () => reject(new DOMException("", "AbortError")));
    })) as typeof fetch;
    await assert.rejects(() => new OpenAiCompatibleEmbeddingProvider({ protocol: "openai-compatible", name: "slow", baseUrl: "https://example.test", model: "embed", timeoutMs: 100 }).embed(["one"]), /AbortError/);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldKey === undefined) delete process.env.CRAFT_EMBED_TEST_KEY; else process.env.CRAFT_EMBED_TEST_KEY = oldKey;
  }
});
