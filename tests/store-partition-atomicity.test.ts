import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths, projectStorageDirectory } from "../core/infrastructure/paths.ts";
import { MarkdownContentStore } from "../common/craft-common-store-local/src/content-store.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "craft-partition-atomicity-"));
  const paths = craftPaths(join(root, "data"));
  const store = await new CraftStore(paths).open();
  return { root, paths, store };
}
function cleanup(f: Awaited<ReturnType<typeof fixture>>) { f.store.close(); rmSync(f.root, { recursive: true, force: true }); }
function partitionCount(file: string, kind: string) {
  const database = new DatabaseSync(file, { readOnly: true });
  try { return Number(database.prepare("SELECT COUNT(*) count FROM records WHERE kind=?").get(kind)!.count); }
  finally { database.close(); }
}
function crashAfterStage(root: string, statements: string, stages = 1) {
  const source = `
    import { CraftStore } from ${JSON.stringify(new URL("../core/infrastructure/store.ts", import.meta.url).href)};
    import { craftPaths } from ${JSON.stringify(new URL("../core/infrastructure/paths.ts", import.meta.url).href)};
    const store = await new CraftStore(craftPaths(${JSON.stringify(join(root, "data"))})).open();
    const transaction = store.transactionOn.bind(store);
    let staged = 0;
    store.transactionOn = (database, operation) => {
      const result = transaction(database, operation);
      if (database !== store.database && ++staged === ${stages}) process.exit(73);
      return result;
    };
    ${statements}
    process.exit(74);
  `;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], { encoding: "utf8", timeout: 20_000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 73, child.stderr);
}

test("project Memory observation identity requires a registered project root", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.store.create("memory_observation", "unbound-observation", { project_id: "unbound-project", outcome: "observed" }),
      /Project Memory storage root is not registered/u);
    assert.equal(f.store.find("memory_observation", "unbound-observation"), null,
      "an inferred project scope cannot fall back to global storage");
  } finally { cleanup(f); }
});

test("Memory observation with an explicit object scope keeps that scope over the project hint", async () => {
  const f = await fixture();
  const project = join(f.root, "project"); mkdirSync(project);
  try {
    f.store.create("scope_alias", "project", { scope: { kind: "project", id: "demo" }, alias_kind: "path", alias: project, status: "active" });
    const observation = f.store.create("memory_observation", "scoped-observation", {
      scope: { kind: "project", id: "demo" }, project_id: "different-project", outcome: "observed",
    });
    assert.deepEqual(observation.scope, { kind: "project", id: "demo" });
    assert.equal(f.store.find("memory_observation", "scoped-observation")?.outcome, "observed");
  } finally { cleanup(f); }
});

test("project content resolvers select exact legacy Knowledge and Experience trees for reads", async () => {
  const f = await fixture();
  const project = join(f.root, "project"); mkdirSync(project);
  try {
    f.store.create("scope_alias", "project", { scope: { kind: "project", id: "demo" }, alias_kind: "path", alias: project, status: "active" });
    const legacyKnowledge = join(project, ".craft_data", "knowledge", "md");
    const legacyExperience = join(project, ".craft_data", "experience", "md");
    const knowledgeFile = join(legacyKnowledge, "claim.v1.md");
    const experienceFile = join(legacyExperience, "procedure.v1.md");
    mkdirSync(legacyKnowledge, { recursive: true }); mkdirSync(legacyExperience, { recursive: true });
    writeFileSync(knowledgeFile, "legacy knowledge"); writeFileSync(experienceFile, "legacy procedure");
    const internals = f.store as unknown as { legacyProjectContentDirectory(root: string, domain: string, path: string, writing: boolean): string | null };
    const original = internals.legacyProjectContentDirectory.bind(f.store);
    const selected: string[] = [];
    internals.legacyProjectContentDirectory = (root, domain, path, writing) => {
      const result = original(root, domain, path, writing);
      if (result) selected.push(domain);
      return result;
    };
    const knowledge = (f.store.contentStore as unknown as { directory(kind: string, folder: undefined, scope: string, projectRoot: undefined, path: string, writing: boolean): string })
      .directory("knowledge", undefined, "project:demo", undefined, knowledgeFile, false);
    const experience = (f.store.contentStore as unknown as { directory(kind: string, folder: undefined, scope: string, projectRoot: undefined, path: string, writing: boolean): string })
      .directory("experience", undefined, "project:demo", undefined, experienceFile, false);
    assert.equal(knowledge, legacyKnowledge);
    assert.equal(experience, legacyExperience);
    assert.deepEqual(selected, ["knowledge", "experience"]);
  } finally { cleanup(f); }
});

test("a held publication lock leaves no staged row and create succeeds after release", async () => {
  const f = await fixture(); let writer: DatabaseSync | undefined;
  try {
    f.store.create("knowledge_claim", "warmup", { scope: "global", content: "warmup" });
    writer = new DatabaseSync(f.paths.databaseFile);
    writer.exec("BEGIN IMMEDIATE");
    f.store.database.exec("PRAGMA busy_timeout=1");
    assert.throws(() => f.store.create("knowledge_claim", "blocked", { scope: "global", content: "pending" }), error => {
      assert.match((error as Error).message, /locked/u);
      assert.equal((error as { stage?: string }).stage, "storage_lock");
      assert.deepEqual((error as { safeDetails?: Record<string, unknown> }).safeDetails, {
        database_role: "primary", phase: "transaction_begin", busy_timeout_ms: 1, retryable: true,
      });
      return true;
    });
    assert.equal(partitionCount(f.paths.knowledgeDatabaseFile, "knowledge_claim"), 1);
    writer.exec("ROLLBACK");
    assert.equal(f.store.find("knowledge_claim", "blocked"), null);
    assert.equal(f.store.create("knowledge_claim", "blocked", { scope: "global", content: "pending" }).version, 1);
  } finally { writer?.close(); cleanup(f); }
});

test("storage lock annotation preserves an existing safe phase diagnostic", async () => {
  const f = await fixture(); let writer: DatabaseSync | undefined, partitionWriter: DatabaseSync | undefined;
  try {
    const run = (f.store as unknown as { transactionOn(database: DatabaseSync, operation: () => void): void }).transactionOn.bind(f.store);
    const error = Object.assign(new Error("database is locked"), {
      stage: "partition_publish", safeDetails: { database_role: "custom_partition" },
    });
    assert.throws(() => run(f.store.database, () => { throw error; }), caught => {
      assert.equal((caught as Error).message, "database is locked");
      assert.equal((caught as { stage?: string }).stage, "partition_publish");
      assert.deepEqual((caught as { safeDetails?: Record<string, unknown> }).safeDetails, { database_role: "custom_partition" });
      return true;
    });
    const nonBusySqliteError = Object.assign(new Error("invalid SQL"), { code: "ERR_SQLITE_ERROR", errcode: 1 });
    assert.throws(() => run(f.store.database, () => { throw nonBusySqliteError; }), caught => {
      assert.equal(caught, nonBusySqliteError);
      assert.equal((caught as { stage?: string }).stage, undefined);
      return true;
    });
    const codeWithoutMessage = { code: "ERR_SQLITE_ERROR", errcode: 1 };
    assert.throws(() => run(f.store.database, () => { throw codeWithoutMessage; }), caught => caught === codeWithoutMessage);
    assert.throws(() => run(f.store.database, () => { throw null; }), caught => caught === null);
    assert.throws(() => run(f.store.database, () => { throw "primitive failure"; }), caught => caught === "primitive failure");
    const codedBusy = Object.assign({ code: "ERR_SQLITE_ERROR", errcode: 5 });
    assert.throws(() => run(f.store.database, () => { throw codedBusy; }), caught => {
      assert.equal((caught as { stage?: string }).stage, "storage_lock");
      assert.equal((caught as { safeDetails?: Record<string, unknown> }).safeDetails?.busy_timeout_ms, 15_000);
      return true;
    });
    const brokenProbe = new Proxy(f.store.database, { get(target, property) {
      if (property === "prepare") return (sql: string) => {
        if (sql === "PRAGMA busy_timeout") throw new Error("diagnostic probe unavailable");
        return target.prepare(sql);
      };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    assert.throws(() => run(brokenProbe, () => { throw new Error("database is locked"); }), caught => {
      assert.equal((caught as { safeDetails?: Record<string, unknown> }).safeDetails?.busy_timeout_ms, null);
      return true;
    });
    writer = new DatabaseSync(f.paths.databaseFile);
    const timeout = Number((f.store.database.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout);
    writer.exec("BEGIN IMMEDIATE"); f.store.database.exec("PRAGMA busy_timeout=1");
    assert.throws(() => run(f.store.database, () => {}), caught => {
      assert.equal((caught as { stage?: string }).stage, "storage_lock");
      assert.equal((caught as { safeDetails?: Record<string, unknown> }).safeDetails?.phase, "transaction_begin");
      return true;
    });
    writer.exec("ROLLBACK"); writer.close(); writer = undefined; f.store.database.exec(`PRAGMA busy_timeout=${timeout}`);
    const database = f.store.database as DatabaseSync & { exec: (sql: string) => void };
    const originalExec = database.exec.bind(database);
    database.exec = sql => {
      if (sql === "SAVEPOINT craft_atomic_1") throw new Error("database is locked");
      originalExec(sql);
    };
    try {
      assert.throws(() => f.store.transaction(() => f.store.transaction(() => {})), caught => {
        assert.equal((caught as { stage?: string }).stage, "storage_lock");
        assert.equal((caught as { safeDetails?: Record<string, unknown> }).safeDetails?.phase, "savepoint_begin");
        return true;
      });
    } finally { database.exec = originalExec; }
    const memoryStore = f.store as unknown as { memoryDatabase(scope: { kind: "global"; id: string }, domain: "memory"): { database: DatabaseSync; file: string } };
    const partition = memoryStore.memoryDatabase({ kind: "global", id: "global" }, "memory");
    partition.database.exec("PRAGMA busy_timeout=1"); partitionWriter = new DatabaseSync(partition.file);
    partitionWriter.exec("PRAGMA busy_timeout=1; BEGIN IMMEDIATE");
    assert.throws(() => run(partition.database, () => {}), caught => {
      assert.equal((caught as { stage?: string }).stage, "storage_lock");
      assert.deepEqual((caught as { safeDetails?: Record<string, unknown> }).safeDetails, {
        database_role: "capability_partition", phase: "transaction_begin", busy_timeout_ms: 1, retryable: true,
      });
      return true;
    });
    partitionWriter.exec("ROLLBACK"); partitionWriter.close(); partitionWriter = undefined;
  } finally { writer?.close(); partitionWriter?.close(); cleanup(f); }
});

test("an actual process exit after create staging recovers only an identical unpublished payload", async () => {
  const f = await fixture();
  try {
    f.store.close();
    crashAfterStage(f.root, 'store.create("knowledge_claim", "crashed", { scope: "global", content: "original" });');
    await f.store.open();
    assert.equal(f.store.find("knowledge_claim", "crashed"), null);
    assert.throws(() => f.store.create("knowledge_claim", "crashed", { scope: "global", content: "different" }), /already exists/u);
    const recovered = f.store.create("knowledge_claim", "crashed", { scope: "global", content: "original" });
    assert.equal(recovered.content, "original"); assert.equal(recovered.version, 1);
    assert.equal(partitionCount(f.paths.knowledgeDatabaseFile, "knowledge_claim"), 1);
    assert.throws(() => f.store.create("knowledge_claim", "crashed", { scope: "global", content: "original" }), /already exists/u);
  } finally { cleanup(f); }
});

test("an actual process exit during optimistic save retains the old version and permits an identical retry", async () => {
  const f = await fixture();
  try {
    f.store.create("memory_candidate", "saved", { scope: { kind: "global", id: "global" }, content: "before" });
    f.store.close();
    crashAfterStage(f.root, 'store.updateIfVersion("memory_candidate", "saved", 1, { scope: { kind: "global", id: "global" }, content: "after" });');
    await f.store.open();
    assert.equal(f.store.get("memory_candidate", "saved").content, "before");
    assert.throws(() => f.store.updateIfVersion("memory_candidate", "saved", 1, { scope: { kind: "global", id: "global" }, content: "conflict" }), /partition version conflicts/u);
    const recovered = f.store.updateIfVersion("memory_candidate", "saved", 1, { scope: { kind: "global", id: "global" }, content: "after" });
    assert.equal(recovered.content, "after"); assert.equal(recovered.version, 2);
    assert.deepEqual(f.store.history("memory_candidate", "saved", 3, 10).map(row => row.content), ["after", "before"]);
  } finally { cleanup(f); }
});

test("partition removal preserves visible bodies on outer and nested rollback", async () => {
  const f = await fixture();
  try {
    f.store.create("knowledge_claim", "kept", { scope: "global", content: "original" });
    assert.throws(() => f.store.transaction(() => {
      assert.equal(f.store.remove("knowledge_claim", "kept"), 1);
      assert.equal(f.store.find("knowledge_claim", "kept"), null);
      throw new Error("abort outer");
    }), /abort outer/u);
    assert.equal(f.store.get("knowledge_claim", "kept").content, "original");
    f.store.transaction(() => {
      assert.throws(() => f.store.transaction(() => {
        f.store.remove("knowledge_claim", "kept"); throw new Error("abort nested");
      }), /abort nested/u);
      assert.equal(f.store.get("knowledge_claim", "kept").content, "original");
    });
    assert.equal(f.store.remove("knowledge_claim", "kept"), 1);
    assert.equal(f.store.find("knowledge_claim", "kept"), null);
    assert.equal(partitionCount(f.paths.knowledgeDatabaseFile, "knowledge_claim"), 0);
  } finally { cleanup(f); }
});

test("mixed partition payload batches commit together and preserve logical record identity", async () => {
  const f = await fixture();
  try {
    f.store.create("knowledge_claim", "claim", { scope: "global", content: "old claim" });
    f.store.save("knowledge_claim", "claim", { scope: "global", content: "current claim" });
    f.store.create("memory_candidate", "memory", { scope: { kind: "global", id: "global" }, content: "old memory" });
    f.store.create("task", "task", { value: "old task" });
    const entries = [
      { kind: "knowledge_claim", id: "claim", version: 2, payload: { scope: "global", content: "new claim" } },
      { kind: "memory_candidate", id: "memory", version: 1, payload: { scope: { kind: "global", id: "global" }, content: "new memory" } },
      { kind: "task", id: "task", version: 1, payload: { value: "new task" } },
    ];
    assert.throws(() => f.store.replacePayloadBatch([...entries, { kind: "task", id: "absent", version: 1, payload: {} }]), /Unknown record version/u);
    assert.equal(f.store.get("knowledge_claim", "claim").content, "current claim");
    assert.equal(f.store.get("memory_candidate", "memory").content, "old memory");
    assert.equal(f.store.get("task", "task").value, "old task");
    assert.equal(partitionCount(f.paths.knowledgeDatabaseFile, "knowledge_claim"), 2);
    const before = f.store.latestRecordsDigest("knowledge_claim", ["claim"]);
    f.store.replacePayloadBatch(entries);
    assert.equal(f.store.get("knowledge_claim", "claim").content, "new claim");
    assert.equal(f.store.get("memory_candidate", "memory").content, "new memory");
    assert.equal(f.store.get("task", "task").value, "new task");
    assert.notEqual(f.store.latestRecordsDigest("knowledge_claim", ["claim"]), before);
    assert.deepEqual(f.store.findMany("knowledge_claim", ["claim"]).map(row => [row.id, row.version]), [["claim", 2]]);
    assert.deepEqual(f.store.history("knowledge_claim", "claim", 3, 10).map(row => row.content), ["new claim", "old claim"]);
    assert.deepEqual(f.store.rawRecords("knowledge_claim").map(row => row.id), ["claim", "claim"]);
    assert.equal(f.store.listScoped("knowledge_claim", [{ kind: "global", id: "global" }], 10)[0]!.id, "claim");
    f.store.replacePayload("knowledge_claim", "claim", 2, { scope: "global", content: "revised twice" });
    assert.equal(f.store.get("knowledge_claim", "claim").content, "revised twice");
    assert.equal(partitionCount(f.paths.knowledgeDatabaseFile, "knowledge_claim"), 4);
    assert.equal(f.store.get("knowledge_claim", "claim")._craft_logical_record_id, undefined);
    assert.equal(f.store.remove("knowledge_claim", "claim"), 2);
    assert.equal(partitionCount(f.paths.knowledgeDatabaseFile, "knowledge_claim"), 0);
  } finally { cleanup(f); }
});

test("payload replacement rolls back with its enclosing transaction and rejects scope relocation", async () => {
  const f = await fixture();
  try {
    f.store.create("knowledge_claim", "claim", { scope: "global", content: "old" });
    assert.throws(() => f.store.transaction(() => {
      f.store.replacePayload("knowledge_claim", "claim", 1, { scope: "global", content: "new" });
      assert.equal(f.store.get("knowledge_claim", "claim").content, "new");
      throw new Error("abort replacement");
    }), /abort replacement/u);
    assert.equal(f.store.get("knowledge_claim", "claim").content, "old");
    assert.equal(partitionCount(f.paths.knowledgeDatabaseFile, "knowledge_claim"), 1);
    assert.throws(() => f.store.replacePayload("knowledge_claim", "claim", 1, { scope: "project:other", content: "wrong scope" }), /change storage scope/u);
    assert.equal(f.store.get("knowledge_claim", "claim").content, "old");
  } finally { cleanup(f); }
});

test("an actual process exit during a cross-capability migration leaves all old payloads visible", async () => {
  const f = await fixture();
  try {
    f.store.create("knowledge_claim", "claim", { scope: "global", content: "old claim" });
    f.store.create("memory_candidate", "memory", { scope: { kind: "global", id: "global" }, content: "old memory" });
    f.store.close();
    const statements = 'store.replacePayloadBatch([{ kind: "knowledge_claim", id: "claim", version: 1, payload: { scope: "global", content: "new claim" } }, { kind: "memory_candidate", id: "memory", version: 1, payload: { scope: { kind: "global", id: "global" }, content: "new memory" } }]);';
    crashAfterStage(f.root, statements, 2);
    await f.store.open();
    assert.equal(f.store.get("knowledge_claim", "claim").content, "old claim");
    assert.equal(f.store.get("memory_candidate", "memory").content, "old memory");
    f.store.replacePayloadBatch([
      { kind: "knowledge_claim", id: "claim", version: 1, payload: { scope: "global", content: "new claim" } },
      { kind: "memory_candidate", id: "memory", version: 1, payload: { scope: { kind: "global", id: "global" }, content: "new memory" } },
    ]);
    assert.equal(f.store.get("knowledge_claim", "claim").content, "new claim");
    assert.equal(f.store.get("memory_candidate", "memory").content, "new memory");
  } finally { cleanup(f); }
});

test("post-commit cleanup cannot delete a staged row adopted by a concurrent successful create", async () => {
  const f = await fixture(); const second = await new CraftStore(f.paths).open();
  try {
    const payload = { scope: "global", content: "same body" };
    f.store.create("knowledge_claim", "recreated", payload);
    const internals = f.store as unknown as { cleanupMemoryRows(rows: unknown[]): void };
    const original = internals.cleanupMemoryRows.bind(f.store);
    let intervened = false;
    internals.cleanupMemoryRows = rows => {
      if (!intervened && rows.length) { intervened = true; second.create("knowledge_claim", "recreated", payload); }
      original(rows);
    };
    assert.equal(f.store.remove("knowledge_claim", "recreated"), 1);
    assert.equal(second.get("knowledge_claim", "recreated").content, "same body");
    assert.equal(f.store.get("knowledge_claim", "recreated").content, "same body");
  } finally { second.close(); cleanup(f); }
});


test("Evidence ownership cannot drift into Core or another capability through ordinary or migration writes", async () => {
  const f = await fixture();
  try {
    f.store.create("evidence", "owned", { source_type: "knowledge_fragment", metadata: { scope: "global" }, claim: "knowledge body" });
    const updated = f.store.save("evidence", "owned", { ...f.store.get("evidence", "owned"), claim: "corrected knowledge body" });
    assert.equal(updated.version, 2);
    assert.equal(f.store.get("evidence", "owned").claim, "corrected knowledge body");
    const changed = { source_type: "other", claim: "would leak" };
    assert.throws(() => f.store.save("evidence", "owned", changed), /capability storage owner/u);
    assert.throws(() => f.store.updateIfVersion("evidence", "owned", 1, changed), /capability storage owner/u);
    assert.throws(() => f.store.saveBatch([{ kind: "evidence", id: "owned", payload: changed }]), /capability storage owner/u);
    assert.throws(() => f.store.save("evidence", "owned", { ...changed, metadata: { capability_owner: "memory", scope: "global" } }), /capability storage owner/u);
    assert.throws(() => f.store.replacePayload("evidence", "owned", 1, changed), /capability storage owner/u);
    assert.equal(f.store.get("evidence", "owned").claim, "corrected knowledge body");
    const shared = String(f.store.database.prepare("SELECT payload_json FROM records WHERE kind='evidence' AND id='owned'").get()!.payload_json);
    assert.equal(shared.includes("would leak"), false);
    assert.equal(shared.includes("knowledge body"), false);
    assert.equal(f.store.get("evidence", "owned").version, 2);
  } finally { cleanup(f); }
});


test("immutable payload replacements preserve a pre-migration central backup for explicit restore", async () => {
  const f = await fixture();
  try {
    f.store.create("knowledge_claim", "recoverable", { scope: "global", content: "before migration" });
    f.store.database.exec("PRAGMA wal_checkpoint(FULL)");
    const backup = f.store.backup();
    f.store.replacePayload("knowledge_claim", "recoverable", 1, { scope: "global", content: "after migration" });
    assert.equal(f.store.get("knowledge_claim", "recoverable").content, "after migration");
    f.store.close();
    copyFileSync(backup, f.paths.databaseFile);
    await f.store.open();
    assert.equal(f.store.get("knowledge_claim", "recoverable").content, "before migration");
  } finally { cleanup(f); }
});

function insertLegacyMemory(store: CraftStore, id: string, scope: string, ref: unknown) {
  store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES('memory_ledger',?,1,?,?,?)")
    .run(id, JSON.stringify({ scope, source_id: "source", content_ref: ref }), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
}

test("Memory migration saves independently recoverable Markdown before retiring a project's global copy", async () => {
  const f = await fixture();
  try {
    const project = join(f.root, "project"); mkdirSync(project);
    f.store.create("scope_alias", "project", { scope: { kind: "project", id: "project" }, alias_kind: "path", alias: project, status: "active" });
    const ref = new MarkdownContentStore(f.paths).writeSync({ kind: "memory", record_id: "legacy", version: 1, scope: "project:project",
      status: "active", sensitivity: "internal", source_id: "source", body: "可恢复的项目记忆" });
    const original = readFileSync(ref.path, "utf8");
    insertLegacyMemory(f.store, "legacy", "project:project", ref);
    f.store.close(); await f.store.open();
    assert.equal(existsSync(ref.path), false);
    assert.equal(f.store.get("memory_ledger", "legacy").content, "可恢复的项目记忆");
    const directory = join(projectStorageDirectory(f.paths, project), "memory", "backups");
    const backup = JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]!), "utf8"));
    assert.deepEqual(backup.scope, { kind: "project", id: "project" });
    assert.equal(backup.content_snapshots.length, 1);
    const snapshot = backup.content_snapshots[0];
    assert.equal(snapshot.markdown, original);
    assert.equal(snapshot.digest, `sha256:${createHash("sha256").update(original).digest("hex")}`);
    const restored = join(f.root, "recovered.md"); writeFileSync(restored, snapshot.markdown);
    const parsed = f.store.contentStore.readUncheckedSync(restored);
    assert.equal(parsed.body, "可恢复的项目记忆"); assert.equal(parsed.manifest.scope, "project:project");
  } finally { cleanup(f); }
});

test("Memory's canonical global scope spelling remains readable after legacy partition migration", async () => {
  const f = await fixture();
  try {
    const ref = new MarkdownContentStore(f.paths).writeSync({ kind: "memory", record_id: "legacy-global", version: 1, scope: "global",
      status: "active", sensitivity: "internal", source_id: "source", body: "global body" });
    insertLegacyMemory(f.store, "legacy-global", "global", ref);
    f.store.close(); await f.store.open();
    assert.equal(f.store.get("memory_ledger", "legacy-global").content, "global body");
  } finally { cleanup(f); }
});

test("Memory and Knowledge reject foreign-scope content before writing it into another project's backup", async () => {
  for (const domain of ["memory", "knowledge"] as const) {
    const f = await fixture();
    try {
      for (const id of ["a", "b"]) {
        const root = join(f.root, id); mkdirSync(root);
        f.store.create("scope_alias", id, { scope: { kind: "project", id }, alias_kind: "path", alias: root, status: "active" });
      }
      const ref = new MarkdownContentStore(f.paths).writeSync({ kind: domain, record_id: "foreign", version: 1, scope: "project:b",
        status: "active", sensitivity: "internal", source_id: "source", body: "B项目私有正文" });
      if (domain === "memory") {
        insertLegacyMemory(f.store, "foreign", "project:a", ref);
        f.store.close(); await assert.rejects(f.store.open(), /content scope drifted/u);
      } else {
        f.store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES('knowledge_claim','foreign',1,?,?,?)")
          .run(JSON.stringify({ scope: "project:a", content_ref: ref }), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
        const result = f.store.reconcileKnowledgeStorage();
        assert.equal((result.blocked as unknown[]).length, 1); assert.equal(result.migrated, 0);
      }
      assert.equal(existsSync(join(projectStorageDirectory(f.paths, join(f.root, "a")), domain, "backups")), false);
      assert.equal(readFileSync(ref.path, "utf8").includes("B项目私有正文"), true);
    } finally { cleanup(f); }
  }
});

test("Memory migration backup rejects symlinks, oversized bodies, identity drift and content changes", async () => {
  for (const fault of ["symlink", "oversized", "identity", "changed"] as const) {
    const f = await fixture();
    try {
      const ref = new MarkdownContentStore(f.paths).writeSync({ kind: "memory", record_id: "legacy", version: 1, scope: "global:global",
        status: "active", sensitivity: "internal", source_id: "source", body: "original body" });
      if (fault === "symlink") { const copied = `${ref.path}.copy`; copyFileSync(ref.path, copied); unlinkSync(ref.path); symlinkSync(copied, ref.path); }
      if (fault === "oversized") truncateSync(ref.path, 8 * 1024 * 1024 + 1);
      insertLegacyMemory(f.store, fault === "identity" ? "other-id" : "legacy", "global", ref);
      f.store.close();
      if (fault === "changed") {
        const original = f.store.contentStore.readCompatSync.bind(f.store.contentStore);
        f.store.contentStore.readCompatSync = (candidate, expected) => {
          const result = original(candidate, expected);
          writeFileSync(candidate.path, `${readFileSync(candidate.path, "utf8")}changed`);
          return result;
        };
      }
      await assert.rejects(f.store.open(), /bounded regular file|content identity drifted|content changed concurrently/u);
      assert.equal(existsSync(join(f.paths.memoryDir, "backups")), false);
    } finally { cleanup(f); }
  }
});

test("publication never waits on a held partition writer and releases its central lock on failure", async () => {
  const f = await fixture(); let writer: DatabaseSync | undefined;
  try {
    f.store.create("knowledge_claim", "warmup", { scope: "global", content: "warmup" });
    writer = new DatabaseSync(f.paths.knowledgeDatabaseFile); writer.exec("BEGIN IMMEDIATE");
    const start = performance.now();
    assert.throws(() => f.store.create("knowledge_claim", "blocked", { scope: "global", content: "body" }), /locked/u);
    assert.ok(performance.now() - start < 1_000, "partition contention must fail promptly while the publication lock is held");
    const central = new DatabaseSync(f.paths.databaseFile);
    try { central.exec("PRAGMA busy_timeout=1; BEGIN IMMEDIATE; ROLLBACK"); } finally { central.close(); }
    writer.exec("ROLLBACK");
    assert.equal(f.store.create("knowledge_claim", "blocked", { scope: "global", content: "body" }).version, 1);
    const internals = f.store as unknown as { memoryDatabase(scope: { kind: string; id: string }, domain: string): { database: DatabaseSync } };
    assert.equal(Number(internals.memoryDatabase({ kind: "global", id: "global" }, "knowledge").database.prepare("PRAGMA busy_timeout").get()!.timeout), 15_000);
  } finally { writer?.close(); cleanup(f); }
});

test("a failed physical retirement reports committed visibility and retries cleanup on a later write", async () => {
  const f = await fixture(); let writer: DatabaseSync | undefined;
  try {
    f.store.create("knowledge_claim", "retired", { scope: "global", content: "body" });
    writer = new DatabaseSync(f.paths.knowledgeDatabaseFile); writer.exec("BEGIN IMMEDIATE");
    assert.throws(() => f.store.remove("knowledge_claim", "retired"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code: string }).code, "CRAFT_PARTITION_RETIREMENT_PENDING");
      assert.equal((error as Error & { committed: boolean }).committed, true);
      return true;
    });
    assert.equal(f.store.find("knowledge_claim", "retired"), null);
    assert.equal(partitionCount(f.paths.knowledgeDatabaseFile, "knowledge_claim"), 1);
    writer.exec("ROLLBACK");
    f.store.create("task", "retry-trigger", {});
    assert.equal(partitionCount(f.paths.knowledgeDatabaseFile, "knowledge_claim"), 0);
  } finally { writer?.close(); cleanup(f); }
});

test("an actual process exit after removal publication never exposes a dangling pointer", async () => {
  const f = await fixture();
  try {
    const payload = { scope: "global", content: "retired body" };
    f.store.create("knowledge_claim", "retired", payload); f.store.close();
    const source = `
      import { CraftStore } from ${JSON.stringify(new URL("../core/infrastructure/store.ts", import.meta.url).href)};
      import { craftPaths } from ${JSON.stringify(new URL("../core/infrastructure/paths.ts", import.meta.url).href)};
      const store = await new CraftStore(craftPaths(${JSON.stringify(join(f.root, "data"))})).open();
      store.cleanupMemoryRows = rows => { if (rows.length) process.exit(73); };
      store.remove("knowledge_claim", "retired"); process.exit(74);
    `;
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], { encoding: "utf8", timeout: 20_000 });
    assert.equal(child.error, undefined); assert.equal(child.status, 73, child.stderr);
    await f.store.open();
    assert.equal(f.store.find("knowledge_claim", "retired"), null);
    assert.equal(f.store.create("knowledge_claim", "retired", payload).content, "retired body");
  } finally { cleanup(f); }
});

test("a nested staged write is cleaned while its enclosing transaction remains usable", async () => {
  const f = await fixture();
  try {
    f.store.transaction(() => {
      assert.throws(() => f.store.transaction(() => {
        f.store.create("knowledge_claim", "nested", { scope: "global", content: "unpublished" });
        throw new Error("abort staged savepoint");
      }), /abort staged savepoint/u);
      assert.equal(f.store.find("knowledge_claim", "nested"), null);
      assert.equal(partitionCount(f.paths.knowledgeDatabaseFile, "knowledge_claim"), 0);
      f.store.create("task", "outer-survives", {});
    });
    assert.ok(f.store.get("task", "outer-survives"));
  } finally { cleanup(f); }
});

test("rollback cleanup preserves an unpublished row another writer legitimately adopted after rollback", async () => {
  const f = await fixture(); const second = await new CraftStore(f.paths).open();
  try {
    const payload = { scope: "global", content: "same body" };
    const internals = f.store as unknown as { cleanupMemoryRows(rows: unknown[]): void };
    const original = internals.cleanupMemoryRows.bind(f.store);
    let intervened = false;
    internals.cleanupMemoryRows = rows => {
      if (!intervened && rows.length) { intervened = true; second.create("knowledge_claim", "adopted", payload); }
      original(rows);
    };
    assert.throws(() => f.store.transaction(() => {
      f.store.create("knowledge_claim", "adopted", payload); throw new Error("abort original writer");
    }), /abort original writer/u);
    assert.equal(second.get("knowledge_claim", "adopted").content, "same body");
    assert.equal(f.store.get("knowledge_claim", "adopted").content, "same body");
  } finally { second.close(); cleanup(f); }
});

test("Memory revalidates scope immediately before writing a backed-up document to its destination", async () => {
  const f = await fixture();
  try {
    const ref = new MarkdownContentStore(f.paths).writeSync({ kind: "memory", record_id: "legacy", version: 1, scope: "global:global",
      status: "active", sensitivity: "internal", source_id: "source", body: "original body" });
    insertLegacyMemory(f.store, "legacy", "global", ref); f.store.close();
    const original = f.store.contentStore.readCompatSync.bind(f.store.contentStore);
    let reads = 0;
    f.store.contentStore.readCompatSync = (candidate, expected) => {
      const result = original(candidate, expected);
      return ++reads === 2 ? { ...result, manifest: { ...result.manifest, scope: "project:foreign" } } : result;
    };
    await assert.rejects(f.store.open(), /content scope drifted/u);
    assert.equal(readFileSync(ref.path, "utf8").includes("original body"), true);
  } finally { cleanup(f); }
});

test("a metadata snapshot resolves its captured immutable payload after a concurrent migration", async () => {
  const f = await fixture();
  try {
    f.store.create("knowledge_claim", "claim", { scope: "global", content: "before" });
    const snapshot = f.store.database.prepare("SELECT * FROM records WHERE kind='knowledge_claim' AND id='claim'").get()!;
    f.store.replacePayload("knowledge_claim", "claim", 1, { scope: "global", content: "after" });
    const internals = f.store as unknown as { recordFromSnapshot(row: Record<string, unknown>, hydrate: boolean): Record<string, unknown> };
    assert.equal(internals.recordFromSnapshot(snapshot, false).content, "before");
    assert.equal(f.store.get("knowledge_claim", "claim").content, "after");
  } finally { cleanup(f); }
});
