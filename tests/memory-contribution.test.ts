import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CraftStore, type JsonObject } from "../common/craft-common-store-local/src/store.ts";
import { craftPaths } from "../common/craft-common-store-local/src/paths.ts";
import { MemoryContribution } from "../capability/craft-memory/contribution.ts";
import { memoryCapability } from "../capability/craft-memory/capability.ts";
import { MemoryLedgerKernel } from "../capability/craft-memory/memory-ledger.ts";
import { buildCapabilityRegistry, CORE_KERNELS, type ContextRequest } from "../common/craft-common-base/src/capability-protocol.ts";
import { KeywordRetrievalPort } from "../common/craft-common-base/src/retrieval-port.ts";
import { ContextResolutionKernel } from "../core/context-resolution.ts";
import { payload } from "../core/digest.ts";
const scope = { kind: "project", id: "p" };
const request: ContextRequest = { query: "alpha", scope_kind: "project", scope_id: "p", max_items: 10, max_chars: 10000 };

for (const [name, validity] of [
  ["expired", { valid_until: "2021-01-01T00:00:00Z" }],
  ["future", { effective_from: "2099-01-01T00:00:00Z" }],
  ["valid", { valid_until: "2099-01-01T00:00:00Z" }],
] as const) {
  test(`Memory ${name} task preference preserves temporal scope precedence in SDK and Context`, async () => {
    const f = await fixture();
    try {
      f.remember("project", { topic: "theme", effective_from: "2020-01-01T00:00:00Z" });
      f.remember("task", { scope_kind: "task", scope_id: "t", topic: "theme", effective_from: "2020-01-01T00:00:00Z", ...validity });
      const now = "2026-10-09T00:00:00Z";
      const local = await f.reader.contribute({ ...request, now, scope_stack: [{ kind: "task", id: "t" }, scope] });
      const expected = name === "valid" ? "task" : "project";
      assert.deepEqual(local.items.map(item => item.memory_id), [expected]);
      const shared = await new ContextResolutionKernel(f.store, [f.reader]).resolve({ query: "alpha", scope_kind: "task", scope_id: "t", project_scope_id: "p", now });
      assert.deepEqual((shared.items as JsonObject[]).map(item => item.memory_id), [expected]);
      const history = await f.reader.contribute({ ...request, now, history_view: true, candidate_mode: true, scope_stack: [{ kind: "task", id: "t" }, scope] });
      assert.deepEqual(history.items.map(item => item.memory_id).sort(), ["project", "task"]);
    } finally { await f.close(); }
  });
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-memory-contribution-"));
  const store = await new CraftStore(craftPaths(root)).open(), writer = await new CraftStore(craftPaths(root)).open();
  store.create("knowledge_source", "source", { status: "active", trust: "verified", scope });
  const ledger = new MemoryLedgerKernel(store), reader = new MemoryContribution(store);
  const remember = (id: string, extra: JsonObject = {}) => ledger.remember({ memory_id: id, source_id: "source", kind: "preference", scope_kind: "project", scope_id: "p", content: `alpha ${id}`, observed_at: "2020-01-01T00:00:00Z", ...extra }).memory as JsonObject;
  return { store, writer, ledger, reader, remember, async close() { writer.close(); store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("Memory registers a single standalone contribution and supports local or shared candidate reads", async () => {
  const f = await fixture();
  try {
    const registry = buildCapabilityRegistry([memoryCapability], { [CORE_KERNELS.store]: f.store });
    assert.deepEqual(registry.contributed.map(provider => provider.member), ["memory"]);
    f.remember("a"); f.remember("b");
    const local = await registry.contributed[0]!.contribute({ ...request, max_items: 1 });
    assert.equal(local.items.length, 1); assert.equal(local.omitted_count, 1);
    const all = await f.reader.contribute({ ...request, candidate_mode: true });
    assert.equal(all.items.length, 2); assert.equal(all.diagnostics?.eligible_memory_count, 2);
    assert.deepEqual(all.read_refs?.map(ref => ref.id).sort(), ["a", "b", "source"]);
    assert.equal((await f.reader.contribute({ ...request, query: "unrelated", memory_ids: ["a", "b"] })).items.length, 2);
    const noHits = await f.reader.contribute({ ...request, query: "unrelated" }); assert.equal(noHits.omitted_count, 0);
    assert.equal((await f.reader.contribute({ ...request, query: "unrelated", memory_ids: ["a"] })).items[0]!.memory_id, "a");
    const ref = { member: "memory", id: "b", version: 1 };
    assert.equal((await f.reader.contribute({ ...request, query: "unrelated", required_refs: [ref] })).items[0]!.memory_id, "b");
    await assert.rejects(f.reader.contribute({ ...request, memory_ids: ["missing"] }), /Required Memory/);
    await assert.rejects(f.reader.contribute({ ...request, required_refs: [{ ...ref, version: 2 }] }), /Required Context/);
    await assert.rejects(f.reader.contribute({ ...request, max_chars: 1, memory_ids: ["a"] }), /budget/);
    await assert.rejects(f.reader.contribute({ ...request, candidate_mode: true, max_items: 1 }), /candidate budget/);
    await assert.rejects(f.reader.contribute({ ...request, candidate_mode: true, max_chars: 1 }), /candidate budget/);
  } finally { await f.close(); }
});

test("Memory owns scope precedence, history, current authorization and exclusions before hydration", async t => {
  const f = await fixture();
  try {
    const now = "2026-10-09T00:00:00.000Z";
    f.remember("project", { topic: "theme", content: "alpha project", observed_at: "2020-01-01T00:00:00Z" });
    f.remember("task", { scope_kind: "task", scope_id: "t", topic: "theme", content: "alpha task", observed_at: "2020-01-01T00:00:00Z" });
    f.remember("future", { effective_from: "2099-01-01T00:00:00Z" });
    f.remember("expired", { valid_until: "2021-01-01T00:00:00Z" });
    f.remember("working", { kind: "working", working_note: true, valid_until: "2099-01-01T00:00:00Z" });
    f.remember("private", { scope_envelope: { audience: { mode: "private", principal_ids: ["owner"] } } });
    f.remember("restricted", { sensitivity: "restricted" });
    f.remember("elsewhere", { scope_id: "other" });
    const original = f.store.contentStore.readCompatSync;
    t.mock.method(f.store.contentStore, "readCompatSync", function(this: typeof f.store.contentStore, ref: Parameters<typeof original>[0]) {
      assert(!["private", "restricted", "elsewhere"].includes(String((ref as JsonObject).record_id))); return original.call(this, ref);
    });
    const selected = await f.reader.contribute({ ...request, now, candidate_mode: true, scope_stack: [{ kind: "task", id: "t" }, scope] });
    assert.deepEqual(selected.items.map(item => item.memory_id), ["task"]);
    assert(selected.diagnostics!.temporal_excluded instanceof Array);
    t.mock.restoreAll();
    const working = await f.reader.contribute({ ...request, now, candidate_mode: true, include_working_notes: true, allow_restricted: true, principal_id: "owner" });
    assert(working.items.some(item => item.memory_id === "working")); assert(working.items.some(item => item.memory_id === "private")); assert(working.items.some(item => item.memory_id === "restricted"));
    const project = f.store.get("memory_ledger", "project"); f.writer.save("memory_ledger", "project", { ...payload(project), status: "revoked" });
    const history = await f.reader.contribute({ ...request, now, history_view: true, candidate_mode: true });
    assert(history.items.filter(item => item.memory_id === "project").length === 2);
    assert(history.items.every(item => item.execution_context === false));
    const known = await f.reader.contribute({ ...request, now, known_at: now, as_of: "2020-01-02T00:00:00Z", candidate_mode: true });
    assert(known.items.every(item => item.execution_context === false));
    for (const extra of [{ now: "bad" }, { as_of: "bad" }, { known_at: "bad" }, { max_items: 0 }]) await assert.rejects(f.reader.contribute({ ...request, ...extra }));
  } finally { await f.close(); }
});

for (const mutation of ["audience", "source", "delete"] as const) {
  test(`standalone Memory contribution rechecks ${mutation} during its await`, async t => {
    const f = await fixture();
    try {
      f.remember("private", { scope_envelope: { audience: { mode: "private", principal_ids: ["owner"] } } });
      const original = KeywordRetrievalPort.prototype.search;
      t.mock.method(KeywordRetrievalPort.prototype, "search", async function(this: KeywordRetrievalPort, ...args: Parameters<typeof original>) {
        if (mutation === "delete") f.writer.database.prepare("DELETE FROM records WHERE kind='memory_ledger' AND id='private'").run();
        else {
          const kind = mutation === "source" ? "knowledge_source" : "memory_ledger", id = mutation === "source" ? "source" : "private";
          f.writer.save(kind, id, { ...payload(f.writer.get(kind, id)), ...(mutation === "source" ? { status: "revoked" } : { scope_envelope: { audience: { mode: "private", principal_ids: ["other"] } } }) });
        }
        return original.call(this, ...args);
      });
      await assert.rejects(f.reader.contribute({ ...request, principal_id: "owner" }), /changed during recall/);
    } finally { await f.close(); }
  });
}

test("Context replaces Memory through the contribution interface, never reading a Ledger fallback", async t => {
  const f = await fixture();
  try {
    const item = { memory_id: "external", memory_version: 1, content: "alpha external", content_digest: "external", scope, source_id: "remote" };
    const provider = { member: "memory" as const, async contribute(input: ContextRequest) { assert(input.candidate_mode); return { member: "memory" as const, items: [item], receipt_id: "remote", omitted_count: 0 }; } };
    const original = f.store.listScoped.bind(f.store);
    t.mock.method(f.store, "listScoped", (...args: Parameters<typeof original>) => { assert.notEqual(args[0], "memory_ledger"); return original(...args); });
    const kernel = new ContextResolutionKernel(f.store, [provider]);
    const result = await kernel.resolve({ ...request, memory_ids: ["external"] });
    assert.equal((result.items as JsonObject[])[0]!.memory_id, "external"); assert.deepEqual(result.contributions, []);
    assert.equal((result.receipt as JsonObject).total_items, 1);
    const excluded = await kernel.resolve({ ...request, members: ["knowledge"] }); assert.deepEqual(excluded.items, []);
    await assert.rejects(kernel.resolve({ ...request, members: ["knowledge"], memory_ids: ["external"] }), /excluded/);
    const broken = new ContextResolutionKernel(f.store, [{ member: "memory", async contribute() { throw new Error("memory unavailable"); } }]);
    await assert.rejects(broken.resolve({ ...request, allow_partial: true }), /memory unavailable/);
  } finally { await f.close(); }
});

test("standalone Memory validates explicitly selected Sources before serving any candidates", async () => {
  const f = await fixture();
  try {
    f.remember("a");
    await assert.rejects(f.reader.contribute({ ...request, source_ids: ["missing"] }), /Requested Knowledge Source/);
    for (const patch of [{ status: "revoked" }, { trust: "untrusted" }, { scope_envelope: { audience: { mode: "private", principal_ids: ["owner"] } } }]) {
      const current = f.store.get("knowledge_source", "source");
      f.store.save("knowledge_source", "source", { ...payload(current), status: "active", trust: "verified", scope_envelope: undefined, ...patch });
      await assert.rejects(f.reader.contribute({ ...request, source_ids: ["source"] }), /Requested Knowledge Source/);
    }
    f.store.save("knowledge_source", "source", { status: "active", trust: "verified", scope });
    assert.equal((await f.reader.contribute({ ...request, source_ids: ["source"] })).items.length, 1);
  } finally { await f.close(); }
});

test("historical Memory receipts pin the Source of the returned version, not a newer binding", async () => {
  const f = await fixture();
  try {
    const memory = f.remember("history");
    f.store.create("knowledge_source", "new-source", { status: "active", trust: "verified", scope });
    f.store.save("memory_ledger", "history", { ...payload(memory), source_id: "new-source" });
    f.store.database.prepare("UPDATE records SET updated_at=? WHERE kind='memory_ledger' AND version=1").run("2020-01-01T00:00:00.000Z");
    f.store.database.prepare("UPDATE records SET updated_at=? WHERE kind='memory_ledger' AND version=2").run("2022-01-01T00:00:00.000Z");
    const result = await new ContextResolutionKernel(f.store).resolve({ ...request, as_of: "2021-01-01T00:00:00Z" });
    const receipt = result.receipt as JsonObject;
    assert.equal((result.items as JsonObject[])[0]!.source_id, "source");
    assert.deepEqual((receipt.read_refs as JsonObject[]).map(ref => ref.id).sort(), ["history", "source"]);
    const { assertContextReadCurrent } = await import("../core/context-access-guard.ts");
    f.writer.save("knowledge_source", "new-source", { status: "revoked", trust: "verified", scope });
    assertContextReadCurrent(f.store, receipt);
    f.writer.save("knowledge_source", "source", { status: "revoked", trust: "verified", scope });
    assert.throws(() => assertContextReadCurrent(f.store, receipt), /changed during recall/);
  } finally { await f.close(); }
});


test("verified feedback counts each matching revision once and ignores stale or malformed references", async () => {
  const f = await fixture();
  try {
    const memory = f.remember("weighted", { observed_at: "2026-10-01T00:00:00Z" });
    const context = { ...request, now: "2026-10-10T00:00:00Z", candidate_mode: true };
    const baseline = (await f.reader.contribute(context)).items[0]!.ranking_weight;
    assert(typeof baseline === "number");
    const ref = { memory_id: memory.id, content_digest: memory.content_digest };
    f.store.create("context_feedback", "first", { outcome: "helpful", evidence_verified: true, memory_refs: [ref] });
    const once = (await f.reader.contribute(context)).items[0]!.ranking_weight;
    assert(typeof once === "number");
    assert(once > baseline);
    f.store.save("context_feedback", "first", { outcome: "helpful", evidence_verified: true, memory_refs: [ref, ref] });
    for (const [id, extra] of [["stale", { memory_refs: [{ ...ref, content_digest: "old" }] }], ["missing", {}], ["malformed", { memory_refs: [null, "invalid", {}] }], ["unverified", { memory_refs: [ref], evidence_verified: false }], ["unhelpful", { memory_refs: [ref], outcome: "unhelpful" }]] as const) {
      f.store.create("context_feedback", id, { outcome: "helpful", evidence_verified: true, ...extra });
    }
    assert.equal((await f.reader.contribute(context)).items[0]!.ranking_weight, once);
    f.store.create("context_feedback", "second", { outcome: "helpful", evidence_verified: true, memory_refs: [ref] });
    const twice = (await f.reader.contribute(context)).items[0]!.ranking_weight;
    assert(typeof twice === "number" && twice > once);
  } finally { await f.close(); }
});
