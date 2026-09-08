import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { McpServer } from "../src/mcp.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

test("v0.9.10 keeps an explicit workspace file-state timeline and restores only an approved checkpoint", async () => {
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

test("v0.9.10 rejects workspace roots, paths, and snapshots that escape the declared file tree", async () => {
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
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("v0.9.10 covers snapshot lifecycle boundaries and exposes its read-only state in the compact MCP surface", async () => {
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
    await symlink(join(worktree, "dir", "nested.txt"), join(worktree, "linked.txt"));
    service.workspaceOpen({ workspace_id: "link", name: "Link", root_path: worktree, include_paths: ["linked.txt"] });
    assert.throws(() => service.workspaceCheckpoint({ workspace_id: "link", label: "link" }), /symbolic links/);
    const fifoPath = join(worktree, "fifo");
    execFileSync("/usr/bin/mkfifo", [fifoPath]);
    service.workspaceOpen({ workspace_id: "fifo", name: "Fifo", root_path: worktree, include_paths: ["fifo"] });
    assert.throws(() => service.workspaceCheckpoint({ workspace_id: "fifo", label: "fifo" }), /regular files/);
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
