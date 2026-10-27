import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { acquireLearningWorkerLocks } from "../infrastructure/learning-worker-lock.ts";
import { CRAFT_RELEASE_VERSION } from "../version.ts";
export { acquireLearningWorkerLocks, learningWorkerOwnerAlive } from "../infrastructure/learning-worker-lock.ts";
import { craftPaths, dataRoot } from "../infrastructure/paths.ts";

export interface LearningWorkerLaunch { entrypoint: string; args: string[]; server_entrypoint: string }
export interface LearningWorkerSupervisorOptions {
  mode: string;
  server_entrypoint?: string;
  env?: NodeJS.ProcessEnv;
  shutdown_timeout_ms?: number;
  restart_base_delay_ms?: number;
  exists?: (path: string) => boolean;
  spawn_process?: typeof spawn;
  on_failure?: (reason: string) => void;
  on_skip?: (reason: string) => void;
}

export function resolveLearningWorkerLaunch(serverEntrypoint: string, exists: (path: string) => boolean = existsSync): LearningWorkerLaunch | null {
  try {
    const server = realpathSync(serverEntrypoint), directory = dirname(server);
    const source = resolve(directory, "../deploy/experience-learning/worker.ts");
    if (exists(source)) return { entrypoint: process.execPath, args: ["--experimental-strip-types", source], server_entrypoint: server };
    const packaged = join(directory, "craft-experience-learning-worker.js");
    if (exists(packaged)) return { entrypoint: process.execPath, args: [packaged], server_entrypoint: server };
    const built = resolve(directory, "../plugin/craft-experience-learning-worker.js");
    if (exists(built)) return { entrypoint: process.execPath, args: [built], server_entrypoint: server };
    return null;
  } catch { return null; }
}

export async function startContextLearningWorker(options: LearningWorkerSupervisorOptions): Promise<(() => Promise<void>) | undefined> {
  const components: Record<string, { product: string; surface?: string; learning: string }> = {
    "component-context-agent": { product: "context", surface: "component-context-complete", learning: "experience,knowledge" },
    "component-context-daily": { product: "context", surface: "component-context-complete", learning: "experience,knowledge" },
    "component-context-complete": { product: "context", surface: "component-context-complete", learning: "experience,knowledge" },
    "component-knowledge-daily": { product: "knowledge", learning: "knowledge" },
    "component-experience-daily": { product: "experience", learning: "experience" },
  };
  const component = components[options.mode];
  if (!component || options.env?.CRAFT_CONTINUOUS_LEARNING === "0") return undefined;
  const launch = options.server_entrypoint ? resolveLearningWorkerLaunch(options.server_entrypoint, options.exists) : null;
  if (!launch) { options.on_failure?.("worker_entrypoint_unavailable"); return undefined; }
  const selection = component.surface ? ["--surface", component.surface] : ["--product", component.product];
  const serverArgs = [...(launch.server_entrypoint.endsWith(".ts") ? ["--experimental-strip-types"] : []), launch.server_entrypoint, ...selection];
  const env = { ...options.env, CRAFT_CONTINUOUS_LEARNING: "0", CRAFT_EXPERIENCE_MCP_COMMAND: process.execPath,
    CRAFT_EXPERIENCE_MCP_ARGS: JSON.stringify(serverArgs), CRAFT_LEARNING_COMPONENTS: component.learning,
    CRAFT_LEARNING_COMPONENT_LOCKS_HELD: component.learning };
  const spawnProcess = options.spawn_process ?? spawn;
  const timeout = options.shutdown_timeout_ms ?? 3_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) throw new Error("shutdown_timeout_ms must be between 1 and 60000");
  const restartBase = options.restart_base_delay_ms ?? 1_000;
  if (!Number.isSafeInteger(restartBase) || restartBase < 1 || restartBase > 30_000) throw new Error("restart_base_delay_ms must be between 1 and 30000");
  let releaseLocks: (() => Promise<void>) | null;
  try {
    releaseLocks = await acquireLearningWorkerLocks(craftPaths(dataRoot(options.env)).runtimeDir, component.learning.split(","), { runtime_version: CRAFT_RELEASE_VERSION });
  } catch {
    options.on_failure?.("worker_lock_unavailable");
    return undefined;
  }
  if (!releaseLocks) {
    if (options.on_skip) options.on_skip("worker_already_running");
    else process.stderr.write("Craft learning worker skipped (worker_already_running).\n");
    return undefined;
  }
  let child: ChildProcess | undefined, childEnded = true, stopping = false, restartTimer: NodeJS.Timeout | undefined, restartCount = 0;
  let releasePromise: Promise<void> | undefined;
  const releaseOwnership = (): Promise<void> => releasePromise ??= (async () => {
    try { await releaseLocks?.(); }
    catch { options.on_failure?.("worker_lock_release_failed"); }
  })();
  const reportAndRestart = (reason: string) => {
    if (stopping) return;
    options.on_failure?.(reason);
    const delay = Math.min(30_000, restartBase * 2 ** Math.min(restartCount, 5));
    restartCount += 1;
    restartTimer = setTimeout(() => { restartTimer = undefined; startChild(); }, delay);
  };
  const startChild = () => {
    // A plugin upgrade may remove this server's old cache while it is alive.
    // A child that cannot load its payload must not monopolize shared learning.
    const exists = options.exists ?? existsSync;
    if (!exists(launch.server_entrypoint) || !exists(launch.args[launch.args.length - 1]!)) {
      stopping = true;
      options.on_failure?.("worker_payload_removed");
      void releaseOwnership();
      return;
    }
    let spawned: ChildProcess;
    try { spawned = spawnProcess(launch.entrypoint, launch.args, { stdio: ["ignore", "ignore", "inherit"], env }); }
    catch (error) {
      const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,31}$/u.test(error.name) ? error.name : "Error";
      childEnded = true;
      reportAndRestart(name);
      return;
    }
    child = spawned;
    childEnded = false;
    spawned.once("error", error => {
      if (child !== spawned || childEnded) return;
      childEnded = true;
      const name = /^[A-Za-z][A-Za-z0-9]{0,31}$/u.test(error.name) ? error.name : "Error";
      reportAndRestart(name);
    });
    spawned.once("exit", code => {
      if (child !== spawned || childEnded) return;
      childEnded = true;
      reportAndRestart(`worker_exit_${String(code)}`);
    });
  };
  startChild();
  return async () => {
    if (stopping) { await releasePromise; return; }
    stopping = true;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = undefined; }
    try {
      if (child && !childEnded) {
        const current = child;
        await new Promise<void>(resolveStop => {
          let settled = false;
          const finish = () => { if (settled) return; settled = true; clearTimeout(force); resolveStop(); };
          const force = setTimeout(() => { current.kill("SIGKILL"); finish(); }, timeout);
          current.once("exit", finish);
          current.kill("SIGTERM");
        });
      }
    } finally { await releaseOwnership(); }
  };
}
