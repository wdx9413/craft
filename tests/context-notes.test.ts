import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";
import { TOOLS } from "../core/mcp/tool-catalog.ts";
import { resolveContextNotes } from "../core/context-notes.ts";
import { classifyTool } from "../core/internal-tool-authorization.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "craft-directory-context-"));
  const store = await new CraftStore(craftPaths(join(root, ".craft_data"))).open();
  const service = new CraftService(store);
  return { root, store, service, registry: service.craftNotesLocation,
    async close() { await store.close(); rmSync(root, { recursive: true, force: true }); } };
}
const entries = (value: JsonObject) => value.results as JsonObject[];

test("directory recall shares the registry without recording, promoting or opening projects", async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "not-created");
    f.registry.record({ path, description: "结算服务：不要修改生产配置" });
    const before = f.registry.list();
    assert.deepEqual(entries(f.service.contextNotesResolve({ description: "结算" })), []);
    const byPath = f.service.contextNotesResolve({ path });
    assert.equal(entries(byPath)[0]!.description, "结算服务：不要修改生产配置");
    assert.equal(entries(byPath)[0]!.status, "observed");
    assert.equal(byPath.access_granted, false);
    assert.deepEqual(f.registry.list(), before);
    f.registry.promote({ id: entries(byPath)[0]!.id });
    const promoted = f.registry.list();
    const found = f.service.contextNotesResolve({ description: "结算", limit: 1, max_chars: 4_000 });
    assert.equal(entries(found)[0]!.path, path);
    assert.equal(found.partial, false);
    assert.deepEqual(f.registry.list(), promoted);
  } finally { await f.close(); }
});

test("Context Worker operations call the Notes and Memory owners without exposing candidate content", async () => {
  const f = await fixture();
  try {
    const server = new McpServer(f.service, "component-context-complete");
    const notesResponse = await server.handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: {
      name: "craft_notes_qualification_run", arguments: { limit: 10 },
    } }) as JsonObject;
    const notesResult = notesResponse.result as JsonObject;
    assert.equal(notesResult.isError, false, JSON.stringify(notesResponse));
    const notes = notesResult.structuredContent as JsonObject;
    assert.equal(notes.processed, 0);
    assert.equal(notes.qualified, 0);
    const memoryResponse = await server.handle({ jsonrpc: "2.0", id: 8, method: "tools/call", params: {
      name: "craft_memory_promotion_run", arguments: { limit: 10 },
    } }) as JsonObject;
    const memoryResult = memoryResponse.result as JsonObject;
    assert.equal(memoryResult.isError, false, JSON.stringify(memoryResponse));
    const memory = memoryResult.structuredContent as JsonObject;
    assert.equal(memory.processed, 0);
    assert.equal(memory.promoted, 0);
  } finally { await f.close(); }
});

test("directory material is bounded without truncating conditions or treating cloud hints as access", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 6; i++) f.registry.record({ path: join(f.root, `repo-${i}`), description: `支付模块 ${i}：仅当验收通过后使用`, promote: true, host_kind: i === 0 ? "cloud" : "local" });
    const normal = resolveContextNotes(f.registry, { description: "支付" });
    assert.equal(entries(normal).length, 3);
    assert.equal(normal.omitted_count, 3);
    assert.equal(normal.partial, true);
    assert.equal(normal.registry_scan_limit, 1_000);
    assert.equal(normal.coverage, "bounded_registry_lookup");
    assert.equal(entries(resolveContextNotes(f.registry, { path: join(f.root, "repo-0") }))[0]!.host_kind, "cloud");
    assert(JSON.stringify(entries(normal)).length <= 1_200);
    const firstSize = JSON.stringify([entries(normal)[0]]).length;
    const exact = resolveContextNotes(f.registry, { description: "支付", max_chars: firstSize });
    assert.equal(entries(exact).length, 1);
    assert.match(String(entries(exact)[0]!.description), /仅当验收通过后使用$/u);
    const tooSmall = resolveContextNotes(f.registry, { description: "支付", max_chars: 1 });
    assert.equal(entries(tooSmall).length, 0);
    assert.equal(tooSmall.omitted_count, 6);
    assert.equal(tooSmall.partial, true);
    assert.equal(entries(resolveContextNotes(f.registry, { description: "支付", limit: 5, max_chars: 4_000 })).length, 5);
    assert.deepEqual(entries(resolveContextNotes(f.registry, { path: join(f.root, "missing") })), []);
  } finally { await f.close(); }
});

test("directory queries reject ambiguous selectors and invalid limits before lookup", async () => {
  const f = await fixture();
  try {
    for (const args of [{}, { path: f.root, description: "repo" }]) assert.throws(() => resolveContextNotes(f.registry, args), /exactly one/u);
    for (const limit of [0, 6, 1.5, "3", true]) assert.throws(() => resolveContextNotes(f.registry, { path: f.root, limit }), /limit must/u);
    for (const max_chars of [0, 4_001, 1.5, "100", false]) assert.throws(() => resolveContextNotes(f.registry, { path: f.root, max_chars }), /max_chars must/u);
    for (const args of [{ path: "relative" }, { description: "" }, { description: "a".repeat(501) }]) assert.throws(() => resolveContextNotes(f.registry, args));
  } finally { await f.close(); }
});

test("Context exposes read-only directory schemas, discovery and routed MCP calls", async () => {
  const f = await fixture();
  try {
    const tool = TOOLS.find(t => t.name === "craft_notes_context_resolve")!;
    assert.equal(tool.annotations!.readOnlyHint, true);
    assert.equal(classifyTool(tool.name), "read");
    const discovered = f.service.contextToolsDiscover({ intent: "recall" });
    const tools = discovered.tools as JsonObject[];
    const discoveredTool = tools.find(t => t.name === tool.name)!;
    assert.deepEqual((discoveredTool.syscall_route as JsonObject).arguments, { resource: "notes_context", operation: "resolve", args: {} });
    f.registry.record({ path: join(f.root, "repo"), description: "目录查询测试", promote: true });
    for (const mode of ["component-context-agent", "component-context-daily", "component-context-complete"]) {
      const server = new McpServer(f.service, mode);
      assert(server.tools.some(t => t.name === tool.name));
      const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool.name, arguments: { description: "目录查询" } } }) as JsonObject;
      const result = response.result as JsonObject;
      assert.equal(result.isError, false, JSON.stringify(response));
      assert.equal(entries(result.structuredContent as JsonObject).length, 1);
    }
    const server = new McpServer(f.service, "component-context-agent");
    const routed = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "craft_run", arguments: { resource: "notes_context", operation: "resolve", args: { path: join(f.root, "repo") } } } }) as JsonObject;
    assert.equal((routed.result as JsonObject).isError, false, JSON.stringify(routed));
    assert.equal(entries((routed.result as JsonObject).structuredContent as JsonObject).length, 1);
    for (const args of [{}, { path: f.root, description: "repo" }, { description: "x", limit: "5" }, { path: f.root, promote: true }, { path: f.root, max_chars: 4_001 }]) {
      const rejected = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: tool.name, arguments: args } }) as JsonObject;
      assert(rejected.error || (rejected.result as JsonObject).isError, JSON.stringify(rejected));
    }
    assert(!new McpServer(f.service, "component-knowledge-daily").tools.some(t => t.name === tool.name));
  } finally { await f.close(); }
});
