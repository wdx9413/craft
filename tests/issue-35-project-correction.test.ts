import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InternalHostDriver } from "../core/internal-host-driver.ts";
import { defineProvider } from "../core/model-gateway.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-issue-35-"));
  const alpha = join(root, "alpha"), beta = join(root, "beta");
  await mkdir(alpha); await mkdir(beta);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  const alphaId = ((service.scopeIdentityResolveProject({ project_root: alpha }).identity as JsonObject).canonical_scope as JsonObject).id as string;
  const betaId = ((service.scopeIdentityResolveProject({ project_root: beta }).identity as JsonObject).canonical_scope as JsonObject).id as string;
  return { root, alpha, beta, alphaId, betaId, store, service, async close() { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("project correction binds canonical root, is retrieved only in that project, and revoke fences warm retrieval", async () => {
  const f = await fixture();
  try {
    const exposedMemorySearch = f.service.internalHost.tools.find(tool => tool.function.name === "memory_search");
    assert.ok(exposedMemorySearch);
    assert.deepEqual(exposedMemorySearch.function.parameters?.required, ["query"]);
    assert.equal((exposedMemorySearch.function.parameters?.properties as JsonObject).scope_id, undefined);
    assert.equal((exposedMemorySearch.function.parameters?.properties as JsonObject).scope_kind, undefined);
    const provider = defineProvider({ provider: "issue-35", protocol: "openai-compatible", base_url: "https://example.invalid/v1", api_key_env: "ISSUE_35_KEY", models: { standard: "test-model" } });
    const staticToolDriver = new InternalHostDriver(f.store, { providers: [provider], tools: [
      { type: "function", function: { name: "memory_search", parameters: { properties: { scope_id: { type: "string" } } } } },
      { type: "function", function: { name: "capability_search", parameters: { properties: { query: { type: "string" } } } } },
    ] });
    assert.deepEqual(staticToolDriver.tools.find(tool => tool.function.name === "memory_search")?.function.parameters?.required, []);
    const bareToolDriver = new InternalHostDriver(f.store, { providers: [provider], tools: [
      { type: "function", function: { name: "memory_search" } },
    ] });
    assert.deepEqual(bareToolDriver.tools[0]?.function.parameters?.required, []);
    const resolver = f.service.cognitiveWrites.resolveProject;
    (f.service.cognitiveWrites as unknown as { resolveProject: (args: JsonObject) => JsonObject }).resolveProject = () => ({});
    assert.throws(() => f.service.memoryCaptureProjectCorrection({ content: "x", project_root: f.alpha }), /canonical project identity/u);
    (f.service.cognitiveWrites as unknown as { resolveProject: (args: JsonObject) => JsonObject }).resolveProject = () => ({ identity: { canonical_scope: { kind: "project", id: "not-canonical" } } });
    assert.throws(() => f.service.memoryCaptureProjectCorrection({ content: "x", project_root: f.alpha }), /canonical project identity/u);
    (f.service.cognitiveWrites as unknown as { resolveProject: (args: JsonObject) => JsonObject }).resolveProject = () => ({ identity: { canonical_scope: { kind: "project", id: 7 } } });
    assert.throws(() => f.service.memoryCaptureProjectCorrection({ content: "x", project_root: f.alpha }), /canonical project identity/u);
    (f.service.cognitiveWrites as unknown as { resolveProject: (args: JsonObject) => JsonObject }).resolveProject = resolver;
    assert.throws(() => f.service.memoryCaptureProjectCorrection({ content: "Sort prices from low to high", project_root: f.alpha, scope_id: f.betaId }), /does not match project_root identity/u);
    const verified = f.service.memoryCaptureProjectCorrection({ content: "Use project-specific headings", kind: "preference", topic: "report:headings", project_root: f.alpha,
      scope_id: f.alphaId, project_scope_id: f.alphaId });
    assert.equal((verified.memory as JsonObject).status, "active");
    const captured = f.service.memoryCaptureProjectCorrection({ content: "Sort prices from low to high", kind: "preference", topic: "report:price-order", project_root: f.alpha });
    const memory = captured.memory as JsonObject;
    assert.equal(memory.status, "active");
    assert.deepEqual(memory.scope, { kind: "project", id: f.alphaId });

    const own = await f.service.contextResolutionResolve({ receipt_id: "issue-35-own", query: "price order sort", scope_kind: "project", scope_id: f.alphaId });
    assert.ok((own.items as JsonObject[]).some(item => item.memory_id === memory.id));
    const other = await f.service.contextResolutionResolve({ receipt_id: "issue-35-other", query: "price order sort", scope_kind: "project", scope_id: f.betaId });
    assert.ok(!(other.items as JsonObject[]).some(item => item.memory_id === memory.id));

    const otherCorrection = f.service.memoryCaptureProjectCorrection({ content: "Sort prices from high to low", kind: "preference", topic: "report:price-order", project_root: f.beta });
    const betaMemory = otherCorrection.memory as JsonObject;
    f.store.create("workspace", "workspace-alpha", { name: "alpha", root_path: f.alpha, canonical_root_path: f.alpha, status: "active" });
    f.store.create("workspace", "workspace-beta", { name: "beta", root_path: f.beta, canonical_root_path: f.beta, status: "active" });
    f.store.create("task", "task-alpha", { workspace_id: "workspace-alpha", goal: "Prepare report" });
    f.store.create("task", "task-beta", { workspace_id: "workspace-beta", goal: "Prepare report" });
    f.store.create("task", "task-unbound", { goal: "Prepare report" });
    f.store.create("task", "task-empty-workspace", { workspace_id: "", goal: "Prepare report" });
    const modelAskedForOtherScope = await f.service.memorySearch({ task_id: "task-alpha", query: "price order sort", scope_kind: "project", scope_id: f.betaId });
    assert.ok((modelAskedForOtherScope.memories as JsonObject[]).some(item => item.memory_id === memory.id));
    assert.ok(!(modelAskedForOtherScope.memories as JsonObject[]).some(item => item.memory_id === betaMemory.id));
    const betaTaskSearch = await f.service.memorySearch({ task_id: "task-beta", query: "price order sort", scope_kind: "project", scope_id: f.alphaId });
    assert.ok((betaTaskSearch.memories as JsonObject[]).some(item => item.memory_id === betaMemory.id));
    assert.ok(!(betaTaskSearch.memories as JsonObject[]).some(item => item.memory_id === memory.id));
    assert.equal((await f.service.memorySearch({ task_id: "task-unbound", query: "price order sort", scope_kind: "project", scope_id: f.alphaId })).reason, "task_workspace_unavailable");
    assert.equal((await f.service.memorySearch({ task_id: "task-empty-workspace", query: "price order sort" })).reason, "task_workspace_unavailable");
    assert.ok(((await f.service.memorySearch({ query: "price order sort", scope_kind: "project", scope_id: f.alphaId })).memories as JsonObject[]).some(item => item.memory_id === memory.id));
    const resolveProject = f.service.scopeIdentity.resolveProject.bind(f.service.scopeIdentity);
    (f.service.scopeIdentity as unknown as { resolveProject: (args: JsonObject) => JsonObject }).resolveProject = () => ({});
    await assert.rejects(Promise.resolve(f.service.memorySearch({ task_id: "task-alpha", query: "price order sort" })), /canonical project identity/u);
    (f.service.scopeIdentity as unknown as { resolveProject: (args: JsonObject) => JsonObject }).resolveProject = () => ({ identity: { canonical_scope: { kind: "project", id: 7 } } });
    await assert.rejects(Promise.resolve(f.service.memorySearch({ task_id: "task-alpha", query: "price order sort" })), /canonical project identity/u);
    (f.service.scopeIdentity as unknown as { resolveProject: (args: JsonObject) => JsonObject }).resolveProject = resolveProject;

    let modelTurn = 0;
    let boundSearch: JsonObject | null = null;
    const driver = new InternalHostDriver(f.store, { providers: [provider], transport: { complete: async () => modelTurn++ === 0
      ? { text: JSON.stringify({ action: "memory_search", args: { query: "price order sort", task_id: "task-beta", scope_kind: "project", scope_id: f.betaId } }), model: "test-model", usage: null }
      : { text: "done", model: "test-model", usage: null } },
      invokeAction: async (_action, args) => { boundSearch = await f.service.memorySearch(args); return boundSearch; } });
    const dispatch = driver.prepare({ task_id: "task-alpha", dispatch_id: "issue-35-host-context", prompt: "Use the project correction" }).dispatch as JsonObject;
    await driver.execute({ dispatch_id: String(dispatch.id), prompt: "Use the project correction" });
    assert.ok(boundSearch);
    assert.ok(((boundSearch as JsonObject).memories as JsonObject[]).some(item => item.memory_id === memory.id));
    assert.ok(!((boundSearch as JsonObject).memories as JsonObject[]).some(item => item.memory_id === betaMemory.id));
    let workspaceBoundSearch: JsonObject | null = null, workspaceBoundTurn = 0;
    const workspaceBoundDriver = new InternalHostDriver(f.store, { providers: [provider], transport: { complete: async () => workspaceBoundTurn++ === 0
      ? { text: JSON.stringify({ action: "memory_search", args: { query: "price order sort", task_id: "task-alpha", scope_kind: "project", scope_id: f.betaId } }), model: "test-model", usage: null }
      : { text: "done", model: "test-model", usage: null } },
      invokeAction: async (_action, args) => { workspaceBoundSearch = await f.service.memorySearch(args); return workspaceBoundSearch; } });
    const workspaceBoundDispatch = workspaceBoundDriver.prepare({ task_id: "task-alpha", dispatch_id: "issue-35-bound-host-context", workspace: f.alpha, sandbox: "read-only", prompt: "Use the project correction" }).dispatch as JsonObject;
    await workspaceBoundDriver.execute({ dispatch_id: String(workspaceBoundDispatch.id), prompt: "Use the project correction" });
    assert.ok(workspaceBoundSearch);
    assert.ok(((workspaceBoundSearch as JsonObject).memories as JsonObject[]).some(item => item.memory_id === memory.id));
    assert.ok(!((workspaceBoundSearch as JsonObject).memories as JsonObject[]).some(item => item.memory_id === betaMemory.id));
    let nonMemoryTurn = 0;
    const nonMemoryDriver = new InternalHostDriver(f.store, { providers: [provider], transport: { complete: async () => nonMemoryTurn++ === 0
      ? { text: JSON.stringify({ action: "capability_search", args: { query: "report" } }), model: "test-model", usage: null }
      : { text: "done", model: "test-model", usage: null } }, invokeAction: async () => ({ ok: true }) });
    const nonMemoryDispatch = nonMemoryDriver.prepare({ task_id: "task-alpha", dispatch_id: "issue-35-non-memory", prompt: "Search capabilities" }).dispatch as JsonObject;
    await nonMemoryDriver.execute({ dispatch_id: String(nonMemoryDispatch.id), prompt: "Search capabilities" });

    const warm = await f.service.contextResolutionResolve({ receipt_id: "issue-35-warm", query: "price order sort", scope_kind: "project", scope_id: f.alphaId });
    assert.ok((warm.items as JsonObject[]).some(item => item.memory_id === memory.id));
    f.service.memoryLedgerTransition({ memory_id: memory.id, status: "revoked", expected_version: memory.version, actor: "user", reason: "Correction withdrawn" });
    const fresh = await f.service.contextResolutionResolve({ receipt_id: "issue-35-after-revoke", query: "price order sort", scope_kind: "project", scope_id: f.alphaId });
    assert.ok(!(fresh.items as JsonObject[]).some(item => item.memory_id === memory.id));
    await assert.rejects(Promise.resolve(f.service.contextResolutionResolve({ receipt_id: "issue-35-warm", query: "price order sort", scope_kind: "project", scope_id: f.alphaId })));
  } finally { await f.close(); }
});
