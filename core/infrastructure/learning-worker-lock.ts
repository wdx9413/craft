import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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

async function acquireComponentLock(path: string, fileSystem: WorkerLockFileSystem, isOwnerAlive: (pid: number) => boolean, runtimeVersion?: string): Promise<ReleaseLock | null> {
  const ownerId = randomUUID();
  const pendingPath = `${path}.creating.${process.pid}.${ownerId}`;
  let handle;
  handle = await fileSystem.open(pendingPath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, owner_id: ownerId, started_at: new Date().toISOString(), ...(runtimeVersion ? { runtime_version: runtimeVersion } : {}) }));
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
    return acquireComponentLock(path, fileSystem, isOwnerAlive, runtimeVersion);
  }
  try { await fileSystem.unlink(pendingPath); }
  catch { /* The published lock is valid; a leftover private staging link is harmless. */ }

  return async () => {
    const current = JSON.parse(await fileSystem.readFile(path, "utf8")) as { owner_id?: unknown };
    if (current.owner_id !== ownerId) throw new Error("Learning worker lock ownership changed");
    await fileSystem.unlink(path);
  };
}

async function acquireGuardedComponentLock(path: string, fileSystem: WorkerLockFileSystem, isOwnerAlive: (pid: number) => boolean, runtimeVersion?: string): Promise<ReleaseLock | null> {
  const database = new DatabaseSync(`${path}.guard.sqlite`);
  try {
    database.exec("PRAGMA busy_timeout=0");
    try { database.exec("BEGIN IMMEDIATE"); }
    catch (error) {
      if (error instanceof Error && /locked|busy/iu.test(error.message)) { database.close(); return null; }
      throw error;
    }
    const release = await acquireComponentLock(path, fileSystem, isOwnerAlive, runtimeVersion);
    if (!release) { database.close(); return null; }
    return async () => {
      try { await release(); }
      finally { database.close(); }
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

export async function acquireLearningWorkerLocks(runtimeDir: string, components: string[], dependencies: {
  file_system?: Partial<WorkerLockFileSystem>;
  is_process_alive?: (pid: number) => boolean;
  runtime_version?: string;
} = {}): Promise<(() => Promise<void>) | null> {
  const fileSystem = { ...workerLockFileSystem, ...dependencies.file_system };
  const isOwnerAlive = dependencies.is_process_alive ?? learningWorkerOwnerAlive;
  await fileSystem.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const releases: ReleaseLock[] = [];
  for (const component of [...new Set(components)].sort()) {
    let release: ReleaseLock | null;
    try {
      release = await acquireGuardedComponentLock(join(runtimeDir, `learning-worker-${component}.lock.json`), fileSystem, isOwnerAlive, dependencies.runtime_version);
    } catch (error) {
      const cleanup = await Promise.allSettled(releases.reverse().map(item => item()));
      const failures = cleanup.filter((item): item is PromiseRejectedResult => item.status === "rejected");
      if (failures.length) throw new AggregateError([error, ...failures.map(item => item.reason)], "Learning worker lock acquisition and cleanup failed");
      throw error;
    }
    if (!release) {
      await Promise.all(releases.reverse().map(item => item()));
      return null;
    }
    releases.push(release);
  }
  return async () => { await Promise.all(releases.reverse().map(item => item())); };
}
