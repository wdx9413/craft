import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CapabilityLoader } from "../core/capability-loader.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-cap-loader-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  return { root, store, loader: new CapabilityLoader(store) };
}

test("describing a capability never loads it; ensureLoaded imports once and caches", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    f.loader.describe({ id: "knowledge", label: "知识", load: async () => { calls += 1; return { ready: true }; } });
    f.loader.describe({ id: "memory", label: "记忆", load: async () => { calls += 1; return { ready: true }; } });
    // Startup view: two descriptors, zero modules loaded.
    assert.equal(f.loader.loadedCount(), 0);
    assert.deepEqual(f.loader.catalog().map((item) => [item.id, item.loaded]), [["knowledge", false], ["memory", false]]);
    const first = await f.loader.ensureLoaded("knowledge");
    assert.deepEqual(first, { ready: true });
    assert.equal(f.loader.isLoaded("knowledge"), true);
    assert.equal(f.loader.isLoaded("memory"), false);
    // Second request reuses the cached module and does not re-import.
    await f.loader.ensureLoaded("knowledge");
    assert.equal(calls, 1);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("concurrent ensureLoaded shares a single in-flight import", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    f.loader.describe({ id: "codebase", label: "Codebase", load: () => new Promise((resolve) => { calls += 1; setTimeout(() => resolve({ ok: 1 }), 10); }) });
    const [a, b] = await Promise.all([f.loader.ensureLoaded("codebase"), f.loader.ensureLoaded("codebase")]);
    assert.equal(calls, 1);
    assert.deepEqual(a, { ok: 1 });
    assert.deepEqual(b, { ok: 1 });
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("unknown, duplicate and invalid descriptors are refused; a failed load can retry", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.loader.describe({ id: "", label: "x", load: async () => ({}) }), /id is required/);
    assert.throws(() => f.loader.describe({ id: "k", label: "x", load: undefined as never }), /load must be a function/);
    await assert.rejects(f.loader.ensureLoaded("missing"), /unknown capability/);
    let attempts = 0;
    f.loader.describe({ id: "flaky", label: "F", load: async () => { attempts += 1; if (attempts === 1) throw new Error("transient"); return { ok: true }; } });
    await assert.rejects(f.loader.ensureLoaded("flaky"), /transient/);
    assert.equal(f.loader.isLoaded("flaky"), false);
    assert.deepEqual(await f.loader.ensureLoaded("flaky"), { ok: true });
    f.loader.describe({ id: "dup", label: "D", load: async () => ({}) });
    assert.throws(() => f.loader.describe({ id: "dup", label: "D2", load: async () => ({}) }), /already described/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
