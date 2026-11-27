import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { cp, mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { craftPaths } from "craft-common-store-local/paths";
import { CraftStore } from "craft-common-store-local/store";
import { catalogOwner, ownedCatalogFile } from "../core/infrastructure/owned-catalog.ts";

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--apply" && !/^--(?:data-root|digest)=.+$/u.test(arg))
  || args.filter(arg => arg === "--apply").length > 1
  || ["data-root", "digest"].some(key => args.filter(arg => arg.startsWith(`--${key}=`)).length > 1)) {
  throw new Error("Usage: notes-owner-storage-migration.ts [--data-root=<path>] [--apply --digest=<preview-digest>]");
}
const value = (key: string) => args.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
const basePaths = craftPaths(value("data-root"));
const ownerDirectory = join(basePaths.root, "notes");
for (const path of [basePaths.root, ownerDirectory]) {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Notes migration requires regular storage directories");
}
const owner = catalogOwner(ownerDirectory) ?? catalogOwner(basePaths.root);
if (owner !== "notes") throw new Error("Notes migration requires the Notes owner catalog");
const databaseFile = ownedCatalogFile(basePaths.root, "notes"), stat = lstatSync(databaseFile);
if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Notes migration requires an existing regular owner database");
function assertSameFile(path: string, expected: { dev: number; ino: number }): void {
  const current = lstatSync(path);
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino) throw new Error("Migration database changed during open");
}
const apply = args.includes("--apply");
if (apply && !value("digest")) throw new Error("Notes apply requires the digest from preflight");
if (!apply && value("digest")) throw new Error("Notes digest is only accepted with --apply");
type MigrationStore = CraftStore & { previewLegacyNotesMigration(): Record<string, unknown>; migrateLegacyNotes(digest: string): Record<string, unknown> };
async function recordTreeDigest(source: string): Promise<string | null> {
  const entry = lstatSync(source, { throwIfNoEntry: false });
  if (!entry) return null;
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Owner record directory is unsafe");
  const pending = [source], entries: Array<{ path: string; kind: string; digest?: string }> = [];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const name of await readdir(directory)) {
      const child = join(directory, name), stat = lstatSync(child);
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new Error("Owner record tree contains an unsafe entry");
      const path = relative(source, child);
      if (stat.isDirectory()) { entries.push({ path, kind: "directory" }); pending.push(child); }
      else {
        const fd = openSync(child, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = fstatSync(fd);
          if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("Owner record changed during inspection");
          entries.push({ path, kind: "file", digest: createHash("sha256").update(readFileSync(fd)).digest("hex") });
        } finally { closeSync(fd); }
      }
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
async function copyRecordTree(source: string, destination: string): Promise<void> {
  const before = await recordTreeDigest(source);
  if (before === null) return;
  await cp(source, destination, { recursive: true, dereference: false });
  if (await recordTreeDigest(destination) !== before || await recordTreeDigest(source) !== before) throw new Error("Owner record snapshot changed during copying");
}
async function openContextAlias(root: string, paths: ReturnType<typeof craftPaths>): Promise<CraftStore | undefined> {
  const directory = join(root, "context"), file = ownedCatalogFile(root, "context");
  const directoryStat = lstatSync(directory, { throwIfNoEntry: false });
  if (!directoryStat) return undefined;
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error("Context alias directory is unsafe");
  const fileStat = lstatSync(file, { throwIfNoEntry: false });
  if (!fileStat) return undefined;
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) throw new Error("Context alias database is unsafe");
  if (catalogOwner(directory) !== "context") throw new Error("Context alias catalog owner is invalid");
  const store = await new CraftStore({ ...paths, databaseDir: directory, databaseFile: file }).open({ ownerRecords: true, skipLegacyPartitionMigration: true });
  try { assertSameFile(file, fileStat); return store; }
  catch (error) { store.close(); throw error; }
}
if (apply) {
  const store = await new CraftStore({ ...basePaths, databaseDir: ownerDirectory, databaseFile }).open({ ownerRecords: true, skipLegacyPartitionMigration: true }) as MigrationStore;
  let aliases: CraftStore | undefined;
  try {
    assertSameFile(databaseFile, stat);
    aliases = await openContextAlias(basePaths.root, basePaths);
    if (aliases) store.setProjectAliasSource(aliases);
    if (aliases) aliases.database.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    try {
      const result = store.transaction(() => store.migrateLegacyNotes(value("digest")!));
      process.stdout.write(`${JSON.stringify({ mode: "apply", ...result })}\n`);
    } finally { if (aliases) aliases.database.exec("ROLLBACK"); }
  } finally { aliases?.close(); store.close(); }
} else {
  const temp = await mkdtemp(join(tmpdir(), "craft-notes-owner-preflight-"));
  const guards: DatabaseSync[] = [];
  try {
    const snapshotPaths = craftPaths(temp), snapshotDirectory = join(temp, "notes"), snapshotDatabase = ownedCatalogFile(temp, "notes");
    await mkdir(snapshotDirectory, { recursive: true });
    const contextDirectory = join(basePaths.root, "context"), contextFile = ownedCatalogFile(basePaths.root, "context");
    const contextStat = lstatSync(contextDirectory, { throwIfNoEntry: false });
    if (contextStat && (contextStat.isSymbolicLink() || !contextStat.isDirectory())) throw new Error("Context alias directory is unsafe");
    const contextFileStat = contextStat && lstatSync(contextFile, { throwIfNoEntry: false });
    if (contextFileStat) {
      if (contextFileStat.isSymbolicLink() || !contextFileStat.isFile()) throw new Error("Context alias database is unsafe");
      if (catalogOwner(contextDirectory) !== "context") throw new Error("Context alias catalog owner is invalid");
      const guard = new DatabaseSync(contextFile); guards.push(guard); assertSameFile(contextFile, contextFileStat);
      guard.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    }
    const ownerGuard = new DatabaseSync(databaseFile); guards.push(ownerGuard); assertSameFile(databaseFile, stat);
    ownerGuard.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    const source = new DatabaseSync(databaseFile, { readOnly: true });
    try { assertSameFile(databaseFile, stat); await backup(source, snapshotDatabase); } finally { source.close(); }
    const records = join(ownerDirectory, "records");
    await copyRecordTree(records, join(snapshotDirectory, "records"));
    if (contextFileStat) {
      const snapshotContext = join(temp, "context"); await mkdir(snapshotContext);
      const contextSource = new DatabaseSync(contextFile, { readOnly: true });
      try { assertSameFile(contextFile, contextFileStat); await backup(contextSource, ownedCatalogFile(temp, "context")); } finally { contextSource.close(); }
      await cp(join(contextDirectory, ".craft-storage-owner"), join(snapshotContext, ".craft-storage-owner"));
      await copyRecordTree(join(contextDirectory, "records"), join(snapshotContext, "records"));
    }
    const store = await new CraftStore({ ...snapshotPaths, databaseDir: snapshotDirectory, databaseFile: snapshotDatabase }).open({ ownerRecords: true, skipLegacyPartitionMigration: true }) as MigrationStore;
    let aliases: CraftStore | undefined;
    try {
      aliases = await openContextAlias(temp, snapshotPaths);
      if (aliases) store.setProjectAliasSource(aliases);
      process.stdout.write(`${JSON.stringify({ mode: "preflight", ...store.previewLegacyNotesMigration() })}\n`);
    } finally { aliases?.close(); store.close(); }
  } finally {
    for (const guard of guards.reverse()) { try { guard.exec("ROLLBACK"); } catch { /* The guard may not have acquired a transaction. */ } guard.close(); }
    await rm(temp, { recursive: true, force: true });
  }
}
