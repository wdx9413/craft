import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

test("v0.10.0 maintains a shared object graph, invalidates dependents, and prevents stale writes", async () => {
  const root = join(tmpdir(), `craft-workbench-${process.pid}-${Date.now()}`);
  const worktree = join(root, "worktree");
  const store = await new CraftStore(craftPaths(join(root, "craft"))).open();
  const service = new CraftService(store);
  try {
    await mkdir(worktree, { recursive: true });
    const opened = service.workspaceOpen({ workspace_id: "ws", name: "Video", root_path: worktree, include_paths: ["assets"] });
    assert.equal(VERSION, "0.11.23");
    assert.equal((opened.workspace as JsonObject).state_revision, 1);
    const brief = service.workObjectPut({ workspace_id: "ws", object_id: "brief", object_type: "brief", name: "人物设定",
      data: { character: "A" }, source_paths: ["assets/brief.md"], expected_state_revision: 1 }).object as JsonObject;
    assert.equal(brief.status, "draft");
    service.workObjectPut({ workspace_id: "ws", object_id: "shot", object_type: "shot", name: "镜头一",
      data: { duration: 5 }, depends_on: ["brief"], artifact_ids: ["artifact-shot"], expected_state_revision: 2 });
    service.workObjectPut({ workspace_id: "ws", object_id: "edit", object_type: "timeline", name: "时间线",
      data: {}, depends_on: ["shot"], expected_state_revision: 3 });
    service.workObjectPut({ workspace_id: "ws", object_id: "cover", object_type: "image", name: "封面",
      data: {}, expected_state_revision: 4 });

    const impact = service.workspaceImpact({ workspace_id: "ws", affected_paths: ["assets/brief.md"] });
    assert.deepEqual(impact.impacted_object_ids, ["brief", "edit", "shot"]);
    assert.deepEqual(impact.unaffected_object_ids, ["cover"]);
    const changed = service.workspaceChangeApply({ workspace_id: "ws", change_id: "change", summary: "修改人物设定",
      object_ids: ["brief"], expected_state_revision: 5 });
    assert.equal((changed.workspace as JsonObject).state_revision, 6);
    assert.equal((changed.objects as JsonObject[]).every((item) => item.status === "needs_review"), true);
    assert.equal((service.workObjectList({ workspace_id: "ws", status: "needs_review" }).objects as JsonObject[]).length, 3);
    assert.throws(() => service.workObjectPut({ workspace_id: "ws", object_id: "cover", object_type: "image", name: "旧写入",
      expected_state_revision: 5 }), /refresh/);
    assert.throws(() => service.workspaceChangeApply({ workspace_id: "ws", summary: "旧变更", expected_state_revision: 5 }), /refresh/);
    assert.throws(() => service.workObjectPut({ workspace_id: "ws", object_id: "accepted", object_type: "document", name: "交付", status: "accepted",
      expected_state_revision: 6 }), /require evidence/);
    const accepted = service.workObjectPut({ workspace_id: "ws", object_id: "accepted", object_type: "document", name: "交付", status: "accepted",
      evidence_ids: ["human-review"], expected_state_revision: 6 }).object as JsonObject;
    assert.deepEqual(accepted.accepted_evidence_ids, ["human-review"]);
    const acceptedAgain = service.workObjectPut({ workspace_id: "ws", object_id: "accepted", name: "交付确认",
      expected_state_revision: 7 }).object as JsonObject;
    assert.deepEqual(acceptedAgain.accepted_evidence_ids, ["human-review"]);
    const revised = service.workObjectPut({ workspace_id: "ws", object_id: "accepted", name: "交付 v2", status: "draft",
      expected_state_revision: 8 }).object as JsonObject;
    assert.equal(revised.object_type, "document");
    assert.deepEqual(revised.accepted_evidence_ids, []);
    assert.throws(() => service.workObjectPut({ workspace_id: "ws", object_id: "brief", name: "cycle", depends_on: ["edit"], expected_state_revision: 9 }), /cycle/);
    service.workspaceCheckpoint({ workspace_id: "ws", label: "before metadata" });
    const emptyChange = service.workspaceChangeApply({ workspace_id: "ws", summary: "metadata only", source: "agent", expected_state_revision: 9 });
    assert.deepEqual(emptyChange.objects, []);
    assert.equal((service.workObjectList({ workspace_id: "ws", limit: 2 }).objects as JsonObject[]).length, 2);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("v0.10.0 assembles attributable bounded context and preserves memory history", async () => {
  const root = join(tmpdir(), `craft-memory-${process.pid}-${Date.now()}`);
  const worktree = join(root, "worktree");
  const store = await new CraftStore(craftPaths(join(root, "craft"))).open();
  const service = new CraftService(store);
  try {
    await mkdir(worktree, { recursive: true });
    service.workspaceOpen({ workspace_id: "ws", name: "Workspace", root_path: worktree, include_paths: ["docs"] });
    const task = service.taskOpen({ title: "Lesson", goal: "Build lesson" }).task as JsonObject;
    service.workObjectPut({ workspace_id: "ws", object_id: "lesson", object_type: "lesson", name: "Math lesson",
      data: { topic: "fractions" }, expected_state_revision: 1 });
    service.workObjectPut({ workspace_id: "ws", object_id: "archived", object_type: "note", name: "Old lesson",
      data: {}, status: "archived", expected_state_revision: 2 });
    service.memoryRemember({ memory_id: "preference", kind: "preference", scope: "user", content: "Prefer editable lessons",
      source: "user", applies_to: ["education"] });
    service.memoryRemember({ memory_id: "task_fact", kind: "fact", scope: "task", task_id: task.id, content: "Lesson is for grade five",
      source: "teacher", evidence_ids: ["brief"] });
    service.memoryRemember({ memory_id: "expired", kind: "decision", scope: "workspace", workspace_id: "ws", content: "Old lesson format",
      source: "user", valid_until: "2000-01-01T00:00:00.000Z" });
    service.memoryRemember({ memory_id: "future", kind: "experience", scope: "workspace", workspace_id: "ws", content: "Lesson rubric",
      source: "evaluation", valid_until: "2999-01-01T00:00:00.000Z" });
    const context = service.contextAssemble({ query: "lesson editable", task_id: task.id, workspace_id: "ws", limit: 3, max_chars: 500 });
    assert.deepEqual((context.items as JsonObject[]).map((item) => item.source_id), ["preference", "future", "lesson"]);
    assert.equal(context.provenance_preserved, true);
    const bounded = service.contextAssemble({ query: "lesson", workspace_id: "ws", limit: 1, max_chars: 5 });
    assert.equal((bounded.items as JsonObject[]).length, 0);
    assert.equal(bounded.omitted_count, 3);
    service.memoryRemember({ memory_id: "replacement", kind: "preference", scope: "user", content: "Prefer visual editable lessons",
      source: "user", supersedes_id: "preference" });
    assert.equal(store.get("memory_item", "preference").status, "superseded");
    assert.throws(() => service.memoryTransition({ memory_id: "replacement", status: "active" }), /unsupported/);
    assert.equal((service.memoryTransition({ memory_id: "replacement", status: "rejected", reason: "user corrected" }).memory as JsonObject).status, "rejected");
    assert.equal((service.memoryTransition({ memory_id: "future", status: "expired" }).memory as JsonObject).status, "expired");

    store.create("memory_item", "foreign", { kind: "fact", scope: "foreign", content: "lesson foreign", source: "test", status: "active",
      valid_until: null, task_id: null, workspace_id: null });
    assert.equal((service.contextAssemble({ query: "lesson" }).items as JsonObject[]).some((item) => item.source_id === "foreign"), false);
    assert.equal((service.contextAssemble({ query: "!!!" }).items as JsonObject[]).length, 0);
    assert.equal((service.contextAssemble({ query: "lesson", workspace_id: "ws", limit: 1, max_chars: 1_000 }).items as JsonObject[]).length, 1);

    const core = new McpServer(service, "core");
    const tools = ((await core.handle({ id: 1, method: "tools/list" }))?.result as JsonObject).tools as JsonObject[];
    assert.equal(tools.some((tool) => tool.name === "craft_context_assemble"), true);
    const response = await core.handle({ id: 2, method: "tools/call", params: { name: "craft_context_assemble",
      arguments: { query: "lesson", workspace_id: "ws" } } });
    assert.equal((response?.result as JsonObject).isError, false);
    const full = new McpServer(service, "full");
    for (const [name, arguments_] of Object.entries({
      craft_work_object_list: { workspace_id: "ws" },
      craft_workspace_impact: { workspace_id: "ws", object_ids: ["lesson"] },
      craft_workspace_change_apply: { workspace_id: "ws", summary: "MCP change", expected_state_revision: 3 },
      craft_memory_remember: { memory_id: "mcp_memory", kind: "fact", scope: "user", content: "MCP lesson", source: "user" },
      craft_memory_transition: { memory_id: "mcp_memory", status: "superseded" },
    })) {
      const result = await full.handle({ id: name, method: "tools/call", params: { name, arguments: arguments_ } });
      assert.equal((result?.result as JsonObject).isError, false, name);
    }
    const currentRevision = Number((service.workspaceGet({ workspace_id: "ws" }).workspace as JsonObject).state_revision);
    const put = await full.handle({ id: 3, method: "tools/call", params: { name: "craft_work_object_put", arguments: {
      workspace_id: "ws", object_type: "note", name: "MCP object", expected_state_revision: currentRevision,
    } } });
    assert.equal((put?.result as JsonObject).isError, false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("v0.10.0 rejects malformed workbench state and cross-workspace dependencies", async () => {
  const root = join(tmpdir(), `craft-workbench-errors-${process.pid}-${Date.now()}`);
  const worktree = join(root, "worktree");
  const store = await new CraftStore(craftPaths(join(root, "craft"))).open();
  const service = new CraftService(store);
  try {
    await mkdir(worktree, { recursive: true });
    service.workspaceOpen({ workspace_id: "one", name: "One", root_path: worktree, include_paths: ["one"] });
    service.workspaceOpen({ workspace_id: "two", name: "Two", root_path: worktree, include_paths: ["two"] });
    service.workObjectPut({ workspace_id: "one", object_id: "first", object_type: "doc", name: "First" });
    assert.throws(() => service.workObjectPut({ workspace_id: "one", object_id: "self", object_type: "doc", name: "Self", depends_on: ["self"], expected_state_revision: 2 }), /itself/);
    assert.throws(() => service.workObjectPut({ workspace_id: "two", object_id: "second", object_type: "doc", name: "Second", depends_on: ["first"] }), /same workspace/);
    assert.throws(() => service.workspaceImpact({ workspace_id: "two", object_ids: ["first"] }), /belong/);
    assert.throws(() => service.workObjectPut({ workspace_id: "two", object_id: "first", object_type: "doc", name: "Moved" }), /another workspace/);
    assert.throws(() => service.workObjectPut({ workspace_id: "one", object_id: "first", status: "wrong", expected_state_revision: 2 }), /unsupported/);
    assert.throws(() => service.workObjectPut({ workspace_id: "one", object_id: "bad id", object_type: "doc", name: "Bad", expected_state_revision: 2 }), /letters/);
    assert.throws(() => service.workObjectPut({ workspace_id: "one", object_type: "doc", name: "Bad", depends_on: "first", expected_state_revision: 2 }), /array/);
    assert.throws(() => service.workObjectPut({ workspace_id: "one", object_type: "doc", name: "Bad", source_paths: ["x", "x"], expected_state_revision: 2 }), /unique/);
    assert.throws(() => service.workObjectPut({ workspace_id: "one", object_type: "doc", name: 3, expected_state_revision: 2 }), /empty/);
    assert.throws(() => service.workObjectPut({ workspace_id: "one", object_type: "doc", name: "Bad", data: [], expected_state_revision: 2 }), /data/);
    assert.throws(() => service.workObjectPut({ workspace_id: "one", object_type: "doc", name: "Bad", source_paths: [""], expected_state_revision: 2 }), /empty/);
    assert.throws(() => service.workObjectPut({ workspace_id: "one", object_type: "doc", name: " ", expected_state_revision: 2 }), /empty/);
    assert.throws(() => service.workObjectPut({ workspace_id: "one", object_type: "doc", name: "Bad", expected_state_revision: 0 }), /positive/);
    assert.throws(() => service.workObjectPut({ workspace_id: "one", object_type: "doc", name: "Bad", expected_state_revision: "bad" }), /positive/);
    service.workObjectPut({ workspace_id: "one", object_id: "left", object_type: "doc", name: "Left", depends_on: ["first"], expected_state_revision: 2 });
    service.workObjectPut({ workspace_id: "one", object_id: "right", object_type: "doc", name: "Right", depends_on: ["first"], expected_state_revision: 3 });
    service.workObjectPut({ workspace_id: "one", object_id: "diamond", object_type: "doc", name: "Diamond", depends_on: ["left", "right"], expected_state_revision: 4 });
    service.workObjectPut({ workspace_id: "one", object_id: "end", object_type: "doc", name: "End", depends_on: ["diamond"], expected_state_revision: 5 });
    store.create("work_object", "legacy_no_data", { workspace_id: "one", object_type: "doc", name: "Legacy", depends_on: [],
      artifact_ids: [], source_paths: [], status: "draft" });
    assert.deepEqual((service.workObjectPut({ workspace_id: "one", object_id: "legacy_no_data",
      expected_state_revision: 6 }).object as JsonObject).data, {});
    store.save("work_object", "first", { ...store.get("work_object", "first"), source_paths: "legacy-invalid" });
    assert.deepEqual(service.workspaceImpact({ workspace_id: "one", affected_paths: ["not-found"] }).impacted_object_ids, []);
    assert.throws(() => service.memoryRemember({ kind: "wrong", scope: "user", content: "x", source: "x" }), /kind/);
    assert.throws(() => service.memoryRemember({ kind: "fact", scope: "wrong", content: "x", source: "x" }), /scope/);
    assert.throws(() => service.memoryRemember({ kind: "fact", scope: "workspace", content: "x", source: "x" }), /workspace_id/);
    assert.throws(() => service.memoryRemember({ kind: "fact", scope: "task", content: "x", source: "x" }), /task_id/);
    assert.throws(() => service.memoryRemember({ kind: "fact", scope: "user", content: "x", source: "x", valid_until: "never" }), /ISO/);
    service.memoryRemember({ memory_id: "old", kind: "fact", scope: "user", content: "old", source: "x" });
    service.memoryTransition({ memory_id: "old", status: "superseded" });
    assert.throws(() => service.memoryRemember({ kind: "fact", scope: "user", content: "new", source: "x", supersedes_id: "old" }), /active/);
    service.memoryRemember({ memory_id: "workspace_old", kind: "fact", scope: "workspace", workspace_id: "one", content: "old", source: "x" });
    assert.throws(() => service.memoryRemember({ kind: "fact", scope: "user", content: "new", source: "x", supersedes_id: "workspace_old" }), /same scope/);
    assert.throws(() => service.contextAssemble({ query: "x", limit: 0 }), /positive/);
    assert.throws(() => service.contextAssemble({ query: "x", max_chars: 0 }), /positive/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
