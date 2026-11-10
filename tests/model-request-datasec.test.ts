import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { CraftService } from "../core/service.ts";
import { saveSettingsSync } from "../core/settings.ts";
import { buildChatRequest, PROVIDER_CATALOG, type ModelTransport } from "../core/model-gateway.ts";

test("model requests protect task context, current input, history and approved Mod", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-request-datasec-"));
  const store = await new CraftStore(craftPaths(root)).open();
  let observed = "";
  const transport: ModelTransport = { complete: async (_provider, request) => {
    observed = JSON.stringify(request.body);
    return { text: "ok", model: "fake", usage: null };
  } };
  try {
    saveSettingsSync({ models: [{ id: "m", name: "M", protocol: "openai-compatible", baseUrl: "https://example.test/v1", model: "test", apiKeyEnv: "TEST_KEY", supportsTools: false }] }, store.paths);
    const service = new CraftService(store, undefined, undefined, undefined, undefined, undefined, undefined, undefined, transport);
    const task = (service.taskOpen({ title: "test", goal: "目标业务 pwd=synthetic-goal-value", model_id: "m" }) as JsonObject).task as JsonObject;
    service.modCreate({ id: "safe-rule", name: "rule", body: "保留业务 pwd=synthetic-mod-value", scope_kind: "global" });
    service.modApprove({ id: "safe-rule", approved_by: "human" });
    store.create("task_message", "historic", { task_id: task.id, role: "user", content: "历史业务 pwd=synthetic-history-value", model_id: "m" });
    await service.taskMessageSend({ task_id: task.id, content: "当前业务 pwd=synthetic-current-value" });
    assert.doesNotMatch(observed, /synthetic-(?:goal|mod|history|current)-value/u);
    for (const term of ["目标业务", "保留业务", "历史业务", "当前业务"]) assert.match(observed, new RegExp(term, "u"));
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("outbound tool call arguments preserve valid JSON and ordinary fields", () => {
  const request = buildChatRequest(PROVIDER_CATALOG[0]!, { model: "test", messages: [{ role: "assistant", content: null,
    tool_calls: [{ id: "call", type: "function", function: { name: "search", arguments: JSON.stringify({ query: "ordinary", token: "synthetic-tool-value" }) } }] }] });
  const calls = ((request.body.messages as JsonObject[])[0].tool_calls as JsonObject[]);
  const args = JSON.parse(String((calls[0].function as JsonObject).arguments)) as JsonObject;
  assert.equal(args.query, "ordinary");
  assert.doesNotMatch(JSON.stringify(args), /synthetic-tool-value/u);
});

test("outbound tool schemas redact sensitive examples without changing schema shape", () => {
  const tools = [{ type: "function" as const, function: { name: "search", description: "Search api_key=synthetic-description-value",
    parameters: { type: "object", nullable: null, additionalProperties: false, properties: {
      token: { type: "string", default: "synthetic-default-value", description: "ordinary field", examples: [null, false, "synthetic-example-value"] },
      query: { type: "string", default: "ordinary-default" } }, required: ["token"] } } }];
  const request = buildChatRequest(PROVIDER_CATALOG[0]!, { model: "test", messages: [{ role: "user", content: "search" }], tools, stream: true });
  assert.equal(request.body.stream, true);
  const serializedTools = JSON.stringify(request.body.tools);
  assert.doesNotMatch(serializedTools, /synthetic-(?:description|default)-value/u);
  assert.match(serializedTools, /ordinary field/u);
  assert.match(serializedTools, /ordinary-default/u);
  assert.doesNotMatch(serializedTools, /synthetic-example-value/u);
  const sent = request.body.tools as typeof tools;
  assert.deepEqual(sent[0]?.function.parameters, { type: "object", nullable: null, additionalProperties: false, properties: {
    token: { type: "string", default: "[REDACTED]", description: "ordinary field", examples: [null, false, "[REDACTED]"] },
    query: { type: "string", default: "ordinary-default" } }, required: ["token"] });
  const anthropic = PROVIDER_CATALOG.find((provider) => provider.protocol === "anthropic")!;
  const anthropicRequest = buildChatRequest(anthropic, { model: "test", messages: [{ role: "user", content: "search" }], tools, stream: true });
  const anthropicTools = anthropicRequest.body.tools as JsonObject[];
  const anthropicSchema = anthropicTools[0]?.input_schema as JsonObject;
  assert.equal(anthropicRequest.body.stream, true);
  assert.doesNotMatch(JSON.stringify(anthropicSchema), /synthetic-default-value/u);
  assert.doesNotMatch(JSON.stringify(anthropicSchema), /synthetic-example-value/u);
  assert.match(JSON.stringify(anthropicSchema), /ordinary field/u);
});

test("outbound tool schemas fail closed when nested beyond the redaction limit", () => {
  let parameters: JsonObject = { type: "string" };
  for (let depth = 0; depth < 65; depth += 1) parameters = { items: parameters };
  assert.throws(() => buildChatRequest(PROVIDER_CATALOG[0]!, { model: "test", messages: [{ role: "user", content: "x" }],
    tools: [{ type: "function", function: { name: "deep", parameters } }] }), /redaction limit/u);
});
