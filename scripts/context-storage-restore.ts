import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { craftPaths, parseSessionStorageScopeId, sessionStorageScopeId } from "../common/craft-common-store-local/src/paths.ts";
import { CraftStore } from "../common/craft-common-store-local/src/store.ts";

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--apply" && !/^--(?:data-root|backup)=.+$/u.test(arg))
  || args.filter(arg => arg === "--apply").length > 1
  || ["data-root", "backup"].some(name => args.filter(arg => arg.startsWith(`--${name}=`)).length > 1)) {
  throw new Error("Usage: context-storage-restore.ts --backup=<name> [--data-root=<path>] [--apply]");
}
const value = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const name = value("backup");
if (!name || !/^legacy-partition-[a-f0-9]{64}\.json$/u.test(name)) throw new Error("Context migration backup name is invalid");
const paths = craftPaths(value("data-root"));
const directory = join(paths.backupsDir, "context-migration", "backups");
for (const path of [paths.root, paths.backupsDir, join(paths.backupsDir, "context-migration"), directory]) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Context migration backup directory is unsafe");
}
const path = join(directory, name), stat = lstatSync(path);
if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 210_000_000) throw new Error("Context migration backup is unsafe");
const content = readFileSync(path, "utf8");
if (name !== `legacy-partition-${createHash("sha256").update(content).digest("hex")}.json`) throw new Error("Context migration backup digest mismatch");
const backup = JSON.parse(content) as { schema?: unknown; domain?: unknown; scope?: { kind?: unknown; id?: unknown }; records?: unknown };
if (backup.schema !== "craft.capability-partition-migration-backup.v1" || backup.domain !== "context" || backup.scope?.kind !== "session"
  || typeof backup.scope.id !== "string" || !parseSessionStorageScopeId(backup.scope.id) || !Array.isArray(backup.records) || backup.records.length < 1 || backup.records.length > 500) throw new Error("Context migration backup is invalid");
const targetFile = join(paths.root, "sessions", backup.scope.id, "context", "context.db");
let target: DatabaseSync | null = null;
try {
  for (const directory of [join(paths.root, "sessions"), join(paths.root, "sessions", backup.scope.id), join(paths.root, "sessions", backup.scope.id, "context")]) {
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Context restore target directory is unsafe");
  }
  const info = lstatSync(targetFile);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Context restore target is unsafe");
  target = new DatabaseSync(targetFile, { readOnly: true });
} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const central = new DatabaseSync(paths.databaseFile, { readOnly: true });
const statusCounts: Record<string, number> = {};
try {
  const archiveDigest = createHash("sha256").update(backup.scope.id).digest("hex").slice(-32);
  const archived = central.prepare("SELECT 1 FROM records WHERE kind='memory_session_archive' AND id=? LIMIT 1").get(`memory_session_archive_${archiveDigest}`) !== undefined;
  for (const raw of backup.records) {
    let status = "invalid_backup_record";
    try {
      const row = raw as { kind: string; id: string; version: number; payload_json: string; created_at: string; updated_at: string };
      if (!["context_ephemeral_index", "context_resume_snapshot"].includes(row.kind) || typeof row.id !== "string" || !row.id
        || !Number.isSafeInteger(row.version) || row.version < 1 || typeof row.payload_json !== "string"
        || typeof row.created_at !== "string" || typeof row.updated_at !== "string") throw new Error("invalid record");
      const payload = JSON.parse(row.payload_json) as { session_id?: unknown; session_host?: unknown; session_scope_id?: unknown };
      if (typeof payload.session_id !== "string" || typeof payload.session_host !== "string"
        || payload.session_scope_id !== backup.scope.id || sessionStorageScopeId(payload.session_host, payload.session_id) !== backup.scope.id) throw new Error("invalid session");
      const rawHeader = central.prepare("SELECT payload_json FROM records WHERE kind=? AND id=? AND version=?").get(row.kind, row.id, row.version) as { payload_json?: string } | undefined;
      const header = rawHeader?.payload_json ? JSON.parse(rawHeader.payload_json) as { context_payload_digest?: unknown; _context_partition?: { file?: unknown; scope?: { kind?: unknown; id?: unknown } } } : null;
      const pointer = header?._context_partition;
      if (archived) status = "session_archived";
      else if (!pointer || pointer.file !== targetFile || pointer.scope?.kind !== "session" || pointer.scope.id !== backup.scope.id
        || header?.context_payload_digest !== `sha256:${createHash("sha256").update(row.payload_json).digest("hex")}`) status = "pointer_changed";
      else {
        const current = target?.prepare("SELECT payload_json FROM records WHERE kind=? AND id=? AND version=?").get(row.kind, row.id, row.version) as { payload_json?: string } | undefined;
        status = !current ? "restore_ready" : current.payload_json === row.payload_json ? "already_present" : "target_conflict";
      }
    } catch { /* Invalid backup data remains blocked. */ }
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }
} finally { central.close(); target?.close(); }
const blocked = Object.entries(statusCounts).reduce((sum, [status, count]) => sum + (["restore_ready", "already_present"].includes(status) ? 0 : count), 0);
let result = { restored: 0, already_present: 0 };
let verified = 0;
if (args.includes("--apply") && blocked === 0) {
  const store = await new CraftStore(paths).open({ skipLegacyPartitionMigration: true });
  try {
    result = store.restoreContextMigrationBackup(name);
    const file = join(paths.root, "sessions", backup.scope.id, "context", "context.db");
    const database = new DatabaseSync(file, { readOnly: true });
    try {
      for (const raw of backup.records) {
        const row = raw as { kind: string; id: string; version: number; payload_json: string };
        const restored = database.prepare("SELECT payload_json FROM records WHERE kind=? AND id=? AND version=?").get(row.kind, row.id, row.version) as { payload_json?: string } | undefined;
        if (restored?.payload_json !== row.payload_json) throw new Error("Context migration restore readback mismatch");
        verified++;
      }
    } finally { database.close(); }
  } finally { store.close(); }
}
process.stdout.write(`${JSON.stringify({ mode: args.includes("--apply") ? "apply" : "backup_check", backup: name,
  records: backup.records.length, backup_digest_verified: true, target_checked: true, status_counts: statusCounts, blocked, verified, ...result })}\n`);
if (args.includes("--apply") && blocked) process.exitCode = 2;
