import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { craftPaths } from "../common/craft-common-store-local/src/paths.ts";
import { TraceShardStore, type TraceEventRow, type TraceRecordRow } from "../common/craft-common-store-local/src/trace-shards.ts";

const CHILD_KINDS = "'trace_event','trace_feedback','telemetry_event'";
const PARENT_KINDS = "'trace','trace_archive'";

/** Requires all Craft Hosts to be stopped. Backup precedes the first row deletion. */
export async function migrateTraceStorage(dataRoot: string, apply = false): Promise<{
  trace_count: number; record_versions: number; event_count: number; migrated: number; backup: string | null;
}> {
  const paths = craftPaths(dataRoot);
  const source = new DatabaseSync(paths.databaseFile, { readOnly: !apply });
  const shards = new TraceShardStore(paths.root);
  let backupPath: string | null = null;
  try {
    source.exec("PRAGMA busy_timeout=15000");
    const recordVersions = Number((source.prepare(`SELECT COUNT(*) n FROM records WHERE kind IN (${PARENT_KINDS},${CHILD_KINDS})`).get() as { n: number }).n);
    const eventCount = Number((source.prepare("SELECT COUNT(*) n FROM events WHERE substr(stream,1,6)='trace:'").get() as { n: number }).n);
    const traceCount = Number((source.prepare(`SELECT COUNT(DISTINCT trace_id) n FROM (
      SELECT id trace_id FROM records WHERE kind IN (${PARENT_KINDS})
      UNION ALL SELECT json_extract(payload_json,'$.trace_id') trace_id FROM records WHERE kind IN (${CHILD_KINDS})
      UNION ALL SELECT substr(stream,7) trace_id FROM events WHERE substr(stream,1,6)='trace:')`).get() as { n: number }).n);
    if (!apply || !recordVersions && !eventCount) return { trace_count: traceCount, record_versions: recordVersions, event_count: eventCount, migrated: 0, backup: null };

    for (const directory of [paths.root, paths.backupsDir]) {
      const stat = lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Trace migration backup directory is unsafe");
    }
    const directory = join(paths.backupsDir, "trace-migration");
    mkdirSync(directory, { mode: 0o700 });
    const backupDirectoryStat = lstatSync(directory);
    if (backupDirectoryStat.isSymbolicLink() || !backupDirectoryStat.isDirectory()) throw new Error("Trace migration backup directory is unsafe");
    backupPath = join(directory, `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}.db`);
    await backup(source, backupPath);
    const check = new DatabaseSync(backupPath, { readOnly: true });
    try {
      if (String((check.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check) !== "ok")
        throw new Error("Trace migration backup failed integrity check");
    } finally { check.close(); }

    source.exec(`CREATE TEMP TABLE trace_migration_records AS SELECT
      CASE WHEN kind IN (${PARENT_KINDS}) THEN id ELSE json_extract(payload_json,'$.trace_id') END trace_id,
      kind,id,version,payload_json,created_at,updated_at FROM records WHERE kind IN (${PARENT_KINDS},${CHILD_KINDS});
      CREATE INDEX trace_migration_owner ON trace_migration_records(trace_id);
      CREATE TEMP TABLE trace_migration_ids(trace_id TEXT PRIMARY KEY) WITHOUT ROWID;
      INSERT OR IGNORE INTO trace_migration_ids SELECT trace_id FROM trace_migration_records WHERE trace_id IS NOT NULL AND trace_id<>'';
      INSERT OR IGNORE INTO trace_migration_ids SELECT substr(stream,7) FROM events WHERE substr(stream,1,6)='trace:' AND length(stream)>6;`);
    const missingOwner = Number((source.prepare("SELECT COUNT(*) n FROM trace_migration_records WHERE trace_id IS NULL OR trace_id=''").get() as { n: number }).n);
    if (missingOwner) throw new Error(`Trace migration found ${missingOwner} records without a Trace owner`);
    const readRecords = source.prepare("SELECT kind,id,version,payload_json,created_at,updated_at FROM trace_migration_records WHERE trace_id=? ORDER BY kind,id,version");
    const readEvents = source.prepare("SELECT stream,sequence,event_type,payload_json,created_at FROM events WHERE stream=? ORDER BY sequence");
    const deleteRecord = source.prepare("DELETE FROM records WHERE kind=? AND id=? AND version=? AND payload_json=? AND created_at=? AND updated_at=?");
    const deleteEvent = source.prepare("DELETE FROM events WHERE stream=? AND sequence=? AND event_type=? AND payload_json=? AND created_at=?");
    const readIds = source.prepare("SELECT trace_id FROM trace_migration_ids WHERE trace_id>? ORDER BY trace_id LIMIT 100");
    let cursor = "", migrated = 0;
    for (;;) {
      const ids = readIds.all(cursor) as Array<{ trace_id: string }>;
      if (!ids.length) break;
      for (const { trace_id: traceId } of ids) {
        source.exec("BEGIN IMMEDIATE");
        try {
          const records = readRecords.all(traceId) as TraceRecordRow[];
          const events = readEvents.all(`trace:${traceId}`) as TraceEventRow[];
          shards.importLegacy(traceId, records, events);
          for (const row of records) {
            if (Number(deleteRecord.run(row.kind, row.id, row.version, row.payload_json, row.created_at, row.updated_at).changes) !== 1)
              throw new Error("Trace migration source record changed during copy");
          }
          for (const row of events) {
            if (Number(deleteEvent.run(row.stream, row.sequence, row.event_type, row.payload_json, row.created_at).changes) !== 1)
              throw new Error("Trace migration source event changed during copy");
          }
          source.exec("COMMIT");
          migrated++;
        } catch (error) { source.exec("ROLLBACK"); throw error; }
        cursor = traceId;
      }
    }
    return { trace_count: traceCount, record_versions: recordVersions, event_count: eventCount, migrated, backup: backupPath };
  } finally { shards.close(); source.close(); }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const root = args.find(arg => arg.startsWith("--data-root="));
  if (args.some(arg => arg !== "--apply" && arg !== "--offline" && !arg.startsWith("--data-root="))
    || args.filter(arg => arg.startsWith("--data-root=")).length !== 1 || args.includes("--apply") && !args.includes("--offline")) {
    throw new Error("Usage: trace-storage-migration.ts --data-root=<path> [--apply --offline]");
  }
  process.stdout.write(`${JSON.stringify(await migrateTraceStorage(root!.slice("--data-root=".length), args.includes("--apply")))}\n`);
}
