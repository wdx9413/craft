import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicPrivateJson, craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { assertSupervisorOwner, LocalSupervisor, SupervisorClient } from "../core/supervisor.ts";

async function fixture(name: string) { const root = join(tmpdir(), `craft-supervisor-${name}-${process.pid}-${Date.now()}`); const paths = craftPaths(root); const store = await new CraftStore(paths).open(); const service = new CraftService(store); return { root, paths, store, service }; }
function raw(url: string, method: string, token: string, body: string): Promise<{ status: number; value: JsonObject }> { return new Promise((resolve, reject) => { const data = Buffer.from(body); const req = request(url, { method, headers: { authorization: `Bearer ${token}`, "content-length": data.length } }, (res) => { const chunks: Buffer[] = []; res.on("data", (chunk: Buffer) => chunks.push(chunk)); res.on("end", () => { try { resolve({ status: Number(res.statusCode), value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonObject }); } catch (error) { reject(error); } }); }); req.once("error", reject); req.end(data); }); }
function noAuth(url: string): Promise<number> { return new Promise((resolve, reject) => { const req = request(url, (res) => { res.resume(); res.on("end", () => resolve(Number(res.statusCode))); }); req.once("error", reject); req.end(); }); }

test("Supervisor cleans its exclusively created partial lock and permits explicit retry", async (t) => {
  const f = await fixture("partial-lock"); const supervisor = new LocalSupervisor(f.service, f.paths);
  const lock = join(f.paths.runtimeDir, "supervisor.lock.json"); const open = fs.open;
  const failure = Object.assign(new Error("partial lock write failed"), { code: "EEXIST" });
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const created = await open(...args);
      if (args[0] === lock) {
        handle = created; const write = created.writeFile.bind(created);
        t.mock.method(created, "writeFile", async () => { await write("{partial"); throw failure; });
      }
      return created;
    }); syncBuiltinESMExports();
    await assert.rejects(supervisor.start(), (error) => error === failure);
    assert.equal(handle?.fd, -1); await assert.rejects(readFile(lock), { code: "ENOENT" });
    await assert.rejects(readFile(join(f.paths.runtimeDir, "supervisor.json")), { code: "ENOENT" });
    t.mock.restoreAll(); syncBuiltinESMExports();
    assert.equal((await supervisor.start()).status, "running"); await supervisor.close();
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Supervisor preserves lock write and close failures without publishing a listener", async (t) => {
  const f = await fixture("lock-close-failure"); const lock = join(f.paths.runtimeDir, "supervisor.lock.json");
  const open = fs.open; const writeError = new Error("write failed"); const closeError = new Error("close failed");
  try {
    for (const failWrite of [false, true]) {
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args); const close = handle.close.bind(handle);
        t.mock.method(handle, "close", async () => { await close(); throw closeError; });
        if (failWrite) t.mock.method(handle, "writeFile", async () => { throw writeError; });
        return handle;
      }); syncBuiltinESMExports();
      await assert.rejects(new LocalSupervisor(f.service, f.paths).start(), (error) => {
        if (failWrite) { assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [writeError, closeError]); }
        else assert.equal(error, closeError);
        return true;
      });
      await assert.rejects(readFile(lock), { code: "ENOENT" });
      await assert.rejects(readFile(join(f.paths.runtimeDir, "supervisor.json")), { code: "ENOENT" });
      t.mock.restoreAll(); syncBuiltinESMExports();
    }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Supervisor lock cleanup preserves replacements and reports uncertain filesystem ownership", async (t) => {
  const f = await fixture("lock-cleanup-failure"); const lock = join(f.paths.runtimeDir, "supervisor.lock.json");
  const open = fs.open; const lstat = fs.lstat; const unlink = fs.unlink;
  const failure = new Error("write failed"); const cleanup = new Error("cleanup denied"); const statError = new Error("identity unavailable");
  try {
    for (const scenario of ["absent", "replaced", "device-changed", "lstat-denied", "unlink-denied", "identity-unavailable"]) {
      let created: Awaited<ReturnType<typeof fs.open>> | undefined;
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        created = await open(...args); const write = created.writeFile.bind(created);
        if (scenario === "identity-unavailable") t.mock.method(created, "stat", async () => { throw statError; });
        t.mock.method(created, "writeFile", async () => {
          await write("partial");
          if (scenario === "absent") await unlink(lock);
          if (scenario === "replaced") { await fs.rename(lock, join(f.paths.runtimeDir, "retired-owned-lock")); await writeFile(lock, "other-owner"); }
          throw failure;
        });
        return created;
      });
      if (scenario === "device-changed" || scenario === "lstat-denied") t.mock.method(fs, "lstat", async (path: string) => {
        if (scenario === "lstat-denied") throw cleanup;
        const identity = await lstat(path); identity.dev += 1; return identity;
      });
      if (scenario === "unlink-denied") t.mock.method(fs, "unlink", async () => { throw cleanup; });
      syncBuiltinESMExports();
      await assert.rejects(new LocalSupervisor(f.service, f.paths).start(), (error) => {
        if (scenario === "absent") assert.equal(error, failure);
        else if (scenario === "identity-unavailable") {
          assert.ok(error instanceof Error); assert.match(error.message, /reconciliation/); assert.equal(error.cause, statError);
        } else {
          assert.ok(error instanceof AggregateError); assert.match(error.message, /reconciliation/); assert.equal(error.errors[0], failure);
          if (scenario === "replaced" || scenario === "device-changed") assert.match(String(error.errors[1]), /identity changed/);
          else assert.equal(error.errors[1], cleanup);
        }
        return true;
      });
      assert.equal(created?.fd, -1);
      if (scenario === "absent") await assert.rejects(readFile(lock), { code: "ENOENT" });
      else assert.equal(await readFile(lock, "utf8"), scenario === "replaced" ? "other-owner" : scenario === "identity-unavailable" ? "" : "partial");
      await assert.rejects(readFile(join(f.paths.runtimeDir, "supervisor.json")), { code: "ENOENT" });
      t.mock.restoreAll(); syncBuiltinESMExports(); await rm(lock, { force: true });
    }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("local Supervisor owns Host processes across authenticated client calls", async () => {
  const f = await fixture("lifecycle"); const supervisor = new LocalSupervisor(f.service, f.paths, { heartbeatMs: 20 });
  try {
    await assert.rejects(supervisor.start(-1), /port/); await assert.rejects(supervisor.startOrReuse(-1), /port/); const owned = await supervisor.startOrReuse(0); assert.equal(owned.owned, true); const state = owned.state; await assert.rejects(supervisor.start(0), /already/);
    const reused = await new LocalSupervisor(f.service, f.paths).startOrReuse(0); assert.equal(reused.owned, false); assert.equal(reused.state.url, state.url);
    const client = new SupervisorClient(f.paths); const health = await client.status(); assert.equal(health.status, "ok"); assert.equal(health.owner_id, f.service.hostRuns.ownerId); await new Promise((resolve) => setTimeout(resolve, 25));
    const task = f.service.taskOpen({ title: "supervised", goal: "run" }).task as JsonObject; f.service.codexDispatchPrepare({ dispatch_id: "dispatch", task_id: task.id, workspace: f.root, prompt: "inspect" });
    f.service.codexHost.executor = (execution) => new Promise((resolve) => execution.signal?.addEventListener("abort", () => resolve({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "", timedOut: false, cancelled: true, outputLimited: false }), { once: true }));
    const started = await client.call("POST", "/runs/start", { run_id: "run", host: "codex-cli", dispatch_id: "dispatch", prompt: "inspect" }); assert.equal((started.run as JsonObject).owner_id, f.service.hostRuns.ownerId);
    assert.equal((await client.call("GET", "/runs/run")).active, true); await client.call("POST", "/runs/run/cancel", { reason: "user" }); await f.service.hostRuns.wait("run"); assert.equal(((await client.call("GET", "/runs/run")).run as JsonObject).status, "cancelled");
    assert.equal((await raw(String(state.url) + "/health", "GET", "wrong", "{}")).status, 401); assert.equal((await raw(String(state.url) + "/health", "GET", supervisor.ownerId.slice(0, -1) + "x", "{}")).status, 401); assert.equal(await noAuth(String(state.url) + "/health"), 401); assert.equal((await raw(String(state.url) + "/missing", "GET", supervisor.ownerId, "{}")).status, 404); await assert.rejects(client.call("GET", "/missing"), /Not found/);
    assert.equal((await raw(String(state.url) + "/runs/start", "POST", supervisor.ownerId, "bad-json")).status, 400); assert.equal((await raw(String(state.url) + "/runs/start", "POST", supervisor.ownerId, "[]")).status, 422); assert.equal((await raw(String(state.url) + "/runs/start", "POST", supervisor.ownerId, "null")).status, 422); assert.equal((await raw(String(state.url) + "/runs/start", "POST", supervisor.ownerId, "")).status, 422);
    assert.equal((await raw(String(state.url) + "/runs/start", "POST", supervisor.ownerId, `{"x":"${"a".repeat(300_000)}"}`)).status, 413);
  } finally { await supervisor.close(); assert.equal((JSON.parse(await readFile(join(f.paths.runtimeDir, "supervisor.json"), "utf8")) as JsonObject).status, "stopped"); await assert.rejects(new SupervisorClient(f.paths).status(), /not running/); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Supervisor reclaims only a dead same-host owner and recovers its runs", async () => {
  const f = await fixture("recovery");
  try {
    await writeFile(join(f.paths.runtimeDir, "supervisor.lock.json"), JSON.stringify({ pid: 999, host: "test-host", owner_id: "old-owner", heartbeat_at: "2000-01-01T00:00:00Z" }));
    f.store.create("host_run", "old-run", { owner_id: "old-owner", status: "running", cancel_requested: false }); f.store.create("host_run", "other-run", { owner_id: "other-owner", status: "running", cancel_requested: false });
    const supervisor = new LocalSupervisor(f.service, f.paths, { host: "test-host", isProcessAlive: () => false }); await supervisor.start(0);
    assert.equal(f.store.get("host_run", "old-run").status, "interrupted"); assert.equal(f.store.get("host_run", "other-run").status, "running"); await supervisor.close();
    await writeFile(join(f.paths.runtimeDir, "supervisor.lock.json"), JSON.stringify({ pid: 999, host: "other-host", owner_id: "foreign", heartbeat_at: "2000-01-01T00:00:00Z" }));
    await assert.rejects(new LocalSupervisor(f.service, f.paths, { host: "test-host", isProcessAlive: () => false }).start(0), /already running/);
    await writeFile(join(f.paths.runtimeDir, "supervisor.lock.json"), JSON.stringify({ pid: 999, host: "test-host", owner_id: "live", heartbeat_at: "2000-01-01T00:00:00Z" }));
    await assert.rejects(new LocalSupervisor(f.service, f.paths, { host: "test-host", isProcessAlive: () => true }).start(0), /already running/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Supervisor recovery treats previous owner identities as data rather than file paths", async () => {
  const f = await fixture("opaque-owner");
  const supervisor = new LocalSupervisor(f.service, f.paths, { host: "test-host", isProcessAlive: () => false });
  try {
    const owners = ["../../outside/owner", "C:\\private\\owner\u0000", "x".repeat(1024)];
    for (const [index, ownerId] of owners.entries()) {
      const owner = { pid: 999, host: "test-host", owner_id: ownerId, heartbeat_at: "2000-01-01T00:00:00Z" };
      await writeFile(join(f.paths.runtimeDir, "supervisor.lock.json"), JSON.stringify(owner));
      f.store.create("host_run", `opaque-${index}`, { owner_id: ownerId, status: "running", cancel_requested: false });
      await supervisor.start();
      assert.equal(f.store.get("host_run", `opaque-${index}`).status, "interrupted");
      const digest = createHash("sha256").update(ownerId).digest("hex");
      const archives = (await readdir(f.paths.runtimeDir)).filter((name) => name.endsWith(`.${digest}.json`));
      assert.equal(archives.length, 1);
      assert.match(archives[0], /^supervisor\.lock\.recovered\.\d+\.[a-f0-9]{64}\.json$/);
      assert.deepEqual(JSON.parse(await readFile(join(f.paths.runtimeDir, archives[0]), "utf8")), owner);
      await supervisor.close();
    }
    assert.equal((await readdir(f.paths.runtimeDir)).filter((name) => name.startsWith("supervisor.lock.recovered.")).length, owners.length);
  } finally { await supervisor.close().catch(() => undefined); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Supervisor client rejects unsafe or unreachable saved endpoints and owner mismatch", async () => {
  const f = await fixture("client");
  try {
    assert.throws(() => new LocalSupervisor(f.service, f.paths, { ownerId: "wrong" }), /owner/); assert.throws(() => new LocalSupervisor(f.service, f.paths, { heartbeatMs: 1 }), /heartbeatMs/);
    const unused = new LocalSupervisor(f.service, f.paths); assert.equal(unused.isProcessAlive(process.pid), true); assert.equal(unused.isProcessAlive(2_147_483_647), false); assert.equal(unused.isProcessAlive(Number.NaN), true); await unused.close();
    await atomicPrivateJson(join(f.paths.runtimeDir, "supervisor.json"), { status: "running", url: "https://example.com", owner_id: "x" }); await assert.rejects(new SupervisorClient(f.paths).status(), /unsafe/); await atomicPrivateJson(join(f.paths.runtimeDir, "supervisor.json"), { status: "running", url: "https://127.0.0.1", owner_id: "x" }); await assert.rejects(new SupervisorClient(f.paths).status(), /unsafe/);
    await atomicPrivateJson(join(f.paths.runtimeDir, "supervisor.json"), { status: "running", url: "http://127.0.0.1:1", owner_id: "x" }); await assert.rejects(new SupervisorClient(f.paths).status());
    const invalid = createServer((_request, response) => response.end("not-json")); await new Promise<void>((resolve) => invalid.listen(0, "127.0.0.1", resolve)); const address = invalid.address(); await atomicPrivateJson(join(f.paths.runtimeDir, "supervisor.json"), { status: "running", url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`, owner_id: "x" }); await assert.rejects(new SupervisorClient(f.paths).status(), /JSON/); await new Promise<void>((resolve) => invalid.close(() => resolve()));
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Supervisor detects lock races and propagates filesystem failures", async () => {
  const f = await fixture("lock-races"); const supervisor = new LocalSupervisor(f.service, f.paths, { host: "test-host", isProcessAlive: () => false }); const privateApi = supervisor as unknown as { acquire(retry?: boolean): Promise<string | null>; heartbeat(): Promise<void>; release(): Promise<void> };
  try {
    assert.doesNotThrow(() => assertSupervisorOwner("same", "same")); assert.throws(() => assertSupervisorOwner("one", "two"), /changed/);
    await writeFile(join(f.paths.runtimeDir, "supervisor.lock.json"), JSON.stringify({ pid: 1, host: "test-host", owner_id: "existing" })); await assert.rejects(privateApi.acquire(false), /changed/);
    await writeFile(join(f.paths.runtimeDir, "supervisor.lock.json"), JSON.stringify({ pid: 1, host: "test-host", owner_id: "wrong" })); await assert.rejects(privateApi.heartbeat(), /ownership/); await assert.rejects(privateApi.release(), /ownership/);
    await unlink(join(f.paths.runtimeDir, "supervisor.lock.json")); await rm(f.paths.runtimeDir, { recursive: true, force: true }); await assert.rejects(privateApi.acquire(), /ENOENT|no such file/i);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Supervisor releases its lock when loopback listen fails and tolerates an already removed own lock", async () => {
  const a = await fixture("port-a"); const b = await fixture("port-b"); const first = new LocalSupervisor(a.service, a.paths);
  try {
    const state = await first.start(0); const port = Number(new URL(String(state.url)).port); await assert.rejects(new LocalSupervisor(b.service, b.paths).start(port));
    assert.equal(await readFile(join(b.paths.runtimeDir, "supervisor.lock.json"), "utf8").then(() => true).catch(() => false), false);
    await unlink(join(a.paths.runtimeDir, "supervisor.lock.json")); await first.close();
  } finally { a.store.close(); b.store.close(); await rm(a.root, { recursive: true, force: true }); await rm(b.root, { recursive: true, force: true }); }
});

test("Supervisor client cannot send its token to a URL selected through the request path", async () => {
  const f = await fixture("url-binding"); let unexpected = 0;
  const other = createServer((_request, response) => { unexpected += 1; response.end("{}"); });
  const supervisor = new LocalSupervisor(f.service, f.paths);
  try {
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const address = other.address(); assert.ok(address && typeof address === "object");
    await supervisor.start(); const client = new SupervisorClient(f.paths);
    for (const path of [`http://127.0.0.1:${address.port}/health`, `//127.0.0.1:${address.port}/health`, `/\\127.0.0.1:${address.port}/health`]) {
      await assert.rejects(client.call("GET", path), /unsafe endpoint/);
    }
    assert.equal(unexpected, 0); assert.equal((await client.status()).status, "ok");
    const state = JSON.parse(await readFile(join(f.paths.runtimeDir, "supervisor.json"), "utf8")) as JsonObject;
    const base = new URL(String(state.url));
    for (const credentials of ["name@", ":password@"]) {
      await assert.rejects(client.call("GET", `http://${credentials}${base.host}/health`), /unsafe endpoint/);
    }
  } finally { await supervisor.close(); await new Promise<void>((resolve) => other.close(() => resolve())); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Supervisor client rejects oversized, truncated and non-object responses", async () => {
  const f = await fixture("response-bounds");
  const server = createServer((request, response) => {
    if (request.url === "/oversized") response.end(JSON.stringify({ value: "a".repeat(256 * 1024) }));
    else if (request.url === "/truncated") { response.writeHead(200, { "content-length": "100" }); response.write("{"); setImmediate(() => response.destroy()); }
    else response.end(request.url === "/array" ? "[]" : request.url === "/scalar" ? "1" : "null");
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    await atomicPrivateJson(join(f.paths.runtimeDir, "supervisor.json"), { status: "running", url: `http://127.0.0.1:${address.port}`, owner_id: "test-token" });
    const client = new SupervisorClient(f.paths);
    await assert.rejects(client.call("GET", "/oversized"), /exceeds/);
    await assert.rejects(client.call("GET", "/truncated"), /aborted|reset|closed/i);
    for (const path of ["/array", "/null", "/scalar"]) await assert.rejects(client.call("GET", path), /object/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Supervisor client has a wall-clock deadline for a peer that never finishes", async () => {
  const f = await fixture("deadline");
  const server = createServer((_request, response) => { response.writeHead(200); response.write("{"); });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    await atomicPrivateJson(join(f.paths.runtimeDir, "supervisor.json"), { status: "running", url: `http://127.0.0.1:${address.port}`, owner_id: "test-token" });
    await assert.rejects(new SupervisorClient(f.paths).status(), /timed out/);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Supervisor startup releases its new lock when recovering previous runs fails", async () => {
  const f = await fixture("recovery-failure");
  const supervisor = new LocalSupervisor(f.service, f.paths, { host: "test-host", isProcessAlive: () => false });
  const lock = join(f.paths.runtimeDir, "supervisor.lock.json"); const original = f.service.hostRunRecover;
  try {
    await writeFile(lock, JSON.stringify({ pid: 999, host: "test-host", owner_id: "old-owner" }));
    const failure = new Error("recovery unavailable"); f.service.hostRunRecover = () => { throw failure; };
    await assert.rejects(supervisor.start(), (error) => error === failure);
    await assert.rejects(readFile(lock), { code: "ENOENT" });
    f.service.hostRunRecover = original;
    assert.equal((await supervisor.start()).status, "running");
  } finally { await supervisor.close(); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Supervisor startup closes its listener when publishing state fails and can restart", async () => {
  const f = await fixture("publish-failure"); const supervisor = new LocalSupervisor(f.service, f.paths);
  const statePath = join(f.paths.runtimeDir, "supervisor.json");
  const reservation = createServer(); await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address(); assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  try {
    await mkdir(statePath);
    await assert.rejects(supervisor.start(address.port), /EISDIR|EPERM|EEXIST/);
    await assert.rejects(noAuth(`http://127.0.0.1:${address.port}/health`), /ECONNREFUSED/);
    await assert.rejects(readFile(join(f.paths.runtimeDir, "supervisor.lock.json")), { code: "ENOENT" });
    await rm(statePath, { recursive: true });
    assert.equal((await supervisor.start(address.port)).status, "running");
  } finally { await rm(statePath, { recursive: true, force: true }); await supervisor.close(); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Supervisor startup preserves both failure causes and never removes a replacement owner lock", async () => {
  const f = await fixture("cleanup-failure"); const lock = join(f.paths.runtimeDir, "supervisor.lock.json");
  const supervisor = new LocalSupervisor(f.service, f.paths, { host: "test-host", isProcessAlive: () => false });
  try {
    await writeFile(lock, JSON.stringify({ pid: 999, host: "test-host", owner_id: "old-owner" }));
    const original = new Error("recovery failed");
    f.service.hostRunRecover = () => { writeFileSync(lock, JSON.stringify({ owner_id: "replacement" })); throw original; };
    await assert.rejects(supervisor.start(), (error) => {
      assert.ok(error instanceof AggregateError); assert.match(error.message, /reconciliation/);
      assert.equal(error.errors[0], original); assert.match(String(error.errors[1]), /ownership changed/); return true;
    });
    assert.deepEqual(JSON.parse(await readFile(lock, "utf8")), { owner_id: "replacement" });
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Supervisor startup closes a published endpoint when its first heartbeat fails", async () => {
  const f = await fixture("heartbeat-start-failure"); const supervisor = new LocalSupervisor(f.service, f.paths);
  const internal = supervisor as unknown as { heartbeat(): Promise<void> }; const heartbeat = internal.heartbeat;
  try {
    const failure = new Error("heartbeat unavailable"); internal.heartbeat = async () => { throw failure; };
    await assert.rejects(supervisor.start(), (error) => error === failure);
    const state = JSON.parse(await readFile(join(f.paths.runtimeDir, "supervisor.json"), "utf8")) as JsonObject;
    await assert.rejects(noAuth(`${state.url}/health`), /ECONNREFUSED/);
    await assert.rejects(readFile(join(f.paths.runtimeDir, "supervisor.lock.json")), { code: "ENOENT" });
    internal.heartbeat = heartbeat; assert.equal((await supervisor.start()).status, "running");
  } finally { await supervisor.close(); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Supervisor closes its endpoint after a scheduled heartbeat fails and reports handoff", async (t) => {
  const f = await fixture("heartbeat-failure"); const supervisor = new LocalSupervisor(f.service, f.paths, { heartbeatMs: 5 });
  const internal = supervisor as unknown as { heartbeat(): Promise<void> }; const heartbeat = internal.heartbeat;
  try {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const state = await supervisor.start(); let calls = 0;
    const failure = "non-error failure";
    internal.heartbeat = async () => { calls += 1; throw failure; };
    t.mock.timers.tick(15);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await assert.rejects(noAuth(`${state.url}/health`), /ECONNREFUSED/);
    assert.equal(calls, 1);
    await assert.rejects(supervisor.close(), (error) => { assert.ok(error instanceof Error); assert.equal(error.cause, failure); return true; });
    await assert.rejects(readFile(join(f.paths.runtimeDir, "supervisor.lock.json")), { code: "ENOENT" });
    const stopped = JSON.parse(await readFile(join(f.paths.runtimeDir, "supervisor.json"), "utf8"));
    assert.equal(stopped.status, "stopped"); assert.equal(stopped.handoff_required, true); assert.equal(JSON.stringify(stopped).includes(failure), false);
    internal.heartbeat = heartbeat;
    await supervisor.start(); await supervisor.close();
  } finally { t.mock.timers.reset(); await supervisor.close().catch(() => undefined); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Supervisor waits for an in-flight heartbeat on close without queueing more work", async (t) => {
  const f = await fixture("heartbeat-pending"); const supervisor = new LocalSupervisor(f.service, f.paths, { heartbeatMs: 5 });
  const internal = supervisor as unknown as { heartbeat(): Promise<void> };
  let finish!: () => void; const pending = new Promise<void>((resolve) => { finish = resolve; });
  try {
    t.mock.timers.enable({ apis: ["setInterval"] }); await supervisor.start(); let calls = 0;
    internal.heartbeat = async () => { calls += 1; await pending; };
    t.mock.timers.tick(50); assert.equal(calls, 1);
    let closed = false; const closing = supervisor.close().then(() => { closed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(closed, false);
    finish(); await closing; t.mock.timers.tick(50); assert.equal(calls, 1);
    const stopped = JSON.parse(await readFile(join(f.paths.runtimeDir, "supervisor.json"), "utf8")); assert.equal(stopped.handoff_required, false);
  } finally { finish(); t.mock.timers.reset(); await supervisor.close(); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Supervisor still closes its socket when owner drift prevents cleanup", async (t) => {
  const f = await fixture("heartbeat-owner-drift"); const supervisor = new LocalSupervisor(f.service, f.paths, { heartbeatMs: 5 });
  const lock = join(f.paths.runtimeDir, "supervisor.lock.json");
  try {
    t.mock.timers.enable({ apis: ["setInterval"] });
    let state = await supervisor.start(); await writeFile(lock, JSON.stringify({ owner_id: "replacement" }));
    await assert.rejects(supervisor.close(), /ownership changed/);
    await assert.rejects(noAuth(`${state.url}/health`), /ECONNREFUSED/);
    // Restore only this fixture's lock so the second scenario can start.
    await writeFile(lock, JSON.stringify({ owner_id: supervisor.ownerId })); await supervisor.close();
    state = await supervisor.start(); await writeFile(lock, JSON.stringify({ owner_id: "replacement" }));
    t.mock.timers.tick(5);
    await assert.rejects(supervisor.close(), (error) => {
      assert.ok(error instanceof AggregateError); assert.match(String(error.errors[0]), /heartbeat failed/); assert.match(String(error.errors[1]), /ownership changed/); return true;
    });
    await assert.rejects(noAuth(`${state.url}/health`), /ECONNREFUSED/);
    assert.equal(JSON.parse(await readFile(lock, "utf8")).owner_id, "replacement");
  } finally { t.mock.timers.reset(); await supervisor.close().catch(() => undefined); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
