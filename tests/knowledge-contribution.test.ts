import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KnowledgeContribution } from "../capability/craft-knowledge/contribution.ts";
import type { ContextRequest } from "../core/capability-protocol.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";

const request: ContextRequest = { query: "alpha", scope_kind: "project", scope_id: "demo", max_items: 10, max_chars: 10000, now: "2026-09-27T10:00:00Z" };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-contribution-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const reader = new KnowledgeContribution(store);
  store.create("knowledge_source", "source", { status: "active", trust: "verified", content_digest: "source-v1" });
  const claim = (id: string, extra: JsonObject = {}) => store.create("knowledge_claim", id, { status: "reviewed", scope: "project:demo", source_id: "source", content: "alpha", evidence_ids: ["fixture-evidence"], content_digest: "fixture-content", ...extra });
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

test("Knowledge contribution separates candidate diagnostics and rejects missing, revoked and drifted sources", async () => {
  const f = await fixture();
  try {
    f.claim("good", { review: { source_digest: "source-v1" } });
    f.claim("candidate", { status: "candidate", review: { source_digest: "old" } });
    f.claim("stale", { status: "stale" });
    f.claim("missing-source", { source_id: "absent" });
    f.claim("legacy-source", { source_id: null });
    f.claim("empty-source", { source_id: "" });
    f.claim("drift", { review: { source_digest: "old" } });
    f.store.create("knowledge_source", "revoked", { status: "revoked", trust: "verified" });
    f.store.create("knowledge_source", "untrusted", { status: "active", trust: "untrusted" });
    f.claim("revoked", { source_id: "revoked" });
    f.claim("untrusted", { source_id: "untrusted" });
    assert.deepEqual((await f.reader.contribute(request)).items.map(x => x.claim_id), ["good"]);
    const diagnostic = await f.reader.search(request, true);
    assert.deepEqual(diagnostic.items.map(x => x.claim_id), ["candidate", "good"]);
    assert.equal(diagnostic.items[0]!.reason, "candidate_diagnostic_only");
    assert.equal(diagnostic.items[1]!.reason, "reviewed_bm25");
    assert.equal((await f.reader.search({ ...request, source_ids: ["other"] }, true)).items.length, 0);
    assert.equal((await f.reader.contribute({ ...request, source_ids: ["source"] })).items.length, 1);
    assert.equal((await f.reader.contribute({ ...request, source_ids: [] })).items.length, 1);
  } finally { await f.close(); }
});

test("Knowledge contribution applies explicit scope stacks, active aliases and audience restrictions", async () => {
  const f = await fixture();
  try {
    f.claim("project");
    f.claim("other", { scope: "project:other" });
    f.claim("global", { scope: "global" });
    f.claim("absent", { scope: null });
    f.claim("empty-scope", { scope: "" });
    f.claim("private", { scope_envelope: { audience: { mode: "private", principal_ids: ["owner"] }, tenant_id: "tenant" } });
    f.claim("alias", { scope: "project:old-name" });
    f.claim("revoked-alias", { scope: "project:revoked-name" });
    f.store.create("scope_alias", "active", { status: "active", scope: { kind: "project", id: "demo" }, alias: "old-name" });
    f.store.create("scope_alias", "revoked", { status: "revoked", scope: { kind: "project", id: "demo" }, alias: "revoked-name" });
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
    f.claim("a", { content: "alpha beta" });
    f.claim("c", { content: "alpha" });
    f.claim("tag-only", { content: "unrelated", tags: ["beta"] });
    f.claim("irrelevant", { content: "unrelated" });
    const content_ref = f.store.contentStore.writeSync({ kind: "knowledge", record_id: "file", version: 1, scope: "project:demo", status: "reviewed", sensitivity: "internal", source_id: "source", body: "alpha", title: "File" });
    f.claim("file", { content: null, content_ref });
    // CraftStore normally hydrates content. Exercise the read-side Interface
    // with a reference-only row, as allowed by the contribution contract.
    const list = f.store.list.bind(f.store);
    t.mock.method(f.store, "list", (...args: Parameters<CraftStore["list"]>) => list(...args).map(row => {
      if (args[0] !== "knowledge_claim" || row.id !== "file") return row;
      const projected = { ...row }; delete projected.content; return projected;
    }));
    const full = await f.reader.contribute({ ...request, query: "alpha beta" });
    assert.deepEqual(full.items.map(x => x.claim_id), ["a", "b", "tag-only", "c", "file"]);
    assert.equal(full.items.find(x => x.claim_id === "file")!.content, "alpha");
    const one = await f.reader.contribute({ ...request, query: "alpha beta", max_items: 1 });
    assert.equal(one.omitted_count, 4);
    assert.equal(one.receipt_id, "knowledge_contribution_a@1");
    const size = JSON.stringify(one.items[0]).length;
    assert.equal((await f.reader.contribute({ ...request, query: "alpha beta", max_chars: size })).items.length, 1);
    const none = await f.reader.contribute({ ...request, max_chars: 0 });
    assert.equal(none.items.length, 0); assert.equal(none.receipt_id, "knowledge_contribution_none");
    f.claim("broken", { content: null });
    await assert.rejects(f.reader.contribute(request), /content reference is missing/);
  } finally { await f.close(); }
});
