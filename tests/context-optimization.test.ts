import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { ContextResolutionKernel } from "../core/context-resolution.ts";
import { KnowledgeContribution } from "../capability/craft-knowledge/contribution.ts";
import { KeywordRetrievalPort } from "../common/craft-common-base/src/retrieval-port.ts";
import { ContextBudget, ContextBudgetError } from "../common/craft-common-base/src/context-assets.ts";
import { ContextReadGuard } from "../common/craft-common-store-local/src/context-access-guard.ts";
import { payload } from "../core/digest.ts";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-context-optimization-"));
  const store = await new CraftStore(craftPaths(root)).open(), writer = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  service.knowledgeSourceRegister({ source_id: "source", kind: "custom", label: "source", scope_kind: "project", scope_id: "p", locator: root, content_digest: "source", trust: "verified", access: "read_only" });
  return { root, store, writer, service, async close() { writer.close(); store.close(); await rm(root, { recursive: true, force: true }); } };
}
for (const mutation of ["claim", "source", "document", "alias", "delete"] as const) {
  test(`standalone Knowledge SDK fences ${mutation} during ranking await`, async t => {
    const f = await fixture();
    try {
      const envelope = { audience: { mode: "private", principal_ids: ["owner"] } };
      f.store.create("knowledge_document", "doc", { status: "current", content_digest: "document" });
      f.store.create("scope_alias", "alias", { scope: { kind: "project", id: "p" }, alias: "/repo", status: "active" });
      f.store.create("knowledge_claim", "claim", { source_id: "source", document_id: "doc", document_digest: "document", scope: "project:p", status: "reviewed", scope_envelope: envelope, content: "alpha", content_digest: "body" });
      const original = KeywordRetrievalPort.prototype.search;
      t.mock.method(KeywordRetrievalPort.prototype, "search", async function(this: KeywordRetrievalPort, query: string, documents: readonly { id: string; body: string }[]) {
        const kind = mutation === "claim" || mutation === "delete" ? "knowledge_claim" : mutation === "source" ? "knowledge_source" : mutation === "document" ? "knowledge_document" : "scope_alias";
        const id = mutation === "claim" || mutation === "delete" ? "claim" : mutation === "source" ? "source" : mutation === "document" ? "doc" : "alias";
        if (mutation === "delete") f.writer.database.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
        else f.writer.save(kind, id, { ...payload(f.writer.get(kind, id)), status: "revoked", scope_envelope: { audience: { mode: "private", principal_ids: ["other"] } } });
        return original.call(this, query, documents);
      });
      await assert.rejects(new KnowledgeContribution(f.store).search({ query: "alpha", scope_kind: "project", scope_id: "p", principal_id: "owner", max_items: 5, max_chars: 10000 }, false), /changed during recall/);
    } finally { await f.close(); }
  });
}
test("required nonmatching Knowledge has nonnegative omission; unselected mutation preserves receipt", async () => {
  const f = await fixture();
  try {
    for (const id of ["required", "other"]) f.store.create("knowledge_claim", id, { source_id: "source", scope: "project:p", status: "reviewed", content: id === "required" ? "unrelated" : "alpha", content_digest: id });
    const kernel = new ContextResolutionKernel(f.store, [new KnowledgeContribution(f.store)]);
    const result = await kernel.resolve({ query: "alpha", scope_kind: "project", scope_id: "p", members: ["knowledge"], max_items: 1, required_refs: [{ member: "knowledge", id: "required" }] });
    const contribution = (result.contributions as JsonObject[])[0]!;
    assert.equal((contribution.items as JsonObject[])[0]!.claim_id, "required"); assert.equal(contribution.omitted_count, 1);
    assert.deepEqual(((result.receipt as JsonObject).read_refs as JsonObject[]).map(ref => ref.id).sort(), ["required", "source"]);
    f.writer.save("knowledge_claim", "other", { ...payload(f.writer.get("knowledge_claim", "other")), status: "revoked" });
    const { assertContextReadCurrent } = await import("../core/context-access-guard.ts");
    assertContextReadCurrent(f.store, result.receipt as JsonObject);
    const only = await kernel.resolve({ query: "nohit", scope_kind: "project", scope_id: "p", members: ["knowledge"], required_refs: [{ member: "knowledge", id: "required" }] });
    assert.equal((only.contributions as JsonObject[])[0]!.omitted_count, 0);
  } finally { await f.close(); }
});
test("scoped temporal selection precedes hydration and honors known time/latest semantics", async t => {
  const f = await fixture();
  try {
    f.store.create("thing", "a", { scope: { kind: "project", id: "p" }, content: "old" });
    f.store.save("thing", "a", { scope: { kind: "project", id: "p" }, content: "new" });
    f.store.create("thing", "elsewhere", { scope: "project:other", content: "private" });
    f.store.database.prepare("UPDATE records SET updated_at=? WHERE kind='thing' AND version=1").run("2020-01-01T00:00:00.000Z");
    f.store.database.prepare("UPDATE records SET updated_at=? WHERE kind='thing' AND version=2").run("2022-01-01T00:00:00.000Z");
    const scope = [{ kind: "project", id: "p" }];
    for (const invalid of ["bad", [null], [{ kind: 1, id: "p" }], [{ kind: "project", id: 1 }]]) assert.throws(() => f.store.listScoped("thing", invalid as never), /Invalid scoped/);
    assert.deepEqual(f.store.listScoped("thing", []), []);
    assert.equal(f.store.list("thing", 1, undefined, false, { source_ids: [], document_ids: [] }).length, 1);
    f.store.create("thing", "global", { scope: "global" });
    assert.equal(f.store.listScoped("thing", [{ kind: "global", id: "global" }]).length, 1);
    assert.equal(f.store.listScoped("thing", scope, 2, undefined, { known_at: "2021-01-01T00:00:00Z" })[0].content, "old");
    assert.equal(f.store.listScoped("thing", scope, 2, undefined, { history: true }).length, 2);
    assert.equal(f.store.listScoped("thing", scope, 1, item => item.content === "old", { history: true, known_at: "2023-01-01T00:00:00Z" })[0].version, 1);
    assert.deepEqual(f.store.listScoped("thing", scope, 1, () => false, { history: true }), []);
    assert.throws(() => f.store.listScoped("thing", scope, 1, undefined, { known_at: "bad" }), /known_at/);
  } finally { await f.close(); }
});
test("shared projection budget and batched explicit read fence", async () => {
  const f = await fixture();
  try {
    for (const limits of [[0, 1], [1, 0], [1.1, 2], [2, Infinity]]) assert.throws(() => new ContextBudget(...limits as [number, number]), ContextBudgetError);
    const budget = new ContextBudget(2, 5);
    for (const [items, chars] of [[-1, 0], [0, -1], [0.5, 0], [0, Infinity]]) assert.throws(() => budget.reserve(items!, chars!, false, "bad"), ContextBudgetError);
    const globalGuard = new ContextReadGuard(f.store, undefined, [{ kind: "global", id: "global" }]); globalGuard.assertCurrent();
    new ContextReadGuard(f.store, undefined, []).assertCurrent();
    assert.equal(budget.reserve(1, 3, true, "required"), true);
    assert.equal(budget.reserve(1, 3, false, "optional"), false);
    assert.throws(() => budget.reserve(1, 3, true, "required"), /required/);
    assert.equal(budget.reserve(1, 2, true, "required"), true);
    assert.equal(budget.reserve(1, 0, false, "optional"), false);
    const refs = Array.from({ length: 501 }, (_, i) => ({ kind: "knowledge_claim", id: `missing${i}`, version: 0 }));
    const guard = new ContextReadGuard(f.store, refs);
    for (const ref of refs) guard.track(ref.kind, ref.id);
    guard.assertCurrent();
    f.writer.create("knowledge_claim", "missing500", {});
    assert.throws(() => guard.assertCurrent(), /changed/);
  } finally { await f.close(); }
});


test("Knowledge listing authorizes metadata before body reads and filters body queries", async t => {
  const f = await fixture();
  try {
    f.store.create("evidence", "proof", { confidence: "confirmed", source_type: "human" });
    const publicClaim = f.service.knowledgeClaimSave({ claim_id: "public", source_id: "source", kind: "fact", scope: "project:p", content: "public fact", evidence_ids: ["proof"] }).claim as JsonObject;
    f.service.knowledgeClaimSave({ claim_id: "hidden", source_id: "source", kind: "fact", scope: "project:p", content: "private fact", evidence_ids: ["proof"], scope_envelope: { audience: { mode: "private", principal_ids: ["owner"] } } });
    const original = f.store.contentStore.readCompatSync;
    t.mock.method(f.store.contentStore, "readCompatSync", function(this: typeof f.store.contentStore, ref: Parameters<typeof original>[0]) {
      if (typeof ref === "object" && ref !== null && "record_id" in ref) assert.notEqual(ref.record_id, "hidden");
      return original.call(this, ref);
    });
    assert.deepEqual((f.service.knowledgeClaimList({ query: "fact" }).claims as JsonObject[]).map(claim => claim.id), [publicClaim.id]);
    assert.deepEqual(f.service.knowledgeClaimList({ query: "does-not-match" }).claims, []);
  } finally { await f.close(); }
});

test("explicit confirmation affects only exact revision ranking and receipt identity", async () => {
  const f = await fixture();
  try {
    f.store.create("evidence", "human", { confidence: "confirmed", source_type: "human" });
    const memories = ["a", "b"].map(id => f.service.memoryLedgerRemember({ memory_id: id, source_id: "source", kind: "preference", scope_kind: "project", scope_id: "p", content: `alpha preference ${id}`, observed_at: "2000-01-01T00:00:00Z", evidence_ids: ["human"] }).memory as JsonObject);
    const args = { query: "alpha", scope_kind: "project", scope_id: "p", max_items: 1, now: new Date(Date.now() + 86_400_000).toISOString() };
    const before = await f.service.contextResolutionResolve(args);
    assert.equal((before.items as JsonObject[])[0]!.memory_id, "a");
    f.service.memoryGovernance.confirm({ memory_id: "b", expected_version: memories[1]!.version, explicit_consent: true, evidence_ids: ["human"] });
    const after = await f.service.contextResolutionResolve(args);
    assert.equal((after.items as JsonObject[])[0]!.memory_id, "b");
    assert.notEqual((after.receipt as JsonObject).id, (before.receipt as JsonObject).id);
    assert.equal(f.store.get("memory_ledger", "b").valid_until, null);
  } finally { await f.close(); }
});

test("Knowledge revalidation selects reverse Source/Document dependencies without unrelated body hydration", async () => {
  const f = await fixture();
  try {
    const { KnowledgeClaimGovernance } = await import("../capability/craft-knowledge/claim-governance.ts");
    const sdk = new KnowledgeClaimGovernance(f.store);
    f.store.create("knowledge_claim", "target", { source_id: "source", document_id: "doc", document_digest: "d", scope: "project:p", status: "reviewed", content: "target" });
    f.store.create("knowledge_claim", "unrelated", { source_id: "other", scope: "project:p", status: "reviewed", content: "unrelated" });
    f.store.create("knowledge_document", "doc", { status: "changed", content_digest: "new" });
    assert.equal(sdk.synchronize({ source_ids: ["source"], document_ids: ["doc"] }).count, 1);
    assert.equal(f.store.get("knowledge_claim", "unrelated").status, "reviewed");
    assert.equal(sdk.synchronize({ source_ids: ["absent"] }).count, 0);
    assert.throws(() => sdk.synchronize({ document_ids: "bad" }), /array/);
    assert.throws(() => sdk.synchronize({ source_ids: ["source", "source"] }), /unique/);
  } finally { await f.close(); }
});

test("invalid third-party contribution counts fail closed or report partial failure", async () => {
  const f = await fixture();
  try {
    for (const result of [{ member: "knowledge", omitted_count: -1 }, { member: "knowledge", omitted_count: 0.5 }, { member: "experience", omitted_count: 0 }]) {
      const reader = new ContextResolutionKernel(f.store, [{ member: "knowledge", async contribute() { return { ...result, items: [], receipt_id: "invalid" }; } } as never]);
      const args = { query: "alpha", scope_kind: "project", scope_id: "p", members: ["knowledge"] };
      await assert.rejects(reader.resolve(args), /invalid member or omission/);
      const partial = await reader.resolve({ ...args, allow_partial: true });
      assert.equal((partial.receipt as JsonObject).partial, true);
    }
  } finally { await f.close(); }
});

for (const action of ["resolve", "searchKnowledge"] as const) {
  test(`scope alias snapshot cannot be replaced between scope selection and ${action} fence`, async t => {
    const f = await fixture();
    try {
      const kernel = new ContextResolutionKernel(f.store, [new KnowledgeContribution(f.store)]);
      const alias = kernel.scopes.bindAlias({ scope_kind: "project", scope_id: "p", alias_kind: "legacy", alias: "legacy" }).alias as JsonObject;
      f.service.memoryLedgerRemember({ memory_id: "m", source_id: "source", kind: "preference", scope_kind: "project", scope_id: "p", content: "alpha" });
      f.store.create("knowledge_claim", "claim", { source_id: "source", scope: "project:p", status: "reviewed", content: "alpha" });
      const resolve = kernel.scopes.resolveStack.bind(kernel.scopes);
      t.mock.method(kernel.scopes, "resolveStack", (...args: Parameters<typeof resolve>) => {
        const result = resolve(...args);
        f.writer.save("scope_alias", String(alias.id), { ...payload(alias), status: "revoked" });
        return result;
      });
      await assert.rejects(kernel[action]({ query: "alpha", scope_kind: "project", scope_id: "legacy" }), /changed during recall/);
      assert.equal(f.store.count("context_resolution_receipt"), 0);
    } finally { await f.close(); }
  });
}
