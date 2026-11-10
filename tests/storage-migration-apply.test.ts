import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { stableDigest } from "../common/craft-common-base/src/digest.ts";
import { craftPaths } from "../common/craft-common-store-local/src/paths.ts";
import { CraftStore } from "../common/craft-common-store-local/src/store.ts";

test("storage apply validates its arguments and supports a read-only inventory", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-storage-apply-inventory-"));
  const paths = craftPaths(join(root, "data"));
  const legacyRoot = join(root, "legacy"); mkdirSync(legacyRoot);
  const store = await new CraftStore(paths).open(); store.close();
  const script = join(import.meta.dirname, "../scripts/storage-migration-apply.ts");
  try {
    const invalid = spawnSync(process.execPath, ["--experimental-strip-types", script, "--unknown"], { encoding: "utf8", timeout: 60_000 });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /Usage: storage-migration-apply/u);
    for (const args of [["--data-root="], ["--data-root=   "], ["--legacy-session-memory-root="],
      ["--legacy-session-memory-root=  "], ["--apply", "--apply"]]) {
      const rejected = spawnSync(process.execPath, ["--experimental-strip-types", script, ...args], { encoding: "utf8", timeout: 60_000 });
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /Usage: storage-migration-apply/u);
      assert.equal(rejected.stdout, "");
    }
    const dry = spawnSync(process.execPath, ["--experimental-strip-types", script, `--data-root=${paths.root}`,
      `--legacy-session-memory-root=${legacyRoot}`], { encoding: "utf8", timeout: 60_000 });
    assert.equal(dry.status, 0, dry.stderr);
    const report = JSON.parse(dry.stdout) as { mode: string; migratable: number };
    assert.equal(report.mode, "dry_run");
    assert.equal(report.migratable, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("storage apply cannot succeed while a Codebase checkpoint lacks its workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-storage-apply-codebase-"));
  const paths = craftPaths(join(root, "data")), legacyRoot = join(root, "legacy"); mkdirSync(legacyRoot);
  const store = await new CraftStore(paths).open();
  try {
    const now = new Date().toISOString();
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("workspace_checkpoint", "checkpoint", 1, JSON.stringify({ workspace_id: "missing", state_revision: 1,
        snapshot_root: join(root, "snapshot"), entries: [] }), now, now);
  } finally { store.close(); }
  try {
    const applied = spawnSync(process.execPath, ["--experimental-strip-types", join(import.meta.dirname, "../scripts/storage-migration-apply.ts"),
      `--data-root=${paths.root}`, `--legacy-session-memory-root=${legacyRoot}`, "--apply"], { encoding: "utf8", timeout: 60_000 });
    assert.equal(applied.status, 2, applied.stderr);
    const report = JSON.parse(applied.stdout) as { remaining: number; codebase_statuses: Record<string, number> };
    assert.equal(report.remaining, 1);
    assert.deepEqual(report.codebase_statuses, { missing_workspace: 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("storage apply reports unpartitioned Knowledge versions as unfinished", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-storage-apply-unpartitioned-"));
  const paths = craftPaths(join(root, "data")), legacyRoot = join(root, "legacy"); mkdirSync(legacyRoot);
  const store = await new CraftStore(paths).open();
  try {
    const now = new Date().toISOString();
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("knowledge_claim", "historical", 1, JSON.stringify({ scope: "project:unknown" }), now, now);
  } finally { store.close(); }
  try {
    const command = ["--experimental-strip-types", join(import.meta.dirname, "../scripts/storage-migration-apply.ts"),
      `--data-root=${paths.root}`, `--legacy-session-memory-root=${legacyRoot}`];
    const dry = spawnSync(process.execPath, command, { encoding: "utf8", timeout: 60_000 });
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal((JSON.parse(dry.stdout) as { unpartitioned_knowledge_versions: number }).unpartitioned_knowledge_versions, 1);
    const applied = spawnSync(process.execPath, [...command, "--apply"], { encoding: "utf8", timeout: 60_000 });
    assert.equal(applied.status, 2, applied.stderr);
    const report = JSON.parse(applied.stdout) as { remaining: number; unpartitioned_knowledge_versions: number; knowledge_failure_kinds: Record<string, number>; knowledge_failure_phases: Record<string, number> };
    assert.equal(report.unpartitioned_knowledge_versions, 1);
    assert.equal(report.remaining, 1);
    assert.deepEqual(report.knowledge_failure_kinds, { project_root_missing: 1 });
    assert.deepEqual(report.knowledge_failure_phases, { scope_resolution: 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("storage apply migrates a valid unpartitioned global Knowledge version", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-storage-apply-knowledge-"));
  const paths = craftPaths(join(root, "data")), legacyRoot = join(root, "legacy"); mkdirSync(legacyRoot);
  const store = await new CraftStore(paths).open();
  try {
    const now = new Date().toISOString();
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("knowledge_claim", "global-historical", 1, JSON.stringify({ scope: "global", content: "fixture" }), now, now);
  } finally { store.close(); }
  try {
    const applied = spawnSync(process.execPath, ["--experimental-strip-types", join(import.meta.dirname, "../scripts/storage-migration-apply.ts"),
      `--data-root=${paths.root}`, `--legacy-session-memory-root=${legacyRoot}`, "--apply"], { encoding: "utf8", timeout: 60_000 });
    assert.equal(applied.status, 0, applied.stderr);
    const report = JSON.parse(applied.stdout) as { knowledge_migrated: number; unpartitioned_knowledge_versions: number };
    assert.equal(report.knowledge_migrated, 1);
    assert.equal(report.unpartitioned_knowledge_versions, 0);
    const readback = await new CraftStore(paths).open({ skipLegacyPartitionMigration: true });
    try { assert.equal(readback.get("knowledge_claim", "global-historical").content, "fixture"); }
    finally { readback.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("storage apply discovers unpartitioned Knowledge sources without claims", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-storage-apply-source-"));
  const paths = craftPaths(join(root, "data")), legacyRoot = join(root, "legacy"); mkdirSync(legacyRoot);
  const store = await new CraftStore(paths).open();
  try {
    const now = new Date().toISOString();
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("knowledge_source", "historical-source", 1, JSON.stringify({ scope: "global", title: "fixture" }), now, now);
  } finally { store.close(); }
  try {
    const applied = spawnSync(process.execPath, ["--experimental-strip-types", join(import.meta.dirname, "../scripts/storage-migration-apply.ts"),
      `--data-root=${paths.root}`, `--legacy-session-memory-root=${legacyRoot}`, "--apply"], { encoding: "utf8", timeout: 60_000 });
    assert.equal(applied.status, 0, applied.stderr);
    const report = JSON.parse(applied.stdout) as { knowledge_migrated: number; unpartitioned_knowledge_versions: number };
    assert.equal(report.knowledge_migrated, 1);
    assert.equal(report.unpartitioned_knowledge_versions, 0);
    const readback = await new CraftStore(paths).open({ skipLegacyPartitionMigration: true });
    try { assert.equal(readback.get("knowledge_source", "historical-source").title, "fixture"); }
    finally { readback.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("storage apply reports each unresolved pointer without migrating or hiding its status", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-storage-apply-report-"));
  const dataRoot = join(root, "data"), projectRoot = join(root, "project"), legacyMemoryRoot = join(root, "legacy-memory");
  mkdirSync(projectRoot); mkdirSync(legacyMemoryRoot);
  const store = await new CraftStore(craftPaths(dataRoot)).open();
  try {
    const alias = { kind: "project", id: "project:report-fixture" };
    store.create("scope_alias", "report-fixture-alias", { scope: alias, alias_kind: "path", alias: projectRoot,
      alias_digest: stableDigest(projectRoot), status: "active" });
    const now = new Date().toISOString();
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("memory_candidate", "unresolved-fixture", 1, JSON.stringify({
        _memory_partition: { file: join(projectRoot, ".craft_data", "memory", "memory.db"), scope: alias },
      }), now, now);
  } finally { store.close(); }

  try {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", join(import.meta.dirname, "../scripts/storage-migration-apply.ts"),
      `--data-root=${dataRoot}`, `--legacy-session-memory-root=${legacyMemoryRoot}`, "--apply"], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout) as { mode: string; blocked_entries: Array<Record<string, unknown>>; project_identity_statuses: Record<string, number> };
    assert.equal(report.mode, "blocked");
    assert.deepEqual(report.project_identity_statuses, { migration_required: 1 });
    assert.deepEqual(report.blocked_entries, [{ kind: "memory_candidate", id: "unresolved-fixture", version: 1, status: "missing_file", project_scope_digest: stableDigest("project:report-fixture") }]);
    const unchanged = await new CraftStore(craftPaths(dataRoot)).open({ skipLegacyPartitionMigration: true });
    try {
      assert.equal(unchanged.database.prepare("SELECT count(*) AS count FROM records WHERE kind='memory_candidate' AND id='unresolved-fixture'")
        .get()?.count, 1);
    } finally { unchanged.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("storage apply cannot report success while old project identities remain", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-storage-apply-identity-"));
  const dataRoot = join(root, "data"), projectRoot = join(root, "project"), legacyMemoryRoot = join(root, "legacy-memory");
  mkdirSync(projectRoot); mkdirSync(legacyMemoryRoot);
  const store = await new CraftStore(craftPaths(dataRoot)).open();
  try {
    const scope = { kind: "project", id: "project:old-identity" };
    store.create("scope_alias", "old-identity-alias", { scope, alias_kind: "path", alias: projectRoot,
      alias_digest: stableDigest(projectRoot), status: "active" });
    store.create("memory_ledger", "project-memory", { scope, status: "active", content: "fixture" });
  } finally { store.close(); }
  try {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", join(import.meta.dirname, "../scripts/storage-migration-apply.ts"),
      `--data-root=${dataRoot}`, `--legacy-session-memory-root=${legacyMemoryRoot}`, "--apply"], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout) as { mode: string; remaining: number; identity_remaining: number; project_identity_statuses: Record<string, number> };
    assert.equal(report.mode, "apply");
    assert.equal(report.remaining, 0);
    assert.equal(report.identity_remaining, 1);
    assert.deepEqual(report.project_identity_statuses, { migration_required: 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("storage apply succeeds when neither physical nor identity migration remains", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-storage-apply-empty-"));
  const dataRoot = join(root, "data"), legacyMemoryRoot = join(root, "legacy-memory");
  mkdirSync(legacyMemoryRoot);
  const store = await new CraftStore(craftPaths(dataRoot)).open();
  store.close();
  try {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", join(import.meta.dirname, "../scripts/storage-migration-apply.ts"),
      `--data-root=${dataRoot}`, `--legacy-session-memory-root=${legacyMemoryRoot}`, "--apply"], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as { remaining: number; identity_remaining: number };
    assert.equal(report.remaining, 0);
    assert.equal(report.identity_remaining, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("storage apply preserves legacy session source after making a quarantine copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-storage-apply-retain-"));
  const dataRoot = join(root, "data"), legacyMemoryRoot = join(root, "legacy-memory");
  const source = join(legacyMemoryRoot, "unknown-session"); mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "memory.md"), "fixture");
  const store = await new CraftStore(craftPaths(dataRoot)).open(); store.close();
  try {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", join(import.meta.dirname, "../scripts/storage-migration-apply.ts"),
      `--data-root=${dataRoot}`, `--legacy-session-memory-root=${legacyMemoryRoot}`, "--apply"], { encoding: "utf8", timeout: 60_000 });
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout) as { remaining: number; legacy_session_memory: { quarantined: number; retirement_deferred: boolean } };
    assert.equal(report.remaining, 1);
    assert.equal(report.legacy_session_memory.quarantined, 1);
    assert.equal(report.legacy_session_memory.retirement_deferred, true);
    assert.equal(existsSync(join(source, "memory.md")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("storage apply migrates safe records while retaining unresolved records and is repeatable", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-storage-apply-partial-"));
  const dataRoot = join(root, "data"), projectRoot = join(root, "project"), legacyMemoryRoot = join(root, "legacy-memory");
  mkdirSync(projectRoot); mkdirSync(legacyMemoryRoot);
  const detachedSession = join(legacyMemoryRoot, "unknown-session");
  mkdirSync(detachedSession); writeFileSync(join(detachedSession, "memory.md"), "fixture");
  const paths = craftPaths(dataRoot);
  const store = await new CraftStore(paths).open();
  try {
    const scope = { kind: "project", id: "project:partial-fixture" };
    store.create("scope_alias", "partial-alias", { scope, alias_kind: "path", alias: projectRoot,
      alias_digest: stableDigest(projectRoot), status: "active" });
    store.create("memory_ledger", "safe-record", { scope, status: "active", content: "fixture" });
    const row = store.database.prepare("SELECT payload_json FROM records WHERE kind='memory_ledger' AND id='safe-record'").get() as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as { _memory_partition: { file: string } };
    const current = payload._memory_partition.file, legacy = join(projectRoot, ".craft_data", "memory", "memory.db");
    store.close();
    mkdirSync(dirname(legacy), { recursive: true }); renameSync(current, legacy);
    const database = new (await import("node:sqlite")).DatabaseSync(paths.databaseFile);
    try {
      payload._memory_partition.file = legacy;
      database.prepare("UPDATE records SET payload_json=? WHERE kind='memory_ledger' AND id='safe-record'").run(JSON.stringify(payload));
      const now = new Date().toISOString();
      database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
        .run("memory_candidate", "unresolved", 1, JSON.stringify({ _memory_partition: { file: join(root, "missing.db"),
          scope: { kind: "project", id: "project:unknown" } } }), now, now);
    } finally { database.close(); }
    const command = ["--experimental-strip-types", join(import.meta.dirname, "../scripts/storage-migration-apply.ts"),
      `--data-root=${dataRoot}`, `--legacy-session-memory-root=${legacyMemoryRoot}`, "--apply"];
    const first = spawnSync(process.execPath, command, { encoding: "utf8", timeout: 60_000 });
    assert.equal(first.status, 2, first.stderr);
    const report = JSON.parse(first.stdout) as { migrated: number; remaining: number; blocked_entries: Array<{ id: string }>; backups: string[];
      legacy_session_memory: { blocked_items: Array<{ reason: string }> } };
    assert.equal(report.migrated, 1);
    assert.equal(report.remaining, 2);
    assert.equal(report.blocked_entries[0]?.id, "unresolved");
    assert.equal(report.backups.length, 1);
    assert.equal(report.legacy_session_memory.blocked_items.length, 0);
    assert.equal(existsSync(join(detachedSession, "memory.md")), true);
    const second = spawnSync(process.execPath, command, { encoding: "utf8", timeout: 60_000 });
    assert.equal(second.status, 2, second.stderr);
    assert.equal((JSON.parse(second.stdout) as { mode: string }).mode, "apply");
    const readback = await new CraftStore(paths).open({ skipLegacyPartitionMigration: true });
    try { assert.equal(readback.get("memory_ledger", "safe-record")?.content, "fixture"); }
    finally { readback.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
