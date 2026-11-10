import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { craftPaths } from "../common/craft-common-store-local/src/paths.ts";
import { CodebaseShardStore, type GraphRow } from "../common/craft-common-store-local/src/codebase-shards.ts";

const KINDS = "'codebase_index_shard','codebase_index_edge_route'";

/** Move legacy graph versions without changing index metadata or graph digests. All Craft Hosts must be stopped. */
export async function migrateCodebaseGraphShards(dataRoot: string, apply = false): Promise<{
  graph_records: number; versions: number; migrated: number; backup: string | null;
}> {
  const paths = craftPaths(dataRoot);
  const source = new DatabaseSync(paths.databaseFile, { readOnly: !apply });
  const shards = new CodebaseShardStore(paths.root);
  try {
    source.exec("PRAGMA busy_timeout=15000");
    const versions = Number((source.prepare(`SELECT COUNT(*) n FROM records WHERE kind IN (${KINDS})`).get() as { n: number }).n);
    const graphRecords = Number((source.prepare(`SELECT COUNT(*) n FROM (SELECT kind,id FROM records WHERE kind IN (${KINDS}) GROUP BY kind,id)`).get() as { n: number }).n);
    if (!apply || !versions) return { graph_records: graphRecords, versions, migrated: 0, backup: null };
    for (const directory of [paths.root, paths.backupsDir]) {
      const stat = lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Codebase graph migration backup directory is unsafe");
    }
    const directory = join(paths.backupsDir, "codebase-graph-shards");
    mkdirSync(directory, { mode: 0o700 });
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Codebase graph migration backup directory is unsafe");
    const backupPath = join(directory, `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}.db`);
    await backup(source, backupPath);
    const check = new DatabaseSync(backupPath, { readOnly: true });
    try {
      if (String((check.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check) !== "ok")
        throw new Error("Codebase graph migration backup failed integrity check");
    } finally { check.close(); }
    const readIds = source.prepare(`SELECT kind,id FROM (SELECT kind,id FROM records WHERE kind IN (${KINDS}) GROUP BY kind,id)
      WHERE kind>? OR kind=? AND id>? ORDER BY kind,id LIMIT 100`);
    const readRows = source.prepare("SELECT kind,id,version,payload_json,created_at,updated_at FROM records WHERE kind=? AND id=? ORDER BY version");
    const remove = source.prepare("DELETE FROM records WHERE kind=? AND id=? AND version=? AND payload_json=? AND created_at=? AND updated_at=?");
    let cursorKind = "", cursorId = "", migrated = 0;
    for (;;) {
      const ids = readIds.all(cursorKind, cursorKind, cursorId) as Array<{ kind: string; id: string }>;
      if (!ids.length) break;
      for (const item of ids) {
        source.exec("BEGIN IMMEDIATE");
        try {
          const rows = readRows.all(item.kind, item.id) as GraphRow[];
          shards.importLegacy(item.id, rows);
          for (const row of rows) {
            if (Number(remove.run(row.kind, row.id, row.version, row.payload_json, row.created_at, row.updated_at).changes) !== 1)
              throw new Error("Codebase graph migration source changed during copy");
          }
          source.exec("COMMIT");
          migrated++;
        } catch (error) { source.exec("ROLLBACK"); throw error; }
        cursorKind = item.kind; cursorId = item.id;
      }
    }
    return { graph_records: graphRecords, versions, migrated, backup: backupPath };
  } finally { shards.close(); source.close(); }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const root = args.find(arg => arg.startsWith("--data-root="));
  if (args.some(arg => arg !== "--apply" && arg !== "--offline" && !arg.startsWith("--data-root="))
    || args.filter(arg => arg.startsWith("--data-root=")).length !== 1 || args.includes("--apply") && !args.includes("--offline")) {
    throw new Error("Usage: codebase-graph-shard-migration.ts --data-root=<path> [--apply --offline]");
  }
  process.stdout.write(`${JSON.stringify(await migrateCodebaseGraphShards(root!.slice("--data-root=".length), args.includes("--apply")))}\n`);
}
