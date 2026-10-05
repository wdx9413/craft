import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { KnowledgeContribution } from "../capability/craft-knowledge/contribution.ts";
import { payload } from "../core/digest.ts";
import { sourceAllows } from "../core/scope-policy.ts";
import { McpServer } from "../core/mcp.ts";
import { bindRemoteIdentity } from "../deploy/components/server.ts";

const scope = { scope_kind: "project", scope_id: "access-fixture" } as const;
const privateEnvelope = { audience: { mode: "private", principal_ids: ["owner"] }, tenant_id: "tenant" };
const owner = { principal_id: "owner", tenant_id: "tenant" };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-source-access-"));
  const store = await new CraftStore(craftPaths(root)).open(), service = new CraftService(store);
  const source = (id: string, extra: JsonObject = {}) => service.knowledgeSourceRegister({ source_id: id, kind: "custom", label: id, ...scope,
    locator: root, content_digest: "fixture", trust: "verified", access: "read_only", ...extra }).source as JsonObject;
  source("public"); source("private", { scope_envelope: privateEnvelope });
  store.create("evidence", "e", { source_type: "human", confidence: "confirmed" });
  const memory = (id: string, extra: JsonObject = {}) => service.memoryLedgerRemember({ memory_id: id, source_id: "public", kind: "preference", ...scope,
    content: `alpha ${id}`, evidence_ids: ["e"], ...extra }).memory as JsonObject;
  return { store, service, source, memory, async close() { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("Source audience gates Knowledge independently of derivative purpose and follows current source restrictions", async () => {
  const f = await fixture();
  try {
    for (const source_id of ["public", "private"]) {
      f.service.knowledgeClaimSave({ claim_id: source_id, source_id, kind: "fact", content: "alpha fact", scope: "project:access-fixture", evidence_ids: ["e"] });
      f.service.knowledgeClaimReview({ claim_id: source_id, status: "reviewed", reviewer: "fixture", reason: "evidence checked" });
    }
    const reader = new KnowledgeContribution(f.store), request = { query: "alpha", ...scope, max_items: 20, max_chars: 10000 } as const;
    assert.deepEqual((await reader.contribute(request)).items.map(i => i.claim_id), ["public"]);
    assert.deepEqual((await reader.contribute({ ...request, ...owner })).items.map(i => i.claim_id), ["private", "public"]);
    const source = f.store.get("knowledge_source", "public");
    f.store.save("knowledge_source", "public", { ...payload(source), scope_envelope: privateEnvelope });
    assert.equal((await reader.contribute(request)).items.length, 0);
    assert(sourceAllows(f.store.get("knowledge_source", "public"), { ...owner, purpose: "preference" }));
    assert(!sourceAllows(f.store.get("knowledge_source", "public"), { principal_id: "owner", tenant_id: "other" }));
    assert(sourceAllows({}, { purpose: "preference" }));
    assert.throws(() => sourceAllows({ scope: "malformed" }, {}), /scope/);
  } finally { await f.close(); }
});

test("Knowledge exact and list reads enforce current and historical audience through remote MCP", async () => {
  const f = await fixture();
  try {
    f.service.knowledgeClaimSave({ claim_id: "private-claim", source_id: "private", kind: "fact", content: "secret fact", scope: "project:access-fixture", evidence_ids: ["e"], scope_envelope: privateEnvelope });
    const current = f.store.get("knowledge_claim", "private-claim");
    assert.throws(() => f.service.knowledgeClaimGet({ claim_id: current.id }), /denied/);
    assert.deepEqual(f.service.knowledgeClaimList({}).claims, []);
    assert.equal((f.service.knowledgeClaimGet({ claim_id: current.id, ...owner }).claim as JsonObject).id, current.id);
    assert.deepEqual((f.service.knowledgeClaimList({ ...owner }).claims as JsonObject[]).map(item => item.id), [current.id]);
    assert.throws(() => f.service.knowledgeClaimGet({ claim_id: current.id, ...owner, scope_kind: "project", scope_id: "other" }), /denied/);
    assert.throws(() => f.service.knowledgeClaimGet({ claim_id: current.id, ...owner, scope_kind: "team" }), /denied/);
    assert.throws(() => f.service.knowledgeClaimGet({ claim_id: current.id, principal_id: "owner", tenant_id: "other" }), /denied/);
    const restricted = f.store.save("knowledge_claim", String(current.id), { ...payload(current), sensitivity: "restricted" });
    assert.throws(() => f.service.knowledgeClaimGet({ claim_id: current.id, ...owner }), /denied/);
    assert.equal((f.service.knowledgeClaimGet({ claim_id: current.id, ...owner, allow_restricted: true }).claim as JsonObject).version, restricted.version);
    f.store.save("knowledge_claim", String(current.id), { ...payload(current), source_id: null });
    assert.throws(() => f.service.knowledgeClaimGet({ claim_id: current.id, ...owner }), /denied/);
    f.store.save("knowledge_claim", String(current.id), { ...payload(current), source_id: "missing" });
    assert.throws(() => f.service.knowledgeClaimGet({ claim_id: current.id, ...owner }), /denied/);
    f.store.save("knowledge_claim", String(current.id), payload(current));
    const mcp = new McpServer(f.service, "component-knowledge");
    const call = async (principal: string, name: string, args: JsonObject) => (await bindRemoteIdentity(mcp, principal, "tenant").handle({ id: 1, method: "tools/call", params: { name, arguments: args } }))!.result as JsonObject;
    assert.equal((await call("other", "craft_knowledge_claim_get", { claim_id: current.id })).isError, true);
    assert.deepEqual(((await call("other", "craft_knowledge_claim_list", {})).structuredContent as JsonObject).claims, []);
    assert.equal(((await call("owner", "craft_knowledge_claim_get", { claim_id: current.id })).structuredContent as JsonObject).claim && true, true);
    f.store.save("knowledge_claim", String(current.id), { ...payload(current), scope_envelope: { audience: { mode: "private", principal_ids: ["new-owner"] }, tenant_id: "tenant" } });
    assert.throws(() => f.service.knowledgeClaimGet({ claim_id: current.id, version: 1, ...owner }), /denied/);
    const changedSource = f.store.get("knowledge_source", "private");
    f.store.save("knowledge_source", "private", { ...payload(changedSource), scope_envelope: { audience: { mode: "private", principal_ids: ["new-owner"] }, tenant_id: "tenant" } });
    assert.throws(() => f.service.knowledgeClaimGet({ claim_id: current.id, version: 1, principal_id: "new-owner", tenant_id: "tenant" }), /historical/);
    const source = f.store.get("knowledge_source", "private");
    f.store.save("knowledge_source", "private", { ...payload(source), trust: "untrusted" });
    assert.deepEqual(f.service.knowledgeClaimList({ principal_id: "new-owner", tenant_id: "tenant" }).claims, []);
    f.store.save("knowledge_source", "private", { ...payload(source), status: "revoked" });
    assert.deepEqual(f.service.knowledgeClaimList({ principal_id: "new-owner", tenant_id: "tenant" }).claims, []);
  } finally { await f.close(); }
});

test("Ledger exact and scoped reads enforce current, historical and Source access without removing legacy ID reads", async () => {
  const f = await fixture();
  try {
    f.memory("plain"); f.memory("source-private", { source_id: "private" });
    const restricted = f.memory("restricted", { scope_envelope: privateEnvelope, sensitivity: "restricted" });
    assert.equal((f.service.memoryLedgerGet({ memory_id: "plain" }).memory as JsonObject).content, "alpha plain");
    for (const args of [{}, owner, { allow_restricted: true }, { ...owner, allow_restricted: true, scope_kind: "project", scope_id: "other" }]) {
      assert.throws(() => f.service.memoryLedgerGet({ memory_id: "restricted", ...args }), /denied/);
    }
    assert.throws(() => f.service.memoryLedgerGet({ memory_id: "source-private" }), /denied/);
    assert.equal((f.service.memoryLedgerGet({ memory_id: "source-private", ...owner }).memory as JsonObject).id, "source-private");
    const read = { memory_id: "restricted", ...scope, ...owner, allow_restricted: true };
    assert.equal((f.service.memoryLedgerGet(read).memory as JsonObject).content, "alpha restricted");
    assert.equal((f.service.memoryLedgerGet({ ...read, version: 1 }).memory as JsonObject).version, 1);
    const ids = (args: JsonObject) => (f.service.memoryLedgerList({ ...scope, ...args }).memories as JsonObject[]).map(i => i.id).sort();
    assert.deepEqual(ids({}), ["plain"]); assert.deepEqual(ids(owner), ["plain", "source-private"]);
    assert.deepEqual(ids({ ...owner, allow_restricted: true }), ["plain", "restricted", "source-private"]);
    f.store.save("memory_ledger", "restricted", { ...payload(restricted), scope_envelope: { audience: { mode: "private", principal_ids: ["new-owner"] }, tenant_id: "tenant" } });
    assert.throws(() => f.service.memoryLedgerGet({ ...read, version: 1 }), /denied/);
    assert.throws(() => f.service.memoryLedgerGet({ ...read, principal_id: "new-owner", version: 1 }), /historical/);
    f.store.save("memory_ledger", "restricted", { ...payload(restricted), scope: { kind: "project", id: "moved" }, scope_envelope: undefined });
    assert.throws(() => f.service.memoryLedgerGet({ memory_id: "restricted", version: 1, allow_restricted: true }), /historical/);
    f.memory("orphan", { source_id: "public" });
    const orphan = f.store.get("memory_ledger", "orphan"); f.store.save("memory_ledger", "orphan", { ...payload(orphan), source_id: "absent" });
    assert.throws(() => f.service.memoryLedgerGet({ memory_id: "orphan" }), /denied/);
    const source = f.store.get("knowledge_source", "public"); f.store.save("knowledge_source", "public", { ...payload(source), scope_envelope: privateEnvelope });
    assert.deepEqual(ids({}), []);
  } finally { await f.close(); }
});

test("Maintenance never bypasses envelopes for unscoped, semantic, legacy or restricted records", async () => {
  const f = await fixture();
  try {
    const legacy = (id: string, extra: JsonObject = {}) => f.store.create("episodic_memory", id, { content_digest: id, ...extra });
    legacy("public-legacy"); legacy("private-legacy", { scope_envelope: privateEnvelope });
    const run = (args: JsonObject = {}) => f.service.memoryMaintenanceRun({ stage: "review", ...args }).run as JsonObject;
    assert.deepEqual(run().memory_ids, ["public-legacy"]);
    assert.deepEqual(run(owner).memory_ids, ["private-legacy", "public-legacy"]);
    f.memory("private-ledger", { scope_envelope: privateEnvelope });
    assert.deepEqual(run().memory_ids, []); assert.equal(run().memory_kind, "memory_ledger");
    f.memory("public-ledger"); f.memory("source-private", { source_id: "private" }); f.memory("restricted", { sensitivity: "restricted" });
    for (const [id, extra] of [["public-semantic", {}], ["private-semantic", { scope_envelope: privateEnvelope }], ["source-semantic", { source_id: "private" }], ["retired-semantic", { status: "revoked" }]] as const) {
      f.store.create("semantic_memory", id, { status: "active", scope: { kind: "project", id: "access-fixture" }, memory_ids: [], ...extra });
    }
    assert.deepEqual(run().memory_ids, ["public-ledger"]); assert.deepEqual(run().semantic_ids, ["public-semantic"]);
    assert.deepEqual(run(scope).semantic_ids, ["public-semantic"]);
    assert.deepEqual(run({ scope_kind: "project", scope_id: "other" }).memory_ids, []);
    const allowed = run({ ...scope, ...owner, allow_restricted: true });
    assert.deepEqual(allowed.memory_ids, ["private-ledger", "public-ledger", "restricted", "source-private"]);
    assert.deepEqual(allowed.semantic_ids, ["private-semantic", "public-semantic", "source-semantic"]);
    assert.deepEqual(run({ ...scope, cognitive_purpose: "preference" }).memory_ids, []);
  } finally { await f.close(); }
});
