import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { craftPaths } from "../common/craft-common-store-local/src/paths.ts";

/** Offline only: keep a hard-linked original and atomically replace the central DB with VACUUM INTO. */
export function compactCentralDb(dataRoot: string, apply = false): {
  before_bytes: number; after_bytes: number | null; free_pages: number; backup: string | null;
} {
  const paths = craftPaths(dataRoot);
  for (const path of [paths.root, dirname(paths.databaseFile), paths.databaseFile]) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (path === paths.databaseFile ? !stat.isFile() : !stat.isDirectory()))
      throw new Error("Central database path must use regular files and directories");
  }
  const beforeBytes = statSync(paths.databaseFile).size;
  const source = new DatabaseSync(paths.databaseFile, { readOnly: !apply });
  let compactPath: string | null = null;
  try {
    const freePages = Number((source.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count);
    if (!apply) return { before_bytes: beforeBytes, after_bytes: null, free_pages: freePages, backup: null };
    const checkpoint = source.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
    if (Number(checkpoint.busy) !== 0) throw new Error("Central database has an active WAL reader");
    if (String((source.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check) !== "ok")
      throw new Error("Central database failed integrity check");
    compactPath = join(dirname(paths.databaseFile), `.craft-compact-${randomUUID()}.db`);
    source.exec(`VACUUM INTO '${compactPath.replaceAll("'", "''")}'`);
    const compact = new DatabaseSync(compactPath, { readOnly: true });
    try {
      if (String((compact.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check) !== "ok")
        throw new Error("Compacted central database failed integrity check");
      for (const table of ["records", "events", "meta"]) {
        const query = `SELECT COUNT(*) n FROM ${table}`;
        if ((source.prepare(query).get() as { n: number }).n !== (compact.prepare(query).get() as { n: number }).n)
          throw new Error(`Compacted central database changed ${table} row count`);
      }
    } finally { compact.close(); }
    const afterBytes = statSync(compactPath).size;
    const fd = openSync(compactPath, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    source.close();
    if (existsSync(`${paths.databaseFile}-wal`) || existsSync(`${paths.databaseFile}-shm`))
      throw new Error("Central database WAL is still open; compaction was not applied");
    const backupDirectory = join(paths.backupsDir, "central-compaction");
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    for (const path of [paths.backupsDir, backupDirectory]) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Central compaction backup directory is unsafe");
    }
    const backupPath = join(backupDirectory, `craft-${randomUUID()}.db`);
    linkSync(paths.databaseFile, backupPath);
    renameSync(compactPath, paths.databaseFile);
    compactPath = null;
    // Node cannot open and flush directory handles on Windows. The file is
    // flushed before replacement; POSIX also flushes the directory entry.
    if (process.platform !== "win32") {
      const directoryFd = openSync(dirname(paths.databaseFile), "r");
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    }
    return { before_bytes: beforeBytes, after_bytes: afterBytes, free_pages: freePages, backup: backupPath };
  } finally {
    try { source.close(); } catch { /* already closed */ }
    if (compactPath && existsSync(compactPath)) unlinkSync(compactPath);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const root = args.find(arg => arg.startsWith("--data-root="));
  if (args.some(arg => arg !== "--apply" && arg !== "--offline" && !arg.startsWith("--data-root="))
    || args.filter(arg => arg.startsWith("--data-root=")).length !== 1 || args.includes("--apply") && !args.includes("--offline")) {
    throw new Error("Usage: compact-central-db.ts --data-root=<path> [--apply --offline]");
  }
  process.stdout.write(`${JSON.stringify(compactCentralDb(root!.slice("--data-root=".length), args.includes("--apply")))}\n`);
}
