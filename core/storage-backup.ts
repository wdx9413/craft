import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

type Entry = { path: string; bytes: number; digest: string; kind: "sqlite" | "file" };
type Manifest = { schema: "craft.storage-backup.v1"; source_root: string; entries: Entry[] };
const MANIFEST = "craft-storage-backup.json";
const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + sep);
async function sha(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function files(root: string, directory = root): Promise<string[]> {
  const result: string[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name), info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("Storage backup rejects symbolic links");
    if (info.isDirectory()) result.push(...await files(root, path));
    else if (info.isFile()) result.push(relative(root, path).split(sep).join("/"));
    else throw new Error("Storage backup requires regular files");
  }
  return result;
}
function dataFiles(paths: string[]): string[] {
  const names = new Set(paths);
  return paths.filter(path => !["-wal", "-shm", "-journal"].some(suffix => path.endsWith(suffix) && names.has(path.slice(0, -suffix.length))));
}
async function targetPath(source: string, output: string): Promise<string> {
  if (!isAbsolute(output)) throw new Error("Backup output must be absolute");
  const target = join(await realpath(dirname(output)), basename(output));
  if (inside(source, target) || inside(target, source)) throw new Error("Backup and restore output must be outside the source tree");
  await mkdir(target, { mode: 0o700 }); // EEXIST refuses all existing destinations.
  return target;
}
async function checkDatabase(path: string): Promise<void> {
  const db = new DatabaseSync(path, { readOnly: true });
  try { if (db.prepare("PRAGMA quick_check").get()!.quick_check !== "ok") throw new Error("Backup database integrity check failed"); }
  finally { db.close(); }
}

/** Maintenance operation: all discovered databases are writer-fenced before any copying. */
export async function backupStorage(dataRoot: string, output: string): Promise<Manifest> {
  if ((await lstat(dataRoot)).isSymbolicLink()) throw new Error("Storage root must be a regular directory");
  const source = await realpath(dataRoot);
  const initial = dataFiles(await files(source));
  if (initial.length > 100_000) throw new Error("Storage backup file budget exceeded");
  if (initial.includes(MANIFEST)) throw new Error("Storage root already contains a backup manifest");
  const guards: DatabaseSync[] = [];
  let target: string | undefined;
  try {
    for (const path of initial.filter(path => /\.(db|sqlite|sqlite3)$/iu.test(path))) {
      const db = new DatabaseSync(join(source, path));
      guards.push(db); db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    }
    target = await targetPath(source, output);
    const entries: Entry[] = [];
    for (const path of initial) {
      const input = join(source, path), destination = join(target, path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const kind = /\.(db|sqlite|sqlite3)$/iu.test(path) ? "sqlite" : "file";
      if (kind === "sqlite") {
        const reader = new DatabaseSync(input, { readOnly: true });
        try { await backup(reader, destination); } finally { reader.close(); }
        const snapshot = new DatabaseSync(destination);
        try { snapshot.exec("PRAGMA journal_mode=DELETE"); } finally { snapshot.close(); }
        await checkDatabase(destination);
      } else {
        const before = await sha(input); await copyFile(input, destination);
        if (before !== await sha(destination) || before !== await sha(input)) throw new Error("Storage file changed during backup");
      }
      entries.push({ path, bytes: (await lstat(destination)).size, digest: await sha(destination), kind });
    }
    if (JSON.stringify(initial) !== JSON.stringify(dataFiles(await files(source)))) throw new Error("Storage inventory changed during backup");
    for (const entry of entries) if (entry.kind === "file" && await sha(join(source, entry.path)) !== entry.digest) throw new Error("Storage file changed during backup");
    const manifest: Manifest = { schema: "craft.storage-backup.v1", source_root: source, entries };
    await writeFile(join(target, MANIFEST), JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
    return manifest;
  } catch (error) { if (target) await rm(target, { recursive: true, force: true }); throw error; }
  finally { for (const db of guards.reverse()) { try { db.exec("ROLLBACK"); } catch { /* BEGIN may have failed. */ } db.close(); } }
}

export async function restoreStorage(archiveRoot: string, output: string): Promise<Manifest> {
  if ((await lstat(archiveRoot)).isSymbolicLink()) throw new Error("Backup root must be a regular directory");
  const source = await realpath(archiveRoot);
  const manifestFile = join(source, MANIFEST);
  const manifestInfo = await lstat(manifestFile);
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) throw new Error("Backup manifest must be a regular file");
  if (manifestInfo.size > 16 * 1024 * 1024) throw new Error("Backup manifest exceeds its size budget");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as Manifest;
  if (manifest.schema !== "craft.storage-backup.v1" || !Array.isArray(manifest.entries) || manifest.entries.length > 100_000) throw new Error("Invalid storage backup manifest");
  const actual = await files(source), expected = new Set<string>([MANIFEST]);
  for (const entry of manifest.entries) {
    if (!entry || typeof entry.path !== "string" || !entry.path || isAbsolute(entry.path) || entry.path.includes("\\") || entry.path.split("/").some(part => !part || part === "." || part === "..")
      || expected.has(entry.path) || !["sqlite", "file"].includes(entry.kind) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/u.test(entry.digest)) throw new Error("Unsafe backup manifest entry");
    expected.add(entry.path);
  }
  if (actual.length !== expected.size || actual.some(path => !expected.has(path))) throw new Error("Backup inventory does not match its manifest");
  let target: string | undefined;
  try {
    target = await targetPath(source, output);
    for (const entry of manifest.entries) {
      const input = join(source, entry.path), destination = join(target, entry.path);
      if ((await lstat(input)).size !== entry.bytes || await sha(input) !== entry.digest) throw new Error("Backup content digest mismatch");
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); await copyFile(input, destination);
      if (await sha(destination) !== entry.digest) throw new Error("Restored content digest mismatch");
      if (entry.kind === "sqlite") await checkDatabase(destination);
    }
    return manifest;
  } catch (error) { if (target) await rm(target, { recursive: true, force: true }); throw error; }
}
