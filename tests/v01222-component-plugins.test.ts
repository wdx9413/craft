import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { COMPONENT_SURFACE_NAMES, McpServer, surfaceToolNames } from "../src/mcp.ts";
import { assertExecutionHostMode, defaultExecutionHostMode, executionHostDescriptor } from "../src/host-protocol.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore } from "../src/store.ts";
import { craftPaths } from "../src/paths.ts";

const components = ["craft-knowledge", "craft-memory", "craft-capability", "craft-skill-quality", "craft-workflow-evolution"] as const;

test("v0.12.24 exposes five bounded component surfaces without the full work runtime", () => {
  assert.deepEqual(COMPONENT_SURFACE_NAMES, components.map((name) => `component-${name.slice(6)}`));
  const expected = {
    "component-knowledge": "craft_knowledge_claim_save",
    "component-memory": "craft_memory_ledger_remember",
    "component-capability": "craft_capability_search",
    "component-skill-quality": "craft_evaluation_run_record",
    "component-workflow-evolution": "craft_workflow_evolution_observe",
  } as const;
  for (const [surface, tool] of Object.entries(expected)) {
    const names = surfaceToolNames(surface);
    assert(names.length > 0, `${surface} must expose tools`);
    assert(names.includes(tool), `${surface} must expose ${tool}`);
    assert(!names.includes("craft_verified_work_loop_prepare"));
  }
  assert(surfaceToolNames("component-knowledge").includes("craft_retrieval_adapter_evaluate"));
  assert(surfaceToolNames("component-memory").includes("craft_retrieval_adapter_evaluate"));
});

test("component plugin manifests mount their exact surface", async () => {
  for (const name of components) {
    const manifest = JSON.parse(await readFile(`plugins/${name}/.codex-plugin/plugin.json`, "utf8"));
    const mcp = JSON.parse(await readFile(`plugins/${name}/.mcp.json`, "utf8"));
    const server = mcp.mcpServers[name];
    assert.equal(manifest.name, name);
    assert.equal(manifest.version, VERSION);
    assert.deepEqual(server.args, ["dist/plugin/craft-mcp.cjs", "--surface", `component-${name.slice(6)}`]);
  }
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
