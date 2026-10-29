import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parseCodebaseStorageMigrationCommand, runCodebaseStorageMigrationCommand } from "../core/codebase-storage-migration-command.ts";
import { craftPaths, projectStorageDirectory } from "../common/craft-common-store-local/src/paths.ts";

function fixture(snapshotRoot?: (root: string, project: string) => string) {
  const root = mkdtempSync(join(tmpdir(), "craft-codebase-migration-command-"));
  const project = join(root, "project"), sourceDatabase = join(project, ".craft_data", "codebase", "db", "craft.db");
  mkdirSync(project, { recursive: true }); mkdirSync(dirname(sourceDatabase), { recursive: true });
  const localSnapshot = snapshotRoot?.(root, project)
    ?? join(project, ".craft_data", "codebase", "runtime", "workspaces", "repo", "snapshots", "checkpoint");
  mkdirSync(join(localSnapshot, "src"), { recursive: true });
  const body = "export const value = 7;\n", file = join(localSnapshot, "src", "value.ts");
  writeFileSync(file, body);
  const payload = { workspace_id: "repo", state_revision: 1, snapshot_root: localSnapshot, entries: [
    { path: "src/value.ts", digest: createHash("sha256").update(body).digest("hex"), size_bytes: Buffer.byteLength(body) },
  ] };
  const database = new DatabaseSync(sourceDatabase);
  try {
    database.exec("CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(kind,id,version))");
    const insert = database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,1,?,'now','now')");
    insert.run("workspace", "repo", JSON.stringify({ root_path: project, state_revision: 1 }));
    insert.run("workspace_checkpoint", "checkpoint", JSON.stringify(payload));
  } finally { database.close(); }
  return { root, project, sourceDatabase, localSnapshot, body, payload };
}

test("migration command inventories an external database and migrates a staged copy idempotently", async () => {
  const f = fixture(), dataRoot = join(f.root, "global-data");
  try {
    const args = [`--data-root=${dataRoot}`, `--source-database=${f.sourceDatabase}`];
    const dryRun = await runCodebaseStorageMigrationCommand(args);
    assert.equal(dryRun.exit_code, 0);
    assert.deepEqual(JSON.parse(dryRun.output), { mode: "dry_run", statuses: { legacy_ready: 1 }, migratable: 1 });
    assert.equal(existsSync(dataRoot), false);
    await assert.rejects(runCodebaseStorageMigrationCommand([...args, "--apply"]), /inside the data root/u);
    mkdirSync(dataRoot);
    await assert.rejects(runCodebaseStorageMigrationCommand([...args, "--apply"]), /inside the data root/u);
    const staged = join(dataRoot, "db", "craft.db"); mkdirSync(dirname(staged), { recursive: true }); copyFileSync(f.sourceDatabase, staged);
    const isolated = join(dataRoot, "db", "isolated.db"); copyFileSync(f.sourceDatabase, isolated);
    await assert.rejects(runCodebaseStorageMigrationCommand([`--data-root=${dataRoot}`, `--source-database=${isolated}`, "--apply"]), /active central database/u);
    const stagedArgs = [`--data-root=${dataRoot}`, `--source-database=${staged}`];
    const applied = await runCodebaseStorageMigrationCommand([...stagedArgs, "--apply"]);
    const result = JSON.parse(applied.output) as { mode: string; migrated: number; blocked: unknown[]; after_statuses: Record<string, number>; backups: string[] };
    assert.equal(applied.exit_code, 0);
    assert.equal(result.mode, "apply");
    assert.equal(result.migrated, 1);
    assert.deepEqual(result.blocked, []);
    assert.deepEqual(result.after_statuses, { current: 1 });
    assert.equal(result.backups.length, 1);
    assert.equal(existsSync(join(result.backups[0]!, "manifest.json")), true);
    assert.equal(existsSync(f.localSnapshot), true);
    const target = join(projectStorageDirectory(craftPaths(dataRoot), f.project), "codebase", "snapshots", "repo", "checkpoint", "src", "value.ts");
    assert.equal(await import("node:fs/promises").then(fs => fs.readFile(target, "utf8")), f.body);
    const source = new DatabaseSync(staged);
    try { source.prepare("UPDATE records SET payload_json=? WHERE kind='workspace_checkpoint' AND id='checkpoint'")
      .run(JSON.stringify(f.payload)); } finally { source.close(); }
    const resumed = await runCodebaseStorageMigrationCommand([...stagedArgs, "--apply", "--recover-verified-peer",
      `--resume-backup=${result.backups[0]}`]);
    assert.equal(resumed.exit_code, 0);
    assert.equal(JSON.parse(resumed.output).migrated, 1);
    const repeated = await runCodebaseStorageMigrationCommand([...stagedArgs, "--apply"]);
    assert.equal(repeated.exit_code, 0);
    assert.equal(JSON.parse(repeated.output).migrated, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("migration command validates options and rejects a database symlink", async () => {
  assert.deepEqual(parseCodebaseStorageMigrationCommand([]), { apply: false, recover_verified_peer: false });
  assert.throws(() => parseCodebaseStorageMigrationCommand(["--unknown"]), /Unsupported/u);
  assert.throws(() => parseCodebaseStorageMigrationCommand(["--apply", "--apply"]), /Duplicate/u);
  assert.throws(() => parseCodebaseStorageMigrationCommand(["--data-root=/a", "--data-root=/b"]), /Duplicate/u);
  assert.throws(() => parseCodebaseStorageMigrationCommand(["--data-root="]), /Unsupported/u);
  assert.throws(() => parseCodebaseStorageMigrationCommand(["--resume-backup=/tmp/backup"]), /require --apply/u);
  assert.throws(() => parseCodebaseStorageMigrationCommand(["--recover-verified-peer"]), /require --apply/u);
  assert.equal(parseCodebaseStorageMigrationCommand(["--apply", "--recover-verified-peer"]).recover_verified_peer, true);
  const f = fixture(), link = join(f.root, "source-link.db");
  try {
    symlinkSync(f.sourceDatabase, link);
    await assert.rejects(runCodebaseStorageMigrationCommand([`--data-root=${join(f.root, "global")}`, `--source-database=${link}`]), /regular file/u);
    const dataRoot = join(f.root, "global"), central = join(dataRoot, "db", "craft.db");
    mkdirSync(dirname(central), { recursive: true }); symlinkSync(f.sourceDatabase, central);
    await assert.rejects(runCodebaseStorageMigrationCommand([`--data-root=${dataRoot}`, "--apply"]), /regular file/u);
    const isolated = join(dataRoot, "db", "isolated.db"); copyFileSync(f.sourceDatabase, isolated);
    rmSync(central);
    await assert.rejects(runCodebaseStorageMigrationCommand([`--data-root=${dataRoot}`, `--source-database=${isolated}`, "--apply"]), /active central database/u);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("migration apply rejects a central database reached through an escaping parent link", async () => {
  const f = fixture(), dataRoot = join(f.root, "global"), outside = join(f.root, "outside");
  try {
    mkdirSync(dataRoot); mkdirSync(outside);
    copyFileSync(f.sourceDatabase, join(outside, "craft.db"));
    symlinkSync(outside, join(dataRoot, "db"));
    await assert.rejects(runCodebaseStorageMigrationCommand([`--data-root=${dataRoot}`, "--apply"]), /inside the data root/u);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("migration command pages more than 500 rows and refuses an oversized resumed page", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-codebase-migration-command-page-"));
  const project = join(root, "project"), dataRoot = join(root, "global"), sourceDatabase = join(dataRoot, "db", "craft.db");
  try {
    mkdirSync(project); mkdirSync(dirname(sourceDatabase), { recursive: true });
    const database = new DatabaseSync(sourceDatabase);
    try {
      database.exec("CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(kind,id,version))");
      const insert = database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,1,?,'now','now')");
      insert.run("workspace", "repo", JSON.stringify({ root_path: project, state_revision: 1 }));
      for (let index = 0; index < 501; index++) {
        const id = `checkpoint_${String(index).padStart(3, "0")}`;
        const snapshot = join(project, ".craft_data", "codebase", "runtime", "workspaces", "repo", "snapshots", id);
        mkdirSync(snapshot, { recursive: true });
        insert.run("workspace_checkpoint", id, JSON.stringify({ workspace_id: "repo", state_revision: 1, snapshot_root: snapshot, entries: [] }));
      }
    } finally { database.close(); }
    const originalDataRoot = process.env.CRAFT_DATA_DIR;
    process.env.CRAFT_DATA_DIR = dataRoot;
    let dryRun;
    try { dryRun = await runCodebaseStorageMigrationCommand([]); }
    finally {
      if (originalDataRoot === undefined) delete process.env.CRAFT_DATA_DIR;
      else process.env.CRAFT_DATA_DIR = originalDataRoot;
    }
    assert.deepEqual(JSON.parse(dryRun.output), { mode: "dry_run", statuses: { legacy_ready: 501 }, migratable: 501 });
    await assert.rejects(runCodebaseStorageMigrationCommand([`--data-root=${dataRoot}`, "--apply", "--resume-backup=/private/tmp/missing"]), /fit one page/u);
    const applied = await runCodebaseStorageMigrationCommand([`--data-root=${dataRoot}`, "--apply"]);
    assert.equal(applied.exit_code, 0);
    assert.equal(JSON.parse(applied.output).migrated, 501);
    assert.deepEqual(JSON.parse(applied.output).after_statuses, { current: 501 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("migration command applies fail-closed status and reports remaining rows", async () => {
  const f = fixture((root, project) => join(project, ".craft_data", "foreign", "snapshot"));
  try {
    const dataRoot = join(f.root, "global"), staged = join(dataRoot, "db", "craft.db");
    mkdirSync(dirname(staged), { recursive: true }); copyFileSync(f.sourceDatabase, staged);
    const result = await runCodebaseStorageMigrationCommand([`--data-root=${dataRoot}`,
      `--source-database=${staged}`, "--apply"]);
    assert.equal(result.exit_code, 2);
    const output = JSON.parse(result.output) as { migrated: number; after_statuses: Record<string, number> };
    assert.equal(output.migrated, 0);
    assert.deepEqual(output.after_statuses, { source_out_of_scope: 1 });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
