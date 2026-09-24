import assert from "node:assert/strict";
import test from "node:test";
import { ACTIVE_TOOLS } from "../core/interfaces/mcp-server.ts";
import type { Tool } from "../core/mcp/tool-schema.ts";
import { tool } from "../core/mcp/tool-schema.ts";
import type { ChatToolDefinition } from "../core/model-gateway.ts";
import { INTERNAL_ONLY_TOOLS } from "../core/internal-host-driver.ts";
import { DEFAULT_INTERNAL_AUTHORIZATION, TOOL_AUTHORIZATIONS, actionNameOf, authorizationAllows, authorizedTools,
  classifyTool, internalToolDefinitions, toChatToolDefinition } from "../core/internal-tool-authorization.ts";

type ParameterSchema = { name: string; type: string; enum?: string[] };

function parametersOf(converted: ReturnType<typeof toChatToolDefinition>): { properties: object; required?: string[] } {
  const parameters = converted.function.parameters;
  assert.ok(parameters, "a converted tool must always carry a parameter schema");
  return parameters as { properties: object; required?: string[] };
}

test("the tier classifier never lets the loop approve its own work by default", () => {
  assert.deepEqual([...DEFAULT_INTERNAL_AUTHORIZATION], ["read", "candidate"]);
  assert.deepEqual([...TOOL_AUTHORIZATIONS], ["read", "candidate", "governed", "forbidden"]);
  // Reads.
  assert.equal(classifyTool("craft_knowledge_search"), "read");
  assert.equal(classifyTool("craft_capability_get"), "read");
  assert.equal(classifyTool("craft_memory_ledger_get"), "read");
  // Candidate: propose / observe / record, still needing a governed decision.
  assert.equal(classifyTool("craft_memory_remember"), "candidate");
  assert.equal(classifyTool("craft_task_checkpoint"), "candidate");
  assert.equal(classifyTool("craft_experience_ledger_observe"), "candidate");
  assert.equal(classifyTool("craft_evidence_record"), "candidate");
  // Governed: publish / promote / decide / rollback.
  assert.equal(classifyTool("craft_wiki_skill_candidate_publication_authorize"), "governed");
  assert.equal(classifyTool("craft_contract_publish"), "governed");
  assert.equal(classifyTool("craft_attention_decide"), "governed");
  assert.equal(classifyTool("craft_runtime_policy_save"), "governed");
  // Forbidden: sandbox, credentials, isolation, egress and host config.
  assert.equal(classifyTool("craft_credential_lease_issue"), "forbidden");
  assert.equal(classifyTool("craft_sandbox_egress_deliver"), "forbidden");
  assert.equal(classifyTool("craft_docker_run"), "forbidden");
  assert.equal(classifyTool("craft_isolation_capability_get"), "forbidden");
});

test("the mount gate is a plain membership check over the mounted tiers", () => {
  assert.equal(authorizationAllows(DEFAULT_INTERNAL_AUTHORIZATION, "read"), true);
  assert.equal(authorizationAllows(DEFAULT_INTERNAL_AUTHORIZATION, "candidate"), true);
  assert.equal(authorizationAllows(DEFAULT_INTERNAL_AUTHORIZATION, "governed"), false);
  assert.equal(authorizationAllows(DEFAULT_INTERNAL_AUTHORIZATION, "forbidden"), false);
  assert.equal(authorizationAllows([], "read"), false);
});

test("an unrecognised verb fails closed to governed rather than opening the loop", () => {
  assert.equal(classifyTool("craft_widget_frobnicate"), "governed");
  assert.equal(classifyTool("craft_info"), "read");
});

test("forbidden syntax wins over a knowledge-looking name", () => {
  assert.equal(classifyTool("craft_knowledge_credential_get"), "forbidden");
});

test("a non-craft name keeps its own terminal segment for classification", () => {
  assert.equal(classifyTool("widget_get"), "read");
  assert.equal(classifyTool("widget_credential_save"), "forbidden");
  // A dotted / hyphenated tail still resolves to its own final segment.
  assert.equal(classifyTool("craft"), "governed");
});

test("authorizedTools projects the catalog down to the mounted tiers", () => {
  const catalog: Tool[] = [
    tool("craft_alpha_get", "read", [], true),
    tool("craft_beta_remember", "candidate"),
    tool("craft_gamma_publish", "governed"),
    tool("craft_credential_lease_issue", "forbidden"),
  ];
  assert.deepEqual(authorizedTools(catalog, DEFAULT_INTERNAL_AUTHORIZATION).map((item) => item.name),
    ["craft_alpha_get", "craft_beta_remember"]);
  assert.equal(authorizedTools(catalog, ["read", "candidate", "governed"]).length, 3);
  assert.equal(authorizedTools(catalog, ["forbidden"]).map((item) => item.name)[0], "craft_credential_lease_issue");
});

test("a canonical tool becomes the model-facing chat tool with the same parameters", () => {
  const source = tool("craft_knowledge_search", "Search bounded project knowledge.", ["query"], true, ["limit", "tier"]);
  const converted = toChatToolDefinition(source);
  assert.equal(converted.type, "function");
  assert.equal(converted.function.name, "knowledge_search");
  assert.equal(converted.function.description, "Search bounded project knowledge.");
  assert.deepEqual(parametersOf(converted).required, ["query"]);
  assert.deepEqual(Object.keys(parametersOf(converted).properties), ["query", "limit", "tier"]);
  assert.equal(actionNameOf("craft_x"), "x");
  assert.equal(actionNameOf("plain"), "plain");
});

test("a schema without required fields or with an unknown type still converts", () => {
  const bare = tool("craft_probe", "Bare probe.");
  const converted = toChatToolDefinition(bare);
  assert.equal(parametersOf(converted).required, undefined);
  const odd = { name: "craft_odd", description: "Odd.", inputSchema: {
    type: "object", properties: { flag: { type: "weird" }, mode: { type: "string", enum: ["a", "b"] } } } };
  const oddConverted = toChatToolDefinition(odd);
  assert.deepEqual(parametersOf(oddConverted).properties, {
    flag: { type: "string" }, mode: { type: "string", enum: ["a", "b"] } });
});

test("a real catalog enum is carried into the model-facing schema", () => {
  const withEnum = tool("craft_probe", "Probe.", [], true, ["mode"]);
  const replaced: Tool = { ...withEnum, inputSchema: {
    type: "object",
    properties: { mode: { type: "string", enum: ["fast", "safe"] } },
    required: ["mode"] } };
  const params = parametersOf(toChatToolDefinition(replaced)).properties as Record<string, ParameterSchema>;
  assert.deepEqual(params.mode, { type: "string", enum: ["fast", "safe"] });
});

test("a tool that declares no properties still becomes a callable function", () => {
  const bare = { name: "craft_bare", description: "No declared inputs.", inputSchema: { type: "object" } };
  const converted = toChatToolDefinition(bare);
  assert.deepEqual(parametersOf(converted).properties, {});
  assert.equal(parametersOf(converted).required, undefined);
});

test("the internal catalog only exposes read and candidate tools by default", () => {
  const definitions = internalToolDefinitions(() => ACTIVE_TOOLS);
  assert.ok(definitions.length > 0);
  const names = definitions.map((definition) => definition.function.name);
  assert.ok(names.includes("knowledge_search"));
  assert.ok(names.includes("memory_remember"));
  assert.ok(!names.includes("credential_lease_issue"));
  assert.ok(!names.includes("contract_publish"));
  // Every emitted name is a real action, never a duplicate of another.
  assert.equal(new Set(names).size, names.length);
  // An explicit mount can widen the loop to governed tools, never to forbidden.
  const widened = internalToolDefinitions(() => ACTIVE_TOOLS, ["read", "candidate", "governed"]);
  assert.ok(widened.length > definitions.length);
  assert.ok(!widened.some((definition) => definition.function.name === "credential_lease_issue"));
});

test("loop-only actions are unioned in without shadowing a canonical tool", () => {
  const extra: ChatToolDefinition = { type: "function", function: {
    name: "workspace_write", description: "Loop-only write.", parameters: { type: "object", properties: {} } } };
  const withExtra = internalToolDefinitions(() => ACTIVE_TOOLS, DEFAULT_INTERNAL_AUTHORIZATION, [extra]);
  assert.ok(withExtra.some((definition) => definition.function.name === "workspace_write"));
  // The catalog already carries `integration_prepare`; an extra of the same name
  // must not create a duplicate and must not replace the canonical definition.
  const canonical = tool("craft_integration_prepare", "Canonical description.");
  const shadow: ChatToolDefinition = { type: "function", function: {
    name: "integration_prepare", description: "Shadow.", parameters: { type: "object", properties: {} } } };
  const merged = internalToolDefinitions(() => [canonical], DEFAULT_INTERNAL_AUTHORIZATION, [shadow]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].function.description, "Canonical description.");
});

test("the projection is narrowed to the actions the service can actually route", () => {
  const one = tool("craft_capability_search", "Search bounded capabilities.");
  // A mounted tier is necessary but not sufficient: a name the service cannot
  // route is never offered, because the loop cannot answer a call it cannot
  // resolve and one unanswered call ends a run.
  const routed = internalToolDefinitions(() => [one], DEFAULT_INTERNAL_AUTHORIZATION, [],
    () => new Set(["capability_search"]));
  assert.deepEqual(routed.map((definition) => definition.function.name), ["capability_search"]);
  const unroutable = internalToolDefinitions(() => [one], DEFAULT_INTERNAL_AUTHORIZATION, [],
    () => new Set(["knowledge_search"]));
  assert.deepEqual(unroutable, []);
  // Loop-only extras are exempt: the caller that names them also dispatches them,
  // so their presence is itself the assertion that they can be answered.
  const extra: ChatToolDefinition = { type: "function", function: {
    name: "workspace_read", description: "Read.", parameters: { type: "object", properties: {} } } };
  const withExtra = internalToolDefinitions(() => [one], DEFAULT_INTERNAL_AUTHORIZATION, [extra], () => new Set());
  assert.deepEqual(withExtra.map((definition) => definition.function.name), ["workspace_read"]);
});

test("the internal host's loop-only exports are exactly the workspace pair", () => {
  assert.deepEqual(INTERNAL_ONLY_TOOLS.map((definition) => definition.function.name),
    ["workspace_read", "workspace_write"]);
});
