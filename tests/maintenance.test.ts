import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalMaintenanceWorker, MaintenanceKernel } from "../src/maintenance.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

async function fixture() { const root = await mkdtemp(path.join(tmpdir(), "craft-maintenance-")); const paths = craftPaths(root); const store = await new CraftStore(paths).open(); const service = new CraftService(store); return { root, paths, store, service, kernel: new MaintenanceKernel(service) }; }
type PrivateWorker = { acquire(retry?: boolean): Promise<void>; release(): Promise<void>; heartbeat(now: string): Promise<void>; reclaimStale(): Promise<void>; assertSameOwner(expected: JsonObject, actual: JsonObject): void };

test("maintenance tick safely reconciles bounded control-plane state and persists health", async () => {
  const f = await fixture(); f.store.create("hub_source", "hub", { status: "active" });
  const first = f.kernel.tick({ now: "2030-01-01T00:00:00.000Z", limit: 5 }); assert.equal((first.status as JsonObject).status, "healthy"); assert.equal((first.receipt as JsonObject).status, "passed"); assert.equal((first.attention as JsonObject).count, 0); assert.equal((first.status as JsonObject).attention_count, 0);
  const second = f.kernel.tick({ now: "2030-01-01T00:01:00.000Z" }); assert.equal((second.status as JsonObject).version, 2);
  assert.throws(() => f.kernel.tick({ now: "never" }), /ISO/); assert.throws(() => f.kernel.tick({ limit: 0 }), /between/); f.store.close();
});

test("local worker owns one cross-platform lock, heartbeats, stops, and reports status", async () => {
  const f = await fixture(); let afterTicks = 0; const worker = new LocalMaintenanceWorker(f.kernel, f.paths, { afterTick: async () => { afterTicks += 1; } });
  assert.deepEqual(await worker.status(), { status: "not_started" });
  const times = ["2030-01-01T00:00:00.000Z", "2030-01-01T00:00:01.000Z"]; let waits = 0;
  const result = await worker.run({ intervalMs: 100, maxTicks: 2, now: () => times.shift()!, wait: async () => { waits += 1; } });
  assert.deepEqual(result, { status: "stopped", ticks: 2 }); assert.equal(waits, 1); assert.equal(afterTicks, 2); assert.equal((await worker.status()).status, "stopped");
  assert.equal(await worker.run({ maxTicks: 1 }).then((item) => item.ticks), 1);
  const controller = new AbortController(); controller.abort(); assert.equal((await worker.run({ maxTicks: 1, signal: controller.signal })).ticks, 0);
  const live = new AbortController(); setTimeout(() => live.abort(), 50); assert.equal((await worker.run({ intervalMs: 100, maxTicks: 2, signal: live.signal })).ticks, 1);
  await writeFile(path.join(f.paths.runtimeDir, "maintenance-worker.json"), "not-json"); await assert.rejects(() => worker.status(), SyntaxError);
  await assert.rejects(() => worker.run({ intervalMs: 99 }), /interval_ms/); await assert.rejects(() => worker.run({ maxTicks: 0 }), /max_ticks/); f.store.close();
});

test("worker lock rejects concurrency, ownership drift, missing locks, and filesystem failures", async () => {
  const f = await fixture(); const first = new LocalMaintenanceWorker(f.kernel, f.paths); const second = new LocalMaintenanceWorker(f.kernel, f.paths);
  await (first as unknown as PrivateWorker).acquire(); await writeFile(path.join(f.paths.runtimeDir, "maintenance-worker.json"), JSON.stringify({ status: "running", token: first.token })); assert.equal((await first.status()).online, true);
  await assert.rejects(() => second.run({ maxTicks: 1 }), /already running/); await assert.rejects(() => (second as unknown as PrivateWorker).acquire(false), /changed during recovery/); await (first as unknown as PrivateWorker).release();
  await (first as unknown as PrivateWorker).release(); await (first as unknown as PrivateWorker).acquire();
  const lock = path.join(f.paths.runtimeDir, "maintenance.lock.json"); await writeFile(lock, JSON.stringify({ token: "changed" }));
  await assert.rejects(() => (first as unknown as PrivateWorker).release(), /ownership changed/); await unlink(lock);
  await writeFile(lock, JSON.stringify({ token: "changed" })); await assert.rejects(() => (first as unknown as PrivateWorker).heartbeat(new Date().toISOString()), /ownership changed/); await unlink(lock);
  await writeFile(path.join(f.paths.runtimeDir, "maintenance-worker.json"), JSON.stringify({ status: "running", token: "x" })); await writeFile(lock, "{");
  await assert.rejects(() => first.status(), SyntaxError); await unlink(lock);
  const brokenPaths = { ...f.paths, runtimeDir: path.join(f.root, "missing", "nested") }; const broken = new LocalMaintenanceWorker(f.kernel, brokenPaths);
  await assert.rejects(() => broken.run({ maxTicks: 1 }), /ENOENT/); await mkdir(brokenPaths.runtimeDir, { recursive: true }); await writeFile(path.join(brokenPaths.runtimeDir, "maintenance.lock.json"), "{");
  await assert.rejects(() => (broken as unknown as PrivateWorker).release(), SyntaxError); f.store.close();
});

test("stale lock takeover requires the same host, a dead process, and an expired valid heartbeat", async () => {
  const f = await fixture(); const lock = path.join(f.paths.runtimeDir, "maintenance.lock.json"); const old = new Date(Date.now() - 10_000).toISOString();
  const worker = new LocalMaintenanceWorker(f.kernel, f.paths, { host: "host", staleAfterMs: 1_000, isProcessAlive: () => false });
  await writeFile(lock, JSON.stringify({ pid: 999, token: "old", host: "host", heartbeat_at: old })); assert.equal((await worker.run({ maxTicks: 1 })).ticks, 1);
  assert.equal((await readdir(f.paths.runtimeDir)).some((name) => name.startsWith("maintenance.lock.recovered.")), true);
  for (const owner of [{ pid: 999, token: "foreign", host: "other", heartbeat_at: old }, { pid: 999, token: "live", host: "host", heartbeat_at: old },
    { pid: 999, token: "recent", host: "host", heartbeat_at: new Date().toISOString() }, { pid: 999, token: "invalid", host: "host", heartbeat_at: "never" }]) {
    await writeFile(lock, JSON.stringify(owner)); const live = new LocalMaintenanceWorker(f.kernel, f.paths, { host: "host", staleAfterMs: 1_000, isProcessAlive: () => owner.token === "live" });
    await assert.rejects(() => (live as unknown as PrivateWorker).reclaimStale(), /already running/); await unlink(lock);
  }
  (worker as unknown as PrivateWorker).assertSameOwner({ token: "a" }, { token: "a" }); assert.throws(() => (worker as unknown as PrivateWorker).assertSameOwner({ token: "a" }, { token: "b" }), /changed during recovery/);
  const native = new LocalMaintenanceWorker(f.kernel, f.paths); assert.equal(native.isProcessAlive(0), false); assert.equal(native.isProcessAlive(process.pid), true);
  const originalKill = process.kill; try { process.kill = (() => { const error = new Error("gone") as NodeJS.ErrnoException; error.code = "ESRCH"; throw error; }) as typeof process.kill; assert.equal(native.isProcessAlive(1), false);
    process.kill = (() => { const error = new Error("denied") as NodeJS.ErrnoException; error.code = "EPERM"; throw error; }) as typeof process.kill; assert.equal(native.isProcessAlive(1), true); } finally { process.kill = originalKill; }
  assert.throws(() => new LocalMaintenanceWorker(f.kernel, f.paths, { staleAfterMs: 10 }), /stale_after_ms/); f.store.close();
});

test("maintenance isolates component failures, fingerprints errors, backs off, opens, and recovers", async () => {
  const f = await fixture(); f.store.create("hub_source", "hub", { status: "active" });
  const originals = { recovery: f.service.recoveryLeaseRecover.bind(f.service), hydration: f.service.hydrationLeaseRecover.bind(f.service),
    speculative: f.service.speculativeExpire.bind(f.service), acceptance: f.service.acceptanceEvaluationRecover.bind(f.service), projection: f.service.recoveryQueueRefresh.bind(f.service), hub: f.service.supplyChainReconcile.bind(f.service), attention: f.service.attentionRefresh.bind(f.service) };
  f.service.recoveryLeaseRecover = (() => { throw new Error("secret detail"); }) as typeof f.service.recoveryLeaseRecover;
  f.service.hydrationLeaseRecover = (() => { throw new Error("hydrate"); }) as typeof f.service.hydrationLeaseRecover;
  f.service.speculativeExpire = (() => { throw new Error("expire"); }) as typeof f.service.speculativeExpire;
  f.service.acceptanceEvaluationRecover = (() => { throw new Error("acceptance"); }) as typeof f.service.acceptanceEvaluationRecover;
  f.service.recoveryQueueRefresh = (() => { throw new Error("project"); }) as typeof f.service.recoveryQueueRefresh;
  f.service.supplyChainReconcile = (() => { throw "hub failure"; }) as typeof f.service.supplyChainReconcile;
  f.service.attentionRefresh = (() => { throw new Error("attention"); }) as typeof f.service.attentionRefresh;
  const first = f.kernel.tick({ now: "2030-01-01T00:00:00.000Z", base_backoff_ms: 100, max_backoff_ms: 200 });
  assert.equal((first.status as JsonObject).status, "degraded"); assert.equal(first.recovery, null); assert.equal((first.reconciliations as JsonObject[]).length, 0);
  const failure = f.store.list("maintenance_failure", 20)[0]; assert.equal(failure.error_type === "Error" || failure.error_type === "NonErrorThrow", true); assert.equal(JSON.stringify(failure).includes("secret detail"), false);
  const backedOff = f.kernel.tick({ now: "2030-01-01T00:00:00.050Z", base_backoff_ms: 100, max_backoff_ms: 200 }); assert.equal((backedOff.outcomes as JsonObject[]).every((item) => item.status === "backoff"), true);
  f.kernel.tick({ now: "2030-01-01T00:00:00.100Z", base_backoff_ms: 100, max_backoff_ms: 200 });
  f.kernel.tick({ now: "2030-01-01T00:00:00.300Z", base_backoff_ms: 100, max_backoff_ms: 200 }); assert.equal(f.store.get("maintenance_component", "recovery_leases").status, "open");
  f.service.recoveryLeaseRecover = originals.recovery; f.service.hydrationLeaseRecover = originals.hydration; f.service.speculativeExpire = originals.speculative; f.service.acceptanceEvaluationRecover = originals.acceptance;
  f.service.recoveryQueueRefresh = originals.projection; f.service.supplyChainReconcile = originals.hub; f.service.attentionRefresh = originals.attention;
  const recovered = f.kernel.tick({ now: "2030-01-01T00:00:00.500Z", base_backoff_ms: 100, max_backoff_ms: 200 }); assert.equal((recovered.status as JsonObject).status, "healthy"); assert.equal(f.store.get("maintenance_component", "recovery_leases").consecutive_failures, 0);
  assert.throws(() => f.kernel.tick({ base_backoff_ms: 99 }), /base_backoff_ms/); assert.throws(() => f.kernel.tick({ base_backoff_ms: 500, max_backoff_ms: 400 }), /max_backoff_ms/); f.store.close();
});
