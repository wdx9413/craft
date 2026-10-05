import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, SCHEMA_VERSION } from "../core/infrastructure/store.ts";

async function fixture(): Promise<{ root: string; store: CraftStore }> {
  const root = join(tmpdir(), `craft-store-${process.pid}-${Date.now()}-${Math.random()}`);
  await mkdir(root, { recursive: true });
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store };
}

test("latest-first ordering uses insertion order when timestamps tie", async () => {
  const { root, store } = await fixture();
  try {
    store.create("ordering", "z-first", { value: 1 });
    store.create("ordering", "a-last", { value: 2 });
    store.database.prepare("UPDATE records SET updated_at=? WHERE kind=?").run("2026-01-01T00:00:00.000Z", "ordering");
    assert.deepEqual(store.list("ordering").map((item) => item.id), ["a-last", "z-first"]);
    assert.deepEqual(store.list("ordering", 1, () => true).map((item) => item.id), ["a-last"]);
    store.save("ordering", "z-first", { value: 3 });
    store.database.prepare("UPDATE records SET updated_at=? WHERE kind=?").run("2026-01-01T00:00:00.000Z", "ordering");
    assert.equal(store.list("ordering", 1)[0].id, "z-first");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("version history remains bounded and excludes the current version", async () => {
  const { root, store } = await fixture();
  try {
    store.create("history", "item", { value: 1 });
    store.save("history", "item", { value: 2 });
    store.save("history", "item", { value: 3 });
    assert.deepEqual(store.history("history", "item", 3, 2).map(record => record.value), [2, 1]);
    assert.deepEqual(store.history("history", "item", 2, 1).map(record => record.value), [1]);
    assert.throws(() => store.history("history", "item", 0, 1), /history bounds/);
    assert.throws(() => store.history("history", "item", 3, 102), /history bounds/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

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

test("nested record operations share an atomic transaction with isolated savepoint rollback", async () => {
  const { root, store } = await fixture();
  try {
    store.transaction(() => {
      store.create("atomic", "outer", {});
      assert.throws(() => store.transaction(() => { store.create("atomic", "inner", {}); throw new Error("inner failure"); }), /inner failure/);
      store.create("atomic", "after", {});
    });
    assert.equal(store.find("atomic", "inner"), null);
    assert.ok(store.find("atomic", "outer"));
    assert.ok(store.find("atomic", "after"));
    assert.throws(() => store.transaction(() => { store.create("atomic", "rolled-back", {}); throw new Error("outer failure"); }), /outer failure/);
    assert.equal(store.find("atomic", "rolled-back"), null);
    store.create("atomic", "recovered", {});
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("migration payload updates and content hydration remain recoverable", async () => {
  const { root, store } = await fixture();
  try {
    store.create("migration", "one", { value: "before" });
    assert.equal(store.rawRecords().length, 1);
    assert.equal(store.rawRecords("migration")[0]!.payload.value, "before");
    store.replacePayload("migration", "one", 1, { value: "after", id: "cannot-overwrite" });
    assert.equal(store.get("migration", "one").value, "after");
    assert.throws(() => store.replacePayload("migration", "absent", 1, {}), /Unknown record/);
    store.replacePayloadBatch([]);
    assert.throws(() => store.replacePayloadBatch([{ kind: "migration", id: "one", version: 1, payload: { value: "partial" } }, { kind: "migration", id: "absent", version: 1, payload: {} }]), /Unknown record/);
    assert.equal(store.get("migration", "one").value, "after");
    store.replacePayloadBatch([{ kind: "migration", id: "one", version: 1, payload: { value: "committed" } }]);
    assert.equal(store.get("migration", "one").value, "committed");
    const ref = store.contentStore.writeSync({ kind: "knowledge", record_id: "body", version: 1, scope: "project:test", status: "candidate", sensitivity: "internal", source_id: "fixture", body: "readable body" });
    store.create("knowledge_claim", "body", { content_ref: ref });
    assert.equal(store.get("knowledge_claim", "body").content, "readable body");
    store.create("memory_ledger", "bad-ref", { content_ref: { path: "/missing" } });
    assert.equal(store.get("memory_ledger", "bad-ref").content_unavailable, true);
    for (const kind of ["episodic_memory", "semantic_memory", "unrelated_record"]) {
      store.create(kind, "compat-body", { content_ref: ref });
      assert.equal(store.get(kind, "compat-body").content, kind === "unrelated_record" ? undefined : "readable body");
    }
    store.create("legacy", "bad-string-ref", { content_ref: "invalid" });
    store.create("legacy", "bad-array-ref", { content_ref: [] });
    store.close();
    await store.open();
    assert.equal(store.get("knowledge_claim", "body").content, "readable body");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
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
    store.create("trace", "archived", {});
    store.create("trace_event", "event", {});
    store.create("trace_feedback", "feedback", {});
    assert.equal(store.removeTraceRecords("archived", ["event"], ["feedback"]), 3);
    assert.equal(store.find("trace_feedback", "feedback"), null);
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
