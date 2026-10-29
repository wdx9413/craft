import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { deleteExperienceTaskGoal, readExperienceTaskGoal, storeExperienceTaskGoal, type ExperienceTaskGoalArgs } from "../core/experience-task-goals.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-experience-task-goal-"));
  const experienceDir = join(root, "experience");
  await mkdir(experienceDir, { recursive: true });
  const args: ExperienceTaskGoalArgs = { experience_dir: experienceDir, scope: "project:fixture", session_host: "codex", session_id: "session-one", turn_id: "turn-one",
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

test("Experience goals with identical session and turn IDs are isolated by Host", async () => {
  const f = await fixture();
  try {
    const claude = { ...f.args, session_host: "claude" as const, task_goal: "Classify another verified change" };
    storeExperienceTaskGoal(f.args);
    storeExperienceTaskGoal(claude);
    assert.equal(readExperienceTaskGoal(f.args), f.args.task_goal);
    assert.equal(readExperienceTaskGoal(claude), claude.task_goal);
    deleteExperienceTaskGoal(f.args);
    assert.equal(readExperienceTaskGoal(claude), claude.task_goal);
    assert.equal((await readdir(join(f.experienceDir, "scenario-classification", "pending"))).length, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("concurrent processes can idempotently create the same Experience task goal", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const moduleUrl = pathToFileURL(join(process.cwd(), "core", "experience-task-goals.ts")).href;
    const code = `import { storeExperienceTaskGoal } from ${JSON.stringify(moduleUrl)}; storeExperienceTaskGoal(JSON.parse(process.env.CRAFT_TEST_GOAL));`;
    const attempts = Array.from({ length: 12 }, () => new Promise<void>((resolveExit, reject) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code],
        { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, CRAFT_TEST_GOAL: JSON.stringify(f.args) } });
      let stderr = ""; child.stderr.on("data", chunk => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolveExit() : reject(new Error(stderr)));
    }));
    await Promise.all(attempts);
    assert.equal(readExperienceTaskGoal(f.args), f.args.task_goal);
    assert.equal((await readdir(join(f.experienceDir, "scenario-classification", "pending"))).length, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("Experience goal publication handles concurrent creation and rejects conflicting or failed writes", async t => {
  const f = await fixture();
  const error = (code: string) => Object.assign(new Error(code), { code });
  const originalLink = fs.linkSync;
  try {
    t.mock.method(fs, "linkSync", ((source, destination) => {
      originalLink(source, destination);
      throw error("EEXIST");
    }) as typeof fs.linkSync);
    syncBuiltinESMExports();
    storeExperienceTaskGoal(f.args);
    assert.equal(readExperienceTaskGoal(f.args), f.args.task_goal);
    deleteExperienceTaskGoal(f.args);
    t.mock.restoreAll(); syncBuiltinESMExports();

    t.mock.method(fs, "linkSync", ((_source, destination) => {
      fs.writeFileSync(destination, JSON.stringify({ identity_digest: "other" }));
      throw error("EEXIST");
    }) as typeof fs.linkSync);
    syncBuiltinESMExports();
    assert.throws(() => storeExperienceTaskGoal(f.args), /idempotency conflict/u);
    deleteExperienceTaskGoal(f.args);
    t.mock.restoreAll(); syncBuiltinESMExports();

    t.mock.method(fs, "linkSync", (() => { throw error("EACCES"); }) as typeof fs.linkSync);
    syncBuiltinESMExports();
    assert.throws(() => storeExperienceTaskGoal(f.args), /EACCES/u);
    assert.deepEqual(await readdir(join(f.experienceDir, "scenario-classification", "pending")), []);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(f.root, { recursive: true, force: true }); }
});

test("Experience goal directory creation checks a concurrent replacement", async t => {
  const f = await fixture();
  const originalMkdir = fs.mkdirSync;
  const error = (code: string) => Object.assign(new Error(code), { code });
  const queue = join(f.experienceDir, "scenario-classification");
  try {
    t.mock.method(fs, "mkdirSync", ((path, options) => { originalMkdir(path, options); throw error("EEXIST"); }) as typeof fs.mkdirSync);
    syncBuiltinESMExports();
    storeExperienceTaskGoal(f.args);
    assert.equal(readExperienceTaskGoal(f.args), f.args.task_goal);
    t.mock.restoreAll(); syncBuiltinESMExports();
    await rm(queue, { recursive: true });

    t.mock.method(fs, "mkdirSync", ((path) => { fs.writeFileSync(path, "not a directory"); throw error("EEXIST"); }) as typeof fs.mkdirSync);
    syncBuiltinESMExports();
    assert.throws(() => storeExperienceTaskGoal(f.args), /regular directories/u);
    t.mock.restoreAll(); syncBuiltinESMExports();
    await rm(queue);

    t.mock.method(fs, "mkdirSync", (() => { throw error("EACCES"); }) as typeof fs.mkdirSync);
    syncBuiltinESMExports();
    assert.throws(() => storeExperienceTaskGoal(f.args), /EACCES/u);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(f.root, { recursive: true, force: true }); }
});

test("Experience task goals reject invalid scope, identity, secret, and oversized summaries", async () => {
  const f = await fixture();
  try {
    for (const args of [
      { ...f.args, scope: "global" }, { ...f.args, session_id: " " }, { ...f.args, turn_id: " " },
      { ...f.args, session_host: "unknown" as "codex" },
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
