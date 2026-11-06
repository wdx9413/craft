import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Catalog } from "../core/catalog.ts";
import { diffKnowledgeBase, KnowledgeIndex, scanKnowledgeBase } from "../core/knowledge-index.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";

/**
 * BM25 was added as an extra signal fused into the existing ranking, not as a
 * replacement. These tests pin the top-k on a fixed corpus with fixed queries so
 * the fusion cannot silently rewrite search order. If the expectations here
 * change, that is a deliberate ranking decision and must be reviewed.
 */

const CORPUS: Array<{ name: string; description: string; body: string }> = [
  { name: "incident-triage", description: "Triage a production incident",
    body: "Runbook for a production incident. Collect the trace, page the on-call, and post a status update." },
  { name: "billing-checkout", description: "Explain checkout failures",
    body: "Checkout failure triage. Inspect the payment intent and the billing ledger before retrying." },
  { name: "release-gate", description: "Decide whether a release may ship",
    body: "A release may ship only when every acceptance digest is present and the incident queue is empty." },
  { name: "digest-tool", description: "Compute an acceptance digest",
    body: "Compute the acceptance digest over a change set. TS-999 is the tracking ticket for this tool." },
];

async function fixture(): Promise<{ root: string; store: CraftStore; catalog: Catalog }> {
  const root = await mkdtemp(join(tmpdir(), "craft-search-regression-"));
  const library = join(root, "library");
  await mkdir(library, { recursive: true });
  for (const entry of CORPUS) {
    await mkdir(join(library, entry.name), { recursive: true });
    await writeFile(join(library, entry.name, "SKILL.md"),
      `---\nname: ${entry.name}\ndescription: ${entry.description}\n---\n${entry.body}`);
  }
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const catalog = new Catalog(store);
  await catalog.addSource(library);
  return { root, store, catalog };
}

test("lexical search ranks the obvious capability first for plain queries", async () => {
  const f = await fixture();
  try {
    assert.equal(f.catalog.search("production incident")[0].name, "incident-triage");
    assert.equal(f.catalog.search("checkout failures")[0].name, "billing-checkout");
    assert.equal(f.catalog.search("release ship")[0].name, "release-gate");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("hybrid search keeps the lexical winner when no embedding provider is configured", async () => {
  const f = await fixture();
  try {
    const hits = await f.catalog.searchHybrid("production incident");
    assert.equal(hits[0].name, "incident-triage");
    assert.equal(f.catalog.semanticStatus().mode, "disabled");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("BM25 rarity weighting surfaces an identifier-dense capability", async () => {
  const f = await fixture();
  try {
    const lexical = f.catalog.search("TS-999");
    assert.equal(lexical[0].name, "digest-tool");
    const hybrid = await f.catalog.searchHybrid("TS-999");
    assert.equal(hybrid[0].name, "digest-tool");
    assert.ok(hybrid.find((item) => item.name === "digest-tool"));
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("result shape is unchanged: hybrid hits carry the same summary fields as lexical hits", async () => {
  const f = await fixture();
  try {
    const [lexical] = f.catalog.search("production incident");
    const [hybrid] = await f.catalog.searchHybrid("production incident");
    const keys = (value: Record<string, unknown>) => Object.keys(value).filter((key) => key !== "score" && key !== "rank_score").sort();
    assert.deepEqual(keys(hybrid), keys(lexical));
    assert.equal(hybrid.name, lexical.name);
    assert.equal(hybrid.logical_capability_id, lexical.logical_capability_id);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("knowledge index prefers the chunk with the rare token over a common-word chunk", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-kn-bm25-"));
  try {
    await writeFile(join(root, "common.md"), "# Notes\n\nbilling billing billing notes about billing");
    await writeFile(join(root, "rare.md"), "# Billing rules\n\nbilling must cite ticket TS-999 before it closes");
    const index = new KnowledgeIndex(join(root, "index.db"));
    index.apply(diffKnowledgeBase([], scanKnowledgeBase(root)), root);
    const hits = index.search("billing TS-999");
    assert.equal(hits[0].path, "rare.md");
    assert.ok(hits[0].snippet.includes("TS-999"));
    index.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("knowledge index still returns candidates in file order when BM25 scores nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-kn-fallback-"));
  try {
    await writeFile(join(root, "a.md"), "# A\n\nzzz alpha common");
    await writeFile(join(root, "b.md"), "# B\n\nzzz beta common");
    const index = new KnowledgeIndex(join(root, "index.db"));
    index.apply(diffKnowledgeBase([], scanKnowledgeBase(root)), root);
    const hits = index.search("common");
    assert.deepEqual(hits.map((hit) => hit.path), ["a.md", "b.md"]);
    assert.deepEqual(hits.map((hit) => hit.rank), [0, 1]);
    index.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
