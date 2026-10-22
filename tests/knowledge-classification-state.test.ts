import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recordKnowledgeClassificationFailure, shouldSuppressKnowledgeClassification, readKnowledgeClassificationCursor, recordKnowledgeClassificationCursor, type KnowledgeClassificationAttempt } from "../deploy/experience-learning/knowledge-classification-state.ts";

const digest = `sha256:${"a".repeat(64)}`;
const attempt: KnowledgeClassificationAttempt = { input_digest: digest, failure_stage: "response_parse", failure_code: "response_not_json", failed_at: "2026-10-18T00:00:00.000Z" };

test("classification attempt state persists safe digests and suppresses only exact matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-classification-state-")), path = join(root, "knowledge", "attempts.json");
  try {
    assert.equal(shouldSuppressKnowledgeClassification(path, "ticket-1", digest), false);
    await recordKnowledgeClassificationFailure(path, "ticket-1", attempt);
    assert.equal(shouldSuppressKnowledgeClassification(path, "ticket-1", digest), true);
    assert.equal(shouldSuppressKnowledgeClassification(path, "ticket-1", `sha256:${"b".repeat(64)}`), false);
    const persisted = await readFile(path, "utf8");
    assert.match(persisted, /craft\.knowledge-classification-attempts\.v1/u);
    assert.equal(persisted.includes("response body"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("classification attempt state rejects invalid paths, records, and identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-classification-state-"));
  try {
    const realDir = join(root, "real"), linkedDir = join(root, "linked"), path = join(root, "attempts.json");
    await mkdir(realDir);
    await symlink(realDir, linkedDir);
    assert.throws(() => shouldSuppressKnowledgeClassification(join(linkedDir, "attempts.json"), "ticket", digest), /symbolic link/u);
    await assert.rejects(recordKnowledgeClassificationFailure(join(linkedDir, "attempts.json"), "ticket", attempt), /symbolic link/u);
    await writeFile(path, "{}");
    await assert.rejects(Promise.resolve().then(() => shouldSuppressKnowledgeClassification(path, "ticket", digest)), /state is invalid/u);
    await assert.rejects(recordKnowledgeClassificationFailure(join(root, "fresh.json"), "bad ticket", attempt), /identity is invalid/u);
    await assert.rejects(recordKnowledgeClassificationFailure(join(root, "fresh.json"), "ticket", { ...attempt, failure_code: "Bad Code" }), /identity is invalid/u);
    assert.throws(() => shouldSuppressKnowledgeClassification(path, "ticket", "bad"), /identity is invalid/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("classification attempt state rejects symlink files and invalid attempt entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-classification-state-"));
  try {
    const validPath = join(root, "valid.json"), linkPath = join(root, "link.json"), malformedPath = join(root, "malformed.json");
    await recordKnowledgeClassificationFailure(validPath, "ticket-1", attempt);
    await symlink(validPath, linkPath);
    assert.throws(() => shouldSuppressKnowledgeClassification(linkPath, "ticket-1", digest), /regular file/u);
    await writeFile(malformedPath, JSON.stringify({ schema: "craft.knowledge-classification-attempts.v1", attempts: { "ticket-1": { ...attempt, input_digest: "invalid" } } }));
    assert.throws(() => shouldSuppressKnowledgeClassification(malformedPath, "ticket-1", digest), /state is invalid/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("classification attempt state keeps only the newest bounded entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-classification-state-")), path = join(root, "attempts.json");
  try {
    for (let index = 0; index < 505; index += 1) {
      await recordKnowledgeClassificationFailure(path, `ticket-${index}`, { ...attempt, failed_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString() });
    }
    const state = JSON.parse(await readFile(path, "utf8")) as { attempts: Record<string, unknown> };
    assert.equal(Object.keys(state.attempts).length, 500);
    assert.equal("ticket-0" in state.attempts, false);
    assert.equal("ticket-504" in state.attempts, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("classification cursor persists independently of failed inputs and rejects invalid identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-classification-cursor-")), path = join(root, "knowledge", "attempts.json");
  try {
    assert.equal(readKnowledgeClassificationCursor(path), undefined);
    await recordKnowledgeClassificationCursor(path, "claim-02");
    await recordKnowledgeClassificationFailure(path, "ticket-1", attempt);
    assert.equal(readKnowledgeClassificationCursor(path), "claim-02");
    await recordKnowledgeClassificationCursor(path, "claim-03");
    assert.equal(shouldSuppressKnowledgeClassification(path, "ticket-1", digest), true);
    await recordKnowledgeClassificationCursor(path, "claim-03");
    for (const id of ["", "bad claim", "x".repeat(201)]) await assert.rejects(recordKnowledgeClassificationCursor(path, id), /cursor identity/u);
    for (const last_claim_id of [null, 3, "", "bad claim"]) {
      await writeFile(path, JSON.stringify({ schema: "craft.knowledge-classification-attempts.v1", attempts: {}, last_claim_id }));
      assert.throws(() => readKnowledgeClassificationCursor(path), /state is invalid/u);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
