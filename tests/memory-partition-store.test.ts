import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { MarkdownContentStore } from "../common/craft-common-store-local/src/content-store.ts";
import { assertRegularSessionMemoryDirectories, CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { MemoryLedgerKernel } from "../capability/craft-memory/memory-ledger.ts";

test("CraftStore keeps Memory records in the database for their scope and can reopen them", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-partition-"));
  const dataRoot = join(root, "global-data");
  const projectRoot = join(root, "project");
  const sessionId = `partition-${process.pid}-${Date.now()}`;
  const sessionDir = join("/tmp", ".craft_data", "memory", sessionId);
  const paths = craftPaths(dataRoot);
  let store = await new CraftStore(paths).open();
  try {
    mkdirSync(projectRoot);
    store.create("scope_alias", "project-partition", { scope: { kind: "project", id: "project-1" },
      alias_kind: "path", alias: projectRoot, status: "active" });
    const records = [
      { id: "global-memory", scope: { kind: "global", id: "global" } },
      { id: "project-memory", scope: { kind: "project", id: "project-1" } },
      { id: "session-memory", scope: { kind: "session", id: sessionId } },
    ];
    for (const record of records) store.create("memory_ledger", record.id, { ...record, status: "active", content: `private body for ${record.id}` });

    const mainRows = store.database.prepare("SELECT payload_json FROM records WHERE kind='memory_ledger'").all() as Array<{ payload_json: string }>;
    assert.equal(mainRows.length, 3, "primary Craft database keeps only a routing and query projection");
    assert.equal(mainRows.some(row => row.payload_json.includes("private body")), false, "primary database must not retain Memory bodies");
    assert.equal(existsSync(paths.memoryDatabaseFile), true);
    assert.equal(existsSync(join(projectRoot, ".craft_data", "memory", "memory.db")), true);
    assert.equal(existsSync(join(sessionDir, "memory.db")), true);
    for (const record of records) assert.equal(store.get("memory_ledger", record.id).content, `private body for ${record.id}`);

    store.close();
    store = await new CraftStore(paths).open();
    for (const record of records) assert.equal(store.get("memory_ledger", record.id).content, `private body for ${record.id}`);
    assert.deepEqual(store.listScoped("memory_ledger", [records[1]!.scope], 10).map(item => item.id), ["project-memory"]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("Memory Markdown bodies follow the same project or session boundary as their record", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-content-partition-"));
  const projectRoot = join(root, "project"); mkdirSync(projectRoot);
  const store = await new CraftStore(craftPaths(join(root, "global-data"))).open();
  try {
    store.create("scope_alias", "project-content", { scope: { kind: "project", id: "project-content" }, alias_kind: "path", alias: projectRoot, status: "active" });
    store.create("knowledge_source", "memory-source", { status: "active", trust: "verified" });
    const ledger = new MemoryLedgerKernel(store);
    const project = ledger.remember({ memory_id: "project-content-memory", source_id: "memory-source", kind: "preference",
      scope_kind: "project", scope_id: "project-content", content: "project-only body" }).memory as JsonObject;
    const session = ledger.remember({ memory_id: "session-content-memory", source_id: "memory-source", kind: "preference",
      scope_kind: "session", scope_id: "session-content", content: "session-only body" }).memory as JsonObject;
    const projectContentPath = (project.content_ref as { path: string }).path;
    const sessionContentPath = (session.content_ref as { path: string }).path;
    assert.equal(projectContentPath.startsWith(join(realpathSync(projectRoot), ".craft_data", "memory", "md") + "/"), true);
    assert.equal(sessionContentPath.startsWith(join("/tmp", ".craft_data", "memory", "session-content", "md") + "/"), true);
    assert.match(readFileSync(projectContentPath, "utf8"), /project-only body/);
    assert.match(readFileSync(sessionContentPath, "utf8"), /session-only body/);
    assert.equal(existsSync(join(store.paths.memoryContentDir, "project-content-memory.v1.md")), false);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(join("/tmp", ".craft_data", "memory", "session-content"), { recursive: true, force: true });
  }
});

test("opening a legacy store backs it up and moves scoped Memory versions out of the primary database", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-legacy-migration-"));
  const dataRoot = join(root, "global-data"), projectRoot = join(root, "project"); mkdirSync(projectRoot);
  const paths = craftPaths(dataRoot);
  let store = await new CraftStore(paths).open();
  try {
    store.create("scope_alias", "project-legacy", { scope: { kind: "project", id: "legacy-project" }, alias_kind: "path", alias: projectRoot, status: "active" });
    const insert = store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES('memory_candidate','legacy-candidate',?,?,?,?)");
    const base = { scope: { kind: "project", id: "legacy-project" }, status: "candidate", content: "legacy private candidate" };
    insert.run(1, JSON.stringify(base), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    insert.run(2, JSON.stringify({ ...base, status: "approved" }), "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    store.create("knowledge_source", "legacy-source", { status: "active", trust: "verified" });
    const legacyRef = new MarkdownContentStore(paths).writeSync({ kind: "memory", record_id: "legacy-ledger", version: 1, scope: "project:legacy-project", status: "active",
      sensitivity: "internal", source_id: "legacy-source", body: "legacy ledger body" });
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES('memory_ledger','legacy-ledger',1,?,?,?)")
      .run(JSON.stringify({ scope: { kind: "project", id: "legacy-project" }, source_id: "legacy-source", source_version: 1, status: "active", kind: "preference", content_digest: "digest", content_ref: legacyRef }),
        "2026-01-03T00:00:00.000Z", "2026-01-03T00:00:00.000Z");
    const globalLegacyRef = store.contentStore.writeSync({ kind: "memory", record_id: "legacy-global-ledger", version: 1, scope: "global:global", status: "active",
      sensitivity: "internal", source_id: "legacy-source", body: "legacy global body" });
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES('memory_ledger','legacy-global-ledger',1,?,?,?)")
      .run(JSON.stringify({ scope: { kind: "global", id: "global" }, source_id: "legacy-source", kind: "episodic", status: "active", sensitivity: "internal", content_ref: globalLegacyRef }),
        "2026-01-04T00:00:00.000Z", "2026-01-04T00:00:00.000Z");
    const projectLegacyOriginal = new MarkdownContentStore(paths).writeSync({ kind: "memory", record_id: "legacy-project-ledger", version: 1, scope: "project:legacy-project",
      status: "active", sensitivity: "internal", source_id: "legacy-source", body: "legacy project body" });
    const projectLegacyPath = store.contentStore.legacyPathFor("memory", "legacy-project-ledger", 1);
    mkdirSync(dirname(projectLegacyPath), { recursive: true });
    writeFileSync(projectLegacyPath, readFileSync(projectLegacyOriginal.path, "utf8")); unlinkSync(projectLegacyOriginal.path);
    const projectLegacyRef = { ...projectLegacyOriginal, path: projectLegacyPath };
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES('memory_ledger','legacy-project-ledger',1,?,?,?)")
      .run(JSON.stringify({ scope: { kind: "project", id: "legacy-project" }, source_id: "legacy-source", kind: "episodic", content_ref: projectLegacyRef }),
        "2026-01-05T00:00:00.000Z", "2026-01-05T00:00:00.000Z");
    store.close();
    const reopening = new CraftStore(paths);
    const readCompat = reopening.contentStore.readCompatSync.bind(reopening.contentStore);
    reopening.contentStore.readCompatSync = ((ref, expectedScope) => {
      const result = readCompat(ref, expectedScope);
      if (ref.path === legacyRef.path) unlinkSync(legacyRef.path);
      return result;
    }) as typeof reopening.contentStore.readCompatSync;
    store = await reopening.open();
    assert.equal(store.get("memory_candidate", "legacy-candidate").content, "legacy private candidate");
    assert.equal(store.get("memory_candidate", "legacy-candidate", 1).status, "candidate");
    const migratedLedger = store.get("memory_ledger", "legacy-ledger");
    assert.equal(store.contentStore.readCompatSync(migratedLedger.content_ref as never).body, "legacy ledger body");
    assert.notEqual((migratedLedger.content_ref as { path: string }).path, legacyRef.path);
    assert.equal(existsSync(legacyRef.path), false);
    const migratedGlobal = store.get("memory_ledger", "legacy-global-ledger");
    assert.equal(store.contentStore.readCompatSync(migratedGlobal.content_ref as never).body, "legacy global body");
    assert.equal(migratedGlobal.status, "active"); assert.equal(migratedGlobal.sensitivity, "internal");
    assert.equal((migratedGlobal.content_ref as JsonObject).path, globalLegacyRef.path);
    assert.equal(existsSync(globalLegacyRef.path), true, "in-place global Memory migration must keep its live content file");
    const migratedProject = store.get("memory_ledger", "legacy-project-ledger");
    assert.equal(store.contentStore.readCompatSync(migratedProject.content_ref as never).body, "legacy project body");
    assert.equal(migratedProject.status, "active"); assert.equal(migratedProject.sensitivity, "internal");
    assert.equal(existsSync(projectLegacyRef.path), true, "project-owned legacy content is outside the global Memory content directory");
    const header = store.database.prepare("SELECT payload_json FROM records WHERE kind='memory_candidate' AND id='legacy-candidate' AND version=2").get() as { payload_json: string };
    assert.equal(header.payload_json.includes("legacy private candidate"), false);
    assert.equal(readdirSync(paths.backupsDir).length, 1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("legacy Memory migration surfaces unexpected retired-file cleanup errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-migration-cleanup-error-"));
  const paths = craftPaths(join(root, "data"));
  const initial = await new CraftStore(paths).open();
  let reopening: CraftStore | null = null;
  try {
    let ref = initial.contentStore.writeSync({ kind: "memory", record_id: "cleanup-error", version: 1, scope: "global:global",
      status: "active", sensitivity: "internal", source_id: "source", body: "cleanup source" });
    const legacyPath = join(paths.memoryContentDir, "legacy-old-name.v1.md");
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, readFileSync(ref.path, "utf8")); unlinkSync(ref.path);
    ref = { ...ref, path: legacyPath };
    initial.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES('memory_ledger','cleanup-error',1,?,?,?)")
      .run(JSON.stringify({ scope: { kind: "global", id: "global" }, status: "active", sensitivity: "internal", source_id: "source", content_ref: ref }),
        "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    initial.close();

    reopening = new CraftStore(paths);
    const readCompat = reopening.contentStore.readCompatSync.bind(reopening.contentStore);
    reopening.contentStore.readCompatSync = ((candidate, expectedScope) => {
      const result = readCompat(candidate, expectedScope);
      if (candidate.path === legacyPath) { unlinkSync(legacyPath); mkdirSync(legacyPath); }
      return result;
    }) as typeof reopening.contentStore.readCompatSync;
    await assert.rejects(reopening.open(), /EISDIR|operation not permitted|is a directory/iu);
  } finally { reopening?.close(); initial.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a failed outer transaction removes staged Memory rows and never publishes their directory entry", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-partition-rollback-"));
  const projectRoot = join(root, "project"); mkdirSync(projectRoot);
  const paths = craftPaths(join(root, "global-data"));
  const store = await new CraftStore(paths).open();
  try {
    store.create("scope_alias", "project-rollback", { scope: { kind: "project", id: "rollback-project" }, alias_kind: "path", alias: projectRoot, status: "active" });
    assert.throws(() => store.transaction(() => {
      store.create("memory_candidate", "rolled-back", { scope: { kind: "project", id: "rollback-project" }, content: "must stay invisible", status: "candidate" });
      throw new Error("abort transaction");
    }), /abort transaction/);
    assert.equal(store.find("memory_candidate", "rolled-back"), null);
    const database = new DatabaseSync(join(projectRoot, ".craft_data", "memory", "memory.db"));
    try { assert.equal(database.prepare("SELECT COUNT(*) count FROM records WHERE kind='memory_candidate' AND id='rolled-back'").get()?.count, 0); }
    finally { database.close(); }
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Memory record scope cannot change after publication and missing project identity fails closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-partition-scope-"));
  const projectRoot = join(root, "project"); mkdirSync(projectRoot);
  const store = await new CraftStore(craftPaths(join(root, "global-data"))).open();
  try {
    store.create("scope_alias", "project-stable", { scope: { kind: "project", id: "stable-project" }, alias_kind: "path", alias: projectRoot, status: "active" });
    store.create("memory_candidate", "stable", { scope: { kind: "project", id: "stable-project" }, content: "stable scope", status: "candidate" });
    assert.throws(() => store.save("memory_candidate", "stable", { scope: { kind: "global", id: "global" }, content: "moved", status: "candidate" }), /cannot change storage scope/);
    assert.throws(() => store.create("memory_ledger", "unbound", { scope: { kind: "project", id: "missing" }, content: "no root" }), /storage root is not registered/);
    assert.throws(() => store.create("memory_candidate", "malformed", { scope: { kind: "unknown", id: "invalid" }, content: "must fail closed" }), /scope is malformed/);
    assert.equal(store.find("memory_candidate", "malformed"), null);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("project Memory storage rejects symlinked data directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-partition-symlink-"));
  const projectRoot = join(root, "project"), external = join(root, "external");
  mkdirSync(projectRoot); mkdirSync(external); symlinkSync(external, join(projectRoot, ".craft_data"));
  const store = await new CraftStore(craftPaths(join(root, "global-data"))).open();
  try {
    store.create("scope_alias", "project-symlink", { scope: { kind: "project", id: "symlink-project" }, alias_kind: "path", alias: projectRoot, status: "active" });
    assert.throws(() => store.create("memory_candidate", "outside", { scope: { kind: "project", id: "symlink-project" }, content: "must not escape" }), /regular directories/);
    assert.equal(readdirSync(external).length, 0);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("session and task Memory paths reject linked or malformed SQLite storage", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-special-paths-"));
  const paths = craftPaths(join(root, "data"));
  const external = join(root, "external"); mkdirSync(external);
  const sessionId = `partition-link-${randomUUID()}`;
  const sessionDirectory = join("/tmp", ".craft_data", "memory", sessionId);
  mkdirSync(dirname(sessionDirectory), { recursive: true });
  symlinkSync(external, sessionDirectory);
  const taskId = `task-link-${randomUUID()}`;
  const taskDirectory = join(paths.runtimeDir, "memory-tasks", taskId);
  mkdirSync(taskDirectory, { recursive: true });
  const externalDb = join(external, "database.db"); writeFileSync(externalDb, "not sqlite");
  symlinkSync(externalDb, join(taskDirectory, "memory.db"));
  const malformedTaskId = `task-corrupt-${randomUUID()}`;
  const malformedDirectory = join(paths.runtimeDir, "memory-tasks", malformedTaskId);
  mkdirSync(malformedDirectory, { recursive: true });
  writeFileSync(join(malformedDirectory, "memory.db"), "not sqlite");
  const store = await new CraftStore(paths).open();
  try {
    assert.throws(() => store.create("memory_ledger", "linked-session", { scope: { kind: "session", id: sessionId }, content: "reject" }), /regular directories/);
    assert.throws(() => store.create("memory_ledger", "linked-task", { scope: { kind: "task", id: taskId }, content: "reject" }), /regular file/);
    assert.throws(() => store.create("memory_ledger", "corrupt-task", { scope: { kind: "task", id: malformedTaskId }, content: "reject" }));
    assert.equal(readFileSync(externalDb, "utf8"), "not sqlite");
  } finally {
    store.close(); unlinkSync(sessionDirectory); rmSync(root, { recursive: true, force: true });
  }
});

test("session Memory validates missing and non-directory data roots without creating them", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-session-root-check-"));
  const dataRoot = join(root, "not-created");
  try {
    assertRegularSessionMemoryDirectories(dataRoot);
    assert.equal(existsSync(dataRoot), false);
    mkdirSync(dataRoot);
    writeFileSync(join(dataRoot, "memory"), "not a directory");
    assert.throws(() => assertRegularSessionMemoryDirectories(dataRoot), /regular directories/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("partitioned Memory supports compatibility scopes, payload replacement, deletion, and connection close", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-partition-lifecycle-"));
  const projectRoot = join(root, "project"); mkdirSync(projectRoot);
  const store = await new CraftStore(craftPaths(join(root, "global-data"))).open();
  try {
    store.create("scope_alias", "project-lifecycle", { scope: { kind: "project", id: "lifecycle" }, alias_kind: "path", alias: projectRoot, status: "active" });
    store.create("memory_candidate", "duplicate-before-write", { scope: { kind: "global", id: "global" }, content: "before" });
    assert.throws(() => store.create("memory_candidate", "duplicate-before-write", { scope: { kind: "global", id: "global" }, content: "again" }), /already exists/);
    assert.throws(() => store.contentStore.writeSync({ kind: "memory", record_id: "unbound", version: 1, scope: "project:unbound",
      status: "active", sensitivity: "internal", source_id: "source", body: "reject" }), /no registered project root/);
    const projectBody = store.contentStore.writeSync({ kind: "memory", record_id: "project-body", version: 1, scope: "project:lifecycle",
      project_root: projectRoot, status: "active", sensitivity: "internal", source_id: "source", body: "root-pinned body" });
    assert.equal(projectBody.path.startsWith(join(realpathSync(projectRoot), ".craft_data", "memory", "md") + "/"), true);
    const globalBody = store.contentStore.writeSync({ kind: "memory", record_id: "global-body", version: 1, scope: "global",
      status: "active", sensitivity: "internal", source_id: "source", body: "global body" });
    assert.equal(globalBody.path.startsWith(store.paths.memoryContentDir), true);
    store.create("memory_ledger", "scope-source", { scope: "global", content: "source", status: "active" });
    const inferredConfirmation = store.create("memory_confirmation", "inferred-confirmation", { memory_id: "scope-source", status: "active" });
    assert.deepEqual(inferredConfirmation.scope, { kind: "global", id: "global" });
    const globalConfirmation = store.create("memory_confirmation", "fallback-confirmation", { status: "active" });
    assert.deepEqual(globalConfirmation.scope, { kind: "global", id: "global" });
    const inferredObservation = store.create("memory_observation", "inferred-observation", { project_id: "lifecycle", status: "active" });
    assert.deepEqual(inferredObservation.scope, { kind: "project", id: "lifecycle" });
    const fieldScope = store.create("memory_candidate", "field-scope", { scope_kind: "task", scope_id: "compat", status: "candidate" });
    assert.deepEqual(fieldScope.scope, { kind: "task", id: "compat" });
    const stringScope = store.create("memory_candidate", "string-scope", { scope: "task:compat", status: "candidate" });
    assert.deepEqual(stringScope.scope, { kind: "task", id: "compat" });
    const legacyScope = store.create("memory_candidate", "legacy-task-scope", { scope: "task", task_id: "task-real", status: "candidate" });
    assert.deepEqual(legacyScope.scope, { kind: "task", id: "task-real" });
    const unboundLegacyScope = store.create("memory_candidate", "unbound-task-scope", { scope: "task", status: "candidate" });
    assert.deepEqual(unboundLegacyScope.scope, { kind: "task", id: "legacy" });
    const organizationScope = store.create("memory_policy", "organization-scope", { scope: { kind: "organization", id: "org" }, status: "active" });
    assert.deepEqual(organizationScope.scope, { kind: "organization", id: "org" });
    const createdAtZero = store.updateIfVersion("memory_candidate", "created-at-zero", 0, { scope: { kind: "global", id: "global" }, content: "new" });
    assert.equal(createdAtZero.version, 1);

    const created = store.create("memory_candidate", "mutable", { scope: { kind: "global", id: "global" }, status: "candidate", content: "before" });
    const updated = store.updateIfVersion("memory_candidate", "mutable", 1, { ...created, content: "updated" });
    assert.throws(() => store.updateIfVersion("memory_candidate", "mutable", 1, { ...created, content: "stale" }), /Concurrent update/);
    store.replacePayload("memory_candidate", "mutable", 2, { ...updated, content: "after-one" });
    store.replacePayloadBatch([{ kind: "memory_candidate", id: "mutable", version: 2, payload: { ...updated, content: "after-two" } }]);
    assert.equal(store.get("memory_candidate", "mutable").content, "after-two");
    const header = store.database.prepare("SELECT payload_json FROM records WHERE kind='memory_candidate' AND id='mutable' AND version=2").get() as { payload_json: string };
    assert.equal(header.payload_json.includes("after-two"), false, "batch replacement must not copy a Memory body into the primary database");
    assert.equal(store.remove("memory_candidate", "mutable"), 2);
    assert.equal(store.find("memory_candidate", "mutable"), null);
    store.closeMemoryScope({ kind: "global", id: "global" });
    store.closeMemoryScope({ kind: "global", id: "global" });
    assert.throws(() => store.create("memory_candidate", "bad-scope", { scope: "malformed", content: "reject" }), /scope is malformed/);
    assert.throws(() => store.create("memory_candidate", "array-scope", { scope: [], content: "reject" }), /scope is malformed/);
    assert.throws(() => store.create("memory_candidate", "bad-task", { scope: { kind: "task", id: "../escape" }, content: "reject" }), /safe directory name/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("project Memory roots reject ambiguous aliases and ignore malformed or non-directory aliases", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-project-roots-"));
  const projectOne = join(root, "one"), projectTwo = join(root, "two"), projectThree = join(root, "three"), file = join(root, "not-a-directory");
  mkdirSync(projectOne); mkdirSync(projectTwo); mkdirSync(projectThree); writeFileSync(file, "file");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    store.create("scope_alias", "root-one", { scope: { kind: "project", id: "ambiguous" }, alias_kind: "path", alias: projectOne, status: "active" });
    store.create("scope_alias", "root-two", { scope: { kind: "project", id: "ambiguous" }, alias_kind: "path", alias: projectTwo, status: "active" });
    assert.throws(() => store.create("memory_candidate", "ambiguous", { scope: { kind: "project", id: "ambiguous" }, content: "reject" }), /root is ambiguous/);

    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES('scope_alias','broken-json',1,?,?,?)")
      .run("{", new Date().toISOString(), new Date().toISOString());
    store.create("scope_alias", "root-file", { scope: { kind: "project", id: "file-alias" }, alias_kind: "path", alias: file, status: "active" });
    assert.throws(() => store.create("memory_candidate", "file-root", { scope: { kind: "project", id: "file-alias" }, content: "reject" }), /root is not registered/);
    store.create("scope_alias", "legacy-project-alias", { scope: { kind: "project", id: "old-project" }, alias_kind: "legacy", alias: "current-project", status: "active" });
    store.create("scope_alias", "legacy-project-path", { scope: { kind: "project", id: "old-project" }, alias_kind: "path", alias: projectThree, status: "active" });
    store.create("memory_candidate", "legacy-project-root", { scope: { kind: "project", id: "current-project" }, content: "resolves through a legacy alias" });
    assert.equal(existsSync(join(projectThree, ".craft_data", "memory", "memory.db")), true);
    assert.equal(store.contentStore.isCanonicalRef({ kind: "memory", record_id: "empty-project", version: 1,
      path: join(root, "empty", ".craft_data", "memory", "md", "empty-project.v1.md"), scope: "project:" }), false);
    assert.equal(store.contentStore.isCanonicalRef({ kind: "memory", record_id: "not-created", version: 1,
      path: join(projectThree, ".craft_data", "memory", "md", "not-created.v1.md"), scope: "project:current-project" }), false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("partition transactions roll back concurrent deletion and preserve orphan checks", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-partition-concurrent-delete-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const created = store.create("memory_candidate", "deleted-between-reads", { scope: { kind: "global", id: "global" }, content: "before" });
    const header = store.database.prepare("SELECT payload_json FROM records WHERE kind='memory_candidate' AND id='deleted-between-reads'").get() as { payload_json: string };
    const pointer = JSON.parse(header.payload_json) as JsonObject;
    const partition = new DatabaseSync(String((pointer._memory_partition as JsonObject).file));
    partition.prepare("DELETE FROM records WHERE kind='memory_candidate' AND id='deleted-between-reads'").run();
    partition.close();
    const originalFind = store.find.bind(store);
    store.find = ((kind: string, id: string, version?: number, hydrate?: boolean) => kind === "memory_candidate" && id === "deleted-between-reads"
      ? created : originalFind(kind, id, version, hydrate)) as typeof store.find;
    assert.throws(() => store.replacePayload("memory_candidate", "deleted-between-reads", 1, { ...created, content: "after" }), /Unknown record version/);
    store.find = originalFind;

    store.create("memory_candidate", "orphaned-partition", { scope: { kind: "global", id: "global" }, content: "orphan" });
    const orphanHeader = store.database.prepare("SELECT payload_json FROM records WHERE kind='memory_candidate' AND id='orphaned-partition'").get() as { payload_json: string };
    const orphanPointer = JSON.parse(orphanHeader.payload_json) as JsonObject;
    const database = new DatabaseSync(String((orphanPointer._memory_partition as JsonObject).file));
    database.close();
    store.database.prepare("DELETE FROM records WHERE kind='memory_candidate' AND id='orphaned-partition'").run();
    assert.throws(() => store.create("memory_candidate", "orphaned-partition", { scope: { kind: "global", id: "global" }, content: "duplicate" }), /already exists/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("partition reads fail closed when a pointer outlives its stored Memory version", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-partition-stale-pointer-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const partitionFor = (id: string) => {
    const header = store.database.prepare("SELECT payload_json FROM records WHERE kind='memory_candidate' AND id=?").get(id) as { payload_json: string };
    const payload = JSON.parse(header.payload_json) as JsonObject;
    return new DatabaseSync(String((payload._memory_partition as JsonObject).file));
  };
  try {
    store.create("memory_candidate", "missing-version", { scope: { kind: "global", id: "global" }, status: "candidate", content: "gone" });
    const direct = partitionFor("missing-version");
    direct.prepare("DELETE FROM records WHERE kind='memory_candidate' AND id='missing-version'").run();
    direct.close();
    assert.throws(() => store.find("memory_candidate", "missing-version"), /partition record is missing/);

    store.create("memory_candidate", "snapshot-version", { scope: { kind: "global", id: "global" }, status: "candidate", content: "gone after pin" });
    assert.throws(() => store.listScoped("memory_candidate", [{ kind: "global", id: "global" }], 10, () => {
      const partition = partitionFor("snapshot-version");
      partition.prepare("DELETE FROM records WHERE kind='memory_candidate' AND id='snapshot-version'").run();
      partition.close();
      return true;
    }), /partition record is missing/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("legacy Memory migration refuses a conflicting pre-existing partition version", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-partition-collision-"));
  const paths = craftPaths(join(root, "data"));
  let store = await new CraftStore(paths).open();
  try {
    store.create("memory_candidate", "collision", { scope: { kind: "global", id: "global" }, status: "candidate", content: "partition copy" });
    store.database.prepare("DELETE FROM records WHERE kind='memory_candidate' AND id='collision'").run();
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES('memory_candidate','collision',1,?,?,?)")
      .run(JSON.stringify({ scope: { kind: "global", id: "global" }, status: "candidate", content: "legacy conflict" }), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    store.close();
    store = new CraftStore(paths);
    await assert.rejects(store.open(), /Memory migration collision/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("failed Memory migration closes the partially opened primary and partition databases", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-partition-open-failure-"));
  const paths = craftPaths(join(root, "data"));
  const store = new CraftStore(paths);
  (store as unknown as { migrateLegacyMemoryRecords(): void }).migrateLegacyMemoryRecords = () => {
    store.create("memory_ledger", "partial-open", { scope: { kind: "global", id: "global" }, content: "private", status: "active" });
    throw new Error("fixture migration failure");
  };
  try {
    await assert.rejects(store.open(), /fixture migration failure/);
    assert.throws(() => store.database, /not open/);
    const recovered = await new CraftStore(paths).open();
    recovered.close();
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
