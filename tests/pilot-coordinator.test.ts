import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import {
  coordinatorTokens,
  coordinatorSimilarity,
  scoreCoordinatorDirectories,
  resolveCoordinatorDirectory,
  detectCoordinatorConflicts,
  type CoordinatorDirectory,
  COORDINATOR_DIRECTORY_THRESHOLD,
} from "../core/pilot-coordinator.ts";

const dirs: CoordinatorDirectory[] = [
  { workspace_id: "ws-billing", name: "billing", root_path: "D:\\projects\\billing", description: "billing service root" },
  { workspace_id: "ws-ledger", name: "ledger", root_path: "D:\\projects\\ledger", description: "ledger service root" },
  { workspace_id: "ws-front", name: "frontend", root_path: "D:\\projects\\craft-workbench\\frontend", description: null },
];

test("tokens splits Latin words and CJK bigrams", () => {
  assert.deepEqual([...coordinatorTokens("Billing 服务")].sort(), ["billing", "服务"]);
});

test("similarity is 0 when nothing overlaps", () => {
  assert.equal(coordinatorSimilarity("billing", "ledger"), 0);
});

test("exact path wins", () => {
  const scores = scoreCoordinatorDirectories("在 D:\\projects\\billing 里修登录", dirs);
  assert.equal(scores[0].root_path, "D:\\projects\\billing");
  assert.equal(scores[0].score, 100);
  assert.equal(scores[0].reason, "意图里直接写了目录路径");
});

test("directory name wins over unrelated", () => {
  const scores = scoreCoordinatorDirectories("前端样式问题", dirs);
  assert.equal(scores[0].root_path, "D:\\projects\\craft-workbench\\frontend");
});

test("description match scores below name match", () => {
  // No directory name matches; description "billing service root" terms both present.
  const scores = scoreCoordinatorDirectories("service root tweak", dirs);
  assert.equal(scores[0].root_path, "D:\\projects\\billing");
  assert.equal(scores[0].reason, "意图和目录描述吻合（2 个词命中）");
});

test("name match outranks partial description match", () => {
  const scores = scoreCoordinatorDirectories("billing ledger", dirs);
  assert.equal(scores[0].root_path, "D:\\projects\\billing");
});

test("resolve binds unambiguous high-confidence directory", () => {
  const res = resolveCoordinatorDirectory("在 D:\\projects\\billing 里修登录", dirs);
  assert.equal(res.root_path, "D:\\projects\\billing");
  assert.equal(res.workspace_id, "ws-billing");
  assert.equal(res.ambiguous, false);
  assert.equal(res.confidence, 1);
});

test("resolve returns ambiguous when two directories tie", () => {
  // Same score (directory name match) and same path length → ambiguous.
  const tieDirs = [
    { workspace_id: "a", name: "x", root_path: "D:\\shared\\one", description: null },
    { workspace_id: "b", name: "y", root_path: "D:\\shared\\two", description: null },
  ];
  const res = resolveCoordinatorDirectory("one two", tieDirs);
  assert.equal(res.root_path, null);
  assert.equal(res.ambiguous, true);
  assert.equal(res.candidates.length, 2);
});

test("resolve does not bind when nothing matches", () => {
  const res = resolveCoordinatorDirectory("something totally new", dirs);
  assert.equal(res.root_path, null);
  assert.equal(res.ambiguous, false);
  assert.equal(res.reason, "意图里没有提到任何已知目录");
});

test("detects conflicts on running tasks", () => {
  const tasks = [
    { id: "t1", title: "修复登录", goal: "修复登录页面", status: "active" },
    { id: "t2", title: "部署", goal: "发布到生产", status: "completed" },
  ];
  const conflicts = detectCoordinatorConflicts(["修复登录页面"], tasks);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].task_id, "t1");
});

test("ignores terminal-status tasks", () => {
  const tasks = [{ id: "t1", title: "修复登录", goal: "修复登录页面", status: "completed" }];
  const conflicts = detectCoordinatorConflicts(["修复登录页面"], tasks);
  assert.equal(conflicts.length, 0);
});

test("threshold is a defensible number", () => {
  assert.equal(COORDINATOR_DIRECTORY_THRESHOLD, 55);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-coordinator-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  return { root, store, service };
}

const asSession = (value: JsonObject): JsonObject => value.session as JsonObject;

test("the Navigator binds a directory named in the intent, and says so", async () => {
  const f = await fixture();
  try {
    const dir = join(f.root, "billing"); await mkdir(dir);
    f.service.workspaceResolveOrCreate({ root_path: dir });
    const session = asSession(f.service.pilotSessionOpen({ input: "在 billing 里修登录" }) as JsonObject);
    const turn = f.service.pilotTurnAuto({ session_id: session.id, input: "在 billing 里修登录" }) as JsonObject;
    const resolution = (turn.turn as JsonObject).workspace_resolution as JsonObject;
    assert.equal(resolution.source, "intent");
    const tasks = turn.tasks as JsonObject[];
    assert.equal((tasks[0].task as JsonObject).workspace_id, f.service.coordinatorDirectories()[0].workspace_id);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("an ambiguous directory asks instead of guessing, and creates nothing", async () => {
  const f = await fixture();
  try {
    // Equal-length names: a longer directory is more specific evidence and wins
    // outright, so a genuine tie needs two equally plausible candidates.
    for (const name of ["alpha", "belta"]) await mkdir(join(f.root, name));
    f.service.workspaceResolveOrCreate({ root_path: join(f.root, "alpha") });
    f.service.workspaceResolveOrCreate({ root_path: join(f.root, "belta") });
    const session = asSession(f.service.pilotSessionOpen({ input: "整理一下" }) as JsonObject);
    const turn = f.service.pilotTurnAuto({ session_id: session.id, input: "整理 alpha belta" }) as JsonObject;
    assert.equal(turn.status, "blocked");
    assert.equal(turn.tasks_created, 0);
    const questions = turn.questions as JsonObject[];
    assert.equal((questions[0].options as string[]).length, 2);
    assert.equal((turn.turn as JsonObject | undefined), undefined, "a guess must not persist a turn");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); };
});

test("a repeated goal is reported as a conflict, not silently duplicated", async () => {
  const f = await fixture();
  try {
    const session = asSession(f.service.pilotSessionOpen({ input: "修复登录页面的空指针" }) as JsonObject);
    f.service.pilotTurnAuto({ session_id: session.id, input: "修复登录页面的空指针" });
    const second = f.service.pilotTurnAuto({ session_id: session.id, input: "继续修复登录页面的空指针问题" }) as JsonObject;
    const conflicts = second.conflicts as JsonObject[];
    assert.ok(conflicts.length >= 1, "the earlier running task should be flagged");
    assert.equal(typeof conflicts[0].task_id, "string");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
