import type { CraftService } from "../application/craft-service.ts";
import { ProcedureDefinitionStore } from "../../capability/craft-experience/procedure-definition.ts";
import { acquireLearningWorkerLocks } from "./learning-worker-supervisor.ts";

/** Local file maintenance is delayed until after startup and bounded per timer tick. */
export async function startExperienceAssetWorker(service: CraftService | undefined, options: {
  enabled?: boolean;
  set_interval?: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  clear_interval?: (timer: NodeJS.Timeout) => void;
  acquire_lock?: typeof acquireLearningWorkerLocks;
  on_failure?: (error: unknown) => void;
} = {}): Promise<() => Promise<void>> {
  if (!service || options.enabled === false) return async () => undefined;
  let releaseLock: Awaited<ReturnType<typeof acquireLearningWorkerLocks>>;
  try { releaseLock = await (options.acquire_lock ?? acquireLearningWorkerLocks)(service.store.paths.runtimeDir, ["experience-asset-migration"]); }
  catch (error) { options.on_failure?.(error); return async () => undefined; }
  if (!releaseLock) return async () => undefined;
  const definitions = new ProcedureDefinitionStore(service.store);
  let stopped = false, running = false;
  const schedule = options.set_interval ?? ((callback: () => void, ms: number) => setInterval(callback, ms) as NodeJS.Timeout);
  let timer: NodeJS.Timeout;
  try {
    timer = schedule(() => {
      if (stopped || running) return;
      running = true;
      try { definitions.maintain(); }
      catch (error) { options.on_failure?.(error); }
      finally { running = false; }
    }, 60_000);
  } catch (error) {
    await releaseLock();
    options.on_failure?.(error);
    return async () => undefined;
  }
  timer.unref?.();
  return async () => {
    if (stopped) return;
    stopped = true;
    (options.clear_interval ?? clearInterval)(timer);
    try { await releaseLock(); } catch (error) { options.on_failure?.(error); }
  };
}
