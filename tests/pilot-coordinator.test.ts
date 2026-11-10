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

test("empty sets, roots, paths and descriptions stay unmatched", () => {
  assert.equal(coordinatorSimilarity("", "billing"), 0);
  assert.equal(coordinatorSimilarity("billing", ""), 0);
  const blank: CoordinatorDirectory = { workspace_id: null, name: "", root_path: "", description: "   " };
  const scores = scoreCoordinatorDirectories("anything", [blank]);
  assert.equal(scores[0]!.score, 0);
  assert.equal(scores[0]!.reason, "没有提到这个目录");
});

test("a parent path at the start of the intent is rejected before any directory binds", () => {
  const directory: CoordinatorDirectory = { workspace_id: "ws", name: "repo", root_path: "repo", description: null };
  const scores = scoreCoordinatorDirectories("repo/../secret", [directory]);
  assert.equal(scores[0]!.reason, "路径包含上级目录，不能确定项目");
  const resolved = resolveCoordinatorDirectory("repo/../secret", [directory]);
  assert.equal(resolved.ambiguous, true);
  assert.equal(resolved.root_path, null);
});

test("a sentence-ending period after a path still counts as a whole reference", () => {
  const scores = scoreCoordinatorDirectories("use ledger.", [{ workspace_id: "ws", name: "ledger", root_path: "ledger", description: null }]);
  assert.equal(scores[0]!.score, 100);
  const followedBySpace = scoreCoordinatorDirectories("use ledger. 继续", [{ workspace_id: "ws", name: "ledger", root_path: "ledger", description: null }]);
  assert.equal(followedBySpace[0]!.score, 100);
});

test("a registered human project name resolves even when the folder name differs", () => {
  const directory: CoordinatorDirectory = { workspace_id: "ws-ledger", name: "ledger-service", root_path: "D:/tmp/hash", description: null };
  const intent = "在 ledger-service 里改结算逻辑";
  const scores = scoreCoordinatorDirectories(intent, [directory]);
  assert.equal(scores[0]!.reason, "意图里提到了项目名");
  const resolved = resolveCoordinatorDirectory(intent, [directory]);
  assert.equal(resolved.root_path, directory.root_path);
  assert.equal(resolved.reason, "意图里提到了项目名");
});

test("blank goals are skipped while real conflicts are still detected", () => {
  const tasks = [{ id: "t1", title: "修复登录", goal: "修复登录页面", status: "active" }];
  const conflicts = detectCoordinatorConflicts([" ", "", "修复登录页面"], tasks);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.task_id, "t1");
});

test("equally similar conflicts are ordered by task id", () => {
  const tasks = [
    { id: "b", title: "修复登录", goal: "修复登录页面", status: "active" },
    { id: "a", title: "修复登录", goal: "修复登录页面", status: "active" },
  ];
  const conflicts = detectCoordinatorConflicts(["修复登录页面"], tasks);
  assert.deepEqual(conflicts.map(item => item.task_id), ["a", "b"]);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-coordinator-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  return { root, store, service };
}

const asSession = (value: JsonObject): JsonObject => value.session as JsonObject;

test("a task inheriting the session workspace reports that source", async () => {
  const f = await fixture();
  try {
    const dir = join(f.root, "billing"); await mkdir(dir);
    const workspace = (f.service.workspaceResolveOrCreate({ root_path: dir }) as JsonObject).workspace as JsonObject;
    const session = asSession(f.service.pilotSessionOpen({ input: "整理问题", workspace_id: workspace.id }) as JsonObject);
    const result = f.service.pilotTurnAuto({ session_id: session.id, input: "整理问题" }) as JsonObject;
    assert.equal(((result.turn as JsonObject).workspace_resolution as JsonObject).source, "session");
    assert.equal(((result.tasks as JsonObject[])[0].task as JsonObject).workspace_id, workspace.id);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

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

test("a replayed turn reinforces the directory once, not once per attempt", async () => {
  const f = await fixture();
  try {
    const dir = join(f.root, "billing"); await mkdir(dir);
    f.service.workspaceResolveOrCreate({ root_path: dir });
    const session = asSession(f.service.pilotSessionOpen({ input: "在 billing 里修登录" }) as JsonObject);
    const input = "在 billing 里修登录";
    const turnId = "turn_replay_once";
    const first = f.service.pilotTurnAuto({ session_id: session.id, input, turn_id: turnId }) as JsonObject;
    assert.notEqual(first.idempotent, true);
    // A retry with the same turn id is the same request, not another use.
    const replay = f.service.pilotTurnAuto({ session_id: session.id, input, turn_id: turnId }) as JsonObject;
    assert.equal(replay.idempotent, true);
    const recorded = f.service.fileDirDescList({}) as JsonObject;
    const entry = ((recorded.items as JsonObject[]).find((item) => item.path === dir) ?? {}) as JsonObject;
    assert.equal(Number(entry.useCount ?? 0), 1, "NEEDREAD 16: repeated queries must not fake use frequency");
    // A genuinely different turn is a separate use.
    f.service.pilotTurnAuto({ session_id: session.id, input: "在 billing 里补一个回归测试", turn_id: "turn_second" });
    const after = f.service.fileDirDescList({}) as JsonObject;
    const second = ((after.items as JsonObject[]).find((item) => item.path === dir) ?? {}) as JsonObject;
    assert.equal(Number(second.useCount ?? 0), 2);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("an explicit workspace reinforces only that workspace and only once on replay", async () => {
  const f = await fixture();
  try {
    const alpha = join(f.root, "alpha"), beta = join(f.root, "beta"); await mkdir(alpha); await mkdir(beta);
    f.service.workspaceResolveOrCreate({ root_path: alpha });
    const selected = (f.service.workspaceResolveOrCreate({ root_path: beta }) as JsonObject).workspace as JsonObject;
    const session = asSession(f.service.pilotSessionOpen({ input: "在 alpha 修复" }) as JsonObject);
    const args = { session_id: session.id, input: "在 alpha 修复", workspace_id: selected.id, turn_id: "selected-once" };
    const first = f.service.pilotTurnAuto(args) as JsonObject;
    assert.equal(((first.tasks as JsonObject[])[0].task as JsonObject).workspace_id, selected.id);
    assert.equal((f.service.pilotTurnAuto(args) as JsonObject).idempotent, true);
    const entries = (f.service.fileDirDescList({}) as JsonObject).items as JsonObject[];
    assert.equal(entries.find(item => item.path === alpha), undefined);
    assert.equal(entries.find(item => item.path === beta)?.useCount, 1);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a blocked directory decision records no use at all", async () => {
  const f = await fixture();
  try {
    for (const name of ["alpha", "belta"]) await mkdir(join(f.root, name));
    f.service.workspaceResolveOrCreate({ root_path: join(f.root, "alpha") });
    f.service.workspaceResolveOrCreate({ root_path: join(f.root, "belta") });
    const session = asSession(f.service.pilotSessionOpen({ input: "整理 alpha belta" }) as JsonObject);
    const blocked = f.service.pilotTurnAuto({ session_id: session.id, input: "整理 alpha belta" }) as JsonObject;
    assert.equal(blocked.status, "blocked");
    assert.equal(((f.service.fileDirDescList({}) as JsonObject).items as JsonObject[]).length, 0);
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

test("same project name at different path depths asks for the directory", async () => {
  const f = await fixture();
  try {
    const first = join(f.root, "one", "billing");
    const second = join(f.root, "another", "billing");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    f.service.workspaceResolveOrCreate({ root_path: first });
    f.service.workspaceResolveOrCreate({ root_path: second });
    const session = asSession(f.service.pilotSessionOpen({ input: "在 billing 里修登录" }) as JsonObject);
    const result = f.service.pilotTurnAuto({ session_id: session.id, input: "在 billing 里修登录" }) as JsonObject;
    assert.equal(result.status, "blocked");
    assert.equal(result.tasks_created, 0);
    const options = ((result.questions as JsonObject[])[0].options as string[]);
    assert.deepEqual(new Set(options), new Set([first, second]));
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("different length project names both mentioned require a choice", async () => {
  const f = await fixture();
  try {
    const first = join(f.root, "alpha");
    const second = join(f.root, "beta");
    await mkdir(first);
    await mkdir(second);
    f.service.workspaceResolveOrCreate({ root_path: first });
    f.service.workspaceResolveOrCreate({ root_path: second });
    const input = "整理 alpha 和 beta";
    const session = asSession(f.service.pilotSessionOpen({ input }) as JsonObject);
    const result = f.service.pilotTurnAuto({ session_id: session.id, input }) as JsonObject;
    assert.equal(result.status, "blocked");
    assert.equal(result.tasks_created, 0);
    assert.deepEqual(new Set((result.questions as JsonObject[])[0].options as string[]), new Set([first, second]));
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a project name contained in another name does not create a false choice", async () => {
  const f = await fixture();
  try {
    const first = join(f.root, "craft");
    const second = join(f.root, "craft-workbench");
    await mkdir(first);
    await mkdir(second);
    f.service.workspaceResolveOrCreate({ root_path: first });
    f.service.workspaceResolveOrCreate({ root_path: second });
    const input = "在 craft-workbench 里修登录";
    const session = asSession(f.service.pilotSessionOpen({ input }) as JsonObject);
    const result = f.service.pilotTurnAuto({ session_id: session.id, input }) as JsonObject;
    const expected = f.service.coordinatorDirectories().find((directory) => directory.root_path === second);
    assert.ok(expected);
    assert.equal(((result.tasks as JsonObject[])[0].task as JsonObject).workspace_id, expected.workspace_id);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("separately mentioning a short name and its longer counterpart requires a choice", async () => {
  const f = await fixture();
  try {
    const first = join(f.root, "craft");
    const second = join(f.root, "craft-workbench");
    await mkdir(first); await mkdir(second);
    f.service.workspaceResolveOrCreate({ root_path: first });
    f.service.workspaceResolveOrCreate({ root_path: second });
    const input = "同时修改 craft 和 craft-workbench";
    const session = asSession(f.service.pilotSessionOpen({ input }) as JsonObject);
    const result = f.service.pilotTurnAuto({ session_id: session.id, input }) as JsonObject;
    assert.equal(result.status, "blocked");
    assert.equal(result.tasks_created, 0);
    assert.deepEqual(new Set((result.questions as JsonObject[])[0].options as string[]), new Set([first, second]));
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("two separate explicit paths require a choice", async () => {
  const f = await fixture();
  try {
    const first = join(f.root, "alpha");
    const second = join(f.root, "longer-beta");
    await mkdir(first); await mkdir(second);
    f.service.workspaceResolveOrCreate({ root_path: first });
    f.service.workspaceResolveOrCreate({ root_path: second });
    const input = `同时修改 ${first} 和 ${second}`;
    const session = asSession(f.service.pilotSessionOpen({ input }) as JsonObject);
    const result = f.service.pilotTurnAuto({ session_id: session.id, input }) as JsonObject;
    assert.equal(result.status, "blocked");
    assert.equal(result.tasks_created, 0);
    assert.deepEqual(new Set((result.questions as JsonObject[])[0].options as string[]), new Set([first, second]));
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("an explicit path and another project name require a choice", async () => {
  const f = await fixture();
  try {
    const first = join(f.root, "craft");
    const second = join(f.root, "workbench");
    await mkdir(first); await mkdir(second);
    f.service.workspaceResolveOrCreate({ root_path: first });
    f.service.workspaceResolveOrCreate({ root_path: second });
    const input = `同时修改 ${first} 和 workbench`;
    const session = asSession(f.service.pilotSessionOpen({ input }) as JsonObject);
    const result = f.service.pilotTurnAuto({ session_id: session.id, input }) as JsonObject;
    assert.equal(result.status, "blocked");
    assert.equal(result.tasks_created, 0);
    assert.deepEqual(new Set((result.questions as JsonObject[])[0].options as string[]), new Set([first, second]));
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("an explicit path outranks an unrelated description match", () => {
  const result = resolveCoordinatorDirectory("在 D:\\projects\\billing 修改 service root", dirs);
  assert.equal(result.root_path, "D:\\projects\\billing");
  assert.equal(result.ambiguous, false);
});

test("an explicit nested project path selects the nested project", async () => {
  const f = await fixture();
  try {
    const parent = join(f.root, "parent");
    const child = join(parent, "child");
    await mkdir(child, { recursive: true });
    f.service.workspaceResolveOrCreate({ root_path: parent });
    f.service.workspaceResolveOrCreate({ root_path: child });
    const expected = f.service.coordinatorDirectories().find((directory) => directory.root_path === child);
    const input = `在 ${child} 修登录`;
    const session = asSession(f.service.pilotSessionOpen({ input }) as JsonObject);
    const result = f.service.pilotTurnAuto({ session_id: session.id, input }) as JsonObject;
    assert.ok(expected);
    assert.equal(((result.tasks as JsonObject[])[0].task as JsonObject).workspace_id, expected.workspace_id);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("an unregistered path with a registered path as prefix is not bound", async () => {
  const f = await fixture();
  try {
    const registered = join(f.root, "craft");
    await mkdir(registered);
    f.service.workspaceResolveOrCreate({ root_path: registered });
    const input = `在 ${registered}-backup 修登录`;
    const session = asSession(f.service.pilotSessionOpen({ input }) as JsonObject);
    const result = f.service.pilotTurnAuto({ session_id: session.id, input }) as JsonObject;
    assert.notEqual(((result.tasks as JsonObject[])[0].task as JsonObject).workspace_id, f.service.coordinatorDirectories()[0].workspace_id);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("an explicit file inside a registered directory binds the project", async () => {
  const f = await fixture();
  try {
    const registered = join(f.root, "craft");
    await mkdir(registered);
    f.service.workspaceResolveOrCreate({ root_path: registered });
    const input = `在 ${registered}/src/main.ts 修登录`;
    const session = asSession(f.service.pilotSessionOpen({ input }) as JsonObject);
    const result = f.service.pilotTurnAuto({ session_id: session.id, input }) as JsonObject;
    assert.equal(((result.tasks as JsonObject[])[0].task as JsonObject).workspace_id, f.service.coordinatorDirectories()[0].workspace_id);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a basename inside another path does not select the registered project", async () => {
  const f = await fixture();
  try {
    const registered = join(f.root, "craft");
    await mkdir(registered);
    f.service.workspaceResolveOrCreate({ root_path: registered });
    const input = "在 /other/tmp/craft 修复";
    const session = asSession(f.service.pilotSessionOpen({ input }) as JsonObject);
    const result = f.service.pilotTurnAuto({ session_id: session.id, input }) as JsonObject;
    assert.notEqual(((result.tasks as JsonObject[])[0].task as JsonObject).workspace_id, f.service.coordinatorDirectories()[0].workspace_id);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a sentence-ending period after an explicit path selects the project", async () => {
  const f = await fixture();
  try {
    const registered = join(f.root, "craft");
    await mkdir(registered);
    f.service.workspaceResolveOrCreate({ root_path: registered });
    const input = `Use ${registered}.`;
    const session = asSession(f.service.pilotSessionOpen({ input }) as JsonObject);
    const result = f.service.pilotTurnAuto({ session_id: session.id, input }) as JsonObject;
    assert.equal(((result.tasks as JsonObject[])[0].task as JsonObject).workspace_id, f.service.coordinatorDirectories()[0].workspace_id);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a path escaping a registered project does not select it", async () => {
  const f = await fixture();
  try {
    const registered = join(f.root, "craft");
    await mkdir(registered);
    f.service.workspaceResolveOrCreate({ root_path: registered });
    const input = `在 ${registered}/../other 修复`;
    const session = asSession(f.service.pilotSessionOpen({ input }) as JsonObject);
    const result = f.service.pilotTurnAuto({ session_id: session.id, input }) as JsonObject;
    assert.equal(result.status, "blocked");
    assert.equal(result.tasks_created, 0);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a parent path followed by punctuation does not select the project", async () => {
  const f = await fixture();
  try {
    const registered = join(f.root, "craft");
    await mkdir(registered);
    f.service.workspaceResolveOrCreate({ root_path: registered });
    for (const suffix of ["。", ")"]) {
      const input = `在 ${registered}/..${suffix}`;
      const session = asSession(f.service.pilotSessionOpen({ input }) as JsonObject);
      const result = f.service.pilotTurnAuto({ session_id: session.id, input }) as JsonObject;
      assert.equal(result.status, "blocked");
      assert.equal(result.tasks_created, 0);
    }
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("API routes, relative files, and slash punctuation do not block normal project tasks", async () => {
  const f = await fixture();
  try {
    const registered = join(f.root, "craft");
    await mkdir(registered);
    f.service.workspaceResolveOrCreate({ root_path: registered });
    const expected = f.service.coordinatorDirectories()[0].workspace_id;
    for (const input of ["在 craft 修复 /api/foo 接口", "在 craft 修复 ./src/app.ts", "修复 craft 的输入 / 输出"]) {
      const session = asSession(f.service.pilotSessionOpen({ input }) as JsonObject);
      const result = f.service.pilotTurnAuto({ session_id: session.id, input }) as JsonObject;
      assert.equal(((result.tasks as JsonObject[])[0].task as JsonObject).workspace_id, expected);
    }
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("explicit unknown working directory blocks session fallback and offers registered workspace ids", async () => {
  const f = await fixture();
  try {
    const known = join(f.root, "known"), unknown = join(f.root, "unknown");
    await mkdir(known); await mkdir(unknown);
    const workspace = (f.service.workspaceResolveOrCreate({ root_path: known }) as JsonObject).workspace as JsonObject;
    const input = `工作目录：${unknown}，修复 /api/foo`;
    const session = asSession(f.service.pilotSessionOpen({ input, workspace_id: workspace.id }) as JsonObject);
    const blocked = f.service.pilotTurnAuto({ session_id: session.id, input }) as JsonObject;
    assert.equal(blocked.status, "blocked"); assert.equal(blocked.tasks_created, 0);
    assert.deepEqual(((blocked.questions as JsonObject[])[0].workspace_options as JsonObject[]).map(o => o.workspace_id), [workspace.id]);
    const selected = f.service.pilotTurnAuto({ session_id: session.id, input, workspace_id: workspace.id }) as JsonObject;
    assert.equal(((selected.tasks as JsonObject[])[0].task as JsonObject).workspace_id, workspace.id);
    assert.equal((selected.turn as JsonObject).input, input);
    const knownInput = `工作目录：${known}，修复问题`;
    assert.equal((f.service.pilotTurnAuto({ session_id: session.id, input: knownInput }) as JsonObject).status, "created");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("an unregistered declared directory with no registered choices remains blocked", async () => {
  const f = await fixture();
  try {
    const session = asSession(f.service.pilotSessionOpen({ input: "work" }) as JsonObject);
    const result = f.service.pilotTurnAuto({ session_id: session.id, input: "工作目录：/new/project，处理任务" }) as JsonObject;
    assert.equal(result.status, "blocked");
    assert.deepEqual((result.questions as JsonObject[])[0].workspace_options, []);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a path escaping a registered project cannot fall back to another project's description", async () => {
  const f = await fixture();
  try {
    const registered = join(f.root, "craft");
    const billing = join(f.root, "billing");
    await mkdir(registered); await mkdir(billing);
    f.service.workspaceResolveOrCreate({ root_path: registered });
    const record = f.service.fileDirDescRecord({ path: billing, description: "用户服务" });
    f.service.fileDirDescPromote({ id: record.id });
    const input = `修改 ${registered}/../other 的用户服务`;
    const session = asSession(f.service.pilotSessionOpen({ input }) as JsonObject);
    const result = f.service.pilotTurnAuto({ session_id: session.id, input }) as JsonObject;
    assert.equal(result.status, "blocked");
    assert.equal(result.tasks_created, 0);
    assert.ok((result.questions as JsonObject[]).length);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a parent path under an unrelated prefix does not block the chosen project", async () => {
  const f = await fixture();
  try {
    const craft = join(f.root, "craft");
    const billing = join(f.root, "billing");
    await mkdir(craft); await mkdir(billing);
    f.service.workspaceResolveOrCreate({ root_path: craft });
    f.service.workspaceResolveOrCreate({ root_path: billing });
    const input = `在 billing 比较 /other${craft}/../file 的内容`;
    const session = asSession(f.service.pilotSessionOpen({ input }) as JsonObject);
    const result = f.service.pilotTurnAuto({ session_id: session.id, input }) as JsonObject;
    const expected = f.service.coordinatorDirectories().find((directory) => directory.root_path === billing);
    assert.ok(expected);
    assert.equal(((result.tasks as JsonObject[])[0].task as JsonObject).workspace_id, expected.workspace_id);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
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
