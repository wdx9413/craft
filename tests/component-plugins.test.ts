import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { COMPONENT_SURFACE_NAMES, McpServer, domainSurfaceOf, surfaceToolNames } from "../src/mcp.ts";
import { componentForSurface, surfaceToolNames as resolveSurfaceToolNames } from "../src/interfaces/mcp/surface-registry.ts";
import { assertExecutionHostMode, defaultExecutionHostMode, executionHostDescriptor } from "../src/host-protocol.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { dataSpaceId } from "../src/data-space.ts";
import { MCP_PRODUCT_NAMES, productSurfaceOf, resolveMcpProductMode } from "../src/interfaces/mcp/product-launch.ts";
import { RELEASE_PRODUCTS } from "../src/release-catalog.ts";

const components = RELEASE_PRODUCTS.map((product) => product.name);
const internalComponentSurfaces = ["component-context", "component-quality", "component-knowledge", "component-memory", "component-capability", "component-skill-quality", "component-experience"] as const;

test("public MCP products resolve only maintained install products", () => {
  assert.deepEqual(MCP_PRODUCT_NAMES, ["full", "knowledge", "memory", "experience"]);
  assert.equal(productSurfaceOf("full"), "syscall");
  assert.equal(productSurfaceOf("knowledge"), "component-knowledge-daily");
  assert.equal(productSurfaceOf("memory"), "component-memory-daily");
  assert.equal(productSurfaceOf("experience"), "component-experience-daily");
  assert.equal(resolveMcpProductMode([], {}), "syscall");
  assert.equal(resolveMcpProductMode(["--surface", "component-memory"], {}), "component-memory");
  assert.equal(resolveMcpProductMode([], { CRAFT_MCP_PRODUCT: "memory" }), "component-memory-daily");
  assert.equal(resolveMcpProductMode(["--product", "memory", "--surface", "component-memory-daily"], {}), "component-memory-daily");
  assert.throws(() => resolveMcpProductMode(["--product", "unknown"], {}), /Unknown Craft MCP product/);
  assert.throws(() => resolveMcpProductMode(["--product"], {}), /requires a value/);
  assert.throws(() => resolveMcpProductMode(["--surface", "--product"], {}), /requires a value/);
  assert.throws(() => resolveMcpProductMode(["--product", "memory", "--product", "memory"], {}), /only once/);
  assert.throws(() => resolveMcpProductMode(["--product", "memory", "--surface", "component-knowledge"], {}), /conflict/);
  assert.throws(() => resolveMcpProductMode([], { CRAFT_MCP_PRODUCT: "memory", CRAFT_MCP_SURFACE: "component-knowledge" }), /conflict/);
  assert.throws(() => productSurfaceOf("context"), /Unknown Craft MCP product/);
});

test("internal component surfaces remain bounded while only three cognition products are installable", () => {
  assert.deepEqual(COMPONENT_SURFACE_NAMES, internalComponentSurfaces);
  const expected = {
    "component-context": "craft_memory_ledger_remember",
    "component-quality": "craft_evaluation_run_record",
    "component-knowledge": "craft_knowledge_claim_save",
    "component-memory": "craft_memory_ledger_remember",
    "component-capability": "craft_capability_search",
    "component-skill-quality": "craft_evaluation_run_record",
    "component-experience": "craft_experience_observe",
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
  assert.equal(componentForSurface("component-knowledge"), "knowledge");
  assert.equal(componentForSurface("component-knowledge-daily"), "knowledge");
  assert.equal(componentForSurface("component-memory"), "memory");
  assert.equal(componentForSurface("component-memory-daily"), "memory");
  assert.equal(componentForSurface("component-experience"), "experience");
  assert.equal(componentForSurface("component-experience-daily"), "experience");
  assert.equal(componentForSurface("component-context"), undefined);
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
  // Daily products must not advertise actions that are absent from a stale or
  // deliberately minimal Host catalog.  This covers both sides of the bounded
  // projection filter rather than relying on the full catalog only.
  assert.deepEqual(resolveSurfaceToolNames("component-knowledge-daily", tools, core), []);
  assert.deepEqual(resolveSurfaceToolNames("component-memory-daily", [], core), []);
  assert.throws(() => resolveSurfaceToolNames("not-a-surface", tools, core), /Unknown Craft MCP surface/);
});

test("component plugin manifests use public MCP products rather than internal surface names", async () => {
  for (const name of components) {
    const manifest = JSON.parse(await readFile(`plugins/${name}/.codex-plugin/plugin.json`, "utf8"));
    const mcp = JSON.parse(await readFile(`plugins/${name}/.mcp.json`, "utf8"));
    const server = mcp.mcpServers[name];
    assert.equal(manifest.name, name);
    assert.equal(manifest.version, VERSION);
    if (["craft-knowledge", "craft-memory", "craft-experience"].includes(name)) assert.equal(manifest.hooks, "./hooks/codex-hooks.json");
    const product = name === "craft" ? "full" : name === "craft-experience" ? "experience" : name.slice(6);
    assert.deepEqual(server.args, ["dist/plugin/craft-mcp.cjs", "--product", product]);
  }
});

test("Knowledge, Memory, and Experience declare equivalent command-only lifecycle Hooks for Codex and Claude", async () => {
  const expected = {
    "craft-knowledge": { member: "knowledge", events: ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"] },
    "craft-memory": { member: "memory", events: ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"] },
    "craft-experience": { member: "experience", events: ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"] },
  } as const;
  for (const [name, contract] of Object.entries(expected)) {
    const codex = JSON.parse(await readFile(`plugins/${name}/.codex-plugin/plugin.json`, "utf8")) as { hooks?: string };
    const claude = JSON.parse(await readFile(`plugins/${name}/.claude-plugin/plugin.json`, "utf8")) as { hooks?: string };
    assert.equal(codex.hooks, "./hooks/codex-hooks.json");
    assert.equal(claude.hooks, "./hooks/hooks.json");
    const codexConfig = JSON.parse(await readFile(`plugins/${name}/hooks/codex-hooks.json`, "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ type?: string; command?: string; additionalContextLimit?: unknown }> }>>;
    };
    const claudeConfig = JSON.parse(await readFile(`plugins/${name}/hooks/hooks.json`, "utf8")) as typeof codexConfig;
    for (const [config, root] of [[codexConfig, "PLUGIN_ROOT"], [claudeConfig, "CLAUDE_PLUGIN_ROOT"]] as const) {
      assert.deepEqual(Object.keys(config.hooks), contract.events);
      assert.doesNotMatch(JSON.stringify(config), /mcp_tool|additionalContextLimit/u);
      for (const group of Object.values(config.hooks).flat()) {
        for (const handler of group.hooks) {
        assert.equal(handler.type, "command");
          assert.equal(handler.command, `node "\${${root}}/dist/plugin/craft-codex-hook.cjs" --member ${contract.member}`);
        }
      }
    }
  }
});

test("the knowledge and memory products can bootstrap provenance, persist bounded memory, and resolve one scoped receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-memory-component-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const service = new CraftService(store); const knowledge = new McpServer(service, "component-knowledge"); const memory = new McpServer(service, "component-memory");
    assert.equal(service.info().data_space_id, dataSpaceId(root));
    assert.notEqual(dataSpaceId(root), dataSpaceId(`${root}-other`));
    await knowledge.handlers.craft_knowledge_bootstrap_install({});
    const remembered = await memory.handlers.craft_memory_ledger_remember({
      memory_id: "context-memory", source_id: "builtin.evidence-wiki", kind: "working", scope_kind: "project", scope_id: "demo", content: "Keep changes incremental.", confidence: "bounded",
    });
    assert.equal((remembered.memory as { id: string }).id, "context-memory");
    const resolved = await memory.handlers.craft_context_resolution_resolve({
      receipt_id: "context-receipt", query: "incremental change", scope_kind: "project", scope_id: "demo", memory_ids: ["context-memory"], max_items: 3, max_chars: 200,
    });
    assert.equal((resolved.receipt as { id: string }).id, "context-receipt");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("built-in evidence source keeps the known pre-content-store locator without weakening unknown drift checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-legacy-builtin-source-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const service = new CraftService(store);
    service.knowledgeSourceRegister({ source_id: "builtin.evidence-wiki", kind: "evidence_wiki", label: "Craft Evidence Wiki", scope_kind: "user", scope_id: "local", locator: "~/.craft_data/wiki", content_digest: "builtin:evidence-wiki:v1", trust: "verified", access: "proposal_only" });
    assert.equal((service.knowledgeMemoryInstallBuiltins().sources as JsonObject[])[0]!.locator, "~/.craft_data/wiki");
    assert.throws(() => service.knowledgeSourceRegister({ source_id: "builtin.evidence-wiki", kind: "evidence_wiki", label: "Craft Evidence Wiki", scope_kind: "user", scope_id: "local", locator: "unexpected://locator", content_digest: "builtin:evidence-wiki:v1", trust: "verified", access: "proposal_only" }), /idempotency conflict/);
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
