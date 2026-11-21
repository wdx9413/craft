import { lstatSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CraftPaths } from "../../infrastructure/paths.ts";
import { assertStorageAvailable, catalogOwner, hasSharedWriterFence, ownedCatalogFile, presentStorageOwners, STORAGE_OWNERS, type StorageOwner } from "../../infrastructure/owned-catalog.ts";
import { productSurfaceOf } from "./product-launch.ts";

function containsOnlyBootstrapScaffold(paths: CraftPaths, fenced: boolean): boolean {
  const directories = new Set([
    paths.configDir, paths.databaseDir, paths.indexDir, paths.logsDir, paths.cacheDir, paths.backupsDir,
    paths.runtimeDir, paths.artifactsDir, paths.knowledgeDir, paths.memoryDir, paths.sessionsDir, paths.experienceDir,
    paths.knowledgeContentDir, paths.memoryContentDir, paths.experienceContentDir, paths.experienceProcedureDir,
  ]);
  const files = new Set([paths.configFile, paths.settingsFile, paths.secretsFile]);
  if (fenced) {
    files.add(join(paths.root, ".craft-storage-layout.json"));
    for (const database of [paths.databaseFile, paths.legacyDatabaseFile]) {
      directories.add(database);
      files.add(join(database, ".craft-write-fence"));
    }
  }
  const isExpected = (path: string): boolean => {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return false;
    if (files.has(path)) return stat.isFile();
    if (!directories.has(path) || !stat.isDirectory()) return false;
    return readdirSync(path).every(name => isExpected(join(path, name)));
  };
  return readdirSync(paths.root).every(name => isExpected(join(paths.root, name)));
}

/**
 * Each capability commits in its own catalog inside the data space. Existing shared data
 * spaces require verified migration before they can change layout.
 */
export function mcpStorageLaunch(paths: CraftPaths, mode: string, requestedOwner: string | undefined): { paths: CraftPaths; mode: string; initializeOwner?: StorageOwner } {
  assertStorageAvailable(paths.root);
  const ownerMarker = catalogOwner(paths.root);
  const existingOwners = presentStorageOwners(paths.root);
  if (requestedOwner === undefined) {
    if (ownerMarker || existingOwners.length || mode.endsWith("-owned")) throw new Error("This MCP surface requires an owned data space and matching product");
    const legacy = lstatSync(paths.legacyDatabaseFile, { throwIfNoEntry: false });
    if (!lstatSync(paths.databaseFile, { throwIfNoEntry: false }) && legacy?.isFile()) {
      return { paths: { ...paths, databaseFile: paths.legacyDatabaseFile, databaseDir: dirname(paths.legacyDatabaseFile) }, mode };
    }
    return { paths, mode };
  }
  const owner = STORAGE_OWNERS.find(product => product === requestedOwner);
  const contextComposition = owner === "context" && ["component-context-agent", "component-context-daily", "component-context-complete", "component-context-owned"].includes(mode);
  if (!owner || mode !== productSurfaceOf(owner) && !contextComposition && !(owner === "runtime" && (mode === "full" || mode === "syscall"))) throw new Error("Owned storage requires a matching standalone product");
  if (ownerMarker && ownerMarker !== owner) throw new Error("This legacy data space is owned by a different product");
  if ((lstatSync(paths.databaseFile, { throwIfNoEntry: false }) || lstatSync(paths.legacyDatabaseFile, { throwIfNoEntry: false })) && !hasSharedWriterFence(paths.root)) {
    throw new Error("Existing shared storage requires verified migration to owned storage");
  }
  const databaseDir = join(paths.root, owner), databaseFile = ownedCatalogFile(paths.root, owner);
  const marker = catalogOwner(databaseDir) ?? ownerMarker;
  if (marker && marker !== owner) throw new Error("The capability catalog has a different owner");
  const root = lstatSync(paths.root, { throwIfNoEntry: false });
  const directory = lstatSync(databaseDir, { throwIfNoEntry: false });
  const catalog = lstatSync(databaseFile, { throwIfNoEntry: false });
  if (root && !root.isDirectory() || directory && !directory.isDirectory() || catalog && !catalog.isFile()) {
    throw new Error("Owned storage requires a regular directory and database file");
  }
  if (marker && !catalog) throw new Error("Owned publication catalog is missing; restore its verified backup");
  if (catalog && !marker) throw new Error("Owned publication catalog has no storage owner marker");
  const fenced = hasSharedWriterFence(paths.root);
  if (!catalog && !existingOwners.length && root && !containsOnlyBootstrapScaffold(paths, fenced)) {
    throw new Error("Owned storage requires a new, empty data space");
  }
  const ownedMode = owner === "context" ? ["component-context-complete", "component-context-daily"].includes(mode) ? mode : "component-context-owned" : mode.replace(/-daily$/u, "-owned");
  return { paths: { ...paths, databaseDir, databaseFile }, mode: ownedMode,
    ...(!catalog ? { initializeOwner: owner } : {}) };
}
