import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { realpathSync } from "node:fs";
import { link, mkdir, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { acquireLearningWorkerLocks, learningWorkerOwnerAlive, resolveLearningWorkerLaunch, startContextLearningWorker } from "../core/interfaces/learning-worker-supervisor.ts";

async function fixture(worker = "setInterval(() => {}, 1000);\n") {
  const root = await mkdtemp(join(tmpdir(), "craft-learning-supervisor-"));
  const bin = join(root, "bin"), deploy = join(root, "deploy", "experience-learning");
  await mkdir(bin, { recursive: true }); await mkdir(deploy, { recursive: true });
  const server = join(bin, "craft-mcp.cjs"), serverTs = join(bin, "craft-mcp.ts"), workerPath = join(deploy, "worker.ts");
  await writeFile(server, ""); await writeFile(serverTs, ""); await writeFile(workerPath, worker);
  return { root, server, serverTs, workerPath, close: () => rm(root, { recursive: true, force: true }) };
}

function startWorker(f: Awaited<ReturnType<typeof fixture>>, options: Parameters<typeof startContextLearningWorker>[0]) {
  return startContextLearningWorker({ ...options, env: { CRAFT_DATA_DIR: f.root, ...options.env } });
}

test("worker owner liveness distinguishes dead processes from permission-denied probes", () => {
  assert.equal(learningWorkerOwnerAlive(12, () => undefined), true);
  assert.equal(learningWorkerOwnerAlive(12, () => { throw Object.assign(new Error("missing"), { code: "ESRCH" }); }), false);
  assert.equal(learningWorkerOwnerAlive(12, () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); }), true);
});

test("worker launch resolves source, packaged, built, and unavailable distributions", async () => {
  const f = await fixture();
  try {
    const directory = realpathSync(join(f.root, "bin")), source = realpathSync(f.workerPath), packaged = join(directory, "craft-experience-learning-worker.js");
    const built = join(realpathSync(f.root), "plugin", "craft-experience-learning-worker.js");
    assert.equal(resolveLearningWorkerLaunch(f.server, path => path === source)?.args[1], source);
    assert.equal(resolveLearningWorkerLaunch(f.server, path => path === packaged)?.args[0], packaged);
    assert.equal(resolveLearningWorkerLaunch(f.server, path => path === built)?.args[0], built);
    assert.equal(resolveLearningWorkerLaunch(f.server, () => false), null);
    assert.equal(resolveLearningWorkerLaunch(join(f.root, "missing.cjs")), null);
  } finally { await f.close(); }
});

test("worker supervisor starts one worker per free component and skips overlapping products", async () => {
  const f = await fixture(); const failures: string[] = [], skips: string[] = [], launches: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  try {
    const spawnWorker = ((_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      launches.push({ args, env: options.env });
      const child = new EventEmitter() as EventEmitter & { kill: () => boolean };
      child.kill = () => { queueMicrotask(() => child.emit("exit", 0)); return true; };
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const stopExperience = await startWorker(f, { mode: "component-experience-daily", server_entrypoint: f.server, env: {}, spawn_process: spawnWorker });
    const stopDuplicate = await startWorker(f, { mode: "component-experience-daily", server_entrypoint: f.server, env: {}, spawn_process: spawnWorker });
    assert.equal(typeof stopDuplicate, "function");
    await stopDuplicate?.();
    const stopKnowledge = await startWorker(f, { mode: "component-knowledge-daily", server_entrypoint: f.server, env: {}, spawn_process: spawnWorker });
    const stopContext = await startWorker(f, { mode: "component-context-agent", server_entrypoint: f.server, env: {}, spawn_process: spawnWorker, on_skip: value => skips.push(value) });
    assert.equal(launches.length, 2);
    assert.deepEqual(skips, ["worker_already_running"]);
    assert.deepEqual(JSON.parse(launches[0]!.env.CRAFT_EXPERIENCE_MCP_ARGS!), [realpathSync(f.server), "--product", "experience"]);
    assert.equal(launches[0]!.env.CRAFT_LEARNING_COMPONENTS, "experience");
    assert.equal(launches[0]!.env.CRAFT_LEARNING_COMPONENT_LOCKS_HELD, "experience");
    assert.deepEqual(JSON.parse(launches[1]!.env.CRAFT_EXPERIENCE_MCP_ARGS!), [realpathSync(f.server), "--product", "knowledge"]);
    assert.equal(launches[1]!.env.CRAFT_LEARNING_COMPONENTS, "knowledge");
    assert.equal(launches[1]!.env.CRAFT_LEARNING_COMPONENT_LOCKS_HELD, "knowledge");
    await stopContext?.();
    await Promise.all([stopExperience?.(), stopKnowledge?.()]);
    const stopContextAfterRelease = await startWorker(f, { mode: "component-context-agent", server_entrypoint: f.server, env: {}, spawn_process: spawnWorker });
    assert.deepEqual(JSON.parse(launches[2]!.env.CRAFT_EXPERIENCE_MCP_ARGS!), [realpathSync(f.server), "--surface", "component-context-complete"]);
    assert.equal(launches[2]!.env.CRAFT_LEARNING_COMPONENTS, "experience,knowledge");
    assert.equal(launches[2]!.env.CRAFT_LEARNING_COMPONENT_LOCKS_HELD, "experience,knowledge");
    await stopContextAfterRelease?.();
    await stopContext?.();
    assert.equal(await startWorker(f, { mode: "component-memory-daily", server_entrypoint: f.server, env: {} }), undefined);
    assert.equal(await startWorker(f, { mode: "component-context-daily", server_entrypoint: f.server, env: { CRAFT_CONTINUOUS_LEARNING: "0" } }), undefined);
    assert.equal(await startWorker(f, { mode: "component-context-daily", server_entrypoint: f.server, env: {}, exists: () => false, on_failure: value => failures.push(value) }), undefined);
    assert.equal(await startWorker(f, { mode: "component-context-daily", env: {}, on_failure: value => failures.push(value) }), undefined);
    assert.deepEqual(failures, ["worker_entrypoint_unavailable", "worker_entrypoint_unavailable"]);
  } finally { await f.close(); }
});

test("worker supervisor serializes concurrent MCP sessions and releases all component locks", async () => {
  const f = await fixture(); const skips: string[] = [], launches: string[] = [];
  try {
    const spawnWorker = ((command: string) => {
      launches.push(command);
      const child = new EventEmitter() as EventEmitter & { kill: (signal?: string) => boolean };
      child.kill = signal => { if (signal === "SIGTERM") queueMicrotask(() => child.emit("exit", 0)); return true; };
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const opts = { mode: "component-context-daily", server_entrypoint: f.server, env: {}, spawn_process: spawnWorker,
      on_skip: (reason: string) => skips.push(reason) };
    const [first, second] = await Promise.all([startWorker(f, opts), startWorker(f, opts)]);
    assert.equal(launches.length, 1);
    assert.equal([first, second].filter(Boolean).length, 2);
    assert.deepEqual(skips, ["worker_already_running"]);
    await Promise.all([first?.(), second?.()]);
    const knowledge = await startWorker(f, { ...opts, mode: "component-knowledge-daily" });
    const experience = await startWorker(f, { ...opts, mode: "component-experience-daily" });
    assert.equal(launches.length, 3, "both disjoint component workers may start after the combined worker releases its locks");
    await Promise.all([knowledge?.(), experience?.()]);
  } finally { await f.close(); }
});

test("worker lock publishes complete metadata atomically under concurrent startup", async () => {
  const f = await fixture();
  try {
    const runtimeDir = join(f.root, "runtime");
    let reachedLink!: () => void, openGate!: () => void;
    const entered = new Promise<void>(resolve => { reachedLink = resolve; });
    const gate = new Promise<void>(resolve => { openGate = resolve; });
    const atomicFileSystem = { link: async (source: Parameters<typeof link>[0], destination: Parameters<typeof link>[1]) => {
      reachedLink();
      await gate;
      assert.match(await readFile(source, "utf8"), /"owner_id":"[^"]+"/u);
      return link(source, destination);
    } };
    const pending = acquireLearningWorkerLocks(runtimeDir, ["knowledge"], { file_system: atomicFileSystem, runtime_version: (await import("../core/version.ts")).CRAFT_RELEASE_VERSION });
    await entered;
    const second = await acquireLearningWorkerLocks(runtimeDir, ["knowledge"], { file_system: atomicFileSystem });
    openGate();
    const first = await pending;
    assert.equal([first, second].filter(Boolean).length, 1);
    const lock = JSON.parse(await readFile(join(runtimeDir, "learning-worker-knowledge.lock.json"), "utf8"));
    assert.equal(lock.pid, process.pid);
    assert.equal(lock.runtime_version, (await import("../core/version.ts")).CRAFT_RELEASE_VERSION);
    await (first ?? second)?.();
  } finally { await f.close(); }
});

test("worker lock preserves link errors and tolerates staging-link cleanup failures", async () => {
  const f = await fixture();
  try {
    const runtimeDir = join(f.root, "runtime"); await mkdir(runtimeDir, { recursive: true });
    const lockPath = join(runtimeDir, "learning-worker-knowledge.lock.json");
    const denied = Object.assign(new Error("link denied"), { code: "EACCES" });
    await assert.rejects(acquireLearningWorkerLocks(runtimeDir, ["knowledge"], {
      file_system: { link: async () => { throw denied; } }
    }), /link denied/u);

    await writeFile(lockPath, JSON.stringify({ pid: process.pid, owner_id: "active-owner" }));
    const active = await acquireLearningWorkerLocks(runtimeDir, ["knowledge"], {
      file_system: { link: async () => { throw Object.assign(new Error("exists"), { code: "EEXIST" }); },
        unlink: async path => { if (String(path).includes(".creating.")) throw new Error("staging cleanup failed"); return unlink(path); } }
    });
    assert.equal(active, null, "a complete active lock remains authoritative if staging cleanup fails");

    const acquired = await acquireLearningWorkerLocks(runtimeDir, ["experience"], {
      file_system: { unlink: async path => { if (String(path).includes(".creating.")) throw new Error("staging cleanup failed"); return unlink(path); } }
    });
    assert.equal(typeof acquired, "function", "a published lock remains usable when only its staging name cannot be removed");
    await acquired?.();
  } finally { await f.close(); }
});

test("worker supervisor recovers dead-owner locks and fails closed on invalid lock state", async () => {
  const f = await fixture(); const failures: string[] = [], launches: string[] = [];
  try {
    const lockDir = join(f.root, "runtime"); const knowledgeLock = join(lockDir, "learning-worker-knowledge.lock.json");
    await mkdir(lockDir, { recursive: true });
    await writeFile(knowledgeLock, JSON.stringify({ pid: 999_999_999, owner_id: "stale-owner" }));
    const spawnWorker = ((command: string) => {
      launches.push(command);
      const child = new EventEmitter() as EventEmitter & { kill: (signal?: string) => boolean };
      child.kill = signal => { if (signal === "SIGTERM") queueMicrotask(() => child.emit("exit", 0)); return true; };
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const stop = await startWorker(f, { mode: "component-knowledge-daily", server_entrypoint: f.server, env: {}, spawn_process: spawnWorker });
    assert.equal(launches.length, 1);
    await stop?.();
    await writeFile(knowledgeLock, "not-json");
    assert.equal(await startWorker(f, { mode: "component-knowledge-daily", server_entrypoint: f.server, env: {}, spawn_process: spawnWorker,
      on_failure: reason => failures.push(reason) }), undefined);
    assert.deepEqual(failures, ["worker_lock_unavailable"]);
    assert.equal(launches.length, 1, "an unreadable lock must never start another worker");
  } finally { await f.close(); }
});

test("dead-owner lock recovery retains the new worker release version", async () => {
  const f = await fixture();
  try {
    const runtimeDir = join(f.root, "runtime");
    await mkdir(runtimeDir, { recursive: true });
    const path = join(runtimeDir, "learning-worker-experience.lock.json");
    await writeFile(path, JSON.stringify({ pid: 999_999_999, owner_id: "old-owner", runtime_version: "0.12.124" }));
    const release = await acquireLearningWorkerLocks(runtimeDir, ["experience"], { is_process_alive: () => false, runtime_version: "0.12.125" });
    assert.ok(release);
    assert.equal(JSON.parse(await readFile(path, "utf8")).runtime_version, "0.12.125");
    await release();
  } finally { await f.close(); }
});

test("concurrent stale-lock recovery admits only one new owner", async () => {
  const f = await fixture();
  try {
    const runtimeDir = join(f.root, "runtime");
    await mkdir(runtimeDir, { recursive: true });
    const path = join(runtimeDir, "learning-worker-knowledge.lock.json");
    await writeFile(path, JSON.stringify({ pid: 999_999_999, owner_id: "dead-owner" }));
    let enteredRecovery!: () => void, continueRecovery!: () => void;
    const entered = new Promise<void>(resolve => { enteredRecovery = resolve; });
    const gate = new Promise<void>(resolve => { continueRecovery = resolve; });
    const pending = acquireLearningWorkerLocks(runtimeDir, ["knowledge"], {
      file_system: { rename: async (from, to) => { enteredRecovery(); await gate; return rename(from, to); } }
    });
    await entered;
    assert.equal(await acquireLearningWorkerLocks(runtimeDir, ["knowledge"]), null);
    continueRecovery();
    const release = await pending;
    assert.ok(release);
    assert.equal(await acquireLearningWorkerLocks(runtimeDir, ["knowledge"]), null);
    await release();
    const next = await acquireLearningWorkerLocks(runtimeDir, ["knowledge"]);
    assert.ok(next);
    await next();
  } finally { await f.close(); }
});

test("worker lock fails closed when its guard database is corrupt", async () => {
  const f = await fixture();
  try {
    const runtimeDir = join(f.root, "runtime");
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, "learning-worker-knowledge.lock.json.guard.sqlite"), "not a sqlite database");
    await assert.rejects(acquireLearningWorkerLocks(runtimeDir, ["knowledge"]), /not a database/u);
  } finally { await f.close(); }
});

test("a real process holds the guard until death and a replacement recovers its lock", { timeout: 15_000 }, async () => {
  const f = await fixture();
  const runtimeDir = join(f.root, "runtime");
  const moduleUrl = pathToFileURL(join(process.cwd(), "core/infrastructure/learning-worker-lock.ts")).href;
  const script = `const { acquireLearningWorkerLocks } = await import(process.argv[1]);
    const release = await acquireLearningWorkerLocks(process.argv[2], ["knowledge"]);
    if (!release) process.exit(2);
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, moduleUrl, runtimeDir], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const [output] = await once(child.stdout!, "data");
    assert.match(String(output), /ready/u);
    assert.equal(await acquireLearningWorkerLocks(runtimeDir, ["knowledge"]), null);
    const ended = once(child, "exit");
    child.kill("SIGKILL");
    await ended;
    const replacement = await acquireLearningWorkerLocks(runtimeDir, ["knowledge"]);
    assert.ok(replacement);
    await replacement();
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const ended = once(child, "exit"); child.kill("SIGKILL"); await ended; }
    await f.close();
  }
});

test("worker supervisor never removes a lock after ownership changes", async () => {
  const f = await fixture(); const failures: string[] = [];
  try {
    const lockPath = join(f.root, "runtime", "learning-worker-experience.lock.json");
    const fake = new EventEmitter() as EventEmitter & { kill: (signal?: string) => boolean };
    fake.kill = signal => { if (signal === "SIGTERM") queueMicrotask(() => fake.emit("exit", 0)); return true; };
    const stop = await startWorker(f, { mode: "component-experience-daily", server_entrypoint: f.server, env: {},
      spawn_process: (() => fake) as unknown as typeof import("node:child_process").spawn,
      on_failure: reason => failures.push(reason) });
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, owner_id: "replacement-owner" }));
    await stop?.();
    assert.deepEqual(failures, ["worker_lock_release_failed"]);
    assert.equal(JSON.parse(await readFile(lockPath, "utf8")).owner_id, "replacement-owner");
  } finally { await f.close(); }
});

test("worker component locks release partial acquisitions and preserve changed stale owners", async () => {
  const f = await fixture();
  try {
    const runtimeDir = join(f.root, "runtime"), knowledgeLock = join(runtimeDir, "learning-worker-knowledge.lock.json");
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(knowledgeLock, JSON.stringify({ pid: process.pid, owner_id: "knowledge-owner" }));
    const acquired = await acquireLearningWorkerLocks(runtimeDir, ["experience", "knowledge"]);
    assert.equal(acquired, null, "the context lock must release Experience when Knowledge is already owned");
    const experienceOnly = await acquireLearningWorkerLocks(runtimeDir, ["experience"]);
    assert.equal(typeof experienceOnly, "function");
    await experienceOnly?.();

    await writeFile(knowledgeLock, JSON.stringify({ pid: 999_999_999, owner_id: "stale-owner" }));
    const replaceBeforeRecovery = {
      rename: async (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => {
        if (from === knowledgeLock) await writeFile(knowledgeLock, JSON.stringify({ pid: process.pid, owner_id: "replacement-owner" }));
        return rename(from, to);
      }
    };
    await assert.rejects(acquireLearningWorkerLocks(runtimeDir, ["knowledge"], { file_system: replaceBeforeRecovery,
      is_process_alive: () => false }), /changed during recovery/u);
    assert.equal(JSON.parse(await readFile(knowledgeLock, "utf8")).owner_id, "replacement-owner");

    const failRestore = {
      rename: async (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => {
        if (String(from).includes(".recovered.")) throw new Error("restore failed");
        if (from === knowledgeLock) await writeFile(knowledgeLock, JSON.stringify({ pid: process.pid, owner_id: "another-owner" }));
        return rename(from, to);
      }
    };
    await assert.rejects(acquireLearningWorkerLocks(runtimeDir, ["knowledge"], { file_system: failRestore,
      is_process_alive: () => false }), /changed during recovery/u);
  } finally { await f.close(); }
});

test("worker component locks fail closed when lock creation or metadata is invalid", async () => {
  const f = await fixture();
  try {
    const runtimeDir = join(f.root, "runtime"); await mkdir(runtimeDir, { recursive: true });
    const permissionDenied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    await assert.rejects(acquireLearningWorkerLocks(runtimeDir, ["knowledge"], {
      file_system: { open: (async () => { throw permissionDenied; }) as unknown as typeof open }
    }), /permission denied/u);
    const lockPath = join(runtimeDir, "learning-worker-knowledge.lock.json");
    await writeFile(lockPath, JSON.stringify({ pid: 0, owner_id: "" }));
    await assert.rejects(acquireLearningWorkerLocks(runtimeDir, ["knowledge"]), /lock is invalid/u);
  } finally { await f.close(); }
});

test("worker lock acquisition errors release previously acquired components", async () => {
  const f = await fixture();
  try {
    const runtimeDir = join(f.root, "runtime");
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, "learning-worker-knowledge.lock.json"), "invalid");
    await assert.rejects(acquireLearningWorkerLocks(runtimeDir, ["experience", "knowledge"]), SyntaxError);
    const release = await acquireLearningWorkerLocks(runtimeDir, ["experience"]);
    assert.ok(release);
    await release();
  } finally { await f.close(); }
});

test("worker lock acquisition reports cleanup failures with the original error", async () => {
  const f = await fixture();
  try {
    const runtimeDir = join(f.root, "runtime");
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, "learning-worker-knowledge.lock.json"), "invalid");
    await assert.rejects(acquireLearningWorkerLocks(runtimeDir, ["experience", "knowledge"], {
      file_system: { unlink: async path => {
        if (String(path).endsWith("learning-worker-experience.lock.json")) throw new Error("cleanup denied");
        return unlink(path);
      } }
    }), error => error instanceof AggregateError && error.errors[0] instanceof SyntaxError
      && error.errors[1] instanceof Error && error.errors[1].message === "cleanup denied");
  } finally { await f.close(); }
});

test("worker component lock cleanup preserves the primary write failure", async () => {
  const f = await fixture();
  try {
    const fakeOpen = (async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      return {
        writeFile: async () => { throw new Error("lock write failed"); },
        close: async () => { await handle.close(); throw new Error("lock close failed"); }
      } as unknown as Awaited<ReturnType<typeof open>>;
    }) as typeof open;
    await assert.rejects(acquireLearningWorkerLocks(join(f.root, "runtime"), ["knowledge"], {
      file_system: { open: fakeOpen, unlink: async () => { throw new Error("lock cleanup failed"); } }
    }), /lock write failed/u);

    const closeWorksOpen = (async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      return { writeFile: async () => { throw new Error("lock write failed"); }, close: () => handle.close() } as unknown as Awaited<ReturnType<typeof open>>;
    }) as typeof open;
    await assert.rejects(acquireLearningWorkerLocks(join(f.root, "runtime-cleanup"), ["knowledge"], {
      file_system: { open: closeWorksOpen }
    }), /lock write failed/u);
  } finally { await f.close(); }
});

test("worker supervisor releases earlier component locks when a later lock is occupied", async () => {
  const f = await fixture();
  try {
    const runtimeDir = join(f.root, "runtime"), knowledgeLock = join(runtimeDir, "learning-worker-knowledge.lock.json");
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(knowledgeLock, JSON.stringify({ pid: process.pid, owner_id: "knowledge-owner" }));
    const skips: string[] = [], launches: string[] = [];
    const spawnWorker = ((command: string) => {
      launches.push(command);
      const child = new EventEmitter() as EventEmitter & { kill: (signal?: string) => boolean };
      child.kill = signal => { if (signal === "SIGTERM") queueMicrotask(() => child.emit("exit", 0)); return true; };
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const context = await startWorker(f, { mode: "component-context-daily", server_entrypoint: f.server, env: {}, spawn_process: spawnWorker,
      on_skip: reason => skips.push(reason) });
    assert.equal(typeof context, "function");
    assert.deepEqual(skips, ["worker_already_running"]);
    await context?.();
    const experience = await startWorker(f, { mode: "component-experience-daily", server_entrypoint: f.server, env: {}, spawn_process: spawnWorker });
    assert.equal(launches.length, 1, "the partial Experience lock must have been released");
    await experience?.();
  } finally { await f.close(); }
});

test("worker supervisor validates its shutdown bound and contains synchronous spawn failures", async () => {
  const f = await fixture(); const failures: string[] = [];
  try {
    for (const shutdown_timeout_ms of [0, 60_001]) await assert.rejects(startWorker(f, { mode: "component-context-daily", server_entrypoint: f.server,
      env: {}, shutdown_timeout_ms }), /shutdown_timeout_ms/u);
    for (const restart_base_delay_ms of [0, 30_001]) await assert.rejects(startWorker(f, { mode: "component-context-daily", server_entrypoint: f.server,
      env: {}, restart_base_delay_ms }), /restart_base_delay_ms/u);
    const spawnFailure = (() => { throw new Error("blocked"); }) as unknown as typeof import("node:child_process").spawn;
    const stopSpawnFailure = await startWorker(f, { mode: "component-context-daily", server_entrypoint: f.server, env: {}, restart_base_delay_ms: 1,
      spawn_process: spawnFailure, on_failure: value => failures.push(value) });
    assert.equal(typeof stopSpawnFailure, "function");
    assert.deepEqual(failures, ["Error"]);
    await stopSpawnFailure?.();
    const nonErrorSpawnFailure = (() => { throw "blocked"; }) as unknown as typeof import("node:child_process").spawn;
    const stopNonErrorSpawnFailure = await startWorker(f, { mode: "component-context-daily", server_entrypoint: f.server, env: {}, restart_base_delay_ms: 1,
      spawn_process: nonErrorSpawnFailure, on_failure: value => failures.push(value) });
    assert.equal(typeof stopNonErrorSpawnFailure, "function");
    assert.deepEqual(failures, ["Error", "Error"]);
    await stopNonErrorSpawnFailure?.();
  } finally { await f.close(); }
});

test("worker supervisor contains asynchronous startup errors and nonzero exits", async () => {
  const f = await fixture(), failures: string[] = [];
  try {
    const fake = new EventEmitter() as EventEmitter & { kill: () => boolean };
    fake.kill = () => false;
    const spawnFailure = (() => { queueMicrotask(() => fake.emit("error", new Error("spawn failure"))); return fake; }) as unknown as typeof import("node:child_process").spawn;
    const stop = await startWorker(f, { mode: "component-context-daily", server_entrypoint: f.server, env: {}, spawn_process: spawnFailure, on_failure: value => failures.push(value) });
    await new Promise(resolve => setImmediate(resolve)); await stop?.();
    assert.deepEqual(failures, ["Error"]);

    const invalidName = new EventEmitter() as EventEmitter & { kill: () => boolean };
    invalidName.kill = () => false;
    const spawnInvalidName = (() => { queueMicrotask(() => invalidName.emit("error", { name: "invalid name" })); return invalidName; }) as unknown as typeof import("node:child_process").spawn;
    const stopInvalidName = await startWorker(f, { mode: "component-context-daily", server_entrypoint: f.server, env: {}, spawn_process: spawnInvalidName, on_failure: value => failures.push(value) });
    await new Promise(resolve => setImmediate(resolve)); await stopInvalidName?.();
    assert.deepEqual(failures, ["Error", "Error"]);

    const fakeExit = new EventEmitter() as EventEmitter & { kill: () => boolean };
    fakeExit.kill = () => false;
    const spawnExit = (() => { queueMicrotask(() => fakeExit.emit("exit", 7)); return fakeExit; }) as unknown as typeof import("node:child_process").spawn;
    const stopExited = await startWorker(f, { mode: "component-context-daily", server_entrypoint: f.server, env: {}, spawn_process: spawnExit, on_failure: value => failures.push(value) });
    await new Promise(resolve => setImmediate(resolve)); await stopExited?.();
    assert.deepEqual(failures, ["Error", "Error", "worker_exit_7"]);
  } finally { await f.close(); }
});

test("worker supervisor releases ownership when an upgrade removes its old payload", async () => {
  for (const removed of ["server", "worker"]) {
    const f = await fixture(), failures: string[] = [];
    let launches = 0;
    const child = new EventEmitter() as ChildProcess;
    const spawnWorker = (() => { launches++; return child; }) as typeof import("node:child_process").spawn;
    try {
      const stop = await startWorker(f, { mode: "component-context-daily", server_entrypoint: f.server,
        restart_base_delay_ms: 1, spawn_process: spawnWorker, on_failure: reason => failures.push(reason) });
      await unlink(removed === "server" ? f.server : f.workerPath);
      child.emit("exit", 1);
      for (let attempt = 0; attempt < 50 && !failures.includes("worker_payload_removed"); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 2));
      }
      await stop?.(); await stop?.();
      assert.equal(launches, 1, "a removed payload must not be restarted indefinitely");
      assert.deepEqual(failures, ["worker_exit_1", "worker_payload_removed"]);
      const release = await acquireLearningWorkerLocks(join(f.root, "runtime"), ["experience", "knowledge"]);
      assert.ok(release, "another runtime must be able to acquire the released ownership");
      await release();
    } finally { await f.close(); }
  }
});

test("concurrent supervisor stops retain ownership until the child exits", async () => {
  const f = await fixture();
  const child = new EventEmitter() as ChildProcess;
  child.kill = () => true;
  const spawnWorker = (() => child) as typeof import("node:child_process").spawn;
  try {
    const stop = await startWorker(f, { mode: "component-context-daily", server_entrypoint: f.server, spawn_process: spawnWorker });
    const stopping = stop!();
    await stop!();
    assert.equal(await acquireLearningWorkerLocks(join(f.root, "runtime"), ["knowledge"]), null);
    child.emit("exit", 0);
    await stopping;
    const release = await acquireLearningWorkerLocks(join(f.root, "runtime"), ["knowledge"]);
    assert.ok(release);
    await release();
  } finally { await f.close(); }
});

test("worker supervisor restarts crashed workers with backoff and stops the replacement cleanly", async () => {
  const f = await fixture(), failures: string[] = [], children: Array<EventEmitter & { kill: (signal?: string) => boolean }> = [];
  try {
    const spawnRestart = (() => {
      const child = new EventEmitter() as EventEmitter & { kill: (signal?: string) => boolean };
      child.kill = signal => { if (signal === "SIGTERM") child.emit("exit", null); return true; };
      children.push(child);
      if (children.length === 1) queueMicrotask(() => child.emit("error", { name: "invalid name" }));
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const stop = await startWorker(f, { mode: "component-context-daily", server_entrypoint: f.server, env: {}, restart_base_delay_ms: 5,
      spawn_process: spawnRestart, on_failure: value => failures.push(value) });
    for (let attempt = 0; attempt < 50 && children.length < 2; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(children.length, 2, "an exited worker must restart after its bounded backoff");
    assert.deepEqual(failures, ["Error"]);
    children[0]?.emit("exit", 7);
    assert.deepEqual(failures, ["Error"], "late exits from the previous child are ignored");
    await stop?.();
    assert.equal(children[1]?.listenerCount("exit"), 0);

    const staleChildren: Array<EventEmitter & { kill: (signal?: string) => boolean }> = [];
    const spawnAfterExit = (() => {
      const child = new EventEmitter() as EventEmitter & { kill: (signal?: string) => boolean };
      child.kill = signal => { if (signal === "SIGTERM") child.emit("exit", null); return true; };
      staleChildren.push(child);
      if (staleChildren.length === 1) queueMicrotask(() => child.emit("exit", 9));
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const staleStop = await startWorker(f, { mode: "component-context-daily", server_entrypoint: f.server, env: {}, restart_base_delay_ms: 5,
      spawn_process: spawnAfterExit, on_failure: value => failures.push(value) });
    for (let attempt = 0; attempt < 50 && staleChildren.length < 2; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(staleChildren.length, 2);
    assert.deepEqual(failures, ["Error", "worker_exit_9"]);
    staleChildren[0]?.emit("error", new Error("late error"));
    assert.deepEqual(failures, ["Error", "worker_exit_9"], "late errors from a replaced child are ignored");
    await staleStop?.();
  } finally { await f.close(); }
});

test("worker supervisor gracefully stops and force-stops an unresponsive child", async () => {
  const graceful = await fixture();
  try {
    const stop = await startWorker(graceful, { mode: "component-context-daily", server_entrypoint: graceful.server, env: {}, shutdown_timeout_ms: 500 });
    await stop?.();
  } finally { await graceful.close(); }

  const f = await fixture("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n");
  try {
    const stop = await startWorker(f, { mode: "component-context-daily", server_entrypoint: f.server, env: {}, shutdown_timeout_ms: 20 });
    assert.equal(typeof stop, "function");
    await stop?.();
    await stop?.();
  } finally { await f.close(); }
});

test("worker supervisor launches TypeScript MCP without recursion and settles a kill/exit race", async () => {
  const f = await fixture();
  try {
    const fake = new EventEmitter() as EventEmitter & { kill: (signal?: string) => boolean };
    fake.kill = signal => { if (signal === "SIGKILL") fake.emit("exit", null); return true; };
    let launch: { entrypoint: string; args: string[]; env: NodeJS.ProcessEnv; stdio?: unknown } | undefined;
    const spawnFake = ((entrypoint: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio?: unknown }) => {
      launch = { entrypoint, args, env: options.env, stdio: options.stdio }; return fake;
    }) as unknown as typeof import("node:child_process").spawn;
    const stop = await startWorker(f, { mode: "component-context-daily", server_entrypoint: f.serverTs, env: {}, shutdown_timeout_ms: 5,
      spawn_process: spawnFake });
    assert.equal(launch?.args[0], "--experimental-strip-types");
    assert.equal(launch?.env.CRAFT_CONTINUOUS_LEARNING, "0");
    assert.equal(launch?.env.CRAFT_EXPERIENCE_MCP_COMMAND, process.execPath);
    assert.deepEqual(launch?.stdio, ["ignore", "ignore", "inherit"], "worker diagnostics reach MCP stderr while stdout stays off the protocol stream");
    await stop?.();
  } finally { await f.close(); }
});


test("waiting supervisor takes ownership after release and cancels cleanly", async () => {
  const f = await fixture(); const children: ChildProcess[] = [];
  const spawnWorker = (() => {
    const child = new EventEmitter() as ChildProcess;
    child.kill = () => { queueMicrotask(() => child.emit("exit", 0)); return true; };
    children.push(child); return child;
  }) as typeof import("node:child_process").spawn;
  try {
    const opts = { mode: "component-knowledge-daily", server_entrypoint: f.server, env: {}, spawn_process: spawnWorker, restart_base_delay_ms: 5, on_skip: () => {} };
    const owner = await startWorker(f, opts);
    const waiting = await startWorker(f, opts);
    assert.equal(children.length, 1);
    await new Promise(resolve => setTimeout(resolve, 12));
    assert.equal(children.length, 1);
    await owner?.();
    for (let i = 0; i < 100 && children.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(children.length, 2);
    await waiting?.();
    const cancelOwner = await startWorker(f, opts);
    const cancelled = await startWorker(f, opts);
    await cancelled?.(); await cancelOwner?.();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(children.length, 3);
  } finally { await f.close(); }
});


test("waiting supervisor reports lock errors and releases an acquisition racing shutdown", async () => {
  const f = await fixture(); const failures: string[] = [];
  try {
    let calls = 0;
    const failRetry: typeof acquireLearningWorkerLocks = async () => {
      if (++calls === 1) return null;
      throw new Error("storage unavailable");
    };
    const failed = await startWorker(f, { mode: "component-knowledge-daily", server_entrypoint: f.server,
      restart_base_delay_ms: 1, acquire_locks: failRetry, on_skip: () => {}, on_failure: reason => failures.push(reason) });
    for (let i = 0; i < 100 && !failures.length; i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.deepEqual(failures, ["worker_lock_unavailable"]);
    await failed?.();

    let completeAcquire!: (release: () => Promise<void>) => void;
    let acquired = false, released = false, launches = 0; calls = 0;
    const delayed: typeof acquireLearningWorkerLocks = async () => {
      if (++calls === 1) return null;
      acquired = true;
      return await new Promise(resolve => { completeAcquire = resolve; });
    };
    const waiting = await startWorker(f, { mode: "component-knowledge-daily", server_entrypoint: f.server,
      restart_base_delay_ms: 1, acquire_locks: delayed, on_skip: () => {},
      spawn_process: (() => { launches++; return new EventEmitter(); }) as unknown as typeof import("node:child_process").spawn });
    for (let i = 0; i < 100 && !acquired; i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(acquired, true);
    const stopping = waiting!();
    completeAcquire(async () => { released = true; });
    await stopping;
    assert.equal(released, true);
    assert.equal(launches, 0);
  } finally { await f.close(); }
});


test("waiting supervisor hands off a real worker process after lock release", async () => {
  const f = await fixture();
  try {
    const opts = { mode: "component-knowledge-daily", server_entrypoint: f.server, env: {}, restart_base_delay_ms: 5,
      shutdown_timeout_ms: 500, on_skip: () => {} };
    const owner = await startWorker(f, opts);
    const waiting = await startWorker(f, opts);
    const path = join(f.root, "runtime", "learning-worker-knowledge.lock.json");
    const before = JSON.parse(await readFile(path, "utf8")).owner_id;
    await owner?.();
    let after = before;
    for (let i = 0; i < 100 && after === before; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      try { after = JSON.parse(await readFile(path, "utf8")).owner_id; } catch { /* Wait for the next acquisition. */ }
    }
    assert.notEqual(after, before);
    await waiting?.();
    const release = await acquireLearningWorkerLocks(join(f.root, "runtime"), ["knowledge"]);
    assert.ok(release); await release();
  } finally { await f.close(); }
});
