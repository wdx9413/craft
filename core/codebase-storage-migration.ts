import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants, copyFileSync, createReadStream, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { canonicalCandidatePath, ensureProjectStorageDirectory, projectStorageDirectory, type CraftPaths } from "../common/craft-common-store-local/src/paths.ts";
import type { CodebaseMigrationEntry } from "./codebase-storage-preflight.ts";

type SnapshotFile = { path: string; digest: string; size_bytes: number };

function regularDirectory(path: string): void {
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Codebase migration directory is unsafe");
}

function checkedFile(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.split(/[\\/]/u).some(part => !part || part === "." || part === "..")) {
    throw new Error("Codebase snapshot entry path is unsafe");
  }
  let current = root;
  const parts = path.split(/[\\/]/u);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error("Codebase snapshot entry is not a regular file");
    }
  }
  return current;
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function safeTargetDirectory(root: string, relativePath: string): string {
  let current = root;
  for (const part of relativePath.split(/[\\/]/u).slice(0, -1)) {
    current = join(current, part);
    regularDirectory(current);
  }
  return current;
}

function snapshotTree(root: string): { directories: string[]; files: Set<string> } {
  const directories: string[] = [], files = new Set<string>();
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("source_snapshot_unsafe");
      if (stat.isDirectory()) { directories.push(relative(root, path).replaceAll("\\", "/")); walk(path); }
      else if (stat.isFile()) files.add(relative(root, path).replaceAll("\\", "/"));
      else throw new Error("source_snapshot_unsafe");
    }
  };
  walk(root);
  return { directories, files };
}

async function verifiedPeer(database: DatabaseSync, paths: CraftPaths, projectRoot: string,
  checkpointId: string, file: SnapshotFile): Promise<{ path: string; checkpoint_id: string; workspace_id: string; workspace_snapshot: string } | null> {
  const rows = database.prepare("SELECT id,payload_json FROM records WHERE kind='workspace_checkpoint' AND id<>? ORDER BY id")
    .all(checkpointId) as Array<{ id: string; payload_json: string }>;
  for (const row of rows) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(row.id)) continue;
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(row.payload_json) as Record<string, unknown>; }
    catch { continue; }
    const peerWorkspaceId = typeof payload.workspace_id === "string" ? payload.workspace_id : "";
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(peerWorkspaceId) || !Number.isSafeInteger(payload.state_revision)
      || !Array.isArray(payload.entries)
      || !payload.entries.some(value => {
        if (!value || typeof value !== "object") return false;
        const item = value as Partial<SnapshotFile>;
        return item.path === file.path && item.digest === file.digest && item.size_bytes === file.size_bytes;
      })) continue;
    const workspaceSnapshot = String((database.prepare("SELECT json_group_array(payload_json) AS snapshot FROM (SELECT payload_json FROM records WHERE kind='workspace' AND id=? ORDER BY version)")
      .get(peerWorkspaceId) as { snapshot: string }).snapshot);
    const workspaceRows = (JSON.parse(workspaceSnapshot) as string[]).map(payload_json => ({ payload_json }));
    let unavailablePeerRoot = false;
    const peerRoots = new Set(workspaceRows.flatMap(value => {
      try {
        const item = JSON.parse(value.payload_json) as Record<string, unknown>;
        if (item.state_revision !== payload.state_revision) return [];
        if (typeof item.root_path !== "string") { unavailablePeerRoot = true; return []; }
        try {
          const root = realpathSync(item.root_path);
          if (lstatSync(root).isDirectory()) return [root];
        } catch { /* matching historical root is unavailable */ }
        unavailablePeerRoot = true; return [];
      } catch { return []; }
    }));
    if (unavailablePeerRoot || peerRoots.size !== 1 || !peerRoots.has(projectRoot)) continue;
    if (typeof payload.snapshot_root !== "string") continue;
    const expected = [join(projectStorageDirectory(paths, projectRoot), "codebase", "snapshots", peerWorkspaceId, row.id),
      join(projectRoot, ".craft_data", "codebase", "snapshots", peerWorkspaceId, row.id),
      join(projectRoot, ".craft_data", "codebase", "runtime", "workspaces", peerWorkspaceId, "snapshots", row.id),
      join(paths.runtimeDir, "workspaces", peerWorkspaceId, "snapshots", row.id)];
    try {
      if (!expected.some(path => canonicalCandidatePath(path) === canonicalCandidatePath(payload.snapshot_root as string))) continue;
      const path = checkedFile(payload.snapshot_root, file.path);
      if (lstatSync(path).size === file.size_bytes && await fileDigest(path) === file.digest) {
        return { path, checkpoint_id: row.id, workspace_id: peerWorkspaceId, workspace_snapshot: workspaceSnapshot };
      }
    } catch { /* try another exact peer */ }
  }
  return null;
}

/** Recover an exact file from a locally available Git object; never fetch from a remote. */
async function verifiedGitHistory(projectRoot: string, file: SnapshotFile, backupDirectory: string): Promise<{ path: string; commit: string } | null> {
  const env = { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" };
  const history = spawnSync("git", ["-C", projectRoot, "log", "--all", "--format=%H", "--", file.path],
    { encoding: "utf8", env, maxBuffer: 1024 * 1024 });
  for (const commit of history.stdout?.split("\n") ?? []) {
    if (!/^[a-f0-9]{40,64}$/u.test(commit)) continue;
    const result = spawnSync("git", ["-C", projectRoot, "show", `${commit}:${file.path}`],
      { encoding: "buffer", env, maxBuffer: Math.min(Math.max(file.size_bytes + 1024, 1024 * 1024), 64 * 1024 * 1024) });
    if (result.status !== 0 || !Buffer.isBuffer(result.stdout) || result.stdout.length !== file.size_bytes
      || createHash("sha256").update(result.stdout).digest("hex") !== file.digest) continue;
    const directory = join(backupDirectory, "verified-git");
    regularDirectory(directory);
    const path = join(directory, file.digest);
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== file.size_bytes || await fileDigest(path) !== file.digest) {
        throw new Error("verified_git_backup_conflict");
      }
    } else {
      writeFileSync(path, result.stdout, { mode: 0o600, flag: "wx" });
    }
    return { path, commit };
  }
  return null;
}

async function updateCheckpointWithRetry(database: DatabaseSync, entry: CodebaseMigrationEntry, expected: string, next: string, workspaceSnapshot: string, peerSnapshots: string, root: string, rootIdentity: { dev: number; ino: number }): Promise<number> {
  const statement = database.prepare(`UPDATE records SET payload_json=? WHERE kind='workspace_checkpoint' AND id=? AND version=? AND payload_json=?
    AND (SELECT json_group_array(payload_json) FROM (SELECT payload_json FROM records WHERE kind='workspace' AND id=? ORDER BY version))=?
    AND NOT EXISTS (SELECT 1 FROM json_each(?) AS peer WHERE
      (SELECT json_group_array(payload_json) FROM (SELECT payload_json FROM records WHERE kind='workspace' AND id=json_extract(peer.value,'$.id') ORDER BY version)) != json_extract(peer.value,'$.snapshot'))`);
  for (let attempt = 0; ; attempt++) {
    try {
      const rootStat = lstatSync(root);
      if (realpathSync(root) !== root || !rootStat.isDirectory() || rootStat.dev !== rootIdentity.dev || rootStat.ino !== rootIdentity.ino) throw new Error("project_root_changed_or_missing");
      return Number(statement.run(next, entry.id, entry.version, expected, entry.workspace_id, workspaceSnapshot, peerSnapshots).changes);
    }
    catch (error) {
      const retryable = error instanceof Error && /database is locked|SQLITE_BUSY|SQLITE_LOCKED/iu.test(error.message);
      if (!retryable || attempt >= 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

/** Back up the central pointer DB, copy digest-checked immutable files, then CAS the checkpoint root. */
export async function migrateCodebaseSnapshots(store: { paths: CraftPaths; database: DatabaseSync }, entries: CodebaseMigrationEntry[],
  options: { backup_directory?: string; recover_verified_peer?: boolean; on_progress?: (processed: number, total: number) => void } = {}): Promise<{
  migrated: number; already_current: number; blocked: Array<{ id: string; version: number; reason: string }>;
  recovered: Array<{ id: string; path: string; from_checkpoint_id: string | null; from_git_commit: string | null; digest: string }>;
  backup_directory: string | null;
}> {
  if (!entries.length) return { migrated: 0, already_current: 0, blocked: [], recovered: [], backup_directory: null };
  if (entries.length > 500) throw new Error("Codebase migration page is too large");
  if (entries.some(item => item.status !== "legacy_ready" || !item.target_root)) throw new Error("Codebase migration requires ready checkpoints");
  for (const path of [store.paths.root, store.paths.backupsDir]) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Codebase migration backup path is unsafe");
  }
  const backupRoot = join(store.paths.backupsDir, "codebase-storage-migration");
  regularDirectory(backupRoot);
  let backupDirectory: string;
  let backupHasWorkspace = false;
  if (options.backup_directory) {
    backupDirectory = resolve(options.backup_directory);
    if (dirname(backupDirectory) !== backupRoot) throw new Error("Codebase migration backup is outside its data root");
    const directoryStat = lstatSync(backupDirectory), manifestPath = join(backupDirectory, "manifest.json");
    const manifestStat = lstatSync(manifestPath), databasePath = join(backupDirectory, "craft.db"), databaseStat = lstatSync(databasePath);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory() || manifestStat.isSymbolicLink() || !manifestStat.isFile()
      || databaseStat.isSymbolicLink() || !databaseStat.isFile() || databaseStat.size === 0) {
      throw new Error("Codebase migration backup is unsafe");
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    backupHasWorkspace = manifest.backup_scope === "checkpoint_and_workspace_rows";
    const covered = Array.isArray(manifest.checkpoint_ids) ? new Set(manifest.checkpoint_ids.map(item => JSON.stringify(item))) : new Set<string>();
    if (manifest.schema !== "craft.codebase-storage-backup.v1" || manifest.central_database !== store.paths.databaseFile
      || manifest.backup !== databasePath || manifest.backup_scope !== undefined && !["checkpoint_rows", "checkpoint_and_workspace_rows"].includes(String(manifest.backup_scope))
      || entries.some(item => !covered.has(JSON.stringify([item.id, item.version])))) {
      throw new Error("Codebase migration backup identity does not match this page");
    }
    const check = new DatabaseSync(databasePath, { readOnly: true });
    try {
      if (String((check.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check) !== "ok") {
        throw new Error("Codebase migration backup failed integrity check");
      }
      const original = check.prepare("SELECT payload_json,created_at,updated_at FROM records WHERE kind='workspace_checkpoint' AND id=? AND version=?");
      const current = store.database.prepare("SELECT payload_json,created_at,updated_at FROM records WHERE kind='workspace_checkpoint' AND id=? AND version=?");
      for (const entry of entries) {
        const before = original.get(entry.id, entry.version), now = current.get(entry.id, entry.version);
        if (!before || JSON.stringify(before) !== JSON.stringify(now)) throw new Error("Codebase migration checkpoint differs from its backup");
      }
    } finally { check.close(); }
  } else {
    backupDirectory = join(backupRoot, `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`);
    regularDirectory(backupDirectory);
    const backupPath = join(backupDirectory, "craft.db");
    const snapshot = new DatabaseSync(backupPath);
    const backedUpEntries: typeof entries = [];
    let readTransaction = false;
    try {
      snapshot.exec("CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(kind,id,version))");
      store.database.exec("BEGIN"); readTransaction = true;
      const readCheckpoint = store.database.prepare("SELECT kind,id,version,payload_json,created_at,updated_at FROM records WHERE kind='workspace_checkpoint' AND id=? AND version=?");
      const writeCheckpoint = snapshot.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)");
      for (const entry of entries) {
        const row = readCheckpoint.get(entry.id, entry.version) as { kind: string; id: string; version: number; payload_json: string; created_at: string; updated_at: string } | undefined;
        if (!row) continue;
        writeCheckpoint.run(row.kind, row.id, row.version, row.payload_json, row.created_at, row.updated_at);
        backedUpEntries.push(entry);
      }
      const readWorkspace = store.database.prepare("SELECT kind,id,version,payload_json,created_at,updated_at FROM records WHERE kind='workspace' AND id=? ORDER BY version");
      for (const workspaceId of new Set(backedUpEntries.map(entry => entry.workspace_id))) {
        for (const row of readWorkspace.all(workspaceId) as Array<{ kind: string; id: string; version: number; payload_json: string; created_at: string; updated_at: string }>) {
          writeCheckpoint.run(row.kind, row.id, row.version, row.payload_json, row.created_at, row.updated_at);
        }
      }
      store.database.exec("COMMIT"); readTransaction = false;
    } finally { if (readTransaction) store.database.exec("ROLLBACK"); snapshot.close(); }
    const check = new DatabaseSync(backupPath, { readOnly: true });
    try {
      if (String((check.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check) !== "ok") {
        throw new Error("Codebase migration backup failed integrity check");
      }
    } finally { check.close(); }
    writeFileSync(join(backupDirectory, "manifest.json"), `${JSON.stringify({ schema: "craft.codebase-storage-backup.v1",
      backup_scope: "checkpoint_and_workspace_rows", central_database: store.paths.databaseFile, backup: backupPath,
      checkpoint_ids: backedUpEntries.map(item => [item.id, item.version]) })}\n`,
    { mode: 0o600, flag: "wx" });
    backupHasWorkspace = true;
  }
  let migrated = 0, alreadyCurrent = 0;
  const blocked: Array<{ id: string; version: number; reason: string }> = [];
  const recovered: Array<{ id: string; path: string; from_checkpoint_id: string | null; from_git_commit: string | null; digest: string }> = [];
  for (const [index, entry] of entries.entries()) {
    try {
      const pendingRecovered: typeof recovered = [];
      const peerSnapshots: Array<{ id: string; snapshot: string }> = [];
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(entry.id)
        || !Number.isSafeInteger(entry.version) || entry.version < 1) throw new Error("checkpoint_identity_invalid");
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(entry.workspace_id)) throw new Error("workspace_id_invalid");
      const row = store.database.prepare("SELECT payload_json FROM records WHERE kind='workspace_checkpoint' AND id=? AND version=?")
        .get(entry.id, entry.version) as { payload_json: string } | undefined;
      if (!row) throw new Error("checkpoint_missing");
      const backup = new DatabaseSync(join(backupDirectory, "craft.db"), { readOnly: true });
      try {
        const saved = backup.prepare("SELECT payload_json FROM records WHERE kind='workspace_checkpoint' AND id=? AND version=?")
          .get(entry.id, entry.version) as { payload_json: string } | undefined;
        if (!saved || saved.payload_json !== row.payload_json) throw new Error("checkpoint_differs_from_backup");
      } finally { backup.close(); }
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      if (payload.snapshot_root !== entry.source_root || payload.workspace_id !== entry.workspace_id || !Array.isArray(payload.entries)) {
        throw new Error("checkpoint_changed");
      }
      const target = entry.target_root!;
      const workspaceSnapshot = String((store.database.prepare("SELECT json_group_array(payload_json) AS snapshot FROM (SELECT payload_json FROM records WHERE kind='workspace' AND id=? ORDER BY version)")
        .get(entry.workspace_id) as { snapshot: string }).snapshot);
      if (backupHasWorkspace) {
        const backup = new DatabaseSync(join(backupDirectory, "craft.db"), { readOnly: true });
        try {
          const saved = (backup.prepare("SELECT json_group_array(payload_json) AS snapshot FROM (SELECT payload_json FROM records WHERE kind='workspace' AND id=? ORDER BY version)")
            .get(entry.workspace_id) as { snapshot: string }).snapshot;
          if (saved !== workspaceSnapshot) throw new Error("workspace_differs_from_backup");
        } finally { backup.close(); }
      }
      const workspaceRows = (JSON.parse(workspaceSnapshot) as string[]).map(payload_json => ({ payload_json }));
      let unavailableRoot = false;
      const roots = [...new Set(workspaceRows.flatMap(value => {
        try {
          const item = JSON.parse(value.payload_json) as Record<string, unknown>;
          if (item.state_revision !== payload.state_revision) return [];
          if (typeof item.root_path !== "string") { unavailableRoot = true; return []; }
          try {
            const root = realpathSync(item.root_path);
            if (lstatSync(root).isDirectory()) return [root];
          } catch { /* matching historical root is unavailable */ }
          unavailableRoot = true; return [];
        } catch { return []; }
      }))];
      if (roots.length !== 1 || unavailableRoot) throw new Error("project_root_changed_or_missing");
      const root = roots[0]!;
      const rootStat = lstatSync(root), rootIdentity = { dev: rootStat.dev, ino: rootStat.ino };
      const projectDirectory = projectStorageDirectory(store.paths, root);
      if (target !== join(projectDirectory, "codebase", "snapshots", entry.workspace_id, entry.id)
        || ensureProjectStorageDirectory(store.paths, root) !== projectDirectory) {
        throw new Error("project_mapping_changed");
      }
      const allowedSources = [join(root, ".craft_data", "codebase", "snapshots", entry.workspace_id, entry.id),
        join(root, ".craft_data", "codebase", "runtime", "workspaces", entry.workspace_id, "snapshots", entry.id),
        join(store.paths.runtimeDir, "workspaces", entry.workspace_id, "snapshots", entry.id)];
      if (!allowedSources.some(source => canonicalCandidatePath(source) === canonicalCandidatePath(entry.source_root))) {
        throw new Error("source_snapshot_out_of_scope");
      }
      const sourceStat = lstatSync(entry.source_root);
      if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) throw new Error("source_snapshot_unsafe");
      const tree = snapshotTree(entry.source_root);
      const declared = new Set((payload.entries as SnapshotFile[]).map(file => file.path.replaceAll("\\", "/")));
      if (declared.size !== payload.entries.length || tree.files.size !== declared.size
        || [...tree.files].some(path => !declared.has(path))) throw new Error("snapshot_manifest_mismatch");
      let currentDirectory = projectDirectory;
      for (const part of ["codebase", "snapshots", entry.workspace_id, entry.id]) {
        currentDirectory = join(currentDirectory, part); regularDirectory(currentDirectory);
      }
      for (const directory of tree.directories) {
        safeTargetDirectory(target, join(directory, "__directory__"));
      }
      for (const file of payload.entries as SnapshotFile[]) {
        if (!file || typeof file.path !== "string" || !/^[a-f0-9]{64}$/u.test(file.digest)
          || !Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0) throw new Error("entry_invalid");
        const sourceFile = checkedFile(entry.source_root, file.path);
        let copySource = sourceFile;
        const sourceSizeMatches = lstatSync(sourceFile).size === file.size_bytes;
        if (!sourceSizeMatches && !options.recover_verified_peer) throw new Error("source_size_changed");
        if (options.recover_verified_peer && (!sourceSizeMatches || await fileDigest(sourceFile) !== file.digest)) {
          const peer = await verifiedPeer(store.database, store.paths, root, entry.id, file);
          const git = peer ? null : await verifiedGitHistory(root, file, backupDirectory);
          if (!peer && !git) throw new Error("verified_source_unavailable");
          copySource = (peer ?? git)!.path;
          if (peer) peerSnapshots.push({ id: peer.workspace_id, snapshot: peer.workspace_snapshot });
          pendingRecovered.push({ id: entry.id, path: file.path, from_checkpoint_id: peer?.checkpoint_id ?? null,
            from_git_commit: git?.commit ?? null, digest: file.digest });
        }
        safeTargetDirectory(target, file.path);
        const targetFile = join(target, file.path);
        if (!existsSync(targetFile)) {
          const temporary = join(dirname(targetFile), `.${basename(targetFile)}.${randomUUID()}.tmp`);
          try {
            copyFileSync(copySource, temporary, constants.COPYFILE_EXCL);
            if (lstatSync(temporary).size !== file.size_bytes || await fileDigest(temporary) !== file.digest) {
              throw new Error("source_digest_changed");
            }
            try { linkSync(temporary, targetFile); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
          } finally { if (existsSync(temporary)) unlinkSync(temporary); }
        }
        const targetStat = lstatSync(targetFile);
        if (targetStat.isSymbolicLink() || !targetStat.isFile() || targetStat.size !== file.size_bytes
          || await fileDigest(targetFile) !== file.digest) throw new Error("target_digest_conflict");
      }
      if (pendingRecovered.length) {
        const receiptPath = join(backupDirectory, `recovery-${entry.id}-v${entry.version}.json`);
        const receipt = `${JSON.stringify({ schema: "craft.codebase-recovery.v1", checkpoint_id: entry.id,
          checkpoint_version: entry.version, original_payload_sha256: createHash("sha256").update(row.payload_json).digest("hex"),
          source_root: entry.source_root, target_root: target, recovered: pendingRecovered })}\n`;
        if (existsSync(receiptPath)) {
          const stat = lstatSync(receiptPath);
          if (stat.isSymbolicLink() || !stat.isFile() || readFileSync(receiptPath, "utf8") !== receipt) {
            throw new Error("recovery_receipt_conflict");
          }
        } else writeFileSync(receiptPath, receipt, { mode: 0o600, flag: "wx" });
      }
      const next = JSON.stringify({ ...payload, snapshot_root: target });
      const changed = await updateCheckpointWithRetry(store.database, entry, row.payload_json, next, workspaceSnapshot, JSON.stringify(peerSnapshots), root, rootIdentity);
      if (changed === 1) { migrated++; recovered.push(...pendingRecovered); }
      else {
        const currentWorkspace = (store.database.prepare("SELECT json_group_array(payload_json) AS snapshot FROM (SELECT payload_json FROM records WHERE kind='workspace' AND id=? ORDER BY version)")
          .get(entry.workspace_id) as { snapshot: string }).snapshot;
        if (currentWorkspace !== workspaceSnapshot) throw new Error("workspace_changed_concurrently");
        for (const peer of peerSnapshots) {
          const current = (store.database.prepare("SELECT json_group_array(payload_json) AS snapshot FROM (SELECT payload_json FROM records WHERE kind='workspace' AND id=? ORDER BY version)")
            .get(peer.id) as { snapshot: string }).snapshot;
          if (current !== peer.snapshot) throw new Error("peer_workspace_changed_concurrently");
        }
        const latest = store.database.prepare("SELECT payload_json FROM records WHERE kind='workspace_checkpoint' AND id=? AND version=?")
          .get(entry.id, entry.version) as { payload_json: string } | undefined;
        if (latest?.payload_json !== next) throw new Error("checkpoint_changed_concurrently");
        alreadyCurrent++;
      }
    } catch (error) {
      blocked.push({ id: entry.id, version: entry.version, reason: error instanceof Error ? error.message : "migration_failed" });
    }
    options.on_progress?.(index + 1, entries.length);
  }
  return { migrated, already_current: alreadyCurrent, blocked, recovered, backup_directory: backupDirectory };
}
