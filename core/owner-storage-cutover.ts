import { randomUUID } from "node:crypto";
import { stableDigest } from "./digest.ts";
import { execFileSync } from "node:child_process";
import { closeSync, fsyncSync, openSync, chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { presentStorageOwners, hasSharedWriterFence } from "./infrastructure/owned-catalog.ts";
import { verifyHistoryArchiveSources, type HistoryArchiveManifest } from "./owner-history-archive.ts";
import { rebaseImportedHistory } from "./owner-history-rebase.ts";

const LAYOUT = ".craft-storage-layout.json";
const FENCE = ".craft-write-fence";
const inside = (parent: string, path: string) => path === parent || path.startsWith(parent + sep);

type Cutover = { schema: "craft.owner-cutover.v1"; archive_digest: string; previous_root: string; staged_root: string; active_root: string; database_modes: Array<{ path: string; mode: number }> };


type Journal = { schema: "craft.owner-cutover-journal.v1"; operation: "switch" | "rollback"; phase: string;
  layout: Cutover; preserved_root?: string; digest: string };
const journalFile = (active: string) => `${active}.craft-cutover.json`;
function syncDirectory(path: string): void { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
function moveTree(source: string, target: string): void {
  renameSync(source, target); syncDirectory(dirname(source)); if (dirname(source) !== dirname(target)) syncDirectory(dirname(target));
}
function writeJournal(active: string, journal: Omit<Journal, "digest">): Journal {
  const value = { ...journal, digest: stableDigest(journal) }, path = journalFile(active), temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  const fd = openSync(temporary, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path); syncDirectory(dirname(path)); return value;
}
function validateLayout(layout: Cutover, active: string): void {
  if (!layout || layout.schema !== "craft.owner-cutover.v1" || layout.active_root !== active
    || typeof layout.archive_digest !== "string" || !Array.isArray(layout.database_modes)
    || ![layout.previous_root, layout.staged_root].every(path => typeof path === "string" && resolve(path) === path
      && !inside(active, path) && !inside(path, active))
    || inside(layout.previous_root, layout.staged_root) || inside(layout.staged_root, layout.previous_root)
    || !layout.database_modes.every(entry => typeof entry.path === "string" && resolve(entry.path) === entry.path
      && inside(active, entry.path) && Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o777)) throw new Error("Invalid cutover layout");
}
function readJournal(active: string): Journal | null {
  const path = journalFile(active);
  if (!existsSync(path)) return null;
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("Invalid cutover journal");
  const record = JSON.parse(readFileSync(path, "utf8")) as Journal;
  const { digest, ...identity } = record;
  validateLayout(record.layout, active);
  if (record.schema !== "craft.owner-cutover-journal.v1" || digest !== stableDigest(identity)
    || !["switch", "rollback"].includes(record.operation) || record.layout?.schema !== "craft.owner-cutover.v1"
    || record.layout.active_root !== active || !Array.isArray(record.layout.database_modes)
    || ![record.layout.previous_root, record.layout.staged_root, ...(record.preserved_root ? [record.preserved_root] : [])]
      .every(path => typeof path === "string" && resolve(path) === path && !inside(active, path) && !inside(path, active))) throw new Error("Invalid cutover journal");
  return record;
}
function acquireOperation(active: string, recovery = false): () => void {
  const path = `${active}.craft-cutover.lock`, mutexPath = `${active}.craft-cutover-mutex.sqlite`;
  const prior = lstatSync(mutexPath, { throwIfNoEntry: false });
  if (prior && (!prior.isFile() || prior.isSymbolicLink())) throw new Error("Invalid storage maintenance mutex");
  const mutex = new DatabaseSync(mutexPath); chmodSync(mutexPath, 0o600);
  try {
  // SQLite arbitrates simultaneous stale-lock recovery and releases the claim on process death.
  mutex.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
  if (existsSync(path)) {
    if (!recovery || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("Storage operation already active; use --recover after it exits");
    const previous = JSON.parse(readFileSync(path, "utf8")) as { pid: number };
    if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error("Invalid storage operation lock");
    try { process.kill(previous.pid, 0); throw new Error("Storage operation is still running"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    unlinkSync(path);
  }
  const token = randomUUID(), temporary = `${path}.${token}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); fsyncSync(fd); } finally { closeSync(fd); }
  // The lock is published only after its owner record is durable; a crash cannot leave an empty lock.
  try { linkSync(temporary, path); } finally { unlinkSync(temporary); }
  syncDirectory(dirname(path));
  return () => {
    try { unlinkSync(path); syncDirectory(dirname(path)); }
    finally { try { mutex.exec("ROLLBACK"); } finally { mutex.close(); } }
  };
  } catch (error) { mutex.close(); throw error; }
}
function beginJournal(active: string, operation: Journal["operation"], layout: Cutover, preserved_root?: string): () => void {
  const previous = readJournal(active);
  if (previous && !["complete", "aborted"].includes(previous.phase)) throw new Error("Unfinished storage operation requires --recover");
  const release = acquireOperation(active);
  try { writeJournal(active, { schema: "craft.owner-cutover-journal.v1", operation, phase: "prepared", layout, ...(preserved_root ? { preserved_root } : {}) }); return release; }
  catch (error) { release(); throw error; }
}
function phaseJournal(active: string, phase: string): void {
  const { digest: _, ...journal } = readJournal(active)!; writeJournal(active, { ...journal, phase });
}
function allDatabases(root: string): string[] {
  if (!existsSync(root)) return [];
  regularDirectory(root);
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("Storage operation rejects symbolic links");
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile() && /\.(?:db|sqlite|sqlite3)$/iu.test(name)) paths.push(path);
    }
  };
  visit(root); return paths.sort();
}
/** A crashed rename sequence conservatively restores the operation's original authority. */
export async function recoverOwnerStorage(activeRoot: string, verify: (root: string) => Promise<void>): Promise<{ status: string; operation: string }> {
  const active = resolve(activeRoot), release = acquireOperation(active, true);
  try {
  const journal = readJournal(active);
  if (!journal) throw new Error("No cutover recovery journal");
  if (["complete", "aborted"].includes(journal.phase)) { await verify(active); return { status: journal.phase, operation: journal.operation }; }
  const { layout } = journal;
  const roots = [active, layout.previous_root, layout.staged_root, ...(journal.preserved_root ? [journal.preserved_root] : [])];
  assertNoOpenDatabases(roots.flatMap(allDatabases));
  if (journal.operation === "switch") {
    if (existsSync(layout.previous_root)) {
      if (existsSync(active)) {
        if (existsSync(layout.staged_root)) throw new Error("Ambiguous cutover recovery trees");
        moveTree(active, layout.staged_root);
      }
      moveTree(layout.previous_root, active);
    } else if (!existsSync(active) || !existsSync(layout.staged_root)) throw new Error("Cutover recovery is missing its original authority");
    for (const entry of layout.database_modes) chmodSync(entry.path, entry.mode);
    rebaseImportedHistory(layout.staged_root, layout.staged_root);
  } else {
    const preserved = journal.preserved_root;
    if (!preserved) throw new Error("Rollback recovery preservation root is missing");
    if (existsSync(preserved)) {
      if (existsSync(active)) {
        if (existsSync(layout.previous_root)) throw new Error("Ambiguous rollback recovery trees");
        for (const entry of layout.database_modes) chmodSync(entry.path, entry.mode & ~0o222);
        moveTree(active, layout.previous_root);
      }
      rebaseImportedHistory(preserved, active); moveTree(preserved, active);
    } else if (!existsSync(active) || !existsSync(layout.previous_root)) throw new Error("Rollback recovery is missing its original authority");
  }
  await verify(active); phaseJournal(active, "aborted");
  return { status: "aborted", operation: journal.operation };
  } finally { release(); }
}


function assertNoOpenDatabases(paths: readonly string[], allowedPid?: number): void {
  for (const path of paths) {
    try {
      const output = execFileSync("lsof", ["-F", "p", "--", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
      const fields = output.trim().split("\n");
      const pids = fields.filter(line => /^p\d+$/u.test(line));
      if (!pids.length || fields.some(line => !/^(?:p\d+|f\S+)$/u.test(line))) throw new Error("Database user inventory is invalid");
      if (pids.some(line => line !== `p${allowedPid}`)) throw new Error("Storage cutover requires all database users to stop");
    } catch (error) {
      if (!(error && typeof error === "object" && "status" in error && error.status === 1)) throw error;
    }
  }
}

function regularDirectory(path: string): void {
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error("Storage cutover requires regular directories");
}

function preserveConfiguration(source: string, target: string): void {
  const copy = (relative: string): void => {
    const input = join(source, relative), output = join(target, relative);
    if (!existsSync(input)) return;
    const stat = lstatSync(input);
    if (stat.isSymbolicLink()) throw new Error("Cutover configuration cannot contain symbolic links");
    if (stat.isDirectory()) { for (const name of readdirSync(input)) copy(join(relative, name)); return; }
    if (!stat.isFile()) throw new Error("Cutover configuration requires regular files");
    if (existsSync(output)) {
      if (!lstatSync(output).isFile() || lstatSync(output).isSymbolicLink() || !readFileSync(input).equals(readFileSync(output))) throw new Error("Staged configuration conflicts with the active installation");
    } else { mkdirSync(dirname(output), { recursive: true, mode: 0o700 }); copyFileSync(input, output); }
  };
  for (const path of ["settings.json", "secrets.json", "config", "datasec"]) copy(path);
}

/** Keep the complete previous tree. A failed post-switch verification restores it immediately. */
export async function switchOwnerStorage(activeRoot: string, stagedRoot: string, previousRoot: string,
  manifest: HistoryArchiveManifest, verify: (root: string) => Promise<void>, onPhase?: (phase: string) => Promise<void>): Promise<Cutover> {
  const active = resolve(activeRoot), staged = resolve(stagedRoot), previous = resolve(previousRoot);
  if ([active, staged, previous].some((path, index, paths) => paths.some((other, at) => at !== index && inside(path, other)))) throw new Error("Cutover directories must be separate");
  regularDirectory(active); regularDirectory(staged);
  if (resolve(manifest.source_root) !== active || existsSync(previous) || !presentStorageOwners(staged).length
    || readFileSync(join(staged, ".craft-history-import"), "utf8") !== manifest.digest) throw new Error("Storage cutover inputs do not match the verified import");
  const databases = allDatabases(active);
  const inventoried = manifest.sources.map(source => resolve(source.file)).filter(file => inside(active, file)).sort();
  if (stableDigest(databases) !== stableDigest(inventoried)) throw new Error("Source database inventory changed; rebuild the migration snapshot");
  assertNoOpenDatabases(allDatabases(staged));
  assertNoOpenDatabases(databases);
  const guards: DatabaseSync[] = [];
  let movedPrevious = false, movedStaged = false;
  const layout: Cutover = { schema: "craft.owner-cutover.v1", archive_digest: manifest.digest,
    previous_root: previous, staged_root: staged, active_root: active,
    database_modes: databases.map(path => ({ path, mode: lstatSync(path).mode & 0o777 })) };
  const release = beginJournal(active, "switch", layout);
  try {
    await onPhase?.("prepared");
    for (const file of databases) { const guard = new DatabaseSync(file); guards.push(guard); guard.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); }
    for (const entry of layout.database_modes) chmodSync(entry.path, entry.mode & ~0o222);
    assertNoOpenDatabases(databases, process.pid);
    verifyHistoryArchiveSources(manifest);
    preserveConfiguration(active, staged);
    await verify(staged);
    rebaseImportedHistory(staged, active);
    const previousFence = hasSharedWriterFence(staged);
    for (const file of [join(staged, "db", "craft.db"), join(staged, "craft.db")]) {
      mkdirSync(file, { recursive: true, mode: 0o700 });
      const fence = join(file, FENCE);
      if (existsSync(fence)) {
        if (readFileSync(fence, "utf8") !== manifest.digest) {
          if (!previousFence) throw new Error("Shared writer fence conflicts");
          const temporary = `${fence}.cutover.tmp`;
          writeFileSync(temporary, manifest.digest, { flag: "wx", mode: 0o400 }); renameSync(temporary, fence);
        }
      } else writeFileSync(fence, manifest.digest, { flag: "wx", mode: 0o400 });
    }
    const layoutFile = join(staged, LAYOUT);
    if (existsSync(layoutFile)) {
      if (readFileSync(layoutFile, "utf8") !== JSON.stringify(layout)) {
        if (!previousFence) throw new Error("Storage layout conflicts");
        const temporary = `${layoutFile}.cutover.tmp`;
        writeFileSync(temporary, JSON.stringify(layout), { flag: "wx", mode: 0o600 }); renameSync(temporary, layoutFile);
      }
    } else writeFileSync(layoutFile, JSON.stringify(layout), { flag: "wx", mode: 0o600 });
    moveTree(active, previous); movedPrevious = true; phaseJournal(active, "old_moved"); await onPhase?.("old_moved");
    moveTree(staged, active); movedStaged = true; phaseJournal(active, "new_moved"); await onPhase?.("new_moved");
    await verify(active);
    phaseJournal(active, "complete"); return layout;
  } catch (error) {
    if (movedStaged) { moveTree(active, staged); movedStaged = false; }
    if (movedPrevious) moveTree(previous, active);
    for (const entry of layout.database_modes) chmodSync(entry.path, entry.mode);
    // Keep failed staged assets intact for diagnosis and retry after relocation repair.
    if (existsSync(staged)) rebaseImportedHistory(staged, staged);
    phaseJournal(active, "aborted"); throw error;
  } finally {
    const errors: unknown[] = [];
    for (const guard of guards.reverse()) {
      try { guard.exec("ROLLBACK"); } catch (error) { errors.push(error); }
      try { guard.close(); } catch (error) { errors.push(error); }
    }
    release();
    if (errors.length) throw errors[0];
  }
}

/** Preserve all post-cutover files before restoring the old installation; never merge two writable authorities. */
export async function rollbackOwnerStorage(activeRoot: string, preservedNewRoot: string,
  verify: (root: string) => Promise<void>, onPhase?: (phase: string) => Promise<void>): Promise<void> {
  const active = resolve(activeRoot), preserved = resolve(preservedNewRoot);
  if (!hasSharedWriterFence(active) || existsSync(preserved) || inside(active, preserved) || inside(preserved, active)) throw new Error("Invalid owner rollback inputs");
  const layout = JSON.parse(readFileSync(join(active, LAYOUT), "utf8")) as Cutover;
  validateLayout(layout, active);
  regularDirectory(layout.previous_root);
  const databases = [...allDatabases(active), ...allDatabases(layout.previous_root)];
  assertNoOpenDatabases(databases);
  const release = beginJournal(active, "rollback", layout, preserved);
  let moved = false;
  try {
  await onPhase?.("prepared");
  moveTree(active, preserved); moved = true; phaseJournal(active, "new_preserved"); await onPhase?.("new_preserved");
  rebaseImportedHistory(preserved, preserved); moveTree(layout.previous_root, active); phaseJournal(active, "old_restored"); await onPhase?.("old_restored");
    for (const entry of layout.database_modes) chmodSync(entry.path, entry.mode);
    await verify(active); phaseJournal(active, "complete"); }
  catch (error) {
    if (!moved) { phaseJournal(active, "aborted"); throw error; }
    if (existsSync(active)) {
      for (const entry of layout.database_modes) chmodSync(entry.path, entry.mode & ~0o222);
      moveTree(active, layout.previous_root);
    }
    rebaseImportedHistory(preserved, active); moveTree(preserved, active); phaseJournal(active, "aborted"); throw error;
  } finally { release(); }
}
