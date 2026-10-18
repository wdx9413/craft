import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deleteExperienceTaskGoal, readExperienceTaskGoal, storeExperienceTaskGoal, type ExperienceTaskGoalArgs } from "../core/experience-task-goals.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-experience-task-goal-"));
  const experienceDir = join(root, "experience");
  await mkdir(experienceDir, { recursive: true });
  const args: ExperienceTaskGoalArgs = { experience_dir: experienceDir, scope: "project:fixture", session_id: "session-one", turn_id: "turn-one",
    task_goal: "Classify a verified project change" };
  return { root, experienceDir, args };
}

test("Experience task goals are project scoped, idempotent, and deleted after use", async () => {
  const f = await fixture();
  try {
    assert.equal(readExperienceTaskGoal(f.args), null);
    deleteExperienceTaskGoal(f.args);
    storeExperienceTaskGoal(f.args);
    storeExperienceTaskGoal(f.args);
    assert.equal(readExperienceTaskGoal(f.args), f.args.task_goal);
    const pending = join(f.experienceDir, "scenario-classification", "pending");
    assert.equal((await readdir(pending)).length, 1);
    assert.doesNotMatch(await readFile(join(pending, (await readdir(pending))[0]!), "utf8"), /raw prompt/u);
    assert.throws(() => storeExperienceTaskGoal({ ...f.args, task_goal: "A different task goal" }), /idempotency conflict/u);
    deleteExperienceTaskGoal(f.args);
    deleteExperienceTaskGoal(f.args);
    assert.equal(readExperienceTaskGoal(f.args), null);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("Experience task goals reject invalid scope, identity, secret, and oversized summaries", async () => {
  const f = await fixture();
  try {
    for (const args of [
      { ...f.args, scope: "global" }, { ...f.args, session_id: " " }, { ...f.args, turn_id: " " },
      { ...f.args, task_goal: "token=abcdefghijk" }, { ...f.args, task_goal: "x".repeat(321) },
    ]) assert.throws(() => storeExperienceTaskGoal(args), /invalid|sanitized/u);
    assert.throws(() => readExperienceTaskGoal({ ...f.args, scope: "global" }), /identity is invalid/u);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("Experience task goal reads reject tampered, oversized, linked, and non-regular files", async () => {
  const f = await fixture();
  try {
    storeExperienceTaskGoal(f.args);
    const pending = join(f.experienceDir, "scenario-classification", "pending");
    const originalName = (await readdir(pending))[0]!;
    const path = join(pending, originalName);
    const original = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const corruptions: Array<Record<string, unknown>> = [
      { ...original, schema: "wrong" }, { ...original, scope: "project:other" }, { ...original, sanitized: false },
      { ...original, content_stored: true }, { ...original, task_goal: "short" }, { ...original, task_goal: "token=abcdefghijk" },
      { ...original, task_goal: "x".repeat(321) }, { ...original, task_identity_digest: "sha256:bad" }, { ...original, identity_digest: "sha256:bad" },
    ];
    for (const corruption of corruptions) {
      await writeFile(path, JSON.stringify(corruption));
      assert.throws(() => readExperienceTaskGoal(f.args), /invalid/u);
    }
    const otherTurn = { ...f.args, turn_id: "turn-two" };
    storeExperienceTaskGoal(otherTurn);
    const replayName = (await readdir(pending)).find(name => name !== originalName)!;
    const replayPath = join(pending, replayName);
    await writeFile(replayPath, JSON.stringify(original));
    assert.throws(() => readExperienceTaskGoal(otherTurn), /invalid/u);
    await writeFile(path, "[]");
    assert.throws(() => readExperienceTaskGoal(f.args), /invalid/u);
    await writeFile(path, "x".repeat(2_049));
    assert.throws(() => readExperienceTaskGoal(f.args), /oversized/u);
    await rm(path);
    await symlink(f.experienceDir, path);
    assert.throws(() => readExperienceTaskGoal(f.args), /linked/u);
    assert.throws(() => deleteExperienceTaskGoal(f.args), /regular file/u);
    await rm(path);
    await mkdir(path);
    assert.throws(() => readExperienceTaskGoal(f.args), /non-regular/u);
    assert.throws(() => deleteExperienceTaskGoal(f.args), /regular file/u);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("Experience task goal paths reject links and handle unavailable directories", async () => {
  const f = await fixture();
  try {
    const missing = { ...f.args, experience_dir: join(f.root, "missing") };
    assert.equal(readExperienceTaskGoal(missing), null);
    assert.throws(() => storeExperienceTaskGoal(missing), /directory is unavailable/u);
    const linkedRoot = join(f.root, "linked-root");
    await symlink(f.experienceDir, linkedRoot);
    assert.throws(() => readExperienceTaskGoal({ ...f.args, experience_dir: linkedRoot }), /regular directories/u);
    const queue = join(f.experienceDir, "scenario-classification");
    await writeFile(queue, "not a directory");
    assert.throws(() => storeExperienceTaskGoal(f.args), /regular directories/u);
    await rm(queue);
    await mkdir(queue);
    assert.equal(readExperienceTaskGoal(f.args), null);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
