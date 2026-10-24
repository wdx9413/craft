import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { runKnowledgeStorageReconcileOnce } from "../deploy/experience-learning/knowledge-storage.ts";

const empty = { status: "completed", examined: 0, migrated: 0, skipped: 0, blocked: [], has_more: false, next_cursor: null };
const page = { status: "partial", examined: 1, migrated: 1, skipped: 0, blocked: [], has_more: true, next_cursor: "Y3Vyc29y" };

test("storage maintenance resumes persisted pages and does not manufacture model work or rewrite idle state", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-storage-worker-")), path = join(root, "knowledge", "state.json");
  try {
    const calls: JsonObject[] = [];
    await runKnowledgeStorageReconcileOnce({ async call(name, args = {}) { assert.equal(name, "craft_knowledge_storage_reconcile"); calls.push(args); return page; } }, path);
    await assert.rejects(runKnowledgeStorageReconcileOnce({ async call(_name, args) { calls.push(args!); throw new Error("transient failure"); } }, path), /transient/u);
    assert.equal(JSON.parse(await readFile(path, "utf8")).cursor, page.next_cursor);
    await runKnowledgeStorageReconcileOnce({ async call(_name, args) { calls.push(args!); return empty; } }, path);
    assert.equal(calls[1]?.cursor, page.next_cursor); assert.equal(calls[2]?.cursor, page.next_cursor);
    const before = await readFile(path, "utf8");
    await runKnowledgeStorageReconcileOnce({ async call() { return empty; } }, path);
    assert.equal(await readFile(path, "utf8"), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("storage maintenance rejects corrupt state and invalid server pages before advancing", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-storage-invalid-")), path = join(root, "state.json");
  try {
    let calls = 0;
    const client = { async call() { calls++; return empty; } };
    for (const value of ["not-json", "{}", JSON.stringify({ schema: "craft.knowledge-storage-cursor.v1", cursor: "bad cursor" })]) {
      await writeFile(path, value); await assert.rejects(runKnowledgeStorageReconcileOnce(client, path));
    }
    assert.equal(calls, 0); await rm(path);
    for (const value of [{}, { ...empty, has_more: true }, { ...page, next_cursor: "!" }, { ...empty, examined: -1 },
      { ...empty, examined: 501 }, { ...empty, migrated: 1 }, { ...empty, skipped: -1 }, { ...empty, blocked: [{}] },
      { ...empty, status: "private server response" }, { ...empty, dry_run: true }, { ...empty, next_cursor: "unexpected" },
      { ...empty, phase: "unsupported" }, { ...empty, retired_content: -1 }, { ...empty, retired_content: 1 }, { ...empty, retired_content: 1.5 }]) {
      await assert.rejects(runKnowledgeStorageReconcileOnce({ async call() { return value; } }, path), /invalid page/u);
    }
    await assert.rejects(readFile(path), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    const linked = join(root, "linked"), real = join(root, "real"); await mkdir(real); await symlink(real, linked);
    await assert.rejects(runKnowledgeStorageReconcileOnce(client, join(linked, "state.json")), /directory must be regular/u);
    await writeFile(path, JSON.stringify({ schema: "craft.knowledge-storage-cursor.v1", cursor: page.next_cursor }));
    await assert.rejects(runKnowledgeStorageReconcileOnce({ async call() { return page; } }, path), /invalid page/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("storage maintenance preserves content retirement counters and rejects state filesystem races", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-storage-files-")), path = join(root, "state.json");
  try {
    const content = { ...empty, examined: 1, phase: "content", retired_content: 1 };
    const summary = await runKnowledgeStorageReconcileOnce({ async call() { return content; } }, path);
    assert.equal(summary.phase, "content"); assert.equal(summary.retired_content, 1);
    await mkdir(path);
    await assert.rejects(runKnowledgeStorageReconcileOnce({ async call() { return empty; } }, path), /state file is invalid/u);
    await rm(path, { recursive: true });
    await writeFile(path, "x".repeat(16_385));
    await assert.rejects(runKnowledgeStorageReconcileOnce({ async call() { return empty; } }, path), /state file is invalid/u);
    await rm(path); const regular = join(root, "regular"); await writeFile(regular, "{}"); await symlink(regular, path);
    await assert.rejects(runKnowledgeStorageReconcileOnce({ async call() { return empty; } }, path), /state file is invalid/u);
    await rm(path);
    const parent = join(root, "parent"); await mkdir(parent);
    await assert.rejects(runKnowledgeStorageReconcileOnce({ async call() {
      await rename(parent, parent + "-saved"); await symlink(parent + "-saved", parent); return page;
    } }, join(parent, "state.json")), /directory must be regular/u);
    const removed = join(root, "removed"); await mkdir(removed);
    await runKnowledgeStorageReconcileOnce({ async call() { await rm(removed, { recursive: true }); return { ...page, phase: "records" }; } }, join(removed, "state.json"));
    assert.equal(JSON.parse(await readFile(join(removed, "state.json"), "utf8")).cursor, page.next_cursor);
  } finally { await rm(root, { recursive: true, force: true }); }
});
