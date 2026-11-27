import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { readVolatileLearningState, registerVolatileLearningState, writeVolatileLearningState } from "../core/codex-session-archive.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { LocalSupervisor, SupervisorClient } from "../core/supervisor.ts";

test("learning snapshot reads remain complete during concurrent publishing and repeated writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-learning-snapshot-"));
  const paths = craftPaths(root), store = await new CraftStore(paths).open();
  const supervisor = new LocalSupervisor(new CraftService(store), paths);
  await supervisor.start();
  const path = join(root, "index.json");
  registerVolatileLearningState(path, { CRAFT_DATA_DIR: root });
  try {
    await writeVolatileLearningState(relative(process.cwd(), path), { marker: "initial", data: "x".repeat(800_000) });
    assert.equal((await readVolatileLearningState(path))?.marker, "initial");
    await Promise.all(Array.from({ length: 80 }, async (_, index) => {
      if (index % 2) await writeVolatileLearningState(path, { marker: String(index), data: "x".repeat(800_000) });
      else {
        const state = await readVolatileLearningState(path);
        assert.equal(typeof state?.marker, "string");
        assert.equal((state?.data as string).length, 800_000);
      }
    }));
    assert.equal(((await readVolatileLearningState(path))?.data as string).length, 800_000);
  } finally { await supervisor.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("failed snapshot publication safely cleans staged chunks or retains a committed generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-learning-snapshot-abort-"));
  const paths = craftPaths(root), store = await new CraftStore(paths).open(), supervisor = new LocalSupervisor(new CraftService(store), paths);
  await supervisor.start();
  const path = join(root, "index.json"), original = SupervisorClient.prototype.contextSnapshotPublish, abort = SupervisorClient.prototype.contextSnapshotAbort;
  registerVolatileLearningState(path, { CRAFT_DATA_DIR: root });
  try {
    await writeVolatileLearningState(path, { marker: "old" });
    let status: unknown;
    SupervisorClient.prototype.contextSnapshotAbort = async function(args) { const result = await abort.call(this, args); status = result.status; return result; };
    SupervisorClient.prototype.contextSnapshotPublish = async () => { throw new Error("not sent"); };
    await assert.rejects(writeVolatileLearningState(path, { marker: "not-sent" }), /not sent/u);
    assert.equal(status, "aborted"); assert.equal((await readVolatileLearningState(path))?.marker, "old");
    SupervisorClient.prototype.contextSnapshotPublish = async function(args) { await original.call(this, args); throw new Error("response lost"); };
    await assert.rejects(writeVolatileLearningState(path, { marker: "committed" }), /response lost/u);
    assert.equal(status, "retained"); assert.equal((await readVolatileLearningState(path))?.marker, "committed");
  } finally {
    SupervisorClient.prototype.contextSnapshotPublish = original; SupervisorClient.prototype.contextSnapshotAbort = abort;
    await supervisor.close(); store.close(); rmSync(root, { recursive: true, force: true });
  }
});
