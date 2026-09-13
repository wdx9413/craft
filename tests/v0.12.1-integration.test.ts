import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";
import { craftPaths } from "../src/paths.ts";
import { McpServer } from "../src/mcp.ts";
import { defineHostProfile, type HostProfile } from "../src/host-registry.ts";
import { KnowledgeIndex, locateSnippet } from "../src/knowledge-index.ts";

async function fixture(name: string, hostProfiles?: HostProfile[]) {
  const root = await mkdtemp(join(tmpdir(), `craft-v0121-${name}-${process.pid}-`));
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store, undefined, undefined, undefined, undefined, undefined, hostProfiles);
  return { root, store, service };
}

test("host profile list and resolve via MCP", async () => {
  const declared = defineHostProfile({ host: "deepseek-cli", kind: "agent-cli", command: "deepseek", output_format: "text", argv_template: ["-p", "{prompt}"] });
  const f = await fixture("host", [declared]);
  try {
    const mcp = new McpServer(f.service, "full");
    const list = await mcp.handlers.craft_host_profile_list({}) as JsonObject;
    assert.ok((list.profiles as JsonObject[]).some((p) => p.host === "deepseek-cli"));
    const resolved = await mcp.handlers.craft_host_profile_resolve({ host: "deepseek-cli" }) as JsonObject;
    assert.equal((resolved.profile as JsonObject).host, "deepseek-cli");
    await assert.rejects(async () => mcp.handlers.craft_host_profile_resolve({ host: "missing" }), /Unknown/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("workflow registry scan and retirement plan via MCP", async () => {
  const f = await fixture("wf");
  try {
    await mkdir(join(f.root, "workflows"), { recursive: true });
    await writeFile(join(f.root, "workflows", "a.workflow.json"), JSON.stringify({ id: "a", title: "A", steps: [{ type: "command", command: ["echo"] }] }));
    const mcp = new McpServer(f.service, "full");
    const scan = await mcp.handlers.craft_workflow_registry_scan({ project_root: join(f.root, "workflows") }) as JsonObject;
    assert.equal((scan.descriptors as JsonObject[]).length, 1);
    // Create a workflow_run to feed usage
    f.store.create("workflow_run", "run1", { workflow_id: "a", workflow_version: 1, status: "passed", created_at: new Date().toISOString() });
    const plan = await mcp.handlers.craft_workflow_retirement_plan({}) as JsonObject;
    assert.ok(Array.isArray(plan.decisions));
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("knowledge index sync and search via MCP", async () => {
  const f = await fixture("kn");
  try {
    await writeFile(join(f.root, "doc.md"), "# Hello\nCraft 确定性工作流");
    const mcp = new McpServer(f.service, "full");
    const sync = await mcp.handlers.craft_knowledge_index_sync({ project_root: f.root }) as JsonObject;
    assert.equal(sync.documents, 1);
    const search = await mcp.handlers.craft_knowledge_search({ query: "工作流" }) as JsonObject;
    assert.ok((search.hits as JsonObject[]).length >= 1);
    // short single-char token triggers LIKE fallback
    const short = await mcp.handlers.craft_knowledge_search({ query: "工" }) as JsonObject;
    assert.ok((short.hits as JsonObject[]).length >= 1);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("execution budget plan via MCP", async () => {
  const f = await fixture("budget");
  try {
    const mcp = new McpServer(f.service, "full");
    const plan = await mcp.handlers.craft_execution_budget_plan({ host: "codex-cli", limit: 10000, texts: ["hello world"] }) as JsonObject;
    assert.ok(typeof plan.estimated_tokens === "number");
    assert.equal(plan.exceeded, false);
    assert.ok(plan.complexity);
    assert.ok(plan.routing);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("hook catalog and run via MCP", async () => {
  const f = await fixture("hook");
  try {
    const mcp = new McpServer(f.service, "full");
    const catalog = await mcp.handlers.craft_hook_catalog({ point: "before_step", hooks: [{ id: "a", point: "before_step", kind: "builtin", target: "builtin:audit-log" }] }) as JsonObject;
    assert.equal((catalog.hooks as JsonObject[]).length, 1);
    const run = await mcp.handlers.craft_hook_run({ point: "before_step", hooks: [{ id: "a", point: "before_step", kind: "builtin", target: "builtin:audit-log" }] }) as JsonObject;
    assert.equal(run.blocked, false);
    // command hook triggers the non-builtin invoker branch
    const commandRun = await mcp.handlers.craft_hook_run({ point: "before_step", hooks: [{ id: "b", point: "before_step", kind: "command", target: "echo hi" }] }) as JsonObject;
    assert.equal(commandRun.blocked, true);
    assert.ok((commandRun.outcomes as JsonObject[])[0].detail);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("KnowledgeIndex apply rollback on error", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-kn-rollback-"));
  try {
    const idx = new KnowledgeIndex(join(root, "index.db"));
    const plan = { added: [{ path: "missing.md", digest: "d", size_bytes: 1, chunks: 1 }], changed: [], removed: [] };
    assert.throws(() => idx.apply(plan, root), /ENOENT/);
    idx.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("KnowledgeIndex apply removes documents", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-kn-rm-"));
  try {
    await writeFile(join(root, "a.md"), "x");
    const idx = new KnowledgeIndex(join(root, "index.db"));
    idx.apply({ added: [{ path: "a.md", digest: "d1", size_bytes: 1, chunks: 1 }], changed: [], removed: [] }, root);
    assert.equal(idx.status().documents, 1);
    idx.apply({ added: [], changed: [], removed: [{ path: "a.md", digest: "d1", size_bytes: 1, chunks: 1 }] }, root);
    assert.equal(idx.status().documents, 0);
    idx.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("locateSnippet no-match fallback", () => {
  const snippet = locateSnippet("hello world", ["xyz"]);
  assert.equal(snippet, "hello world".slice(0, 200));
});
