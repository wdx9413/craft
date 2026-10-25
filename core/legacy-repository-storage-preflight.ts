import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { existingProjectStorageDirectory, projectStorageDirectory, type CraftPaths } from "../common/craft-common-store-local/src/paths.ts";

export type LegacyRepositoryStorageStatus = "ready" | "unbound" | "unsafe" | "incomplete";
export interface LegacyRepositoryStorageEntry {
  source_root: string;
  canonical_project_root: string | null;
  project_directory: string | null;
  status: LegacyRepositoryStorageStatus;
  file_count: number;
  size_bytes: number;
  symlink_count: number;
  unsafe_entry_count: number;
  scan_error_count: number;
  capabilities: Record<string, { file_count: number; size_bytes: number }>;
}
export interface LegacyRepositoryStorageScan {
  entries: LegacyRepositoryStorageEntry[];
  scan_errors: Array<{ path: string; error_code: string }>;
}

type FileTotals = { file_count: number; size_bytes: number };
type GitRootResolver = (directory: string) => string | null;
type DirectoryReader = (directory: string) => string[];

function gitRoot(directory: string): string | null {
  const result = spawnSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000,
  });
  if (result.status !== 0) return null;
  return realpathSync(result.stdout.trim());
}

function requireDirectory(path: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Legacy storage scan root must be a regular directory");
  return realpathSync(path);
}

function add(totals: FileTotals, size: number): void {
  totals.file_count++;
  totals.size_bytes += size;
}

function inspectStorageRoot(sourceRoot: string, readDirectory: DirectoryReader, onError: (path: string, error: unknown) => void): Pick<LegacyRepositoryStorageEntry,
  "file_count" | "size_bytes" | "symlink_count" | "unsafe_entry_count" | "scan_error_count" | "capabilities" | "status"> {
  const total = { file_count: 0, size_bytes: 0 }, capabilities: LegacyRepositoryStorageEntry["capabilities"] = {};
  let symlinkCount = 0, unsafeCount = 0, scanErrorCount = 0;
  const walk = (directory: string, capability: string | null): void => {
    let names: string[];
    try { names = readDirectory(directory).sort(); }
    catch (error) { scanErrorCount++; onError(directory, error); return; }
    for (const name of names) {
      const path = join(directory, name);
      let stat;
      try { stat = lstatSync(path); }
      catch (error) { scanErrorCount++; onError(path, error); continue; }
      if (stat.isSymbolicLink()) { symlinkCount++; continue; }
      if (stat.isDirectory()) { walk(path, capability ?? name); continue; }
      if (!stat.isFile()) { unsafeCount++; continue; }
      add(total, stat.size);
      if (capability) {
        const item = capabilities[capability] ?? { file_count: 0, size_bytes: 0 };
        add(item, stat.size);
        capabilities[capability] = item;
      }
    }
  };
  walk(sourceRoot, null);
  return { ...total, symlink_count: symlinkCount, unsafe_entry_count: unsafeCount, scan_error_count: scanErrorCount, capabilities,
    status: scanErrorCount ? "incomplete" : symlinkCount || unsafeCount ? "unsafe" : "ready" };
}

/** Read-only discovery of repository-local .craft_data. It never reads database contents or mutates source trees. */
export function legacyRepositoryStoragePreflight(scanRoots: string[], paths: CraftPaths,
  options: { resolve_git_root?: GitRootResolver; read_directory?: DirectoryReader } = {}): LegacyRepositoryStorageScan {
  const resolveGitRoot = options.resolve_git_root ?? gitRoot;
  const readDirectory = options.read_directory ?? (directory => readdirSync(directory));
  const found = new Map<string, LegacyRepositoryStorageEntry>();
  const visited = new Set<string>();
  const scanErrors: LegacyRepositoryStorageScan["scan_errors"] = [];
  const recordScanError = (path: string, error: unknown): void => {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "unknown";
    scanErrors.push({ path, error_code: code });
  };
  const visit = (directory: string): void => {
    const canonical = requireDirectory(directory);
    if (visited.has(canonical)) return;
    visited.add(canonical);
    let names: string[];
    try { names = readDirectory(canonical).sort(); }
    catch (error) { recordScanError(canonical, error); return; }
    for (const name of names) {
      const child = join(canonical, name);
      let stat;
      try { stat = lstatSync(child); }
      catch (error) { recordScanError(child, error); continue; }
      if (stat.isSymbolicLink()) {
        if (name === ".craft_data") found.set(resolve(child), { source_root: resolve(child), canonical_project_root: null,
          project_directory: null, status: "unsafe", file_count: 0, size_bytes: 0, symlink_count: 1,
          unsafe_entry_count: 0, scan_error_count: 0, capabilities: {} });
        continue;
      }
      if (!stat.isDirectory()) continue;
      if (name === ".git") continue;
      if (name === ".craft_data") {
        const sourceRoot = resolve(child);
        let projectRoot: string | null = null;
        try { projectRoot = resolveGitRoot(canonical); } catch { /* invalid Git roots remain unbound */ }
        let canonicalProjectRoot: string | null = null, projectDirectory: string | null = null;
        let identityMatches = false;
        if (projectRoot) {
          try {
            canonicalProjectRoot = realpathSync(projectRoot);
            identityMatches = canonicalProjectRoot === realpathSync(canonical);
            projectDirectory = projectStorageDirectory(paths, canonicalProjectRoot);
          } catch { identityMatches = false; projectDirectory = null; }
        } else {
          // Project identity is the canonical path, not the presence of a Git
          // repository. Accept only an already registered exact path mapping;
          // preflight must never create identity or guess a parent project.
          try {
            projectDirectory = existingProjectStorageDirectory(paths, canonical);
            if (projectDirectory) { canonicalProjectRoot = canonical; identityMatches = true; }
          } catch { projectDirectory = null; }
        }
        const inventory = inspectStorageRoot(sourceRoot, readDirectory, recordScanError);
        found.set(sourceRoot, { source_root: sourceRoot, canonical_project_root: canonicalProjectRoot,
          project_directory: projectDirectory, ...inventory, status: !identityMatches ? "unbound" : inventory.status });
        continue;
      }
      visit(child);
    }
  };
  for (const root of scanRoots) visit(resolve(root));
  return { entries: [...found.values()].sort((a, b) => a.source_root.localeCompare(b.source_root)), scan_errors: scanErrors };
}

export function legacyRepositoryStorageSummary(scan: LegacyRepositoryStorageScan): {
  roots: number; file_count: number; size_bytes: number; scan_error_count: number;
  statuses: Record<LegacyRepositoryStorageStatus, number>;
} {
  const statuses: Record<LegacyRepositoryStorageStatus, number> = { ready: 0, unbound: 0, unsafe: 0, incomplete: 0 };
  for (const entry of scan.entries) statuses[entry.status]++;
  return { roots: scan.entries.length, file_count: scan.entries.reduce((n, entry) => n + entry.file_count, 0),
    size_bytes: scan.entries.reduce((n, entry) => n + entry.size_bytes, 0), scan_error_count: scan.scan_errors.length, statuses };
}
