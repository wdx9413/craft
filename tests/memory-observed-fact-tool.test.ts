import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";
import { productSurfaceOf } from "../core/interfaces/mcp/product-launch.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";

test("standalone Memory MCP captures Host-classified facts into session scope without an explicit remember request", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-memory-observed-fact-"));
  const dataRoot = join(root, "data"), projectRoot = join(root, "project");
  await mkdir(projectRoot);
  const store = await new CraftStore(craftPaths(dataRoot)).open();
  const service = new CraftService(store), memory = new McpServer(service, productSurfaceOf("memory"));
  service.scopeAliasBind({ scope_kind: "project", scope_id: "project-a", alias_kind: "path", alias: projectRoot });
  try {
    assert.throws(() => service.memoryCaptureObservedFact({ content: "stable", project_scope_id: "project-a" }), /session_id/u);
    assert.throws(() => service.memoryCaptureObservedFact({ content: "stable", session_id: "session-a", project_scope_id: "project-a", scope_kind: "global" }), /session scope/u);
    assert.throws(() => service.memoryCaptureObservedFact({ content: "stable", session_id: "session-a", project_scope_id: "project-a", scope_id: "session-b" }), /match session_id/u);

    const listed = await memory.handle({ jsonrpc: "2.0", id: "list", method: "tools/list" });
    const tools = ((listed!.result as JsonObject).tools as JsonObject[]);
    const tool = tools.find(item => item.name === "craft_memory_capture_observed_fact")!;
    assert(tool, "standalone Memory MCP exposes the Host-classified capture entry point");
    const schema = tool.inputSchema as JsonObject;
    assert.deepEqual(schema.required, ["content", "session_id", "project_scope_id"]);

    const called = await memory.handle({ jsonrpc: "2.0", id: "capture", method: "tools/call", params: { name: "craft_memory_capture_observed_fact",
      arguments: { content: "Project uses pnpm for focused tests", session_id: "session-a", project_scope_id: "project-a", project_root: projectRoot,
        kind: "procedural", topic: "project.test-command" } } });
    const result = (called!.result as JsonObject).structuredContent as JsonObject;
    assert.equal((called!.result as JsonObject).isError, false, JSON.stringify(called));
    assert.equal(result.auto_committed, true);
    assert.equal((result.candidate as JsonObject).proposed_by, "host-observed-stable-fact");
    assert.deepEqual((result.memory as JsonObject).scope, { kind: "session", id: "session-a" });
    assert.equal((result.evidence as JsonObject).source_type, "host_observed_fact");
    assert.equal((result.evidence as JsonObject).confidence, "bounded");
    assert.equal((store.list("memory_ledger", 10)[0]!.scope as JsonObject).kind, "session");
    const replay = await memory.handle({ jsonrpc: "2.0", id: "capture-replay", method: "tools/call", params: { name: "craft_memory_capture_observed_fact",
      arguments: { content: "Project uses pnpm for focused tests", session_id: "session-a", project_scope_id: "project-a", project_root: projectRoot,
        kind: "procedural", topic: "project.test-command" } } });
    assert.equal((((replay!.result as JsonObject).structuredContent as JsonObject).already_retained), true);
    assert.equal(store.list("memory_ledger", 10).length, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
