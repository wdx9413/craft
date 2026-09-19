import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { COMPONENT_SURFACE_NAMES, McpServer, domainSurfaceOf, surfaceToolNames } from "../src/mcp.ts";
import { surfaceToolNames as resolveSurfaceToolNames } from "../src/interfaces/mcp/surface-registry.ts";
import { assertExecutionHostMode, defaultExecutionHostMode, executionHostDescriptor } from "../src/host-protocol.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore } from "../src/infrastructure/store.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { dataSpaceId } from "../src/data-space.ts";
import { MCP_PRODUCT_NAMES, productSurfaceOf, resolveMcpProductMode } from "../src/interfaces/mcp/product-launch.ts";

const components = ["craft-context", "craft-quality", "craft-knowledge", "craft-memory", "craft-capability", "craft-skill-quality", "craft-experience"] as const;

test("public MCP products resolve to bounded Runtime surfaces while legacy surfaces remain an explicit escape hatch", () => {
  assert.deepEqual(MCP_PRODUCT_NAMES, ["full", "context", "knowledge", "memory", "capability", "quality", "experience", "admin"]);
  assert.equal(productSurfaceOf("full"), "syscall");
  assert.equal(productSurfaceOf("context"), "component-context");
  assert.equal(productSurfaceOf("knowledge"), "component-knowledge");
  assert.equal(productSurfaceOf("memory"), "component-memory");
  assert.equal(productSurfaceOf("capability"), "component-capability");
  assert.equal(productSurfaceOf("quality"), "component-quality");
  assert.equal(productSurfaceOf("experience"), "component-experience");
  assert.equal(productSurfaceOf("admin"), "full");
  assert.equal(resolveMcpProductMode([], {}), "syscall");
  assert.equal(resolveMcpProductMode(["--product", "context"], {}), "component-context");
  assert.equal(resolveMcpProductMode(["--surface", "component-memory"], {}), "component-memory");
  assert.equal(resolveMcpProductMode([], { CRAFT_MCP_PRODUCT: "quality" }), "component-quality");
  assert.equal(resolveMcpProductMode(["--product", "memory", "--surface", "component-memory"], {}), "component-memory");
  assert.throws(() => resolveMcpProductMode(["--product", "unknown"], {}), /Unknown Craft MCP product/);
  assert.throws(() => resolveMcpProductMode(["--product"], {}), /requires a value/);
  assert.throws(() => resolveMcpProductMode(["--surface", "--product"], {}), /requires a value/);
  assert.throws(() => resolveMcpProductMode(["--product", "context", "--product", "context"], {}), /only once/);
  assert.throws(() => resolveMcpProductMode(["--product", "context", "--surface", "component-memory"], {}), /conflict/);
  assert.throws(() => resolveMcpProductMode([], { CRAFT_MCP_PRODUCT: "context", CRAFT_MCP_SURFACE: "component-memory" }), /conflict/);
});

test("component products expose a deep context and generic quality surface without the full work runtime", () => {
  assert.deepEqual(COMPONENT_SURFACE_NAMES, components.map((name) => `component-${name.slice(6)}`));
  const expected = {
    "component-context": "craft_memory_ledger_remember",
    "component-quality": "craft_evaluation_run_record",
    "component-knowledge": "craft_knowledge_claim_save",
    "component-memory": "craft_memory_ledger_remember",
    "component-capability": "craft_capability_search",
    "component-skill-quality": "craft_evaluation_run_record",
    "component-experience": "craft_workflow_evolution_observe",
  } as const;
  for (const [surface, tool] of Object.entries(expected)) {
    const names = surfaceToolNames(surface);
    assert(names.length > 0, `${surface} must expose tools`);
    assert(names.includes(tool), `${surface} must expose ${tool}`);
    assert(!names.includes("craft_verified_work_loop_prepare"));
  }
  assert(surfaceToolNames("component-context").includes("craft_knowledge_claim_save"));
  assert(surfaceToolNames("component-context").includes("craft_memory_ledger_remember"));
  assert(surfaceToolNames("component-context").includes("craft_context_resolution_resolve"));
  assert(surfaceToolNames("component-context").includes("craft_retrieval_adapter_evaluate"));
  assert(surfaceToolNames("component-quality").includes("craft_harness_configuration_save"));
  assert(surfaceToolNames("component-quality").includes("craft_acceptance_plan_save"));
  assert(surfaceToolNames("component-quality").includes("craft_delivery_evaluation_run"));
  assert.deepEqual(surfaceToolNames("component-quality"), surfaceToolNames("component-skill-quality"));
  for (const surface of ["component-context", "component-knowledge", "component-memory"]) {
    assert(surfaceToolNames(surface).includes("craft_knowledge_bootstrap_install"));
  }
});

test("surface registry keeps generic quality and every bounded projection deterministic", () => {
  assert.equal(domainSurfaceOf("craft_capability_search"), "governance");
  assert.equal(domainSurfaceOf("craft_evaluation_run_record"), "evaluation");
  assert.equal(domainSurfaceOf("craft_runtime_readiness_get"), "execution");
  assert.equal(domainSurfaceOf("craft_context_resolution_get"), "knowledge");
  assert.equal(domainSurfaceOf("craft_workspace_get"), "workspace");
  assert.equal(domainSurfaceOf("craft_a2a_delegation_get"), "collaboration");
  assert.equal(domainSurfaceOf("craft_unknown_operation"), "workflow");
  assert.equal(domainSurfaceOf("unknown_operation"), "workflow");

  const tools = [
    { name: "craft_info" }, { name: "craft_evaluation_run_record" }, { name: "craft_workspace_get" }, { name: "craft_source_list" },
  ] as never[];
  const core = new Set(["craft_info", "craft_workspace_get"]);
  assert.deepEqual(resolveSurfaceToolNames("full", tools, core), ["craft_info", "craft_evaluation_run_record", "craft_workspace_get", "craft_source_list"]);
  assert.deepEqual(resolveSurfaceToolNames("core", tools, core), ["craft_info", "craft_workspace_get"]);
  assert.deepEqual(resolveSurfaceToolNames("syscall", tools, core), ["craft_describe", "craft_list", "craft_get", "craft_create", "craft_update", "craft_run", "craft_cancel", "craft_search", "craft_info", "craft_default_route", "craft_default_route_resume", "craft_default_route_find", "craft_default_route_execute", "craft_task_checkpoint", "craft_evidence_record", "craft_knowledge_bootstrap_install"]);
  assert.deepEqual(resolveSurfaceToolNames("evaluation", tools, core), ["craft_evaluation_run_record"]);
  assert.throws(() => resolveSurfaceToolNames("not-a-surface", tools, core), /Unknown Craft MCP surface/);
});

test("component plugin manifests use public MCP products rather than internal surface names", async () => {
  for (const name of components) {
    const manifest = JSON.parse(await readFile(`plugins/${name}/.codex-plugin/plugin.json`, "utf8"));
    const mcp = JSON.parse(await readFile(`plugins/${name}/.mcp.json`, "utf8"));
    const server = mcp.mcpServers[name];
    assert.equal(manifest.name, name);
    assert.equal(manifest.version, VERSION);
    const product = name === "craft-skill-quality" ? "quality" : name === "craft-experience" ? "experience" : name.slice(6);
    assert.deepEqual(server.args, ["dist/plugin/craft-mcp.cjs", "--product", product]);
  }
});

test("the context component can bootstrap provenance, persist bounded memory, and resolve one scoped receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-context-component-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const service = new CraftService(store); const server = new McpServer(service, "component-context");
    assert.equal(service.info().data_space_id, dataSpaceId(root));
    assert.notEqual(dataSpaceId(root), dataSpaceId(`${root}-other`));
    await server.handlers.craft_knowledge_bootstrap_install({});
    const remembered = await server.handlers.craft_memory_ledger_remember({
      memory_id: "context-memory", source_id: "builtin.evidence-wiki", kind: "working", scope_kind: "project", scope_id: "demo", content: "Keep changes incremental.", confidence: "bounded",
    });
    assert.equal((remembered.memory as { id: string }).id, "context-memory");
    const resolved = await server.handlers.craft_context_resolution_resolve({
      receipt_id: "context-receipt", query: "incremental change", scope_kind: "project", scope_id: "demo", memory_ids: ["context-memory"], max_items: 3, max_chars: 200,
    });
    assert.equal((resolved.receipt as { id: string }).id, "context-receipt");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Execution Host protocol distinguishes embedded, managed, and remote execution", () => {
  const embedded = executionHostDescriptor("codex-app", "embedded");
  assert.deepEqual(embedded, { id: "codex-app", mode: "embedded", executesOutsideCraft: true, startsChildProcess: false, receiptRequired: true });
  assert.equal(executionHostDescriptor("codex-cli", "managed").startsChildProcess, true);
  assert.equal(executionHostDescriptor("a2a-agent", "remote").startsChildProcess, false);
  assert.equal(assertExecutionHostMode("embedded"), "embedded");
  assert.equal(defaultExecutionHostMode("codex-cli"), "managed");
  assert.equal(defaultExecutionHostMode("local-worker"), "managed");
  assert.equal(defaultExecutionHostMode("A2A:research"), "remote");
  assert.equal(defaultExecutionHostMode("remote:worker"), "remote");
  assert.equal(defaultExecutionHostMode("codex-app"), "embedded");
  assert.throws(() => assertExecutionHostMode("other"), /Unsupported Execution Host mode/);
  assert.throws(() => executionHostDescriptor(" ", "embedded"), /must not be empty/);
});

test("component McpServer cannot call tools outside its mounted boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-components-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const server = new McpServer(new CraftService(store), "component-capability");
    assert(server.tools.some((tool) => tool.name === "craft_capability_search"));
    assert(!server.tools.some((tool) => tool.name === "craft_verified_work_loop_prepare"));
    const response = await server.handle({ id: 1, method: "tools/call", params: { name: "craft_verified_work_loop_prepare", arguments: {} } });
    assert.equal((response?.error as { code: number }).code, -32602);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
