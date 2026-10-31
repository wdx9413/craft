import { spawn } from "node:child_process";

export const MEMORY_ARCHIVE_WORKER_FLAG = "--memory-archive-worker";

/** Keep the short-lived Hook independent of archive worker and storage initialization. */
export function launchMemoryArchiveWorker(entrypoint: string, dataDirectory: string): void {
  const args = [...(entrypoint.endsWith(".ts") ? ["--experimental-strip-types"] : []), entrypoint, MEMORY_ARCHIVE_WORKER_FLAG];
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", env: { ...process.env, CRAFT_DATA_DIR: dataDirectory, CRAFT_HOOK_MODE: "0" } });
  child.on("error", () => { /* Queue survives launch failure and is retried on a later startup. */ });
  child.unref();
}
