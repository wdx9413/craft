import { lstatSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { craftPaths, ensureLayout } from "../common/craft-common-store-local/src/paths.ts";
import { CodebaseStoragePreflightReader, type CodebaseMigrationEntry } from "./codebase-storage-preflight.ts";
import { migrateCodebaseSnapshots } from "./codebase-storage-migration.ts";

export interface CodebaseStorageMigrationCommandOptions {
  apply: boolean;
  recover_verified_peer: boolean;
  data_root?: string;
  source_database?: string;
  resume_backup?: string;
}

export function parseCodebaseStorageMigrationCommand(args: string[]): CodebaseStorageMigrationCommandOptions {
  const options: CodebaseStorageMigrationCommandOptions = { apply: false, recover_verified_peer: false };
  const seen = new Set<string>();
  for (const arg of args) {
    if (arg === "--apply" || arg === "--recover-verified-peer") {
      const key = arg.slice(2).replaceAll("-", "_");
      if (seen.has(key)) throw new Error(`Duplicate option: ${arg}`);
      seen.add(key);
      if (key === "apply") options.apply = true;
      else options.recover_verified_peer = true;
      continue;
    }
    const match = /^(--data-root|--source-database|--resume-backup)=(.+)$/u.exec(arg);
    if (!match || !match[2]!.trim()) throw new Error("Unsupported Codebase migration argument");
    const key = match[1]!.slice(2).replaceAll("-", "_") as "data_root" | "source_database" | "resume_backup";
    if (seen.has(key)) throw new Error(`Duplicate option: ${match[1]}`);
    seen.add(key);
    options[key] = match[2]!;
  }
  if ((options.resume_backup || options.recover_verified_peer) && !options.apply) {
    throw new Error("Resume and verified recovery require --apply");
  }
  return options;
}

export async function runCodebaseStorageMigrationCommand(args: string[]): Promise<{ output: string; exit_code: number }> {
  const options = parseCodebaseStorageMigrationCommand(args);
  const basePaths = craftPaths(options.data_root ? resolve(options.data_root) : undefined);
  let paths = basePaths;
  if (options.source_database) {
    const source = resolve(options.source_database), stat = lstatSync(source);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Source Codebase database must be a regular file");
    const realSource = realpathSync(source);
    if (options.apply) {
      let root: string;
      try { root = realpathSync(basePaths.root); } catch { throw new Error("Codebase migration database must be inside the data root"); }
      const within = relative(root, realSource);
      if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error("Codebase migration database must be inside the data root");
      let activeDatabase: string;
      try { activeDatabase = realpathSync(basePaths.databaseFile); } catch { throw new Error("Codebase migration database must be the active central database"); }
      if (realSource !== activeDatabase) throw new Error("Codebase migration database must be the active central database");
    }
    paths = { ...basePaths, databaseFile: realSource };
  }
  if (options.apply && !options.source_database) {
    const file = lstatSync(paths.databaseFile);
    if (file.isSymbolicLink() || !file.isFile()) throw new Error("Central Codebase database must be a regular file");
    const within = relative(realpathSync(paths.root), realpathSync(paths.databaseFile));
    if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error("Codebase migration database must be inside the data root");
  }
  const ready: CodebaseMigrationEntry[] = [], counts: Record<string, number> = {};
  let cursor: string | undefined;
  const initialReader = new CodebaseStoragePreflightReader(paths);
  try { do {
    const page = initialReader.readPage({ max_records: 500, ...(cursor ? { cursor } : {}) });
    for (const entry of page.entries) {
      counts[entry.status] = (counts[entry.status] ?? 0) + 1;
      if (entry.status === "legacy_ready") ready.push(entry);
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor); } finally { initialReader.close(); }
  if (!options.apply) return { output: JSON.stringify({ mode: "dry_run", statuses: counts, migratable: ready.length }), exit_code: 0 };
  if (options.resume_backup && ready.length > 500) throw new Error("A resumed Codebase migration must fit one page");
  await ensureLayout(paths);
  const database = new DatabaseSync(paths.databaseFile);
  try {
    database.exec("PRAGMA busy_timeout=15000");
    const store = { paths, database };
    let migrated = 0;
    const blocked: Array<{ id: string; version: number; reason: string }> = [];
    const recovered: Array<{ id: string; path: string; from_checkpoint_id: string | null; from_git_commit: string | null; digest: string }> = [];
    const backups: string[] = [];
    for (let offset = 0; offset < ready.length; offset += 500) {
      const result = await migrateCodebaseSnapshots(store, ready.slice(offset, offset + 500), {
        ...(options.resume_backup ? { backup_directory: resolve(options.resume_backup) } : {}),
        recover_verified_peer: options.recover_verified_peer,
      });
      migrated += result.migrated;
      blocked.push(...result.blocked);
      recovered.push(...result.recovered);
      if (result.backup_directory) backups.push(result.backup_directory);
    }
    const after: Record<string, number> = {};
    cursor = undefined;
    const finalReader = new CodebaseStoragePreflightReader(paths);
    try { do {
      const page = finalReader.readPage({ max_records: 500, ...(cursor ? { cursor } : {}) });
      for (const entry of page.entries) after[entry.status] = (after[entry.status] ?? 0) + 1;
      cursor = page.next_cursor ?? undefined;
    } while (cursor); } finally { finalReader.close(); }
    const output = JSON.stringify({ mode: "apply", migrated, blocked, recovered, after_statuses: after, backups });
    const remaining = Object.entries(after).some(([status]) => status !== "current");
    return { output, exit_code: blocked.length || remaining ? 2 : 0 };
  } finally { database.close(); }
}
