import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";

test("contended writes yield to timers, execute once and restore the normal busy timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-write-retry-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const peer = new DatabaseSync(store.paths.databaseFile);
  let locked = false;
  try {
    const originalTimeout = store.database.prepare("PRAGMA busy_timeout").get()!.timeout;
    peer.exec("BEGIN IMMEDIATE"); locked = true;
    let heartbeat = false, calls = 0;
    const timer = setTimeout(() => { heartbeat = true; peer.exec("ROLLBACK"); locked = false; }, 60);
    try {
      const result = await store.transactionWithRetry(() => { calls++; return store.create("retry_test", "one", { value: 1 }); });
      assert.equal(result.id, "one"); assert.equal(calls, 1); assert.equal(heartbeat, true);
    } finally { clearTimeout(timer); }
    assert.equal(store.database.prepare("PRAGMA busy_timeout").get()!.timeout, originalTimeout);
    let executed = 0;
    await assert.rejects(store.transactionWithRetry(() => { executed++; store.create("retry_test", "rollback", {}); throw new Error("callback failure"); }), /callback failure/);
    assert.equal(executed, 1); assert.equal(store.find("retry_test", "rollback"), null);
    peer.exec("BEGIN IMMEDIATE"); locked = true;
    await assert.rejects(store.transactionWithRetry(() => { assert.fail("contended callback ran"); }, { timeoutMs: 0 }), error => (error as { safeDetails?: { phase?: string } }).safeDetails?.phase === "transaction_begin");
    const abort = new AbortController();
    const cancel = setTimeout(() => abort.abort(), 30);
    try { await assert.rejects(store.transactionWithRetry(() => assert.fail("cancelled callback ran"), { signal: abort.signal }), /abort/i); }
    finally { clearTimeout(cancel); }
    peer.exec("ROLLBACK"); locked = false;
    await assert.rejects(store.transactionWithRetry(() => 1, { timeoutMs: -1 }), /timeout/);
    await assert.rejects(store.transactionWithRetry(() => Promise.resolve(1)), /synchronous/);
    await store.readSnapshot(() => assert.rejects(store.transactionWithRetry(() => 1), /inside a transaction/));
    assert.equal(store.database.prepare("PRAGMA busy_timeout").get()!.timeout, originalTimeout);
  } finally { if (locked) peer.exec("ROLLBACK"); peer.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a writer in another process does not freeze the local event loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-write-process-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE');
    process.stdout.write('locked');
    setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, 200);
  `, store.paths.databaseFile], { stdio: ["ignore", "pipe", "ignore"] });
  const exit = once(child, "exit");
  try {
    await once(child.stdout!, "data");
    let ticks = 0, calls = 0;
    const timer = setInterval(() => { ticks++; }, 10);
    try { await store.transactionWithRetry(() => { calls++; store.create("retry_test", "cross-process", {}); }, { timeoutMs: 1000 }); }
    finally { clearInterval(timer); }
    assert.equal(calls, 1); assert.ok(ticks > 0);
    assert.equal((await exit)[0], 0);
  } finally { if (child.exitCode === null) child.kill(); await exit; store.close(); await rm(root, { recursive: true, force: true }); }
});
