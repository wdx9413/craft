import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

test("bounded context profiles remain separate from generic task-graph execution", async () => {
  const root = join(tmpdir(), `craft-context-profile-${process.pid}-${Date.now()}`); const worktree = join(root, "workspace");
  const store = await new CraftStore(craftPaths(join(root, "craft"))).open(); const service = new CraftService(store);
  try {
    await mkdir(worktree, { recursive: true });
    const task = service.taskOpen({ title: "Lesson", goal: "Create an editable lesson" }).task as JsonObject;
    service.workspaceOpen({ workspace_id: "lesson_ws", name: "Lesson workspace", root_path: worktree, include_paths: ["docs"] });
    service.workObjectPut({ workspace_id: "lesson_ws", object_id: "brief", object_type: "brief", name: "Lesson brief", data: { grade: 5 }, expected_state_revision: 1 });
    service.workObjectPut({ workspace_id: "lesson_ws", object_id: "plan", object_type: "plan", name: "Lesson plan", data: { topic: "fractions" }, expected_state_revision: 2 });
    service.memoryRemember({ memory_id: "preference", kind: "preference", scope: "user", content: "Use editable visual materials", source: "user" });
    service.memoryRemember({ memory_id: "fact", kind: "fact", scope: "task", task_id: task.id, content: "The lesson targets grade five", source: "brief" });
    const profile = service.contextProfileSave({ profile_id: "lesson_context", name: "Lesson authoring", task_id: task.id, workspace_id: "lesson_ws",
      memory_kinds: ["preference", "fact"], object_types: ["brief"], required_memory_ids: ["preference"], required_object_ids: ["brief"], max_items: 3, max_chars: 1_000 }).profile as JsonObject;
    const assembled = service.contextProfileAssemble({ profile_id: profile.id, profile_version: profile.version, query: "grade" }) as JsonObject;
    assert.deepEqual(((assembled.context as JsonObject).items as JsonObject[]).map((item) => item.source_id), ["brief", "preference", "fact"]);
    assert.equal((((assembled.context as JsonObject).items as JsonObject[])[0]).required, true);
    const revised = service.contextProfileSave({ profile_id: "lesson_context", name: "Lesson authoring v2", task_id: task.id, workspace_id: "lesson_ws",
      required_memory_ids: ["preference"], required_object_ids: ["brief"], max_items: 2, max_chars: 1_000 }).profile as JsonObject;
    assert.equal(revised.version, 2);
    assert.equal(((service.contextProfileAssemble({ profile_id: profile.id, profile_version: 1, query: "grade" }).profile as JsonObject).name), "Lesson authoring");
    assert.throws(() => service.contextProfileAssemble({ profile_id: profile.id, query: "grade", task_id: "wrong" }), /Task/);
    assert.throws(() => service.contextProfileAssemble({ profile_id: profile.id, query: "grade", workspace_id: "wrong" }), /Workspace/);
    assert.throws(() => service.contextProfileSave({ name: "bad", required_object_ids: ["brief"] }), /workspace/);
    assert.throws(() => service.contextProfileSave({ name: "bad", required_memory_ids: ["fact"] }), /scope/);
    assert.throws(() => service.contextProfileSave({ name: "bad", memory_kinds: ["wrong"] }), /unsupported/);
    assert.throws(() => service.contextProfileSave({ name: "bad", max_items: 0 }), /positive/);
    assert.equal((service.contextProfileSave({ name: "Empty profile" }).profile as JsonObject).task_id, null);
    assert.equal((service.contextProfileSave({ profile_id: profile.id }).profile as JsonObject).name, "Lesson authoring v2");
    assert.throws(() => service.contextAssemble({ query: "grade", workspace_id: "lesson_ws", required_memory_ids: ["fact"] }), /unavailable/);
    assert.throws(() => service.contextAssemble({ query: "grade", workspace_id: "lesson_ws", object_types: ["brief"], required_object_ids: ["plan"] }), /unavailable/);
    assert.throws(() => service.contextAssemble({ query: "grade", task_id: task.id, workspace_id: "lesson_ws", required_memory_ids: ["preference"], max_chars: 1 }), /exceeds/);

    const graph = service.taskGraphCreate({ graph_id: "lesson_graph", name: "Lesson delivery", task_id: task.id, workspace_id: "lesson_ws", nodes: [
      { id: "research", title: "Research", objective: "Read the brief", kind: "explore", context_profile_id: profile.id, context_profile_version: 2 },
      { id: "draft", title: "Draft", objective: "Make a lesson", kind: "produce", depends_on: ["research"], context_profile_id: profile.id, context_profile_version: 2 },
      { id: "review", title: "Review", objective: "Check lesson", kind: "review", depends_on: ["draft"] },
    ] }).graph as JsonObject;
    assert.deepEqual((service.taskGraphCreate({ name: "Tiny", nodes: [{ id: "only", title: "Only", objective: "Do", kind: "deliver" }] }).ready_node_ids), ["only"]);
    assert.throws(() => service.taskGraphCreate({ name: "bad", nodes: [] }), /at least one/);
    assert.throws(() => service.taskGraphCreate({ name: "bad", nodes: [null] }), /object/);
    assert.throws(() => service.taskGraphCreate({ name: "bad", nodes: [{ id: "a", title: "A", objective: "A", kind: "explore" }, { id: "a", title: "Again", objective: "Again", kind: "review" }] }), /Duplicate/);
    assert.throws(() => service.taskGraphCreate({ name: "bad", nodes: [{ id: "a", title: "A", objective: "A", kind: "explore", depends_on: ["a"] }] }), /itself/);
    assert.throws(() => service.taskGraphCreate({ name: "bad", nodes: [{ id: "bad", title: "Bad", objective: "Bad", kind: "unknown" }] }), /kind/);
    assert.throws(() => service.taskGraphCreate({ name: "bad", nodes: [{ id: "a", title: "A", objective: "A", kind: "explore", depends_on: ["b"] }] }), /unknown/);
    assert.throws(() => service.taskGraphCreate({ name: "bad", nodes: [{ id: "a", title: "A", objective: "A", kind: "explore", depends_on: ["b"] }, { id: "b", title: "B", objective: "B", kind: "review", depends_on: ["a"] }] }), /cycle/);
    assert.throws(() => service.taskGraphCreate({ name: "bad", task_id: task.id, nodes: [{ id: "a", title: "A", objective: "A", kind: "explore", context_profile_id: profile.id, context_profile_version: 2 }] }), /workspace/);
    assert.throws(() => service.taskGraphCreate({ name: "bad", nodes: [{ id: "a", title: "A", objective: "A", kind: "explore", context_profile_version: 2 }] }), /requires/);
    assert.throws(() => service.taskGraphCreate({ name: "bad", nodes: [{ id: "a", title: "A", objective: "A", kind: "explore", context_profile_id: profile.id, context_profile_version: 0 }] }), /positive/);
    assert.throws(() => service.taskGraphAdvance({ graph_id: graph.id, node_id: "draft", status: "active" }), /dependencies/);
    const afterResearch = service.taskGraphAdvance({ graph_id: graph.id, node_id: "research", status: "done" });
    assert.deepEqual(afterResearch.ready_node_ids, ["draft"]);
    const afterDraft = service.taskGraphAdvance({ graph_id: graph.id, node_id: "draft", status: "blocked" });
    assert.equal((afterDraft.graph as JsonObject).status, "blocked");
    assert.equal((((afterDraft.graph as JsonObject).nodes as JsonObject[]).find((node) => node.id === "review") as JsonObject).status, "blocked");
    assert.throws(() => service.taskGraphAdvance({ graph_id: graph.id, node_id: "draft", status: "done" }), /terminal/);
    assert.throws(() => service.taskGraphAdvance({ graph_id: graph.id, node_id: "research", status: "pending" }), /unsupported/);
    assert.throws(() => service.taskGraphAdvance({ graph_id: graph.id, node_id: "missing", status: "done" }), /Unknown/);
    const anotherTask = service.taskOpen({ title: "Other", goal: "Other goal" }).task as JsonObject;
    const taskOnly = service.contextProfileSave({ profile_id: "task_only", name: "Task only", task_id: task.id }).profile as JsonObject;
    assert.throws(() => service.taskGraphCreate({ name: "bad", task_id: anotherTask.id, nodes: [{ id: "a", title: "A", objective: "A", kind: "explore", context_profile_id: taskOnly.id, context_profile_version: taskOnly.version }] }), /task/);
    const capabilities = join(worktree, "capabilities"); await mkdir(capabilities, { recursive: true }); await writeFile(join(capabilities, "SKILL.md"), "---\nname: profile capability\ndescription: profile\n---\nbody");
    const source = await service.sourceAdd({ path: capabilities, priority: 1 });
    assert.equal((service.sourceUpdate({ source_id: source.id, priority: 2 }) as JsonObject).priority, 2);
    const mcp = new McpServer(service, "full");
    for (const [name, arguments_] of Object.entries({
      craft_context_profile_get: { profile_id: profile.id }, craft_context_profile_list: {}, craft_task_graph_get: { graph_id: graph.id }, craft_task_graph_list: {},
      craft_context_profile_assemble: { profile_id: profile.id, query: "grade" },
      craft_logical_capability_list: {},
    })) {
      const result = await mcp.handle({ id: name, method: "tools/call", params: { name, arguments: arguments_ } });
      assert.equal((result?.result as JsonObject).isError, false, name);
    }
    const savedProfile = await mcp.handle({ id: "profile-save", method: "tools/call", params: { name: "craft_context_profile_save",
      arguments: { profile_id: "mcp_context", name: "MCP Context", max_items: 1, max_chars: 100 } } });
    assert.equal((savedProfile?.result as JsonObject).isError, false);
    const mcpGraph = await mcp.handle({ id: "graph-create", method: "tools/call", params: { name: "craft_task_graph_create", arguments: {
      graph_id: "mcp_graph", name: "MCP graph", nodes: [{ id: "one", title: "One", objective: "Do it", kind: "deliver" }],
    } } });
    assert.equal((mcpGraph?.result as JsonObject).isError, false);
    const advanced = await mcp.handle({ id: "graph-advance", method: "tools/call", params: { name: "craft_task_graph_advance",
      arguments: { graph_id: "mcp_graph", node_id: "one", status: "done" } } });
    assert.equal((advanced?.result as JsonObject).isError, false);
    assert.equal(((service.contextProfileAssemble({ profile_id: "mcp_context", query: "anything" }).profile as JsonObject).id), "mcp_context");
    assert.equal(VERSION, "0.11.59");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
