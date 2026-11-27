import { createHash, randomUUID } from "node:crypto";
import { chmodSync, constants, copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, linkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { ensureProjectStorageDirectory, projectStorageIdentity, type CraftPaths } from 'craft-common-store-local/paths';
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

async function snapshot(source: string, prior?: Manifest, ignoreBackup?: string): Promise<{ directories: DirectoryEntry[]; files: FileEntry[]; bytes: number; digest: string }> {
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
      if (prior) {
        const original = [...prior.directories, ...prior.files];
        const generated = [...PROJECT_CAPABILITIES].map(capability => `${capability}/legacy-import/${prior.migration_id}`);
        if (generated.some(prefix => path === prefix || path.startsWith(`${prefix}/`))) continue;
        if ((path === "project.json" || path === ".gitignore") && !original.some(item => item.path === path)) {
          const expected = path === ".gitignore" ? "*\n" : `${JSON.stringify({ schema_version: 1, ...projectStorageIdentity(prior.project_root) })}\n`;
          if (!stat.isFile() || readFileSync(absolute, "utf8") !== expected) throw new Error("legacy_source_changed_since_preflight");
          continue;
        }
        if (stat.isDirectory() && !original.some(item => item.path === path) && generated.some(prefix => prefix.startsWith(`${path}/`))) {
          pending.push(absolute); continue;
        }
      }
      const target = mapping(path);
      if (stat.isDirectory()) {
        directories.push({ path, capability: target.capability, target_path: target.path });
        pending.push(absolute);
      } else if (stat.isFile()) {
        if (path === ".gitignore" && prior && ignoreBackup && prior.files.some(item => item.path === path)) {
          const original = readFileSync(ignoreBackup), current = readFileSync(absolute);
          const adjusted = Buffer.concat([original, Buffer.from(original.length && original[original.length - 1] !== 10 ? "\n*\n" : "*\n")]);
          if (!current.equals(original) && !current.equals(adjusted)) throw new Error("legacy_source_changed_since_preflight");
          const size = original.length, fileDigest = createHash("sha256").update(original).digest("hex");
          bytes += size; files.push({ path, size_bytes: size, digest: fileDigest, capability: target.capability, target_path: target.path });
          continue;
        }
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
    || entry.project_directory !== sourceRoot) throw new Error("legacy_source_identity_mismatch");
  const sourceStat = lstatSync(sourceRoot);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) throw new Error("legacy_source_unsafe");
  const backupDirectory = join(paths.backupsDir, "legacy-repository-storage", "v1", identity.path_sha256);
  const priorManifests: Manifest[] = [];
  if (existsSync(backupDirectory)) for (const name of readdirSync(backupDirectory)) {
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
    const manifest = JSON.parse(readFileSync(join(backupDirectory, name), "utf8")) as Manifest;
    if (manifest.schema !== "craft.legacy-repository-storage-migration.v1" || manifest.source_root !== sourceRoot
      || manifest.project_path_sha256 !== identity.path_sha256 || manifest.migration_id !== name.slice(0, -5)
      || !Array.isArray(manifest.files) || !Array.isArray(manifest.directories)) throw new Error("migration_manifest_conflict");
    if (manifest.file_count !== manifest.files.length || manifest.bytes !== manifest.files.reduce((sum, item) => sum + item.size_bytes, 0)
      || createHash("sha256").update(JSON.stringify({ directories: manifest.directories, files: manifest.files })).digest("hex") !== manifest.migration_id) throw new Error("migration_manifest_conflict");
    priorManifests.push(manifest);
  }
  if (priorManifests.length > 1) throw new Error("migration_manifest_conflict");
  const prior = priorManifests[0];
  const tree = await snapshot(sourceRoot, prior, prior ? join(backupDirectory, `${prior.migration_id}.gitignore`) : undefined);
  if (tree.files.length !== (priorManifests[0]?.file_count ?? entry.file_count)
    || tree.bytes !== (priorManifests[0]?.bytes ?? entry.size_bytes)) throw new Error("legacy_source_changed_since_preflight");
  const manifest: Manifest = { schema: "craft.legacy-repository-storage-migration.v1", project_root: projectRoot,
    project_path_sha256: identity.path_sha256, source_root: sourceRoot, migration_id: tree.digest,
    directories: tree.directories, files: tree.files, file_count: tree.files.length, bytes: tree.bytes };
  const migrationId = tree.digest;
  if (priorManifests[0] && priorManifests[0].migration_id !== migrationId) throw new Error("legacy_source_changed_since_preflight");
  const generatedRoots = [...PROJECT_CAPABILITIES].map(capability => `${capability}/legacy-import/${migrationId}`);
  if (!priorManifests.length && [...tree.directories, ...tree.files].some(item => generatedRoots.some(prefix => item.path === prefix || item.path.startsWith(`${prefix}/`)))) throw new Error("migration_target_conflict");
  const projectDirectory = sourceRoot;
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
  const expectedManifest = manifestText(manifest);
  const priorGlobal = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : null;
  const priorProject = existsSync(projectManifestPath) ? readFileSync(projectManifestPath, "utf8") : null;
  if ((priorGlobal !== null && priorGlobal !== expectedManifest) || (priorProject !== null && priorProject !== expectedManifest))
    throw new Error("migration_manifest_conflict");
  const completionPath = join(backupDirectory, `${migrationId}.complete`);
  const completion = existsSync(completionPath) ? readFileSync(completionPath, "utf8") : null;
  if (completion !== null && completion !== expectedManifest) throw new Error("migration_manifest_conflict");
  const alreadyCompleted = completion !== null || priorProject !== null;
  const ignoreBackup = join(backupDirectory, `${migrationId}.gitignore`);
  const originalIgnore = tree.files.find(item => item.path === ".gitignore");
  if (originalIgnore && !existsSync(ignoreBackup)) {
    const temp = join(backupDirectory, `.${migrationId}.${randomUUID()}.ignore.tmp`);
    try {
      copyFileSync(join(sourceRoot, ".gitignore"), temp, constants.COPYFILE_EXCL);
      chmodSync(temp, 0o600);
      if (!await verifyFile(temp, originalIgnore)) throw new Error("migration_source_changed_during_copy");
      try { linkSync(temp, ignoreBackup); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !await verifyFile(ignoreBackup, originalIgnore)) throw new Error("migration_target_conflict"); }
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  if (originalIgnore && !await verifyFile(ignoreBackup, originalIgnore)) throw new Error("migration_target_conflict");
  if (priorGlobal === null) {
    const temp = join(dirname(manifestPath), `.${migrationId}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, expectedManifest, { mode: 0o600, flag: "wx" });
      try { linkSync(temp, manifestPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || readFileSync(manifestPath, "utf8") !== expectedManifest) throw new Error("migration_manifest_conflict"); }
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  ensureProjectStorageDirectory(paths, projectRoot);
  for (const root of projectRoots.values()) ensureDirectory(root);
  ensureDirectory(projectImportRoot);

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
    const source = item.path === ".gitignore" ? ignoreBackup : checkedPath(sourceRoot, item.path);
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
    if (readdirSync(targetRoot).some(name => name !== "payload" && !(capability === "context" && name === "manifest.json"))) throw new Error("migration_target_tree_conflict");
  }
  if (!projectRoots.has("context") && readdirSync(projectImportRoot).some(name => name !== "manifest.json")) throw new Error("migration_target_tree_conflict");
  if ((await snapshot(sourceRoot, manifest, originalIgnore ? ignoreBackup : undefined)).digest !== migrationId) throw new Error("legacy_source_changed_since_preflight");
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
  if (!existsSync(completionPath)) {
    const temp = join(backupDirectory, `.${migrationId}.${randomUUID()}.complete.tmp`);
    try {
      writeFileSync(temp, expectedManifest, { mode: 0o600, flag: "wx" });
      try { linkSync(temp, completionPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || readFileSync(completionPath, "utf8") !== expectedManifest) throw new Error("migration_manifest_conflict"); }
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  return { status: alreadyCompleted ? "already_migrated" : "migrated", migration_id: migrationId,
    file_count: tree.files.length, bytes: tree.bytes, manifest_path: manifestPath };
}
