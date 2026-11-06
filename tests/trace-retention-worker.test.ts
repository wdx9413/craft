import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CraftService } from "../core/application/craft-service.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { TRACE_RETENTION_WORKER_FLAG, runTraceRetentionMaintenance, startConfiguredTraceRetentionWorker, startTraceRetentionWorker } from "../core/interfaces/trace-retention-worker.ts";

function fixture(maintain: () => void) {
  return { trace: { maintain }, store: { paths: { root: "/tmp/craft-retention-test" } } } as unknown as CraftService;
}

test("Trace retention worker checks on a low-frequency timer and stops cleanly", () => {
  let run: (() => void) | undefined, interval = 0, unrefCalls = 0, cancelled = 0, runs = 0;
  const timer = { unref: () => { unrefCalls += 1; } } as unknown as NodeJS.Timeout;
  const stop = startTraceRetentionWorker(fixture(() => { runs += 1; }), {
    set_interval: (callback, ms) => { run = callback; interval = ms; return timer; },
    clear_interval: candidate => { assert.equal(candidate, timer); cancelled += 1; },
  });
  assert.equal(interval, 60_000);
  assert.equal(unrefCalls, 1);
  run!();
  assert.equal(runs, 1);
  stop(); stop();
  run!();
  assert.equal(runs, 1);
  assert.equal(cancelled, 1);
});

test("configured retention isolates slow work in one child and stops its own active child", async () => {
  let tick: (() => void) | undefined, launches = 0, foregroundRuns = 0, failures = 0;
  const children: ChildProcess[] = [], killed: unknown[] = [];
  const stop = startConfiguredTraceRetentionWorker(fixture(() => { foregroundRuns++; }), {}, () => { failures++; }, {
    server_entrypoint: "/tmp/craft-mcp.ts",
    set_interval: callback => { tick = callback; return {} as NodeJS.Timeout; }, clear_interval: () => undefined,
    spawn_process: ((_executable: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: string }) => {
      launches++;
      assert.deepEqual(args, ["--experimental-strip-types", "/tmp/craft-mcp.ts", TRACE_RETENTION_WORKER_FLAG]);
      assert.equal(options.env.CRAFT_DATA_DIR, "/tmp/craft-retention-test");
      assert.equal(options.env.CRAFT_CONTINUOUS_LEARNING, "0");
      assert.equal(options.stdio, "ignore");
      const child = new EventEmitter() as ChildProcess;
      child.kill = signal => { killed.push(signal); child.emit("close", null, "SIGTERM"); return true; };
      children.push(child); return child;
    }) as typeof spawn,
  });
  tick!(); tick!();
  assert.equal(launches, 1); assert.equal(foregroundRuns, 0);
  children[0]!.emit("close", 0, null);
  await Promise.resolve();
  tick!(); assert.equal(launches, 2);
  stop(); stop();
  await Promise.resolve();
  assert.deepEqual(killed, [undefined]); assert.equal(failures, 0);
});

test("isolated retention reports child failure, spawn failure and timeout without overlapping requests", async () => {
  for (const failure of ["exit", "error", "spawn", "timeout"] as const) {
    let tick: (() => void) | undefined, errors = 0, kills = 0;
    const child = new EventEmitter() as ChildProcess;
    child.kill = () => { kills++; return true; };
    const stop = startConfiguredTraceRetentionWorker(fixture(() => { throw new Error("foreground must remain idle"); }), {}, () => { errors++; }, {
      server_entrypoint: "/tmp/craft-mcp.cjs", process_timeout_ms: failure === "timeout" ? 1 : 1000,
      set_interval: callback => { tick = callback; return {} as NodeJS.Timeout; }, clear_interval: () => undefined,
      spawn_process: ((_command: string, args: string[]) => {
        assert.deepEqual(args, ["/tmp/craft-mcp.cjs", TRACE_RETENTION_WORKER_FLAG]);
        if (failure === "spawn") throw new Error("spawn failed");
        return child;
      }) as typeof spawn,
    });
    tick!();
    if (failure === "exit") child.emit("close", 1, null);
    if (failure === "error") child.emit("error", new Error("child failed"));
    if (failure === "timeout") await new Promise(resolve => setTimeout(resolve, 10));
    await Promise.resolve();
    assert.equal(errors, 1); assert.equal(kills, failure === "timeout" ? 1 : 0);
    stop();
  }
  for (const process_timeout_ms of [0, 600_001, 1.5]) assert.throws(() => startConfiguredTraceRetentionWorker(fixture(() => undefined), {}, undefined, { process_timeout_ms }), /process_timeout_ms/u);
  assert.throws(() => startConfiguredTraceRetentionWorker(fixture(() => undefined), {}, undefined, { server_entrypoint: "" }), /entrypoint/u);
});

test("retention child releases its lock and Store for skipped, failed and completed work", async () => {
  let closed = 0, released = 0, opened = 0;
  const store = { close: () => { closed++; } } as CraftStore;
  const acquire = async () => async () => { released++; };
  await runTraceRetentionMaintenance({}, { acquire_lock: async () => null, open_store: async () => { throw new Error("must not open"); } });
  await assert.rejects(runTraceRetentionMaintenance({}, { acquire_lock: acquire, open_store: async () => { opened++; throw new Error("open failed"); } }), /open failed/u);
  await assert.rejects(runTraceRetentionMaintenance({}, { acquire_lock: acquire, open_store: async () => store, maintain: () => { throw new Error("maintain failed"); } }), /maintain failed/u);
  await runTraceRetentionMaintenance({}, { acquire_lock: acquire, open_store: async () => store, maintain: () => undefined });
  assert.equal(opened, 1); assert.equal(closed, 2); assert.equal(released, 3);
});

test("retention child default entry performs one bounded sweep in its own data root", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-trace-child-"));
  const previous = process.env.CRAFT_DATA_DIR;
  process.env.CRAFT_DATA_DIR = root;
  try {
    await runTraceRetentionMaintenance();
    const store = await new CraftStore(craftPaths(root)).open();
    try { assert.equal(store.get("maintenance_component", "trace_retention").status, "healthy"); }
    finally { store.close(); }
  } finally {
    if (previous === undefined) delete process.env.CRAFT_DATA_DIR; else process.env.CRAFT_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("Trace retention worker prevents reentry and reports maintenance failures", () => {
  let run: (() => void) | undefined, runs = 0, failures = 0;
  const timer = {} as NodeJS.Timeout;
  const stop = startTraceRetentionWorker(fixture(() => { runs += 1; run?.(); throw new Error("maintenance failed"); }), {
    interval_ms: 5_000,
    set_interval: callback => { run = callback; return timer; },
    clear_interval: () => undefined,
    on_failure: error => { assert.match(String(error), /maintenance failed/u); failures += 1; },
  });
  run!();
  assert.equal(runs, 1);
  assert.equal(failures, 1);
  stop();
});

test("Trace retention worker validates its interval", () => {
  for (const interval_ms of [999, 3_600_001, 1.5]) assert.throws(() => startTraceRetentionWorker(fixture(() => undefined), { interval_ms }), /interval_ms/u);
});

test("Trace retention worker supports default timer controls and contains unexpected errors", () => {
  const stop = startTraceRetentionWorker(fixture(() => { throw new Error("contained"); }));
  stop();
});

test("configured Trace retention worker honors disable and interval settings", () => {
  let run: (() => void) | undefined, cancelled = 0, runs = 0;
  const timer = {} as NodeJS.Timeout;
  const service = fixture(() => { runs += 1; });
  const disabled = startConfiguredTraceRetentionWorker(service, { CRAFT_TRACE_RETENTION_WORKER: "0" });
  disabled();
  const noService = startConfiguredTraceRetentionWorker(undefined, {});
  noService();
  const defaults = startConfiguredTraceRetentionWorker(service, {});
  defaults();
  const stop = startConfiguredTraceRetentionWorker(service, { CRAFT_TRACE_RETENTION_INTERVAL_MS: "5000" }, () => undefined);
  stop();
  const scheduled = startTraceRetentionWorker(service, { interval_ms: 5000,
    set_interval: callback => { run = callback; return timer; }, clear_interval: () => { cancelled += 1; } });
  run!();
  assert.equal(runs, 1);
  scheduled();
  assert.equal(cancelled, 1);
});
