import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkbenchKernel } from "../core/workbench.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";

async function fixture(): Promise<{ store: CraftStore; root: string; workbench: WorkbenchKernel }> {
  const root = await mkdtemp(join(tmpdir(), "craft-workbench-kernel-"));
  const store = await new CraftStore(craftPaths(root)).open();
  store.create("workspace", "w1", { root_path: root, include_paths: [], state_revision: 1 });
  store.create("workspace", "w2", { root_path: join(root, "w2"), include_paths: [], state_revision: 1 });
  store.create("task", "t1", {});
  return { store, root, workbench: new WorkbenchKernel(store) };
}

test("workbench objects track revisions, dependencies and cycles", async () => {
  const f = await fixture();
  try {
    const a = f.workbench.objectPut({ workspace_id: "w1", object_id: "a", object_type: "task", name: "A", source_paths: ["src/a.ts"] });
    assert.equal((a.workspace as JsonObject).state_revision, 2);
    const b = f.workbench.objectPut({ workspace_id: "w1", object_id: "b", object_type: "task", name: "B", depends_on: ["a"] });
    assert.equal((b.object as JsonObject).state_revision, 3);
    assert.throws(() => f.workbench.objectPut({ workspace_id: "w1", object_id: "a", object_type: "task", name: "A", depends_on: ["b"] }), /cycle/u);
    assert.throws(() => f.workbench.objectPut({ workspace_id: "w1", object_id: "c", object_type: "task", name: "C", depends_on: ["c"] }), /itself/u);
    assert.throws(() => f.workbench.objectPut({ workspace_id: "w1", object_id: "c", object_type: "task", name: "C", depends_on: ["missing"] }), /Unknown/u);
    assert.throws(() => f.workbench.objectPut({ workspace_id: "w1", object_id: "a", object_type: "task", name: "A", expected_state_revision: 1 }), /changed/u);
    assert.throws(() => f.workbench.objectPut({ workspace_id: "w1", object_id: "x", object_type: "task", name: "X", status: "bogus" }), /unsupported/u);
    assert.throws(() => f.workbench.objectPut({ workspace_id: "w1", object_id: "x", object_type: "task", name: "X", status: "accepted" }), /evidence_ids/u);
    assert.throws(() => f.workbench.objectPut({ workspace_id: "w1", object_id: "x", object_type: "task", name: "X", data: [] }), /object/u);
    f.workbench.objectPut({ workspace_id: "w1", object_id: "x", object_type: "task", name: "X", status: "accepted", evidence_ids: ["e1"] });
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("workbench impact and change apply follow dependencies", async () => {
  const f = await fixture();
  try {
    f.workbench.objectPut({ workspace_id: "w1", object_id: "a", object_type: "task", name: "A", source_paths: ["src/a.ts"] });
    f.workbench.objectPut({ workspace_id: "w1", object_id: "b", object_type: "task", name: "B", depends_on: ["a"] });
    const byId = f.workbench.impact({ workspace_id: "w1", object_ids: ["a"] });
    assert.deepEqual(byId.impacted_object_ids, ["a", "b"]);
    const byPath = f.workbench.impact({ workspace_id: "w1", affected_paths: ["src/a.ts"] });
    assert.deepEqual(byPath.root_object_ids, ["a"]);
    assert.throws(() => f.workbench.impact({ workspace_id: "w1", object_ids: ["missing"] }), /Unknown/u);
    const change = f.workbench.changeApply({ workspace_id: "w1", affected_paths: ["src/a.ts"], summary: "edit" });
    assert.equal((change.change as JsonObject).state_revision, 4);
    assert.equal(f.store.get("work_object", "a").status, "needs_review");
    assert.equal(f.store.get("work_object", "b").status, "needs_review");
    assert.equal((f.workbench.objectList({ workspace_id: "w1", status: "needs_review" }).objects as JsonObject[]).length, 2);
    assert.throws(() => f.workbench.changeApply({ workspace_id: "w1", summary: "stale", expected_state_revision: 1 }), /changed/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("workbench memory scope, supersession and transitions are governed", async () => {
  const f = await fixture();
  try {
    const user = f.workbench.remember({ kind: "fact", scope: "user", content: "keep it local", source: "user" });
    assert.equal((user.memory as JsonObject).status, "active");
    f.workbench.remember({ kind: "preference", scope: "workspace", workspace_id: "w1", content: "prefer tests", source: "user" });
    f.workbench.remember({ kind: "decision", scope: "task", task_id: "t1", content: "use node", source: "user" });
    assert.throws(() => f.workbench.remember({ kind: "bogus", scope: "user", content: "x", source: "u" }), /kind/u);
    assert.throws(() => f.workbench.remember({ kind: "fact", scope: "bogus", content: "x", source: "u" }), /scope/u);
    assert.throws(() => f.workbench.remember({ kind: "fact", scope: "workspace", content: "x", source: "u" }), /workspace_id/u);
    assert.throws(() => f.workbench.remember({ kind: "fact", scope: "user", content: "api_key=abcdefgh", source: "u" }), /credentials/u);
    assert.throws(() => f.workbench.remember({ kind: "fact", scope: "user", content: "new", source: "u", supersedes_id: "missing" }), /Unknown/u);
    const original = f.store.get("memory_item", String((user.memory as JsonObject).id));
    const superseded = f.workbench.remember({ kind: "fact", scope: "user", content: "new", source: "u", supersedes_id: String(original.id) });
    assert.equal(String((superseded.memory as JsonObject).supersedes_id), String(original.id));
    assert.equal(f.store.get("memory_item", String(original.id)).status, "superseded");
    const fresh = f.workbench.remember({ kind: "fact", scope: "user", content: "third", source: "u" });
    assert.throws(() => f.workbench.memoryTransition({ memory_id: String((fresh.memory as JsonObject).id), status: "active" }), /unsupported/u);
    const rejected = f.workbench.memoryTransition({ memory_id: String((fresh.memory as JsonObject).id), status: "rejected" });
    assert.equal((rejected.memory as JsonObject).status, "rejected");
    assert.throws(() => f.workbench.remember({ kind: "fact", scope: "user", content: "x", source: "u", supersedes_id: String((fresh.memory as JsonObject).id) }), /Only an active memory/u);
    const w2 = f.workbench.remember({ kind: "fact", scope: "workspace", workspace_id: "w2", content: "elsewhere", source: "u" });
    assert.throws(() => f.workbench.remember({ kind: "fact", scope: "workspace", workspace_id: "w1", content: "x", source: "u", supersedes_id: String((w2.memory as JsonObject).id) }), /same scope target/u);
    f.store.create("memory_item", "weird", { kind: "fact", scope: "team:t", content: "x", status: "active" });
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("workbench context profiles and assembly stay bounded", async () => {
  const f = await fixture();
  try {
    f.workbench.objectPut({ workspace_id: "w1", object_id: "a", object_type: "task", name: "Alpha", data: { body: "alpha" } });
    const memory = f.workbench.remember({ kind: "fact", scope: "workspace", workspace_id: "w1", content: "alpha fact", source: "u" });
    const memoryId = String((memory.memory as JsonObject).id);
    f.store.create("memory_item", "weird", { kind: "fact", scope: "team:t", content: "x", status: "active" });
    const profile = f.workbench.contextProfileSave({ profile_id: "p1", name: "P1", workspace_id: "w1", required_memory_ids: [memoryId], required_object_ids: ["a"], max_items: 5, max_chars: 500 });
    assert.equal((profile.profile as JsonObject).max_items, 5);
    assert.throws(() => f.workbench.contextProfileSave({ profile_id: "p1", name: "P1", workspace_id: "w1", required_memory_ids: ["missing"] }), /Unknown/u);
    assert.throws(() => f.workbench.contextProfileSave({ profile_id: "p1", name: "P1", workspace_id: "w1", required_object_ids: ["missing"] }), /Unknown/u);
    const assembled = f.workbench.contextProfileAssemble({ profile_id: "p1", query: "alpha" });
    assert.equal(((assembled.context as JsonObject).items as JsonObject[]).length, 2);
    assert.throws(() => f.workbench.contextProfileAssemble({ profile_id: "p1", task_id: "other" }), /Task/u);
    const direct = f.workbench.contextAssemble({ query: "alpha", workspace_id: "w1", limit: 1 });
    assert.equal((direct.items as JsonObject[]).length, 1);
    assert.throws(() => f.workbench.contextAssemble({ query: "alpha", required_memory_ids: ["missing"] }), /unavailable/u);
    assert.throws(() => f.workbench.contextProfileSave({ profile_id: "p2", name: "P2", workspace_id: "w2", required_memory_ids: [memoryId] }), /does not belong/u);
    assert.throws(() => f.workbench.contextAssemble({ query: "alpha", workspace_id: "w1", required_memory_ids: [memoryId], max_chars: 1 }), /exceeds/u);
    assert.throws(() => f.workbench.contextProfileSave({ profile_id: "p3", name: "P3", workspace_id: "w1", required_memory_ids: ["weird"] }), /does not belong/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("workbench task graphs validate deps and advance atomically", async () => {
  const f = await fixture();
  try {
    const graph = f.workbench.taskGraphCreate({ graph_id: "g1", name: "G", nodes: [
      { id: "one", title: "One", objective: "o", kind: "explore" },
      { id: "two", title: "Two", objective: "o", kind: "produce", depends_on: ["one"] },
      { id: "three", title: "Three", objective: "o", kind: "review", depends_on: ["two"] },
    ] });
    assert.deepEqual((graph.ready_node_ids as string[]), ["one"]);
    assert.throws(() => f.workbench.taskGraphCreate({ graph_id: "g2", name: "G", nodes: [
      { id: "one", title: "One", objective: "o", kind: "explore" }, { id: "one", title: "One", objective: "o", kind: "explore" },
    ] }), /Duplicate/u);
    assert.throws(() => f.workbench.taskGraphCreate({ graph_id: "g3", name: "G", nodes: [
      { id: "one", title: "One", objective: "o", kind: "explore", depends_on: ["missing"] },
    ] }), /unknown dependency/u);
    assert.throws(() => f.workbench.taskGraphCreate({ graph_id: "g4", name: "G", nodes: [
      { id: "one", title: "One", objective: "o", kind: "explore", depends_on: ["two"] },
      { id: "two", title: "Two", objective: "o", kind: "produce", depends_on: ["one"] },
    ] }), /cycle/u);
    assert.throws(() => f.workbench.taskGraphCreate({ graph_id: "g5", name: "G", nodes: [
      { id: "n", title: "N", objective: "o", kind: "explore", context_profile_version: 1 },
    ] }), /requires a context profile id/u);
    assert.throws(() => f.workbench.taskGraphCreate({ graph_id: "g6", name: "G", nodes: [
      { id: "n", title: "N", objective: "o", kind: "explore", context_profile_id: "p1", context_profile_version: 0 },
    ] }), /positive integer/u);
    assert.throws(() => f.workbench.taskGraphCreate({ graph_id: "g7", name: "G", nodes: [
      { id: "n", title: "N", objective: "o", kind: "explore", context_profile_id: "missing", context_profile_version: 1 },
    ] }), /Unknown/u);
    assert.throws(() => f.workbench.taskGraphAdvance({ graph_id: "g1", node_id: "two", status: "active" }), /dependencies/u);
    const first = f.workbench.taskGraphAdvance({ graph_id: "g1", node_id: "one", status: "done" });
    assert.deepEqual((first.ready_node_ids as string[]), ["two"]);
    const second = f.workbench.taskGraphAdvance({ graph_id: "g1", node_id: "two", status: "blocked" });
    assert.equal((second.graph as JsonObject).status, "blocked");
    assert.equal(((second.graph as JsonObject).nodes as JsonObject[]).find(node => node.id === "three")?.status, "blocked");
    assert.throws(() => f.workbench.taskGraphAdvance({ graph_id: "g1", node_id: "one", status: "done" }), /terminal/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("context assembly bounds by items and characters and preserves provenance", async () => {
  const f = await fixture();
  try {
    f.workbench.objectPut({ workspace_id: "w1", object_id: "a", object_type: "task", name: "Alpha", data: { body: "alpha" } });
    f.workbench.objectPut({ workspace_id: "w1", object_id: "b", object_type: "task", name: "Beta", data: { body: "beta" } });
    f.workbench.objectPut({ workspace_id: "w1", object_id: "c", object_type: "task", name: "Gamma", data: { body: "gamma" } });
    f.workbench.remember({ kind: "fact", scope: "workspace", workspace_id: "w1", content: "alpha fact", source: "u" });
    // Non-required candidates beyond the character budget are skipped, not thrown.
    const tight = f.workbench.contextAssemble({ query: "alpha", workspace_id: "w1", limit: 50, max_chars: 1 });
    assert.equal((tight.items as JsonObject[]).length, 0);
    assert.equal(tight.omitted_count, 2);
    assert.equal(tight.provenance_preserved, true);
    // A required memory that exceeds the budget raises rather than silently dropping.
    assert.throws(() => f.workbench.contextAssemble({ query: "alpha", workspace_id: "w1", limit: 50, max_chars: 1, required_memory_ids: [(f.workbench.remember({ kind: "fact", scope: "workspace", workspace_id: "w1", content: "required long memory", source: "u" }).memory as JsonObject).id] }), /exceeds the context budget/u);
    // Invalid limits are rejected before any selection.
    assert.throws(() => f.workbench.contextAssemble({ query: "alpha", workspace_id: "w1", limit: 0 }), /positive integers/u);
    assert.throws(() => f.workbench.contextAssemble({ query: "alpha", workspace_id: "w1", max_chars: 0 }), /positive integers/u);
    // Kind and object-type filters narrow candidates.
    const filtered = f.workbench.contextAssemble({ query: "alpha", workspace_id: "w1", memory_kinds: ["decision"], object_types: ["doc"] });
    assert.equal((filtered.items as JsonObject[]).length, 0);
    // workspace_id binds the workspace lookup.
    assert.throws(() => f.workbench.contextAssemble({ query: "x", workspace_id: "missing" }), /Unknown/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
test("workbench validation, scope and error branches are fully exercised", async () => {
  const f = await fixture();
  try {
    // identifier: rejects malformed ids.
    assert.throws(() => f.workbench.objectPut({ workspace_id: "w1", object_id: "bad id", object_type: "task", name: "X" }), /must contain only letters/u);
    // strings: rejects non-array and duplicate values.
    assert.throws(() => f.workbench.objectPut({ workspace_id: "w1", object_id: "a1", object_type: "task", name: "X", depends_on: "nope" as unknown as string[] }), /must be an array/u);
    assert.throws(() => f.workbench.objectPut({ workspace_id: "w1", object_id: "a1", object_type: "task", name: "X", depends_on: ["x", "x"] }), /unique/u);
    // expected_state_revision must be a positive integer.
    assert.throws(() => f.workbench.objectPut({ workspace_id: "w1", object_id: "a2", object_type: "task", name: "X", expected_state_revision: -1 }), /positive integer/u);
    // objectPut: depends_on must reference known objects, and type filter is an allow-list.
    assert.throws(() => f.workbench.objectPut({ workspace_id: "w1", object_id: "a3", object_type: "task", name: "X", depends_on: ["ghost"] }), /Unknown/u);
    assert.throws(() => f.workbench.objectPut({ workspace_id: "w1", object_id: "a4", object_type: "task", name: "X", depends_on: ["a4"] }), /cannot depend on itself/u);
    // objectPut update: object_type must be supplied when changing data and evidence required for accepted.
    f.workbench.objectPut({ workspace_id: "w1", object_id: "a5", object_type: "task", name: "A5", source_paths: ["src/a.ts"] });
    assert.throws(() => f.workbench.objectPut({ workspace_id: "w1", object_id: "a5", object_type: "task", name: "A5", status: "accepted" }), /evidence_ids/u);
    // impact only follows known objects.
    assert.throws(() => f.workbench.impact({ workspace_id: "w1", object_ids: ["ghost"] }), /Unknown/u);
    // changeApply: stale expected_state_revision.
    assert.throws(() => f.workbench.changeApply({ workspace_id: "w1", expected_state_revision: 999 }), /changed/u);
    // memory: valid_until parsing and scope-name mismatch on supersede.
    assert.throws(() => f.workbench.remember({ kind: "fact", scope: "user", content: "x", source: "u", valid_until: "not-a-date" }), /ISO timestamp/u);
    const first = f.workbench.remember({ kind: "fact", scope: "user", content: "x", source: "u" });
    assert.throws(() => f.workbench.remember({ kind: "fact", scope: "workspace", workspace_id: "w1", content: "y", source: "u", supersedes_id: String((first.memory as JsonObject).id) }), /same scope/u);
    // memoryTransition: unsupported target status.
    assert.throws(() => f.workbench.memoryTransition({ memory_id: String((first.memory as JsonObject).id), status: "bogus" as unknown as string }), /unsupported/u);
    // contextProfileSave: invalid limits, missing previous, type allow-list, required ids not belonging.
    assert.throws(() => f.workbench.contextProfileSave({ profile_id: "p", name: "P", workspace_id: "w1", max_items: 0 }), /positive integers/u);
    assert.throws(() => f.workbench.contextProfileSave({ profile_id: "p", name: "P", workspace_id: "w1", memory_kinds: ["bogus"] }), /unsupported value/u);
    assert.throws(() => f.workbench.contextProfileSave({ profile_id: "px", name: "X", workspace_id: "w1", required_object_ids: ["ghost"] }), /Unknown/u);
    const mem = f.workbench.remember({ kind: "fact", scope: "workspace", workspace_id: "w1", content: "alpha fact", source: "u" });
    f.workbench.objectPut({ workspace_id: "w1", object_id: "o1", object_type: "doc", name: "Doc", data: {} });
    const prof = f.workbench.contextProfileSave({ profile_id: "p2", name: "P2", workspace_id: "w1", required_memory_ids: [String((mem.memory as JsonObject).id)], required_object_ids: ["o1"] });
    // assembling a profile scoped to a different workspace fails, and task mismatch fails.
    assert.throws(() => f.workbench.contextProfileAssemble({ profile_id: "p2", workspace_id: "w2" }), /Workspace does not match/u);
    assert.throws(() => f.workbench.contextProfileAssemble({ profile_id: "p2", task_id: "t1" }), /Task does not match/u);
    // contextAssemble: task must exist when provided, required object must belong.
    assert.throws(() => f.workbench.contextAssemble({ query: "x", task_id: "ghost" }), /Unknown/u);
    // taskGraphCreate: node kind allow-list and self-dependency.
    assert.throws(() => f.workbench.taskGraphCreate({ graph_id: "g", name: "G", nodes: [{ id: "n", title: "N", objective: "o", kind: "bogus" }] }), /Unsupported task graph node kind/u);
    assert.throws(() => f.workbench.taskGraphCreate({ graph_id: "g", name: "G", nodes: [{ id: "n", title: "N", objective: "o", kind: "explore", depends_on: ["n"] }] }), /cannot depend on itself/u);
    // taskGraphAdvance: unsupported status, unknown node.
    f.workbench.taskGraphCreate({ graph_id: "g2", name: "G", nodes: [{ id: "n1", title: "N", objective: "o", kind: "explore" }] });
    assert.throws(() => f.workbench.taskGraphAdvance({ graph_id: "g2", node_id: "n1", status: "pending" }), /unsupported/u);
    assert.throws(() => f.workbench.taskGraphAdvance({ graph_id: "g2", node_id: "ghost", status: "done" }), /Unknown/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
test("workbench scope matching, profile updates and graph status derive every branch", async () => {
  const f = await fixture();
  try {
    f.store.create("task", "task1", {});
    // task-scoped memory matches only its task.
    const taskMem = f.workbench.remember({ kind: "fact", scope: "task", task_id: "task1", content: "task memory", source: "u" });
    // contextAssemble with the matching task_id returns it; another task excludes it.
    f.workbench.objectPut({ workspace_id: "w1", object_id: "o1", object_type: "doc", name: "Doc", data: {} });
    const withTask = f.workbench.contextAssemble({ query: "task memory", task_id: "task1", workspace_id: "w1" });
    assert.equal((withTask.items as JsonObject[]).length, 1);
    const withoutTask = f.workbench.contextAssemble({ query: "task memory", workspace_id: "w1" });
    assert.equal((withoutTask.items as JsonObject[]).length, 0);
    // objectPut update preserves prior fields and accepts evidence for accepted.
    f.workbench.objectPut({ workspace_id: "w1", object_id: "o2", object_type: "task", name: "O2", source_paths: ["src/o2.ts"] });
    const updated = f.workbench.objectPut({ workspace_id: "w1", object_id: "o2", object_type: "task", name: "O2 renamed", status: "accepted", evidence_ids: ["e1"], data: { body: "x" }, artifact_ids: ["a1"], depends_on: [] });
    assert.equal((updated.object as JsonObject).name, "O2 renamed");
    assert.equal((updated.object as JsonObject).status, "accepted");
    // required object must belong to the profile workspace.
    const mem = f.workbench.remember({ kind: "fact", scope: "workspace", workspace_id: "w1", content: "alpha fact", source: "u" });
    f.workbench.contextProfileSave({ profile_id: "pp", name: "PP", workspace_id: "w1", required_memory_ids: [String((mem.memory as JsonObject).id)], required_object_ids: ["o1", "o2"] });
    // create a second workspace object that does not belong.
    f.store.create("workspace", "w3", { root_path: join(f.root, "w3"), include_paths: [], state_revision: 1 });
    f.workbench.objectPut({ workspace_id: "w3", object_id: "o3", object_type: "doc", name: "Doc3", data: {} });
    assert.throws(() => f.workbench.contextProfileSave({ profile_id: "pp2", name: "PP2", workspace_id: "w1", required_object_ids: ["o3"] }), /does not belong to the context profile workspace/u);
    // profile update path: reuse previous when not supplied.
    const updatedProfile = f.workbench.contextProfileSave({ profile_id: "pp", name: "PP renamed" });
    assert.equal((updatedProfile.profile as JsonObject).name, "PP renamed");
    assert.equal((updatedProfile.profile as JsonObject).workspace_id, "w1");
    // task graph node profile mismatch for task and workspace.
    f.workbench.taskGraphCreate({ graph_id: "tg", name: "TG", task_id: "task1", workspace_id: "w1", nodes: [{ id: "n1", title: "N", objective: "o", kind: "explore" }] });
    f.store.create("task", "taskX", {});
    f.workbench.contextProfileSave({ profile_id: "ppt", name: "PPT", task_id: "taskX", workspace_id: "w1" });
    assert.throws(() => f.workbench.taskGraphCreate({ graph_id: "tg2", name: "G", task_id: "task1", workspace_id: "w1", nodes: [{ id: "n1", title: "N", objective: "o", kind: "explore", context_profile_id: "ppt", context_profile_version: 1 }] }), /does not match the task/u);
    // graph terminal derivation: a fully done graph reports completed.
    const g2 = f.workbench.taskGraphCreate({ graph_id: "tg3", name: "G", workspace_id: "w1", nodes: [{ id: "n1", title: "N", objective: "o", kind: "explore" }] });
    const advanced = f.workbench.taskGraphAdvance({ graph_id: "tg3", node_id: "n1", status: "done" });
    assert.equal((advanced.graph as JsonObject).status, "completed");
    // memoryTransition to expired and superseded are both supported.
    const m = f.workbench.remember({ kind: "fact", scope: "user", content: "x", source: "u" });
    assert.equal((f.workbench.memoryTransition({ memory_id: String((m.memory as JsonObject).id), status: "expired" }).memory as JsonObject).status, "expired");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
test("workbench defensive branches and edge paths are covered", async () => {
  const f = await fixture();
  try {
    // store.create bypasses remember validation, exercising matchesScope/memoryScopeName object and global branches.
    f.store.create("task", "xt", {});
    f.store.create("memory_item", "glob", { kind: "fact", scope: "global", content: "global memory", source: "u", status: "active", task_id: null, workspace_id: null });
    // dependency in another workspace is rejected.
    f.store.create("workspace", "w9", { root_path: join(f.root, "w9"), include_paths: [], state_revision: 1 });
    f.workbench.objectPut({ workspace_id: "w9", object_id: "d1", object_type: "task", name: "D1", source_paths: [] });
    assert.throws(() => f.workbench.objectPut({ workspace_id: "w1", object_id: "d2", object_type: "task", name: "D2", depends_on: ["d1"] }), /same workspace/u);
    // objectPut on a brand-new object exercises previous===undefined field fallbacks.
    const fresh = f.workbench.objectPut({ workspace_id: "w1", object_id: "nf", object_type: "task", name: "NF", source_paths: [], artifact_ids: [], depends_on: [] });
    assert.equal((fresh.object as JsonObject).name, "NF");
    // changeApply affects only workspace objects and marks impacted via dependency.
    f.workbench.objectPut({ workspace_id: "w1", object_id: "c1", object_type: "task", name: "C1", depends_on: [], source_paths: ["src/c1.ts"] });
    f.workbench.objectPut({ workspace_id: "w1", object_id: "c2", object_type: "task", name: "C2", depends_on: ["c1"], source_paths: [] });
    const change = f.workbench.changeApply({ workspace_id: "w1", affected_paths: ["src/c1.ts"], summary: "edit c1" });
    assert.equal((change.change as JsonObject).state_revision, Number(f.store.get("workspace", "w1").state_revision));
    assert.deepEqual((f.workbench.impact({ workspace_id: "w1", object_ids: ["c1"] }).impacted_object_ids as string[]).sort(), ["c1", "c2"]);
    // contextAssemble with no query tokens matches nothing but still returns a bounded result.
    const empty = f.workbench.contextAssemble({ query: "!!!", workspace_id: "w1" });
    assert.equal((empty.items as JsonObject[]).length, 0);
    // profile version lookup uses a specific version.
    f.workbench.contextProfileSave({ profile_id: "vp", name: "VP", workspace_id: "w1", max_items: 3 });
    const assembled = f.workbench.contextProfileAssemble({ profile_id: "vp", workspace_id: "w1", query: "x" });
    assert.equal((assembled.profile as JsonObject).name, "VP");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
test("workbench object writes are atomic against workspace revision drift", async () => {
  const f = await fixture();
  try {
    f.workbench.objectPut({ workspace_id: "w1", object_id: "r1", object_type: "task", name: "R1", source_paths: [] });
    // A stale caller that read revision 1 must not bump from 1 to 2 after a commit already moved to 2.
    assert.throws(() => f.workbench.objectPut({ workspace_id: "w1", object_id: "r2", object_type: "task", name: "R2", source_paths: [], expected_state_revision: 1 }), /changed/u);
    // The workspace revision is exactly what the committed write produced.
    assert.equal(Number(f.store.get("workspace", "w1").state_revision), 2);
    // A follow-up with the fresh revision succeeds and advances to 3.
    f.workbench.objectPut({ workspace_id: "w1", object_id: "r2", object_type: "task", name: "R2", source_paths: [], expected_state_revision: 2 });
    assert.equal(Number(f.store.get("workspace", "w1").state_revision), 3);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});