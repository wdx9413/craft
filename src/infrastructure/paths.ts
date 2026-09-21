import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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

export async function ensureLayout(paths = craftPaths()): Promise<CraftPaths> {
  await Promise.all([
    paths.configDir, paths.databaseDir, paths.indexDir, paths.logsDir,
    paths.cacheDir, paths.backupsDir, paths.runtimeDir, paths.artifactsDir,
    paths.knowledgeDir, paths.memoryDir, paths.experienceDir,
    paths.knowledgeContentDir, paths.memoryContentDir, paths.experienceContentDir, paths.experienceProcedureDir,
  ].map((path) => mkdir(path, { recursive: true })));
  return paths;
}

export async function atomicPrivateJson(
  path: string, value: unknown, platform = process.platform,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8", mode: 0o600,
  });
  await rename(temporary, path);
  if (platform !== "win32") await chmod(path, 0o600);
}
