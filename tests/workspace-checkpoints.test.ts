import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { McpServer } from "../core/mcp.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
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
    const expected = join(worktree, ".craft_data", "codebase", "snapshots", "repository_demo", "project_first");
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
    assert.equal(second.snapshot_root, join(worktree, ".craft_data", "codebase", "snapshots", "repository_demo", "project_second"));
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("workspace freshness reports missing checkpoints and added, changed, and deleted files", async () => {
  const root = join(tmpdir(), `craft-workspace-freshness-${process.pid}-${Date.now()}`);
  const worktree = join(root, "worktree");
  const store = await new CraftStore(craftPaths(join(root, "craft"))).open();
  const workspace = new WorkspaceState(store, store.paths);
  try {
    await mkdir(join(worktree, "src"), { recursive: true });
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
    await writeFile(join(worktree, "src", "changed.txt"), "after\n", "utf8");
    await writeFile(join(worktree, "src", "added.txt"), "new\n", "utf8");
    await rm(join(worktree, "src", "deleted.txt"));
    assert.deepEqual(workspace.freshness({ workspace_id: "freshness" }), {
      workspace_id: "freshness", checkpoint_id: checkpoint.id, status: "changed",
      changed_paths: ["src/added.txt", "src/changed.txt", "src/deleted.txt"],
    });
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
    await symlink(outside, join(worktree, ".craft_data"));
    assert.throws(() => service.workspaceCheckpoint({ workspace_id: "repository_link", checkpoint_id: "linked_root", label: "linked" }), /unsafe directory/);
    await rm(join(worktree, ".craft_data"));
    const snapshotRoot = join(worktree, ".craft_data", "codebase", "snapshots", "repository_link", "linked_file");
    await mkdir(snapshotRoot, { recursive: true });
    await symlink(join(outside, "note.txt"), join(snapshotRoot, "src"));
    assert.throws(() => service.workspaceCheckpoint({ workspace_id: "repository_link", checkpoint_id: "linked_file", label: "linked" }), /unsafe/);
    await rm(snapshotRoot, { recursive: true, force: true });
    await writeFile(join(worktree, "root.txt"), "safe\n", "utf8");
    service.workspaceOpen({ workspace_id: "repository_file_link", name: "Repository file link", root_path: worktree,
      include_paths: ["root.txt"], snapshot_storage: "project_codebase" });
    const fileSnapshotRoot = join(worktree, ".craft_data", "codebase", "snapshots", "repository_file_link", "linked_file");
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
