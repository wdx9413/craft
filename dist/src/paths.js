import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
export function dataRoot(env = process.env) {
    const configured = env.CRAFT_DATA_DIR?.trim();
    return resolve(configured || join(homedir(), ".craft_data"));
}
export function craftPaths(root = dataRoot()) {
    const resolved = resolve(root);
    return {
        root: resolved,
        configDir: join(resolved, "config"),
        configFile: join(resolved, "config", "config.json"),
        databaseDir: join(resolved, "db"),
        databaseFile: join(resolved, "db", "craft.db"),
        legacyDatabaseFile: join(resolved, "craft.db"),
        indexDir: join(resolved, "index"),
        indexFile: join(resolved, "index", "capabilities.db"),
        logsDir: join(resolved, "logs"),
        cacheDir: join(resolved, "cache"),
        backupsDir: join(resolved, "backups"),
        runtimeDir: join(resolved, "runtime"),
    };
}
export async function ensureLayout(paths = craftPaths()) {
    await Promise.all([
        paths.configDir, paths.databaseDir, paths.indexDir, paths.logsDir,
        paths.cacheDir, paths.backupsDir, paths.runtimeDir,
    ].map((path) => mkdir(path, { recursive: true })));
    return paths;
}
export async function atomicPrivateJson(path, value, platform = process.platform) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8", mode: 0o600,
    });
    await rename(temporary, path);
    if (platform !== "win32")
        await chmod(path, 0o600);
}
//# sourceMappingURL=paths.js.map