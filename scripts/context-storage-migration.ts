import { craftPaths } from "../common/craft-common-store-local/src/paths.ts";
import { CraftStore } from "../common/craft-common-store-local/src/store.ts";
import { ContextStoragePreflightReader } from "../core/context-storage-preflight.ts";

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--apply" && !/^--(?:data-root|cursor|limit)=.+$/u.test(arg))
  || args.filter(arg => arg === "--apply").length > 1
  || ["data-root", "cursor", "limit"].some(name => args.filter(arg => arg.startsWith(`--${name}=`)).length > 1)) {
  throw new Error("Usage: context-storage-migration.ts [--data-root=<path>] [--cursor=<base64url>] [--limit=1..500] [--apply]");
}
const value = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
if (value("data-root") !== undefined && !value("data-root")!.trim()) throw new Error("Context migration data root is invalid");
const paths = craftPaths(value("data-root"));
const limit = value("limit") === undefined ? 100 : Number(value("limit"));
let cursor: [string, string, number] = ["", "", 0];
if (value("cursor")) {
  if (!/^[A-Za-z0-9_-]{1,4096}$/u.test(value("cursor")!)) throw new Error("Context migration cursor is invalid");
  try { cursor = JSON.parse(Buffer.from(value("cursor")!, "base64url").toString("utf8")) as typeof cursor; }
  catch { throw new Error("Context migration cursor is invalid"); }
}
const reader = new ContextStoragePreflightReader(paths);
let page: ReturnType<ContextStoragePreflightReader["readPage"]>;
try { page = reader.readPage(cursor, limit); } finally { reader.close(); }
const counts: Record<string, number> = {};
for (const record of page.records) counts[record.status] = (counts[record.status] ?? 0) + 1;
let migrated = 0, verified = 0;
const entries = page.records.filter(record => record.status === "central_ready");
if (args.includes("--apply") && entries.length) {
  const store = await new CraftStore(paths).open({ skipLegacyPartitionMigration: true });
  try {
    migrated = store.migrateLegacyContextVersions(entries).migrated;
    const check = new ContextStoragePreflightReader(paths);
    try {
      const after = check.readPage(cursor, limit);
      verified = entries.filter(entry => after.records.some(item => item.kind === entry.kind && item.id === entry.id && item.version === entry.version && item.status === "partition_digest_verified")).length;
      if (verified !== entries.length) throw new Error("Context migration readback incomplete");
    } finally { check.close(); }
  } finally { store.close(); }
}
const blocked = page.records.length - entries.length - (counts.partition_digest_verified ?? 0);
let remainingStatusCounts: Record<string, number> | null = null;
if (args.includes("--apply") && !page.next_cursor) {
  remainingStatusCounts = {};
  const scan = new ContextStoragePreflightReader(paths);
  try {
    let scanCursor: [string, string, number] | null = ["", "", 0];
    do {
      const next = scan.readPage(scanCursor, 500);
      for (const record of next.records) remainingStatusCounts[record.status] = (remainingStatusCounts[record.status] ?? 0) + 1;
      scanCursor = next.next_cursor;
    } while (scanCursor);
  } finally { scan.close(); }
}
const remaining = remainingStatusCounts === null ? null : Object.entries(remainingStatusCounts).reduce((sum, [status, count]) => sum + (status === "partition_digest_verified" ? 0 : count), 0);
process.stdout.write(`${JSON.stringify({ mode: args.includes("--apply") ? "apply" : "preflight", examined: page.records.length, status_counts: counts,
  migrated, verified, blocked, remaining_status_counts: remainingStatusCounts, remaining, completion_verified: remaining === 0,
  next_cursor: page.next_cursor ? Buffer.from(JSON.stringify(page.next_cursor)).toString("base64url") : null })}\n`);
if (args.includes("--apply") && (blocked || (remaining ?? 0) > 0)) process.exitCode = 2;
