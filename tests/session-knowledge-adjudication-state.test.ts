import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearKnowledgeAdjudicationFailure, readKnowledgeAdjudicationCursor, readKnowledgeAdjudicationRetries,
  recordKnowledgeAdjudicationFailure, writeKnowledgeAdjudicationCursor } from "../deploy/experience-learning/session-knowledge-adjudication-state.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "craft-knowledge-adjudication-cursor-"));
  return { root, path: join(root, "knowledge", "cursor.json"), close: () => rmSync(root, { recursive: true, force: true }) };
}

test("adjudication page cursor persists and can reset after the final page", async () => {
  const f = fixture();
  try {
    assert.equal(readKnowledgeAdjudicationCursor(f.path), null);
    mkdirSync(join(f.root, "knowledge"), { recursive: true });
    writeFileSync(f.path, JSON.stringify({ schema: "craft.knowledge-session-adjudication-cursor.v2", after_id: null }));
    assert.deepEqual(readKnowledgeAdjudicationRetries(f.path), {});
    await writeKnowledgeAdjudicationCursor(f.path, "case-b");
    assert.equal(readKnowledgeAdjudicationCursor(f.path), "case-b");
    await writeKnowledgeAdjudicationCursor(f.path, null);
    assert.equal(readKnowledgeAdjudicationCursor(f.path), null);
  } finally { f.close(); }
});

test("adjudication cursor rejects malformed IDs and corrupted state", async () => {
  const f = fixture();
  try {
    await assert.rejects(writeKnowledgeAdjudicationCursor(f.path, "!"), /cursor is invalid/u);
    mkdirSync(join(f.root, "knowledge"), { recursive: true });
    for (const json of ["null", "[]", "\"text\""]) {
      writeFileSync(f.path, json);
      assert.throws(() => readKnowledgeAdjudicationCursor(f.path), /cursor is invalid/u);
    }
    writeFileSync(f.path, JSON.stringify({ schema: "wrong", last_case_id: null }));
    assert.throws(() => readKnowledgeAdjudicationCursor(f.path), /cursor is invalid/u);
    writeFileSync(f.path, "{");
    assert.throws(() => readKnowledgeAdjudicationCursor(f.path));
    writeFileSync(f.path, JSON.stringify({ schema: "craft.knowledge-session-adjudication-cursor.v2", after_id: "!" }));
    assert.throws(() => readKnowledgeAdjudicationCursor(f.path), /cursor is invalid/u);
    for (const retries of [null, [], { "!": {} }, { "case-a": null }, { "case-a": { attempts: 0, last_failure_at: "bad", next_attempt_at: "bad", failure_kind: "!" } },
      { "case-a": { attempts: 1, last_failure_at: "2026-10-23T00:00:00.000Z", next_attempt_at: "2026-10-23T00:00:30.000Z", failure_kind: "Error", failure_code: "unsafe code" } }]) {
      writeFileSync(f.path, JSON.stringify({ schema: "craft.knowledge-session-adjudication-cursor.v2", after_id: null, retries }));
      assert.throws(() => readKnowledgeAdjudicationRetries(f.path), /retry state is invalid/u);
    }
  } finally { f.close(); }
});

test("adjudication cursor rejects unsafe files and directories", async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, "knowledge"), { recursive: true });
    const directoryPath = join(f.root, "knowledge", "directory");
    mkdirSync(directoryPath);
    assert.throws(() => readKnowledgeAdjudicationCursor(directoryPath), /file is invalid/u);
    const targetPath = join(f.root, "target.json");
    writeFileSync(targetPath, JSON.stringify({ schema: "craft.knowledge-session-adjudication-cursor.v1", last_case_id: null }));
    const symlinkPath = join(f.root, "knowledge", "symlink.json");
    symlinkSync(targetPath, symlinkPath);
    assert.throws(() => readKnowledgeAdjudicationCursor(symlinkPath), /file is invalid/u);
    writeFileSync(f.path, "x".repeat(4_194_305));
    assert.throws(() => readKnowledgeAdjudicationCursor(f.path), /file is invalid/u);
    const linkDir = join(f.root, "linked-directory");
    symlinkSync(join(f.root, "knowledge"), linkDir);
    const linkedPath = join(linkDir, "cursor.json");
    await assert.rejects(writeKnowledgeAdjudicationCursor(linkedPath, "case-a"), /directory is invalid/u);
    assert.throws(() => readKnowledgeAdjudicationCursor(linkedPath), /directory is invalid/u);
  } finally { f.close(); }
});

test("adjudication failures use bounded exponential backoff and clear after recovery", async () => {
  const f = fixture();
  try {
    const first = await recordKnowledgeAdjudicationFailure(f.path, "case-a", "TypeError", "2026-10-23T00:00:00.000Z");
    assert.deepEqual(first, { attempts: 1, last_failure_at: "2026-10-23T00:00:00.000Z", next_attempt_at: "2026-10-23T00:00:30.000Z", failure_kind: "TypeError" });
    const second = await recordKnowledgeAdjudicationFailure(f.path, "case-a", "TypeError", "2026-10-23T00:01:00.000Z");
    assert.equal(second.attempts, 2);
    assert.equal(second.next_attempt_at, "2026-10-23T00:02:00.000Z");
    assert.deepEqual(readKnowledgeAdjudicationRetries(f.path), { "case-a": second });
    const coded = await recordKnowledgeAdjudicationFailure(f.path, "case-b", "Error", "2026-10-23T00:02:00.000Z", "ERR_MCP_INTERNAL_ERROR");
    assert.equal(coded.failure_code, "ERR_MCP_INTERNAL_ERROR");
    await assert.rejects(recordKnowledgeAdjudicationFailure(f.path, "case-c", "Error", "2026-10-23T00:02:00.000Z", "unsafe code"), /failure code/u);
    await clearKnowledgeAdjudicationFailure(f.path, "case-a");
    assert.deepEqual(readKnowledgeAdjudicationRetries(f.path), { "case-b": coded });
    await clearKnowledgeAdjudicationFailure(f.path, "case-b");
    assert.deepEqual(readKnowledgeAdjudicationRetries(f.path), {});
    assert.equal(readKnowledgeAdjudicationCursor(f.path), null);
    await clearKnowledgeAdjudicationFailure(f.path, "case-a");
    await assert.rejects(recordKnowledgeAdjudicationFailure(f.path, "!", "TypeError", "2026-10-23T00:00:00.000Z"), /retry input/u);
    await assert.rejects(recordKnowledgeAdjudicationFailure(f.path, "case-a", "Bad Error Name", "2026-10-23T00:00:00.000Z"), /retry input/u);
    await assert.rejects(recordKnowledgeAdjudicationFailure(f.path, "case-a", "TypeError", "not-a-date"), /retry time/u);
    const fullRetries = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`case-${index}`, {
      attempts: 1, last_failure_at: "2026-10-23T00:00:00.000Z", next_attempt_at: "2026-10-23T00:00:30.000Z", failure_kind: "Error",
    }]));
    writeFileSync(f.path, JSON.stringify({ schema: "craft.knowledge-session-adjudication-cursor.v2", after_id: null, retries: fullRetries }));
    await assert.rejects(recordKnowledgeAdjudicationFailure(f.path, "case-new", "Error", "2026-10-23T00:00:00.000Z"), /capacity reached/u);
  } finally { f.close(); }
});
