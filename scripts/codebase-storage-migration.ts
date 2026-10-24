import { craftPaths } from "../common/craft-common-store-local/src/paths.ts";
import { DatabaseSync } from "node:sqlite";
import { codebaseStoragePreflight, type CodebaseMigrationEntry } from "../core/codebase-storage-preflight.ts";
import { migrateCodebaseSnapshots } from "../core/codebase-storage-migration.ts";

const args = process.argv.slice(2);
const rootArgument = args.find(arg => arg.startsWith("--data-root="));
const resumeArgument = args.find(arg => arg.startsWith("--resume-backup="));
const apply = args.includes("--apply");
const recoverPeer = args.includes("--recover-verified-peer");
if (args.some(arg => arg !== "--apply" && arg !== "--recover-verified-peer" && !arg.startsWith("--data-root=") && !arg.startsWith("--resume-backup="))
  || args.filter(arg => arg.startsWith("--data-root=")).length > 1
  || args.filter(arg => arg.startsWith("--resume-backup=")).length > 1 || (resumeArgument || recoverPeer) && !apply) {
  throw new Error("Usage: codebase-storage-migration.ts [--data-root=<path>] [--apply] [--resume-backup=<path>] [--recover-verified-peer]");
}
const paths = craftPaths(rootArgument ? rootArgument.slice("--data-root=".length) : undefined);
function scan(): { ready: CodebaseMigrationEntry[]; counts: Record<string, number> } {
  const ready: CodebaseMigrationEntry[] = [];
  const counts: Record<string, number> = {};
  let cursor: string | undefined;
  do {
    const page = codebaseStoragePreflight(paths, { max_records: 500, ...(cursor ? { cursor } : {}) });
    for (const item of page.entries) {
      counts[item.status] = (counts[item.status] ?? 0) + 1;
      if (item.status === "legacy_ready") ready.push(item);
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return { ready, counts };
}
const { ready, counts } = scan();
if (!apply) {
  process.stdout.write(`${JSON.stringify({ mode: "dry_run", statuses: counts, migratable: ready.length })}\n`);
} else {
  const database = new DatabaseSync(paths.databaseFile);
  try {
    database.exec("PRAGMA busy_timeout=15000");
    const store = { paths, database };
    let migrated = 0;
    const blocked: Array<{ id: string; version: number; reason: string }> = [];
    const recovered: Array<{ id: string; path: string; from_checkpoint_id: string | null; from_git_commit: string | null; digest: string }> = [];
    const backups: string[] = [];
    if (resumeArgument && ready.length > 500) throw new Error("A resumed Codebase migration must fit one page");
    for (let offset = 0; offset < ready.length; offset += 500) {
      const result = await migrateCodebaseSnapshots(store, ready.slice(offset, offset + 500), {
        ...(resumeArgument ? { backup_directory: resumeArgument.slice("--resume-backup=".length) } : {}),
        recover_verified_peer: recoverPeer,
        on_progress: (processed, total) => {
          if (processed % 25 === 0 || processed === total) process.stderr.write(`Codebase migration page ${processed}/${total}\n`);
        },
      });
      migrated += result.migrated;
      blocked.push(...result.blocked);
      recovered.push(...result.recovered);
      if (result.backup_directory) backups.push(result.backup_directory);
    }
    const after = scan().counts;
    process.stdout.write(`${JSON.stringify({ mode: "apply", migrated, blocked, recovered, after_statuses: after, backups })}\n`);
    if (blocked.length || Object.entries(after).some(([status]) => status !== "current")) process.exitCode = 2;
  } finally { database.close(); }
}
