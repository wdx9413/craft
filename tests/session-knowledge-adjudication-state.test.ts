import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearKnowledgeAdjudicationFailure, readKnowledgeAdjudicationCursor, readKnowledgeAdjudicationRetries,
  recordKnowledgeAdjudicationFailure, writeKnowledgeAdjudicationCursor } from "../deploy/experience-learning/session-knowledge-adjudication-state.ts";
import { readLegacyLearningState, registerVolatileLearningState, writeVolatileLearningState } from "../core/codex-session-archive.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { LocalSupervisor } from "../core/supervisor.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "craft-knowledge-adjudication-cursor-"));
  const paths = craftPaths(root);
  const store = await new CraftStore(paths).open();
  const supervisor = new LocalSupervisor(new CraftService(store), paths);
  await supervisor.start();
  const path = join(root, "knowledge", "cursor.json");
  registerVolatileLearningState(path, { CRAFT_DATA_DIR: root });
  return { root, path, close: async () => { await supervisor.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("adjudication page cursor lives in memory and resets after the final page", async () => {
  const f = await fixture();
  try {
    assert.equal(await readKnowledgeAdjudicationCursor(f.path), null);
    assert.deepEqual(await readKnowledgeAdjudicationRetries(f.path), {});
    await writeKnowledgeAdjudicationCursor(f.path, "case-b");
    assert.equal(await readKnowledgeAdjudicationCursor(f.path), "case-b");
    await writeKnowledgeAdjudicationCursor(f.path, null);
    assert.equal(await readKnowledgeAdjudicationCursor(f.path), null);
  } finally { await f.close(); }
});

test("legacy adjudication cursor and retry state migrate into memory without changing the file", async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.root, "knowledge"), { recursive: true });
    const retry = { attempts: 2, last_failure_at: "2026-10-23T00:00:00.000Z", next_attempt_at: "2026-10-23T00:01:00.000Z", failure_kind: "Error" };
    const legacy = JSON.stringify({ schema: "craft.knowledge-session-adjudication-cursor.v2", after_id: "case-a", retries: { "case-b": retry } });
    writeFileSync(f.path, legacy);
    assert.equal(await readKnowledgeAdjudicationCursor(f.path), "case-a");
    assert.deepEqual(await readKnowledgeAdjudicationRetries(f.path), { "case-b": retry });
    await writeKnowledgeAdjudicationCursor(f.path, "case-c");
    assert.equal(await readKnowledgeAdjudicationCursor(f.path), "case-c");
    assert.equal(readFileSync(f.path, "utf8"), legacy);
  } finally { await f.close(); }
});

test("adjudication rejects malformed in-memory state and retry entries", async () => {
  const f = await fixture();
  try {
    await assert.rejects(writeKnowledgeAdjudicationCursor(f.path, "!"), /cursor is invalid/u);
    for (const state of [{ schema: "wrong", after_id: null }, { schema: "craft.knowledge-session-adjudication-cursor.v2", after_id: "!" }]) {
      await writeVolatileLearningState(f.path, state);
      await assert.rejects(readKnowledgeAdjudicationCursor(f.path), /cursor is invalid/u);
    }
    for (const retries of [null, [], { "!": {} }, { "case-a": null },
      { "case-a": { attempts: 0, last_failure_at: "bad", next_attempt_at: "bad", failure_kind: "!" } },
      { "case-a": { attempts: 1, last_failure_at: "2026-10-23T00:00:00.000Z", next_attempt_at: "2026-10-23T00:00:30.000Z", failure_kind: "Error", failure_code: "unsafe code" } }]) {
      await writeVolatileLearningState(f.path, { schema: "craft.knowledge-session-adjudication-cursor.v2", after_id: null, retries } as JsonObject);
      await assert.rejects(readKnowledgeAdjudicationRetries(f.path), /retry state is invalid/u);
    }
  } finally { await f.close(); }
});

test("legacy learning state inspection is read-only and rejects invalid or unsafe files", async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.root, "knowledge"), { recursive: true });
    const valid = { schema: "craft.knowledge-session-adjudication-cursor.v2", after_id: null };
    writeFileSync(f.path, JSON.stringify(valid));
    assert.deepEqual(await readLegacyLearningState(f.path), valid);
    assert.equal(await readKnowledgeAdjudicationCursor(f.path), null);
    assert.deepEqual(await readKnowledgeAdjudicationRetries(f.path), {});
    for (const json of ["null", "[]", "\"text\"", "{"]) {
      writeFileSync(f.path, json);
      await assert.rejects(readLegacyLearningState(f.path));
    }
    const directory = join(f.root, "knowledge", "directory");
    mkdirSync(directory);
    await assert.rejects(readLegacyLearningState(directory), /file is invalid/u);
    writeFileSync(f.path, "x".repeat(8 * 1024 * 1024 + 1));
    await assert.rejects(readLegacyLearningState(f.path), /file is invalid/u);
    const link = join(f.root, "knowledge", "link");
    symlinkSync(f.path, link);
    await assert.rejects(readLegacyLearningState(link), /file is invalid/u);
  } finally { await f.close(); }
});

test("adjudication failures use bounded exponential backoff and clear after recovery", async () => {
  const f = await fixture();
  try {
    const first = await recordKnowledgeAdjudicationFailure(f.path, "case-a", "TypeError", "2026-10-23T00:00:00.000Z");
    assert.deepEqual(first, { attempts: 1, last_failure_at: "2026-10-23T00:00:00.000Z", next_attempt_at: "2026-10-23T00:00:30.000Z", failure_kind: "TypeError" });
    const second = await recordKnowledgeAdjudicationFailure(f.path, "case-a", "TypeError", "2026-10-23T00:01:00.000Z");
    assert.equal(second.attempts, 2);
    assert.equal(second.next_attempt_at, "2026-10-23T00:02:00.000Z");
    assert.deepEqual(await readKnowledgeAdjudicationRetries(f.path), { "case-a": second });
    const coded = await recordKnowledgeAdjudicationFailure(f.path, "case-b", "Error", "2026-10-23T00:02:00.000Z", "ERR_MCP_INTERNAL_ERROR");
    assert.equal(coded.failure_code, "ERR_MCP_INTERNAL_ERROR");
    await assert.rejects(recordKnowledgeAdjudicationFailure(f.path, "case-c", "Error", "2026-10-23T00:02:00.000Z", "unsafe code"), /failure code/u);
    await clearKnowledgeAdjudicationFailure(f.path, "case-a");
    assert.deepEqual(await readKnowledgeAdjudicationRetries(f.path), { "case-b": coded });
    await clearKnowledgeAdjudicationFailure(f.path, "case-b");
    assert.deepEqual(await readKnowledgeAdjudicationRetries(f.path), {});
    assert.equal(await readKnowledgeAdjudicationCursor(f.path), null);
    await clearKnowledgeAdjudicationFailure(f.path, "case-a");
    await assert.rejects(recordKnowledgeAdjudicationFailure(f.path, "!", "TypeError", "2026-10-23T00:00:00.000Z"), /retry input/u);
    await assert.rejects(recordKnowledgeAdjudicationFailure(f.path, "case-a", "Bad Error Name", "2026-10-23T00:00:00.000Z"), /retry input/u);
    await assert.rejects(recordKnowledgeAdjudicationFailure(f.path, "case-a", "TypeError", "not-a-date"), /retry time/u);
    const retries = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`case-${index}`, {
      attempts: 1, last_failure_at: "2026-10-23T00:00:00.000Z", next_attempt_at: "2026-10-23T00:00:30.000Z", failure_kind: "Error",
    }]));
    await writeVolatileLearningState(f.path, { schema: "craft.knowledge-session-adjudication-cursor.v2", after_id: null, retries });
    await assert.rejects(recordKnowledgeAdjudicationFailure(f.path, "case-new", "Error", "2026-10-23T00:00:00.000Z"), /capacity reached/u);
  } finally { await f.close(); }
});
