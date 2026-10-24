import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ensureProjectStorageDirectory, type CraftPaths } from "./infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { readRepositoryState, sameRepositoryState, type RepositoryState } from "./workspace-repository-state.ts";

type SnapshotEntry = { path: string; digest: string; size_bytes: number; file_version?: string };
const snapshotFileVersion = (stat: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">): string =>
  [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");

function identifier(value: unknown, name: string, prefix: string): string {
  const result = value === undefined ? `${prefix}_${randomUUID().replaceAll("-", "")}` : String(value).trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new Error(`${name} must contain only letters, numbers, _ or -`);
  return result;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}

function recordPayload(record: JsonObject): JsonObject {
  const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...payload } = record;
  return payload;
}

function relativePath(value: unknown, name: string): string {
  const path = requiredText(value, name);
  if (isAbsolute(path) || path.split(/[\\/]+/).includes("..")) throw new Error(`${name} must be a relative path within the workspace`);
  return path === "." ? path : path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function includePaths(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length) throw new Error("include_paths must contain at least one relative path");
  const paths = value.map((item) => relativePath(item, "include_paths"));
  if (new Set(paths).size !== paths.length) throw new Error("include_paths must be unique");
  return paths.sort();
}

function nested(root: string, path: string): string {
  const target = resolve(root, path);
  if (relative(root, target).startsWith("..") || relative(root, target) === "") {
    if (target !== root) throw new Error("workspace path escapes root");
  }
  return target;
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function snapshotStatIfPresent(path: string): Stats | undefined {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export function snapshotNodeKind(stat: Pick<Stats, "isFile" | "isDirectory">, path: string): "file" | "directory" {
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  throw new Error(`workspace snapshots support regular files only: ${path}`);
}

function files(root: string, path: string, knownEntries?: ReadonlyMap<string, SnapshotEntry>): SnapshotEntry[] {
  const absolute = nested(root, path);
  if (!existsSync(absolute)) return [];
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error(`workspace snapshots do not follow symbolic links: ${path}`);
  if (snapshotNodeKind(stat, path) === "file") {
    const fileVersion = snapshotFileVersion(stat);
    const previous = knownEntries?.get(path);
    return [{ path, digest: previous?.file_version === fileVersion ? previous.digest : digest(absolute), size_bytes: stat.size, file_version: fileVersion }];
  }
  return readdirSync(absolute, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => files(root, join(path, entry.name).replaceAll("\\", "/"), knownEntries));
}

function snapshotTarget(snapshotRoot: string, entry: SnapshotEntry): string {
  const target = nested(snapshotRoot, entry.path), relativeParent = relative(snapshotRoot, dirname(target));
  let current = snapshotRoot;
  if (relativeParent !== "") for (const part of relativeParent.split(/[\\/]+/)) {
    current = join(current, part);
    if (!snapshotStatIfPresent(current)) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`workspace snapshot destination is unsafe: ${entry.path}`);
  }
  const targetStat = snapshotStatIfPresent(target);
  if (targetStat && (targetStat.isSymbolicLink() || !targetStat.isFile()))
    throw new Error(`workspace snapshot destination is unsafe: ${entry.path}`);
  return target;
}

function copyEntries(root: string, snapshotRoot: string, entries: SnapshotEntry[]): void {
  for (const entry of entries) copyFileSync(nested(root, entry.path), snapshotTarget(snapshotRoot, entry));
}

function writeSnapshotEntries(snapshotRoot: string, entries: SnapshotEntry[], contents: ReadonlyMap<string, string>): void {
  for (const entry of entries) writeFileSync(snapshotTarget(snapshotRoot, entry), contents.get(entry.path)!, { mode: 0o600 });
}

function projectCodebaseSnapshotRoot(paths: CraftPaths, root: string, workspaceId: string, checkpointId: string): string {
  let current = ensureProjectStorageDirectory(paths, root);
  for (const part of ["codebase", "snapshots", workspaceId, checkpointId]) {
    current = join(current, part);
    if (!snapshotStatIfPresent(current)) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("project Codebase snapshot path contains an unsafe directory");
  }
  return current;
}

export class WorkspaceState {
  readonly store: CraftStore;
  readonly paths: CraftPaths;
  private readonly readRepositoryState: (root: string) => RepositoryState | undefined;
  constructor(store: CraftStore, paths: CraftPaths, repositoryStateReader = readRepositoryState) {
    this.store = store; this.paths = paths; this.readRepositoryState = repositoryStateReader;
  }

  open(args: JsonObject): JsonObject {
    const workspaceId = identifier(args.workspace_id, "workspace_id", "workspace");
    const rootPath = resolve(requiredText(args.root_path, "root_path"));
    if (!existsSync(rootPath) || !lstatSync(rootPath).isDirectory()) throw new Error("root_path must exist and be a directory");
    const includes = includePaths(args.include_paths);
    const snapshotStorage = args.snapshot_storage ?? "project_codebase";
    if (snapshotStorage !== "project_codebase") throw new Error("snapshot_storage must be project_codebase for new workspaces");
    const workspace = this.store.create("workspace", workspaceId, { name: requiredText(args.name, "name"), root_path: rootPath,
      include_paths: includes, git_baseline_ref: args.git_baseline_ref === undefined ? null : requiredText(args.git_baseline_ref, "git_baseline_ref"),
      snapshot_storage: snapshotStorage, state_revision: 1, latest_checkpoint_id: null });
    return { workspace, checkpoints: [], changes: [] };
  }

  get(args: JsonObject): JsonObject {
    const workspaceId = identifier(args.workspace_id, "workspace_id", "workspace");
    return { workspace: this.store.get("workspace", workspaceId), checkpoints: this.checkpoints(workspaceId), changes: this.changes(workspaceId) };
  }

  /** Read only the declared paths; never infer freshness from a checkpoint id. */
  freshness(args: JsonObject): JsonObject {
    const workspace = this.store.get("workspace", identifier(args.workspace_id, "workspace_id", "workspace"));
    if (!workspace.latest_checkpoint_id) return { status: "unavailable", reason: "checkpoint_required", changed_paths: [] };
    const checkpoint = this.checkpointFor(String(workspace.id), String(workspace.latest_checkpoint_id));
    const repositoryStateBefore = this.readRepositoryState(String(workspace.root_path));
    const before = new Map((checkpoint.entries as SnapshotEntry[]).map((entry) => [entry.path, entry]));
    const entries = (workspace.include_paths as string[]).flatMap((path) => files(String(workspace.root_path), path, before));
    const repositoryStateAfter = this.readRepositoryState(String(workspace.root_path));
    const repositoryChanged = !sameRepositoryState(repositoryStateBefore, repositoryStateAfter)
      || !sameRepositoryState(repositoryStateAfter, checkpoint.repository_state);
    const after = new Map(entries.map((entry) => [entry.path, entry.digest]));
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path)?.digest !== after.get(path)).sort();
    return { workspace_id: workspace.id, checkpoint_id: checkpoint.id, status: changed.length || repositoryChanged ? "changed" : "current",
      changed_paths: changed, ...(repositoryChanged ? { repository_state_changed: true } : {}) };
  }

  checkpoint(args: JsonObject): JsonObject {
    const workspaceId = identifier(args.workspace_id, "workspace_id", "workspace");
    const workspace = this.store.get("workspace", workspaceId);
    const checkpointId = identifier(args.checkpoint_id, "checkpoint_id", "workspace_checkpoint");
    const root = requiredText(workspace.root_path, "workspace.root_path");
    const repositoryStateBefore = this.readRepositoryState(root);
    const snapshotRoot = projectCodebaseSnapshotRoot(this.paths, root, workspaceId, checkpointId);
    const entries = (workspace.include_paths as string[]).flatMap((path) => files(root, path)).sort((left, right) => left.path.localeCompare(right.path));
    if (new Set(entries.map((entry) => entry.path)).size !== entries.length) throw new Error("include_paths must not overlap");
    mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
    copyEntries(root, snapshotRoot, entries);
    const repositoryStateAfter = this.readRepositoryState(root);
    if (!sameRepositoryState(repositoryStateBefore, repositoryStateAfter)) throw new Error("Git repository state changed during workspace checkpoint");
    const checkpoint = this.store.create("workspace_checkpoint", checkpointId, { workspace_id: workspaceId,
      label: requiredText(args.label, "label"), snapshot_root: snapshotRoot, entries,
      ...(repositoryStateAfter ? { repository_state: repositoryStateAfter } : {}),
      state_revision: workspace.state_revision, artifact_ids: args.artifact_ids ?? [], evidence_ids: args.evidence_ids ?? [] });
    const saved = this.store.save("workspace", workspaceId, { ...recordPayload(workspace), snapshot_storage: "project_codebase", latest_checkpoint_id: checkpointId });
    return { workspace: saved, checkpoint };
  }

  checkpointFromRepositoryFiles(args: JsonObject): JsonObject {
    const workspaceId = identifier(args.workspace_id, "workspace_id", "workspace");
    const workspace = this.store.get("workspace", workspaceId);
    const root = requiredText(workspace.root_path, "workspace.root_path");
    const sourceFiles = args.repository_files;
    if (!Array.isArray(sourceFiles) || sourceFiles.some(file => !file || typeof file !== "object" || Array.isArray(file)))
      throw new Error("repository_files must be an array of source files");
    const includePaths = workspace.include_paths as string[];
    const byPath = new Map<string, { path: string; content: string; digest: string; file_version: string }>();
    for (const value of sourceFiles as JsonObject[]) {
      const path = requiredText(value.path, "repository_file.path"), content = value.content, digestValue = value.digest, version = value.file_version;
      if (typeof content !== "string" || typeof digestValue !== "string" || !/^[a-f0-9]{64}$/u.test(digestValue)
        || typeof version !== "string" || byPath.has(path)) throw new Error("repository_files contains invalid or duplicate entries");
      if (!includePaths.includes(path) || createHash("sha256").update(content).digest("hex") !== digestValue)
        throw new Error(`repository file does not match the workspace selection: ${path}`);
      const source = nested(root, path), stat = lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink() || snapshotFileVersion(stat) !== version || stat.size !== Buffer.byteLength(content))
        throw new Error(`repository source changed before snapshot: ${path}`);
      byPath.set(path, { path, content, digest: digestValue, file_version: version });
    }
    if (byPath.size !== includePaths.length || includePaths.some(path => !byPath.has(path)))
      throw new Error("repository_files must match the workspace selection");

    const checkpointId = identifier(args.checkpoint_id, "checkpoint_id", "workspace_checkpoint");
    const repositoryStateBefore = this.readRepositoryState(root);
    const snapshotRoot = projectCodebaseSnapshotRoot(this.paths, root, workspaceId, checkpointId);
    const entries = [...byPath.values()].map(file => ({ path: file.path, digest: file.digest,
      size_bytes: Buffer.byteLength(file.content), file_version: file.file_version }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const label = requiredText(args.label, "label");
    mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
    writeSnapshotEntries(snapshotRoot, entries, new Map([...byPath].map(([path, file]) => [path, file.content])));
    const repositoryStateAfter = this.readRepositoryState(root);
    for (const entry of entries) {
      const file = byPath.get(entry.path)!, stat = lstatSync(nested(root, entry.path));
      if (!stat.isFile() || stat.isSymbolicLink() || snapshotFileVersion(stat) !== file.file_version)
        throw new Error(`repository source changed during snapshot: ${entry.path}`);
    }
    if (!sameRepositoryState(repositoryStateBefore, repositoryStateAfter)) throw new Error("Git repository state changed during workspace checkpoint");
    const checkpoint = this.store.create("workspace_checkpoint", checkpointId, { workspace_id: workspaceId, label,
      snapshot_root: snapshotRoot, entries, ...(repositoryStateAfter ? { repository_state: repositoryStateAfter } : {}),
      state_revision: workspace.state_revision, artifact_ids: args.artifact_ids ?? [], evidence_ids: args.evidence_ids ?? [] });
    const saved = this.store.save("workspace", workspaceId, { ...recordPayload(workspace), snapshot_storage: "project_codebase", latest_checkpoint_id: checkpointId });
    return { workspace: saved, checkpoint };
  }

  diff(args: JsonObject): JsonObject {
    const workspaceId = identifier(args.workspace_id, "workspace_id", "workspace");
    const from = this.checkpointFor(workspaceId, identifier(args.from_checkpoint_id, "from_checkpoint_id", "workspace_checkpoint"));
    const to = this.checkpointFor(workspaceId, identifier(args.to_checkpoint_id, "to_checkpoint_id", "workspace_checkpoint"));
    const before = new Map((from.entries as SnapshotEntry[]).map((entry) => [entry.path, entry]));
    const after = new Map((to.entries as SnapshotEntry[]).map((entry) => [entry.path, entry]));
    const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
    const added_paths = paths.filter((path) => !before.has(path));
    const deleted_paths = paths.filter((path) => !after.has(path));
    const modified_paths = paths.filter((path) => before.has(path) && after.has(path) && before.get(path)!.digest !== after.get(path)!.digest);
    return { diff: { workspace_id: workspaceId, from_checkpoint_id: from.id, to_checkpoint_id: to.id, added_paths, deleted_paths, modified_paths } };
  }

  humanChange(args: JsonObject): JsonObject {
    const workspaceId = identifier(args.workspace_id, "workspace_id", "workspace");
    const workspace = this.store.get("workspace", workspaceId);
    const affected = Array.isArray(args.affected_paths) ? args.affected_paths.map((path) => relativePath(path, "affected_paths")) : [];
    const change = this.store.create("workspace_change", identifier(args.change_id, "change_id", "workspace_change"), { workspace_id: workspaceId,
      summary: requiredText(args.summary, "summary"), affected_paths: affected, source: args.source ?? "human", previous_checkpoint_id: workspace.latest_checkpoint_id });
    const saved = this.store.save("workspace", workspaceId, { ...recordPayload(workspace), state_revision: Number(workspace.state_revision) + 1,
      latest_human_change_id: change.id });
    return { workspace: saved, change };
  }

  restore(args: JsonObject): JsonObject {
    if (args.approved !== true) throw new Error("workspace restore requires approved=true");
    const workspaceId = identifier(args.workspace_id, "workspace_id", "workspace");
    const workspace = this.store.get("workspace", workspaceId);
    const checkpoint = this.checkpointFor(workspaceId, identifier(args.checkpoint_id, "checkpoint_id", "workspace_checkpoint"));
    const root = requiredText(workspace.root_path, "workspace.root_path");
    const includes = workspace.include_paths as string[];
    if (includes.includes(".")) throw new Error("workspace restore cannot replace the workspace root");
    for (const path of includes) rmSync(nested(root, path), { recursive: true, force: true });
    copyEntries(requiredText(checkpoint.snapshot_root, "checkpoint.snapshot_root"), root, checkpoint.entries as SnapshotEntry[]);
    const saved = this.store.save("workspace", workspaceId, { ...recordPayload(workspace), latest_checkpoint_id: checkpoint.id,
      restored_checkpoint_id: checkpoint.id, state_revision: Number(workspace.state_revision) + 1 });
    return { workspace: saved, checkpoint };
  }

  private checkpointFor(workspaceId: string, checkpointId: string): JsonObject {
    const checkpoint = this.store.get("workspace_checkpoint", checkpointId);
    if (checkpoint.workspace_id !== workspaceId) throw new Error("workspace checkpoint does not belong to workspace");
    return checkpoint;
  }

  private checkpoints(workspaceId: string): JsonObject[] { return this.store.list("workspace_checkpoint", 1_000, (item) => item.workspace_id === workspaceId); }
  private changes(workspaceId: string): JsonObject[] { return this.store.list("workspace_change", 1_000, (item) => item.workspace_id === workspaceId); }
}
