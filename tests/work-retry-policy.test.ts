import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { workRetryPolicy } from "../core/work-retry-policy.ts";

test("retry ancestry counts persisted attempts and rejects corrupt ownership, cycles and unbounded chains", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "craft-retry-policy-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    let launch = store.create("work_launch", "root", { task_id: "task" });
    assert.deepEqual(workRetryPolicy(store, launch), { root_launch_id: "root", retries_used: 0, max_retries: 3, exhausted: false });
    for (let i = 1; i <= 4; i++) {
      launch = store.create("work_launch", `retry-${i}`, { task_id: "task", retry_of: launch.id });
      const policy = workRetryPolicy(store, launch);
      assert.equal(policy.retries_used, i);
      assert.equal(policy.exhausted, i >= 3);
      assert.equal(policy.root_launch_id, "root");
    }
    const foreign = store.create("work_launch", "foreign", { task_id: "other", retry_of: launch.id });
    assert.throws(() => workRetryPolicy(store, foreign), /crosses task/);
    const cycle = store.create("work_launch", "cycle", { task_id: "task", retry_of: "cycle" });
    assert.throws(() => workRetryPolicy(store, cycle), /cyclic/);
    assert.throws(() => workRetryPolicy(store, { id: "missing", task_id: "task", retry_of: "unknown" }), /Unknown work_launch/);
    let counter = 0;
    const infinite = t.mock.method(store, "get", () => ({ id: `node-${++counter}`, task_id: "task", retry_of: "next" }) as JsonObject);
    assert.throws(() => workRetryPolicy(store, { id: "initial", task_id: "task", retry_of: "next" }), /safety bound/);
    infinite.mock.restore();
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
