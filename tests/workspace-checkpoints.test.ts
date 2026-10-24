import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { McpServer } from "../core/mcp.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths, ensureProjectStorageDirectory, projectStorageDirectory } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import type { RepositoryState } from "../core/workspace-repository-state.ts";
import { WorkspaceState, snapshotNodeKind, snapshotStatIfPresent } from "../core/workspace.ts";

test("workspace checkpoints preserve a file-state timeline and require approval to restore", async () => {
  const root = join(tmpdir(), `craft-workspace-${process.pid}-${Date.now()}`);
  const worktree = join(root, "worktree");
  const store = await new CraftStore(craftPaths(join(root, "craft"))).open();
  const service = new CraftService(store);
  try {
    await mkdir(join(worktree, "src"), { recursive: true });
    await writeFile(join(worktree, "src", "note.txt"), "before\n", "utf8");
    const opened = service.workspaceOpen({ workspace_id: "workspace", name: "Demo", root_path: worktree,
      git_baseline_ref: "main@abc", include_paths: ["src"] });
    assert.equal((opened.workspace as JsonObject).git_baseline_ref, "main@abc");
    const baseline = service.workspaceCheckpoint({ workspace_id: "workspace", label: "before-change" }).checkpoint as JsonObject;
    await writeFile(join(worktree, "src", "note.txt"), "after\n", "utf8");
    const changed = service.workspaceCheckpoint({ workspace_id: "workspace", label: "after-change" }).checkpoint as JsonObject;
    const diff = service.workspaceDiff({ workspace_id: "workspace", from_checkpoint_id: baseline.id,
      to_checkpoint_id: changed.id }).diff as JsonObject;
    assert.deepEqual(diff.modified_paths, ["src/note.txt"]);

    const human = service.workspaceHumanChange({ workspace_id: "workspace", summary: "human adjusted the note",
      affected_paths: ["src/note.txt"] }).workspace as JsonObject;
    assert.equal(human.state_revision, 2);
    assert.equal((service.workspaceGet({ workspace_id: "workspace" }).changes as JsonObject[]).length, 1);
    assert.throws(() => service.workspaceRestore({ workspace_id: "workspace", checkpoint_id: baseline.id }), /approved/);
    const restored = service.workspaceRestore({ workspace_id: "workspace", checkpoint_id: baseline.id, approved: true });
    assert.equal((restored.workspace as JsonObject).latest_checkpoint_id, baseline.id);
    assert.equal(await readFile(join(worktree, "src", "note.txt"), "utf8"), "before\n");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("rejects workspace roots, paths, and snapshots that escape the declared file tree", async () => {
  const root = join(tmpdir(), `craft-workspace-boundary-${process.pid}-${Date.now()}`);
  const worktree = join(root, "worktree");
  const store = await new CraftStore(craftPaths(join(root, "craft"))).open();
  const service = new CraftService(store);
  try {
    await mkdir(worktree, { recursive: true });
    assert.throws(() => service.workspaceOpen({ name: "bad", root_path: join(root, "missing"), include_paths: ["."] }), /must exist/);
    await writeFile(join(root, "not-a-directory"), "x", "utf8");
    assert.throws(() => service.workspaceOpen({ name: "file", root_path: join(root, "not-a-directory"), include_paths: ["."] }), /directory/);
    assert.throws(() => service.workspaceOpen({ name: "empty", root_path: worktree, include_paths: [] }), /at least one/);
    assert.throws(() => service.workspaceOpen({ name: "array", root_path: worktree, include_paths: "src" }), /at least one/);
    assert.throws(() => service.workspaceOpen({ workspace_id: "not valid", name: "id", root_path: worktree, include_paths: ["."] }), /letters, numbers/);
    assert.throws(() => service.workspaceOpen({ workspace_id: "blank", name: " ", root_path: worktree, include_paths: ["."] }), /must not be empty/);
    assert.throws(() => service.workspaceOpen({ workspace_id: "duplicate", name: "Duplicate", root_path: worktree, include_paths: ["src", "src"] }), /must be unique/);
    service.workspaceOpen({ workspace_id: "safe", name: "Safe", root_path: worktree, include_paths: ["."] });
    assert.throws(() => service.workspaceOpen({ workspace_id: "unsafe", name: "Unsafe", root_path: worktree,
      include_paths: ["../outside"] }), /relative path/);
    assert.throws(() => service.workspaceOpen({ workspace_id: "absolute", name: "Absolute", root_path: worktree,
      include_paths: [root] }), /relative path/);
    assert.throws(() => service.workspaceHumanChange({ workspace_id: "safe", summary: "bad", affected_paths: ["../outside"] }), /relative path/);
    assert.throws(() => service.workspaceDiff({ workspace_id: "safe", from_checkpoint_id: "none", to_checkpoint_id: "none" }), /Unknown workspace_checkpoint/);
    store.create("workspace", "corrupt", { name: "Corrupt", root_path: worktree, include_paths: ["../outside"], state_revision: 1 });
    assert.throws(() => service.workspaceCheckpoint({ workspace_id: "corrupt", label: "corrupt" }), /escapes root/);
    assert.throws(() => service.workspaceOpen({ workspace_id: "bad-storage", name: "Bad storage", root_path: worktree,
      include_paths: ["."], snapshot_storage: "external" }), /snapshot_storage/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("repository checkpoints store project Codebase snapshots under the ignored project data root", async () => {
  const root = join(tmpdir(), `craft-workspace-project-snapshot-${process.pid}-${Date.now()}`);
  const worktree = join(root, "worktree");
  const store = await new CraftStore(craftPaths(join(root, "craft"))).open();
  const service = new CraftService(store);
  try {
    await mkdir(join(worktree, "src"), { recursive: true });
    await writeFile(join(worktree, "src", "note.txt"), "project snapshot\n", "utf8");
    service.workspaceOpen({ workspace_id: "repository_demo", name: "Repository", root_path: worktree,
      include_paths: ["src"], snapshot_storage: "project_codebase" });
    const expected = join(ensureProjectStorageDirectory(store.paths, worktree), "codebase", "snapshots", "repository_demo", "project_first");
    await mkdir(join(expected, "src"), { recursive: true });
    await writeFile(join(expected, "src", "note.txt"), "old snapshot\n", "utf8");
    const checkpoint = service.workspaceCheckpoint({ workspace_id: "repository_demo", checkpoint_id: "project_first", label: "project" }).checkpoint as JsonObject;
    assert.equal(checkpoint.snapshot_root, expected);
    assert.equal(String(checkpoint.snapshot_root).startsWith(store.paths.runtimeDir), false);
    assert.equal(await readFile(join(expected, "src", "note.txt"), "utf8"), "project snapshot\n");
    await writeFile(join(worktree, "src", "note.txt"), "changed\n", "utf8");
    const restored = service.workspaceRestore({ workspace_id: "repository_demo", checkpoint_id: "project_first", approved: true });
    assert.equal((restored.workspace as JsonObject).latest_checkpoint_id, "project_first");
    assert.equal(await readFile(join(worktree, "src", "note.txt"), "utf8"), "project snapshot\n");
    const second = service.workspaceCheckpoint({ workspace_id: "repository_demo", checkpoint_id: "project_second", label: "project second" }).checkpoint as JsonObject;
    assert.equal(second.snapshot_root, join(projectStorageDirectory(store.paths, worktree), "codebase", "snapshots", "repository_demo", "project_second"));
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("repository snapshots reuse selected file bytes and reject stale source versions", async () => {
  const root = join(tmpdir(), `craft-workspace-selected-snapshot-${process.pid}-${Date.now()}`);
  const worktree = join(root, "worktree"), content = "export const value = 1;\n";
  const store = await new CraftStore(craftPaths(join(root, "craft"))).open();
  const service = new CraftService(store);
  try {
    await mkdir(join(worktree, "src"), { recursive: true });
    await writeFile(join(worktree, "src", "value.ts"), content, "utf8");
    await writeFile(join(worktree, "root.ts"), "export const root = true;\n", "utf8");
    service.workspaceOpen({ workspace_id: "repository_selected", name: "Repository", root_path: worktree,
      include_paths: ["src/value.ts", "root.ts"], snapshot_storage: "project_codebase" });
    const selected: Array<{ path: string; content: string; digest: string; file_version: string }> = [];
    for (const [path, body] of [["src/value.ts", content], ["root.ts", "export const root = true;\n"]] as const) {
      const metadata = await stat(join(worktree, path));
      selected.push({ path, content: body, digest: createHash("sha256").update(body).digest("hex"),
        file_version: [metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs, metadata.ctimeMs].join(":") });
    }
    assert.throws(() => service.workspaceCheckpointFromRepositoryFiles({ workspace_id: "repository_selected", label: "invalid" }), /must be an array/u);
    assert.throws(() => service.workspaceCheckpointFromRepositoryFiles({ workspace_id: "repository_selected", label: "invalid", repository_files: [null] }), /must be an array/u);
    assert.throws(() => service.workspaceCheckpointFromRepositoryFiles({ workspace_id: "repository_selected", label: "invalid", repository_files: [{ path: "root.ts", content: 1 }] }), /invalid or duplicate/u);
    assert.throws(() => service.workspaceCheckpointFromRepositoryFiles({ workspace_id: "repository_selected", label: "invalid", repository_files: [{ ...selected[0], digest: "bad" }] }), /invalid or duplicate/u);
    assert.throws(() => service.workspaceCheckpointFromRepositoryFiles({ workspace_id: "repository_selected", label: "invalid", repository_files: [{ ...selected[0], file_version: undefined }] }), /invalid or duplicate/u);
    assert.throws(() => service.workspaceCheckpointFromRepositoryFiles({ workspace_id: "repository_selected", label: "invalid", repository_files: [] }), /match the workspace selection/u);
    assert.throws(() => service.workspaceCheckpointFromRepositoryFiles({ workspace_id: "repository_selected", label: "invalid", repository_files: [selected[0], selected[0], selected[1]] }), /invalid or duplicate/u);
    assert.throws(() => service.workspaceCheckpointFromRepositoryFiles({ workspace_id: "repository_selected", label: "invalid", repository_files: [{ ...selected[0], content: "different" }, selected[1]] }), /does not match the workspace selection/u);
    assert.throws(() => service.workspaceCheckpointFromRepositoryFiles({ workspace_id: "repository_selected", label: "invalid", repository_files: [{ ...selected[0], path: "outside.ts" }, selected[1]] }), /does not match the workspace selection/u);
    const priorSnapshot = join(projectStorageDirectory(store.paths, worktree), "codebase", "snapshots", "repository_selected", "selected_first");
    await mkdir(join(priorSnapshot, "src"), { recursive: true });
    await writeFile(join(priorSnapshot, "src", "value.ts"), "old snapshot\n", "utf8");
    await writeFile(join(priorSnapshot, "root.ts"), "old snapshot\n", "utf8");
    const checkpoint = service.workspaceCheckpointFromRepositoryFiles({ workspace_id: "repository_selected", checkpoint_id: "selected_first",
      label: "selected", repository_files: selected }).checkpoint as JsonObject;
    assert.equal(await readFile(join(String(checkpoint.snapshot_root), "src", "value.ts"), "utf8"), content);
    assert.equal(await readFile(join(String(checkpoint.snapshot_root), "root.ts"), "utf8"), "export const root = true;\n");
    assert.equal((checkpoint.entries as JsonObject[]).find(entry => entry.path === "src/value.ts")?.digest, selected[0]?.digest);
    await writeFile(join(worktree, "src", "value.ts"), "export const value = 2;\n", "utf8");
    assert.throws(() => service.workspaceCheckpointFromRepositoryFiles({ workspace_id: "repository_selected", checkpoint_id: "selected_stale",
      label: "selected", repository_files: selected }), /source changed before snapshot/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("repository snapshots reject source and repository state races", async () => {
  const root = join(tmpdir(), `craft-workspace-selected-race-${process.pid}-${Date.now()}`), worktree = join(root, "worktree");
  const store = await new CraftStore(craftPaths(join(root, "craft"))).open();
  const service = new CraftService(store), sourcePath = join(worktree, "race.ts");
  const content = "export const race = 1;\n";
  try {
    await mkdir(worktree, { recursive: true });
    await writeFile(sourcePath, content, "utf8");
    service.workspaceOpen({ workspace_id: "repository_race", name: "Repository", root_path: worktree,
      include_paths: ["race.ts"], snapshot_storage: "project_codebase" });
    const selectedFor = async (body: string) => {
      const metadata = await stat(sourcePath);
      return [{ path: "race.ts", content: body, digest: createHash("sha256").update(body).digest("hex"),
        file_version: [metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs, metadata.ctimeMs].join(":") }];
    };
    let reads = 0;
    const sourceRace = new WorkspaceState(store, store.paths, () => {
      if (++reads === 2) writeFileSync(sourcePath, "export const race = 2;\n", "utf8");
      return undefined;
    });
    const staleSelection = await selectedFor(content);
    assert.throws(() => sourceRace.checkpointFromRepositoryFiles({ workspace_id: "repository_race", checkpoint_id: "source_race",
      label: "race", repository_files: staleSelection }), /source changed during snapshot/u);
    await writeFile(sourcePath, content, "utf8");
    const selected = await selectedFor(content);
    const before = { root: worktree, branch: "main", revision: "one", working_tree_digest: "one" };
    const after = { ...before, revision: "two" };
    const changedState = new WorkspaceState(store, store.paths, (() => {
      let call = 0;
      return () => ++call === 1 ? before : after;
    })());
    assert.throws(() => changedState.checkpointFromRepositoryFiles({ workspace_id: "repository_race", checkpoint_id: "state_race",
      label: "race", repository_files: selected }), /Git repository state changed/u);
    const stableState = new WorkspaceState(store, store.paths, () => before);
    const checkpoint = stableState.checkpointFromRepositoryFiles({ workspace_id: "repository_race", checkpoint_id: "state_stable",
      label: "stable", repository_files: selected }).checkpoint as JsonObject;
    assert.deepEqual(checkpoint.repository_state, before);
    service.workspaceOpen({ workspace_id: "repository_runtime", name: "Runtime", root_path: worktree, include_paths: ["race.ts"] });
    assert.equal(service.store.get("workspace", "repository_runtime").snapshot_storage, "project_codebase");
    const runtimeCheckpoint = service.workspaceCheckpointFromRepositoryFiles({ workspace_id: "repository_runtime", checkpoint_id: "runtime_first",
      label: "runtime", repository_files: selected }).checkpoint as JsonObject;
    assert.equal(String(runtimeCheckpoint.snapshot_root).startsWith(join(projectStorageDirectory(store.paths, worktree), "codebase", "snapshots")), true);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("workspace freshness reports missing checkpoints and added, changed, and deleted files", async () => {
  const root = join(tmpdir(), `craft-workspace-freshness-${process.pid}-${Date.now()}`);
  const worktree = join(root, "worktree");
  const store = await new CraftStore(craftPaths(join(root, "craft"))).open();
  const workspace = new WorkspaceState(store, store.paths);
  try {
    await mkdir(join(worktree, "src"), { recursive: true });
    execFileSync("git", ["-C", worktree, "init", "-q"]);
    await writeFile(join(worktree, "src", "changed.txt"), "before\n", "utf8");
    await writeFile(join(worktree, "src", "deleted.txt"), "remove\n", "utf8");
    workspace.open({ workspace_id: "freshness", name: "Freshness", root_path: worktree, include_paths: ["src"] });
    assert.deepEqual(workspace.freshness({ workspace_id: "freshness" }), {
      status: "unavailable", reason: "checkpoint_required", changed_paths: [],
    });
    const checkpoint = workspace.checkpoint({ workspace_id: "freshness", label: "baseline" }).checkpoint as JsonObject;
    assert.deepEqual(workspace.freshness({ workspace_id: "freshness" }), {
      workspace_id: "freshness", checkpoint_id: checkpoint.id, status: "current", changed_paths: [],
    });
    await writeFile(join(worktree, "src", "changed.txt"), "after!\n", "utf8");
    assert.deepEqual(workspace.freshness({ workspace_id: "freshness" }), {
      workspace_id: "freshness", checkpoint_id: checkpoint.id, status: "changed", changed_paths: ["src/changed.txt"],
    });
    await writeFile(join(worktree, "src", "added.txt"), "new\n", "utf8");
    await rm(join(worktree, "src", "deleted.txt"));
    assert.deepEqual(workspace.freshness({ workspace_id: "freshness" }), {
      workspace_id: "freshness", checkpoint_id: checkpoint.id, status: "changed",
      changed_paths: ["src/added.txt", "src/changed.txt", "src/deleted.txt"], repository_state_changed: true,
    });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("workspace freshness rehashes legacy checkpoint entries without file metadata", async () => {
  const root = join(tmpdir(), `craft-workspace-legacy-checkpoint-${process.pid}-${Date.now()}`);
  const worktree = join(root, "worktree");
  const store = await new CraftStore(craftPaths(join(root, "craft"))).open();
  const workspace = new WorkspaceState(store, store.paths);
  try {
    await mkdir(join(worktree, "src"), { recursive: true });
    await writeFile(join(worktree, "src", "note.txt"), "legacy snapshot\n", "utf8");
    workspace.open({ workspace_id: "legacy", name: "Legacy", root_path: worktree, include_paths: ["src"] });
    const checkpoint = workspace.checkpoint({ workspace_id: "legacy", label: "legacy" }).checkpoint as JsonObject;
    const stored = store.get("workspace_checkpoint", String(checkpoint.id));
    const entries = (stored.entries as JsonObject[]).map(({ file_version: _metadata, ...entry }) => entry);
    store.save("workspace_checkpoint", String(checkpoint.id), { ...stored, entries });
    assert.deepEqual(workspace.freshness({ workspace_id: "legacy" }), {
      workspace_id: "legacy", checkpoint_id: checkpoint.id, status: "current", changed_paths: [],
    });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("workspace checkpoint fails when Git state changes while the snapshot is copied", async () => {
  const root = join(tmpdir(), `craft-workspace-git-race-${process.pid}-${Date.now()}`);
  const worktree = join(root, "worktree");
  const store = await new CraftStore(craftPaths(join(root, "craft"))).open();
  const states: RepositoryState[] = [
    { root: worktree, branch: "main", revision: "revision-a", working_tree_digest: "clean" },
    { root: worktree, branch: "other", revision: "revision-b", working_tree_digest: "clean" },
  ];
  const workspace = new WorkspaceState(store, store.paths, () => states.shift());
  try {
    await mkdir(join(worktree, "src"), { recursive: true });
    await writeFile(join(worktree, "src", "source.ts"), "export const value = 1;\n", "utf8");
    workspace.open({ workspace_id: "git-race", name: "Git race", root_path: worktree, include_paths: ["src"] });
    assert.throws(() => workspace.checkpoint({ workspace_id: "git-race", label: "racing checkpoint" }), /repository state changed/u);
    assert.equal(states.length, 0);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("rejects symlinked project Codebase snapshot directories and files", async () => {
  const root = join(tmpdir(), `craft-workspace-project-snapshot-links-${process.pid}-${Date.now()}`);
  const worktree = join(root, "worktree");
  const outside = join(root, "outside");
  const store = await new CraftStore(craftPaths(join(root, "craft"))).open();
  const service = new CraftService(store);
  try {
    await mkdir(join(worktree, "src"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(worktree, "src", "note.txt"), "safe\n", "utf8");
    service.workspaceOpen({ workspace_id: "repository_link", name: "Repository", root_path: worktree,
      include_paths: ["src"], snapshot_storage: "project_codebase" });
    await symlink(outside, join(store.paths.root, "projects"));
    assert.throws(() => service.workspaceCheckpoint({ workspace_id: "repository_link", checkpoint_id: "linked_root", label: "linked" }), /regular directories/);
    await rm(join(store.paths.root, "projects"));
    const projectStorage = ensureProjectStorageDirectory(store.paths, worktree);
    await writeFile(join(projectStorage, "codebase"), "not a directory", "utf8");
    assert.throws(() => service.workspaceCheckpoint({ workspace_id: "repository_link", checkpoint_id: "file_root", label: "file" }), /unsafe directory/);
    await rm(join(projectStorage, "codebase"));
    const snapshotRoot = join(ensureProjectStorageDirectory(store.paths, worktree), "codebase", "snapshots", "repository_link", "linked_file");
    await mkdir(snapshotRoot, { recursive: true });
    await symlink(join(outside, "note.txt"), join(snapshotRoot, "src"));
    assert.throws(() => service.workspaceCheckpoint({ workspace_id: "repository_link", checkpoint_id: "linked_file", label: "linked" }), /unsafe/);
    await rm(snapshotRoot, { recursive: true, force: true });
    await writeFile(join(worktree, "root.txt"), "safe\n", "utf8");
    service.workspaceOpen({ workspace_id: "repository_file_link", name: "Repository file link", root_path: worktree,
      include_paths: ["root.txt"], snapshot_storage: "project_codebase" });
    const fileSnapshotRoot = join(projectStorageDirectory(store.paths, worktree), "codebase", "snapshots", "repository_file_link", "linked_file");
    await mkdir(fileSnapshotRoot, { recursive: true });
    await symlink(join(outside, "missing.txt"), join(fileSnapshotRoot, "root.txt"));
    assert.throws(() => service.workspaceCheckpoint({ workspace_id: "repository_file_link", checkpoint_id: "linked_file", label: "linked" }), /unsafe/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("covers snapshot lifecycle boundaries and exposes its read-only state in the compact MCP surface", async () => {
  assert.throws(() => snapshotNodeKind({ isFile: () => false, isDirectory: () => false }, "special"), /regular files/);
  assert.equal(snapshotStatIfPresent(join(tmpdir(), `craft-missing-snapshot-${process.pid}-${Date.now()}`)), undefined);
  assert.throws(() => snapshotStatIfPresent("\0"), /path/i);
  const root = join(tmpdir(), `craft-workspace-lifecycle-${process.pid}-${Date.now()}`);
  const worktree = join(root, "worktree");
  const store = await new CraftStore(craftPaths(join(root, "craft"))).open();
  const service = new CraftService(store);
  try {
    await mkdir(join(worktree, "dir"), { recursive: true });
    await writeFile(join(worktree, "file.txt"), "one", "utf8");
    await writeFile(join(worktree, "dir", "nested.txt"), "nested", "utf8");
    service.workspaceOpen({ workspace_id: "one", name: "One", root_path: worktree, include_paths: ["file.txt", "dir", "missing"] });
    const first = service.workspaceCheckpoint({ workspace_id: "one", checkpoint_id: "first", label: "first", artifact_ids: [], evidence_ids: [] }).checkpoint as JsonObject;
    await rm(join(worktree, "file.txt"));
    await writeFile(join(worktree, "dir", "added.txt"), "added", "utf8");
    const second = service.workspaceCheckpoint({ workspace_id: "one", checkpoint_id: "second", label: "second" }).checkpoint as JsonObject;
    const diff = service.workspaceDiff({ workspace_id: "one", from_checkpoint_id: first.id, to_checkpoint_id: second.id }).diff as JsonObject;
    assert.deepEqual(diff.added_paths, ["dir/added.txt"]);
    assert.deepEqual(diff.deleted_paths, ["file.txt"]);
    service.workspaceHumanChange({ workspace_id: "one", summary: "agent report", source: "agent" });
    service.workspaceOpen({ workspace_id: "two", name: "Two", root_path: worktree, include_paths: ["dir"] });
    assert.throws(() => service.workspaceDiff({ workspace_id: "two", from_checkpoint_id: first.id, to_checkpoint_id: second.id }), /does not belong/);
    service.workspaceOpen({ workspace_id: "root", name: "Root", root_path: worktree, include_paths: ["."] });
    const rootCheckpoint = service.workspaceCheckpoint({ workspace_id: "root", label: "root" }).checkpoint as JsonObject;
    assert.throws(() => service.workspaceRestore({ workspace_id: "root", checkpoint_id: rootCheckpoint.id, approved: true }), /workspace root/);
    const linkPath = process.platform === "win32" ? join(worktree, "linked-dir") : join(worktree, "linked.txt");
    await symlink(process.platform === "win32" ? join(worktree, "dir") : join(worktree, "dir", "nested.txt"), linkPath,
      process.platform === "win32" ? "junction" : undefined);
    service.workspaceOpen({ workspace_id: "link", name: "Link", root_path: worktree, include_paths: [process.platform === "win32" ? "linked-dir" : "linked.txt"] });
    assert.throws(() => service.workspaceCheckpoint({ workspace_id: "link", label: "link" }), /symbolic links/);
    if (process.platform !== "win32") {
      const fifoPath = join(worktree, "fifo");
      execFileSync("/usr/bin/mkfifo", [fifoPath]);
      service.workspaceOpen({ workspace_id: "fifo", name: "Fifo", root_path: worktree, include_paths: ["fifo"] });
      assert.throws(() => service.workspaceCheckpoint({ workspace_id: "fifo", label: "fifo" }), /regular files/);
    }
    service.workspaceOpen({ workspace_id: "overlap", name: "Overlap", root_path: worktree, include_paths: ["dir", "dir/nested.txt"] });
    assert.throws(() => service.workspaceCheckpoint({ workspace_id: "overlap", label: "overlap" }), /must not overlap/);

    const core = new McpServer(service, "core");
    const full = new McpServer(service, "full");
    const coreTools = ((await core.handle({ id: 1, method: "tools/list" }))?.result as JsonObject).tools as JsonObject[];
    assert.equal(coreTools.some((tool) => tool.name === "craft_workspace_get"), true);
    assert.equal(coreTools.some((tool) => tool.name === "craft_workspace_open"), false);
    const fullOpen = await full.handle({ id: 2, method: "tools/call", params: { name: "craft_workspace_open", arguments: {
      workspace_id: "mcp", name: "Mcp", root_path: worktree, include_paths: ["dir"],
    } } });
    assert.equal((fullOpen?.result as JsonObject).isError, false);
    const fullCheckpoint = await full.handle({ id: 3, method: "tools/call", params: { name: "craft_workspace_checkpoint", arguments: {
      workspace_id: "mcp", checkpoint_id: "mcp_first", label: "Mcp first",
    } } });
    const mcpCheckpoint = ((fullCheckpoint?.result as JsonObject).structuredContent as JsonObject).checkpoint as JsonObject;
    for (const [name, arguments_] of Object.entries({
      craft_workspace_get: { workspace_id: "mcp" },
      craft_workspace_diff: { workspace_id: "mcp", from_checkpoint_id: mcpCheckpoint.id, to_checkpoint_id: mcpCheckpoint.id },
      craft_workspace_human_change: { workspace_id: "mcp", summary: "human" },
      craft_workspace_restore: { workspace_id: "mcp", checkpoint_id: mcpCheckpoint.id, approved: true },
    })) {
      const response = await full.handle({ id: name, method: "tools/call", params: { name, arguments: arguments_ } });
      assert.equal((response?.result as JsonObject).isError, false, name);
    }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
