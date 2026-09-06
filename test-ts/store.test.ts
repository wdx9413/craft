import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../src/paths.ts";
import { CraftStore, SCHEMA_VERSION } from "../src/store.ts";

async function fixture(): Promise<{ root: string; store: CraftStore }> {
  const root = join(tmpdir(), `craft-store-${process.pid}-${Date.now()}-${Math.random()}`);
  await mkdir(root, { recursive: true });
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store };
}

test("store initializes once, commits, and rolls back atomically", async () => {
  const { root, store } = await fixture();
  try {
    assert.equal((store.database.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value, String(SCHEMA_VERSION));
    assert.equal(await store.open(), store);
    store.transaction((db) => db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run("committed", "yes"));
    assert.throws(() => store.transaction((db) => {
      db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run("rolled_back", "no");
      throw new Error("stop");
    }), /stop/);
    assert.equal(store.database.prepare("SELECT value FROM meta WHERE key='committed'").get()?.value, "yes");
    assert.equal(store.database.prepare("SELECT value FROM meta WHERE key='rolled_back'").get(), undefined);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("closed stores reject access and legacy databases are only detected", async () => {
  const { root, store } = await fixture();
  try {
    assert.equal(store.legacyDatabaseDetected(), false);
    await writeFile(store.paths.legacyDatabaseFile, "legacy");
    assert.equal(store.legacyDatabaseDetected(), true);
    store.close();
    store.close();
    assert.throws(() => store.database, /not open/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
