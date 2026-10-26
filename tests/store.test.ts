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
    const find = store.find.bind(store);
    let pointLookups = 0;
    store.find = ((...args: Parameters<CraftStore["find"]>) => { pointLookups += 1; return find(...args); }) as CraftStore["find"];
    assert.deepEqual(store.list("ordering").map((item) => item.id), ["a-last", "z-first"]);
    assert.equal(pointLookups, 0, "a latest-first list must hydrate its selected snapshot rows without N+1 point reads");
    assert.deepEqual(store.list("ordering", 1, () => true).map((item) => item.id), ["a-last"]);
    store.save("ordering", "z-first", { value: 3 });
    store.database.prepare("UPDATE records SET updated_at=? WHERE kind=?").run("2026-01-01T00:00:00.000Z", "ordering");
    assert.equal(store.list("ordering", 1)[0].id, "z-first");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("read snapshots keep a consistent read while allowing another store to write", async () => {
  const { root, store } = await fixture();
  const writer = await new CraftStore(craftPaths(root)).open();
  try {
    store.create("snapshot", "before", { value: 1 });
    const observed = store.readSnapshot((database) => {
      const before = Number((database.prepare("SELECT COUNT(*) AS count FROM records WHERE kind=?").get("snapshot") as { count: number }).count);
      writer.create("snapshot", "during", { value: 2 });
      const during = Number((database.prepare("SELECT COUNT(*) AS count FROM records WHERE kind=?").get("snapshot") as { count: number }).count);
      return { before, during };
    });
    assert.deepEqual(observed, { before: 1, during: 1 });
    assert.equal(store.list("snapshot").length, 2);
    assert.equal(store.transaction(() => store.readSnapshot(() => "nested")), "nested");
    assert.throws(() => store.readSnapshot(() => { throw new Error("snapshot failed"); }), /snapshot failed/u);
    assert.equal(store.readSnapshot((database) => Number((database.prepare("SELECT COUNT(*) AS count FROM records WHERE kind=?").get("snapshot") as { count: number }).count)), 2);
  } finally { writer.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("ID-ordered record pages resume after a stable cursor and include latest versions", async () => {
  const { root, store } = await fixture();
  try {
    store.create("paged", "case-c", { value: 3 });
    store.create("paged", "case-a", { value: 1 });
    store.create("paged", "case-b", { value: 2 });
    store.save("paged", "case-b", { value: 22 });
    const first = store.listByIdPage("paged", "", 2);
    assert.deepEqual(first.records.map(item => [item.id, item.value]), [["case-a", 1], ["case-b", 22]]);
    assert.equal(first.has_more, true);
    assert.equal(first.next_cursor, "case-b");
    const last = store.listByIdPage("paged", first.next_cursor!, 2);
    assert.deepEqual(last.records.map(item => item.id), ["case-c"]);
    assert.equal(last.has_more, false);
    assert.equal(last.next_cursor, null);
    const empty = store.listByIdPage("paged", "case-z", 2);
    assert.deepEqual(empty, { records: [], has_more: false, next_cursor: null });
    assert.throws(() => store.listByIdPage("paged", "", 1_001), /not exceed/u);
    assert.throws(() => store.listByIdPage("", "", 2), /kind must not be empty/u);
    assert.throws(() => store.listByIdPage("paged", null as unknown as string, 2), /after_id must be a string/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Knowledge records reject malformed unqualified string scopes", async () => {
  const { root, store } = await fixture();
  try {
    assert.throws(() => store.create("knowledge_claim", "legacy-scope", { scope: "other", status: "candidate" }), /storage scope is malformed/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Knowledge storage validates explicit custody, legacy partitions, and repair of an unpartitioned row", async () => {
  const { root, store } = await fixture();
  try {
    const legacyProject = store.create("legacy_knowledge_migration_candidate", "legacy-project-scope", {
      scope: "project", project: "fixture", migration_id: "migration-project", status: "candidate",
    });
    const legacyShared = store.create("legacy_knowledge_migration_candidate", "legacy-shared-scope", {
      scope: "shared", project: null, migration_id: "migration-shared", status: "candidate",
    });
    assert.equal(legacyProject.migration_id, "migration-project");
    assert.equal(legacyShared.migration_id, "migration-shared");

    const task = store.create("knowledge_claim", "task-scope", { scope: "task", task_id: "task-1", content: "task scoped" });
    const workspace = store.create("knowledge_claim", "workspace-legacy-scope", { scope: "workspace", content: "legacy workspace scope" });
    assert.equal(task.scope, "task");
    assert.equal(workspace.scope, "workspace");
    assert.throws(() => store.create("knowledge_claim", "malformed-object-scope", { scope: { kind: "project" } }), /storage scope is malformed/u);
    assert.throws(() => store.create("knowledge_claim", "malformed-array-scope", { scope: [] }), /storage scope is malformed/u);
    assert.throws(() => store.create("knowledge_claim", "unsupported-object-scope", { scope: { kind: "unsupported", id: "fixture" } }), /storage scope is malformed/u);

    store.create("knowledge_source", "user-source", { scope: "user:principal" });
    const matchingUserClaim = store.create("knowledge_claim", "matching-user-claim", { scope: "user:principal", source_id: "user-source", content: "same custody" });
    assert.equal(matchingUserClaim.content, "same custody");
    assert.throws(() => store.create("knowledge_claim", "mismatched-user-claim", { scope: "user:other", source_id: "user-source" }), /different storage scopes/u);
    assert.throws(() => store.create("knowledge_claim", "unscoped-user-claim", { source_id: "user-source" }), /storage scope is unavailable/u);

    store.create("knowledge_source", "global-source", { scope: "global" });
    const inheritedDocument = store.create("knowledge_document", "global-source-document", { source_id: "global-source", path: "README.md" });
    assert.equal(inheritedDocument.path, "README.md");
    assert.throws(() => store.create("knowledge_claim", "unscoped-global-claim", { source_id: "global-source" }), /storage scope is unavailable/u);

    const now = new Date().toISOString();
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("knowledge_claim", "unpartitioned-legacy-claim", 1,
        JSON.stringify({ scope: "global", source_id: "global-source", content: "legacy row" }), now, now);
    const repaired = store.save("knowledge_claim", "unpartitioned-legacy-claim", { scope: "global", source_id: "global-source", content: "repaired row" });
    assert.equal(repaired.content, "repaired row");
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

test("countMany returns current per-kind counts from one batched latest-version query", async () => {
  const { root, store } = await fixture();
  try {
    store.create("workflow", "one", { value: 1 });
    store.save("workflow", "one", { value: 2 });
    store.create("workflow", "two", { value: 1 });
    store.create("task", "task-one", { value: 1 });
    assert.deepEqual(store.countMany(["workflow", "task", "missing", "workflow"]), { workflow: 2, task: 1, missing: 0 });
    assert.deepEqual(store.countMany([]), {});
    assert.throws(() => store.countMany(["", "workflow"]), /count kinds/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("scoped record reads paginate metadata and bind valid time cutoffs", async () => {
  const { root, store } = await fixture();
  try {
    store.createBatch(Array.from({ length: 513 }, (_, index) => ({ kind: "page", id: `page-${index}`,
      payload: { scope: "project:p", value: index } })));
    assert.equal(store.listScoped("page", [{ kind: "project", id: "p" }], 600).length, 513);
    assert.equal(store.listScoped("page", [{ kind: "project", id: "p" }], 600, undefined, { known_at: "2030-01-01T00:00:00.000Z" }).length, 513);
    assert.throws(() => store.listScoped("page", [{ kind: "project", id: "p" }], 600, undefined, { known_at: "invalid" }), /known_at/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("latest record payload fingerprints are order-stable and detect append, replacement, and missing rows", async () => {
  const { root, store } = await fixture();
  try {
    store.create("fingerprint", "a", { value: 1 }); store.create("fingerprint", "b", { value: 2 });
    const first = store.latestRecordsDigest("fingerprint", ["b", "a"]);
    assert.equal(first, store.latestRecordsDigest("fingerprint", ["a", "b", "a"]));
    assert.notEqual(first, store.latestRecordsDigest("fingerprint", ["a"]));
    store.save("fingerprint", "a", { value: 3 });
    const appended = store.latestRecordsDigest("fingerprint", ["a", "b"]);
    assert.notEqual(appended, first);
    store.replacePayload("fingerprint", "a", 2, { value: 4 });
    assert.notEqual(store.latestRecordsDigest("fingerprint", ["a", "b"]), appended);
    assert.notEqual(store.latestRecordsDigest("fingerprint", ["absent"]), store.latestRecordsDigest("fingerprint", []));
    assert.throws(() => store.latestRecordsDigest("", ["a"]), /kind/);
    assert.throws(() => store.latestRecordsDigest("fingerprint", [""]), /bounds/);
    assert.throws(() => store.latestRecordsDigest("fingerprint", Array(10_001).fill("a")), /bounds/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("findMany returns requested latest records, skips missing ids, and chunks SQLite parameters", async () => {
  const { root, store } = await fixture();
  try {
    const entries = Array.from({ length: 501 }, (_, index) => ({ kind: "batch_read", id: `item_${index}`, payload: { value: index } }));
    store.createBatch(entries);
    store.save("batch_read", "item_0", { value: "newest" });
    const ids = [...entries.map(item => item.id), "missing", "item_0"];
    const found = store.findMany("batch_read", ids);
    assert.equal(found.length, 501);
    assert.equal(found[0]!.value, "newest");
    assert.equal(found.at(-1)!.id, "item_500");
    assert.deepEqual(store.findMany("batch_read", ["missing"]), []);
    assert.deepEqual(store.findMany("batch_read", []), []);
    assert.equal(store.findMany("batch_read", ["item_0"], false)[0]!.value, "newest");
    assert.throws(() => store.findMany("", []), /kind/);
    assert.throws(() => store.findMany("batch_read", [""]), /read bounds/);
    assert.throws(() => store.findMany("batch_read", Array(10_001).fill("id")), /read bounds/);
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
    store.create("scope_alias", "project-test", { scope: { kind: "project", id: "test" }, alias_kind: "path", alias: root, status: "active" });
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
    store.create("trace_event", "event", { trace_id: "archived" });
    store.create("trace_feedback", "feedback", { trace_id: "archived" });
    assert.equal(store.removeTraceRecords("archived", ["event"], ["feedback"]), 3);
    store.create("trace", "archived-with-telemetry", {});
    store.create("telemetry_event", "telemetry", { trace_id: "archived-with-telemetry" });
    assert.equal(store.removeTraceRecords("archived-with-telemetry", [], [], ["telemetry"]), 2);
    assert.equal(store.find("trace_feedback", "feedback"), null);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("immutable record batches preserve create conflicts and rollback atomically", async () => {
  const { root, store } = await fixture();
  try {
    assert.deepEqual(store.createBatch([]), []);
    const entries = Array.from({ length: 501 }, (_, index) => ({ kind: "immutable_batch", id: `item_${index}`, payload: { value: index } }));
    const created = store.createBatch(entries);
    assert.equal(created.length, entries.length);
    assert.equal(created[0]!.version, 1);
    assert.equal(created.at(-1)!.value, 500);
    assert.equal(store.count("immutable_batch"), entries.length);

    assert.throws(() => store.createBatch([
      { kind: "immutable_batch", id: "rolled_back", payload: {} },
      { kind: "immutable_batch", id: "rolled_back", payload: {} },
    ]), /already exists: rolled_back/u);
    assert.equal(store.find("immutable_batch", "rolled_back"), null);

    store.create("immutable_batch", "preexisting", {});
    assert.throws(() => store.createBatch([
      { kind: "immutable_batch", id: "also_rolled_back", payload: {} },
      { kind: "immutable_batch", id: "preexisting", payload: {} },
    ]), /already exists: preexisting/u);
    assert.equal(store.find("immutable_batch", "also_rolled_back"), null);
    assert.equal(store.createBatch([{ kind: "another_batch", id: "preexisting", payload: {} }])[0]!.version, 1);

    assert.throws(() => store.transaction(() => {
      store.createBatch([{ kind: "immutable_batch", id: "outer_rollback", payload: {} }]);
      throw new Error("outer batch rollback");
    }), /outer batch rollback/u);
    assert.equal(store.find("immutable_batch", "outer_rollback"), null);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
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
