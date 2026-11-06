import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { canonicalRootPath } from "../core/workspace.ts";

test("canonicalRootPath folds case only on win32 and defaults to the host platform", () => {
  const mixed = join(resolve(tmpdir()), "MiXeD-Case-Root");
  assert.equal(canonicalRootPath(mixed, "win32"), mixed.toLowerCase());
  assert.equal(canonicalRootPath(mixed, "linux"), mixed);
  // The default parameter path is what production uses.
  assert.equal(canonicalRootPath(mixed), canonicalRootPath(mixed, process.platform));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-workspace-binding-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  return { root, store, service };
}

test("taskOpen resolves a directory workspace into a canonical workspace_id", async () => {
  const f = await fixture();
  try {
    const projectA = join(f.root, "project-a");
    const projectB = join(f.root, "project-b");
    await mkdir(projectA); await mkdir(projectB);

    const first = f.service.taskOpen({ title: "A1", goal: "one", workspace: projectA });
    const second = f.service.taskOpen({ title: "A2", goal: "two", workspace: projectA });
    const other = f.service.taskOpen({ title: "B1", goal: "three", workspace: projectB });
    const unbound = f.service.taskOpen({ title: "U", goal: "none" });

    const taskA1 = first.task as JsonObject, taskA2 = second.task as JsonObject, taskB1 = other.task as JsonObject, taskU = unbound.task as JsonObject;
    assert.ok(typeof taskA1.workspace_id === "string" && taskA1.workspace_id.startsWith("workspace_"));
    // Same directory yields the same canonical identity; a different directory diverges.
    assert.equal(taskA1.workspace_id, taskA2.workspace_id);
    assert.notEqual(taskA1.workspace_id, taskB1.workspace_id);
    assert.equal(taskU.workspace_id, null);

    const workspaces = (f.service.workspaceList({}) as JsonObject).workspaces as JsonObject[];
    assert.equal(workspaces.length, 2);
    const paths = workspaces.map((item) => item.root_path);
    assert.ok(paths.includes(projectA));
    assert.ok(paths.includes(projectB));
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("workspaceResolveOrCreate is idempotent and rejects missing paths", async () => {
  const f = await fixture();
  try {
    const dir = join(f.root, "only");
    await mkdir(dir);
    const one = (f.service.workspaceResolveOrCreate({ root_path: dir, name: "Only" }) as JsonObject).workspace as JsonObject;
    const two = (f.service.workspaceResolveOrCreate({ root_path: dir }) as JsonObject).workspace as JsonObject;
    assert.equal(one.id, two.id);
    assert.equal(one.name, "Only");
    assert.throws(() => f.service.workspaceResolveOrCreate({ root_path: join(f.root, "missing") }), /must exist/);
    // On Windows the same directory spelled with a different case is one workspace.
    if (process.platform === "win32") {
      const remixed = dir.replace(/[a-z]/, (c) => (c === "o" ? "O" : c));
      const three = (f.service.workspaceResolveOrCreate({ root_path: remixed }) as JsonObject).workspace as JsonObject;
      assert.equal(three.id, one.id);
    }
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("workspaceBackfill dry-run reports binds without mutating, then apply binds non-destructively", async () => {
  const f = await fixture();
  try {
    const dir = join(f.root, "history");
    await mkdir(dir);
    // A historical task with no workspace_id plus a session link that remembers its directory.
    f.store.create("task", "task_history", { title: "Old", goal: "legacy", project_id: null, status: "active" });
    f.store.create("workbench_agent_session_link", "link_history", { task_id: "task_history", provider: "codex",
      native_session_id: "native-1", workspace: dir, model: null, permission: "ask", turn_state: "idle" });
    // A task already bound must never be overwritten.
    f.service.taskOpen({ title: "Bound", goal: "bound", workspace: dir, task_id: undefined });

    const dry = f.service.workspaceBackfill({ dry_run: true }) as JsonObject;
    assert.equal(dry.dry_run, true);
    assert.equal(dry.bound, 1);
    assert.equal((f.store.get("task", "task_history") as JsonObject).workspace_id ?? null, null);

    const applied = f.service.workspaceBackfill({ dry_run: false }) as JsonObject;
    assert.equal(applied.dry_run, false);
    assert.equal(applied.bound, 1);
    const boundTask = f.store.get("task", "task_history") as JsonObject;
    assert.equal(boundTask.title, "Old");
    assert.equal(typeof boundTask.workspace_id, "string");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("homeView projects workspace_id on tasks and root_path on workspaces", async () => {
  const f = await fixture();
  try {
    const dir = join(f.root, "home");
    await mkdir(dir);
    f.service.taskOpen({ title: "H", goal: "home", workspace: dir });
    const view = f.service.homeView({ limit: 10 }) as JsonObject;
    const tasks = view.tasks as JsonObject[];
    assert.equal(typeof tasks[0]?.workspace_id, "string");
    const workspaces = view.workspaces as JsonObject[];
    assert.equal(workspaces[0]?.root_path, dir);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
