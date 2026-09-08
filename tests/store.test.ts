import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
    store.close();
    await store.open();
    assert.equal(store.database.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value, String(SCHEMA_VERSION));
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

test("store refuses a database created by a newer Craft schema", async () => {
  const { root, store } = await fixture();
  try {
    store.database.prepare("UPDATE meta SET value='999' WHERE key='schema_version'").run();
    store.close();
    await assert.rejects(() => store.open(), /newer than supported/);
    assert.throws(() => store.database, /not open/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("versioned records and events provide the shared persistence primitives", async () => {
  const { root, store } = await fixture();
  try {
    assert.equal(store.save("thing", "a", { name: "one" }).version, 1);
    assert.equal(store.save("thing", "a", { name: "two" }).version, 2);
    assert.equal(store.save("thing", "b", { name: "other" }, 4).version, 4);
    assert.equal(store.create("thing", "immutable", { name: "fixed" }).version, 1);
    assert.throws(() => store.create("thing", "immutable", { name: "changed" }), /already exists/);
    const clean = store.save("thing", "clean", { name: "clean", id: "bad", version: 99, created_at: "old" });
    assert.notEqual(clean.id, "bad");
    assert.equal(store.count("thing"), 4);
    assert.deepEqual(store.saveBatch([]), []);
    assert.equal(store.saveBatch([{ kind: "thing", id: "batch", payload: { name: "batch" } }])[0].version, 1);
    assert.equal(store.updateIfVersion("thing", "batch", 1, { name: "updated" }).version, 2);
    assert.throws(() => store.updateIfVersion("thing", "batch", 1, {}), /Concurrent update/);
    assert.equal(store.get("thing", "a").name, "two");
    assert.equal(store.get("thing", "a", 1).name, "one");
    assert.deepEqual(store.list("thing", 500, (item) => item.name === "two").map((x) => x.id), ["a"]);
    assert.equal(store.list("thing", 0).length, 1);
    assert.throws(() => store.list("thing", Number.NaN), /finite integer/);
    assert.deepEqual(store.searchCapabilities([], 1), []);
    store.save("capability", "minimal", {});
    assert.equal(store.searchCapabilities(["missing"], 1).length, 0);
    store.save("capability", "ranked", { name: "needle", description: "searchable capability", body: "needle body" });
    assert.equal(store.searchCapabilities(["needle"], 1)[0].id, "ranked");
    store.remove("capability", "minimal");
    assert.throws(() => store.get("thing", "missing"), /Unknown thing/);
    assert.equal(store.appendEvent("a", "started", { ok: true }).sequence, 1);
    assert.equal(store.appendEvent("a", "finished", {}).sequence, 2);
    assert.deepEqual(store.events("a").map((x) => x.event_type), ["started", "finished"]);
    assert.equal(store.remove("thing", "a"), 2);
    assert.equal(store.remove("thing", "a"), 0);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("store preserves schema migration safety and uses keyword fallback when FTS5 is unavailable", async () => {
  const root = join(tmpdir(), `craft-store-fts-${process.pid}-${Date.now()}-${Math.random()}`);
  const paths = craftPaths(root);
  await mkdir(paths.databaseDir, { recursive: true });
  const database = new DatabaseSync(paths.databaseFile);
  database.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO meta(key,value) VALUES('schema_version','1');
    CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(kind,id,version));
    CREATE TABLE capability_fts(broken TEXT);`);
  database.close();
  const store = await new CraftStore(paths).open();
  try {
    assert.equal(store.database.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value, String(SCHEMA_VERSION));
    store.save("capability", "fallback", { name: "fallback needle", description: "keyword", body: "body" });
    store.save("capability", "fallback-two", { name: "needle two", description: "keyword", body: "needle" });
    assert.equal(store.searchCapabilities(["needle"], 2).length, 2);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
