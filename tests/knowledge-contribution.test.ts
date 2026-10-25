import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KnowledgeContribution } from "../capability/craft-knowledge/contribution.ts";
import type { ContextContributionProvider, ContextRequest } from "../core/capability-protocol.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { ContextResolutionKernel, projectKnowledgeRetrieval, projectMemoryRetrieval } from "../core/context-resolution.ts";
import { assertContextReadCurrent } from "../common/craft-common-store-local/src/context-access-guard.ts";
import { MemoryContribution } from "../capability/craft-memory/contribution.ts";
import { MemoryLedgerKernel } from "../capability/craft-memory/memory-ledger.ts";
import { KeywordRetrievalPort } from "../core/retrieval-port.ts";
import { attachVerifiedPromotionFixture } from "./helpers/knowledge-promotion-proof.ts";

const request: ContextRequest = { query: "alpha", scope_kind: "project", scope_id: "demo", max_items: 10, max_chars: 10000, now: "2026-09-27T10:00:00Z" };

test("Knowledge Context excludes restricted bodies unless explicitly allowed", async t => {
  const f = await fixture();
  try {
    const ref = f.store.contentStore.writeSync({ kind: "knowledge", record_id: "restricted", version: 1, scope: "project:demo", status: "reviewed", sensitivity: "restricted", source_id: "source", body: "alpha secret fixture" });
    f.claim("restricted", { sensitivity: "restricted", content: undefined, content_ref: ref });
    t.mock.method(f.store.contentStore, "readCompatSync", () => { throw new Error("Restricted body must not be hydrated"); });
    assert.deepEqual((await f.reader.contribute(request)).items, []);
    const kernel = new ContextResolutionKernel(f.store, [f.reader]);
    assert.deepEqual(((await kernel.resolve({ ...request, members: ["knowledge"] })).contributions as JsonObject[])[0]!.items, []);
    t.mock.restoreAll();
    assert.equal((await f.reader.contribute({ ...request, allow_restricted: true })).items[0]!.claim_id, "restricted");
    const allowed = await kernel.resolve({ ...request, members: ["knowledge"], allow_restricted: true });
    assert.deepEqual((allowed.contributions as JsonObject[]).flatMap(part => (part.items as JsonObject[]).map(item => item.claim_id)), ["restricted"]);
  } finally { await f.close(); }
});

test("direct Knowledge search uses a small default budget and removes duplicated retrieval text", async () => {
  const f = await fixture();
  try {
    const sourceText = "alpha " + "fact ".repeat(260);
    f.claim("large-a", { content: sourceText });
    f.claim("large-b", { content: sourceText });
    const kernel = new ContextResolutionKernel(f.store, [f.reader]);
    const result = await kernel.searchKnowledge({ query: "alpha", scope_kind: "project", scope_id: "demo" });
    const hits = result.hits as JsonObject[];
    assert(hits.length > 0);
    assert.equal(result.omitted_count, 2 - hits.length);
    assert(hits.every(hit => String(hit.content).length <= 600));
    assert(hits.every(hit => hit.content === "" && (hit.content_excerpt as JsonObject).reason === "requires_expansion"));
    const excerpt = hits[0]!.content_excerpt as JsonObject;
    assert.equal(sourceText.slice(Number(excerpt.source_start), Number(excerpt.source_end)), sourceText);
    assert.equal("retrieval_text" in hits[0]!, false);
    assert((JSON.stringify(hits).length) <= 1_200);
    const expanded = await kernel.searchKnowledge({ query: "alpha", scope_kind: "project", scope_id: "demo", max_chars: 4_000 });
    assert.equal((expanded.hits as JsonObject[]).length, 2);
    assert((expanded.hits as JsonObject[]).every(hit => hit.content === "" && (hit.content_excerpt as JsonObject).reason === "requires_expansion"));
    const tiny = await kernel.searchKnowledge({ query: "alpha", scope_kind: "project", scope_id: "demo", max_chars: 1 });
    assert.equal((tiny.hits as JsonObject[]).length, 0);
    assert.equal(tiny.omitted_count, 2);
    await assert.rejects(kernel.searchKnowledge({ query: "alpha", scope_kind: "project", scope_id: "demo", max_chars: 12_001 }), /max_chars must be between/u);
    await assert.rejects(kernel.searchKnowledge({ query: "alpha", scope_kind: "project", scope_id: "demo", limit: 101 }), /limit must be between/u);
  } finally { await f.close(); }
});

test("Context projections preserve explicit expansion ranges rather than a cropped instruction", () => {
  const content = `无关前文。不要在未满足以下条件时${"背景说明 ".repeat(150)}执行 Redis 清理。`;
  const knowledge = projectKnowledgeRetrieval({ content, claim_id: "claim" }, "Redis");
  const memory = projectMemoryRetrieval({ content, memory_id: "memory" }, "Redis", false);
  for (const projection of [knowledge, memory]) {
    assert.equal(projection.content, "");
    const excerpt = projection.content_excerpt as JsonObject;
    assert.equal(excerpt.reason, "requires_expansion");
    assert.equal(content.slice(Number(excerpt.source_start), Number(excerpt.source_end)), content.slice(5));
    const repeated = "claim_id" in projection ? projectKnowledgeRetrieval(projection, "Redis") : projectMemoryRetrieval(projection, "Redis", false);
    assert.deepEqual(repeated.content_excerpt, excerpt);
  }
});

test("shared Context ranks expansion-only Knowledge and Memory by bounded matched terms, retaining references", async t => {
  const f = await fixture();
  try {
    const content = `不要在未满足以下条件时${"背景说明 ".repeat(150)}执行 Redis 清理。`;
    f.claim("conditional", { content });
    new MemoryLedgerKernel(f.store).remember({ memory_id: "conditional-memory", source_id: "source", kind: "preference",
      scope_kind: "project", scope_id: "demo", content, confidence: "bounded", observed_at: "2020-01-01T00:00:00Z" });
    const corpora: Array<Array<{ id: string; body: string }>> = [];
    const search = KeywordRetrievalPort.prototype.search;
    t.mock.method(KeywordRetrievalPort.prototype, "search", async function(this: KeywordRetrievalPort, query: string, documents: readonly { id: string; body: string }[]) {
      corpora.push(documents.map(item => ({ ...item })));
      return search.call(this, query, documents);
    });
    const kernel = new ContextResolutionKernel(f.store, [f.reader, new MemoryContribution(f.store)]);
    const result = await kernel.resolve({ ...request, query: "Redis", members: ["knowledge", "memory"], max_items: 4, max_chars: 2_000 });
    const items = [...result.items as JsonObject[], ...(result.contributions as JsonObject[]).flatMap(part => part.items as JsonObject[])];
    assert.equal(items.length, 2);
    for (const item of items) {
      assert.equal(item.content, "");
      assert.equal((item.content_excerpt as JsonObject).reason, "requires_expansion");
      assert.deepEqual((item.content_excerpt as JsonObject).matched_terms, ["redis"]);
      assert.equal((item.content_excerpt as JsonObject).source_start, 0);
      assert.equal((item.content_excerpt as JsonObject).source_end, content.length);
      assert(item.claim_id || item.memory_id);
    }
    assert.deepEqual(corpora.at(-1)!.map(item => item.body).sort(), ["redis", "redis"]);
    await assert.rejects(kernel.resolve({ ...request, query: "Redis", members: ["knowledge", "memory"], max_chars: 100,
      required_refs: [{ member: "knowledge", id: "conditional" }] }), /Required Memory or Context reference exceeds Context budget/u);
  } finally { await f.close(); }
});

test("a required Memory reference with no matched terms ranks without inventing retrieval text", async () => {
  const f = await fixture();
  try {
    const stored = f.store.create("memory_ledger", "required-expansion", { status: "active", scope: { kind: "project", id: "demo" },
      source_id: "source", content: `needle ${"background ".repeat(150)}`, content_excerpt: { reason: "requires_expansion", source_start: 0,
        source_end: 1_500, source_chars: 1_500 } });
    const memoryProvider: ContextContributionProvider = { member: "memory", async contribute() {
      return { member: "memory", items: [{ ...stored, memory_id: stored.id, memory_version: stored.version }],
        receipt_id: "required-expansion-receipt", omitted_count: 0 };
    } };
    const kernel = new ContextResolutionKernel(f.store, [memoryProvider]);
    const result = await kernel.resolve({ ...request, members: ["memory"], memory_ids: ["required-expansion"] });
    const items = result.items as JsonObject[];
    assert.equal(items.length, 1);
    assert.equal(items[0]!.content, stored.content);
    assert.equal((items[0]!.content_excerpt as JsonObject).reason, "requires_expansion");
  } finally { await f.close(); }
});

test("Knowledge candidate shortlist excerpts long claims and preserves explicitly required Claims", async () => {
  const f = await fixture();
  try {
    const long = `alpha verified fact. ${"supporting detail. ".repeat(900)}`;
    f.claim("long-candidate", { content: long });
    const selected = await f.reader.contribute({ ...request, candidate_mode: true, max_items: 8, max_chars: 6_000 });
    assert.equal(selected.items[0]!.content, "alpha verified fact.");
    assert.equal("retrieval_text" in selected.items[0]!, false);
    assert(Number((selected.items[0]!.content_excerpt as JsonObject).source_chars) > 6_000);
    const required = await f.reader.contribute({ ...request, candidate_mode: true, max_items: 8, max_chars: 30_000,
      required_refs: [{ member: "knowledge", id: "long-candidate" }] });
    assert(String(required.items[0]!.content).length > 600);
  } finally { await f.close(); }
});

test("semantic-only retrieval returns provenance without inventing a body excerpt", () => {
  const content = "旧版本说明。".repeat(120);
  const knowledge = projectKnowledgeRetrieval({ content, retrieval_text: content, claim_id: "claim" }, "current rollout");
  const memory = projectMemoryRetrieval({ content, memory_id: "memory" }, "current rollout", false);
  for (const projection of [knowledge, memory]) {
    assert.equal(projection.content, "");
    assert.equal((projection.content_excerpt as JsonObject).reason, "no_lexical_match");
    assert.equal((projection.content_excerpt as JsonObject).source_start, null);
    assert.equal((projection.content_excerpt as JsonObject).source_end, null);
    assert.equal((projection.content_excerpt as JsonObject).source_chars, content.length);
  }
  assert.equal("retrieval_text" in knowledge, false);
  const absentKnowledge = projectKnowledgeRetrieval({ claim_id: "claim" }, "query");
  const absentMemory = projectMemoryRetrieval({ memory_id: "memory" }, "query", false);
  assert.equal("content" in absentKnowledge, false);
  assert.equal("content" in absentMemory, false);
  assert.equal("content" in projectKnowledgeRetrieval({ content, retrieval_text: content }, "query", true), true);
  assert.equal(projectMemoryRetrieval({ content, memory_id: "required" }, "query", true).content, content);
});

test("a legacy Memory record without content stays metadata-only during shared packing", async () => {
  const f = await fixture();
  try {
    const memory: ContextContributionProvider = {
      member: "memory",
      async contribute() {
        return { member: "memory", receipt_id: "legacy-memory", omitted_count: 0, items: [{ memory_id: "legacy", memory_version: 1, scope: { kind: "project", id: "demo" } }] };
      },
    };
    const kernel = new ContextResolutionKernel(f.store, [memory]);
    const result = await kernel.resolve({ ...request, query: "undefined", members: ["memory"] });
    const items = result.items as JsonObject[];
    assert.equal(items.length, 1);
    assert.equal(items[0]!.memory_id, "legacy");
    assert.equal("content" in items[0]!, false);
  } finally { await f.close(); }
});

test("Context recalls project aliases without an identity record and fences alias revocation", async () => {
  const f = await fixture();
  try {
    f.store.create("scope_alias", "active", { status: "active", scope: { kind: "project", id: "demo" }, alias_kind: "legacy", alias: "old-name" });
    f.claim("alias", { scope: "project:old-name" });
    f.claim("foreign", { scope: "project:other" });
    const kernel = new ContextResolutionKernel(f.store, [f.reader]);
    const result = await kernel.resolve({ ...request, members: ["knowledge"] });
    assert.deepEqual((result.contributions as JsonObject[]).flatMap(part => (part.items as JsonObject[]).map(item => item.claim_id)), ["alias"]);
    const receipt = result.receipt as JsonObject;
    assert((receipt.read_refs as JsonObject[]).some(ref => ref.kind === "scope_alias" && ref.id === "active"));
    f.store.save("scope_alias", "active", { status: "revoked", scope: { kind: "project", id: "demo" }, alias: "old-name" });
    assert.throws(() => assertContextReadCurrent(f.store, receipt), /changed during recall/);
    const reopened = await kernel.resolve({ ...request, members: ["knowledge"] });
    assert.deepEqual((reopened.contributions as JsonObject[]).flatMap(part => part.items as JsonObject[]), []);
  } finally { await f.close(); }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-contribution-"));
  const store = await new CraftStore(craftPaths(root)).open();
  store.create("scope_alias", "demo-path", { scope: { kind: "project", id: "demo" }, alias_kind: "path", alias: root, status: "active" });
  const otherRoot = join(root, "other-project"); await mkdir(otherRoot);
  store.create("scope_alias", "other-path", { scope: { kind: "project", id: "other" }, alias_kind: "path", alias: otherRoot, status: "active" });
  const reader = new KnowledgeContribution(store);
  store.create("knowledge_source", "source", { scope: { kind: "global", id: "global" }, status: "active", trust: "verified", content_digest: "source-v1" });
  const claim = (id: string, extra: JsonObject = {}) => {
    const { status = "reviewed", ...rest } = extra;
    const record = store.create("knowledge_claim", id, { status: status === "reviewed" ? "candidate" : status,
      scope: "project:demo", source_id: "source", content: "alpha", evidence_ids: [], content_digest: "fixture-content", ...rest });
    return status === "reviewed" && store.find("knowledge_source", String(record.source_id)) ? attachVerifiedPromotionFixture(store, record) : record;
  };
  return { store, reader, claim, async close() { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("Knowledge contribution fails closed for invalid request time and malformed or expired claim validity", async () => {
  const f = await fixture();
  try {
    for (const [i, valid_until] of ["invalid", "", false, 0, {}, "2026-09-27T09:59:59Z"].entries()) f.claim(`bad-${i}`, { valid_until });
    f.claim("equal", { valid_until: request.now });
    f.claim("future", { valid_until: "9999-01-01T00:00:00Z" });
    f.claim("none", { valid_until: null });
    f.claim("legacy-unspecified");
    await assert.rejects(f.reader.contribute({ ...request, now: "not-a-date" }), /valid timestamp/);
    assert.deepEqual((await f.reader.contribute(request)).items.map(x => x.claim_id), ["equal", "future", "legacy-unspecified", "none"]);
    assert((await f.reader.contribute({ ...request, now: undefined })).items.some(x => x.claim_id === "future"));
  } finally { await f.close(); }
});

test("Knowledge contribution separates candidate diagnostics and rejects missing, revoked and drifted sources", async (t) => {
  const f = await fixture();
  try {
    f.store.create("knowledge_source", "source-record-missing", { scope: "global", status: "active", trust: "verified" });
    f.store.create("knowledge_source", "absent", { scope: "global", status: "active", trust: "verified" });
    f.claim("good", { review: { source_digest: "source-v1" } });
    f.claim("candidate", { status: "candidate", review: { source_digest: "old" } });
    f.claim("candidate-missing-source-record", { status: "candidate", source_id: "source-record-missing" });
    f.claim("stale", { status: "stale" });
    f.claim("missing-source", { source_id: "absent" });
    f.claim("legacy-source", { source_id: null });
    f.claim("empty-source", { source_id: "" });
    f.store.remove("knowledge_source", "source-record-missing");
    f.store.remove("knowledge_source", "absent");
    f.claim("drift", { review: { source_digest: "old" } });
    const reviewDigestDrift = f.claim("review-digest-drift");
    f.store.save("knowledge_claim", String(reviewDigestDrift.id), { ...f.store.get("knowledge_claim", String(reviewDigestDrift.id)),
      review: { ...(reviewDigestDrift.review as JsonObject), source_digest: "sha256:stale-source" } });
    f.store.create("knowledge_source", "revoked", { scope: { kind: "global", id: "global" }, status: "revoked", trust: "verified" });
    f.store.create("knowledge_source", "untrusted", { scope: { kind: "global", id: "global" }, status: "active", trust: "untrusted" });
    f.claim("candidate-untrusted-source", { status: "candidate", source_id: "untrusted" });
    f.claim("revoked", { source_id: "revoked" });
    f.claim("untrusted", { source_id: "untrusted" });
    assert.deepEqual((await f.reader.contribute(request)).items.map(x => x.claim_id), ["good"]);
    assert.equal((await f.reader.contribute(request)).items.some(x => x.claim_id === "review-digest-drift"), false,
      "a formerly reviewed Claim cannot remain visible after its Source digest drifts");
    const diagnostic = await f.reader.search(request, true);
    assert.deepEqual(diagnostic.items.map(x => x.claim_id), ["candidate", "good"]);
    assert.equal(diagnostic.items[0]!.reason, "candidate_diagnostic_only");
    assert.equal(diagnostic.items[1]!.reason, "reviewed_bm25");
    assert.equal((await f.reader.search({ ...request, source_ids: ["other"] }, true)).items.length, 0);
    assert.equal((await f.reader.contribute({ ...request, source_ids: ["source"] })).items.length, 1);
    assert.equal((await f.reader.contribute({ ...request, source_ids: [] })).items.length, 1);

    const racingSource = f.store.create("knowledge_source", "racing-source", { scope: { kind: "global", id: "global" }, status: "active", trust: "verified", content_digest: "racing-source-v1" });
    f.claim("source-changed-during-recall", { source_id: racingSource.id });
    const find = f.store.find.bind(f.store); let sourceReads = 0;
    t.mock.method(f.store, "find", ((kind: string, id: string, version?: number, hydrate?: boolean) => {
      const found = find(kind, id, version, hydrate);
      if (kind === "knowledge_source" && id === racingSource.id && found && ++sourceReads >= 2) return { ...found, content_digest: "racing-source-v2" };
      return found;
    }) as typeof f.store.find);
    const raced = await f.reader.contribute(request);
    t.mock.restoreAll();
    assert.equal(sourceReads >= 2, true, "the source is checked during promotion proof and again for Context dependencies");
    assert.equal(raced.items.some(item => item.claim_id === "source-changed-during-recall"), false,
      "a source digest change during recall fails closed before injecting the Claim");
  } finally { await f.close(); }
});

test("Knowledge contribution applies explicit scope stacks, active aliases and audience restrictions", async () => {
  const f = await fixture();
  try {
    f.store.create("scope_alias", "active", { status: "active", scope: { kind: "project", id: "demo" }, alias_kind: "legacy", alias: "old-name" });
    f.store.create("scope_alias", "revoked", { status: "active", scope: { kind: "project", id: "demo" }, alias_kind: "legacy", alias: "revoked-name" });
    f.claim("project");
    f.claim("other", { scope: "project:other" });
    f.claim("global", { scope: "global" });
    const timestamp = new Date().toISOString();
    f.store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("knowledge_claim", "absent", 1, JSON.stringify({ id: "absent", version: 1, status: "reviewed", scope: null,
        source_id: "source", content: "alpha", evidence_ids: [] }), timestamp, timestamp);
    f.store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("knowledge_claim", "empty-scope", 1, JSON.stringify({ id: "empty-scope", version: 1, status: "reviewed", scope: "", source_id: "source", content: "alpha", evidence_ids: ["fixture-evidence"] }), timestamp, timestamp);
    f.claim("private", { scope_envelope: { audience: { mode: "private", principal_ids: ["owner"] }, tenant_id: "tenant" } });
    f.claim("alias", { scope: "project:old-name" });
    f.claim("revoked-alias", { scope: "project:revoked-name" });
    f.store.save("scope_alias", "revoked", { status: "revoked", scope: { kind: "project", id: "demo" }, alias_kind: "legacy", alias: "revoked-name" });
    f.store.create("scope_alias", "other", { status: "active", scope: { kind: "project", id: "other" }, alias: "other" });
    assert.deepEqual((await f.reader.contribute(request)).items.map(x => x.claim_id), ["alias", "project"]);
    assert.deepEqual((await f.reader.contribute({ ...request, scope_kind: "global", scope_id: "global" })).items.map(x => x.claim_id), ["global"]);
    const expanded = await f.reader.contribute({ ...request, scope_stack: [{ kind: "project", id: "demo" }, { kind: "global", id: "global" }], principal_id: "owner", tenant_id: "tenant", cognitive_purpose: "fact" });
    assert.deepEqual(expanded.items.map(x => x.claim_id), ["alias", "global", "private", "project"]);
  } finally { await f.close(); }
});

test("Knowledge contribution reads canonical bodies, sorts deterministically and bounds every returned excerpt", async (t) => {
  const f = await fixture();
  try {
    f.claim("b", { content: "alpha beta" });
    const claimA = f.claim("a", { content: "alpha beta" });
    f.claim("c", { content: "alpha" });
    f.claim("tag-only", { content: "unrelated", tags: ["beta"] });
    f.claim("irrelevant", { content: "unrelated" });
    const content_ref = f.store.contentStore.writeSync({ kind: "knowledge", record_id: "file", version: 1, scope: "project:demo", status: "reviewed", sensitivity: "internal", source_id: "source", body: "alpha", title: "File" });
    f.claim("file", { content: null, content_ref });
    // CraftStore normally hydrates content. Exercise the read-side Interface
    // with a reference-only row, as allowed by the contribution contract.
    const list = f.store.listScoped.bind(f.store);
    t.mock.method(f.store, "listScoped", (...args: Parameters<CraftStore["listScoped"]>) => list(...args).map(row => {
      if (args[0] !== "knowledge_claim" || row.id !== "file") return row;
      const projected = { ...row }; delete projected.content; return projected;
    }));
    const full = await f.reader.contribute({ ...request, query: "alpha beta" });
    assert.deepEqual(full.items.map(x => x.claim_id), ["a", "b", "tag-only", "c", "file"]);
    assert.equal(full.items.find(x => x.claim_id === "file")!.content, "alpha");
    const one = await f.reader.contribute({ ...request, query: "alpha beta", max_items: 1 });
    assert.equal(one.omitted_count, 4);
    assert.equal(one.receipt_id, `knowledge_contribution_a@${claimA.version}`);
    const size = JSON.stringify(one.items[0]).length;
    assert.equal((await f.reader.contribute({ ...request, query: "alpha beta", max_chars: size })).items.length, 1);
    const unmatched = await f.reader.contribute({ ...request, query: "no-matching-token", candidate_mode: true });
    assert.deepEqual(unmatched.items.map(item => item.claim_id), ["a", "b", "c", "file", "irrelevant", "tag-only"],
      "candidate mode must resolve equal zero-score ties deterministically");
    const none = await f.reader.contribute({ ...request, max_chars: 0 });
    assert.equal(none.items.length, 0); assert.equal(none.receipt_id, "knowledge_contribution_none");
    f.claim("broken", { content: null });
    await assert.rejects(f.reader.contribute(request), /content reference is missing/);
  } finally { await f.close(); }
});
