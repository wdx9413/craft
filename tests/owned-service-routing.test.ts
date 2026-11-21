import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openCapabilityService, openMcpRuntime } from "../core/interfaces/mcp/runtime.ts";
import { WorkbenchWebApp } from "../core/workbench-server.ts";
import { routeOwnedService } from "../core/application/owner-service.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";

test("Context public MCP composes its members and Runtime SDK and Workbench delegate to the same owner assets", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-owner-facade-")), project = mkdtempSync(join(tmpdir(), "craft-owner-workspace-"));
  writeFileSync(join(project, "verify.ts"), "export function verifyFixture() { return true; }\n");
  const env = { CRAFT_DATA_DIR: root };
  const context = await openMcpRuntime("component-context-agent", env);
  let runtime: Awaited<ReturnType<typeof openCapabilityService>> | undefined;
  try {
    assert(context.server.tools.some(tool => tool.name === "craft_context_open"));
    assert(context.server.tools.some(tool => tool.name === "craft_codebase_symbol_find"));
    runtime = await openCapabilityService("runtime", env);
    assert.equal(routeOwnedService(runtime.service), runtime.service);
    const memory = runtime.service.memoryCaptureUserStatement({ memory_id: "routed-memory", content: "I prefer short fixture explanations.",
      session_id: "facade-session", session_host: "codex", kind: "preference", topic: "explanations" });
    assert.equal(memory.auto_committed, true);
    assert.equal(runtime.store.find("memory_ledger", "routed-memory"), null);
    assert.equal(runtime.service.ownerServices.get("memory")!.store.get("memory_ledger", "routed-memory").status, "active");
    const open = await context.server.handle({ jsonrpc: "2.0", id: "open", method: "tools/call", params: { name: "craft_context_open", arguments: {
      project_root: project, query: "short fixture explanations", include_codebase: false, members: ["memory"], session_scope_id: "facade-session", session_id: "facade-session", session_host: "codex", response_detail: "full", max_tokens: 5000,
    } } });
    assert.equal(open?.error, undefined, JSON.stringify(open));
    assert.equal((open?.result as JsonObject).isError, false, JSON.stringify(open));
    assert.match(JSON.stringify(open), /routed-memory/u);
    const indexed = await context.server.handle({ jsonrpc: "2.0", id: "code", method: "tools/call", params: { name: "craft_context_open", arguments: {
      project_root: project, query: "verifyFixture code", include_codebase: true, response_detail: "full", max_tokens: 5000,
    } } });
    assert.equal((indexed?.result as JsonObject).isError, false, JSON.stringify(indexed));
    assert.match(JSON.stringify(indexed), /"status":"ready"/u);
    const knowledge = runtime.service.ownerServices.get("knowledge")!;
    knowledge.knowledgeMemoryInstallBuiltins();
    const evidence = knowledge.evidenceRecord({ source_type: "program", confidence: "bounded", claim: "Synthetic fixture input." });
    const app = new WorkbenchWebApp(runtime.service, "fixture", "http://127.0.0.1:4173");
    const saved = app.handle({ method: "POST", path: "/api/workbench/knowledge/claims", token: "fixture",
      body: JSON.stringify({ claim_id: "web-claim", content: "Verify fixture changes before accepting them.", kind: "rule", scope: "global", evidence_ids: [evidence.id] }) });
    assert.equal(saved.status, 201, String(saved.body));
    assert(knowledge.store.find("knowledge_claim", "web-claim"));
    assert.equal(runtime.store.find("knowledge_claim", "web-claim"), null);
    assert.equal(runtime.service.componentAssetInspect("knowledge", { asset_id: "web-claim", scope_kind: "global", scope_id: "global", action: "read", version: 1 }).kind, "knowledge_claim");
    assert.equal(typeof Reflect.get(runtime.service, Symbol.toStringTag), "undefined");
  } finally { runtime?.close(); context.close(); rmSync(root, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); }
});

test("independent owners reject unavailable foreign operations while retaining local Memory provenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-owner-missing-"));
  const memory = await openCapabilityService("memory", { CRAFT_DATA_DIR: root });
  try {
    assert.equal(memory.service.knowledgeMemoryInstallBuiltins().sources !== undefined, true);
    assert.throws(() => memory.service.knowledgeClaimSave({ content: "No foreign owner." }), /knowledge owner is unavailable/u);
    assert.throws(() => memory.service.contextWorkingSets, /context owner is unavailable/u);
    assert.throws(() => memory.service.taskList({}), /runtime owner is unavailable/u);
    const legacyRoot = join(root, "legacy-isolated");
    const store = await new CraftStore(craftPaths(legacyRoot)).open();
    try { const service = new CraftService(store); assert.equal(routeOwnedService(service), service); }
    finally { store.close(); }
  } finally { memory.close(); rmSync(root, { recursive: true, force: true }); }
});

test("owner authorization precedes prose access and metadata history survives a missing body", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-owner-preauth-"));
  const runtime = await openCapabilityService("memory", { CRAFT_DATA_DIR: root });
  const { unlinkSync } = await import("node:fs");
  try {
    runtime.service.memoryCaptureUserStatement({ memory_id: "private-body", content: "I prefer brief fixture notes.",
      scope_kind: "user", scope_id: "first-user", kind: "preference" });
    const args = { asset_id: "private-body", scope_kind: "user", scope_id: "first-user" };
    const reference = runtime.service.componentAssetInspect("memory", { ...args, action: "reference", version: 1 }).reference;
    const record = runtime.store.get("memory_ledger", "private-body");
    unlinkSync((record.content_ref as JsonObject).path as string);
    assert.throws(() => runtime.service.componentAssetInspect("memory", { ...args, scope_id: "other-user", action: "read", version: 1 }), /scope or audience denied/u);
    const history = runtime.service.componentAssetInspect("memory", args);
    assert.equal((history.versions as unknown[]).length, 1);
    assert.equal(runtime.service.componentAssetInspect("memory", { ...args, action: "resolve", reference }).status, "unavailable");
    assert.throws(() => runtime.service.memoryLedgerTransition({ memory_id: "private-body", scope_kind: "user", scope_id: "other-user", status: "revoked", reason: "Wrong scope." }), /scope or audience denied/u);
    assert.equal(runtime.store.findMetadata("memory_ledger", "private-body")?.status, "active");
  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a standalone Context without members reports unavailable without creating foreign assets", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-context-no-members-"));
  const project = mkdtempSync(join(tmpdir(), "craft-context-empty-project-"));
  const context = await openCapabilityService("context", { CRAFT_DATA_DIR: root, CRAFT_CONTEXT_MEMBERS: "" });
  try {
    const result = await context.service.contextOpen({ project_root: project, query: "fixture code", include_codebase: true });
    assert.equal(result.partial, true);
    assert.equal((result.codebase as JsonObject).status, "unavailable");
    assert.equal((result.knowledge_source_discovery as JsonObject).status, "unavailable");
    for (const kind of ["knowledge_source", "codebase_index", "craft_note"]) assert.equal(context.store.count(kind), 0);
    const app = new WorkbenchWebApp(context.service, "fixture", "http://127.0.0.1:4173");
    assert.equal(app.handle({ method: "GET", path: "/api/projects", token: "fixture" }).status, 503);
  } finally { context.close(); rmSync(root, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); }
});
