import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { linkDirectory, supportsFileSymlinks } from "./symlink-support.ts";
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
    await linkDirectory(data, join(root, "linked"));
    await assert.rejects(backupStorage(join(root, "linked"), join(root, "linked-backup")), /regular directory/);
    if (supportsFileSymlinks()) {
      await symlink(join(data, "craft.db"), join(data, "linked.db"));
      await assert.rejects(backupStorage(data, join(root, "linked-file")), /symbolic/);
    }
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

test("restore reports missing archive files and malformed manifests without creating output", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-backup-diagnostics-"));
  try {
    const data = join(root, "data"); await mkdir(data);
    await writeFile(join(data, "note.md"), "known content");
    const archive = join(root, "archive");
    await backupStorage(data, archive);

    await rm(join(archive, "note.md"));
    const missingOutput = join(root, "missing-output");
    await assert.rejects(restoreStorage(archive, missingOutput), /inventory does not match/u);
    await assert.rejects(readFile(missingOutput), /ENOENT/u);

    await writeFile(join(archive, "craft-storage-backup.json"), "{");
    const malformedOutput = join(root, "malformed-output");
    await assert.rejects(restoreStorage(archive, malformedOutput), /Invalid storage backup manifest JSON/u);
    await assert.rejects(readFile(malformedOutput), /ENOENT/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("paged manifests stream 500000 identities with bounded pages and retain Array reads", async t => {
  const { readStorageBackupManifest, writeStorageBackupManifest } = await import("../core/storage-backup.ts");
  const root = await mkdtemp(join(tmpdir(), "craft-manifest-pages-"));
  const digest = "a".repeat(64);
  try {
    global.gc?.(); const heapBefore = process.memoryUsage().heapUsed, started = performance.now();
    function* entries() { for (let index = 0; index < 500000; index++) yield { path: `projects/p/snapshots/${index}.bin`, bytes: index, digest, kind: "file" as const }; }
    const manifest = await writeStorageBackupManifest(root, { schema: "craft.storage-backup.v1", source_root: "/source" }, entries());
    const header = JSON.parse(await readFile(join(root, "craft-storage-backup.json"), "utf8"));
    assert.equal(header.schema, "craft.storage-backup.v2"); assert.equal(header.entry_chunks.length, 500);
    assert(header.entry_chunks.every((chunk: { bytes: number; count: number }) => chunk.bytes <= 1024 * 1024 && chunk.count <= 1000));
    assert(Array.isArray(manifest.entries)); assert.equal(manifest.entries.length, 500000);
    assert.equal(manifest.entries[499999]!.bytes, 499999); assert.equal(manifest.entries[500000], undefined);
    assert.equal(499999 in manifest.entries, true); assert.equal(500000 in manifest.entries, false);
    assert(manifest.entries.some(entry => entry.bytes === 1001));
    const reopened = await readStorageBackupManifest(root);
    let count = 0;
    for (const entry of reopened.entries) { assert.equal(entry.bytes, count++); }
    assert.equal(count, 500000);
    global.gc?.(); const retainedBytes = process.memoryUsage().heapUsed - heapBefore;
    if (global.gc) assert(retainedBytes < 32 * 1024 * 1024, `retained heap ${retainedBytes}`);
    const small = await mkdtemp(join(tmpdir(), "craft-manifest-array-"));
    try {
      await writeStorageBackupManifest(small, { schema: "craft.storage-backup.v1", source_root: "/source" }, (function* () { for (let index = 0; index < 1001; index++) yield { path: `file-${index}`, bytes: index, digest, kind: "file" as const }; })());
      const parsed = await readStorageBackupManifest(small);
      assert.deepEqual(parsed.entries.map(entry => entry.bytes).slice(-2), [999, 1000]);
      assert.equal(JSON.parse(JSON.stringify(parsed.entries)).length, 1001);
      await writeFile(join(small, "manifest-entries/0.json"), "[]");
      assert.throws(() => parsed.entries[0], /chunk file/u);
    } finally { await rm(small, { recursive: true, force: true }); }
    t.diagnostic(`500000 logical paths; retained heap ${retainedBytes} bytes; elapsed ${Math.round(performance.now()-started)}ms; ${header.entry_chunks.length} pages; largest page ${Math.max(...header.entry_chunks.map((chunk: {bytes:number}) => chunk.bytes))} bytes`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("paged manifest verification rejects forged descriptors and changed page bytes before use", async () => {
  const { readStorageBackupManifest, writeStorageBackupManifest } = await import("../core/storage-backup.ts");
  const { createHash } = await import("node:crypto");
  const root = await mkdtemp(join(tmpdir(), "craft-manifest-guards-"));
  try {
    const digest = "a".repeat(64);
    function* entries() { for (let index = 0; index < 1001; index++) yield { path: `file-${index}`, bytes: 0, digest, kind: "file" as const }; }
    await writeStorageBackupManifest(root, { schema: "craft.storage-backup.v1", source_root: "/source" }, entries());
    const path = join(root, "craft-storage-backup.json"), original = JSON.parse(await readFile(path, "utf8"));
    const pagePath = join(root, original.entry_chunks[0].path), originalPage = await readFile(pagePath, "utf8");
    for (const patch of [{ entry_count: 0 }, { entry_count: 1002 }, { entry_chunks: null }, { entry_chunks: [{ ...original.entry_chunks[0], path: "../foreign" }] }, { entry_chunks: [{ ...original.entry_chunks[0], count: 1001 }] }, { entry_chunks: [{ ...original.entry_chunks[0], bytes: 1048577 }] }, { entry_chunks: [{ ...original.entry_chunks[0], digest: "bad" }] }]) {
      await writeFile(path, JSON.stringify({ ...original, ...patch }));
      await assert.rejects(readStorageBackupManifest(root), /manifest|chunk/u);
    }
    await writeFile(path, JSON.stringify(original));
    const changed = originalPage.replace("file-0", "file-x"); await writeFile(pagePath, changed);
    const awaited = await readStorageBackupManifest(root); assert.throws(() => awaited.entries[0], /digest/u);
    for (const content of ["{}", "[]", JSON.stringify([{ path: "../unsafe", bytes: 0, digest, kind: "file" }]), "not-json"]) {
      const header = structuredClone(original); header.entry_chunks[0] = { ...header.entry_chunks[0], count: 1, bytes: Buffer.byteLength(content), digest: createHash("sha256").update(content).digest("hex") }; header.entry_count = 2;
      await writeFile(pagePath, content); await writeFile(path, JSON.stringify(header));
      const reader = await readStorageBackupManifest(root); assert.throws(() => reader.entries[0], /count|entry|JSON|Unexpected/u);
    }
    await writeFile(pagePath, originalPage); await writeFile(path, JSON.stringify(original));
    await writeFile(path, "null"); await assert.rejects(readStorageBackupManifest(root), /Invalid/u);
    await writeFile(path, JSON.stringify({ schema: "unknown" })); await assert.rejects(readStorageBackupManifest(root), /Invalid/u);
    await assert.rejects(writeStorageBackupManifest(root, { schema: "craft.storage-backup.v1", source_root: "/source" }, [{ path: "x".repeat(1048576), bytes: 0, digest, kind: "file" }]), /page budget/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("normal backup and restore consume paged manifests without copying manifest pages into authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-backup-paged-roundtrip-"));
  const source = join(root, "source"), archive = join(root, "archive"), output = join(root, "restored");
  await mkdir(source);
  try {
    for (let index = 0; index < 1001; index++) await writeFile(join(source, `body-${index}`), "shared immutable bytes");
    const backup = await backupStorage(source, archive);
    assert.equal(backup.entries.length, 1001);
    assert.equal(JSON.parse(await readFile(join(archive, "craft-storage-backup.json"), "utf8")).schema, "craft.storage-backup.v2");
    const restored = await restoreStorage(archive, output);
    assert.equal(restored.entries.length, 1001);
    assert.equal(await readFile(join(output, "body-1000"), "utf8"), "shared immutable bytes");
    await assert.rejects(readFile(join(output, "manifest-entries/0.json")), /ENOENT/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("manifest headers reject non-files, oversized bytes and malformed external dependencies", async () => {
  const { readStorageBackupManifest } = await import("../core/storage-backup.ts");
  const root = await mkdtemp(join(tmpdir(), "craft-backup-header-validation-")), path = join(root, "craft-storage-backup.json");
  try {
    await mkdir(path); await assert.rejects(readStorageBackupManifest(root), /regular file/u); await rm(path, { recursive: true });
    await writeFile(path, " ".repeat(16 * 1024 * 1024 + 1)); await assert.rejects(readStorageBackupManifest(root), /size budget/u);
    const valid = { owner: "knowledge", storage_kind: "content", record_id: "record", version: 1, digest: "digest" };
    for (const external_references of [null, Array(100001).fill(valid), [null], [{ ...valid, owner: "unknown" }], [{ ...valid, storage_kind: "unknown" }], [{ ...valid, record_id: 1 }], [{ ...valid, version: 0.5 }], [{ ...valid, digest: null }]]) {
      await writeFile(path, JSON.stringify({ schema: "craft.storage-backup.v1", source_root: "/source", entries: [], external_references }));
      await assert.rejects(restoreStorage(root, join(root, "unused")), /external references/u);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("backup rejects source changes during copy and after manifest publication", async t => {
  const promises = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const root = await mkdtemp(join(tmpdir(), "craft-backup-source-mutation-")), source = join(root, "source"), body = join(source, "body");
  await mkdir(source);
  try {
    await writeFile(body, "original");
    const originalCopy = promises.copyFile;
    t.mock.method(promises, "copyFile", async (...args: Parameters<typeof originalCopy>) => { await originalCopy(...args); await writeFile(body, "modified-during-copy"); });
    syncBuiltinESMExports();
    await assert.rejects(backupStorage(source, join(root, "changed-copy")), /changed during backup/u);
    t.mock.restoreAll(); syncBuiltinESMExports();
    await writeFile(body, "original");
    const originalWrite = promises.writeFile;
    t.mock.method(promises, "writeFile", async (...args: Parameters<typeof originalWrite>) => { await originalWrite(...args); if (String(args[0]).endsWith("craft-storage-backup.json")) await originalWrite(body, "modified-after-publication"); });
    syncBuiltinESMExports();
    await assert.rejects(backupStorage(source, join(root, "changed-manifest")), /changed during backup/u);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); }
});
