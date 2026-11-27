import type { CraftService } from "../application/craft-service.ts";
import { LocalSupervisor, SupervisorClient } from "./supervisor.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicPrivateJson } from "../infrastructure/paths.ts";

/** Keep a shared in-memory Context endpoint available while this MCP connection lives. */
export async function startContextSupervisor(service: CraftService, intervalMs = 2_000): Promise<() => Promise<void>> {
  const supervisor = new LocalSupervisor(service, service.store.paths);
  const client = new SupervisorClient(service.store.paths);
  let state = await supervisor.startOrReuse();
  let stopping = false;
  let recovery: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (stopping || recovery) return;
    recovery = (async () => {
      try { await client.status(); return; }
      catch {
        if (state.owned) {
          const lock = JSON.parse(await readFile(join(service.store.paths.runtimeDir, "supervisor.lock.json"), "utf8")) as { owner_id?: string };
          if (lock.owner_id !== supervisor.ownerId || typeof state.state.url !== "string") throw new Error("owned Context supervisor lock is unavailable");
          const health = await fetch(new URL("/health", state.state.url), { headers: { authorization: `Bearer ${supervisor.ownerId}` }, signal: AbortSignal.timeout(1_000) });
          const body = await health.json() as { status?: string; owner_id?: string };
          if (!health.ok || body.status !== "ok" || body.owner_id !== supervisor.ownerId) throw new Error("owned Context supervisor health check failed");
          await atomicPrivateJson(join(service.store.paths.runtimeDir, "supervisor.json"), state.state);
          return;
        }
        state = await supervisor.startOrReuse();
      }
    })().catch(() => { process.stderr.write("Craft Context memory service is unavailable.\n"); })
      .finally(() => { recovery = undefined; });
  }, intervalMs);
  timer.unref();
  return async () => {
    stopping = true;
    clearInterval(timer);
    await recovery;
    if (state.owned) await supervisor.close();
  };
}
