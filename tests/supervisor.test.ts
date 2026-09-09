import assert from "node:assert/strict";
import { readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicPrivateJson, craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";
import { assertSupervisorOwner, LocalSupervisor, SupervisorClient } from "../src/supervisor.ts";

async function fixture(name: string) { const root = join(tmpdir(), `craft-supervisor-${name}-${process.pid}-${Date.now()}`); const paths = craftPaths(root); const store = await new CraftStore(paths).open(); const service = new CraftService(store); return { root, paths, store, service }; }
function raw(url: string, method: string, token: string, body: string): Promise<{ status: number; value: JsonObject }> { return new Promise((resolve, reject) => { const data = Buffer.from(body); const req = request(url, { method, headers: { authorization: `Bearer ${token}`, "content-length": data.length } }, (res) => { const chunks: Buffer[] = []; res.on("data", (chunk: Buffer) => chunks.push(chunk)); res.on("end", () => { try { resolve({ status: Number(res.statusCode), value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonObject }); } catch (error) { reject(error); } }); }); req.once("error", reject); req.end(data); }); }
function noAuth(url: string): Promise<number> { return new Promise((resolve, reject) => { const req = request(url, (res) => { res.resume(); res.on("end", () => resolve(Number(res.statusCode))); }); req.once("error", reject); req.end(); }); }

test("local Supervisor owns Host processes across authenticated client calls", async () => {
  const f = await fixture("lifecycle"); const supervisor = new LocalSupervisor(f.service, f.paths, { heartbeatMs: 20 });
  try {
    await assert.rejects(supervisor.start(-1), /port/); const state = await supervisor.start(0); await assert.rejects(supervisor.start(0), /already/);
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
