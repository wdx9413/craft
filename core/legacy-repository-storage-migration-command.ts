import { resolve } from "node:path";
import { canonicalCandidatePath, craftPaths } from "../common/craft-common-store-local/src/paths.ts";
import { legacyRepositoryStoragePreflight } from "./legacy-repository-storage-preflight.ts";
import { migrateLegacyRepositoryStorage } from "./legacy-repository-storage-migration.ts";
import type { LegacyRepositoryStorageScan } from "./legacy-repository-storage-preflight.ts";
import type { LegacyRepositoryStorageEntry } from "./legacy-repository-storage-preflight.ts";

export interface LegacyRepositoryMigrationOptions {
  apply: boolean;
  data_root?: string;
  scan_roots: string[];
}

export function parseLegacyRepositoryMigrationArgs(args: string[]): LegacyRepositoryMigrationOptions {
  const options: LegacyRepositoryMigrationOptions = { apply: false, scan_roots: [] };
  let dataRootSeen = false;
  for (const arg of args) {
    if (arg === "--apply") {
      if (options.apply) throw new Error("Duplicate option: --apply");
      options.apply = true;
      continue;
    }
    if (arg.startsWith("--data-root=")) {
      const dataRoot = arg.slice("--data-root=".length);
      if (dataRootSeen || !dataRoot.trim()) throw new Error("Invalid or duplicate --data-root");
      dataRootSeen = true;
      options.data_root = dataRoot;
      continue;
    }
    if (arg.startsWith("-")) throw new Error("Unsupported legacy repository migration option");
    options.scan_roots.push(arg);
  }
  if (options.scan_roots.length === 0) throw new Error("At least one repository scan root is required");
  return options;
}

export async function runLegacyRepositoryStorageMigration(args: string[], dependencies: {
  preflight?: (roots: string[], paths: ReturnType<typeof craftPaths>) => LegacyRepositoryStorageScan;
  migrate?: (paths: ReturnType<typeof craftPaths>, entry: LegacyRepositoryStorageEntry) => Promise<{
    status: "migrated" | "already_migrated"; migration_id: string; file_count: number; bytes: number; manifest_path: string;
  }>;
} = {}): Promise<{ output: string; exit_code: number }> {
  const options = parseLegacyRepositoryMigrationArgs(args);
  const paths = craftPaths(options.data_root ? canonicalCandidatePath(resolve(options.data_root)) : undefined);
  const preflight = dependencies.preflight ?? legacyRepositoryStoragePreflight;
  const migrate = dependencies.migrate ?? migrateLegacyRepositoryStorage;
  const scan = preflight(options.scan_roots.map(root => resolve(root)), paths);
  const counts = scan.entries.reduce<Record<string, number>>((result, entry) => {
    result[entry.status] = (result[entry.status] ?? 0) + 1;
    return result;
  }, {});
  if (!options.apply) return { output: JSON.stringify({ mode: "dry_run", migration_semantics: "archive_copy_only", source_retired: false, runtime_data_integrated: false, roots: scan.entries.length, statuses: counts,
    blocked: scan.entries.filter(entry => entry.status !== "ready").map(entry => ({ source_root: entry.source_root, status: entry.status,
      file_count: entry.file_count, size_bytes: entry.size_bytes, symlink_count: entry.symlink_count,
      unsafe_entry_count: entry.unsafe_entry_count, scan_error_count: entry.scan_error_count })),
    scan_errors: scan.scan_errors, migratable: counts.ready ?? 0 }), exit_code: scan.scan_errors.length ? 2 : 0 };
  const results = [];
  for (const entry of scan.entries) if (entry.status === "ready") results.push(await migrate(paths, entry));
  const blocked = scan.entries.filter(entry => entry.status !== "ready").map(entry => ({ source_root: entry.source_root, status: entry.status }));
  return { output: JSON.stringify({ mode: "apply", migration_semantics: "archive_copy_only", source_retired: false, runtime_data_integrated: false, migrated: results.length, results, blocked, scan_errors: scan.scan_errors }),
    exit_code: blocked.length || scan.scan_errors.length ? 2 : 0 };
}
