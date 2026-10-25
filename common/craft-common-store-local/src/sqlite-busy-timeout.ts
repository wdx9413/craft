/** Keep Hook subprocesses responsive under SQLite writer contention. */
export function sqliteBusyTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return env.CRAFT_HOOK_MODE === "1" ? 750 : 15_000;
}
