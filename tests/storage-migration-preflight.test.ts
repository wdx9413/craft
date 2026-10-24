import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { stableDigest } from "../common/craft-common-base/src/digest.ts";
import { craftPaths, projectStorageDirectory, sessionStorageDirectory, sessionStorageScopeId } from "../common/craft-common-store-local/src/paths.ts";
import { CraftStore } from "../common/craft-common-store-local/src/store.ts";
import { StorageMigrationPreflightReader, storageMigrationPreflight } from "../core/storage-migration-preflight.ts";

test("storage preflight pages current, legacy, blocked and missing pointers without changing files", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-storage-preflight-"));
  const paths = craftPaths(join(root, "data"));
  const project = join(root, "project"), other = join(root, "other");
  mkdirSync(project); mkdirSync(other);
  const store = await new CraftStore(paths).open();
  try {
    const alias = (id: string, scopeId: string, path: string) => store.create("scope_alias", id,
      { status: "active", alias_kind: "path", alias: path, alias_digest: stableDigest(path), scope: { kind: "project", id: scopeId } });
    alias("project", "project:demo", project);
    alias("ambig-a", "project:ambig", project);
    alias("ambig-b", "project:ambig", other);
    store.create("memory_ledger", "current-global", { scope: { kind: "global", id: "global" }, status: "active", content: "global" });
    store.create("memory_ledger", "legacy-project", { scope: { kind: "project", id: "project:demo" }, status: "active", content: "project" });
    const addPointer = (id: string, scope: { kind: string; id: string }, file: string) => {
      const now = new Date().toISOString();
      store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
        .run("memory_candidate", id, 1, JSON.stringify({ _memory_partition: { file, scope } }), now, now);
    };
    addPointer("missing-root", { kind: "project", id: "project:missing" }, join(root, "none.db"));
    addPointer("ambiguous-root", { kind: "project", id: "project:ambig" }, join(root, "none.db"));
    addPointer("unbound-session", { kind: "session", id: `unbound-${randomUUID()}` }, join(root, "none.db"));
    addPointer("outside-pointer", { kind: "project", id: "project:demo" }, join(root, "outside.db"));
    const missingLegacy = join(other, ".craft_data", "memory", "memory.db");
    alias("other", "project:other", other);
    addPointer("missing-file", { kind: "project", id: "project:other" }, missingLegacy);
    store.close();
    const currentFile = join(projectStorageDirectory(paths, project), "memory", "memory.db");
    const legacyFile = join(project, ".craft_data", "memory", "memory.db");
    mkdirSync(dirname(legacyFile), { recursive: true }); renameSync(currentFile, legacyFile);
    const database = new (await import("node:sqlite")).DatabaseSync(paths.databaseFile);
    try {
      const row = database.prepare("SELECT payload_json FROM records WHERE kind='memory_ledger' AND id='legacy-project'").get() as { payload_json: string };
      const payload = JSON.parse(row.payload_json) as Record<string, { file: string }>;
      payload._memory_partition!.file = legacyFile;
      database.prepare("UPDATE records SET payload_json=? WHERE kind='memory_ledger' AND id='legacy-project'").run(JSON.stringify(payload));
    } finally { database.close(); }
    const seen = new Map<string, string>();
    let cursor: string | undefined;
    const reader = new StorageMigrationPreflightReader(paths);
    try {
      do {
        const page = reader.readPage({ max_records: 2, ...(cursor ? { cursor } : {}) });
        assert(page.entries.length <= 2);
        for (const entry of page.entries) seen.set(entry.id, entry.status);
        cursor = page.next_cursor ?? undefined;
        assert.equal(page.unpartitioned_knowledge_versions, 0);
        assert.equal(page.codebase_checkpoint_versions, 0);
      } while (cursor);
    } finally { reader.close(); }
    reader.close();
    assert.throws(() => reader.readPage(), /reader is closed/u);
    assert.equal(seen.get("current-global"), "current");
    assert.equal(seen.get("legacy-project"), "legacy_ready");
    assert.equal(seen.get("missing-root"), "missing_root");
    assert.equal(seen.get("ambiguous-root"), "ambiguous_root");
    assert.equal(seen.get("unbound-session"), "unbound_session");
    assert.equal(seen.get("outside-pointer"), "pointer_out_of_scope");
    assert.equal(seen.get("missing-file"), "missing_file");
    assert.throws(() => storageMigrationPreflight(paths, { max_records: 0 }), /max_records/u);
    assert.throws(() => storageMigrationPreflight(paths, { cursor: "bad!" }), /cursor is invalid/u);
    assert.throws(() => storageMigrationPreflight(paths, { cursor: Buffer.from("[]").toString("base64url") }), /cursor is invalid/u);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("physical-pointer migration opens without rewriting unrelated legacy capability records", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-storage-migration-isolation-"));
  const paths = craftPaths(join(root, "data"));
  let store = await new CraftStore(paths).open();
  try {
    const now = new Date().toISOString();
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("memory_candidate", "unpartitioned", 1, JSON.stringify({ scope: { kind: "global", id: "global" }, content: "old" }), now, now);
    store.close();
    store = await new CraftStore(paths).open({ skipLegacyPartitionMigration: true });
    const before = store.database.prepare("SELECT payload_json FROM records WHERE kind='memory_candidate' AND id='unpartitioned'")
      .get() as { payload_json: string };
    assert.equal(JSON.parse(before.payload_json)._memory_partition, undefined);
    store.close();
    store = await new CraftStore(paths).open();
    const after = store.database.prepare("SELECT payload_json FROM records WHERE kind='memory_candidate' AND id='unpartitioned'")
      .get() as { payload_json: string };
    assert.equal(typeof JSON.parse(after.payload_json)._memory_partition?.file, "string");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("storage preflight binds session paths to the exact Host identity and rejects malformed bindings", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-session-preflight-")), paths = craftPaths(join(root, "data"));
  const store = await new CraftStore(paths).open();
  try {
    const put = (kind: string, id: string, payload: unknown, version = 1) => store.database.prepare(
      "INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    ).run(kind, id, version, JSON.stringify(payload), "now", "now");
    const pointer = (id: string, file: string, scopeId = id) => put("memory_candidate", id, { _memory_partition: { file, scope: { kind: "session", id: scopeId } } });
    const bind = (id: string, payload: unknown) => put("session_storage_identity",
      `session_storage_${createHash("sha256").update(id).digest("hex")}`, payload);
    const bindId = (id: string, payload: unknown) => put("session_storage_identity", id, payload);
    const current = join(sessionStorageDirectory(paths, "codex", "current"), "memory", "memory.db");
    mkdirSync(dirname(current), { recursive: true }); writeFileSync(current, "fixture");
    bind("current", { host: "codex", session_id: "current" }); pointer("current", current);
    const currentScopedRoot = store.bindSessionStorageHost("same-raw-id", "claude");
    const currentScoped = join(currentScopedRoot, "memory", "memory.db");
    mkdirSync(dirname(currentScoped), { recursive: true }); writeFileSync(currentScoped, "fixture");
    pointer("current-scoped", currentScoped, sessionStorageScopeId("claude", "same-raw-id"));
    for (const id of ["plain", "hashed", "outside"]) bind(id, { host: "codex", session_id: id });
    pointer("plain", join("/tmp", ".craft_data", "memory", "plain", "memory.db"));
    pointer("hashed", join("/tmp", ".craft_data", "memory", createHash("sha256").update("hashed").digest("hex").slice(0, 32), "memory.db"));
    pointer("outside", join(root, "foreign.db"));
    pointer("invalid-host-type", join("/tmp", ".craft_data", "memory", "invalid-host-type", "memory.db"));
    bind("invalid-host-type", { host: 42, session_id: "invalid-host-type" });
    pointer("ambiguous", join("/tmp", ".craft_data", "memory", "ambiguous", "memory.db"));
    bindId("session_storage_ambiguous_one", { host: "codex", session_id: "ambiguous" });
    bindId("session_storage_ambiguous_two", { host: "claude", session_id: "ambiguous" });
    const parsedRawId = "parsed-mismatch", parsedScopeId = sessionStorageScopeId("codex", parsedRawId);
    const parsedBindingId = `session_storage_${createHash("sha256").update(parsedScopeId).digest("hex")}`;
    bindId(parsedBindingId, { host: "claude", session_id: parsedRawId,
      session_digest: createHash("sha256").update(parsedRawId).digest("hex"), scope_id: parsedScopeId });
    pointer("parsed-mismatch", join("/tmp", ".craft_data", "memory", parsedRawId, "memory.db"), parsedScopeId);
    const parsedNullId = "parsed-null", parsedNullScope = sessionStorageScopeId("codex", parsedNullId);
    const parsedNullBindingId = `session_storage_${createHash("sha256").update(parsedNullScope).digest("hex")}`;
    bindId(parsedNullBindingId, { host: "codex", session_id: null,
      session_digest: createHash("sha256").update(parsedNullId).digest("hex"), scope_id: parsedNullScope });
    const parsedNullTarget = join(sessionStorageDirectory(paths, "codex", parsedNullScope), "memory", "memory.db");
    mkdirSync(dirname(parsedNullTarget), { recursive: true }); writeFileSync(parsedNullTarget, "fixture");
    pointer("parsed-null", parsedNullTarget, parsedNullScope);
    bind("legacy-bound-scope", { host: "codex", session_id: "legacy-bound-scope",
      scope_id: sessionStorageScopeId("codex", "legacy-bound-scope") });
    pointer("legacy-bound-scope", join("/tmp", ".craft_data", "memory", "legacy-bound-scope", "memory.db"));
    bind("legacy-mismatched-scope", { host: "codex", session_id: "legacy-mismatched-scope", scope_id: "wrong-scope" });
    pointer("legacy-mismatched-scope", join("/tmp", ".craft_data", "memory", "legacy-mismatched-scope", "memory.db"));
    const versionedId = `session_storage_${createHash("sha256").update("versioned").digest("hex")}`;
    put("session_storage_identity", versionedId, { host: "codex", session_id: "versioned" }, 1);
    put("session_storage_identity", versionedId, { host: "codex", session_id: "versioned" }, 2);
    pointer("versioned", join("/tmp", ".craft_data", "memory", "versioned", "memory.db"));
    bind("mismatch", { host: "codex", session_id: "another-session" }); pointer("mismatch", current);
    bind("invalid-host", { host: "../codex", session_id: "invalid-host" }); pointer("invalid-host", current);
    const entries = storageMigrationPreflight(paths, { max_records: 20 }).entries;
    const statuses = Object.fromEntries(entries.map(item => [item.id, item.status]));
    assert.deepEqual(statuses, { ambiguous: "unbound_session", current: "current", "current-scoped": "current", hashed: "missing_file",
      "invalid-host": "unbound_session", "invalid-host-type": "unbound_session", "legacy-bound-scope": "missing_file",
      "legacy-mismatched-scope": "unbound_session", mismatch: "unbound_session", outside: "pointer_out_of_scope",
      "parsed-mismatch": "unbound_session", "parsed-null": "current", plain: "missing_file", versioned: "missing_file" });
    assert.equal(entries.find(item => item.id === "invalid-host")?.target_file, null);
    pointer("invalid-file", "bad\u0000file");
    assert.throws(() => storageMigrationPreflight(paths, { max_records: 20 }), /null bytes/u);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("storage preflight handles empty stores, invalid aliases and malformed physical pointers", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-storage-preflight-malformed-")), paths = craftPaths(join(root, "data"));
  const store = await new CraftStore(paths).open();
  try {
    assert.equal(storageMigrationPreflight(paths).examined, 0);
    assert.throws(() => storageMigrationPreflight(paths, { cursor: Buffer.from("{").toString("base64url") }), /cursor is invalid/u);
    const project = join(root, "project"); mkdirSync(project);
    const file = join(root, "file"); writeFileSync(file, "not directory");
    for (const [id, path, status] of [["file", file, "active"], ["missing", join(root, "gone"), "active"], ["inactive", project, "retired"], ["valid", project, "active"]]) {
      store.create("scope_alias", id!, { status, alias_kind: "path", alias: path, alias_digest: stableDigest(path), scope: { kind: "project", id: "project:demo" } });
    }
    const put = (id: string, payload: unknown) => store.database.prepare(
      "INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES('memory_candidate',?,1,?,'now','now')",
    ).run(id, JSON.stringify(payload));
    const target = join(projectStorageDirectory(paths, project), "memory", "memory.db");
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, "fixture");
    put("project", { _memory_partition: { file: target, scope: { kind: "project", id: "demo" } } });
    put("malformed", { _memory_partition: { file: 42 } });
    const shared = paths.memoryDatabaseFile, saved = `${shared}.saved`;
    renameSync(shared, saved); symlinkSync(saved, shared);
    put("linked", { _memory_partition: { file: shared, scope: { kind: "global", id: "global" } } });
    const statuses = Object.fromEntries(storageMigrationPreflight(paths).entries.map(item => [item.id, item.status]));
    assert.deepEqual(statuses, { linked: "missing_file", malformed: "pointer_out_of_scope", project: "current" });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("storage preflight reader closes its read-only handle if metadata setup fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-storage-preflight-open-failure-")), paths = craftPaths(join(root, "data"));
  try {
    mkdirSync(dirname(paths.databaseFile), { recursive: true });
    const database = new (await import("node:sqlite")).DatabaseSync(paths.databaseFile);
    database.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY)");
    database.close();
    assert.throws(() => new StorageMigrationPreflightReader(paths));
    const reopened = new (await import("node:sqlite")).DatabaseSync(paths.databaseFile, { readOnly: true });
    reopened.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("storage preflight resolves only valid project identity roots", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-storage-preflight-identities-")), paths = craftPaths(join(root, "data"));
  const store = await new CraftStore(paths).open();
  try {
    const project = join(root, "project"), notDirectory = join(root, "file"), missing = join(root, "missing");
    mkdirSync(project); writeFileSync(notDirectory, "file");
    const putIdentity = (id: string, canonical: unknown, localPath: unknown, digestOverride?: string) => {
      const identity = { canonical_scope: canonical, project_kind: "git", remote_digest: "remote-digest" };
      store.create("project_identity", id, { ...identity, local_path_alias: localPath,
        identity_digest: digestOverride ?? stableDigest({ canonical, project_kind: identity.project_kind, remote_digest: identity.remote_digest }) });
    };
    putIdentity("project:not-project", { kind: "user", id: "project:not-project" }, project);
    putIdentity("project:wrong-id", { kind: "project", id: "project:another-id" }, project);
    putIdentity("project:not-string", { kind: "project", id: "project:not-string" }, 42);
    putIdentity("project:relative", { kind: "project", id: "project:relative" }, "relative/path");
    putIdentity("project:bad-digest", { kind: "project", id: "project:bad-digest" }, project, "sha256:wrong");
    putIdentity("project:file", { kind: "project", id: "project:file" }, notDirectory);
    putIdentity("project:missing", { kind: "project", id: "project:missing" }, missing);
    putIdentity("project:identity", { kind: "project", id: "project:identity" }, project);
    const projectRoots = (store as unknown as { projectRoots(projectId: string): string[] }).projectRoots.bind(store);
    assert.deepEqual(projectRoots("identity"), [realpathSync(project)]);
    for (const id of ["not-project", "wrong-id", "not-string", "relative", "bad-digest", "file", "missing"]) {
      assert.deepEqual(projectRoots(id), [], `invalid project identity ${id} must not authorize a storage root`);
    }
    const target = join(projectStorageDirectory(paths, project), "memory", "memory.db");
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, "fixture");
    const now = new Date().toISOString();
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("memory_candidate", "identity-pointer", 1,
        JSON.stringify({ _memory_partition: { file: target, scope: { kind: "project", id: "project:identity" } } }), now, now);

    const reader = new StorageMigrationPreflightReader(paths);
    try {
      const entries = reader.readPage().entries;
      assert.deepEqual(entries.map(item => [item.id, item.status]), [["identity-pointer", "current"]]);
    } finally { reader.close(); }
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
