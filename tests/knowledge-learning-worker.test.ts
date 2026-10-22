import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { runKnowledgeSyncOnce, type KnowledgeLearningClient } from "../deploy/experience-learning/knowledge-sync.ts";

const source = (id: string, patch: JsonObject = {}): JsonObject => ({ id, status: "active", access: "read_only", trust: "verified", ...patch });
const sourceRef = (id: string): string => `sha256:${createHash("sha256").update(id).digest("hex")}`;

test("Knowledge sync preserves stable failure codes without storing private error messages", async () => {
  const root = tempDir();
  try {
    const result = await runKnowledgeSyncOnce({ async call(name) {
      if (name === "craft_knowledge_source_list") return { sources: [source("a")] };
      throw Object.assign(new Error("private source details"), { code: "ERR_MCP_INVALID_INPUT" });
    } }, { state_file: join(root, "state.json") });
    assert.equal((result.outcomes as JsonObject[])[0]!.failure_code, "ERR_MCP_INVALID_INPUT");
    assert.equal(JSON.stringify(result).includes("private source details"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function tempDir(): string { return mkdtempSync(join(tmpdir(), "craft-knowledge-worker-")); }

test("Knowledge worker paginates bounded verified sources and rotates from central cursor state", async () => {
  const root = tempDir(), stateFile = join(root, "knowledge", "learning-worker-state.json"), calls: Array<{ name: string; args: JsonObject }> = [];
  try {
    const client: KnowledgeLearningClient = { async call(name, args = {}) {
      calls.push({ name, args });
      if (name === "craft_knowledge_source_list") return { sources: [source("b"), source("a"), source("bounded", { trust: "bounded" }), source("untrusted", { trust: "untrusted" }), source("write", { access: "proposal_only" }), source("inactive", { status: "revoked" }), { status: "active", access: "read_only", trust: "verified" }] };
      if (name === "craft_knowledge_source_ingest" && args.source_id === "a" && args.cursor === undefined) return { status: "partial", has_more: true, next_cursor: "page-2", processed_files: 2, candidates: [{ id: "candidate-1" }], automatic_review: { summary: { promoted: 1 } } };
      if (name === "craft_knowledge_source_ingest" && args.source_id === "a" && args.cursor === "page-2") return { status: "completed", has_more: false, processed_files: 1, candidates: [], automatic_review: { summary: { promoted: 0 } } };
      if (name === "craft_knowledge_source_ingest" && args.source_id === "b") return { status: "unavailable", reason: "source_not_ready", has_more: false, automatic_review: { summary: { promoted: "unknown" } } };
      if (name === "craft_knowledge_source_ingest" && args.source_id === "bounded") return { status: "completed", has_more: false, candidates: [{ id: "bounded-candidate" }], automatic_review: { summary: { promoted: 0 } } };
      throw new Error(`unexpected tool ${name}`);
    } };
    const first = await runKnowledgeSyncOnce(client, { state_file: stateFile, max_sources: 1, max_files_per_page: 2 });
    assert.deepEqual(first, { sources_seen: 3, sources_selected: 1, outcomes: [{ source_ref: sourceRef("a"), status: "completed", reason: null, pages: 2, processed_files: 3, candidates: 1, promoted: 1, has_more: false }], skipped_sources: 4 });
    assert.equal(calls.filter(call => call.name === "craft_knowledge_source_ingest").length, 2);
    assert.equal(calls.find(call => call.name === "craft_knowledge_source_ingest" && call.args.cursor !== undefined)?.args.cursor, "page-2");
    assert.equal(calls.every(call => call.name !== "craft_knowledge_source_ingest" || call.args.max_files === 2), true);
    const second = await runKnowledgeSyncOnce(client, { state_file: stateFile, max_sources: 1 });
    assert.equal((second.outcomes as JsonObject[])[0]?.source_ref, sourceRef("b"));
    const third = await runKnowledgeSyncOnce(client, { state_file: stateFile, max_sources: 1 });
    assert.deepEqual(third.outcomes, [{ source_ref: sourceRef("bounded"), status: "completed", reason: null, pages: 1, processed_files: 0, candidates: 1, promoted: 0, has_more: false }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Knowledge worker logs a source failure without blocking the next source", async () => {
  const root = tempDir(), stateFile = join(root, "worker-state.json"), calls: string[] = [];
  try {
    const client: KnowledgeLearningClient = { async call(name, args = {}) {
      if (name === "craft_knowledge_source_list") return { sources: [source("a"), source("b")] };
      calls.push(String(args.source_id));
      if (args.source_id === "a") throw new TypeError("must not expose local source path");
      return { has_more: false };
    } };
    const first = await runKnowledgeSyncOnce(client, { state_file: stateFile, max_sources: 2 });
    assert.deepEqual(first.outcomes, [
      { source_ref: sourceRef("a"), status: "failed", failure_kind: "TypeError", failure_code: "INVALID_INPUT" },
      { source_ref: sourceRef("b"), status: "unknown", reason: null, pages: 1, processed_files: 0, candidates: 0, promoted: 0, has_more: false },
    ]);
    assert.equal(JSON.stringify(first).includes("local source path"), false);
    assert.deepEqual(calls, ["a", "b"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Knowledge worker bounds page loops and reports an incomplete source without losing its fair rotation", async () => {
  const root = tempDir(), stateFile = join(root, "worker-state.json"), seen: string[] = [];
  try {
    const client: KnowledgeLearningClient = { async call(name, args = {}) {
      if (name === "craft_knowledge_source_list") return { sources: [source("a"), source("b")] };
      seen.push(String(args.cursor ?? "first"));
      return { status: "partial", has_more: true, next_cursor: `cursor-${seen.length}`, processed_files: 1, candidates: [] };
    } };
    const first = await runKnowledgeSyncOnce(client, { state_file: stateFile, max_sources: 1, max_pages_per_source: 2 });
    assert.deepEqual(first.outcomes, [{ source_ref: sourceRef("a"), status: "partial", reason: null, pages: 2, processed_files: 2, candidates: 0, promoted: 0, has_more: true }]);
    const second = await runKnowledgeSyncOnce(client, { state_file: stateFile, max_sources: 1, max_pages_per_source: 2 });
    assert.equal((second.outcomes as JsonObject[])[0]?.source_ref, sourceRef("b"));
    const third = await runKnowledgeSyncOnce(client, { state_file: stateFile, max_sources: 1, max_pages_per_source: 2 });
    assert.equal((third.outcomes as JsonObject[])[0]?.source_ref, sourceRef("a"));
    const fourth = await runKnowledgeSyncOnce(client, { state_file: stateFile, max_sources: 1, max_pages_per_source: 2 });
    assert.equal((fourth.outcomes as JsonObject[])[0]?.source_ref, sourceRef("b"));
    assert.deepEqual(seen, ["first", "cursor-1", "first", "cursor-3", "cursor-2", "cursor-5", "cursor-4", "cursor-7"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Knowledge worker restarts a stale saved cursor from page one and clears it after completion", async () => {
  const root = tempDir(), stateFile = join(root, "worker-state.json"), seen: Array<string | null> = [];
  writeFileSync(stateFile, JSON.stringify({ schema: "craft.knowledge-learning-worker-state.v2", last_source_ref: sourceRef("changed"), source_cursors: { [sourceRef("changed")]: "stale-cursor" } }));
  try {
    const client: KnowledgeLearningClient = { async call(name, args = {}) {
      if (name === "craft_knowledge_source_list") return { sources: [source("changed")] };
      const cursor = typeof args.cursor === "string" ? args.cursor : null;
      seen.push(cursor);
      if (cursor) throw new Error("Knowledge cursor is stale or invalid; restart ingestion");
      return { status: "completed", has_more: false, processed_files: 1, candidates: [] };
    } };
    const result = await runKnowledgeSyncOnce(client, { state_file: stateFile, max_sources: 1 });
    assert.equal((result.outcomes as JsonObject[])[0]?.status, "completed");
    assert.deepEqual(seen, ["stale-cursor", null]);
    assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")).source_cursors, {});
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Knowledge worker fails closed on malformed cursors, source lists and state files", async () => {
  const root = tempDir(), stateFile = join(root, "worker-state.json");
  try {
    const malformedCursor: KnowledgeLearningClient = { async call(name) {
      if (name === "craft_knowledge_source_list") return { sources: [source("a")] };
      return { status: "partial", has_more: true, next_cursor: null };
    } };
    const result = await runKnowledgeSyncOnce(malformedCursor, { state_file: stateFile, max_pages_per_source: 1 });
    assert.deepEqual(result.outcomes, [{ source_ref: sourceRef("a"), status: "failed", failure_kind: "Error", failure_code: "INVALID_INPUT" }]);
    const invalidList: KnowledgeLearningClient = { async call() { return {}; } };
    await assert.rejects(runKnowledgeSyncOnce(invalidList, { state_file: join(root, "other.json") }), /sources array/u);
    writeFileSync(stateFile, JSON.stringify({ schema: "wrong", last_source_id: null }));
    await assert.rejects(runKnowledgeSyncOnce(invalidList, { state_file: stateFile }), /state is invalid/u);
    const oversizedCursors = Object.fromEntries(Array.from({ length: 1_001 }, (_, index) => [sourceRef(`source-${index}`), "cursor"]));
    const invalidCursors: unknown[] = [null, [], { invalid: "cursor" }, { [sourceRef("a")]: 42 }, { [sourceRef("a")]: "bad.cursor" }, oversizedCursors];
    for (const source_cursors of invalidCursors) {
      writeFileSync(stateFile, JSON.stringify({ schema: "craft.knowledge-learning-worker-state.v2", last_source_ref: null, source_cursors }));
      await assert.rejects(runKnowledgeSyncOnce(invalidList, { state_file: stateFile }), /source cursors are invalid/u);
    }
    rmSync(stateFile);
    mkdirSync(stateFile);
    await assert.rejects(runKnowledgeSyncOnce(invalidList, { state_file: stateFile }), /regular file/u);
    rmSync(stateFile, { recursive: true, force: true });
    writeFileSync(stateFile, "not-json");
    await assert.rejects(runKnowledgeSyncOnce(invalidList, { state_file: stateFile }), SyntaxError);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Knowledge worker rejects linked state locations and invalid budgets", async () => {
  const root = tempDir();
  try {
    const actual = join(root, "actual.json"), linked = join(root, "linked.json");
    writeFileSync(actual, JSON.stringify({ schema: "craft.knowledge-learning-worker-state.v1", last_source_ref: null }));
    symlinkSync(actual, linked);
    const empty: KnowledgeLearningClient = { async call() { return { sources: [] }; } };
    await assert.rejects(runKnowledgeSyncOnce(empty, { state_file: linked }), /regular file/u);
    for (const options of [{ max_sources: 0 }, { max_sources: 51 }, { max_files_per_page: 501 }, { max_pages_per_source: 21 }]) {
      await assert.rejects(runKnowledgeSyncOnce(empty, { ...options, state_file: join(root, "other", "state.json") }));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Knowledge worker defaults its state under the configured Craft data root", async () => {
  const root = tempDir(), previous = process.env.CRAFT_DATA_DIR;
  process.env.CRAFT_DATA_DIR = root;
  try {
    const client: KnowledgeLearningClient = { async call() { return { sources: [] }; } };
    assert.deepEqual(await runKnowledgeSyncOnce(client), { sources_seen: 0, sources_selected: 0, outcomes: [], skipped_sources: 0 });
  } finally {
    if (previous === undefined) delete process.env.CRAFT_DATA_DIR;
    else process.env.CRAFT_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Knowledge worker refuses symlinked state directories and contains non-Error failures", async () => {
  const root = tempDir(), actual = join(root, "actual"), linked = join(root, "linked");
  mkdirSync(actual);
  symlinkSync(actual, linked);
  try {
    const symlinkClient: KnowledgeLearningClient = { async call(name) {
      return name === "craft_knowledge_source_list" ? { sources: [source("a")] } : { status: "completed", has_more: false };
    } };
    await assert.rejects(runKnowledgeSyncOnce(symlinkClient, { state_file: join(linked, "worker-state.json") }), /directory must not be a symbolic link/u);
    const throwingClient: KnowledgeLearningClient = { async call(name) {
      if (name === "craft_knowledge_source_list") return { sources: [source("a")] };
      throw "opaque failure";
    } };
    const outcome = await runKnowledgeSyncOnce(throwingClient, { state_file: join(root, "state.json") });
    assert.deepEqual(outcome.outcomes, [{ source_ref: sourceRef("a"), status: "failed", failure_kind: "Error", failure_code: "OPERATION_FAILED" }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Knowledge worker leaves state untouched when there are no eligible sources", async () => {
  const root = tempDir(), stateFile = join(root, "worker-state.json");
  try {
    const client: KnowledgeLearningClient = { async call() { return { sources: [source("untrusted", { trust: "untrusted" })] }; } };
    assert.deepEqual(await runKnowledgeSyncOnce(client, { state_file: stateFile }), { sources_seen: 0, sources_selected: 0, outcomes: [], skipped_sources: 1 });
    await assert.rejects(runKnowledgeSyncOnce({ async call() { return {}; } }, { state_file: join(root, "absent", "worker-state.json") }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Knowledge worker resumes at the first source when its prior cursor source was revoked", async () => {
  const root = tempDir(), stateFile = join(root, "worker-state.json"), observed: string[] = [];
  writeFileSync(stateFile, JSON.stringify({ schema: "craft.knowledge-learning-worker-state.v1", last_source_ref: sourceRef("revoked") }));
  try {
    const client: KnowledgeLearningClient = { async call(name, args = {}) {
      if (name === "craft_knowledge_source_list") return { sources: [source("a"), source("b")] };
      observed.push(String(args.source_id));
      return { status: "completed", has_more: false };
    } };
    const result = await runKnowledgeSyncOnce(client, { state_file: stateFile, max_sources: 1 });
    assert.equal(((result.outcomes as JsonObject[])[0])?.source_ref, sourceRef("a"));
    assert.deepEqual(observed, ["a"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
