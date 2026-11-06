/** Keep Hook subprocesses responsive under SQLite writer contention. */
export function sqliteBusyTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return env.CRAFT_HOOK_MODE === "1" ? 100 : 15_000;
}

/** Trace shards absorb concurrent Hook journals; keep their bounded queue separate from central Store writes. */
export function sqliteTraceBusyTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return env.CRAFT_HOOK_MODE === "1" ? 100 : 15_000;
}
