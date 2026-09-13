import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
export function dataRoot(env = process.env) {
    const configured = env.CRAFT_DATA_DIR?.trim();
    if (configured)
        return resolve(configured);
    const defaultRoot = join(homedir(), ".craft_data");
    const settingsPath = env.CRAFT_SETTINGS_FILE?.trim() || join(defaultRoot, "settings.json");
    if (existsSync(settingsPath)) {
        try {
            const value = JSON.parse(readFileSync(settingsPath, "utf8"));
            if (value && typeof value === "object" && !Array.isArray(value)) {
                const candidate = value.dataRoot;
                if (typeof candidate === "string" && candidate.trim())
                    return resolve(candidate);
            }
        }
        catch {
            // A malformed settings file must never prevent Craft from starting.
        }
    }
    return resolve(defaultRoot);
}
export function craftPaths(root = dataRoot()) {
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
        knowledgeIndex: join(resolved, "index", "knowledge.db"),
    };
}
export async function ensureLayout(paths = craftPaths()) {
    await Promise.all([
        paths.configDir, paths.databaseDir, paths.indexDir, paths.logsDir,
        paths.cacheDir, paths.backupsDir, paths.runtimeDir, paths.artifactsDir,
    ].map((path) => mkdir(path, { recursive: true })));
    return paths;
}
export async function atomicPrivateJson(path, value, platform = process.platform) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8", mode: 0o600,
    });
    await rename(temporary, path);
    if (platform !== "win32")
        await chmod(path, 0o600);
}
//# sourceMappingURL=paths.js.map