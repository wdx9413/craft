import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { craftPaths } from "../infrastructure/paths.ts";
import { SupervisorClient } from "../infrastructure/supervisor-client.ts";

export const CONTEXT_CLEANUP_WORKER_FLAG = "--context-cleanup-worker";

/** Preserve only opaque session and owner identifiers in a detached process. */
export function launchContextCleanupWorker(entrypoint: string, dataDirectory: string, sessionKey: string, ownerId: string): void {
  const absoluteEntrypoint = resolve(entrypoint);
  const args = [...(absoluteEntrypoint.endsWith(".ts") ? ["--experimental-strip-types"] : []), absoluteEntrypoint, CONTEXT_CLEANUP_WORKER_FLAG];
  const env: NodeJS.ProcessEnv = { CRAFT_DATA_DIR: dataDirectory, CRAFT_CLEANUP_SESSION_KEY: sessionKey, CRAFT_CLEANUP_OWNER_ID: ownerId };
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG"]) if (process.env[name] !== undefined) env[name] = process.env[name];
  if (entrypoint.endsWith(".ts") && process.env.NODE_OPTIONS) env.NODE_OPTIONS = process.env.NODE_OPTIONS;
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", env });
  child.on("error", () => {});
  child.unref();
}

export async function runContextCleanupWorker(env: NodeJS.ProcessEnv = process.env, options: { deadlineMs?: number; retryMs?: number } = {}): Promise<void> {
  const sessionKey = env.CRAFT_CLEANUP_SESSION_KEY, ownerId = env.CRAFT_CLEANUP_OWNER_ID;
  if (!sessionKey || !ownerId) throw new Error("Context cleanup identity is unavailable");
  const client = new SupervisorClient(craftPaths(env.CRAFT_DATA_DIR), ownerId), deadline = Date.now() + (options.deadlineMs ?? 86_400_000);
  do {
    try { await client.contextEnd({ session_key: sessionKey }); return; }
    catch (error) {
      if (error instanceof Error && /owner changed/u.test(error.message)) return;
      if (Date.now() >= deadline) return;
      await delay(Math.min(options.retryMs ?? 1_000, Math.max(0, deadline - Date.now())));
    }
  } while (Date.now() < deadline);
}
