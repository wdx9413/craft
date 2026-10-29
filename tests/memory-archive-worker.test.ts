import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths, sessionStorageScopeId } from "../core/infrastructure/paths.ts";
import { MemoryFileStore } from "../capability/craft-memory/memory-files.ts";
import { launchMemoryArchiveWorker, queueHookMaintenance, runMemoryArchiveWorker } from "../core/interfaces/memory-archive-worker.ts";
import { CraftService } from "../core/service.ts";
import { acquireLearningWorkerLocks } from "../core/infrastructure/learning-worker-lock.ts";
import { pathToFileURL } from "node:url";

test("maintenance request enqueue handles races and rejects identity conflicts", () => {
  const lease = "codex-memory-race";
  let reads = 0;
  const raced = { find: () => ++reads === 1 ? null : { lease_id: lease }, create: () => { throw new Error("duplicate"); } } as unknown as CraftStore;
  assert.doesNotThrow(() => queueHookMaintenance(raced, lease));
  const wrong = { find: () => ({ lease_id: "different" }) } as unknown as CraftStore;
  assert.throws(() => queueHookMaintenance(wrong, lease), /identity conflict/u);
  const unavailable = { find: () => null, create: () => { throw new Error("unavailable"); } } as unknown as CraftStore;
  assert.throws(() => queueHookMaintenance(unavailable, lease), /unavailable/u);
});

test("worker launch uses the proper runtime flags and tolerates spawn errors", t => {
  const launches: Array<{ args: string[]; env: Record<string, string> }> = [];
  let unrefs = 0, observedErrors = 0;
  t.mock.method(childProcess, "spawn", ((_command, args, options) => {
    launches.push({ args: args as string[], env: (options as { env: Record<string, string> }).env });
    return { on: (_event: string, listener: () => void) => { listener(); observedErrors++; }, unref: () => { unrefs++; } };
  }) as typeof childProcess.spawn);
  try {
    syncBuiltinESMExports();
    launchMemoryArchiveWorker("/example/hook.ts", "/example/data");
    launchMemoryArchiveWorker("/example/hook.cjs", "/example/data");
    assert.deepEqual(launches.map(item => item.args), [
      ["--experimental-strip-types", "/example/hook.ts", "--memory-archive-worker"],
      ["/example/hook.cjs", "--memory-archive-worker"],
    ]);
    assert(launches.every(item => item.env.CRAFT_DATA_DIR === "/example/data" && item.env.CRAFT_HOOK_MODE === "0"));
    assert.equal(unrefs, 2); assert.equal(observedErrors, 2);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("the Claude Hook uses its explicit Host even when source is an event reason", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-claude-hook-host-"));
  let store: CraftStore | undefined;
  try {
    const hook = spawn(process.execPath, ["--experimental-strip-types", resolve("bin/craft-codex-hook.ts"), "--member", "memory", "--host", "claude"],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CRAFT_DATA_DIR: root, CRAFT_CONTINUOUS_LEARNING: "0" } });
    hook.stdout.resume(); hook.stderr.resume();
    hook.stdin.end(JSON.stringify({ hook_event_name: "SessionEnd", source: "clear", cwd: process.cwd(), session_id: "same-session" }));
    assert.equal(await new Promise<number | null>((resolveExit, reject) => { hook.once("error", reject); hook.once("exit", resolveExit); }), 0);
    store = await new CraftStore(craftPaths(root)).open();
    const deadline = Date.now() + 15_000;
    while (!store.list("memory_session_archive", 1).some(row => row.status === "archived") && Date.now() < deadline) await delay(100);
    const archive = store.list("memory_session_archive", 1)[0];
    assert.equal(archive?.session_digest, createHash("sha256").update(sessionStorageScopeId("claude", "same-session")).digest("hex"));
    const lock = join(craftPaths(root).runtimeDir, "learning-worker-memory-session-archive.lock.json");
    while (existsSync(lock) && Date.now() < deadline) await delay(50);
    assert.equal(existsSync(lock), false);
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("SessionEnd Hook returns while its detached worker completes the durable archive", { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "craft-hook-archive-worker-"));
  const sessionId = "background-session", scope = sessionStorageScopeId("codex", sessionId);
  let store: CraftStore | undefined;
  try {
    store = await new CraftStore(craftPaths(root)).open();
    store.bindSessionStorageHost(sessionId, "codex");
    for (let i = 0; i < 501; i++) store.create("memory_candidate", `worker-${String(i).padStart(4, "0")}`,
      { scope: { kind: "session", id: scope }, status: "candidate" });
    store.close(); store = undefined;
    const started = performance.now();
    const hook = spawn(process.execPath, ["--experimental-strip-types", resolve("bin/craft-codex-hook.ts"), "--member", "memory"],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CRAFT_DATA_DIR: root, CRAFT_CONTINUOUS_LEARNING: "0" } });
    let output = "", errors = "";
    hook.stdout.setEncoding("utf8"); hook.stdout.on("data", chunk => { output += chunk; });
    hook.stderr.setEncoding("utf8"); hook.stderr.on("data", chunk => { errors += chunk; });
    hook.stdin.end(JSON.stringify({ hook_event_name: "SessionEnd", source: "codex", cwd: process.cwd(), session_id: sessionId }));
    const exit = await new Promise<number | null>((resolveExit, reject) => { hook.once("error", reject); hook.once("exit", resolveExit); });
    t.diagnostic(`hook_ms=${Math.round(performance.now() - started)} records=501`);
    assert.equal(exit, 0, errors);
    assert.deepEqual(JSON.parse(output), {});
    store = await new CraftStore(craftPaths(root)).open();
    const deadline = Date.now() + 20_000;
    let archived = false;
    do {
      archived = store.list("memory_session_archive", 10).some(item => item.status === "archived");
      if (!archived) await delay(100);
    } while (!archived && Date.now() < deadline);
    assert.equal(archived, true);
    assert.equal(store.listSessionMemoryPage("memory_candidate", scope).records.length, 0);
    const lock = join(craftPaths(root).runtimeDir, "learning-worker-memory-session-archive.lock.json");
    while (existsSync(lock) && Date.now() < deadline) await delay(50);
    assert.equal(existsSync(lock), false);
    assert.equal(store.list("memory_maintenance_request", 10)[0]?.status, "completed");
    const request = store.list("memory_maintenance_request", 10)[0]!;
    assert.equal(store.find("maintenance_schedule_receipt", String(request.lease_id))?.status, "completed");
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("SessionStart recovers maintenance interrupted after its run was persisted", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-hook-maintenance-restart-"));
  const leaseId = "codex-memory-maintenance-recovery";
  let store: CraftStore | undefined;
  try {
    store = await new CraftStore(craftPaths(root)).open();
    const service = await CraftService.open(store);
    service.memoryMaintenanceRun({ stage: "light", maintenance_id: `scheduled_${leaseId}` });
    queueHookMaintenance(store, leaseId);
    queueHookMaintenance(store, leaseId);
    store.close(); store = undefined;
    const hook = spawn(process.execPath, ["--experimental-strip-types", resolve("bin/craft-codex-hook.ts"), "--member", "context"],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CRAFT_DATA_DIR: root, CRAFT_CONTINUOUS_LEARNING: "0" } });
    hook.stdout.resume(); hook.stderr.resume();
    hook.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", source: "codex", cwd: process.cwd(), session_id: "new-session" }));
    const exit = await new Promise<number | null>((resolveExit, reject) => { hook.once("error", reject); hook.once("exit", resolveExit); });
    assert.equal(exit, 0);
    store = await new CraftStore(craftPaths(root)).open();
    const deadline = Date.now() + 15_000;
    while (store.list("memory_maintenance_request", 1)[0]?.status !== "completed" && Date.now() < deadline) await delay(100);
    assert.equal(store.list("memory_maintenance_request", 10).length, 1);
    assert.equal(store.list("memory_maintenance_request", 1)[0]?.status, "completed");
    const receipt = store.find("maintenance_schedule_receipt", leaseId);
    assert.equal(receipt?.expired_memory, null);
    assert.equal(receipt?.run_id, `scheduled_${leaseId}`);
    const lock = join(craftPaths(root).runtimeDir, "learning-worker-memory-session-archive.lock.json");
    while (existsSync(lock) && Date.now() < deadline) await delay(50);
    assert.equal(existsSync(lock), false);
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("maintenance identity conflicts and malformed requests stop for reconciliation", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-hook-maintenance-conflict-"));
  const leaseId = "codex-memory-conflicting-lease";
  let store: CraftStore | undefined;
  try {
    store = await new CraftStore(craftPaths(root)).open();
    store.create("maintenance_schedule_receipt", leaseId, { identity_digest: "conflicting", status: "completed" });
    queueHookMaintenance(store, leaseId);
    store.create("memory_maintenance_request", "malformed-request", { status: "pending", content_free: true });
    store.close(); store = undefined;
    const hook = spawn(process.execPath, ["--experimental-strip-types", resolve("bin/craft-codex-hook.ts"), "--member", "context"],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CRAFT_DATA_DIR: root, CRAFT_CONTINUOUS_LEARNING: "0" } });
    hook.stdout.resume(); hook.stderr.resume();
    hook.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", source: "codex", cwd: process.cwd(), session_id: "new-session" }));
    assert.equal(await new Promise<number | null>((resolveExit, reject) => { hook.once("error", reject); hook.once("exit", resolveExit); }), 0);
    store = await new CraftStore(craftPaths(root)).open();
    const deadline = Date.now() + 15_000;
    while (store.list("memory_maintenance_request", 10, row => row.status === "requires_reconciliation").length < 2 && Date.now() < deadline) await delay(100);
    const requests = store.list("memory_maintenance_request", 10);
    assert.equal(requests.filter(row => row.status === "requires_reconciliation").length, 2);
    assert.equal(requests.find(row => row.lease_id === leaseId)?.failures, 1);
    assert.equal(requests.find(row => row.id === "malformed-request")?.last_error_type, "invalid_lease_id");
    const lock = join(craftPaths(root).runtimeDir, "learning-worker-memory-session-archive.lock.json");
    while (existsSync(lock) && Date.now() < deadline) await delay(50);
    assert.equal(existsSync(lock), false);
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a contending worker process resumes after the owner holds the lock beyond five seconds", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-hook-maintenance-lock-"));
  let store: CraftStore | undefined;
  let release: (() => Promise<void>) | null = null;
  try {
    const paths = craftPaths(root);
    store = await new CraftStore(paths).open();
    queueHookMaintenance(store, "codex-memory-lock-contention");
    release = await acquireLearningWorkerLocks(paths.runtimeDir, ["memory-session-archive"]);
    assert(release);
    const hook = spawn(process.execPath, ["--experimental-strip-types", resolve("bin/craft-codex-hook.ts"), "--member", "context"],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CRAFT_DATA_DIR: root, CRAFT_CONTINUOUS_LEARNING: "0" } });
    hook.stdout.resume(); hook.stderr.resume();
    hook.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", source: "codex", cwd: process.cwd(), session_id: "new-session" }));
    assert.equal(await new Promise<number | null>((resolveExit, reject) => { hook.once("error", reject); hook.once("exit", resolveExit); }), 0);
    await delay(5_500);
    assert.equal(store.list("memory_maintenance_request", 1)[0]?.status, "pending");
    assert.equal(existsSync(join(paths.runtimeDir, "learning-worker-memory-session-archive-waiter.lock.json")), true);
    await release(); release = null;
    const deadline = Date.now() + 15_000;
    while (store.list("memory_maintenance_request", 1)[0]?.status !== "completed" && Date.now() < deadline) await delay(100);
    assert.equal(store.list("memory_maintenance_request", 1)[0]?.status, "completed");
    const lock = join(paths.runtimeDir, "learning-worker-memory-session-archive.lock.json");
    while (existsSync(lock) && Date.now() < deadline) await delay(50);
    assert.equal(existsSync(lock), false);
  } finally { await release?.(); store?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a transient maintenance failure is checkpointed and retried by the worker process", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-hook-maintenance-retry-"));
  let store: CraftStore | undefined;
  try {
    store = await new CraftStore(craftPaths(root)).open();
    queueHookMaintenance(store, "codex-memory-retry-test");
    const workerUrl = pathToFileURL(resolve("core/interfaces/memory-archive-worker.ts")).href;
    const serviceUrl = pathToFileURL(resolve("core/service.ts")).href;
    const script = `import { CraftService } from ${JSON.stringify(serviceUrl)};
      import { runMemoryArchiveWorker } from ${JSON.stringify(workerUrl)};
      const open = CraftService.open.bind(CraftService); let failed = false;
      CraftService.open = async (...args) => { const service = await open(...args); const schedule = service.memoryMaintenanceSchedule.bind(service);
        service.memoryMaintenanceSchedule = (...input) => { if (!failed) { failed = true; throw new Error('injected transient'); } return schedule(...input); }; return service; };
      await runMemoryArchiveWorker();`;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script],
      { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, CRAFT_DATA_DIR: root } });
    let stderr = ""; child.stderr.on("data", chunk => { stderr += String(chunk); });
    const done = new Promise<number | null>((resolveExit, reject) => { child.once("error", reject); child.once("exit", resolveExit); });
    const deadline = Date.now() + 15_000;
    let sawBackoff = false;
    while (Date.now() < deadline) {
      const request = store.list("memory_maintenance_request", 1)[0];
      if (request?.status === "pending" && request.failures === 1 && typeof request.next_retry_at === "string") { sawBackoff = true; break; }
      await delay(50);
    }
    assert.equal(sawBackoff, true);
    assert.equal(await done, 0, stderr);
    const request = store.list("memory_maintenance_request", 1)[0];
    assert.equal(request?.status, "completed");
    assert.equal(request?.failures, 1);
    assert.equal(request?.next_retry_at, null);
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a failed backoff checkpoint leaves the durable request available for retry", { timeout: 20_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "craft-hook-backoff-checkpoint-"));
  const previousRoot = process.env.CRAFT_DATA_DIR;
  let store: CraftStore | undefined;
  try {
    process.env.CRAFT_DATA_DIR = root;
    store = await new CraftStore(craftPaths(root)).open();
    queueHookMaintenance(store, "codex-memory-backoff-checkpoint");
    const originalOpen = CraftService.open.bind(CraftService), originalSave = CraftStore.prototype.save;
    let injectedMaintenance = false, injectedSave = false;
    t.mock.method(CraftService, "open", async (...args: Parameters<typeof CraftService.open>) => {
      const service = await originalOpen(...args), schedule = service.memoryMaintenanceSchedule.bind(service);
      service.memoryMaintenanceSchedule = args => {
        if (!injectedMaintenance) { injectedMaintenance = true; throw new Error("transient maintenance"); }
        return schedule(args);
      };
      return service;
    });
    t.mock.method(CraftStore.prototype, "save", function (this: CraftStore, kind: string, id: string, payload: JsonObject, version?: number) {
      if (kind === "memory_maintenance_request" && payload.status === "pending" && payload.failures === 1 && !injectedSave) {
        injectedSave = true; throw new Error("transient checkpoint");
      }
      return originalSave.call(this, kind, id, payload, version);
    });
    await runMemoryArchiveWorker();
    assert.equal(injectedMaintenance, true);
    assert.equal(injectedSave, true);
    assert.equal(store.list("memory_maintenance_request", 1)[0]?.status, "completed");
  } finally {
    t.mock.restoreAll();
    if (previousRoot === undefined) delete process.env.CRAFT_DATA_DIR; else process.env.CRAFT_DATA_DIR = previousRoot;
    store?.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("non-Error maintenance failures are recorded safely and retried", { timeout: 10_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "craft-hook-unknown-failure-"));
  const previousRoot = process.env.CRAFT_DATA_DIR;
  let store: CraftStore | undefined;
  try {
    process.env.CRAFT_DATA_DIR = root;
    store = await new CraftStore(craftPaths(root)).open();
    queueHookMaintenance(store, "codex-unknown-failure");
    const legacyRequest = store.list("memory_maintenance_request", 1)[0]!;
    const { failures: _missingLegacyFailures, ...legacyPayload } = legacyRequest;
    store.save("memory_maintenance_request", String(legacyRequest.id), legacyPayload);
    assert.equal(store.list("memory_maintenance_request", 1)[0]?.failures, undefined);
    const open = CraftService.open.bind(CraftService), save = CraftStore.prototype.save;
    let failureRecorded = false, thrown = false;
    t.mock.method(CraftService, "open", async (...args: Parameters<typeof CraftService.open>) => {
      const service = await open(...args), schedule = service.memoryMaintenanceSchedule.bind(service);
      service.memoryMaintenanceSchedule = input => { if (!thrown) { thrown = true; throw "sensitive failure"; } return schedule(input); };
      return service;
    });
    t.mock.method(CraftStore.prototype, "save", function (this: CraftStore, kind: string, id: string, value: JsonObject, version?: number) {
      if (kind === "memory_maintenance_request" && value.last_error_type === "unknown") {
        assert(!JSON.stringify(value).includes("sensitive failure"));
        failureRecorded = true;
      }
      return save.call(this, kind, id, value, version);
    });
    await runMemoryArchiveWorker();
    assert.equal(failureRecorded, true);
    assert.equal(store.list("memory_maintenance_request", 1)[0]?.status, "completed");
  } finally {
    t.mock.restoreAll();
    if (previousRoot === undefined) delete process.env.CRAFT_DATA_DIR; else process.env.CRAFT_DATA_DIR = previousRoot;
    store?.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("archive failure without a persisted backoff is rate-limited before retry", { timeout: 10_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "craft-hook-archive-backoff-"));
  const previousRoot = process.env.CRAFT_DATA_DIR;
  try {
    process.env.CRAFT_DATA_DIR = root;
    let calls = 0;
    t.mock.method(MemoryFileStore.prototype, "runQueuedArchiveSteps", () => ++calls === 1
      ? { attempted: 1, outcomes: [{ status: "failed", backoff_recorded: false }] }
      : { attempted: 0, outcomes: [] });
    const started = performance.now();
    await runMemoryArchiveWorker();
    assert.equal(calls, 2);
    assert(performance.now() - started >= 900);
  } finally {
    t.mock.restoreAll();
    if (previousRoot === undefined) delete process.env.CRAFT_DATA_DIR; else process.env.CRAFT_DATA_DIR = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test("incomplete or reconciliation-required archives do not keep the worker waiting", { timeout: 10_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "craft-hook-archive-incomplete-"));
  const previousRoot = process.env.CRAFT_DATA_DIR;
  let store: CraftStore | undefined;
  try {
    process.env.CRAFT_DATA_DIR = root;
    store = await new CraftStore(craftPaths(root)).open();
    store.create("memory_session_archive", "reconcile", { status: "archiving", retry_state: "requires_reconciliation", session_id: "s", session_host: "codex" });
    store.create("memory_session_archive", "missing-session", { status: "archiving", session_host: "codex" });
    store.create("memory_session_archive", "missing-host", { status: "archiving", session_id: "s" });
    store.close(); store = undefined;
    t.mock.method(MemoryFileStore.prototype, "runQueuedArchiveSteps", () => ({ attempted: 0, outcomes: [] }));
    await runMemoryArchiveWorker();
  } finally {
    t.mock.restoreAll();
    if (previousRoot === undefined) delete process.env.CRAFT_DATA_DIR; else process.env.CRAFT_DATA_DIR = previousRoot;
    store?.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("waiter release failure also releases the acquired main lock", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-hook-waiter-release-")), previousRoot = process.env.CRAFT_DATA_DIR;
  const paths = craftPaths(root);
  let owner: (() => Promise<void>) | null = null;
  try {
    process.env.CRAFT_DATA_DIR = root;
    owner = await acquireLearningWorkerLocks(paths.runtimeDir, ["memory-session-archive"]);
    assert(owner);
    const worker = runMemoryArchiveWorker();
    const waiter = join(paths.runtimeDir, "learning-worker-memory-session-archive-waiter.lock.json");
    const deadline = Date.now() + 8_000;
    while (!existsSync(waiter) && Date.now() < deadline) await delay(20);
    assert(existsSync(waiter));
    writeFileSync(waiter, JSON.stringify({ pid: process.pid, owner_id: "changed-owner" }));
    await owner(); owner = null;
    await assert.rejects(worker, /lock ownership changed/u);
    const next = await acquireLearningWorkerLocks(paths.runtimeDir, ["memory-session-archive"]);
    assert(next);
    await next();
  } finally {
    if (owner) await owner();
    if (previousRoot === undefined) delete process.env.CRAFT_DATA_DIR; else process.env.CRAFT_DATA_DIR = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a single waiter automatically resumes after a long-held lock is released", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-hook-long-lock-"));
  const previousRoot = process.env.CRAFT_DATA_DIR;
  let store: CraftStore | undefined, release: (() => Promise<void>) | null = null;
  try {
    process.env.CRAFT_DATA_DIR = root;
    const paths = craftPaths(root);
    store = await new CraftStore(paths).open();
    queueHookMaintenance(store, "codex-memory-long-lock");
    release = await acquireLearningWorkerLocks(paths.runtimeDir, ["memory-session-archive"]);
    assert(release);
    const pending = runMemoryArchiveWorker();
    const waiterLock = join(paths.runtimeDir, "learning-worker-memory-session-archive-waiter.lock.json");
    const deadline = Date.now() + 5_000;
    while (!existsSync(waiterLock) && Date.now() < deadline) await delay(50);
    assert.equal(existsSync(waiterLock), true);
    await runMemoryArchiveWorker(); // A second contender must not wait or duplicate work.
    await delay(5_500);
    assert.equal(store.list("memory_maintenance_request", 1)[0]?.status, "pending");
    await release(); release = null;
    await pending;
    assert.equal(store.list("memory_maintenance_request", 1)[0]?.status, "completed");
    assert.equal(existsSync(waiterLock), false);
  } finally {
    await release?.();
    if (previousRoot === undefined) delete process.env.CRAFT_DATA_DIR; else process.env.CRAFT_DATA_DIR = previousRoot;
    store?.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("a replacement worker recovers a killed waiter's lock and processes its durable request", { timeout: 25_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-hook-dead-waiter-"));
  const paths = craftPaths(root);
  let store: CraftStore | undefined, release: (() => Promise<void>) | null = null;
  let first: ReturnType<typeof spawn> | undefined, second: ReturnType<typeof spawn> | undefined;
  try {
    store = await new CraftStore(paths).open();
    queueHookMaintenance(store, "codex-memory-dead-waiter");
    release = await acquireLearningWorkerLocks(paths.runtimeDir, ["memory-session-archive"]);
    assert(release);
    const workerUrl = pathToFileURL(resolve("core/interfaces/memory-archive-worker.ts")).href;
    const script = `import { runMemoryArchiveWorker } from ${JSON.stringify(workerUrl)}; await runMemoryArchiveWorker();`;
    const start = () => spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script],
      { cwd: process.cwd(), stdio: "ignore", env: { ...process.env, CRAFT_DATA_DIR: root } });
    const waiterLock = join(paths.runtimeDir, "learning-worker-memory-session-archive-waiter.lock.json");
    const deadline = Date.now() + 15_000;
    first = start();
    while (!existsSync(waiterLock) && Date.now() < deadline) await delay(50);
    assert.equal(existsSync(waiterLock), true);
    const stopped = new Promise<void>(resolveExit => first!.once("exit", () => resolveExit()));
    first.kill("SIGTERM"); await stopped;
    assert.equal(existsSync(waiterLock), true);
    second = start();
    const completed = new Promise<number | null>((resolveExit, reject) => { second!.once("error", reject); second!.once("exit", resolveExit); });
    while (Date.now() < deadline) {
      try {
        const lock = JSON.parse(readFileSync(waiterLock, "utf8")) as { pid: number };
        if (lock.pid === second.pid) break;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await delay(50);
    }
    assert.equal((JSON.parse(readFileSync(waiterLock, "utf8")) as { pid: number }).pid, second.pid);
    await release(); release = null;
    assert.equal(await completed, 0);
    assert.equal(store.list("memory_maintenance_request", 1)[0]?.status, "completed");
    assert.equal(existsSync(waiterLock), false);
  } finally {
    if (first && first.exitCode === null && first.signalCode === null) first.kill("SIGTERM");
    if (second && second.exitCode === null && second.signalCode === null) second.kill("SIGTERM");
    await release?.(); store?.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("SessionStart restarts an interrupted durable archive", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-hook-archive-restart-"));
  const sessionId = "restart-session", scope = sessionStorageScopeId("codex", sessionId);
  let store: CraftStore | undefined;
  try {
    store = await new CraftStore(craftPaths(root)).open();
    store.bindSessionStorageHost(sessionId, "codex");
    store.create("memory_candidate", "pending-candidate", { scope: { kind: "session", id: scope }, status: "candidate" });
    new MemoryFileStore(store).queueSessionArchive(sessionId, "codex");
    store.close(); store = undefined;
    const hook = spawn(process.execPath, ["--experimental-strip-types", resolve("bin/craft-codex-hook.ts"), "--member", "context"],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CRAFT_DATA_DIR: root, CRAFT_CONTINUOUS_LEARNING: "0" } });
    hook.stdout.resume(); hook.stderr.resume();
    hook.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", source: "codex", cwd: process.cwd(), session_id: "new-session" }));
    const exit = await new Promise<number | null>((resolveExit, reject) => { hook.once("error", reject); hook.once("exit", resolveExit); });
    assert.equal(exit, 0);
    store = await new CraftStore(craftPaths(root)).open();
    const deadline = Date.now() + 15_000;
    let archived = false;
    do {
      archived = store.list("memory_session_archive", 10).some(item => item.status === "archived");
      if (!archived) await delay(100);
    } while (!archived && Date.now() < deadline);
    assert.equal(archived, true);
    assert.equal(store.listSessionMemoryPage("memory_candidate", scope).records.length, 0);
    const lock = join(craftPaths(root).runtimeDir, "learning-worker-memory-session-archive.lock.json");
    while (existsSync(lock) && Date.now() < deadline) await delay(50);
    assert.equal(existsSync(lock), false);
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});
