export interface CraftPaths {
    root: string;
    configDir: string;
    configFile: string;
    databaseDir: string;
    databaseFile: string;
    legacyDatabaseFile: string;
    indexDir: string;
    indexFile: string;
    logsDir: string;
    cacheDir: string;
    backupsDir: string;
    runtimeDir: string;
}
export declare function dataRoot(env?: NodeJS.ProcessEnv): string;
export declare function craftPaths(root?: string): CraftPaths;
export declare function ensureLayout(paths?: CraftPaths): Promise<CraftPaths>;
export declare function atomicPrivateJson(path: string, value: unknown, platform?: NodeJS.Platform): Promise<void>;
