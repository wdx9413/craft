import { createHash, randomUUID } from "node:crypto";
import { chmodSync, constants, copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, linkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { ensureProjectStorageDirectory, projectStorageIdentity, type CraftPaths } from "../common/craft-common-store-local/src/paths.ts";
import type { LegacyRepositoryStorageEntry } from "./legacy-repository-storage-preflight.ts";

type FileEntry = { path: string; size_bytes: number; digest: string; capability: string; target_path: string };
type DirectoryEntry = { path: string; capability: string; target_path: string };
type Snapshot = { directories: DirectoryEntry[]; files: FileEntry[]; bytes: number; digest: string };
type Manifest = {
  schema: "craft.legacy-repository-storage-migration.v1";
  project_root: string;
  project_path_sha256: string;
  source_root: string;
  migration_id: string;
  directories: DirectoryEntry[];
  files: FileEntry[];
  file_count: number;
  bytes: number;
};

const PROJECT_CAPABILITIES = new Set(["codebase", "knowledge", "memory", "experience", "context"]);

async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function ensureDirectory(path: string): void {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { mkdirSync(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("migration_directory_unsafe");
  }
}

function checkedPath(root: string, relativePath: string): string {
  if (!relativePath || relativePath.split(/[\\/]/u).some(part => !part || part === "." || part === "..")) {
    throw new Error("migration_relative_path_invalid");
  }
  let current = root;
  const parts = relativePath.split(/[\\/]/u);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) throw new Error("migration_source_missing");
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error("migration_tree_unsafe");
    }
  }
  return current;
}

function mapping(path: string): { capability: string; path: string } {
  const [head, ...tail] = path.split("/");
  if (PROJECT_CAPABILITIES.has(head!)) return { capability: head!, path: tail.join("/") };
  if (tail.length === 0 && head) return { capability: "context", path: `root-files/${head}` };
  return { capability: "context", path: `unclassified/${path}` };
}

async function snapshot(source: string): Promise<{ directories: DirectoryEntry[]; files: FileEntry[]; bytes: number; digest: string }> {
  const directories: DirectoryEntry[] = [], files: FileEntry[] = [];
  let bytes = 0;
  const pending = [source];
  while (pending.length) {
    const directory = pending.pop()!;
    const names = readdirSync(directory).sort();
    for (const name of names) {
      const absolute = join(directory, name), stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error("migration_tree_unsafe");
      const path = relative(source, absolute).split(sep).join("/");
      const target = mapping(path);
      if (stat.isDirectory()) {
        directories.push({ path, capability: target.capability, target_path: target.path });
        pending.push(absolute);
      } else if (stat.isFile()) {
        const fileDigest = await digestFile(absolute);
        bytes += stat.size;
        files.push({ path, size_bytes: stat.size, digest: fileDigest, capability: target.capability, target_path: target.path });
      } else throw new Error("migration_tree_unsafe");
    }
  }
  directories.sort((a, b) => a.path.localeCompare(b.path));
  files.sort((a, b) => a.path.localeCompare(b.path));
  const digest = createHash("sha256").update(JSON.stringify({ directories, files })).digest("hex");
  return { directories, files, bytes, digest };
}

function ensureTargetParent(root: string, relativePath: string): string {
  let current = root;
  for (const part of relativePath.split(/[\\/]/u).slice(0, -1)) {
    current = join(current, part);
    ensureDirectory(current);
  }
  return current;
}

async function verifyFile(path: string, entry: FileEntry): Promise<boolean> {
  try {
    const stat = lstatSync(path);
    return !stat.isSymbolicLink() && stat.isFile() && stat.size === entry.size_bytes && await digestFile(path) === entry.digest;
  } catch { return false; }
}

function expectedDirectories(tree: Snapshot, capability: string): Set<string> {
  const result = new Set<string>([""]);
  const addParents = (path: string): void => {
    let current = "";
    for (const part of path.split("/").slice(0, -1)) {
      current = current ? `${current}/${part}` : part;
      result.add(current);
    }
  };
  for (const item of tree.directories) if (item.capability === capability) {
    let current = "";
    for (const part of item.target_path.split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      result.add(current);
    }
  }
  for (const item of tree.files) if (item.capability === capability) addParents(item.target_path);
  return result;
}

function verifyPayloadTree(root: string, tree: Snapshot, capability: string): boolean {
  const expectedFiles = new Set(tree.files.filter(item => item.capability === capability).map(item => item.target_path));
  const expectedDirs = expectedDirectories(tree, capability);
  const actualFiles = new Set<string>(), actualDirs = new Set<string>([""]);
  const walk = (directory: string, prefix: string): boolean => {
    let names: string[];
    try { names = readdirSync(directory).sort(); } catch { return false; }
    for (const name of names) {
      const path = prefix ? `${prefix}/${name}` : name;
      let stat;
      try { stat = lstatSync(join(directory, name)); } catch { return false; }
      if (stat.isSymbolicLink()) return false;
      if (stat.isDirectory()) { actualDirs.add(path); if (!walk(join(directory, name), path)) return false; }
      else if (stat.isFile()) actualFiles.add(path);
      else return false;
    }
    return true;
  };
  if (!walk(root, "") || actualFiles.size !== expectedFiles.size || actualDirs.size !== expectedDirs.size) return false;
  return [...expectedFiles].every(path => actualFiles.has(path)) && [...expectedDirs].every(path => actualDirs.has(path));
}

function manifestText(manifest: Manifest): string { return `${JSON.stringify(manifest)}\n`; }

/** Copy a bound repository's legacy tree into project-scoped capability archives without deleting its source. */
export async function migrateLegacyRepositoryStorage(paths: CraftPaths, entry: LegacyRepositoryStorageEntry): Promise<{
  status: "migrated" | "already_migrated"; migration_id: string; file_count: number; bytes: number; manifest_path: string;
}> {
  if (entry.status !== "ready" || !entry.canonical_project_root || !entry.project_directory) throw new Error("legacy_source_not_ready");
  ensureDirectory(paths.root);
  const projectRoot = entry.canonical_project_root;
  const identity = projectStorageIdentity(projectRoot);
  const sourceRoot = join(projectRoot, ".craft_data");
  if (identity.canonical_root !== projectRoot || entry.source_root !== sourceRoot
    || entry.project_directory !== join(paths.root, "projects", identity.directory_name)) throw new Error("legacy_source_identity_mismatch");
  const sourceStat = lstatSync(sourceRoot);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) throw new Error("legacy_source_unsafe");
  const tree = await snapshot(sourceRoot);
  if (tree.files.length !== entry.file_count || tree.bytes !== entry.size_bytes) throw new Error("legacy_source_changed_since_preflight");
  const projectDirectory = ensureProjectStorageDirectory(paths, projectRoot);
  const manifest: Manifest = { schema: "craft.legacy-repository-storage-migration.v1", project_root: projectRoot,
    project_path_sha256: identity.path_sha256, source_root: sourceRoot, migration_id: tree.digest,
    directories: tree.directories, files: tree.files, file_count: tree.files.length, bytes: tree.bytes };
  const migrationId = tree.digest;
  const manifestPath = join(paths.backupsDir, "legacy-repository-storage", "v1", identity.path_sha256, `${migrationId}.json`);
  const projectManifestPath = join(projectDirectory, "context", "legacy-import", migrationId, "manifest.json");
  ensureDirectory(paths.backupsDir);
  const projectImportRoot = dirname(projectManifestPath);
  const projectRoots = new Map<string, string>();
  for (const item of [...tree.directories, ...tree.files]) {
    if (!projectRoots.has(item.capability)) projectRoots.set(item.capability, join(projectDirectory, item.capability, "legacy-import", migrationId));
  }
  ensureDirectory(join(paths.backupsDir, "legacy-repository-storage"));
  ensureDirectory(join(paths.backupsDir, "legacy-repository-storage", "v1"));
  ensureDirectory(join(paths.backupsDir, "legacy-repository-storage", "v1", identity.path_sha256));
  for (const root of projectRoots.values()) ensureDirectory(root);
  ensureDirectory(projectImportRoot);

  const expectedManifest = manifestText(manifest);
  const priorGlobal = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : null;
  const priorProject = existsSync(projectManifestPath) ? readFileSync(projectManifestPath, "utf8") : null;
  if ((priorGlobal !== null && priorGlobal !== expectedManifest) || (priorProject !== null && priorProject !== expectedManifest))
    throw new Error("migration_manifest_conflict");
  const alreadyStarted = priorGlobal !== null || priorProject !== null;

  for (const item of tree.directories) {
    const targetRoot = projectRoots.get(item.capability)!;
    const payloadRoot = join(targetRoot, "payload");
    ensureDirectory(payloadRoot);
    if (item.target_path) {
      const targetDirectory = join(payloadRoot, item.target_path);
      ensureDirectory(targetDirectory);
    }
  }
  for (const item of tree.files) {
    const targetRoot = projectRoots.get(item.capability)!;
    const payloadRoot = join(targetRoot, "payload");
    const target = join(payloadRoot, item.target_path);
    const parent = ensureTargetParent(payloadRoot, item.target_path);
    if (existsSync(target)) {
      if (!await verifyFile(target, item)) throw new Error("migration_target_conflict");
      continue;
    }
    const source = checkedPath(sourceRoot, item.path);
    const temporary = join(parent, `.${randomUUID()}.tmp`);
    try {
      copyFileSync(source, temporary, constants.COPYFILE_EXCL);
      chmodSync(temporary, 0o600);
      if (lstatSync(temporary).size !== item.size_bytes || await digestFile(temporary) !== item.digest) throw new Error("migration_source_changed_during_copy");
      try { linkSync(temporary, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !await verifyFile(target, item)) throw new Error("migration_target_conflict");
      }
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  for (const item of tree.files) {
    const targetRoot = projectRoots.get(item.capability)!;
    if (!await verifyFile(join(targetRoot, "payload", item.target_path), item)) throw new Error("migration_target_verification_failed");
  }
  for (const [capability, targetRoot] of projectRoots) {
    if (!verifyPayloadTree(join(targetRoot, "payload"), tree, capability)) throw new Error("migration_target_tree_conflict");
  }
  const text = expectedManifest;
  for (const path of [manifestPath, projectManifestPath]) {
    if (existsSync(path)) continue;
    const parent = dirname(path), temp = join(parent, `.${migrationId}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
      try { linkSync(temp, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || readFileSync(path, "utf8") !== text) throw new Error("migration_manifest_conflict");
      }
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  return { status: alreadyStarted ? "already_migrated" : "migrated", migration_id: migrationId,
    file_count: tree.files.length, bytes: tree.bytes, manifest_path: manifestPath };
}
