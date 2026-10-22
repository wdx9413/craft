import type { CraftService } from "../application/craft-service.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { CraftStore } from "../infrastructure/store.ts";
import { craftPaths, dataRoot, type CraftPaths } from "../infrastructure/paths.ts";
import { TraceKernel } from "../trace-kernel.ts";
import { acquireLearningWorkerLocks } from "./learning-worker-supervisor.ts";

export const TRACE_RETENTION_WORKER_FLAG = "--trace-retention-worker";

export interface TraceRetentionWorkerOptions {
  interval_ms?: number;
  set_interval?: (callback: () => void, interval_ms: number) => NodeJS.Timeout;
  clear_interval?: (timer: NodeJS.Timeout) => void;
  on_failure?: (error: unknown) => void;
  run_maintenance?: () => void | Promise<void>;
}

/** Run the cadence-gated, bounded Trace retention sweep outside request handling. */
export function startTraceRetentionWorker(service: CraftService, options: TraceRetentionWorkerOptions = {}): () => void {
  const interval = options.interval_ms ?? 60_000;
  if (!Number.isSafeInteger(interval) || interval < 1_000 || interval > 3_600_000) throw new Error("interval_ms must be between 1000 and 3600000");
  const schedule: NonNullable<TraceRetentionWorkerOptions["set_interval"]> = options.set_interval
    ?? ((callback, delay) => setInterval(callback, delay) as NodeJS.Timeout);
  const cancel: NonNullable<TraceRetentionWorkerOptions["clear_interval"]> = options.clear_interval
    ?? (timer => clearInterval(timer));
  let stopped = false;
  let running = false;
  const timer = schedule(() => {
    if (stopped || running) return;
    running = true;
    const failed = (error: unknown) => { running = false; if (!stopped) options.on_failure?.(error); };
    try {
      const result = options.run_maintenance ? options.run_maintenance() : service.trace.maintain();
      if (result instanceof Promise) void result.then(() => { running = false; }, failed);
      else running = false;
    } catch (error) { failed(error); }
  }, interval);
  timer.unref?.();
  return () => { if (stopped) return; stopped = true; cancel(timer); };
}

export function startConfiguredTraceRetentionWorker(
  service: CraftService | undefined,
  env: NodeJS.ProcessEnv = process.env,
  onFailure?: (error: unknown) => void,
  options: Pick<TraceRetentionWorkerOptions, "set_interval" | "clear_interval"> & {
    spawn_process?: typeof spawn;
    server_entrypoint?: string;
    process_timeout_ms?: number;
  } = {},
): () => void {
  if (!service || env.CRAFT_TRACE_RETENTION_WORKER === "0") return () => undefined;
  const interval = env.CRAFT_TRACE_RETENTION_INTERVAL_MS;
  const entrypoint = options.server_entrypoint ?? process.argv[1];
  if (!entrypoint) throw new Error("Trace retention worker requires a server entrypoint");
  const timeout = options.process_timeout_ms ?? 300_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600_000) throw new Error("process_timeout_ms must be between 1 and 600000");
  let child: ChildProcess | undefined, stopped = false;
  const stop = startTraceRetentionWorker(service, {
    set_interval: options.set_interval, clear_interval: options.clear_interval,
    ...(interval === undefined ? {} : { interval_ms: Number(interval) }),
    ...(onFailure === undefined ? {} : { on_failure: onFailure }),
    run_maintenance: () => new Promise<void>((resolve, reject) => {
      const launched = (options.spawn_process ?? spawn)(process.execPath,
        [...(entrypoint.endsWith(".ts") ? ["--experimental-strip-types"] : []), entrypoint, TRACE_RETENTION_WORKER_FLAG],
        { stdio: "ignore", env: { ...env, CRAFT_DATA_DIR: service.store.paths.root, CRAFT_CONTINUOUS_LEARNING: "0", CRAFT_TRACE_RETENTION_WORKER: "0" } });
      child = launched;
      const finish = (error?: Error) => { clearTimeout(timer); if (child === launched) child = undefined; if (error && !stopped) reject(error); else resolve(); };
      const timer = setTimeout(() => { launched.kill("SIGKILL"); finish(new Error("Trace retention worker timed out")); }, timeout);
      timer.unref();
      launched.once("error", finish);
      launched.once("close", (code, signal) => finish(code === 0 && signal === null ? undefined : new Error("Trace retention worker did not complete")));
    }),
  });
  return () => { if (stopped) return; stopped = true; stop(); child?.kill(); };
}

/** The child owns its lock and Store; archive scanning never runs on the MCP event loop. */
export async function runTraceRetentionMaintenance(env: NodeJS.ProcessEnv = process.env, dependencies: {
  acquire_lock?: typeof acquireLearningWorkerLocks;
  open_store?: (paths: CraftPaths) => Promise<CraftStore>;
  maintain?: (store: CraftStore) => void;
} = {}): Promise<void> {
  const paths = craftPaths(dataRoot(env));
  const release = await (dependencies.acquire_lock ?? acquireLearningWorkerLocks)(paths.runtimeDir, ["trace-retention"]);
  if (!release) return;
  try {
    const store = await (dependencies.open_store ?? (async paths => new CraftStore(paths).open()))(paths);
    try { if (dependencies.maintain) dependencies.maintain(store); else new TraceKernel(store).maintain({ limit: 1 }); }
    finally { store.close(); }
  } finally { await release(); }
}
