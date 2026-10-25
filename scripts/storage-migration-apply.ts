import { craftPaths } from "../common/craft-common-store-local/src/paths.ts";
import { CraftStore } from "../common/craft-common-store-local/src/store.ts";
import { legacySessionMemoryPreflight } from "../core/legacy-session-memory-preflight.ts";
import { quarantineLegacySessionMemory } from "../core/legacy-session-memory-quarantine.ts";
import { StorageMigrationPreflightReader } from "../core/storage-migration-preflight.ts";

const args = process.argv.slice(2);
const rootArgument = args.find(arg => arg.startsWith("--data-root="));
const legacySessionRootArgument = args.find(arg => arg.startsWith("--legacy-session-memory-root="));
const apply = args.includes("--apply");
const unknown = args.filter(arg => arg !== "--apply" && !arg.startsWith("--data-root=") && !arg.startsWith("--legacy-session-memory-root="));
if (unknown.length || args.filter(arg => arg.startsWith("--data-root=")).length > 1
  || args.filter(arg => arg.startsWith("--legacy-session-memory-root=")).length > 1) {
  throw new Error("Usage: storage-migration-apply.ts [--data-root=<path>] [--legacy-session-memory-root=<path>] [--apply]");
}
const paths = craftPaths(rootArgument ? rootArgument.slice("--data-root=".length) : undefined);
const legacySessionRoot = legacySessionRootArgument?.slice("--legacy-session-memory-root=".length) ?? "/tmp/.craft_data/memory";
function scan(): { entries: Array<{ kind: string; id: string; version: number }>; counts: Record<string, number>;
  blocked_entries: Array<{ kind: string; id: string; version: number; status: string }>;
  legacy_entries: Awaited<ReturnType<typeof legacySessionMemoryPreflight>>["entries"]; legacy_root_status: "missing" | "ready" | "unsafe" } {
  const entries: Array<{ kind: string; id: string; version: number }> = [];
  const blockedEntries: Array<{ kind: string; id: string; version: number; status: string }> = [];
  const counts: Record<string, number> = {};
  let cursor: string | undefined;
  const reader = new StorageMigrationPreflightReader(paths);
  try {
    do {
      const page = reader.readPage({ max_records: 500, ...(cursor ? { cursor } : {}) });
      for (const item of page.entries) {
        counts[item.status] = (counts[item.status] ?? 0) + 1;
        if (item.status === "legacy_ready") entries.push({ kind: item.kind, id: item.id, version: item.version });
        else if (item.status !== "current") blockedEntries.push({ kind: item.kind, id: item.id, version: item.version, status: item.status });
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  } finally { reader.close(); }
  const legacyEntries: Awaited<ReturnType<typeof legacySessionMemoryPreflight>>["entries"] = [];
  let legacyCursor: string | undefined, legacyRootStatus: "missing" | "ready" | "unsafe" = "missing";
  do {
    const page = legacySessionMemoryPreflight(paths, { legacy_root: legacySessionRoot, max_entries: 500,
      ...(legacyCursor ? { cursor: legacyCursor } : {}) });
    legacyRootStatus = page.root_status;
    legacyEntries.push(...page.entries);
    legacyCursor = page.next_cursor ?? undefined;
  } while (legacyCursor);
  return { entries, counts, blocked_entries: blockedEntries, legacy_entries: legacyEntries, legacy_root_status: legacyRootStatus };
}
const { entries, counts: statusCounts, blocked_entries: blockedEntries, legacy_entries: legacyEntries, legacy_root_status: legacyRootStatus } = scan();
const legacyStatusCounts = legacyEntries.reduce<Record<string, number>>((counts, entry) => {
  counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  return counts;
}, {});
if (!apply) {
  process.stdout.write(`${JSON.stringify({ mode: "dry_run", physical_pointer_statuses: statusCounts, migratable: entries.length,
    blocked_entries: blockedEntries, legacy_session_memory: { root_status: legacyRootStatus, directories: legacyEntries.length, statuses: legacyStatusCounts } })}\n`);
} else {
  if (blockedEntries.length) {
    process.stdout.write(`${JSON.stringify({ mode: "blocked", physical_pointer_statuses: statusCounts,
      blocked_entries: blockedEntries, legacy_session_memory: { root_status: legacyRootStatus, directories: legacyEntries.length,
        statuses: legacyStatusCounts } })}\n`);
    process.exitCode = 2;
  } else {
    const store = await new CraftStore(paths).open({ skipLegacyPartitionMigration: true });
    try {
    let migrated = 0;
    const backups: string[] = [];
    for (let offset = 0; offset < entries.length; offset += 500) {
      const result = await store.migrateLegacyPartitionVersions(entries.slice(offset, offset + 500));
      migrated += result.migrated;
      if (result.backup_directory) backups.push(result.backup_directory);
    }
    const sessionQuarantine = legacyRootStatus === "ready"
      ? quarantineLegacySessionMemory(paths, legacySessionRoot, legacyEntries)
      : { quarantined: 0, broken_links: 0, staging_recovered: 0,
        blocked: legacyEntries.length ? [{ source_digest: "root", reason: "legacy_root_unavailable" }] : [] };
    const after = scan();
    const afterLegacyStatusCounts = after.legacy_entries.reduce<Record<string, number>>((counts, entry) => {
      counts[entry.status] = (counts[entry.status] ?? 0) + 1;
      return counts;
    }, {});
    const remaining = Object.entries(after.counts).filter(([status]) => status !== "current")
      .reduce((sum, [, count]) => sum + count, 0) + after.legacy_entries.length + sessionQuarantine.blocked.length
      + (after.legacy_root_status === "unsafe" ? 1 : 0);
    process.stdout.write(`${JSON.stringify({ mode: "apply", migrated, remaining, after_statuses: after.counts, backups,
      legacy_session_memory: { root_status: after.legacy_root_status, directories: after.legacy_entries.length, statuses: afterLegacyStatusCounts,
        quarantined: sessionQuarantine.quarantined, broken_links_retired: sessionQuarantine.broken_links,
        staging_recovered: sessionQuarantine.staging_recovered, blocked: sessionQuarantine.blocked.length,
        blocked_items: sessionQuarantine.blocked } })}\n`);
    if (remaining) process.exitCode = 2;
    } finally { store.close(); }
  }
}
