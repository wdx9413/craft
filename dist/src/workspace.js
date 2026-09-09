import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CraftStore } from "./store.js";
function identifier(value, name, prefix) {
    const result = value === undefined ? `${prefix}_${randomUUID().replaceAll("-", "")}` : String(value).trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(result))
        throw new Error(`${name} must contain only letters, numbers, _ or -`);
    return result;
}
function requiredText(value, name) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${name} must not be empty`);
    return value.trim();
}
function recordPayload(record) {
    const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...payload } = record;
    return payload;
}
function relativePath(value, name) {
    const path = requiredText(value, name);
    if (isAbsolute(path) || path.split(/[\\/]+/).includes(".."))
        throw new Error(`${name} must be a relative path within the workspace`);
    return path === "." ? path : path.replaceAll("\\", "/").replace(/^\.\//, "");
}
function includePaths(value) {
    if (!Array.isArray(value) || !value.length)
        throw new Error("include_paths must contain at least one relative path");
    const paths = value.map((item) => relativePath(item, "include_paths"));
    if (new Set(paths).size !== paths.length)
        throw new Error("include_paths must be unique");
    return paths.sort();
}
function nested(root, path) {
    const target = resolve(root, path);
    if (relative(root, target).startsWith("..") || relative(root, target) === "") {
        if (target !== root)
            throw new Error("workspace path escapes root");
    }
    return target;
}
function digest(path) {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}
export function snapshotNodeKind(stat, path) {
    if (stat.isFile())
        return "file";
    if (stat.isDirectory())
        return "directory";
    throw new Error(`workspace snapshots support regular files only: ${path}`);
}
function files(root, path) {
    const absolute = nested(root, path);
    if (!existsSync(absolute))
        return [];
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink())
        throw new Error(`workspace snapshots do not follow symbolic links: ${path}`);
    if (snapshotNodeKind(stat, path) === "file")
        return [{ path, digest: digest(absolute), size_bytes: stat.size }];
    return readdirSync(absolute, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))
        .flatMap((entry) => files(root, join(path, entry.name).replaceAll("\\", "/")));
}
function copyEntries(root, snapshotRoot, entries) {
    for (const entry of entries) {
        const source = nested(root, entry.path);
        const target = nested(snapshotRoot, entry.path);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        copyFileSync(source, target);
    }
}
export class WorkspaceState {
    store;
    paths;
    constructor(store, paths) { this.store = store; this.paths = paths; }
    open(args) {
        const workspaceId = identifier(args.workspace_id, "workspace_id", "workspace");
        const rootPath = resolve(requiredText(args.root_path, "root_path"));
        if (!existsSync(rootPath) || !lstatSync(rootPath).isDirectory())
            throw new Error("root_path must exist and be a directory");
        const includes = includePaths(args.include_paths);
        const workspace = this.store.create("workspace", workspaceId, { name: requiredText(args.name, "name"), root_path: rootPath,
            include_paths: includes, git_baseline_ref: args.git_baseline_ref === undefined ? null : requiredText(args.git_baseline_ref, "git_baseline_ref"),
            state_revision: 1, latest_checkpoint_id: null });
        return { workspace, checkpoints: [], changes: [] };
    }
    get(args) {
        const workspaceId = identifier(args.workspace_id, "workspace_id", "workspace");
        return { workspace: this.store.get("workspace", workspaceId), checkpoints: this.checkpoints(workspaceId), changes: this.changes(workspaceId) };
    }
    checkpoint(args) {
        const workspaceId = identifier(args.workspace_id, "workspace_id", "workspace");
        const workspace = this.store.get("workspace", workspaceId);
        const checkpointId = identifier(args.checkpoint_id, "checkpoint_id", "workspace_checkpoint");
        const snapshotRoot = join(this.paths.runtimeDir, "workspaces", workspaceId, "snapshots", checkpointId);
        const root = requiredText(workspace.root_path, "workspace.root_path");
        const entries = workspace.include_paths.flatMap((path) => files(root, path)).sort((left, right) => left.path.localeCompare(right.path));
        if (new Set(entries.map((entry) => entry.path)).size !== entries.length)
            throw new Error("include_paths must not overlap");
        copyEntries(root, snapshotRoot, entries);
        const checkpoint = this.store.create("workspace_checkpoint", checkpointId, { workspace_id: workspaceId,
            label: requiredText(args.label, "label"), snapshot_root: snapshotRoot, entries,
            state_revision: workspace.state_revision, artifact_ids: args.artifact_ids ?? [], evidence_ids: args.evidence_ids ?? [] });
        const saved = this.store.save("workspace", workspaceId, { ...recordPayload(workspace), latest_checkpoint_id: checkpointId });
        return { workspace: saved, checkpoint };
    }
    diff(args) {
        const workspaceId = identifier(args.workspace_id, "workspace_id", "workspace");
        const from = this.checkpointFor(workspaceId, identifier(args.from_checkpoint_id, "from_checkpoint_id", "workspace_checkpoint"));
        const to = this.checkpointFor(workspaceId, identifier(args.to_checkpoint_id, "to_checkpoint_id", "workspace_checkpoint"));
        const before = new Map(from.entries.map((entry) => [entry.path, entry]));
        const after = new Map(to.entries.map((entry) => [entry.path, entry]));
        const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
        const added_paths = paths.filter((path) => !before.has(path));
        const deleted_paths = paths.filter((path) => !after.has(path));
        const modified_paths = paths.filter((path) => before.has(path) && after.has(path) && before.get(path).digest !== after.get(path).digest);
        return { diff: { workspace_id: workspaceId, from_checkpoint_id: from.id, to_checkpoint_id: to.id, added_paths, deleted_paths, modified_paths } };
    }
    humanChange(args) {
        const workspaceId = identifier(args.workspace_id, "workspace_id", "workspace");
        const workspace = this.store.get("workspace", workspaceId);
        const affected = Array.isArray(args.affected_paths) ? args.affected_paths.map((path) => relativePath(path, "affected_paths")) : [];
        const change = this.store.create("workspace_change", identifier(args.change_id, "change_id", "workspace_change"), { workspace_id: workspaceId,
            summary: requiredText(args.summary, "summary"), affected_paths: affected, source: args.source ?? "human", previous_checkpoint_id: workspace.latest_checkpoint_id });
        const saved = this.store.save("workspace", workspaceId, { ...recordPayload(workspace), state_revision: Number(workspace.state_revision) + 1,
            latest_human_change_id: change.id });
        return { workspace: saved, change };
    }
    restore(args) {
        if (args.approved !== true)
            throw new Error("workspace restore requires approved=true");
        const workspaceId = identifier(args.workspace_id, "workspace_id", "workspace");
        const workspace = this.store.get("workspace", workspaceId);
        const checkpoint = this.checkpointFor(workspaceId, identifier(args.checkpoint_id, "checkpoint_id", "workspace_checkpoint"));
        const root = requiredText(workspace.root_path, "workspace.root_path");
        const includes = workspace.include_paths;
        if (includes.includes("."))
            throw new Error("workspace restore cannot replace the workspace root");
        for (const path of includes)
            rmSync(nested(root, path), { recursive: true, force: true });
        copyEntries(requiredText(checkpoint.snapshot_root, "checkpoint.snapshot_root"), root, checkpoint.entries);
        const saved = this.store.save("workspace", workspaceId, { ...recordPayload(workspace), latest_checkpoint_id: checkpoint.id,
            restored_checkpoint_id: checkpoint.id, state_revision: Number(workspace.state_revision) + 1 });
        return { workspace: saved, checkpoint };
    }
    checkpointFor(workspaceId, checkpointId) {
        const checkpoint = this.store.get("workspace_checkpoint", checkpointId);
        if (checkpoint.workspace_id !== workspaceId)
            throw new Error("workspace checkpoint does not belong to workspace");
        return checkpoint;
    }
    checkpoints(workspaceId) { return this.store.list("workspace_checkpoint", 1_000, (item) => item.workspace_id === workspaceId); }
    changes(workspaceId) { return this.store.list("workspace_change", 1_000, (item) => item.workspace_id === workspaceId); }
}
//# sourceMappingURL=workspace.js.map