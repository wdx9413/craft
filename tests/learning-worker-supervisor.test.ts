import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import test from "node:test";
import { resolveLearningWorkerLaunch, startContextLearningWorker } from "../core/interfaces/learning-worker-supervisor.ts";

async function fixture(worker = "setInterval(() => {}, 1000);\n") {
  const root = await mkdtemp(join(tmpdir(), "craft-learning-supervisor-"));
  const bin = join(root, "bin"), deploy = join(root, "deploy", "experience-learning");
  await mkdir(bin, { recursive: true }); await mkdir(deploy, { recursive: true });
  const server = join(bin, "craft-mcp.cjs"), serverTs = join(bin, "craft-mcp.ts"), workerPath = join(deploy, "worker.ts");
  await writeFile(server, ""); await writeFile(serverTs, ""); await writeFile(workerPath, worker);
  return { root, server, serverTs, workerPath, close: () => rm(root, { recursive: true, force: true }) };
}

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

test("worker supervisor starts isolated Knowledge and Experience workers and skips unrelated products", async () => {
  const f = await fixture(); const failures: string[] = [], launches: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  try {
    const spawnWorker = ((_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      launches.push({ args, env: options.env });
      const child = new EventEmitter() as EventEmitter & { kill: () => boolean };
      child.kill = () => { queueMicrotask(() => child.emit("exit", 0)); return true; };
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const stopExperience = await startContextLearningWorker({ mode: "component-experience-daily", server_entrypoint: f.server, env: {}, spawn_process: spawnWorker });
    const stopKnowledge = await startContextLearningWorker({ mode: "component-knowledge-daily", server_entrypoint: f.server, env: {}, spawn_process: spawnWorker });
    const stopContextAgent = await startContextLearningWorker({ mode: "component-context-agent", server_entrypoint: f.server, env: {}, spawn_process: spawnWorker });
    const stopContext = await startContextLearningWorker({ mode: "component-context-complete", server_entrypoint: f.server, env: {}, spawn_process: spawnWorker });
    assert.equal(launches.length, 4);
    assert.deepEqual(JSON.parse(launches[0]!.env.CRAFT_EXPERIENCE_MCP_ARGS!), [realpathSync(f.server), "--product", "experience"]);
    assert.equal(launches[0]!.env.CRAFT_LEARNING_COMPONENTS, "experience");
    assert.deepEqual(JSON.parse(launches[1]!.env.CRAFT_EXPERIENCE_MCP_ARGS!), [realpathSync(f.server), "--product", "knowledge"]);
    assert.equal(launches[1]!.env.CRAFT_LEARNING_COMPONENTS, "knowledge");
    assert.deepEqual(JSON.parse(launches[2]!.env.CRAFT_EXPERIENCE_MCP_ARGS!), [realpathSync(f.server), "--surface", "component-context-complete"]);
    assert.equal(launches[2]!.env.CRAFT_LEARNING_COMPONENTS, "experience,knowledge");
    assert.deepEqual(JSON.parse(launches[3]!.env.CRAFT_EXPERIENCE_MCP_ARGS!), [realpathSync(f.server), "--surface", "component-context-complete"]);
    assert.equal(launches[3]!.env.CRAFT_LEARNING_COMPONENTS, "experience,knowledge");
    await Promise.all([stopExperience?.(), stopKnowledge?.(), stopContextAgent?.(), stopContext?.()]);
    assert.equal(await startContextLearningWorker({ mode: "component-memory-daily", server_entrypoint: f.server, env: {} }), undefined);
    assert.equal(await startContextLearningWorker({ mode: "component-context-daily", server_entrypoint: f.server, env: { CRAFT_CONTINUOUS_LEARNING: "0" } }), undefined);
    assert.equal(await startContextLearningWorker({ mode: "component-context-daily", server_entrypoint: f.server, env: {}, exists: () => false, on_failure: value => failures.push(value) }), undefined);
    assert.equal(await startContextLearningWorker({ mode: "component-context-daily", env: {}, on_failure: value => failures.push(value) }), undefined);
    assert.deepEqual(failures, ["worker_entrypoint_unavailable", "worker_entrypoint_unavailable"]);
  } finally { await f.close(); }
});

test("worker supervisor validates its shutdown bound and contains synchronous spawn failures", async () => {
  const f = await fixture(); const failures: string[] = [];
  try {
    for (const shutdown_timeout_ms of [0, 60_001]) await assert.rejects(startContextLearningWorker({ mode: "component-context-daily", server_entrypoint: f.server,
      env: {}, shutdown_timeout_ms }), /shutdown_timeout_ms/u);
    for (const restart_base_delay_ms of [0, 30_001]) await assert.rejects(startContextLearningWorker({ mode: "component-context-daily", server_entrypoint: f.server,
      env: {}, restart_base_delay_ms }), /restart_base_delay_ms/u);
    const spawnFailure = (() => { throw new Error("blocked"); }) as unknown as typeof import("node:child_process").spawn;
    const stopSpawnFailure = await startContextLearningWorker({ mode: "component-context-daily", server_entrypoint: f.server, env: {}, restart_base_delay_ms: 1,
      spawn_process: spawnFailure, on_failure: value => failures.push(value) });
    assert.equal(typeof stopSpawnFailure, "function");
    assert.deepEqual(failures, ["Error"]);
    await stopSpawnFailure?.();
    const nonErrorSpawnFailure = (() => { throw "blocked"; }) as unknown as typeof import("node:child_process").spawn;
    const stopNonErrorSpawnFailure = await startContextLearningWorker({ mode: "component-context-daily", server_entrypoint: f.server, env: {}, restart_base_delay_ms: 1,
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
    const stop = await startContextLearningWorker({ mode: "component-context-daily", server_entrypoint: f.server, env: {}, spawn_process: spawnFailure, on_failure: value => failures.push(value) });
    await new Promise(resolve => setImmediate(resolve)); await stop?.();
    assert.deepEqual(failures, ["Error"]);

    const invalidName = new EventEmitter() as EventEmitter & { kill: () => boolean };
    invalidName.kill = () => false;
    const spawnInvalidName = (() => { queueMicrotask(() => invalidName.emit("error", { name: "invalid name" })); return invalidName; }) as unknown as typeof import("node:child_process").spawn;
    const stopInvalidName = await startContextLearningWorker({ mode: "component-context-daily", server_entrypoint: f.server, env: {}, spawn_process: spawnInvalidName, on_failure: value => failures.push(value) });
    await new Promise(resolve => setImmediate(resolve)); await stopInvalidName?.();
    assert.deepEqual(failures, ["Error", "Error"]);

    const fakeExit = new EventEmitter() as EventEmitter & { kill: () => boolean };
    fakeExit.kill = () => false;
    const spawnExit = (() => { queueMicrotask(() => fakeExit.emit("exit", 7)); return fakeExit; }) as unknown as typeof import("node:child_process").spawn;
    const stopExited = await startContextLearningWorker({ mode: "component-context-daily", server_entrypoint: f.server, env: {}, spawn_process: spawnExit, on_failure: value => failures.push(value) });
    await new Promise(resolve => setImmediate(resolve)); await stopExited?.();
    assert.deepEqual(failures, ["Error", "Error", "worker_exit_7"]);
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
    const stop = await startContextLearningWorker({ mode: "component-context-daily", server_entrypoint: f.server, env: {}, restart_base_delay_ms: 5,
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
    const staleStop = await startContextLearningWorker({ mode: "component-context-daily", server_entrypoint: f.server, env: {}, restart_base_delay_ms: 5,
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
    const stop = await startContextLearningWorker({ mode: "component-context-daily", server_entrypoint: graceful.server, env: {}, shutdown_timeout_ms: 500 });
    await stop?.();
  } finally { await graceful.close(); }

  const f = await fixture("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n");
  try {
    const stop = await startContextLearningWorker({ mode: "component-context-daily", server_entrypoint: f.server, env: {}, shutdown_timeout_ms: 20 });
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
    const stop = await startContextLearningWorker({ mode: "component-context-daily", server_entrypoint: f.serverTs, env: {}, shutdown_timeout_ms: 5,
      spawn_process: spawnFake });
    assert.equal(launch?.args[0], "--experimental-strip-types");
    assert.equal(launch?.env.CRAFT_CONTINUOUS_LEARNING, "0");
    assert.equal(launch?.env.CRAFT_EXPERIENCE_MCP_COMMAND, process.execPath);
    assert.deepEqual(launch?.stdio, ["ignore", "ignore", "inherit"], "worker diagnostics reach MCP stderr while stdout stays off the protocol stream");
    await stop?.();
  } finally { await f.close(); }
});
