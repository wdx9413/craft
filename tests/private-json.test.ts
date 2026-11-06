import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicPrivateJson } from "../core/infrastructure/paths.ts";

test("private JSON removes owned staging files after a real publication failure", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "craft-private-json-")); const target = join(root, "state.json");
  try {
    await fs.mkdir(target); await fs.writeFile(join(target, "keep"), "unchanged");
    await assert.rejects(atomicPrivateJson(target, { private: "fixture-only" }));
    assert.deepEqual(await fs.readdir(root), ["state.json"]);
    assert.equal(await fs.readFile(join(target, "keep"), "utf8"), "unchanged");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("private JSON closes partial writes and preserves the prior target", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "craft-private-json-")); const target = join(root, "state.json");
  const open = fs.open; let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  const failure = new Error("disk full");
  try {
    await fs.writeFile(target, "previous");
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      handle = await open(...args); const write = handle.writeFile.bind(handle);
      t.mock.method(handle, "writeFile", async () => { await write("partial"); throw failure; });
      return handle;
    }); syncBuiltinESMExports();
    await assert.rejects(atomicPrivateJson(target, { next: true }), (error) => error === failure);
    assert.equal(handle?.fd, -1); assert.equal(await fs.readFile(target, "utf8"), "previous");
    assert.deepEqual(await fs.readdir(root), ["state.json"]);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await fs.rm(root, { recursive: true, force: true }); }
});

test("private JSON never cleans a staging file whose exclusive open failed", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "craft-private-json-")); const target = join(root, "state.json");
  const open = fs.open; let foreign = "";
  try {
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      foreign = String(args[0]); await fs.writeFile(foreign, "other-writer"); return open(...args);
    }); syncBuiltinESMExports();
    await assert.rejects(atomicPrivateJson(target, {}), { code: "EEXIST" });
    assert.equal(await fs.readFile(foreign, "utf8"), "other-writer");
    await assert.rejects(fs.readFile(target), { code: "ENOENT" });
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await fs.rm(root, { recursive: true, force: true }); }
});

test("private JSON preserves write and close failures and does not publish after either", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "craft-private-json-")); const target = join(root, "state.json");
  const open = fs.open; const writeError = new Error("write failed"); const closeError = new Error("close failed");
  try {
    await fs.writeFile(target, "previous");
    for (const failWrite of [false, true]) {
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args); const close = handle.close.bind(handle);
        t.mock.method(handle, "close", async () => { await close(); throw closeError; });
        if (failWrite) t.mock.method(handle, "writeFile", async () => { throw writeError; });
        return handle;
      }); syncBuiltinESMExports();
      await assert.rejects(atomicPrivateJson(target, {}), (error) => {
        if (failWrite) { assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [writeError, closeError]); }
        else assert.equal(error, closeError);
        return true;
      });
      assert.equal(await fs.readFile(target, "utf8"), "previous"); assert.deepEqual(await fs.readdir(root), ["state.json"]);
      t.mock.restoreAll(); syncBuiltinESMExports();
    }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await fs.rm(root, { recursive: true, force: true }); }
});

test("private JSON tolerates an already absent staging file but surfaces cleanup failures", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "craft-private-json-")); const target = join(root, "state.json");
  const unlink = fs.unlink; const failure = new Error("publication failed"); const cleanup = new Error("cleanup denied");
  try {
    await fs.writeFile(target, "previous");
    t.mock.method(fs, "rename", async (source: Parameters<typeof fs.rename>[0]) => { await unlink(source); throw failure; }); syncBuiltinESMExports();
    await assert.rejects(atomicPrivateJson(target, {}), (error) => error === failure);
    assert.deepEqual(await fs.readdir(root), ["state.json"]);
    t.mock.restoreAll();
    t.mock.method(fs, "rename", async () => { throw failure; });
    t.mock.method(fs, "unlink", async () => { throw cleanup; }); syncBuiltinESMExports();
    await assert.rejects(atomicPrivateJson(target, {}), (error) => {
      assert.ok(error instanceof AggregateError); assert.match(error.message, /reconciliation/);
      assert.deepEqual(error.errors, [failure, cleanup]); return true;
    });
    assert.equal(await fs.readFile(target, "utf8"), "previous"); assert.equal((await fs.readdir(root)).length, 2);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await fs.rm(root, { recursive: true, force: true }); }
});

test("private JSON publishes complete concurrent writes and serializes before staging", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "craft-private-json-")); const target = join(root, "state.json");
  try {
    const values = Array.from({ length: 4 }, (_, index) => ({ index, body: "fixture".repeat(1000) }));
    await Promise.all(values.map((value) => atomicPrivateJson(target, value)));
    const saved = JSON.parse(await fs.readFile(target, "utf8"));
    assert.ok(values.some((value) => JSON.stringify(value) === JSON.stringify(saved)));
    assert.deepEqual(await fs.readdir(root), ["state.json"]);
    if (process.platform !== "win32") assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    await assert.rejects(atomicPrivateJson(join(root, "new", "state.json"), cyclic), /circular/i);
    assert.deepEqual(await fs.readdir(root), ["state.json"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
