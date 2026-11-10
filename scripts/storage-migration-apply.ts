import { craftPaths } from "../common/craft-common-store-local/src/paths.ts";
import { CraftStore } from "../common/craft-common-store-local/src/store.ts";
import { legacySessionMemoryInventory, legacySessionMemoryPreflight } from "../core/legacy-session-memory-preflight.ts";
import { quarantineLegacySessionMemory } from "../core/legacy-session-memory-quarantine.ts";
import { StorageMigrationPreflightReader } from "../core/storage-migration-preflight.ts";
import { CodebaseStoragePreflightReader } from "../core/codebase-storage-preflight.ts";

const args = process.argv.slice(2);
const rootArgument = args.find(arg => arg.startsWith("--data-root="));
const legacySessionRootArgument = args.find(arg => arg.startsWith("--legacy-session-memory-root="));
const apply = args.includes("--apply");
const unknown = args.filter(arg => arg !== "--apply" && !arg.startsWith("--data-root=") && !arg.startsWith("--legacy-session-memory-root="));
if (unknown.length || args.filter(arg => arg.startsWith("--data-root=")).length > 1
  || args.filter(arg => arg.startsWith("--legacy-session-memory-root=")).length > 1
  || args.filter(arg => arg === "--apply").length > 1
  || rootArgument !== undefined && !rootArgument.slice("--data-root=".length).trim()
  || legacySessionRootArgument !== undefined && !legacySessionRootArgument.slice("--legacy-session-memory-root=".length).trim()) {
  throw new Error("Usage: storage-migration-apply.ts [--data-root=<path>] [--legacy-session-memory-root=<path>] [--apply]");
}
const paths = craftPaths(rootArgument ? rootArgument.slice("--data-root=".length) : undefined);
const legacySessionRoot = legacySessionRootArgument?.slice("--legacy-session-memory-root=".length) ?? "/tmp/.craft_data/memory";
function scan(): { entries: Array<{ kind: string; id: string; version: number }>; counts: Record<string, number>; identity_counts: Record<string, number>; unpartitioned_knowledge_versions: number; codebase_statuses: Record<string, number>;
  blocked_entries: Array<{ kind: string; id: string; version: number; status: string; project_scope_digest: string | null }>;
  legacy_entries: Awaited<ReturnType<typeof legacySessionMemoryPreflight>>["entries"]; legacy_root_status: "missing" | "ready" | "unsafe" } {
  const entries: Array<{ kind: string; id: string; version: number }> = [];
  const blockedEntries: Array<{ kind: string; id: string; version: number; status: string; project_scope_digest: string | null }> = [];
  const counts: Record<string, number> = {};
  const identityCounts: Record<string, number> = {};
  let cursor: string | undefined, unpartitionedKnowledgeVersions = 0;
  const reader = new StorageMigrationPreflightReader(paths);
  try {
    do {
      const page = reader.readPage({ max_records: 500, ...(cursor ? { cursor } : {}) });
      unpartitionedKnowledgeVersions = page.unpartitioned_knowledge_versions;
      for (const item of page.entries) {
        counts[item.status] = (counts[item.status] ?? 0) + 1;
        if (item.project_identity_status !== null) identityCounts[item.project_identity_status] = (identityCounts[item.project_identity_status] ?? 0) + 1;
        if (item.status === "legacy_ready") entries.push({ kind: item.kind, id: item.id, version: item.version });
        else if (item.status !== "current") blockedEntries.push({ kind: item.kind, id: item.id, version: item.version, status: item.status, project_scope_digest: item.project_scope_digest });
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  } finally { reader.close(); }
  const legacyInventory = legacySessionMemoryInventory(paths, legacySessionRoot);
  const legacyEntries = legacyInventory.entries, legacyRootStatus = legacyInventory.root_status;
  const codebaseStatuses: Record<string, number> = {};
  let codebaseCursor: string | undefined;
  const codebaseReader = new CodebaseStoragePreflightReader(paths);
  try { do {
    const page = codebaseReader.readPage({ max_records: 500, ...(codebaseCursor ? { cursor: codebaseCursor } : {}) });
    for (const entry of page.entries) codebaseStatuses[entry.status] = (codebaseStatuses[entry.status] ?? 0) + 1;
    codebaseCursor = page.next_cursor ?? undefined;
  } while (codebaseCursor); } finally { codebaseReader.close(); }
  return { entries, counts, identity_counts: identityCounts, unpartitioned_knowledge_versions: unpartitionedKnowledgeVersions, codebase_statuses: codebaseStatuses, blocked_entries: blockedEntries, legacy_entries: legacyEntries, legacy_root_status: legacyRootStatus };
}
const { entries, counts: statusCounts, identity_counts: identityCounts, unpartitioned_knowledge_versions: unpartitionedKnowledgeVersions, codebase_statuses: codebaseStatuses, blocked_entries: blockedEntries, legacy_entries: legacyEntries, legacy_root_status: legacyRootStatus } = scan();
const legacyStatusCounts = legacyEntries.reduce<Record<string, number>>((counts, entry) => {
  counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  return counts;
}, {});
if (!apply) {
  process.stdout.write(`${JSON.stringify({ mode: "dry_run", physical_pointer_statuses: statusCounts, migratable: entries.length,
    project_identity_statuses: identityCounts, unpartitioned_knowledge_versions: unpartitionedKnowledgeVersions, codebase_statuses: codebaseStatuses, blocked_entries: blockedEntries, legacy_session_memory: { root_status: legacyRootStatus, directories: legacyEntries.length, statuses: legacyStatusCounts } })}\n`);
} else {
  if (blockedEntries.length && entries.length === 0 && unpartitionedKnowledgeVersions === 0 && !(legacyRootStatus === "ready" && legacyEntries.length)) {
    process.stdout.write(`${JSON.stringify({ mode: "blocked", physical_pointer_statuses: statusCounts,
      project_identity_statuses: identityCounts, unpartitioned_knowledge_versions: unpartitionedKnowledgeVersions, codebase_statuses: codebaseStatuses, blocked_entries: blockedEntries, legacy_session_memory: { root_status: legacyRootStatus, directories: legacyEntries.length,
        statuses: legacyStatusCounts } })}\n`);
    process.exitCode = 2;
  } else {
    const store = await new CraftStore(paths).open({ skipLegacyPartitionMigration: true });
    try {
    let migrated = 0;
    let knowledgeMigrated = 0, knowledgeBlocked = 0;
    const knowledgeFailureKinds: Record<string, number> = {}, knowledgeFailurePhases: Record<string, number> = {};
    let knowledgeCursor: string | undefined;
    if (unpartitionedKnowledgeVersions) do {
      const page = store.reconcileKnowledgeStorage({ max_records: 500, records_only: true, summary_only: true,
        ...(knowledgeCursor ? { cursor: knowledgeCursor } : {}) });
      knowledgeMigrated += Number(page.migrated ?? 0);
      knowledgeBlocked += Number(page.blocked_count ?? 0);
      for (const [key, count] of Object.entries((page.blocked_failure_kinds ?? {}) as Record<string, number>)) knowledgeFailureKinds[key] = (knowledgeFailureKinds[key] ?? 0) + count;
      for (const [key, count] of Object.entries((page.blocked_failure_phases ?? {}) as Record<string, number>)) knowledgeFailurePhases[key] = (knowledgeFailurePhases[key] ?? 0) + count;
      knowledgeCursor = typeof page.next_cursor === "string" ? page.next_cursor : undefined;
    } while (knowledgeCursor);
    const backups: string[] = [];
    for (let offset = 0; offset < entries.length; offset += 500) {
      const result = await store.migrateLegacyPartitionVersions(entries.slice(offset, offset + 500));
      migrated += result.migrated;
      if (result.backup_directory) backups.push(result.backup_directory);
    }
    // Copy-only quarantine leaves even directories referenced by unresolved
    // pointers intact; legacy writers may still be running.
    const sessionQuarantine = legacyRootStatus === "ready"
      ? quarantineLegacySessionMemory(paths, legacySessionRoot, legacyEntries, { retain_source: true })
      : { quarantined: 0, broken_links: 0, staging_recovered: 0,
        blocked: legacyEntries.length ? [{ source_digest: "root", reason: "legacy_root_unavailable" }] : [] };
    const after = scan();
    const afterLegacyStatusCounts = after.legacy_entries.reduce<Record<string, number>>((counts, entry) => {
      counts[entry.status] = (counts[entry.status] ?? 0) + 1;
      return counts;
    }, {});
    const remaining = Object.entries(after.counts).filter(([status]) => status !== "current")
      .reduce((sum, [, count]) => sum + count, 0) + after.legacy_entries.length + sessionQuarantine.blocked.length
      + (after.legacy_root_status === "unsafe" ? 1 : 0) + after.unpartitioned_knowledge_versions
      + Object.entries(after.codebase_statuses).filter(([status]) => status !== "current").reduce((sum, [, count]) => sum + count, 0);
    const identityRemaining = (after.identity_counts.migration_required ?? 0) + (after.identity_counts.unresolved ?? 0);
    process.stdout.write(`${JSON.stringify({ mode: "apply", migrated, knowledge_migrated: knowledgeMigrated, knowledge_blocked: knowledgeBlocked, knowledge_failure_kinds: knowledgeFailureKinds, knowledge_failure_phases: knowledgeFailurePhases, remaining, unpartitioned_knowledge_versions: after.unpartitioned_knowledge_versions, codebase_statuses: after.codebase_statuses, identity_remaining: identityRemaining, after_statuses: after.counts, project_identity_statuses: after.identity_counts, blocked_entries: after.blocked_entries, backups,
      legacy_session_memory: { root_status: after.legacy_root_status, directories: after.legacy_entries.length, statuses: afterLegacyStatusCounts,
        quarantined: sessionQuarantine.quarantined, broken_links_copied: sessionQuarantine.broken_links, broken_links_retired: 0,
        staging_recovered: sessionQuarantine.staging_recovered, retirement_deferred: true, blocked: sessionQuarantine.blocked.length,
        blocked_items: sessionQuarantine.blocked } })}\n`);
    if (remaining || identityRemaining || knowledgeBlocked) process.exitCode = 2;
    } finally { store.close(); }
  }
}
