import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { KnowledgeContribution } from "../capability/craft-knowledge/contribution.ts";
import { ExperienceContribution } from "../capability/craft-experience/contribution.ts";
import { ContextResolutionKernel } from "../core/context-resolution.ts";

const request = { query: "alpha", scope_kind: "project", scope_id: "target", max_items: 10, max_chars: 12000 } as const;
const source = { status: "active", trust: "verified", scope: { kind: "project", id: "target" }, content_digest: "source" };
const claim = { status: "reviewed", source_id: "source", scope: "project:target", content: "alpha", content_digest: "body" };
const procedure = { lifecycle: "routeable", routeable: true, scope: "project:target", trigger: "alpha", title: "Alpha", procedure_kind: "prompt", content_digest: "body" };
type Row = { kind: string; id: string; payload: JsonObject; at?: string };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-candidate-scope-"));
  const store = await new CraftStore(craftPaths(root)).open();
  // Bulk immutable fixture rows avoid filesystem/content writes while exercising
  // the real SQLite list ordering, hydration, predicates and candidate selection.
  const insert = (rows: Row[]) => store.transaction(database => {
    const statement = database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,1,?,?,?)");
    for (const row of rows) { const at = row.at ?? "2026-10-04T10:00:00.000Z"; statement.run(row.kind, row.id, JSON.stringify(row.payload), at, at); }
  });
  insert([{ kind: "knowledge_source", id: "source", payload: source, at: "2020-01-01T00:00:00.000Z" }]);
  return { store, insert, knowledge: new KnowledgeContribution(store), experience: new ExperienceContribution(store), async close() { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("Old target Knowledge and Experience survive over 10000 newer foreign records and Sources", async () => {
  const f = await fixture();
  try {
    f.insert([{ kind: "knowledge_claim", id: "target-claim", payload: { ...claim, document_id: "current", document_digest: "current" }, at: "2020-01-01T00:00:00.000Z" },
      { kind: "experience_procedure", id: "target-procedure", payload: procedure, at: "2020-01-01T00:00:00.000Z" }]);
    f.insert([{ kind: "knowledge_document", id: "current", payload: { status: "current", content_digest: "current" } },
      { kind: "knowledge_document", id: "deleted", payload: { status: "deleted", content_digest: "current" } },
      ...["absent", "deleted", "current"].map(document_id => ({ kind: "knowledge_claim", id: `stale-${document_id}`, payload: { ...claim, document_id, document_digest: "old" } }))]);
    f.insert(Array.from({ length: 10_001 }, (_, n) => [
      { kind: "knowledge_source", id: `foreign-source-${n}`, payload: { ...source, scope: { kind: "project", id: "foreign" } } },
      { kind: "knowledge_claim", id: `foreign-claim-${n}`, payload: { ...claim, scope: "project:foreign", source_id: `foreign-source-${n}` } },
      { kind: "experience_procedure", id: `foreign-procedure-${n}`, payload: { ...procedure, scope: "project:foreign" } },
    ]).flat());
    assert.deepEqual((await f.knowledge.contribute(request)).items.map(i => i.claim_id), ["target-claim"]);
    assert.deepEqual((await f.experience.contribute(request)).items.map(i => i.procedure_id), ["target-procedure"]);
    const empty = { ...request, scope_id: "empty" };
    assert.deepEqual((await f.knowledge.contribute(empty)).items, []); assert.deepEqual((await f.experience.contribute(empty)).items, []);
  } finally { await f.close(); }
});

test("Unauthorized candidates and Sources do not consume the authorized scope budget", async () => {
  const f = await fixture();
  try {
    const hidden = { audience: { mode: "private", principal_ids: ["owner"] } };
    f.insert([{ kind: "knowledge_claim", id: "target-claim", payload: claim, at: "2020-01-01T00:00:00.000Z" },
      { kind: "experience_procedure", id: "target-procedure", payload: procedure, at: "2020-01-01T00:00:00.000Z" }]);
    f.insert(Array.from({ length: 10_002 }, (_, n) => [
      { kind: "knowledge_source", id: `hidden-source-${n}`, payload: { ...source, scope_envelope: hidden } },
      { kind: "knowledge_claim", id: `hidden-claim-${n}`, payload: { ...claim, source_id: `hidden-source-${n}` } },
      { kind: "experience_procedure", id: `hidden-procedure-${n}`, payload: { ...procedure, scope_envelope: hidden } },
    ]).flat());
    assert.deepEqual((await f.knowledge.contribute(request)).items.map(i => i.claim_id), ["target-claim"]);
    assert.deepEqual((await f.experience.contribute(request)).items.map(i => i.procedure_id), ["target-procedure"]);
    await assert.rejects(f.knowledge.contribute({ ...request, principal_id: "owner" }), /Knowledge candidate budget/);
    await assert.rejects(f.experience.contribute({ ...request, principal_id: "owner" }), /Experience candidate budget/);
  } finally { await f.close(); }
});

test("Authorized candidate overflow is explicit for strict reads and aggregate partial resolution", async () => {
  const f = await fixture();
  try {
    f.insert(Array.from({ length: 10_001 }, (_, n) => [
      { kind: "knowledge_claim", id: `claim-${n}`, payload: claim },
      { kind: "experience_procedure", id: `procedure-${n}`, payload: procedure },
    ]).flat());
    await assert.rejects(f.knowledge.contribute(request), /Knowledge candidate budget/);
    await assert.rejects(f.experience.contribute(request), /Experience candidate budget/);
    assert.equal((await f.knowledge.contribute({ ...request, source_ids: ["absent"] })).items.length, 0);
    const resolver = new ContextResolutionKernel(f.store, [f.knowledge, f.experience]);
    await assert.rejects(resolver.resolve({ ...request, members: ["knowledge", "experience"] }), /candidate budget/);
    const result = await resolver.resolve({ ...request, members: ["knowledge", "experience"], allow_partial: true });
    const receipt = result.receipt as JsonObject;
    assert.equal(receipt.partial, true); assert.deepEqual((receipt.contributor_failures as JsonObject[]).map(i => i.member), ["knowledge", "experience"]);
    f.insert(Array.from({ length: 10_001 }, (_, n) => ({ kind: "scope_alias", id: `alias-${n}`, payload: { status: "active", scope: { kind: "project", id: "target" }, alias: `old-${n}` } })));
    await assert.rejects(f.knowledge.contribute(request), /candidate budget.*aliases/);
  } finally { await f.close(); }
});
