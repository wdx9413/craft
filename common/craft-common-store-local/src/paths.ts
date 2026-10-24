import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface CraftPaths {
  root: string;
  configDir: string;
  configFile: string;
  settingsFile: string;
  databaseDir: string;
  databaseFile: string;
  legacyDatabaseFile: string;
  indexDir: string;
  indexFile: string;
  logsDir: string;
  cacheDir: string;
  backupsDir: string;
  runtimeDir: string;
  artifactsDir: string;
  knowledgeIndex: string;
  knowledgeDir: string;
  memoryDir: string;
  sessionsDir: string;
  experienceDir: string;
  knowledgeDatabaseFile: string;
  memoryDatabaseFile: string;
  experienceDatabaseFile: string;
  experienceProcedureDir: string;
  knowledgeContentDir: string;
  memoryContentDir: string;
  experienceContentDir: string;
}

export function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CRAFT_DATA_DIR?.trim();
  if (configured) return resolve(configured);
  const defaultRoot = join(homedir(), ".craft_data");
  const settingsPath = env.CRAFT_SETTINGS_FILE?.trim() || join(defaultRoot, "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const value: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const candidate = (value as Record<string, unknown>).dataRoot;
        if (typeof candidate === "string" && candidate.trim()) return resolve(candidate);
      }
    } catch {
      // A malformed settings file must never prevent Craft from starting.
    }
  }
  return resolve(defaultRoot);
}

export function craftPaths(root = dataRoot()): CraftPaths {
  const resolved = resolve(root);
  return {
    root: resolved,
    configDir: join(resolved, "config"),
    configFile: join(resolved, "config", "config.json"),
    settingsFile: join(resolved, "settings.json"),
    databaseDir: join(resolved, "db"),
    databaseFile: join(resolved, "db", "craft.db"),
    legacyDatabaseFile: join(resolved, "craft.db"),
    indexDir: join(resolved, "index"),
    indexFile: join(resolved, "index", "capabilities.db"),
    logsDir: join(resolved, "logs"),
    cacheDir: join(resolved, "cache"),
    backupsDir: join(resolved, "backups"),
    runtimeDir: join(resolved, "runtime"),
    artifactsDir: join(resolved, "artifacts"),
    knowledgeDir: join(resolved, "knowledge"),
    memoryDir: join(resolved, "memory"),
    sessionsDir: join(resolved, "sessions"),
    experienceDir: join(resolved, "experience"),
    knowledgeDatabaseFile: join(resolved, "knowledge", "knowledge.db"),
    memoryDatabaseFile: join(resolved, "memory", "memory.db"),
    experienceDatabaseFile: join(resolved, "experience", "experience.db"),
    experienceProcedureDir: join(resolved, "experience", "procedures"),
    knowledgeContentDir: join(resolved, "knowledge", "md"),
    memoryContentDir: join(resolved, "memory", "md"),
    experienceContentDir: join(resolved, "experience", "md"),
    // The searchable knowledge projection shares the knowledge domain DB;
    // its tables are independent from the content-index projection.
    knowledgeIndex: join(resolved, "knowledge", "knowledge.db"),
  };
}

export interface ProjectStorageIdentity {
  canonical_root: string;
  path_sha256: string;
  directory_name: string;
}

/** The project identity follows the real directory, so aliases and symlinks share one partition. */
export function projectStorageIdentity(projectRoot: string): ProjectStorageIdentity {
  const canonicalRoot = realpathSync(projectRoot);
  if (!statSync(canonicalRoot).isDirectory()) throw new Error("Project storage root must be a directory");
  const pathHash = createHash("sha256").update(canonicalRoot).digest("hex");
  const readableName = basename(canonicalRoot).replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[-.]+|[-.]+$/gu, "").slice(0, 48) || "root";
  return { canonical_root: canonicalRoot, path_sha256: pathHash, directory_name: `${readableName}--${pathHash}` };
}

export function projectStorageDirectory(paths: CraftPaths, projectRoot: string): string {
  return join(paths.root, "projects", projectStorageIdentity(projectRoot).directory_name);
}

/** Host and session ID are both part of the storage key; raw IDs never become path segments. */
export function sessionStorageScopeId(host: string, sessionId: string): string {
  if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(host)) throw new Error("Session storage host is invalid");
  if (typeof sessionId !== "string" || !sessionId.trim() || Buffer.byteLength(sessionId, "utf8") > 65_536)
    throw new Error("session_id must be a non-empty identifier under 65536 UTF-8 bytes");
  const existing = parseSessionStorageScopeId(sessionId);
  if (existing) {
    if (existing.host !== host) throw new Error("Session storage scope Host does not match the requested Host");
    return sessionId;
  }
  return `${host}--${createHash("sha256").update(sessionId).digest("hex")}`;
}

export function parseSessionStorageScopeId(value: string): { host: string; digest: string } | null {
  const match = /^([a-z][a-z0-9_-]{0,31})--([a-f0-9]{64})$/u.exec(value);
  return match ? { host: match[1]!, digest: match[2]! } : null;
}

export function sessionStorageDirectoryForScopeId(paths: CraftPaths, scopeId: string): string {
  if (!parseSessionStorageScopeId(scopeId)) throw new Error("Session storage scope ID is malformed");
  return join(paths.root, "sessions", scopeId);
}

export function ensureSessionStorageDirectoryForScopeId(paths: CraftPaths, scopeId: string): string {
  const directory = sessionStorageDirectoryForScopeId(paths, scopeId);
  const rootStat = lstatSync(paths.root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Craft data root must be a regular directory");
  regularDirectory(paths.sessionsDir);
  regularDirectory(directory);
  return directory;
}

export function sessionStorageDirectory(paths: CraftPaths, host: string, sessionId: string): string {
  return sessionStorageDirectoryForScopeId(paths, sessionStorageScopeId(host, sessionId));
}

/** Old compatibility directories used raw IDs; only inspect those for IDs they could safely represent. */
export function isLegacySafeSessionId(sessionId: string): boolean {
  return Boolean(sessionId) && sessionId.trim() === sessionId && Buffer.byteLength(sessionId, "utf8") <= 255
    && sessionId !== "." && sessionId !== ".." && !/[/\\\x00-\x1f\x7f]/u.test(sessionId);
}

export function ensureSessionStorageDirectory(paths: CraftPaths, host: string, sessionId: string): string {
  return ensureSessionStorageDirectoryForScopeId(paths, sessionStorageScopeId(host, sessionId));
}

/** Canonicalize an existing prefix even when the final content file is absent. */
export function canonicalCandidatePath(path: string): string {
  let current = resolve(path);
  const suffix: string[] = [];
  while (!lstatSync(current, { throwIfNoEntry: false })) {
    suffix.unshift(basename(current));
    current = dirname(current);
  }
  return resolve(realpathSync(current), ...suffix);
}

function regularDirectory(path: string): void {
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Project storage path must use regular directories");
}

function verifyProjectMapping(directory: string, identity: ProjectStorageIdentity): void {
  const mappingPath = join(directory, "project.json");
  const stat = lstatSync(mappingPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Project storage mapping must be a regular file");
  let stored: unknown;
  try { stored = JSON.parse(readFileSync(mappingPath, "utf8")); }
  catch { throw new Error("Project storage mapping is malformed"); }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)
    || (stored as Record<string, unknown>).schema_version !== 1
    || (stored as Record<string, unknown>).canonical_root !== identity.canonical_root
    || (stored as Record<string, unknown>).path_sha256 !== identity.path_sha256
    || (stored as Record<string, unknown>).directory_name !== identity.directory_name) {
    throw new Error("Project storage mapping does not match the canonical root");
  }
}

/** Read-only resolution does not create directories or acquire a writer lock. */
export function existingProjectStorageDirectory(paths: CraftPaths, projectRoot: string): string | null {
  const identity = projectStorageIdentity(projectRoot);
  const projectsRoot = join(paths.root, "projects");
  const directory = join(projectsRoot, identity.directory_name);
  for (const path of [paths.root, projectsRoot, directory]) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Project storage path must use regular directories");
  }
  verifyProjectMapping(directory, identity);
  return directory;
}

/** Create and verify the durable path-to-hash binding before any capability writes. */
export function ensureProjectStorageDirectory(paths: CraftPaths, projectRoot: string): string {
  const identity = projectStorageIdentity(projectRoot);
  const projectsRoot = join(paths.root, "projects");
  const directory = join(projectsRoot, identity.directory_name);
  const dataRootStat = lstatSync(paths.root);
  if (dataRootStat.isSymbolicLink() || !dataRootStat.isDirectory()) throw new Error("Craft data root must be a regular directory");
  regularDirectory(projectsRoot);
  regularDirectory(directory);
  const mappingPath = join(directory, "project.json");
  const mapping = { schema_version: 1, ...identity };
  const temporary = `${mappingPath}.${process.pid}.${randomUUID()}.tmp`;
  if (!existsSync(mappingPath)) {
    const handle = openSync(temporary, "wx", 0o600);
    try {
      try { writeFileSync(handle, `${JSON.stringify(mapping)}\n`); fsyncSync(handle); }
      finally { closeSync(handle); }
      try { linkSync(temporary, mappingPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { unlinkSync(temporary); }
  }
  verifyProjectMapping(directory, identity);
  return directory;
}

export async function ensureLayout(paths = craftPaths()): Promise<CraftPaths> {
  await Promise.all([
    paths.configDir, paths.databaseDir, paths.indexDir, paths.logsDir,
    paths.cacheDir, paths.backupsDir, paths.runtimeDir, paths.artifactsDir,
    paths.knowledgeDir, paths.memoryDir, paths.sessionsDir, paths.experienceDir,
    paths.knowledgeContentDir, paths.memoryContentDir, paths.experienceContentDir, paths.experienceProcedureDir,
  ].map((path) => mkdir(path, { recursive: true })));
  return paths;
}

export async function atomicPrivateJson(
  path: string, value: unknown, platform = process.platform,
): Promise<void> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  // Acquire ownership before entering cleanup: a failed exclusive open must
  // never remove a file created by another writer.
  const handle = await open(temporary, "wx", 0o600);
  try {
    try { await handle.writeFile(content, "utf8"); }
    catch (writeError) {
      try { await handle.close(); }
      catch (closeError) { throw new AggregateError([writeError, closeError], "Private JSON write and handle close failed"); }
      throw writeError;
    }
    await handle.close();
    await rename(temporary, path);
  } catch (error) {
    try { await unlink(temporary); }
    catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw new AggregateError([error, cleanupError], "Private JSON write failed and staging cleanup requires reconciliation");
    }
    throw error;
  }
  if (platform !== "win32") await chmod(path, 0o600);
}
