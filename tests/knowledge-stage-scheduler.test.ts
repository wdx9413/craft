import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nextKnowledgeLearningStage, nextLearningPassOrder } from "../deploy/experience-learning/knowledge-stage-scheduler.ts";

test("Knowledge Host-call stages advance fairly and resume after process restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-learning-stage-"));
  try {
    const path = join(root, "knowledge", "cursor.json");
    assert.equal(await nextKnowledgeLearningStage(path), "classification");
    assert.equal(await nextKnowledgeLearningStage(path), "session_candidate");
    assert.equal(await nextKnowledgeLearningStage(path), "session_evaluation");
    assert.equal(await nextKnowledgeLearningStage(path), "session_adjudication");
    assert.equal(await nextKnowledgeLearningStage(path), "classification");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Knowledge scheduler rejects corrupt state and symbolic-link paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-learning-stage-invalid-"));
  try {
    const corrupt = join(root, "corrupt.json"); await writeFile(corrupt, "{}");
    await assert.rejects(nextKnowledgeLearningStage(corrupt), /state is invalid/u);
    const target = join(root, "target"); await mkdir(target); const linkedDir = join(root, "linked"); await symlink(target, linkedDir);
    await assert.rejects(nextKnowledgeLearningStage(join(linkedDir, "cursor.json")), /directory is invalid/u);
    const targetFile = join(root, "target.json"); await writeFile(targetFile, JSON.stringify({ schema: "craft.knowledge-learning-stage-cursor.v1", cursor: 0 }));
    const linkedFile = join(root, "linked-file.json"); await symlink(targetFile, linkedFile);
    await assert.rejects(nextKnowledgeLearningStage(linkedFile), /file is invalid/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Knowledge scheduler rejects malformed stages, non-directory parents, and non-file or oversized cursors", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-learning-stage-bounds-"));
  try {
    const path = join(root, "runtime", "cursor.json");
    await assert.rejects(nextKnowledgeLearningStage(path, []), /non-empty unique/u);
    await assert.rejects(nextKnowledgeLearningStage(path, ["classification", "classification"]), /non-empty unique/u);
    await assert.rejects(nextKnowledgeLearningStage(path, ["unsupported" as never]), /non-empty unique/u);
    const parentFile = join(root, "parent-file"); await writeFile(parentFile, "file");
    await assert.rejects(nextKnowledgeLearningStage(join(parentFile, "cursor.json")), /directory is invalid/u);
    await assert.rejects(nextLearningPassOrder(join(parentFile, "cursor.json")), /directory is invalid/u);
    const cursorDirectory = join(root, "cursor-directory"); await mkdir(cursorDirectory);
    await assert.rejects(nextKnowledgeLearningStage(cursorDirectory), /file is invalid/u);
    await assert.rejects(nextLearningPassOrder(cursorDirectory), /file is invalid/u);
    const oversized = join(root, "oversized.json"); await writeFile(oversized, " ".repeat(4_097));
    await assert.rejects(nextKnowledgeLearningStage(oversized), /file is invalid/u);
    await assert.rejects(nextLearningPassOrder(oversized), /file is invalid/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Experience and Knowledge alternate access to the one-call Host budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-learning-pass-order-"));
  try {
    const path = join(root, "runtime", "pass-order.json");
    assert.equal(await nextLearningPassOrder(path), "experience_first");
    assert.equal(await nextLearningPassOrder(path), "knowledge_first");
    assert.equal(await nextLearningPassOrder(path), "experience_first");
    const invalid = join(root, "runtime", "invalid.json"); await writeFile(invalid, JSON.stringify({ schema: "craft.learning-pass-order.v1", next_order: "other" }));
    await assert.rejects(nextLearningPassOrder(invalid), /state is invalid/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
