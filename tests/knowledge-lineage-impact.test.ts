import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { CraftService } from "../core/service.ts";
import { knowledgeLineageImpact } from '@craft/capability-knowledge/knowledge-lineage-impact';

async function fixture(): Promise<{ root: string; store: CraftStore; service: CraftService }> {
  const root = await mkdtemp(join(tmpdir(), "craft-lineage-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store, service: new CraftService(store) };
}

async function claim(service: CraftService, id: string, content: string): Promise<string> {
  const evidence = service.evidenceRecord({ evidence_id: `${id}-evidence`, source_type: "program", claim: content, confidence: "confirmed" });
  const saved = service.knowledgeClaimSave({ claim_id: id, kind: "fact", content, scope: "global", evidence_ids: [evidence.id] }).claim as JsonObject;
  return String(saved.id);
}

const node = (id: string): JsonObject => ({ kind: "knowledge_claim", id });

test("a refuted foundation flags every derived claim for re-evaluation, with degrading confidence", async () => {
  const f = await fixture();
  try {
    const foundation = await claim(f.service, "c-base", "All agents need structured memory.");
    const derived = await claim(f.service, "c-derived", "Retrieval alone loses provenance.");
    const grandchild = await claim(f.service, "c-grandchild", "Ontology-guided claims are queryable.");
    const challenger = await claim(f.service, "c-challenger", "A newer study reverses the premise.");
    // derived derives_from foundation; grandchild derives_from derived.
    f.service.relationSave({ relation_id: "r-d1", source: node(derived), target: node(foundation), relation: "derives_from", confidence: "confirmed", evidence_ids: ["c-base-evidence"] });
    f.service.relationSave({ relation_id: "r-d2", source: node(grandchild), target: node(derived), relation: "derives_from", confidence: "bounded" });
    f.service.relationSave({ relation_id: "r-x", source: node(challenger), target: node(foundation), relation: "contradicts", confidence: "confirmed", evidence_ids: ["c-base-evidence"] });

    const impact = knowledgeLineageImpact(f.store, { node: node(foundation) });
    assert.equal(impact.root_challenged, true);
    assert.deepEqual(impact.challenge_relation_ids, ["r-x"]);
    const impacted = impact.impacted as unknown as JsonObject[];
    assert.equal(impacted.length, 2);
    const byId = new Map(impacted.map((entry) => [String((entry.node as JsonObject).id), entry]));
    assert.equal(byId.get(derived)!.depth, 1);
    assert.equal(byId.get(derived)!.confidence_factor, 1);
    assert.equal(byId.get(grandchild)!.depth, 2);
    assert.equal(byId.get(grandchild)!.confidence_factor, 0.8);
    assert.equal(byId.get(grandchild)!.relation_confidence, "bounded");
    assert.equal(impacted.every((entry) => entry.needs_reevaluation === true), true);
    assert.equal(impact.needs_reevaluation, true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("an unchallenged root still enumerates lineage but does not claim invalidation", async () => {
  const f = await fixture();
  try {
    const foundation = await claim(f.service, "c-base", "Base premise.");
    const derived = await claim(f.service, "c-derived", "Derived premise.");
    f.service.relationSave({ source: node(derived), target: node(foundation), relation: "derives_from", confidence: "unverified" });
    const impact = knowledgeLineageImpact(f.store, { node: node(foundation) });
    assert.equal(impact.root_challenged, false);
    assert.equal((impact.impacted as unknown as JsonObject[]).length, 1);
    assert.equal((impact.impacted as unknown as JsonObject[])[0]!.confidence_factor, 0.5);
    assert.equal(impact.needs_reevaluation, false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a derives_from edge pointing at the root's own foundation is not followed", async () => {
  const f = await fixture();
  try {
    // root derives_from upstream: the impact of refuting root must NOT walk back
    // to upstream (that is root's premise, not something derived from root).
    const upstream = await claim(f.service, "c-upstream", "Older premise.");
    const root = await claim(f.service, "c-root", "Middle premise.");
    const challenger = await claim(f.service, "c-challenger", "Refutation.");
    f.service.relationSave({ source: node(root), target: node(upstream), relation: "derives_from" });
    f.service.relationSave({ source: node(challenger), target: node(root), relation: "supersedes" });
    const impact = knowledgeLineageImpact(f.store, { node: node(root) });
    assert.equal(impact.root_challenged, true);
    assert.equal((impact.impacted as unknown as JsonObject[]).length, 0);
    assert.equal(impact.needs_reevaluation, false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a cycle in derives_from terminates without duplicating nodes", async () => {
  const f = await fixture();
  try {
    const a = await claim(f.service, "c-a", "A.");
    const b = await claim(f.service, "c-b", "B.");
    const challenger = await claim(f.service, "c-x", "X.");
    f.service.relationSave({ source: node(a), target: node(b), relation: "derives_from" });
    f.service.relationSave({ source: node(b), target: node(a), relation: "derives_from" });
    f.service.relationSave({ source: node(challenger), target: node(a), relation: "contradicts" });
    const impact = knowledgeLineageImpact(f.store, { node: node(a) });
    const impacted = impact.impacted as unknown as JsonObject[];
    assert.equal(impacted.length, 1);
    assert.equal(String((impacted[0]!.node as JsonObject).id), b);
    assert.equal(impact.truncated, false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("retracted challenge edges do not trigger re-evaluation", async () => {
  const f = await fixture();
  try {
    const foundation = await claim(f.service, "c-base", "Base.");
    const derived = await claim(f.service, "c-derived", "Derived.");
    const challenger = await claim(f.service, "c-x", "X.");
    f.service.relationSave({ source: node(derived), target: node(foundation), relation: "derives_from" });
    const challenge = f.service.relationSave({ relation_id: "r-challenge", source: node(challenger), target: node(foundation), relation: "contradicts" }) as JsonObject;
    f.service.relationRetract({ relation_id: String((challenge.relation as JsonObject).id), reason: "withdrawn", valid_to: "2030-01-01T00:00:00.000Z" });
    const impact = knowledgeLineageImpact(f.store, { node: node(foundation), as_of: "2031-01-01T00:00:00.000Z" });
    assert.equal(impact.root_challenged, false);
    assert.equal(impact.needs_reevaluation, false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("malformed node input is rejected before any graph read", async () => {
  const f = await fixture();
  try {
    assert.throws(() => knowledgeLineageImpact(f.store, { node: "not-an-object" }), /node must be an object/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("kind/id shorthand and version-pinned endpoints are accepted", async () => {
  const f = await fixture();
  try {
    const foundation = await claim(f.service, "c-base", "Base.");
    const derived = await claim(f.service, "c-derived", "Derived.");
    f.service.relationSave({ source: { kind: "knowledge_claim", id: derived, version: 1 }, target: { kind: "knowledge_claim", id: foundation, version: 1 }, relation: "derives_from" });
    const impact = knowledgeLineageImpact(f.store, { kind: "knowledge_claim", id: foundation, version: 1 });
    assert.equal((impact.root as JsonObject).version, 1);
    assert.equal((impact.impacted as unknown as JsonObject[]).length, 1);
    assert.equal((impact.impacted as unknown as JsonObject[])[0]!.depth, 1);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a bounded node budget truncates the walk instead of expanding without limit", async () => {
  const f = await fixture();
  try {
    const foundation = await claim(f.service, "c-base", "Base.");
    const first = await claim(f.service, "c-1", "One.");
    const second = await claim(f.service, "c-2", "Two.");
    const challenger = await claim(f.service, "c-x", "X.");
    f.service.relationSave({ source: node(first), target: node(foundation), relation: "derives_from" });
    f.service.relationSave({ source: node(second), target: node(foundation), relation: "derives_from" });
    f.service.relationSave({ source: node(challenger), target: node(foundation), relation: "supersedes" });
    const impact = knowledgeLineageImpact(f.store, { node: node(foundation), max_nodes: 1 });
    assert.equal(impact.truncated, true);
    assert.equal((impact.impacted as unknown as JsonObject[]).length, 1);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a relation without a confidence value degrades as unverified", async () => {
  const f = await fixture();
  try {
    const foundation = await claim(f.service, "c-base", "Base.");
    const derived = await claim(f.service, "c-derived", "Derived.");
    const relation = f.service.relationSave({ source: node(derived), target: node(foundation), relation: "derives_from" }) as JsonObject;
    // Simulate a legacy edge with no confidence stored; the kernel must fail
    // closed to the lowest trust rather than inventing a high one.
    const row = f.store.get("knowledge_relation", String((relation.relation as JsonObject).id));
    f.store.save("knowledge_relation", String(row.id), { ...row, confidence: null });
    const impact = knowledgeLineageImpact(f.store, { node: node(foundation) });
    const impacted = impact.impacted as unknown as JsonObject[];
    assert.equal(impacted[0]!.confidence_factor, 0.5);
    assert.equal(impacted[0]!.relation_confidence, "unverified");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
