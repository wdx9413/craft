import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { CraftStore, type JsonObject } from "./store.ts";

type Entry = { path: string; digest: string; size_bytes: number };

function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function fileDigest(path: string): string { return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`; }
function relativePath(value: unknown, name: string): string { const item = text(value, name).replaceAll("\\", "/"); if (isAbsolute(item) || item.split("/").includes("..")) throw new Error(`${name} must be relative to the workspace`); return item.replace(/^\.\//, "") || "."; }
function nested(root: string, path: string): string { const target = resolve(root, path);
  /* node:coverage ignore next */
  if (relative(root, target).startsWith("..")) throw new Error("workspace state path escapes root");
  return target;
}
function kind(stat: Pick<Stats, "isFile" | "isDirectory">, path: string): "file" | "directory" { if (stat.isFile()) return "file"; if (stat.isDirectory()) return "directory"; throw new Error(`state adapters support regular files only: ${path}`); }
function files(root: string, path: string): Entry[] {
  const target = nested(root, path); if (!existsSync(target)) return [];
  const stat = lstatSync(target); if (stat.isSymbolicLink()) throw new Error(`state adapters do not follow symbolic links: ${path}`);
  if (kind(stat, path) === "file") return [{ path, digest: fileDigest(target), size_bytes: stat.size }];
  return readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => files(root, join(path, entry.name).replaceAll("\\", "/")));
}

/**
 * Produces content-free observations of a declared Workspace. Adapters differ
 * only in their selection policy; the immutable snapshot receipt is uniform.
 */
export class StateWorkspaceKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  observe(args: JsonObject): JsonObject {
    const workspace = this.store.get("workspace", text(args.workspace_id, "workspace_id"));
    const adapter = args.adapter === undefined ? "file_tree" : text(args.adapter, "adapter");
    if (!["file_tree", "file_artifact"].includes(adapter)) throw new Error("State Workspace adapter is unsupported");
    const root = text(workspace.root_path, "workspace.root_path");
    const paths = adapter === "file_tree"
      ? (workspace.include_paths as unknown[]).map((item) => relativePath(item, "workspace.include_paths")).sort()
      : ((args.paths as unknown[] | undefined) ?? []).map((item) => relativePath(item, "paths")).sort();
    if (!paths.length) throw new Error("file_artifact observation requires at least one declared path");
    if (new Set(paths).size !== paths.length) throw new Error("State Workspace paths must be unique");
    const entries = paths.flatMap((path) => files(root, path)).sort((a, b) => a.path.localeCompare(b.path));
    if (new Set(entries.map((item) => item.path)).size !== entries.length) throw new Error("State Workspace paths must not overlap");
    const artifactIds = args.artifact_ids === undefined ? [] : (args.artifact_ids as unknown[]).map((item) => text(item, "artifact_ids"));
    for (const artifactId of artifactIds) this.store.get("artifact", artifactId);
    const identity = { workspace_id: workspace.id, workspace_version: workspace.version, workspace_state_revision: workspace.state_revision, adapter, paths, entries, artifact_ids: artifactIds };
    const snapshotId = String(args.snapshot_id ?? `state_snapshot_${workspace.id}_${digest(identity).slice(-16)}`); const existing = this.store.find("state_snapshot", snapshotId); const snapshotDigest = digest(identity);
    if (existing) { if (existing.snapshot_digest !== snapshotDigest) throw new Error("State Snapshot idempotency conflict"); return { snapshot: existing, idempotent: true }; }
    return { snapshot: this.store.create("state_snapshot", snapshotId, { ...identity, snapshot_digest: snapshotDigest }), idempotent: false };
  }

  compare(args: JsonObject): JsonObject {
    const before = this.store.get("state_snapshot", text(args.before_snapshot_id, "before_snapshot_id")); const after = this.store.get("state_snapshot", text(args.after_snapshot_id, "after_snapshot_id"));
    if (before.workspace_id !== after.workspace_id) throw new Error("State Snapshots must belong to one workspace");
    const left = new Map((before.entries as Entry[]).map((entry) => [entry.path, entry])); const right = new Map((after.entries as Entry[]).map((entry) => [entry.path, entry]));
    const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
    return { difference: { workspace_id: before.workspace_id, before_snapshot_id: before.id, after_snapshot_id: after.id,
      added_paths: paths.filter((path) => !left.has(path)), deleted_paths: paths.filter((path) => !right.has(path)), modified_paths: paths.filter((path) => left.has(path) && right.has(path) && left.get(path)!.digest !== right.get(path)!.digest),
      changed: before.snapshot_digest !== after.snapshot_digest } };
  }
}
