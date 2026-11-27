import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { McpServer } from "../core/mcp.ts";
import { CraftService } from "../core/service.ts";

test("Experience MCP publishes durable Work Item intake and fails closed without the Eval owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-experience-learning-work-item-mcp-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const server = new McpServer(new CraftService(store), "component-experience-daily");
    const listed = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const tools = ((listed?.result as { tools: Array<{ name: string; inputSchema: { required: string[] } }> }).tools);
    const tool = tools
      .find(entry => entry.name === "craft_experience_learning_evaluation_dispatch_next");
    assert.deepEqual(tool?.inputSchema.required, ["worker_id"]);
    assert.deepEqual(tools.find(entry => entry.name === "craft_experience_learning_work_item_block")?.inputSchema.required,
      ["work_item_id", "worker_id", "lease_token", "reason"]);
    assert.deepEqual(tools.find(entry => entry.name === "craft_experience_learning_work_item_resume")?.inputSchema.required,
      ["work_item_id", "expected_version"]);

    const response = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "craft_experience_learning_evaluation_dispatch_next", arguments: { worker_id: "mcp-worker" } } });
    const result = response?.result as { isError: boolean; content?: Array<{ text?: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content?.map(item => item.text ?? "").join("\n") ?? "", /require the Eval owner/u);
    assert.equal(store.count("experience_learning_work_item"), 0);
    assert.equal(store.count("experience_evaluation_dispatch"), 0);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Experience MCP accepts the signed Prompt receipt envelope on the existing result tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-experience-signed-receipt-mcp-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const server = new McpServer(new CraftService(store), "component-experience-daily");
    const listed = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const tools = ((listed?.result as { tools: Array<{ name: string; inputSchema: { required: string[]; properties: Record<string, unknown> } }> }).tools);
    const resultTool = tools.find(tool => tool.name === "craft_experience_learning_evaluation_result");
    assert.deepEqual(resultTool?.inputSchema.required, ["dispatch_id"]);
    for (const property of ["evaluator_request_id", "receipt", "signature"]) assert.ok(property in (resultTool?.inputSchema.properties ?? {}));
    const response = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
      name: "craft_experience_learning_evaluation_result", arguments: { dispatch_id: "missing-dispatch", evaluator_request_id: "request-1",
        receipt: { schema: "craft.experience-evaluation-receipt.v1" }, signature: "AA" } } });
    const result = response?.result as { isError: boolean; content?: Array<{ text?: string }> };
    assert.equal(result.isError, true);
    assert.doesNotMatch(result.content?.map(item => item.text ?? "").join("\n") ?? "", /unknown field|additional properties/u);
    assert.match(result.content?.map(item => item.text ?? "").join("\n") ?? "", /Unknown experience_evaluator_request/u);
    const missingDispatch = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
      name: "craft_experience_learning_evaluation_result", arguments: { evaluator_request_id: "request-1", receipt: {}, signature: "AA" } } });
    const missing = missingDispatch?.result as { isError: boolean; content?: Array<{ text?: string }> };
    assert.equal(missing.isError, true);
    assert.match(missing.content?.map(item => item.text ?? "").join("\n") ?? "", /dispatch_id/u);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});
