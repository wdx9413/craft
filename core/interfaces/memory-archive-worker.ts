import { spawn } from "node:child_process";
import { setImmediate as yieldImmediate, setTimeout as delay } from "node:timers/promises";
import { MemoryFileStore } from "../../capability/craft-memory/memory-files.ts";
import { craftPaths, dataRoot } from "../infrastructure/paths.ts";
import { CraftStore } from "../infrastructure/store.ts";
import { acquireLearningWorkerLocks } from "../infrastructure/learning-worker-lock.ts";
import { stableDigest } from "../digest.ts";

/** Persist only a lease identifier, never a session transcript. */
export function queueHookMaintenance(store: CraftStore, leaseId: string): void {
  const id = `memory_maintenance_request_${stableDigest(leaseId).slice(-32)}`;
  const existing = store.find("memory_maintenance_request", id);
  if (existing) {
    if (existing.lease_id !== leaseId) throw new Error("Maintenance request identity conflict");
    return;
  }
  try { store.create("memory_maintenance_request", id, { lease_id: leaseId, status: "pending", failures: 0, content_free: true }); }
  catch (error) {
    if (store.find("memory_maintenance_request", id)?.lease_id !== leaseId) throw error;
  }
}

export const MEMORY_ARCHIVE_WORKER_FLAG = "--memory-archive-worker";

/** Launch independently of the Hook; durable requests remain available if launch fails. */
export function launchMemoryArchiveWorker(entrypoint: string, dataDirectory: string): void {
  const args = [...(entrypoint.endsWith(".ts") ? ["--experimental-strip-types"] : []), entrypoint, MEMORY_ARCHIVE_WORKER_FLAG];
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", env: { ...process.env, CRAFT_DATA_DIR: dataDirectory, CRAFT_HOOK_MODE: "0" } });
  child.on("error", () => { /* Queue survives launch failure and is retried on a later startup. */ });
  child.unref();
}

/** Process one bounded page at a time outside the Hook process. */
export async function runMemoryArchiveWorker(): Promise<void> {
  const paths = craftPaths(dataRoot());
  let release = await acquireLearningWorkerLocks(paths.runtimeDir, ["memory-session-archive"]);
  if (!release) {
    // A single durable waiter covers the race where the active worker has
    // already inspected an empty queue while a new request is being enqueued.
    // Other competing processes exit, bounding the number of waiters.
    const releaseWaiter = await acquireLearningWorkerLocks(paths.runtimeDir, ["memory-session-archive-waiter"]);
    if (!releaseWaiter) return;
    try {
      while (!release) {
        await delay(1_000);
        release = await acquireLearningWorkerLocks(paths.runtimeDir, ["memory-session-archive"]);
      }
    } finally {
      try { await releaseWaiter(); }
      catch (error) { if (release) await release(); throw error; }
    }
  }
  try {
    const store = await new CraftStore(paths).open({ skipLegacyPartitionMigration: true });
    try {
      const files = new MemoryFileStore(store);
      let service: Awaited<ReturnType<typeof import("../service.ts").CraftService.open>> | undefined;
      for (;;) {
        const result = files.runQueuedArchiveSteps(1);
        const now = Date.now();
        const job = store.list("memory_maintenance_request", 1, row => {
          const retryAt = Date.parse(String(row.next_retry_at ?? ""));
          return row.status === "pending" && typeof row.lease_id === "string" && row.lease_id.length > 0
            && row.id === `memory_maintenance_request_${stableDigest(row.lease_id).slice(-32)}` && (!Number.isFinite(retryAt) || retryAt <= now);
        }, false)[0];
        if (job) {
          try {
            service ??= await (await import("../service.ts")).CraftService.open(store);
            service.memoryMaintenanceSchedule({ stage: "light", lease_id: job.lease_id });
            store.save("memory_maintenance_request", String(job.id), { ...job, status: "completed", next_retry_at: null });
          } catch (error) {
            const failures = Math.min(Number(job.failures ?? 0) + 1, 20);
            const reconcile = error instanceof Error && /Maintenance schedule (?:idempotency|recovery identity) conflict/u.test(error.message);
            try { store.save("memory_maintenance_request", String(job.id), { ...job, failures,
              status: reconcile ? "requires_reconciliation" : "pending",
              next_retry_at: reconcile ? null : new Date(now + Math.min(300_000, 1_000 * 2 ** (failures - 1))).toISOString(),
              last_error_type: error instanceof Error ? error.name : "unknown" }); } catch { /* Retry later if the checkpoint cannot be written. */ }
            await delay(1_000);
          }
        }
        const malformed = store.list("memory_maintenance_request", 1, row => row.status === "pending" && (typeof row.lease_id !== "string" || !row.lease_id
          || row.id !== `memory_maintenance_request_${stableDigest(row.lease_id).slice(-32)}`), false)[0];
        if (malformed) store.save("memory_maintenance_request", String(malformed.id), { ...malformed, status: "requires_reconciliation", last_error_type: "invalid_lease_id" });
        if (result.attempted === 0) {
          const waiting = store.list("memory_session_archive", 1, row => row.status === "archiving"
            && row.retry_state !== "requires_reconciliation" && typeof row.session_id === "string" && typeof row.session_host === "string", false);
          const maintenanceWaiting = store.list("memory_maintenance_request", 1, row => row.status === "pending", false);
          if (!waiting.length && !maintenanceWaiting.length) break;
          await delay(1_000);
          continue;
        }
        if ((result.outcomes as Array<{ status: string; backoff_recorded?: boolean }>).some(item => item.status === "failed" && item.backoff_recorded === false)) await delay(1_000);
        await yieldImmediate();
      }
    } finally { store.close(); }
  } finally { await release(); }
}
