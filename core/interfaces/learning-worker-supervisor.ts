import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

type ReleaseLock = () => Promise<void>;
type WorkerLockFileSystem = {
  mkdir: typeof mkdir;
  link: typeof link;
  open: typeof open;
  readFile: typeof readFile;
  rename: typeof rename;
  unlink: typeof unlink;
};
const workerLockFileSystem: WorkerLockFileSystem = { link, mkdir, open, readFile, rename, unlink };

export function learningWorkerOwnerAlive(pid: number, kill: (pid: number, signal: 0) => void = process.kill): boolean {
  try { kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function acquireComponentLock(path: string, fileSystem: WorkerLockFileSystem, isOwnerAlive: (pid: number) => boolean): Promise<ReleaseLock | null> {
  const ownerId = randomUUID();
  const pendingPath = `${path}.creating.${process.pid}.${ownerId}`;
  let handle;
  handle = await fileSystem.open(pendingPath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, owner_id: ownerId, started_at: new Date().toISOString() }));
    await handle.close();
  } catch (error) {
    try { await handle.close(); } catch { /* Keep the original write failure. */ }
    try { await fileSystem.unlink(pendingPath); } catch { /* Keep the original write failure. */ }
    throw error;
  }
  try { await fileSystem.link(pendingPath, path); }
  catch (error) {
    try { await fileSystem.unlink(pendingPath); } catch { /* Preserve the publication failure. */ }
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const previous = JSON.parse(await fileSystem.readFile(path, "utf8")) as { pid?: unknown; owner_id?: unknown };
    const previousPid = Number(previous.pid);
    if (!Number.isSafeInteger(previousPid) || previousPid < 1 || typeof previous.owner_id !== "string" || !previous.owner_id) {
      throw new Error("Learning worker lock is invalid; reconciliation required");
    }
    if (isOwnerAlive(previousPid)) return null;
    const ownerDigest = createHash("sha256").update(previous.owner_id).digest("hex");
    const recoveredPath = `${path}.recovered.${Date.now()}.${ownerDigest}`;
    await fileSystem.rename(path, recoveredPath);
    const moved = JSON.parse(await fileSystem.readFile(recoveredPath, "utf8")) as { owner_id?: unknown };
    if (moved.owner_id !== previous.owner_id) {
      try { await fileSystem.rename(recoveredPath, path); } catch { /* Preserve the changed lock for manual reconciliation. */ }
      throw new Error("Learning worker lock changed during recovery");
    }
    await fileSystem.unlink(recoveredPath);
    return acquireComponentLock(path, fileSystem, isOwnerAlive);
  }
  try { await fileSystem.unlink(pendingPath); }
  catch { /* The published lock is valid; a leftover private staging link is harmless. */ }

  return async () => {
    const current = JSON.parse(await fileSystem.readFile(path, "utf8")) as { owner_id?: unknown };
    if (current.owner_id !== ownerId) throw new Error("Learning worker lock ownership changed");
    await fileSystem.unlink(path);
  };
}

export async function acquireLearningWorkerLocks(runtimeDir: string, components: string[], dependencies: {
  file_system?: Partial<WorkerLockFileSystem>;
  is_process_alive?: (pid: number) => boolean;
} = {}): Promise<(() => Promise<void>) | null> {
  const fileSystem = { ...workerLockFileSystem, ...dependencies.file_system };
  const isOwnerAlive = dependencies.is_process_alive ?? learningWorkerOwnerAlive;
  await fileSystem.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const releases: ReleaseLock[] = [];
  for (const component of [...new Set(components)].sort()) {
    const release = await acquireComponentLock(join(runtimeDir, `learning-worker-${component}.lock.json`), fileSystem, isOwnerAlive);
    if (!release) {
      await Promise.all(releases.reverse().map(item => item()));
      return null;
    }
    releases.push(release);
  }
  return async () => { await Promise.all(releases.reverse().map(item => item())); };
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
    releaseLocks = await acquireLearningWorkerLocks(craftPaths(dataRoot(options.env)).runtimeDir, component.learning.split(","));
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
  const reportAndRestart = (reason: string) => {
    if (stopping) return;
    options.on_failure?.(reason);
    const delay = Math.min(30_000, restartBase * 2 ** Math.min(restartCount, 5));
    restartCount += 1;
    restartTimer = setTimeout(() => { restartTimer = undefined; startChild(); }, delay);
  };
  const startChild = () => {
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
    if (stopping) return;
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
    } finally {
      try { await releaseLocks?.(); }
      catch { options.on_failure?.("worker_lock_release_failed"); }
    }
  };
}
