import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";

/**
 * A relation graph an agent can author needs two guarantees that are easy to
 * lose: you cannot walk it forever, and you cannot make a belief disappear by
 * wishing it away. These tests pin the bounded walk and the soft retract, plus
 * the evidence gate that separates "confirmed" from "bounded".
 */

async function fixture(): Promise<{ root: string; store: CraftStore; service: CraftService }> {
  const root = await mkdtemp(join(tmpdir(), "craft-relation-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store, service: new CraftService(store) };
}

async function claim(service: CraftService, id: string, content: string): Promise<string> {
  const evidence = service.evidenceRecord({ evidence_id: `${id}-evidence`, source_type: "program", claim: content, confidence: "confirmed" });
  const saved = service.knowledgeClaimSave({ claim_id: id, kind: "fact", content, evidence_ids: [evidence.id] }).claim as JsonObject;
  return String(saved.id);
}

test("relations require evidence before they may be called confirmed", async () => {
  const f = await fixture();
  try {
    const a = await claim(f.service, "c-a", "Observed behaviour of A.");
    const b = await claim(f.service, "c-b", "Observed behaviour of B.");
    assert.throws(() => f.service.relationSave({ source: { kind: "knowledge_claim", id: a }, target: { kind: "knowledge_claim", id: b }, relation: "supports", confidence: "confirmed" }), /Evidence/u);
    const bounded = f.service.relationSave({ source: { kind: "knowledge_claim", id: a }, target: { kind: "knowledge_claim", id: b }, relation: "supports" }) as JsonObject;
    assert.equal((bounded.relation as JsonObject).confidence, "bounded");
    assert.equal(bounded.idempotent, false);
    const evidence = f.service.evidenceRecord({ evidence_id: "e-shared", source_type: "program", claim: "A second observation.", confidence: "confirmed" });
    const confirmed = f.service.relationSave({ relation_id: "r-confirmed", source: { kind: "knowledge_claim", id: a }, target: { kind: "knowledge_claim", id: b }, relation: "refines", confidence: "confirmed", evidence_ids: [evidence.id] }) as JsonObject;
    assert.deepEqual((confirmed.relation as JsonObject).evidence_ids, [evidence.id]);
    assert.throws(() => f.service.relationSave({ relation_id: "r-ghost-evidence", source: { kind: "knowledge_claim", id: a }, target: { kind: "knowledge_claim", id: b }, relation: "references", evidence_ids: ["e-missing"] }), /evidence/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("relate is idempotent on an identical edge and rejects a conflicting replay", async () => {
  const f = await fixture();
  try {
    const a = await claim(f.service, "c-a", "Observed behaviour of A.");
    const b = await claim(f.service, "c-b", "Observed behaviour of B.");
    const args = { relation_id: "r-1", source: { kind: "knowledge_claim", id: a }, target: { kind: "knowledge_claim", id: b }, relation: "refines" };
    const first = f.service.relationSave(args) as JsonObject;
    assert.equal(String(first.idempotent), "false");
    assert.equal(String((f.service.relationSave(args) as JsonObject).idempotent), "true");
    assert.equal(String((f.service.relationGet({ relation_id: "r-1" }).relation as JsonObject).id), "r-1");
    assert.throws(() => f.service.relationSave({ ...args, relation: "supersedes" }), /idempotency/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("retract soft-invalidates rather than deleting, so the edge stops being live", async () => {
  const f = await fixture();
  try {
    const a = await claim(f.service, "c-a", "Observed behaviour of A.");
    const b = await claim(f.service, "c-b", "Observed behaviour of B.");
    f.service.relationSave({ relation_id: "r-1", source: { kind: "knowledge_claim", id: a }, target: { kind: "knowledge_claim", id: b }, relation: "supports", valid_from: "2020-01-01T00:00:00.000Z" });
    const live = f.service.relationNeighbors({ kind: "knowledge_claim", id: a }).relations as JsonObject[];
    assert.equal(live.length, 1);
    const retracted = f.service.relationRetract({ relation_id: "r-1", reason: "superseded by a broader finding" }) as JsonObject;
    assert.ok(Date.parse(String((retracted.relation as JsonObject).valid_to)) > Date.parse("2020-01-01T00:00:00.000Z"));
    assert.equal((f.service.relationNeighbors({ kind: "knowledge_claim", id: a }).relations as JsonObject[]).length, 0);
    assert.equal((f.service.relationNeighbors({ kind: "knowledge_claim", id: a, as_of: "2021-01-01T00:00:00.000Z" }).relations as JsonObject[]).length, 1);
    assert.equal(String((f.service.relationGet({ relation_id: "r-1" }).relation as JsonObject).id), "r-1");
    assert.throws(() => f.service.relationRetract({ relation_id: "r-1", reason: "too early", valid_to: "2019-01-01T00:00:00.000Z" }), /after valid_from/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("neighbours span both directions and label which way the edge points", async () => {
  const f = await fixture();
  try {
    const a = await claim(f.service, "c-a", "Observed behaviour of A.");
    const b = await claim(f.service, "c-b", "Observed behaviour of B.");
    f.service.relationSave({ relation_id: "ab", source: { kind: "knowledge_claim", id: a }, target: { kind: "knowledge_claim", id: b }, relation: "supports" });
    const forward = f.service.relationNeighbors({ kind: "knowledge_claim", id: a }).relations as JsonObject[];
    assert.equal(String(forward[0].direction), "forward");
    const inverse = f.service.relationNeighbors({ kind: "knowledge_claim", id: b }).relations as JsonObject[];
    assert.equal(String(inverse[0].direction), "inverse");
    assert.equal((f.service.relationNeighbors({ kind: "knowledge_claim", id: b, direction: "forward" }).relations as JsonObject[]).length, 0);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("traverse is bounded, terminates on a cycle, and honours max_depth", async () => {
  const f = await fixture();
  try {
    const a = await claim(f.service, "c-a", "Observed behaviour of A.");
    const b = await claim(f.service, "c-b", "Observed behaviour of B.");
    const c = await claim(f.service, "c-c", "Observed behaviour of C.");
    f.service.relationSave({ relation_id: "ab", source: { kind: "knowledge_claim", id: a }, target: { kind: "knowledge_claim", id: b }, relation: "supports" });
    f.service.relationSave({ relation_id: "bc", source: { kind: "knowledge_claim", id: b }, target: { kind: "knowledge_claim", id: c }, relation: "supports" });
    f.service.relationSave({ relation_id: "ca", source: { kind: "knowledge_claim", id: c }, target: { kind: "knowledge_claim", id: a }, relation: "supports" });
    const depthOne = f.service.relationTraverse({ kind: "knowledge_claim", id: a, max_depth: 1 }) as JsonObject;
    assert.equal((depthOne.nodes as JsonObject[]).length, 2);
    const depthThree = f.service.relationTraverse({ kind: "knowledge_claim", id: a, max_depth: 3 }) as JsonObject;
    assert.equal((depthThree.nodes as JsonObject[]).length, 3);
    assert.equal(String(depthThree.truncated), "false");
    assert.throws(() => f.service.relationTraverse({ kind: "knowledge_claim", id: a, max_depth: 4 }), /between/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("edges pointing at an object that does not exist are not surfaced", async () => {
  const f = await fixture();
  try {
    const a = await claim(f.service, "c-a", "Observed behaviour of A.");
    f.service.relationSave({ relation_id: "ghost", source: { kind: "knowledge_claim", id: a }, target: { kind: "knowledge_claim", id: "c-missing" }, relation: "references" });
    assert.equal((f.service.relationNeighbors({ kind: "knowledge_claim", id: a }).relations as JsonObject[]).length, 0);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("relation endpoints must be distinct, known kinds, and free of secrets", async () => {
  const f = await fixture();
  try {
    const a = await claim(f.service, "c-a", "Observed behaviour of A.");
    assert.throws(() => f.service.relationSave({ source: { kind: "knowledge_claim", id: a }, target: { kind: "knowledge_claim", id: a }, relation: "supports" }), /differ/u);
    assert.throws(() => f.service.relationSave({ source: { kind: "nonsense", id: a }, target: { kind: "knowledge_claim", id: a }, relation: "supports" }), /unsupported/u);
    assert.throws(() => f.service.relationSave({ source: { kind: "knowledge_claim", id: a }, target: { kind: "knowledge_claim", id: "c-x" }, relation: "not-a-kind" }), /unsupported/u);
    const saved = f.service.relationSave({ relation_id: "r-plain", source: { kind: "knowledge_claim", id: a }, target: { kind: "knowledge_claim", id: "c-x" }, relation: "supports", rationale: "we observed this while triaging" });
    assert.ok(saved);
    assert.throws(() => f.service.relationSave({ relation_id: "r-leak", source: { kind: "knowledge_claim", id: a }, target: { kind: "knowledge_claim", id: "c-x" }, relation: "supports", rationale: "token=abcdefghijkl" }), /secret/u);
    assert.throws(() => f.service.relationSave({ relation_id: "r-leak-2", source: { kind: "knowledge_claim", id: a }, target: { kind: "knowledge_claim", id: "c-x" }, relation: "supports", rationale: "api_key=abcdefghijkl" }), /secret/u);
    assert.throws(() => f.service.relationSave({ relation_id: "r-shape", source: { kind: "knowledge_claim", id: a }, target: { kind: "knowledge_claim", id: "c-x" }, relation: "supports", evidence_ids: "not-an-array" }), /array/u);
    assert.throws(() => f.service.relationSave({ relation_id: "r-dupes", source: { kind: "knowledge_claim", id: a }, target: { kind: "knowledge_claim", id: "c-x" }, relation: "supports", evidence_ids: ["e-1", "e-1"] }), /unique/u);
    assert.throws(() => f.service.relationSave({ relation_id: "r-missing-endpoint", source: { kind: "knowledge_claim" }, target: { kind: "knowledge_claim", id: "c-x" }, relation: "supports" }), /source\.id/u);
    assert.throws(() => f.service.relationSave({ relation_id: "r-bad-version", source: { kind: "knowledge_claim", id: a, version: 0 }, target: { kind: "knowledge_claim", id: "c-x" }, relation: "supports" }), /between/u);
    assert.throws(() => f.service.relationRetract({ reason: "no id" }), /relation_id/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("knowledge search carries a one-hop relation summary for both directions", async () => {
  const f = await fixture();
  try {
    const docs = join(f.root, "docs");
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, "guide.md"), "# Guide\n\nrunbook zeta for the incident queue");
    f.service.knowledgeIndexSync({ project_root: docs });
    const claimId = await claim(f.service, "c-a", "Observed behaviour of A.");
    f.service.relationSave({ relation_id: "forward", source: { kind: "knowledge_document", id: "guide.md" }, target: { kind: "knowledge_claim", id: claimId }, relation: "supports" });
    f.service.relationSave({ relation_id: "inverse", source: { kind: "knowledge_claim", id: claimId }, target: { kind: "knowledge_document", id: "guide.md" }, relation: "references" });
    const hits = f.service.knowledgeSearch({ query: "runbook" }).hits as JsonObject[];
    assert.equal(hits.length, 1);
    const relations = hits[0].relations as JsonObject[];
    assert.equal(relations.length, 2);
    const forward = relations.find((edge) => edge.relation_id === "forward")!;
    const inverse = relations.find((edge) => edge.relation_id === "inverse")!;
    assert.equal(String(forward.direction), "forward");
    assert.deepEqual(forward.other, { kind: "knowledge_claim", id: claimId, version: null });
    assert.equal(String(inverse.direction), "inverse");
    assert.deepEqual(inverse.other, { kind: "knowledge_claim", id: claimId, version: null });
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("the relation kernels are reachable over MCP with the craft_relation_* surface", async () => {
  const f = await fixture();
  try {
    const a = await claim(f.service, "c-a", "Observed behaviour of A.");
    const b = await claim(f.service, "c-b", "Observed behaviour of B.");
    const mcp = new McpServer(f.service, "full");
    const call = (name: string, arguments_: JsonObject) => mcp.handle({ id: name, method: "tools/call", params: { name, arguments: arguments_ } });
    assert.equal(((await call("craft_relation_relate", { relation_id: "r-1", source: { kind: "knowledge_claim", id: a }, target: { kind: "knowledge_claim", id: b }, relation: "supports" }))?.result as JsonObject).isError, false);
    assert.equal(((await call("craft_relation_neighbors", { kind: "knowledge_claim", id: a }))?.result as JsonObject).isError, false);
    assert.equal(((await call("craft_relation_traverse", { kind: "knowledge_claim", id: a, max_depth: 2 }))?.result as JsonObject).isError, false);
    assert.equal(((await call("craft_relation_get", { relation_id: "r-1" }))?.result as JsonObject).isError, false);
    assert.equal(((await call("craft_relation_retract", { relation_id: "r-1", reason: "no longer believed" }))?.result as JsonObject).isError, false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("the running service version is the one under test", () => { assert.equal(VERSION, "0.12.36"); });
