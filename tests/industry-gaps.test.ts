import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { prepareAblations } from "../scripts/eval/component-ablation.ts";
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { payload, stableDigest } from "../core/digest.ts";
import { ContextResolutionKernel } from "../core/context-resolution.ts";
import { KnowledgeContribution } from "../capability/craft-knowledge/contribution.ts";
import { KnowledgeSourceRegistry } from "../capability/craft-knowledge/knowledge-source-registry.ts";
import { OpenAiCompatibleEmbeddingRetrievalPort, KeywordRetrievalPort } from "../core/retrieval-port.ts";
import ts from "typescript";
import { analyzeTypeScript, createCheckpointCompilerHost } from "../capability/craft-codebase/typescript-analysis.ts";
import { normalizeLspSymbols } from "../capability/craft-codebase/lsp-adapter.ts";
import { runRetrievalEvaluation } from "../core/retrieval-evaluation.ts";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";

const originalFetch = globalThis.fetch;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-industry-")), store = await new CraftStore(craftPaths(join(root, "data"))).open();
  store.create("knowledge_source", "source", { status: "active", trust: "verified" });
  const context = new ContextResolutionKernel(store, [new KnowledgeContribution(store)]);
  const scope = { scope_kind: "project", scope_id: "fixture" };
  const memory = (id: string, extra: JsonObject = {}) => store.create("memory_ledger", id, { source_id: "source", scope: { kind: "project", id: "fixture" }, status: "active", valid_until: null,
    content: "alpha", content_digest: id, kind: "preference", sensitivity: "internal", ...extra });
  return { root, store, context, scope, memory, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("shared ranking prevents weak Memory starving Knowledge; required items and aggregate budgets hold", async () => {
  const f = await fixture();
  try {
    f.memory("weak");
    f.store.create("knowledge_claim", "specific", { source_id: "source", scope: "project:fixture", status: "reviewed", content: "alpha beta gamma", content_digest: "specific", evidence_ids: [] });
    const args = { ...f.scope, query: "alpha beta gamma", max_items: 1 };
    const mixed = await f.context.resolve(args);
    assert.deepEqual(mixed.items, []);
    assert.equal(((mixed.contributions as JsonObject[])[0]!.items as JsonObject[])[0]!.claim_id, "specific");
    assert.equal((mixed.receipt as JsonObject).omitted_count, 1);
    const required = await f.context.resolve({ ...args, memory_ids: ["weak"] });
    assert.equal((required.items as JsonObject[])[0]!.reason, "required");
    await assert.rejects(() => f.context.resolve({ ...args, memory_ids: ["weak"], max_chars: 1 }), /budget/);
    f.memory("another", { content: "gamma" });
    await assert.rejects(() => f.context.resolve({ ...args, memory_ids: ["weak", "another"] }), /budget/);
  } finally { await f.close(); }
});

test("history returns revoked/expired versions diagnostically; as-of uses recorded knowledge and current ACL", async () => {
  const f = await fixture();
  try {
    const original = f.memory("changing", { effective_from: "2020-01-01" });
    f.store.save("memory_ledger", "changing", { ...payload(original), status: "revoked" });
    f.memory("expired", { valid_until: "2021-01-01", effective_from: "2020-01-01" });
    f.store.database.exec("UPDATE records SET updated_at='2022-01-01T00:00:00Z' WHERE kind='memory_ledger' AND version=1; UPDATE records SET updated_at='2024-01-01T00:00:00Z' WHERE kind='memory_ledger' AND version=2;");
    const args = { ...f.scope, query: "alpha", now: "2025-01-01" };
    assert.deepEqual((await f.context.resolve(args)).items, []);
    const history = await f.context.resolve({ ...args, history_view: true });
    assert.equal((history.items as JsonObject[]).length, 3);
    assert.equal((history.receipt as JsonObject).execution_context, false);
    const past = await f.context.resolve({ ...args, as_of: "2023-01-01" });
    assert.deepEqual((past.items as JsonObject[]).map(item => [item.memory_id, item.memory_version]), [["changing", 1]]);
    assert.deepEqual((await f.context.resolve({ ...args, as_of: "2020-01-01" })).items, []);
    await assert.rejects(() => f.context.resolve({ ...args, as_of: "bad" }), /as_of/);
    await assert.rejects(() => f.context.resolve({ ...args, known_at: "bad" }), /known_at/);
    f.store.save("memory_ledger", "changing", { ...payload(original), status: "revoked", sensitivity: "restricted" });
    assert.deepEqual((await f.context.resolve({ ...args, as_of: "2023-01-01" })).items, []);
  } finally { await f.close(); }
});

test("ingestion keeps unchanged review, invalidates edits/deletions, and exposes cursor drift", async () => {
  const f = await fixture();
  try {
    const root = join(f.root, "source"); await mkdir(root);
    await writeFile(join(root, "a.md"), "# Alpha\n\n" + "a".repeat(160) + "\n\n" + "b".repeat(100));
    await writeFile(join(root, "b.md"), "stable knowledge");
    const sources = new KnowledgeSourceRegistry(f.store);
    sources.sourceRegister({ source_id: "files", kind: "readme", label: "Files", ...f.scope, locator: root, content_digest: "initial", trust: "verified", access: "read_only" });
    f.store.create("knowledge_claim", "legacy-ingest", { source_id: "files", source_revision_id: "old-source-revision", status: "reviewed", scope: "project:fixture", content: "old alpha" });
    const first = sources.sourceIngest({ source_id: "files", max_files: 1, max_chars_per_fragment: 200 });
    assert.equal(f.store.get("knowledge_claim", "legacy-ingest").status, "stale");
    assert.equal(first.status, "partial"); assert.equal(first.has_more, true);
    const second = sources.sourceIngest({ source_id: "files", max_files: 1, max_chars_per_fragment: 200, cursor: first.next_cursor });
    assert.equal(second.status, "completed"); assert.equal(second.has_more, false);
    for (const claim of f.store.list("knowledge_claim", 100, item => item.id !== "legacy-ingest")) f.store.save("knowledge_claim", String(claim.id), { ...payload(claim), status: "reviewed" });
    const b = (second.candidates as JsonObject[])[0]!.claim_id as string;
    await writeFile(join(root, "a.md"), "changed alpha");
    assert.throws(() => sources.sourceIngest({ source_id: "files", cursor: first.next_cursor }), /stale/);
    const updated = sources.sourceIngest({ source_id: "files" });
    assert.equal(updated.invalidated_documents, 1);
    assert.equal(f.store.get("knowledge_claim", b).status, "reviewed");
    assert(f.store.list("knowledge_claim", 100).some(claim => claim.status === "stale"));
    await unlink(join(root, "b.md")); sources.sourceIngest({ source_id: "files" });
    assert.equal(f.store.get("knowledge_claim", b).status, "stale");
    assert.throws(() => sources.sourceIngest({ source_id: "files", cursor: Buffer.from(JSON.stringify({ digest: "bad", offset: -1 })).toString("base64url") }), /cursor/);
    const revisionId = (updated.revision as JsonObject).id;
    assert.throws(() => sources.sourceIngest({ source_id: "files", revision_id: revisionId }), /identity conflict/);
  } finally { await f.close(); }
});

test("persisted vector cache survives adapter instances; batches are bounded and dimension failures fall back", async t => {
  const f = await fixture(); const old = process.env.CRAFT_INDUSTRY_EMBED_KEY; process.env.CRAFT_INDUSTRY_EMBED_KEY = "fixture";
  try {
    const configuration = { endpoint: `https://fixture.invalid/${f.root}`, model: "fixture", model_revision: "1", credential_env: "CRAFT_INDUSTRY_EMBED_KEY" };
    let requests = 0;
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      const input = JSON.parse(String(init.body)).input as string[]; assert(input.length <= 32); requests++;
      return new Response(JSON.stringify({ data: input.map(() => ({ embedding: [1, 0] })), usage: { total_tokens: input.length } }));
    });
    const docs = Array.from({ length: 70 }, (_, n) => ({ id: String(n), body: `document ${n}` }));
    const path = join(f.root, "cache.sqlite");
    assert.equal((await new OpenAiCompatibleEmbeddingRetrievalPort(configuration, path).search("query", docs)).hits.length, 70);
    assert.equal(requests, 3);
    assert.equal((await new OpenAiCompatibleEmbeddingRetrievalPort(configuration, path).search("query", docs)).hits.length, 70); assert.equal(requests, 3);
    assert.equal((await new OpenAiCompatibleEmbeddingRetrievalPort(configuration).search("x".repeat(32001), [])).execution.unavailable_reason, "embedding_input_budget_exceeded");
  } finally { if (old === undefined) delete process.env.CRAFT_INDUSTRY_EMBED_KEY; else process.env.CRAFT_INDUSTRY_EMBED_KEY = old; await f.close(); }
});

const dataset = { documents: [{ id: "a", scope: "p", body: "alpha beta" }, { id: "b", scope: "other", body: "alpha beta" }], cases: [{ query: "alpha", scope: "p", expected_ids: ["a"], top_k: 1 }] };
test("retrieval eligibility requires executed labelled results, not caller-reported scores", async t => {
  const f = await fixture(); const old = process.env.CRAFT_INDUSTRY_EMBED_KEY; process.env.CRAFT_INDUSTRY_EMBED_KEY = "fixture";
  try {
    const adapter = f.context.retrievalConfigure({ strategy: "hybrid", provider_fingerprint: "fixture", configuration: { endpoint: `https://fixture.invalid/${f.root}`, model: "m", credential_env: "CRAFT_INDUSTRY_EMBED_KEY", cost_per_million_input_units: 1 } }).adapter as JsonObject;
    const reported = f.context.retrievalEvaluate({ adapter_id: adapter.id, metrics: { recall: 1, cross_project_leak_count: 0, latency_ms: 0, cost_usd: 0 } });
    assert.equal((reported.adapter as JsonObject).status, "rejected");
    for (const extra of [{ negative_case_count: -1 }, { negative_case_count: 1.5 }, { false_positive_count: -1 }, { false_positive_count: 1.5 },
      { no_answer_false_positive_count: -1 }, { no_answer_false_positive_count: 1.5 }, { no_answer_false_positive_count: 1 }]) {
      assert.throws(() => f.context.retrievalEvaluate({ adapter_id: adapter.id, metrics: { recall: 1, cross_project_leak_count: 0, latency_ms: 0, cost_usd: 0, ...extra } }), /metrics are invalid/);
    }
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => new Response(JSON.stringify({ data: JSON.parse(String(init.body)).input.map(() => ({ embedding: [1, 0] })), usage: { total_tokens: 2 } })));
    const result = await f.context.retrievalRun({ adapter_id: adapter.id, dataset, max_cost_usd: 1 });
    assert.equal((result.adapter as JsonObject).status, "eligible");
    const evaluation = result.evaluation as JsonObject;
    const run = f.store.get("retrieval_evaluation_run", String(evaluation.run_id));
    assert.equal((run.metrics as JsonObject).recall, 1); assert.equal((run.metrics as JsonObject).cross_project_leak_count, 0);
    assert(!JSON.stringify(run).includes('"body"'));
    const knowledge = f.store.create("knowledge_claim", "semantic", { source_id: "source", scope: "project:fixture", status: "reviewed", content: "different words", content_digest: "s" });
    const resolved = await f.context.resolve({ ...f.scope, query: "alpha", members: ["knowledge"], retrieval_adapter_id: adapter.id });
    assert.equal(((resolved.contributions as JsonObject[])[0]!.items as JsonObject[])[0]!.claim_id, knowledge.id);
    delete process.env.CRAFT_INDUSTRY_EMBED_KEY;
    await f.context.resolve({ ...f.scope, query: "alpha", retrieval_adapter_id: adapter.id });
    assert.equal(f.store.get("retrieval_adapter_health", `retrieval_adapter_health_${adapter.id}`).consecutive_transient_failures, 0);
    for (const bad of [{}, { documents: [], cases: [] }, { ...dataset, documents: [...dataset.documents, dataset.documents[0]] }, { ...dataset, cases: [{ query: "q", scope: "p", expected_ids: ["b"] }] }, { ...dataset, cases: [{ ...dataset.cases[0], top_k: 0 }] }])
      await assert.rejects(() => runRetrievalEvaluation(adapter, bad));
    process.env.CRAFT_INDUSTRY_EMBED_KEY = "fixture";
    const noAnswer = { ...dataset, cases: [{ query: "alpha", scope: "p", expected_ids: [], top_k: 1 }] };
    const negative = await f.context.retrievalRun({ adapter_id: adapter.id, dataset: noAnswer });
    assert.equal((negative.adapter as JsonObject).status, "rejected");
    const negativeMetrics = ((f.store.get("retrieval_evaluation_run", String((negative.evaluation as JsonObject).run_id))).metrics) as JsonObject;
    assert.equal(negativeMetrics.false_positive_count, 1);
    assert.equal(negativeMetrics.no_answer_false_positive_count, 1);
    assert.equal(negativeMetrics.abstention_accuracy, 0);
    const abstaining = await f.context.retrievalRun({ adapter_id: adapter.id, dataset: { ...dataset, cases: [{ query: "nothing", scope: "absent", expected_ids: [] }] } });
    assert.equal((abstaining.adapter as JsonObject).status, "eligible");
    const empty = await runRetrievalEvaluation({ ...adapter, strategy: "keyword", configuration: {} }, { documents: dataset.documents, cases: [{ query: "unmatched", scope: "p", expected_ids: [] }] });
    assert.equal((empty.metrics as JsonObject).abstention_accuracy, 1);
    assert.equal((empty.results as JsonObject[])[0]!.recall, 1);
    assert.equal((empty.results as JsonObject[])[0]!.precision, 1);
  } finally { if (old === undefined) delete process.env.CRAFT_INDUSTRY_EMBED_KEY; else process.env.CRAFT_INDUSTRY_EMBED_KEY = old; await f.close(); }
});

function source(path: string, content: string) { return { path, content, digest: createHash("sha256").update(content).digest("hex"), language: "ts" }; }
test("compiler resolves imports, aliases and methods without matching comments, strings or unrelated same names", () => {
  const files = [source("a.ts", "export function target() {}\nexport class Box { method() {} }"),
    source("b.ts", "import {target as alias, Box} from './a';\nexport function caller() { alias(); new Box().method(); }\n// target()\nconst text='target()';"),
    source("c.ts", "import missing from 'unavailable-package';\nfunction target() {}\nfunction unrelated() { target(); }")];
  const result = analyzeTypeScript(files), nodes = result.nodes as JsonObject[], edges = result.edges as JsonObject[];
  const target = nodes.find(node => node.path === "a.ts" && node.name === "target")!;
  const incoming = edges.filter(edge => edge.kind === "calls" && edge.to_node_id === target.id);
  assert.equal(incoming.length, 1); assert.equal(nodes.find(node => node.id === incoming[0]!.from_node_id)!.name, "caller");
  const method = nodes.find(node => node.name === "method")!;
  assert(edges.some(edge => edge.to_node_id === method.id && edge.kind === "calls"));
  const again = analyzeTypeScript(files);
  assert.equal((again.diagnostics as JsonObject).reused_file_count, 3);
  assert.deepEqual(again.nodes, nodes); assert.deepEqual(again.edges, edges);
  assert.throws(() => analyzeTypeScript(Array.from({ length: 2001 }, () => files[0]!)), /budget/);
});

test("MCP initialize, tool list and readiness expose one actual schema fingerprint", async () => {
  const f = await fixture();
  try {
    const server = new McpServer(new CraftService(f.store), "component-memory-daily");
    const initialized = await server.handle({ id: 1, method: "initialize", params: {} });
    assert.deepEqual((((initialized!.result as JsonObject).capabilities as JsonObject).experimental as JsonObject)["craft/runtime-fingerprint"], server.fingerprint);
    const result = await server.handle({ id: 2, method: "tools/call", params: { name: "craft_component_diagnose", arguments: { component: "memory", expected_schema_digest: "wrong" } } });
    const value = (result!.result as JsonObject).structuredContent as JsonObject;
    assert.equal(value.schema_match, false); assert.deepEqual(value.runtime_fingerprint, server.fingerprint);
  } finally { await f.close(); }
});

test("LSP relations retain real endpoints and reject dangling, malformed or out-of-range facts", () => {
  const doc = { path: "a.java", language: "java", content: "foo bar", source_digest: createHash("sha256").update("foo bar").digest("hex"),
    symbols: [{ name: "foo", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } }, { name: "bar", range: { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } } }] };
  const relation = { kind: "calls", from: { path: "a.java", start_offset: 0 }, to: { path: "a.java", start_offset: 4 }, source_span: { start_offset: 4, end_offset: 7 } };
  const input = { analyzer: "jdtls", analyzer_version: "fixture", documents: [doc], relations: [relation] };
  assert.equal((normalizeLspSymbols(input).edges as unknown[]).length, 1);
  for (const relations of [{}, Array(20001).fill(relation), [null], [{ ...relation, kind: "wrong" }], [{ ...relation, to: {} }],
    [{ ...relation, source_span: { start_offset: -1, end_offset: 7 } }], [{ ...relation, source_span: { start_offset: 4, end_offset: 9 } }]])
    assert.throws(() => normalizeLspSymbols({ ...input, relations }));
});

test("changed document guards remain fail-closed even if a stale claim is externally marked reviewed", async () => {
  const f = await fixture();
  try {
    const claim = { source_id: "source", status: "reviewed", scope: "project:fixture", content: "alpha", document_id: "doc", document_digest: "current", evidence_ids: [] };
    f.store.create("knowledge_claim", "claim", claim);
    assert.deepEqual((await f.context.searchKnowledge({ ...f.scope, query: "alpha" })).hits, []);
    f.store.create("knowledge_document", "doc", { status: "changed", content_digest: "current" });
    assert.deepEqual((await f.context.searchKnowledge({ ...f.scope, query: "alpha" })).hits, []);
    f.store.save("knowledge_document", "doc", { status: "current", content_digest: "wrong" });
    assert.deepEqual((await f.context.searchKnowledge({ ...f.scope, query: "alpha" })).hits, []);
    f.store.save("knowledge_document", "doc", { status: "current", content_digest: "current" });
    assert.equal(((await f.context.searchKnowledge({ ...f.scope, query: "alpha" })).hits as unknown[]).length, 1);
  } finally { await f.close(); }
});

test("scoped maintenance proposes actionable versioned work; verified feedback only breaks relevance ties", async () => {
  const f = await fixture();
  try {
    const service = new CraftService(f.store), now = new Date(Date.now() + 60_000).toISOString();
    f.memory("a", { observed_at: "2026-09-01", content_digest: "same" });
    f.memory("b", { observed_at: "2026-09-01", content_digest: "same" });
    f.memory("expired", { valid_until: "2000-01-01" });
    f.memory("other", { scope: { kind: "project", id: "other" } });
    f.store.create("semantic_memory", "semantic", { status: "active", scope: { kind: "project", id: "fixture" }, memory_ids: [] });
    f.store.create("semantic_memory", "foreign", { status: "active", scope: { kind: "project", id: "other" }, memory_ids: [] });
    const maintenance = service.memoryMaintenanceRun({ ...f.scope, now, stage: "deep" });
    assert(!(maintenance.findings as JsonObject[]).some(item => item.memory_id === "other" || item.memory_id === "foreign"));
    const actions = (maintenance.candidate as JsonObject).actions as JsonObject[];
    assert(actions.some(item => item.action === "expire")); assert(actions.some(item => item.action === "review_duplicate"));
    assert.equal((service.memoryMaintenanceRun({ scope_kind: "project", scope_id: "empty" }).run as JsonObject).memory_kind, "memory_ledger");
    const result = await f.context.resolve({ ...f.scope, query: "alpha", now, memory_ids: ["b"], max_items: 1 });
    const receipt = result.receipt as JsonObject;
    for (const [id, metadata] of [["missing", undefined], ["wrong", { context_receipt_id: "wrong" }], ["unpassed", { context_receipt_id: receipt.id }], ["valid", { context_receipt_id: receipt.id, verdict: "passed" }]] as const) {
      f.store.create("evidence", id, { source_type: "program", confidence: "confirmed", metadata });
      f.context.feedback({ receipt_id: receipt.id, outcome: "helpful", evidence_ids: [id] });
    }
    const preferred = await f.context.resolve({ ...f.scope, query: "alpha", now, max_items: 1 });
    assert.equal((preferred.items as JsonObject[])[0]!.memory_id, "b");
    const mcp = new McpServer(service, "component-memory-daily");
    assert.equal((await mcp.handlers.craft_memory_maintenance_run({})).reason, "scope_unavailable");
    assert((await mcp.handlers.craft_memory_maintenance_run({ ...f.scope, stage: "review" })).run);
  } finally { await f.close(); }
});

test("keyword dataset grading measures missed queries, validates scopes and can run through MCP", async () => {
  const f = await fixture();
  try {
    const service = new CraftService(f.store), adapter = f.context.retrievalConfigure({ strategy: "keyword" }).adapter as JsonObject;
    const mcp = new McpServer(service);
    const result = await mcp.handlers.craft_retrieval_adapter_evaluate({ adapter_id: adapter.id, dataset: { ...dataset, cases: [{ ...dataset.cases[0], query: "unrelated", top_k: undefined }] } });
    assert.equal(((result.evaluation as JsonObject).metrics as JsonObject).recall, 0);
    const missing = await runRetrievalEvaluation({ strategy: "vector", configuration: {}, identity_digest: "fixture" }, dataset);
    assert.equal(missing.execution_complete, false); assert.equal((missing.metrics as JsonObject).cost_usd, null);
    const run = f.store.list("retrieval_evaluation_run", 1)[0]!;
    assert.equal(f.context.retrievalEvaluate({ adapter_id: adapter.id, run_id: run.id, metrics: run.metrics }).evaluation !== undefined, true);
    assert.equal((await f.context.retrievalRun({ adapter_id: adapter.id, dataset })).idempotent, false);
  } finally { await f.close(); }
});


test("vector disk cache works in a fresh process; provider usage, cache writes and resource bounds fail closed", async t => {
  const f = await fixture(); const prior = process.env.CRAFT_INDUSTRY_EMBED_KEY; process.env.CRAFT_INDUSTRY_EMBED_KEY = "fixture";
  try {
    const config = { endpoint: `https://fixture.invalid/${f.root}`, model: "disk", credential_env: "CRAFT_INDUSTRY_EMBED_KEY" };
    const cachePath = join(f.root, "vectors.sqlite");
    let requests = 0;
    const mockedFetch = t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      const inputs = JSON.parse(String(init.body)).input as string[]; requests++;
      assert(inputs.reduce((n, value) => n + value.length, 0) <= 32000);
      return new Response(JSON.stringify({ data: inputs.map(() => ({ embedding: [1, 0] })), usage: {} }));
    });
    const port = new OpenAiCompatibleEmbeddingRetrievalPort(config, cachePath);
    assert.equal((await port.search("cold", [{ id: "a", body: "cached" }])).execution.cost_summary!.billable_units, null);
    const script = `import {OpenAiCompatibleEmbeddingRetrievalPort as Port} from ${JSON.stringify(new URL("../core/retrieval-port.ts", import.meta.url).href)}; globalThis.fetch=()=>{throw new Error("cache miss")}; console.log(JSON.stringify(await new Port(${JSON.stringify(config)},${JSON.stringify(cachePath)}).search("cold",[{id:"a",body:"cached"}])));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).execution.used, "vector");
    assert.equal(JSON.parse(child.stdout).execution.cost_summary.billable_units, 0);
    await port.search("long", [{ id: "a", body: "a".repeat(20000) }, { id: "b", body: "b".repeat(20000) }]);
    assert.equal(requests, 3);
    const db = new DatabaseSync(cachePath);
    db.exec("CREATE TRIGGER deny_cache BEFORE INSERT ON embeddings BEGIN SELECT RAISE(ABORT,'fixture disk write failure'); END"); db.close();
    assert.equal((await port.search("write-fail", [])).execution.used, "keyword");
    const reopened = new DatabaseSync(cachePath); assert.equal(reopened.prepare("SELECT count(*) AS n FROM embeddings").get()!.n, 5); reopened.close();
    assert.equal((await new OpenAiCompatibleEmbeddingRetrievalPort(config, join(f.root, "absent", "db")).search("x", [])).execution.used, "keyword");
    const large = Array.from({ length: 4100 }, (_, n) => ({ id: String(n), body: `evict-${n}` }));
    assert.equal((await new OpenAiCompatibleEmbeddingRetrievalPort({ ...config, model: "eviction" }).search("many", large)).hits.length, 4100);
    mockedFetch.mock.mockImplementation(async () => new Response(JSON.stringify({ data: [{ embedding: Array(8193).fill(0) }] })));
    assert.equal((await new OpenAiCompatibleEmbeddingRetrievalPort(config).search("oversized-vector", [])).execution.used, "keyword");
  } finally { if (prior === undefined) delete process.env.CRAFT_INDUSTRY_EMBED_KEY; else process.env.CRAFT_INDUSTRY_EMBED_KEY = prior; await f.close(); }
});

test("retrieval evaluation rejects adapter drift and records unavailable embedded-process fingerprint", async t => {
  const f = await fixture(); const prior = process.env.CRAFT_INDUSTRY_EMBED_KEY; process.env.CRAFT_INDUSTRY_EMBED_KEY = "fixture";
  try {
    const adapter = f.context.retrievalConfigure({ strategy: "vector", provider_fingerprint: "fixture", configuration: { endpoint: `https://fixture.invalid/${f.root}`, model: "drift", credential_env: "CRAFT_INDUSTRY_EMBED_KEY" } }).adapter as JsonObject;
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      f.store.save("retrieval_adapter", String(adapter.id), { ...payload(adapter), status: "configured" });
      return new Response(JSON.stringify({ data: JSON.parse(String(init.body)).input.map(() => ({ embedding: [1, 0] })) }));
    });
    await assert.rejects(() => f.context.retrievalRun({ adapter_id: adapter.id, dataset }), /changed during/);
    assert.equal(f.store.list("retrieval_evaluation_run", 10).length, 0);
    const argv = process.argv[1];
    try { process.argv[1] = join(f.root, "embedded-entry-missing"); assert.equal(new McpServer(new CraftService(f.store)).fingerprint.entrypoint_digest, null); }
    finally { process.argv[1] = argv!; }
  } finally { if (prior === undefined) delete process.env.CRAFT_INDUSTRY_EMBED_KEY; else process.env.CRAFT_INDUSTRY_EMBED_KEY = prior; await f.close(); }
});

test("source ingestion caps total bytes and files before persisting a partial manifest", async () => {
  const f = await fixture();
  try {
    const root = join(f.root, "source"); await mkdir(root);
    const registry = new KnowledgeSourceRegistry(f.store);
    registry.sourceRegister({ source_id: "bounded", kind: "project_note", label: "fixture", trust: "verified", locator: root, content_digest: "fixture", ...f.scope });
    await writeFile(join(root, "large.md"), "x".repeat(2_000_001));
    assert.throws(() => registry.sourceIngest({ source_id: "bounded" }), /2 MiB/);
    await unlink(join(root, "large.md"));
    for (let n = 0; n < 11; n++) await writeFile(join(root, `${n}.md`), "x".repeat(1_900_000));
    assert.throws(() => registry.sourceIngest({ source_id: "bounded" }), /20 MB/);
    await rm(root, { recursive: true }); await mkdir(root);
    for (let n = 0; n < 10001; n++) await writeFile(join(root, `${n}.md`), "");
    assert.throws(() => registry.sourceIngest({ source_id: "bounded" }), /10000 files/);
    assert.equal(f.store.list("knowledge_source_revision", 10).length, 0);
  } finally { await f.close(); }
});

test("ablation preparation uses real campaign slots, requires curated cases and never fabricates results", async () => {
  const f = await fixture();
  try {
    const service = new CraftService(f.store);
    const ids = Array.from({ length: 20 }, (_, n) => `fixture-case-${n}`);
    const manifest = { case_ids: ids, environment: { host: "fixture", model: "fixture", repository_revision: "fixture" }, budget: { tokens: 100 },
      harnesses: { none: "none", knowledge: "k", memory: "m", experience: "e", codebase: "c", all: "all" }, acceptance_ref: "fixture-contract" };
    assert.throws(() => prepareAblations(service, { ...manifest, case_ids: ids.slice(1) }), /20..100/);
    assert.throws(() => prepareAblations(service, { ...manifest, harnesses: { ...manifest.harnesses, all: "none" } }), /distinct/);
    for (const caseId of ids) service.deliveryEvaluationCaseSave({ case_id: caseId, name: caseId, domain: "software", partition: "held_out", sanitized: true, approved_by: "synthetic-test-only", acceptance_contract_ref: "fixture-contract" });
    const last = f.store.get("delivery_evaluation_case", ids[19]!);
    f.store.save("delivery_evaluation_case", ids[19]!, { ...payload(last), approved_by: null });
    assert.throws(() => prepareAblations(service, manifest), /approved/);
    assert.equal(f.store.list("eval_campaign", 10).length, 0);
    f.store.save("delivery_evaluation_case", ids[19]!, payload(last));
    const prepared = prepareAblations(service, manifest);
    assert.equal(prepared.model_effect_proven, false); assert.equal((prepared.campaigns as JsonObject[]).length, 5);
    assert.equal(f.store.list("eval_campaign_slot", 1000).length, 600);
    assert.deepEqual(prepareAblations(service, manifest), prepared);
    const explicit = prepareAblations(service, { ...manifest, trials_per_case: 2 }); assert.equal(explicit.trials_per_case, 2);
    const manifestFile = join(f.root, "ablation.json"); await writeFile(manifestFile, JSON.stringify(manifest));
    const command = new URL("../scripts/eval/component-ablation.ts", import.meta.url).pathname;
    const invoked = spawnSync(process.execPath, [command, join(f.root, "data"), manifestFile], { encoding: "utf8" });
    assert.equal(invoked.status, 0, invoked.stderr); assert.equal(JSON.parse(invoked.stdout).status, "awaiting_actual_host_runs");
    const invalid = spawnSync(process.execPath, [command], { encoding: "utf8" }); assert.match(invalid.stderr, /Usage/);
    const missingManifest = spawnSync(process.execPath, [command, join(f.root, "data")], { encoding: "utf8" }); assert.match(missingManifest.stderr, /Usage/);
  } finally { await f.close(); }
});


test("history reads all recorded versions within budget and scoped document bundles preserve freshness guards", async () => {
  const f = await fixture(), target = await fixture();
  try {
    const a = f.memory("history"); f.store.save("memory_ledger", "history", { ...payload(a), content: "new alpha" });
    assert.equal(((await f.context.resolve({ ...f.scope, query: "alpha", known_at: "2099-01-01" })).items as JsonObject[]).length, 1);
    f.store.create("knowledge_document", "document", { source_id: "source", status: "current", content_digest: "doc-digest" });
    f.store.create("knowledge_claim", "portable", { source_id: "source", scope: "project:portable", status: "reviewed", content_ref: f.store.contentStore.writeSync({ kind: "knowledge", record_id: "portable", version: 1, scope: "project:portable", status: "reviewed", sensitivity: "internal", source_id: "source", body: "portable alpha" }), content: "portable alpha", document_id: "document", document_digest: "doc-digest", evidence_ids: [] });
    const sourceService = new CraftService(f.store), receiver = new CraftService(target.store);
    const bundle = sourceService.knowledgeMemoryBundleExport({ scope_kind: "project", scope_id: "portable" }).bundle;
    receiver.knowledgeMemoryBundleImportApply({ bundle, approved: true });
    assert.equal(target.store.get("knowledge_document", "document").content_digest, "doc-digest");
    assert.equal(((await target.context.searchKnowledge({ scope_kind: "project", scope_id: "portable", query: "portable" })).hits as JsonObject[]).length, 1);
    f.store.database.prepare("WITH RECURSIVE versions(n) AS (SELECT 3 UNION ALL SELECT n+1 FROM versions WHERE n<10001) INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) SELECT 'memory_ledger','history',n,?,'2020-01-01','2020-01-01' FROM versions").run(JSON.stringify(payload(a)));
    await assert.rejects(() => f.context.resolve({ ...f.scope, query: "alpha", history_view: true }), /history budget/);
  } finally { await f.close(); await target.close(); }
});

test("compiler refuses oversized graphs, handles incomplete declarations and bounds its parsed-file cache", () => {
  const file = (path: string, content: string) => ({ path, content, digest: stableDigest([path, content]), language: "typescript" });
  const uncertain = analyzeTypeScript([file("main.ts", '/// <reference path="missing.ts" />\nexport default function () {}\n(() => 1)(); const object = { method: () => 2 }; object.method();')]);
  assert(Number((uncertain.diagnostics as JsonObject).unresolved_relations) > 0);
  const many = Array.from({ length: 10001 }, (_, n) => `const variable${n}=1;`).join("\n");
  assert.throws(() => analyzeTypeScript([file("many.ts", many)]), /graph exceeds/);
  analyzeTypeScript(Array.from({ length: 2000 }, (_, n) => file(`cache${n}.ts`, "export {};")));
  assert.equal((analyzeTypeScript([file("new-cache.ts", "export {};")]).nodes as JsonObject[]).length, 1);
});

test("unmatched governed claims and sparse contribution descriptors do not invent lexical matches", async () => {
  const f = await fixture();
  try {
    for (const id of ["one", "two"]) f.store.create("knowledge_claim", id, { source_id: "source", status: "reviewed", scope: "project:fixture", content: id, evidence_ids: [] });
    const result = await f.context.resolve({ ...f.scope, query: "alpha" });
    assert((result.contributions as JsonObject[]).every(part => !(part.items as JsonObject[]).length));
    const context = new ContextResolutionKernel(f.store, [{ member: "experience", contribute: async () => ({ member: "experience", items: [{ trigger: "alpha" }, {}], receipt_id: "sparse", omitted_count: 0 }) }]);
    assert.equal((((await context.resolve({ ...f.scope, query: "alpha" })).contributions as JsonObject[])[0]!.items as JsonObject[]).length, 1);
  } finally { await f.close(); }
});


test("compiler IO cannot reach working files or emit artifacts; warm binding observes a changed dependency", async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, "outside.ts"); await writeFile(outside, "export const secret = 1;");
    const file = (path: string, content: string) => ({ path, content, digest: stableDigest(content), language: "typescript" });
    const host = createCheckpointCompilerHost([file("snapshot.ts", "export const value = 1;")]);
    assert.equal(host.fileExists(outside), false); assert.equal(host.readFile(outside), undefined);
    assert.equal(host.readFile("/snapshot.ts"), "export const value = 1;");
    // Real compiler emission uses this Host's write callback, and must stay in memory.
    const program = ts.createProgram(["/snapshot.ts"], { noLib: true, outDir: f.root }, host);
    assert.equal(program.emit().emitSkipped, false);
    assert.match(ts.formatDiagnosticsWithColorAndContext(program.getGlobalDiagnostics(), host), /Cannot find global type/);
    await assert.rejects(readFile(join(f.root, "snapshot.js")), /ENOENT/);
    const caller = file("caller.ts", 'import {target} from "./target"; target();');
    analyzeTypeScript([caller, file("target.ts", "export function target() { return 1; }")]);
    const changed = analyzeTypeScript([caller, file("target.ts", "export const target = 42;")]);
    const target = (changed.nodes as JsonObject[]).find(node => node.name === "target" && node.path === "target.ts")!;
    assert(!(changed.edges as JsonObject[]).some(edge => edge.kind === "calls" && edge.to_node_id === target.id));
    const removed = analyzeTypeScript([caller, file("target.ts", "export function replacement() {}")]);
    assert(!(removed.edges as JsonObject[]).some(edge => edge.kind === "calls"));
  } finally { await f.close(); }
});


test("default BM25 retrieves Chinese words and mixed code identifiers without punctuation artifacts", async () => {
  const port = new KeywordRetrievalPort();
  const result = await port.search("数据库 回滚", [{ id: "relevant", body: "数据库.回滚 事务 reset_error_42" }, { id: "other", body: "操作系统 调度" }]);
  assert.deepEqual(result.hits.map(hit => hit.id), ["relevant"]);
  assert.equal((await port.search("reset_error_42", [{ id: "code", body: "排查 reset_error_42。" }])).hits[0]!.id, "code");
});

test("retrieval test mocks leave the shared process fetch unchanged", () => {
  assert.equal(globalThis.fetch, originalFetch);
});
