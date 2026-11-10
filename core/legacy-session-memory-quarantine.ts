import { createHash, randomUUID } from "node:crypto";
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, chmodSync, openSync, readSync, closeSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { hostname } from "node:os";
import type { CraftPaths } from "../common/craft-common-store-local/src/paths.ts";
import type { LegacySessionMemoryEntry } from "./legacy-session-memory-preflight.ts";

type SnapshotFile = { path: string; bytes: number; digest: string };
type Snapshot = { directories: string[]; files: SnapshotFile[]; bytes: number; digest: string };
type Manifest = {
  schema: "craft.legacy-session-memory-quarantine.v1";
  source_digest: string;
  source_name: string;
  status: string;
  payload_digest: string;
  file_count: number;
  bytes: number;
  link_target?: string;
};

const MAX_FILES = 20_000;
const MAX_BYTES = 512 * 1024 * 1024;
const QUARANTINE_STATUSES = new Set(["unbound_host", "unidentified_session", "source_unreadable"]);

export interface LegacySessionMemoryQuarantineLimits {
  readonly max_files?: number;
  readonly max_bytes?: number;
  readonly retain_source?: boolean;
}

function fileDigest(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r"), buffer = Buffer.alloc(64 * 1024);
  try {
    let read = 0;
    while ((read = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
    return hash.digest("hex");
  } finally { closeSync(fd); }
}

function ensureDirectory(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("quarantine_directory_unsafe");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(path, { mode: 0o700 });
  }
  chmodSync(path, 0o700);
}

function ensureQuarantineRoot(paths: CraftPaths): string {
  const rootStat = lstatSync(paths.root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("craft_data_root_unsafe");
  let current = paths.root;
  for (const part of ["quarantine", "legacy-session-memory", "v1"]) {
    current = join(current, part);
    ensureDirectory(current);
  }
  return current;
}

function snapshotTree(source: string, limits: { max_files: number; max_bytes: number }): Snapshot {
  const directories: string[] = [];
  const files: SnapshotFile[] = [];
  let bytes = 0;
  const pending = [source];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name), stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error("source_tree_unsafe");
      const path = relative(source, absolute).split(sep).join("/");
      if (stat.isDirectory()) { directories.push(path); pending.push(absolute); }
      else if (stat.isFile()) {
        bytes += stat.size;
        if (files.length >= limits.max_files || bytes > limits.max_bytes) throw new Error("source_tree_over_limit");
        files.push({ path, bytes: stat.size, digest: fileDigest(absolute) });
      } else throw new Error("source_tree_unsafe");
    }
  }
  directories.sort(); files.sort((a, b) => a.path.localeCompare(b.path));
  const digest = createHash("sha256").update(JSON.stringify({ directories, files })).digest("hex");
  return { directories, files, bytes, digest };
}

function targetPath(root: string, relativePath: string): string { return join(root, relativePath); }

function manifestText(value: Manifest): string { return `${JSON.stringify(value)}\n`; }

function verifyPublished(directory: string, manifest: Manifest): boolean {
  try {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    const stored = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as Manifest;
    if (manifestText(stored) !== manifestText(manifest)) return false;
    if (manifest.status === "broken_symlink") {
      return typeof manifest.link_target === "string"
        && createHash("sha256").update(`broken-link\0${manifest.link_target}`).digest("hex") === manifest.payload_digest;
    }
    const payload = join(directory, "payload"), snapshot = snapshotTree(payload, { max_files: MAX_FILES, max_bytes: MAX_BYTES });
    return snapshot.digest === manifest.payload_digest && snapshot.files.length === manifest.file_count && snapshot.bytes === manifest.bytes;
  } catch { return false; }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Remove only staging directories proven to belong to a dead local process. */
function removeOrphanStaging(root: string, sourceDigest: string): number {
  const hostDigest = createHash("sha256").update(hostname()).digest("hex").slice(0, 12);
  const pattern = new RegExp(`^\\.${sourceDigest}\\.([a-f0-9]{12})\\.(\\d+)\\.([a-f0-9-]{36})\\.tmp$`, "u");
  let removed = 0;
  for (const name of readdirSync(root)) {
    const match = pattern.exec(name);
    if (!match || match[1] !== hostDigest) continue;
    const pid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid < 1 || processIsAlive(pid)) continue;
    const path = join(root, name), stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("quarantine_staging_unsafe");
    rmSync(path, { recursive: true });
    removed++;
  }
  return removed;
}

function publishQuarantine(paths: CraftPaths, source: string, sourceName: string, entry: LegacySessionMemoryEntry,
  limits: { max_files: number; max_bytes: number }, retainSource: boolean): { manifest: Manifest; staging_recovered: number } {
  const root = ensureQuarantineRoot(paths);
  const sourceDigest = entry.source_digest.slice("sha256:".length);
  const stagingRecovered = removeOrphanStaging(root, sourceDigest);
  let payloadDigest = createHash("sha256").update("empty").digest("hex"), fileCount = 0, bytes = 0;
  let linkTarget: string | undefined;
  const sourceStat = lstatSync(source);
  if (sourceStat.isSymbolicLink()) {
    try { realpathSync(source); throw new Error("source_link_is_live"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      linkTarget = readlinkSync(source);
      payloadDigest = createHash("sha256").update(`broken-link\0${linkTarget}`).digest("hex");
    }
  } else if (sourceStat.isDirectory()) {
    const snapshot = snapshotTree(source, limits);
    payloadDigest = snapshot.digest; fileCount = snapshot.files.length; bytes = snapshot.bytes;
  } else throw new Error("source_type_not_quarantinable");
  // Retained sources can continue changing under an old Host. Preserve each
  // verified snapshot instead of treating a later digest as a target conflict.
  const target = join(root, retainSource ? `${sourceDigest}-${payloadDigest}` : sourceDigest);
  const manifest: Manifest = { schema: "craft.legacy-session-memory-quarantine.v1", source_digest: entry.source_digest,
    source_name: sourceName, status: entry.status, payload_digest: payloadDigest, file_count: fileCount, bytes,
    ...(linkTarget === undefined ? {} : { link_target: linkTarget }) };
  if (existsSync(target)) {
    if (!verifyPublished(target, manifest)) throw new Error("quarantine_target_conflict");
  } else {
    const hostDigest = createHash("sha256").update(hostname()).digest("hex").slice(0, 12);
    const staging = join(root, `.${sourceDigest}.${hostDigest}.${process.pid}.${randomUUID()}.tmp`);
    mkdirSync(staging, { mode: 0o700 });
    try {
      if (!sourceStat.isSymbolicLink()) {
        const snapshot = snapshotTree(source, limits);
        if (snapshot.digest !== payloadDigest) throw new Error("quarantine_source_changed");
        const payload = join(staging, "payload");
        mkdirSync(payload, { mode: 0o700 });
        for (const directory of snapshot.directories) mkdirSync(targetPath(payload, directory), { recursive: true, mode: 0o700 });
        for (const file of snapshot.files) {
          const sourceFile = targetPath(source, file.path), targetFile = targetPath(payload, file.path);
          ensureDirectory(dirname(targetFile));
          copyFileSync(sourceFile, targetFile, constants.COPYFILE_EXCL);
          chmodSync(targetFile, 0o600);
          const copied = lstatSync(targetFile);
          if (copied.isSymbolicLink() || !copied.isFile() || copied.size !== file.bytes || fileDigest(targetFile) !== file.digest)
            throw new Error("quarantine_copy_digest_mismatch");
        }
        if (snapshotTree(source, limits).digest !== snapshot.digest || snapshotTree(payload, limits).digest !== snapshot.digest)
          throw new Error("quarantine_source_changed");
      }
      writeFileSync(join(staging, "manifest.json"), manifestText(manifest), { encoding: "utf8", mode: 0o600, flag: "wx" });
      // A concurrent publisher may win this digest-scoped path. Leave this
      // source intact on EEXIST/ENOTEMPTY; the next idempotent run verifies
      // the winner before retiring it.
      renameSync(staging, target);
    } finally {
      if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    }
  }
  if (!verifyPublished(target, manifest)) throw new Error("quarantine_verify_failed");
  if (retainSource) return { manifest, staging_recovered: stagingRecovered };
  const current = lstatSync(source);
  if (current.isSymbolicLink()) {
    if (linkTarget === undefined || readlinkSync(source) !== linkTarget) throw new Error("source_link_changed");
    try { realpathSync(source); throw new Error("source_link_became_live"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    unlinkSync(source);
  } else {
    if (!current.isDirectory() || snapshotTree(source, limits).digest !== payloadDigest) throw new Error("source_changed_before_retire");
    rmSync(source, { recursive: true });
  }
  return { manifest, staging_recovered: stagingRecovered };
}

/** Copy detached, identity-uncertain Memory into an inert local quarantine before retiring its legacy path. */
export function quarantineLegacySessionMemory(paths: CraftPaths, legacyRoot: string, entries: readonly LegacySessionMemoryEntry[],
  options: LegacySessionMemoryQuarantineLimits = {}): {
  quarantined: number; broken_links: number; staging_recovered: number; blocked: Array<{ source_digest: string; reason: string }>;
} {
  const limits = { max_files: options.max_files ?? MAX_FILES, max_bytes: options.max_bytes ?? MAX_BYTES };
  if (!Number.isSafeInteger(limits.max_files) || limits.max_files < 1 || limits.max_files > MAX_FILES
    || !Number.isSafeInteger(limits.max_bytes) || limits.max_bytes < 1 || limits.max_bytes > MAX_BYTES)
    throw new Error("quarantine limits exceed the supported range");
  const rootStat = lstatSync(legacyRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("legacy_memory_root_unsafe");
  const names = readdirSync(legacyRoot).sort();
  const quarantinedDigests = new Set<string>(), brokenDigests = new Set<string>();
  let stagingRecovered = 0;
  const blocked: Array<{ source_digest: string; reason: string }> = [];
  for (const entry of entries) {
    if (!QUARANTINE_STATUSES.has(entry.status) && entry.status !== "broken_symlink") continue;
    if (!/^sha256:[a-f0-9]{64}$/u.test(entry.source_digest)) { blocked.push({ source_digest: "invalid", reason: "source_identity_invalid" }); continue; }
    const sourceName = names.find(name => `sha256:${createHash("sha256").update(name).digest("hex")}` === entry.source_digest);
    if (!sourceName) { blocked.push({ source_digest: entry.source_digest, reason: "source_identity_missing" }); continue; }
    const source = join(legacyRoot, sourceName);
    try {
      const { manifest, staging_recovered } = publishQuarantine(paths, source, sourceName, entry, limits, options.retain_source === true);
      stagingRecovered += staging_recovered;
      (manifest.status === "broken_symlink" ? brokenDigests : quarantinedDigests).add(entry.source_digest);
    } catch (error) {
      const message = String(error).replace(/^Error:\s*/u, "");
      blocked.push({ source_digest: entry.source_digest, reason: /^[a-z][a-z0-9_]{0,80}$/u.test(message) ? message : "filesystem_error" });
    }
  }
  return { quarantined: quarantinedDigests.size, broken_links: brokenDigests.size, staging_recovered: stagingRecovered, blocked };
}
