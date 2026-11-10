import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { canonicalRootPath } from "../core/workspace.ts";
import { linkDirectory, supportsFileSymlinks } from "./symlink-support.ts";

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
  service.codexHost.executor = async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, cancelled: false, outputLimited: false });
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

test("workspace binding treats a directory and its symbolic aliases as the same workspace", { skip: !supportsFileSymlinks() }, async () => {
  const f = await fixture();
  try {
    const parent = join(f.root, "parent"), project = join(parent, "project");
    const parentAlias = join(f.root, "parent-alias"), projectAlias = join(f.root, "project-alias");
    await mkdir(parent); await mkdir(project);
    await linkDirectory(parent, parentAlias); await linkDirectory(project, projectAlias);
    const first = f.service.taskOpen({ title: "A", goal: "one", workspace: project });
    const nestedAlias = f.service.taskOpen({ title: "B", goal: "two", workspace: join(parentAlias, "project") });
    const directAlias = f.service.taskOpen({ title: "C", goal: "three", workspace: projectAlias });
    const ids = [first, nestedAlias, directAlias].map((item) => (item.task as JsonObject).workspace_id);
    assert.equal(ids[0], ids[1]); assert.equal(ids[0], ids[2]);
    const workspaces = (f.service.workspaceList({}) as JsonObject).workspaces as JsonObject[];
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0]?.root_path, project);
    assert.equal(workspaces[0]?.canonical_root_path, realpathSync(project));
    const other = join(f.root, "other"); await mkdir(other); await rm(parentAlias); await linkDirectory(other, parentAlias);
    assert.equal(((f.service.workspaceGet({ workspace_id: ids[0] }) as JsonObject).workspace as JsonObject).canonical_root_path, realpathSync(project));
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("legacy duplicate workspace aliases require resolution instead of selecting by order", { skip: !supportsFileSymlinks() }, async () => {
  const f = await fixture();
  try {
    const parent = join(f.root, "parent"), project = join(parent, "project"), alias = join(f.root, "alias");
    await mkdir(parent); await mkdir(project); await linkDirectory(parent, alias);
    f.service.workspaceOpen({ workspace_id: "first", name: "first", root_path: project, include_paths: ["."] });
    f.service.workspaceOpen({ workspace_id: "second", name: "second", root_path: join(alias, "project"), include_paths: ["."] });
    assert.throws(() => f.service.workspaceResolveOrCreate({ root_path: project }), /multiple workspace records/u);
    assert.equal(((f.service.workspaceList({}) as JsonObject).workspaces as JsonObject[]).length, 2);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("legacy workspace using a movable symbolic parent requires reconciliation", { skip: !supportsFileSymlinks() }, async () => {
  const f = await fixture();
  try {
    const original = join(f.root, "original"), replacement = join(f.root, "replacement"), alias = join(f.root, "alias");
    await mkdir(original); await mkdir(replacement); await mkdir(join(original, "project")); await mkdir(join(replacement, "project"));
    await linkDirectory(original, alias);
    f.service.workspaceOpen({ workspace_id: "legacy", name: "legacy", root_path: join(alias, "project"), include_paths: ["."] });
    await rm(alias); await linkDirectory(replacement, alias);
    assert.throws(() => f.service.workspaceResolveOrCreate({ root_path: join(alias, "project") }), /reconciliation/u);
    assert.throws(() => f.service.workspaceResolveOrCreate({ root_path: join(original, "project") }), /reconciliation/u);
    assert.throws(() => f.service.workspaceCheckpoint({ workspace_id: "legacy", label: "snapshot" }), /reconciliation/u);
    assert.throws(() => f.service.stateWorkspaceObserve({ workspace_id: "legacy" }), /reconciliation/u);
    f.store.create("trajectory_script_proposal", "proposal", { lifecycle: "verified", operations: [] });
    f.store.create("workspace_transaction", "transaction", { status: "prepared", workspace_id: "legacy" });
    assert.throws(() => f.service.verifiedScriptIssue({ workspace_id: "legacy", proposal_id: "proposal", transaction_id: "transaction" }), /reconciliation/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a bound task cannot launch after its symbolic workspace parent is redirected", { skip: !supportsFileSymlinks() }, async () => {
  const f = await fixture();
  try {
    const original = join(f.root, "original"), replacement = join(f.root, "replacement"), alias = join(f.root, "alias");
    await mkdir(original); await mkdir(replacement); await mkdir(join(original, "project")); await mkdir(join(replacement, "project"));
    await linkDirectory(original, alias);
    const task = f.service.taskOpen({ title: "Run", goal: "inspect", workspace: join(alias, "project") }).task as JsonObject;
    await rm(alias); await linkDirectory(replacement, alias);
    assert.throws(() => f.service.workLaunchPrepare({ task_id: task.id, host: "codex-cli", workspace: join(alias, "project"), sandbox: "workspace-write", prompt: "inspect" }), /reconciliation/u);
    assert.equal(f.store.list("work_launch", 10).length, 0);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a bound task launches only in its resolved directory", { skip: !supportsFileSymlinks() }, async () => {
  const f = await fixture();
  try {
    const project = join(f.root, "project"), other = join(f.root, "other"), alias = join(f.root, "alias");
    await mkdir(project); await mkdir(other); await linkDirectory(project, alias);
    const task = f.service.taskOpen({ title: "Run", goal: "inspect", workspace: project }).task as JsonObject;
    assert.throws(() => f.service.workLaunchPrepare({ task_id: task.id, host: "codex-cli", workspace: other, sandbox: "workspace-write", prompt: "inspect" }), /does not match/u);
    const prepared = f.service.workLaunchPrepare({ task_id: task.id, host: "codex-cli", workspace: alias, sandbox: "workspace-write", prompt: "inspect" });
    assert.equal((prepared.launch as JsonObject).workspace, realpathSync(project));
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("workspace redirection after preparation cannot be approved", { skip: !supportsFileSymlinks() }, async () => {
  const f = await fixture();
  try {
    const original = join(f.root, "original"), replacement = join(f.root, "replacement"), alias = join(f.root, "alias");
    await mkdir(original); await mkdir(replacement); await mkdir(join(original, "project")); await mkdir(join(replacement, "project"));
    await linkDirectory(original, alias);
    const task = f.service.taskOpen({ title: "Run", goal: "edit", workspace: join(alias, "project") }).task as JsonObject;
    const launch = f.service.workLaunchPrepare({ task_id: task.id, host: "codex-cli", workspace: join(alias, "project"), sandbox: "workspace-write", prompt: "edit" }).launch as JsonObject;
    await rm(alias); await linkDirectory(replacement, alias);
    assert.throws(() => f.service.workLaunchDecide({ launch_id: launch.id, actor: "user", approved: true, prompt: "edit" }), /reconciliation/u);
    assert.equal(f.store.list("host_run", 10).length, 0);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("an unanchored legacy symbolic root requires reconciliation", { skip: !supportsFileSymlinks() }, async () => {
  const f = await fixture();
  try {
    const parent = join(f.root, "parent"), project = join(parent, "project"), alias = join(f.root, "alias");
    await mkdir(parent); await mkdir(project); await linkDirectory(parent, alias);
    f.store.create("workspace", "unanchored", { name: "legacy", root_path: join(alias, "project"), include_paths: ["."], state_revision: 1, latest_checkpoint_id: null });
    assert.throws(() => f.service.workspaceResolveOrCreate({ root_path: project }), /reconciliation/u);
    assert.throws(() => f.service.stateWorkspaceObserve({ workspace_id: "unanchored" }), /reconciliation/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("legacy canonical workspaces remain usable and missing roots do not hide a new workspace", async () => {
  const f = await fixture();
  try {
    const current = join(f.root, "current"); await mkdir(current);
    const payload = { name: "old", include_paths: ["."], state_revision: 1, latest_checkpoint_id: null };
    f.store.create("workspace", "legacy", { ...payload, root_path: realpathSync(current) });
    f.store.create("workspace", "missing", { ...payload, root_path: join(f.root, "deleted") });
    assert.equal(((f.service.workspaceResolveOrCreate({ root_path: current }) as JsonObject).workspace as JsonObject).id, "legacy");
    assert.ok(f.service.stateWorkspaceObserve({ workspace_id: "legacy" }).snapshot);
    const another = join(f.root, "another"); await mkdir(another);
    assert.notEqual(((f.service.workspaceResolveOrCreate({ root_path: another }) as JsonObject).workspace as JsonObject).id, "missing");
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
