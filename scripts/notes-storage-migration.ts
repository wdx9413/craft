import { lstatSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { craftPaths } from "craft-common-store-local/paths";
import { CraftStore } from "craft-common-store-local/store";
import { ownedCatalogFile } from "../core/infrastructure/owned-catalog.ts";

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--apply" && !/^--(?:data-root|digest)=.+$/u.test(arg))
  || args.filter(arg => arg === "--apply").length > 1
  || ["data-root", "digest"].some(key => args.filter(arg => arg.startsWith(`--${key}=`)).length > 1)) {
  throw new Error("Usage: notes-storage-migration.ts [--data-root=<path>] [--apply --digest=<preview-digest>]");
}
const value = (key: string) => args.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
const paths = craftPaths(value("data-root"));
if (lstatSync(ownedCatalogFile(paths.root, "notes"), { throwIfNoEntry: false })) {
  await import("./notes-owner-storage-migration.ts");
  process.exit(0);
}
const apply = args.includes("--apply");
const databaseStat = lstatSync(paths.databaseFile);
if (!databaseStat.isFile() || databaseStat.isSymbolicLink()) throw new Error("Notes migration requires an existing regular database");
if (apply && !value("digest")) throw new Error("Notes apply requires the digest from preflight");
if (!apply && value("digest")) throw new Error("Notes digest is only accepted with --apply");

type NotesMigrationStore = CraftStore & { previewLegacyNotesMigration(): Record<string, unknown>; migrateLegacyNotes(digest: string): Record<string, unknown> };
if (apply) {
  const store = await new CraftStore(paths).open({ skipLegacyPartitionMigration: true }) as NotesMigrationStore;
  try { process.stdout.write(`${JSON.stringify({ mode: "apply", ...store.migrateLegacyNotes(value("digest")!) })}\n`); }
  finally { store.close(); }
} else {
  const temp = await mkdtemp(join(tmpdir(), "craft-notes-preflight-"));
  try {
    const snapshotPaths = craftPaths(temp);
    await mkdir(snapshotPaths.databaseDir, { recursive: true });
    const source = new DatabaseSync(paths.databaseFile, { readOnly: true });
    try { await backup(source, snapshotPaths.databaseFile); } finally { source.close(); }
    const store = await new CraftStore(snapshotPaths).open({ skipLegacyPartitionMigration: true }) as NotesMigrationStore;
    try { process.stdout.write(`${JSON.stringify({ mode: "preflight", ...store.previewLegacyNotesMigration() })}\n`); }
    finally { store.close(); }
  } finally { await rm(temp, { recursive: true, force: true }); }
}
