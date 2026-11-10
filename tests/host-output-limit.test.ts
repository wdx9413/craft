import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { executeHostProcess, stopWindowsHostProcessTree } from "../core/host-driver.ts";

test("a pre-cancelled Host request never spawns its executable", async () => {
  const controller = new AbortController(); controller.abort();
  const result = await executeHostProcess({ executable: "craft-nonexistent-executable", argv: [], cwd: process.cwd(), stdin: "", timeoutMs: 1000, outputLimit: 1024, signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, "");
});

test("an unavailable Host executable returns its startup error", async () => {
  await assert.rejects(executeHostProcess({ executable: "craft-nonexistent-executable", argv: [], cwd: process.cwd(), stdin: "", timeoutMs: 5000, outputLimit: 1024 }), /ENOENT/u);
});

test("a normal Host process completes with its output intact", async () => {
  const result = await executeHostProcess({ executable: process.execPath, argv: ["-e", "process.stdout.write('ok'); process.stderr.write('note');"], cwd: process.cwd(), stdin: "", timeoutMs: 5000, outputLimit: 1024 });
  assert.deepEqual([result.exitCode, result.stdout, result.stderr, result.timedOut, result.outputLimited], [0, "ok", "note", false, false]);
});

test("timeout force-stops a Host that ignores SIGTERM", { skip: process.platform === "win32" }, async () => {
  const result = await executeHostProcess({ executable: process.execPath,
    argv: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    cwd: process.cwd(), stdin: "", timeoutMs: 500, outputLimit: 1024 });
  assert.equal(result.timedOut, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.signal, "SIGKILL");
});

test("Host timeout stops descendants retaining its output pipe", { skip: process.platform === "win32" }, async () => {
  const descendant = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
  const program = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: 'inherit'}); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
  const result = await executeHostProcess({ executable: process.execPath, argv: ["-e", program], cwd: process.cwd(), stdin: "", timeoutMs: 500, outputLimit: 1024 });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
});

for (const stream of ["stdout", "stderr"] as const) {
  test(`Host output limit stops a process producing ${stream}`, async () => {
    const result = await executeHostProcess({ executable: process.execPath,
      argv: ["-e", `process.${stream}.write('x'.repeat(8192)); setTimeout(() => {}, 10000);`],
      cwd: process.cwd(), stdin: "", timeoutMs: 5000, outputLimit: 1024 });
    assert.equal(result.outputLimited, true);
    assert.equal(result.timedOut, false);
    assert.equal(Buffer.byteLength(result[stream]), 1024);
    assert.notEqual(result.exitCode, 0);
  });
}

test("Host force-stops an output producer that ignores SIGTERM", { skip: process.platform === "win32" }, async () => {
  const result = await executeHostProcess({ executable: process.execPath,
    argv: ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('x'.repeat(8192)); setInterval(() => {}, 1000);"],
    cwd: process.cwd(), stdin: "", timeoutMs: 5000, outputLimit: 1024 });
  assert.equal(result.outputLimited, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.signal, "SIGKILL");
});

test("cancellation during the grace period is not relabeled as a timeout", { skip: process.platform === "win32" }, async () => {
  const controller = new AbortController();
  const result = await executeHostProcess({ executable: process.execPath,
    argv: ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);"],
    cwd: process.cwd(), stdin: "", timeoutMs: 500, outputLimit: 1024,
    signal: controller.signal, observe: () => controller.abort() });
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.signal, "SIGKILL");
});


test("Windows tree termination uses bounded shell-free taskkill and rejects invalid process ids", async t => {
  const calls: any[][] = [];
  let failure: Error | null = null;
  const mocked = t.mock.method(childProcess, "execFile", (...args: any[]) => {
    calls.push(args);
    queueMicrotask(() => args[3](failure));
    return {} as ReturnType<typeof childProcess.execFile>;
  });
  syncBuiltinESMExports();
  try {
    for (const pid of [0, -1, 1.5, Infinity]) await assert.rejects(stopWindowsHostProcessTree(pid), /positive safe integer/u);
    assert.equal(calls.length, 0);
    await stopWindowsHostProcessTree(123);
    assert.match(calls[0][0], /System32[\\/]taskkill.exe$/u);
    assert.deepEqual(calls[0][1], ["/PID", "123", "/T", "/F"]);
    assert.deepEqual(calls[0][2], { windowsHide: true, timeout: 2000, maxBuffer: 16384 });
    failure = new Error("access denied");
    await assert.rejects(stopWindowsHostProcessTree(124), /access denied/u);
    // A PID that exited before cleanup makes taskkill return 128 (stderr is
    // localised); that is the desired end state, not an unconfirmed cleanup.
    const exited = Object.assign(new Error("Command failed: taskkill"), { code: 128 });
    failure = exited;
    await stopWindowsHostProcessTree(125);
    // Any other failure code must still surface, so real cleanup problems
    // cannot be hidden by the already-exited allowance.
    failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
    await assert.rejects(stopWindowsHostProcessTree(126), /permission denied/u);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("Windows cancellation waits for tree cleanup and does not hide cleanup failures", async t => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  for (const failure of [false, true]) {
    const stop = new AbortController();
    let callback: ((error: Error | null) => void) | undefined;
    let calls = 0;
    const mocked = t.mock.method(childProcess, "execFile", (...args: any[]) => {
      calls++;
      callback = args[3];
      if (!failure) process.kill(Number(args[1][1]), "SIGKILL");
      return {} as ReturnType<typeof childProcess.execFile>;
    });
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
    try {
      let settled = false;
      const running = executeHostProcess({ executable: process.execPath, argv: ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"], cwd: process.cwd(), stdin: "", timeoutMs: 5000, outputLimit: 1024, signal: stop.signal, observe: () => stop.abort() });
      const outcome = running.then(result => { settled = true; return result; }, error => { settled = true; throw error; });
      for (let attempt = 0; !callback && attempt < 500; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(callback, "taskkill must be invoked before the simulated deadline");
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(settled, false);
      assert.equal(calls, 1);
      callback(failure ? new Error("taskkill failed") : null);
      if (failure) await assert.rejects(outcome, /cleanup could not be confirmed/u);
      else assert.equal((await outcome).cancelled, true);
    } finally { Object.defineProperty(process, "platform", originalPlatform); mocked.mock.restore(); syncBuiltinESMExports(); }
  }
});

test("cancellation stops descendants even after the root closes without shared output pipes", { skip: process.platform === "win32" }, async () => {
  const stop = new AbortController();
  const descendant = "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);";
  const parent = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: ['ignore', 'pipe', 'ignore']}); child.stdout.once('data', () => process.stdout.write(String(child.pid))); setInterval(() => {}, 1000);`;
  const result = await executeHostProcess({ executable: process.execPath, argv: ["-e", parent], cwd: process.cwd(), stdin: "", timeoutMs: 5000, outputLimit: 1024, signal: stop.signal, observe: () => stop.abort() });
  const pid = Number(result.stdout);
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  try {
    let status = "running";
    for (let attempt = 0; attempt < 20; attempt++) {
      try { status = childProcess.execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim(); }
      catch (error) { if ((error as { status?: number }).status === 1) status = ""; else throw error; }
      if (!status || status.startsWith("Z")) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(!status || status.startsWith("Z"), `descendant remains live: ${status}`);
    assert.equal(result.cancelled, true);
  } finally { try { process.kill(pid, "SIGKILL"); } catch {} }
});


test("Host startup without a pid still closes before reporting a broken input stream", async t => {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.stdin.end = () => queueMicrotask(() => child.stdin.emit("error", new Error("simulated EPIPE")));
  child.kill = () => { queueMicrotask(() => child.emit("close", null, "SIGTERM")); return true; };
  const mocked = t.mock.method(childProcess, "spawn", () => child);
  syncBuiltinESMExports();
  try { await assert.rejects(executeHostProcess({ executable: "simulated", argv: [], cwd: process.cwd(), stdin: "", timeoutMs: 1000, outputLimit: 1024 }), /simulated EPIPE/u); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("Host handles cancellation during listener registration and removes startup-error listeners", async t => {
  const stop = new AbortController();
  const add = stop.signal.addEventListener.bind(stop.signal);
  const mocked = t.mock.method(stop.signal, "addEventListener", (...args: Parameters<AbortSignal["addEventListener"]>) => { stop.abort(); add(...args); });
  try {
    const result = await executeHostProcess({ executable: process.execPath, argv: ["-e", "setInterval(()=>{},1000)"], cwd: process.cwd(), stdin: "", timeoutMs: 5000, outputLimit: 1024, signal: stop.signal });
    assert.equal(result.cancelled, true);
  } finally { mocked.mock.restore(); }
  await assert.rejects(executeHostProcess({ executable: "craft-nonexistent-startup-with-signal", argv: [], cwd: process.cwd(), stdin: "", timeoutMs: 1000, outputLimit: 1024, signal: new AbortController().signal }), /ENOENT/u);
});
