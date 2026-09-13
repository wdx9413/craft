import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chunkMarkdown, diffKnowledgeBase, KnowledgeIndex, knowledgeQueryTokens, locateSnippet, scanKnowledgeBase } from "../src/knowledge-index.ts";

test("scanKnowledgeBase discovers markdown and computes digests", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-kn-"));
  try {
    await writeFile(join(root, "a.md"), "# Hello\nworld");
    await writeFile(join(root, "b.md"), "deepseek");
    await writeFile(join(root, "ignored.txt"), "skip");
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "nested.md"), "nested content");
    const docs = scanKnowledgeBase(root);
    assert.equal(docs.length, 3);
    assert.ok(docs.every((d) => d.digest.length > 0 && d.size_bytes > 0));
    assert.throws(() => scanKnowledgeBase(join(root, "missing")), /does not exist/);
    assert.throws(() => scanKnowledgeBase(root, { limit: 0 }), /positive integer/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("chunkMarkdown splits on headings and caps size", () => {
  const chunks = chunkMarkdown("# A\nbody1\n# B\nbody2");
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].heading, "A");
  assert.equal(chunks[1].heading, "B");
  const big = "x".repeat(10_000);
  const capped = chunkMarkdown(`# H\n${big}`, { maxChars: 3000 });
  assert.ok(capped.length > 1);
  assert.ok(capped.every((c) => c.body.length <= 3000));
  assert.throws(() => chunkMarkdown("x", { maxChars: 0 }), /positive integer/);
});

test("diffKnowledgeBase detects added, changed, removed", () => {
  const prev = [{ path: "a.md", digest: "d1", size_bytes: 1, chunks: 1 }, { path: "b.md", digest: "d2", size_bytes: 1, chunks: 1 }];
  const next = [{ path: "a.md", digest: "d1", size_bytes: 1, chunks: 1 }, { path: "b.md", digest: "d3", size_bytes: 1, chunks: 1 }, { path: "c.md", digest: "d4", size_bytes: 1, chunks: 1 }];
  const plan = diffKnowledgeBase(prev, next);
  assert.equal(plan.added.length, 1);
  assert.equal(plan.changed.length, 1);
  assert.equal(plan.removed.length, 0);
});

test("knowledgeQueryTokens extracts safe tokens", () => {
  assert.deepEqual(knowledgeQueryTokens("hello 世界"), ["hello", "世界"]);
  assert.throws(() => knowledgeQueryTokens("!!!"), /at least one word/);
  assert.throws(() => knowledgeQueryTokens(""), /must not be empty/);
});

test("KnowledgeIndex round-trip sync and search", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-kn-idx-"));
  const idxPath = join(root, "index.db");
  try {
    await writeFile(join(root, "doc.md"), "# Craft\n确定性工作流承接各行各业的任务");
    await writeFile(join(root, "notes.txt"), "ignored");
    const index = new KnowledgeIndex(idxPath);
    const current = scanKnowledgeBase(root);
    const result = index.apply(diffKnowledgeBase([], current), root);
    assert.equal(result.documents, 1);
    assert.ok(result.chunks >= 1);
    const catalog = index.catalog();
    assert.equal(catalog.length, 1);
    // Trigram search for CJK
    const hits = index.search("工作流");
    assert.ok(hits.length >= 1);
    assert.ok(hits[0].snippet.includes("工作流"));
    // Short token fallback to LIKE (single CJK char triggers LIKE path)
    const short = index.search("工");
    assert.ok(short.length >= 1);
    assert.throws(() => index.search("", { limit: 1 }), /must not be empty/);
    assert.throws(() => index.search("x", { limit: 0 }), /between 1 and 100/);
    // changed document path
    await writeFile(join(root, "doc.md"), "# Craft\nmodified content");
    const changed = scanKnowledgeBase(root);
    const changedResult = index.apply(diffKnowledgeBase(current, changed), root);
    assert.equal(changedResult.documents, 1);
    index.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("locateSnippet match and no-match branches", () => {
  // no-match: returns head slice
  const noMatch = locateSnippet("hello world", ["xyz"]);
  assert.equal(noMatch, "hello world".slice(0, 200));
  // match: returns centered snippet
  const match = locateSnippet("hello world", ["world"]);
  assert.ok(match.includes("world"));
});
