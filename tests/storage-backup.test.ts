import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { backupStorage, restoreStorage } from "../core/storage-backup.ts";

test("backup captures committed WAL data and files; restore verifies bytes into a new directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-backup-"));
  const data = join(root, "data"); await mkdir(join(data, "projects/p/memory"), { recursive: true });
  const main = new DatabaseSync(join(data, "craft.db")), partition = new DatabaseSync(join(data, "projects/p/memory/memory.db"));
  try {
    for (const db of [main, partition]) db.exec("PRAGMA journal_mode=WAL; CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES('committed');");
    await writeFile(join(data, "projects/p/memory/note.md"), "retained body");
    const archive = join(root, "backup"), restored = join(root, "restored");
    const manifest = await backupStorage(data, archive);
    assert.equal(manifest.entries.length, 3);
    assert.equal(manifest.entries.filter(entry => entry.kind === "sqlite").length, 2);
    await restoreStorage(archive, restored);
    const check = new DatabaseSync(join(restored, "craft.db"), { readOnly: true });
    try { assert.equal(check.prepare("SELECT value FROM sample").get()!.value, "committed"); } finally { check.close(); }
    assert.equal(await readFile(join(restored, "projects/p/memory/note.md"), "utf8"), "retained body");
    const cli = fileURLToPath(new URL("../core/cli.ts", import.meta.url));
    const cliBackup = join(root, "cli-backup"), cliRestore = join(root, "cli-restore");
    const invoke = (args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", cli, ...args], { encoding: "utf8", env: { ...process.env, CRAFT_DATA_DIR: data } });
    const backed = invoke(["storage-backup", "--output", cliBackup]);
    assert.equal(backed.status, 0, backed.stderr); assert.equal(JSON.parse(backed.stdout).files, 3);
    const recovered = invoke(["storage-restore", "--backup", cliBackup, "--output", cliRestore]);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(await readFile(join(cliRestore, "projects/p/memory/note.md"), "utf8"), "retained body");
    await assert.rejects(restoreStorage(archive, restored), /EEXIST/);
    await assert.rejects(backupStorage(data, join(data, "nested")), /outside/);
    main.exec("BEGIN IMMEDIATE");
    try { await assert.rejects(backupStorage(data, join(root, "busy")), /locked|busy/); } finally { main.exec("ROLLBACK"); }
    await writeFile(join(archive, "projects/p/memory/note.md"), "tampered");
    await assert.rejects(restoreStorage(archive, join(root, "bad")), /digest mismatch/);
    await assert.rejects(readFile(join(root, "bad", "craft.db")), /ENOENT/);
    const manifestPath = join(archive, "craft-storage-backup.json");
    const unsafe = JSON.parse(await readFile(manifestPath, "utf8")); unsafe.entries[0].path = "../escape";
    await writeFile(manifestPath, JSON.stringify(unsafe));
    await assert.rejects(restoreStorage(archive, join(root, "escape")), /Unsafe/);
    await symlink(data, join(root, "linked"));
    await assert.rejects(backupStorage(join(root, "linked"), join(root, "linked-backup")), /regular directory/);
    await symlink(join(data, "craft.db"), join(data, "linked.db"));
    await assert.rejects(backupStorage(data, join(root, "linked-file")), /symbolic/);
  } finally { main.close(); partition.close(); await rm(root, { recursive: true, force: true }); }
});

test("empty SQLite guard databases remain backupable", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-backup-empty-"));
  try {
    const data = join(root, "data"); await mkdir(data);
    await writeFile(join(data, ".memory-write-lock.db"), Buffer.alloc(0));
    const result = await backupStorage(data, join(root, "archive"));
    assert.equal(result.entries.length, 1);
    await restoreStorage(join(root, "archive"), join(root, "restored"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
