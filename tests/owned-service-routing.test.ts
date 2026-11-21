import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openCapabilityService, openMcpRuntime } from "../core/interfaces/mcp/runtime.ts";
import { WorkbenchWebApp } from "../core/workbench-server.ts";
import { routeOwnedService } from "../core/application/owner-service.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftOperationError } from "../core/operation-error.ts";
import { learningOwnerFailureKind, openOwnedLearningClients } from "../deploy/experience-learning/owned-client.ts";

test("learning owner diagnostics retain only safe error class names", () => {
  assert.equal(learningOwnerFailureKind(new TypeError("private path")), "TypeError");
  assert.equal(learningOwnerFailureKind({ name: "SecretError", message: "private path" }), "Error");
  const invalid = new Error("private path"); invalid.name = "Secret Error";
  assert.equal(learningOwnerFailureKind(invalid), "Error");
});

test("owned learning clients report a safe reason when one owner cannot open", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-owner-open-failure-"));
  const seed = await openCapabilityService("notes", { CRAFT_DATA_DIR: root }); seed.close();
  writeFileSync(join(root, "notes", "publication.db"), "not a SQLite database");
  const originalWrite = process.stderr.write;
  let diagnostic = "";
  process.stderr.write = ((chunk: string | Uint8Array) => { diagnostic += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    const clients = await openOwnedLearningClients({ CRAFT_DATA_DIR: root });
    assert.equal(clients.hasContext, false);
    assert.match(diagnostic, /notes owner unavailable \(Error\)/u);
    clients.close();
  } finally {
    process.stderr.write = originalWrite;
    rmSync(root, { recursive: true, force: true });
  }
});

test("owned learning clients discover Notes owners created after the worker starts", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-late-notes-owner-"));
  const env = { CRAFT_DATA_DIR: root };
  const clients = await openOwnedLearningClients(env);
  const notes = await openCapabilityService("notes", env);
  try {
    notes.service.craftNotesCreateDevice({ id: "late-owner", note: "Created after worker startup." });
    notes.service.craftNotesObserveDirectory({ device_id: "late-owner", path: "/tmp/craft-late-owner", pin: true });
    const results = await Promise.all([clients.notes.call("craft_notes_candidate_list", { limit: 10 }),
      clients.notes.call("craft_notes_candidate_list", { limit: 10 })]);
    for (const result of results) {
      assert.equal((result.items as JsonObject[]).length, 1);
      assert.equal((result.items as JsonObject[])[0]?.device_id, "late-owner");
    }
  } finally { clients.close(); notes.close(); rmSync(root, { recursive: true, force: true }); }
});

test("owned learning clients report Context availability when its owner is mounted", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-context-owner-mounted-"));
  const env = { CRAFT_DATA_DIR: root };
  const context = await openCapabilityService("context", env);
  const clients = await openOwnedLearningClients(env);
  try { assert.equal(clients.hasContext, true); }
  finally { clients.close(); context.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Context public MCP composes its members and Runtime SDK and Workbench delegate to the same owner assets", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-owner-facade-")), project = mkdtempSync(join(tmpdir(), "craft-owner-workspace-"));
  writeFileSync(join(project, "verify.ts"), "export function verifyFixture() { return true; }\n");
  writeFileSync(join(project, "README.md"), "Verify every fixture before publishing.\n");
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
    const discovery = ((open?.result as JsonObject).structuredContent as JsonObject).knowledge_source_discovery as JsonObject;
    assert.equal(discovery.failed_ingests, 0, "the Knowledge owner must resolve the project root in its own scope catalog before ingesting");
    assert(Number(discovery.sources_ingested) > 0);
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

test("Context reports Knowledge-owned project identity migration errors without losing their code", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-knowledge-identity-failure-"));
  const project = mkdtempSync(join(tmpdir(), "craft-knowledge-identity-project-"));
  const context = await openMcpRuntime("component-context-agent", { CRAFT_DATA_DIR: root });
  try {
    const knowledge = context.server.service.ownerServices.get("knowledge")!;
    knowledge.scopeIdentityResolveProject = () => { throw new CraftOperationError("PROJECT_IDENTITY_MIGRATION_REQUIRED", "identity_migration", "migration required"); };
    const response = await context.server.handle({ jsonrpc: "2.0", id: "identity", method: "tools/call", params: { name: "craft_context_open", arguments: {
      project_root: project, query: "identity migration", include_codebase: false, members: ["knowledge"], response_detail: "full", max_tokens: 5000,
    } } });
    assert.equal((response?.result as JsonObject).isError, false, JSON.stringify(response));
    const result = (response?.result as JsonObject).structuredContent as JsonObject;
    const discovery = result.knowledge_source_discovery as JsonObject;
    assert.equal(discovery.failure_code, "PROJECT_IDENTITY_MIGRATION_REQUIRED");
  } finally { context.close(); rmSync(root, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); }
});

test("independent owners reject unavailable foreign operations while retaining local Memory provenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-owner-missing-"));
  const memory = await openCapabilityService("memory", { CRAFT_DATA_DIR: root });
  try {
    assert.throws(() => (memory.service as unknown as { notesOwner(): CraftService }).notesOwner(), /Notes owner is unavailable/u);
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

test("owned learning worker routes Memory and Notes passes to their own catalogs", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-owned-learning-routes-"));
  const env = { CRAFT_DATA_DIR: root };
  const memory = await openCapabilityService("memory", env), notes = await openCapabilityService("notes", env), codebase = await openCapabilityService("codebase", env);
  const clients = await openOwnedLearningClients(env);
  try {
    assert.equal(clients.hasContext, false);
    assert.equal(clients.hasContext, false, "repeated availability checks must honor the bounded discovery window");
    const memoryPass = await clients.memory.call("craft_memory_promotion_run", { limit: 10 });
    const notesPass = await clients.notes.call("craft_notes_qualification_run", { limit: 10 });
    assert.equal(memoryPass.processed, 0);
    assert.equal(notesPass.processed, 0);
    assert.equal(memory.service.ownerServices.get("notes"), undefined);
  } finally { clients.close(); memory.close(); notes.close(); codebase.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an unavailable owner blocks only its own learning pass", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-learning-owner-failure-"));
  const memory = await openCapabilityService("memory", { CRAFT_DATA_DIR: root });
  memory.close();
  mkdirSync(join(root, "notes", "publication.db"), { recursive: true });
  let diagnostics = "";
  const stderr = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { diagnostics += String(chunk); return true; }) as typeof process.stderr.write;
  let clients: Awaited<ReturnType<typeof openOwnedLearningClients>> | undefined;
  try {
    clients = await openOwnedLearningClients({ CRAFT_DATA_DIR: root });
    assert.equal((await clients.memory.call("craft_memory_promotion_run", { limit: 10 })).processed, 0);
    await assert.rejects(clients.notes.call("craft_notes_qualification_run", { limit: 10 }), /LearningOwnerUnavailable/u);
    assert.match(diagnostics, /notes owner unavailable/u);
  } finally {
    process.stderr.write = stderr;
    clients?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Context delegates every Notes mutation, review, and recall operation to the Notes owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-context-notes-delegation-"));
  const context = await openMcpRuntime("component-context-agent", { CRAFT_DATA_DIR: root, CRAFT_CONTINUOUS_LEARNING: "0" });
  try {
    const service = context.server.service;
    const notes = service.ownerServices.get("notes")!;
    notes.craftNotes.createDevice({ id: "local", note: "Fixture device." });
    const directory = service.craftNotesObserveDirectory({ device_id: "local", path: "/tmp/craft-notes-delegation", pin: true }).note as JsonObject;
    const file = service.craftNotesObserveFile({ device_id: "local", path: "/tmp/craft-notes-delegation/config.json", pin: true }).note as JsonObject;
    assert.equal((service.craftNotesCandidateList({ limit: 10 }).items as JsonObject[]).length, 2);
    assert.equal(service.craftNotesQualificationRun({ limit: 10 }).qualified, 2);
    const current = notes.store.find("craft_note", String(directory.id))!;
    assert.equal(service.craftNotesConfirm({ id: directory.id, expected_version: current.version }).status, "confirmed");
    assert.equal((service.craftNotesResolve({ device_id: "local", path: "/tmp/craft-notes-delegation" }).items as JsonObject[]).length, 2);
    const currentFile = notes.store.find("craft_note", String(file.id))!;
    assert.equal(service.craftNotesRevoke({ id: file.id, expected_version: currentFile.version, revoked_by: "fixture", reason: "done" }).status, "revoked");
    const ownedFile = notes.craftNotesObserveFile({ device_id: "local", path: "/tmp/craft-notes-owned/config.json", pin: true }).note as JsonObject;
    assert.equal((notes.craftNotesCandidateList({ limit: 10 }).items as JsonObject[]).length, 1);
    assert.equal(notes.craftNotesQualificationRun({ limit: 10 }).qualified, 1);
    const ownedFileCurrent = notes.store.find("craft_note", String(ownedFile.id))!;
    assert.equal(notes.craftNotesConfirm({ id: ownedFile.id, expected_version: ownedFileCurrent.version }).status, "confirmed");
    assert.equal((notes.craftNotesResolve({ device_id: "local", path: "/tmp/craft-notes-owned/config.json" }).items as JsonObject[]).length, 2);
    const finalVersion = notes.store.find("craft_note", String(ownedFile.id))!;
    assert.equal(notes.craftNotesRevoke({ id: ownedFile.id, expected_version: finalVersion.version, revoked_by: "fixture", reason: "done" }).status, "revoked");
  } finally { context.close(); rmSync(root, { recursive: true, force: true }); }
});

test("uncomposed CraftService routes each Notes method to its configured Notes owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-notes-service-routing-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const context = new CraftService(store), notes = new CraftService(store);
  (context.ownerServices as Map<string, CraftService>).set("notes", notes);
  try {
    notes.craftNotesCreateDevice({ id: "local", note: "Fixture device." });
    const directory = context.craftNotesObserveDirectory({ device_id: "local", path: "/tmp/craft-notes-service-routing", pin: true }).note as JsonObject;
    const file = context.craftNotesObserveFile({ device_id: "local", path: "/tmp/craft-notes-service-routing/a.txt", pin: true }).note as JsonObject;
    assert.equal((context.craftNotesCandidateList({ limit: 10 }).items as JsonObject[]).length, 2);
    assert.equal(context.craftNotesQualificationRun({ limit: 10 }).qualified, 2);
    const current = notes.store.find("craft_note", String(directory.id))!;
    assert.equal(context.craftNotesConfirm({ id: directory.id, expected_version: current.version }).status, "confirmed");
    assert.equal((context.craftNotesResolve({ device_id: "local", path: "/tmp/craft-notes-service-routing" }).items as JsonObject[]).length, 2);
    const currentFile = notes.store.find("craft_note", String(file.id))!;
    assert.equal(context.craftNotesRevoke({ id: file.id, expected_version: currentFile.version, revoked_by: "fixture", reason: "done" }).status, "revoked");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("owned non-Notes MCP rejects Notes operations when its Notes owner is absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-without-notes-"));
  const memory = await openCapabilityService("memory", { CRAFT_DATA_DIR: root });
  try {
    assert.throws(() => memory.service.craftNotesObserveFile({ path: "/tmp/file", pin: true }), /notes owner is unavailable/u);
    assert.throws(() => memory.service.craftNotesCandidateList(), /notes owner is unavailable/u);
    assert.throws(() => memory.service.craftNotesQualificationRun(), /notes owner is unavailable/u);
    assert.throws(() => memory.service.craftNotesConfirm({ id: "missing", expected_version: 1 }), /notes owner is unavailable/u);
    assert.throws(() => memory.service.craftNotesRevoke({ id: "missing", expected_version: 1, revoked_by: "fixture", reason: "test" }), /notes owner is unavailable/u);
    assert.throws(() => memory.service.craftNotesResolve({}), /notes owner is unavailable/u);
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
