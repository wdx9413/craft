import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer, SYSCALL_TOOLS, TOOL_REGISTRY, TOOLS, VERB_DEFAULT_OPERATION, surfaceToolNames } from "../core/mcp.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { buildRegistry, catalogOf, findEntry, measureSurface, parseToolName, resolveEntry } from "../core/tool-plane.ts";

test("the registry is a lossless re-index of every legacy tool", () => {
  assert.equal(TOOL_REGISTRY.length, TOOLS.length);
  assert.deepEqual(TOOL_REGISTRY.map((entry) => entry.tool).sort(), TOOLS.map((tool) => tool.name).sort());
  const keys = TOOL_REGISTRY.map((entry) => `${entry.resource}.${entry.operation}`);
  assert.equal(new Set(keys).size, keys.length, "every (resource, operation) pair must be unique");
  for (const entry of TOOL_REGISTRY) {
    assert.ok(entry.resource.length > 0 && entry.operation.length > 0);
    assert.ok(["read_only", "local_write", "external_write", "destructive"].includes(entry.effect));
    assert.equal(entry.approval_required, entry.effect !== "read_only");
    assert.ok(entry.timeout_ms > 0);
  }
});

test("tool name parsing keeps multi-word resources and honours trailing verbs", () => {
  assert.deepEqual(parseToolName("craft_capability_search"), { resource: "capability", operation: "search" });
  assert.deepEqual(parseToolName("craft_default_route_execute"), { resource: "default_route", operation: "execute" });
  assert.deepEqual(parseToolName("craft_verified_work_loop_receipt"), { resource: "verified_work_loop", operation: "receipt" });
  assert.deepEqual(parseToolName("craft_memory_ledger_remember"), { resource: "memory_ledger", operation: "remember" });
  assert.deepEqual(parseToolName("craft_memory_ledger_transition"), { resource: "memory_ledger", operation: "transition" });
  assert.deepEqual(parseToolName("craft_info"), { resource: "info", operation: "info" });
  assert.deepEqual(parseToolName("craft_something_unknownsuffix"), { resource: "something_unknownsuffix", operation: "info" });
  assert.deepEqual(parseToolName("not_prefixed"), { resource: "not_prefixed", operation: "info" });
});

test("registry construction fails closed on a duplicate address", () => {
  const colliding = [
    { name: "craft_thing_get", description: "a", inputSchema: { type: "object", properties: {} } },
    { name: "craft_thing_get", description: "b", inputSchema: { type: "object", properties: {} } },
  ];
  assert.throws(() => buildRegistry(colliding), /registry collision/);
});

test("effect, risk and audit metadata follow the declared read-only hint", () => {
  const [readOnly] = buildRegistry([{ name: "craft_thing_get", description: "x",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, annotations: { readOnlyHint: true } }]);
  assert.equal(readOnly.effect, "read_only");
  assert.equal(readOnly.risk, "low");
  assert.equal(readOnly.approval_required, false);
  assert.equal(readOnly.audit_policy, "never");
  assert.deepEqual(readOnly.required, ["id"]);
  assert.deepEqual(readOnly.optional, []);

  const [destructive] = buildRegistry([{ name: "craft_thing_remove", description: "x", inputSchema: { type: "object", properties: {} } }]);
  assert.equal(destructive.effect, "destructive");
  assert.equal(destructive.risk, "high");
  assert.equal(destructive.audit_policy, "always");

  const [external] = buildRegistry([{ name: "craft_egress_send", description: "x", inputSchema: { type: "object", properties: {} } }]);
  assert.equal(external.effect, "external_write");
  assert.deepEqual(external.roles, ["owner"]);

  const [governed] = buildRegistry([{ name: "craft_supply_chain_reconcile", description: "x", inputSchema: { type: "object", properties: {} } }]);
  assert.deepEqual(governed.roles, ["owner", "admin"]);

  const [local] = buildRegistry([{ name: "craft_thing_apply", description: "x", inputSchema: { type: "object", properties: {} } }]);
  assert.equal(local.effect, "local_write");
  assert.equal(local.audit_policy, "on_write");
  assert.equal(local.idempotent, false);
});

test("resolution finds an address, falls back to the lone operation, and reports misses", () => {
  assert.equal(findEntry(TOOL_REGISTRY, "capability", "search")?.tool, "craft_capability_search");
  assert.equal(findEntry(TOOL_REGISTRY, "capability", "nope"), null);
  assert.equal(resolveEntry(TOOL_REGISTRY, "task", undefined, "list")?.tool, "craft_task_list");
  assert.equal(resolveEntry(TOOL_REGISTRY, "info", undefined, "get")?.tool, "craft_info");
  assert.equal(resolveEntry(TOOL_REGISTRY, "no_such_resource", undefined, "list"), null);
  const entry = resolveEntry(TOOL_REGISTRY, "task", "list", "list");
  assert.ok(entry);
  assert.equal(catalogOf([entry]).resources, 1);
});

test("every syscall verb but describe declares a default operation", () => {
  const verbs = ["craft_list", "craft_get", "craft_create", "craft_update", "craft_run", "craft_cancel", "craft_search"];
  assert.deepEqual(Object.keys(VERB_DEFAULT_OPERATION).sort(), [...verbs].sort());
  for (const verb of verbs) assert.ok(VERB_DEFAULT_OPERATION[verb].length > 0);
});

test("a tool with no declared properties yields an empty optional list", () => {
  const [bare] = buildRegistry([{ name: "craft_bare_apply", description: "x", inputSchema: { type: "object" } }]);
  assert.deepEqual(bare.required, []);
  assert.deepEqual(bare.optional, []);
});

test("the syscall surface is O(1) in tools and far below the full surface", () => {
  const syscall = surfaceToolNames("syscall");
  assert.equal(syscall.length, SYSCALL_TOOLS.length + 8);
  const mounted = [...TOOLS, ...SYSCALL_TOOLS].filter((tool) => syscall.includes(tool.name));
  const measured = measureSurface(mounted);
  assert.equal(measured.tools, syscall.length);
  // The point of the surface: an order of magnitude below the full tool list.
  assert.ok(measured.estimated_tokens < measureSurface(TOOLS).estimated_tokens / 10,
    `syscall surface must stay an order of magnitude below full (was ${measured.estimated_tokens} vs ${measureSurface(TOOLS).estimated_tokens})`);
});

test("craft_describe explains the catalog and then one exact operation", async () => {
  const root = join(tmpdir(), `craft-syscall-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const store = await new CraftStore(craftPaths(root)).open();
  const server = new McpServer(new CraftService(store), "syscall");
  const call = async (name: string, args: JsonObject): Promise<JsonObject> => {
    const response = await server.handle({ id: 1, method: "tools/call", params: { name, arguments: args } });
    const result = response?.result as JsonObject;
    assert.equal(result.isError, false, `${name}: ${JSON.stringify(result.content)}`);
    return result.structuredContent as JsonObject;
  };
  try {
    assert.equal(server.tools.length, surfaceToolNames("syscall").length);
    const catalog = await call("craft_describe", {});
    assert.ok(Number(catalog.resources) > 0);
    assert.equal(catalog.operations, TOOL_REGISTRY.length);

    const described = await call("craft_describe", { resource: "capability", operation: "search" });
    assert.equal(described.tool, "craft_capability_search");
    assert.equal(described.effect, "read_only");
    assert.deepEqual(described.required, ["query"]);

    const missing = await call("craft_describe", { resource: "no_such_thing" });
    assert.equal(missing.found, false);
    assert.ok(typeof missing.hint === "string");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("the primary syscall surface composes every built-in Craft component on demand", async () => {
  const root = join(tmpdir(), `craft-primary-composition-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const store = await new CraftStore(craftPaths(root)).open();
  const server = new McpServer(new CraftService(store), "syscall");
  const call = async (name: string, args: JsonObject): Promise<JsonObject> => {
    const response = await server.handle({ id: name, method: "tools/call", params: { name, arguments: args } });
    const result = response?.result as JsonObject;
    assert.equal(result.isError, false, `${name}: ${JSON.stringify(result.content)}`);
    return result.structuredContent as JsonObject;
  };
  const describe = async (resource: string, operation: string): Promise<JsonObject> => {
    return call("craft_describe", { resource, operation });
  };
  try {
    const initialized = await call("craft_knowledge_bootstrap_install", {});
    assert.deepEqual((initialized.sources as JsonObject[]).map((source) => source.id).sort(), [
      "builtin.evidence-wiki", "builtin.serena-project-knowledge",
    ]);
    const reinitialized = await call("craft_knowledge_bootstrap_install", {});
    assert.equal((reinitialized.sources as JsonObject[]).every((source) => source.status === "active"), true);
    const expected = [
      ["knowledge_source", "register", "craft_knowledge_source_register"],
      ["memory_ledger", "remember", "craft_memory_ledger_remember"],
      ["capability", "search", "craft_capability_search"],
      ["evaluation_run", "record", "craft_evaluation_run_record"],
      ["experience", "observe", "craft_experience_observe"],
    ] as const;
    for (const [resource, operation, tool] of expected) {
      const contract = await describe(resource, operation);
      assert.equal(contract.tool, tool);
    }
    assert.equal(server.tools.length, surfaceToolNames("syscall").length);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("syscall verbs dispatch to the same handler as the named tool", async () => {
  const root = join(tmpdir(), `craft-syscall-run-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const store = await new CraftStore(craftPaths(root)).open();
  const server = new McpServer(new CraftService(store), "syscall");
  const call = async (name: string, args: JsonObject): Promise<JsonObject> => {
    const response = await server.handle({ id: 2, method: "tools/call", params: { name, arguments: args } });
    const result = response?.result as JsonObject;
    assert.equal(result.isError, false, `${name}: ${JSON.stringify(result.content)}`);
    return result.structuredContent as JsonObject;
  };
  try {
    // create → the operation is named, because `task` has no `create` operation.
    const task = await call("craft_create", { resource: "task", operation: "open", args: { title: "T", goal: "G" } });
    assert.ok(String((task.task as JsonObject).id).startsWith("task_"));
    // get by explicit resource with a single operation
    const info = await call("craft_get", { resource: "info" });
    assert.ok(typeof info.version === "string");
    // search defaults to capabilities
    const search = await call("craft_search", { query: "nothing-matches-this" });
    assert.ok(typeof search === "object");
    // explicit operation on a multi-resource noun
    const budget = await call("craft_describe", { resource: "capability", operation: "search" });
    assert.equal(budget.operation, "search");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("syscall verbs fail closed on an unknown operation or a missing handler", async () => {
  const root = join(tmpdir(), `craft-syscall-fail-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const store = await new CraftStore(craftPaths(root)).open();
  const server = new McpServer(new CraftService(store), "syscall");
  const call = async (name: string, args: JsonObject) => {
    const response = await server.handle({ id: 3, method: "tools/call", params: { name, arguments: args } });
    return response?.result as JsonObject;
  };
  try {
    const unknown = await call("craft_update", { resource: "no_such_resource" });
    assert.equal(unknown.isError, true);
    assert.match((unknown.content as JsonObject[])[0].text as string, /Unknown Craft operation: no_such_resource$/);

    // A resource that exists but whose default operation does not: the message
    // names the resource alone, without inventing an operation.
    const ambiguous = await call("craft_update", { resource: "capability" });
    assert.equal(ambiguous.isError, true);
    assert.match((ambiguous.content as JsonObject[])[0].text as string, /Unknown Craft operation: capability$/);

    // A syscall surface may address any registered operation, but a registry row
    // whose handler is not installed must refuse rather than resolve to nothing.
    const reachable = await call("craft_list", { resource: "task" });
    assert.equal(reachable.isError, false);
    delete server.handlers.craft_task_list;
    const unbacked = await call("craft_list", { resource: "task" });
    assert.equal(unbacked.isError, true);
    assert.match((unbacked.content as JsonObject[])[0].text as string, /not mounted on this surface/);

    // A named tool outside the mounted surface must still be rejected up front.
    const outside = await server.handle({ id: 4, method: "tools/call", params: { name: "craft_source_add", arguments: {} } });
    assert.equal((outside?.error as { code: number }).code, -32602);
    // In full mode an unknown name has no handler and must fail as an unknown tool.
    const full = new McpServer(new CraftService(store), "full");
    const ghost = await full.handle({ id: 5, method: "tools/call", params: { name: "craft_not_a_tool", arguments: {} } });
    assert.equal((ghost?.error as { code: number }).code, -32602);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
