import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { payload, stableDigest } from "../core/digest.ts";
import { ContextResolutionKernel } from "../core/context-resolution.ts";
import { ContextReadGuard, assertContextReadCurrent } from "../core/context-access-guard.ts";
import { KnowledgeContribution } from "../capability/craft-knowledge/contribution.ts";
import { ExperienceContribution } from "../capability/craft-experience/contribution.ts";

const scope = { scope_kind: "project", scope_id: "race" };
const owner = { principal_id: "owner", tenant_id: "tenant" };
function barrier() {
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  return { release, started, async wait() { entered(); await waiting; } };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-revocation-race-")), paths = craftPaths(root);
  const store = await new CraftStore(paths).open(), writer = await new CraftStore(paths).open(), service = new CraftService(store);
  service.knowledgeSourceRegister({ source_id: "source", kind: "custom", label: "source", ...scope, locator: root, content_digest: "source-digest", trust: "verified", access: "read_only" });
  store.create("evidence", "proof", { source_type: "human", confidence: "confirmed" });
  const memory = service.memoryLedgerRemember({ memory_id: "private", source_id: "source", kind: "preference", ...scope, content: "alpha private content", evidence_ids: ["proof"],
    scope_envelope: { audience: { mode: "private", principal_ids: ["owner"] }, tenant_id: "tenant" } }).memory as JsonObject;
  return { root, store, writer, service, memory, async close() { writer.close(); store.close(); await rm(root, { recursive: true, force: true }); } };
}

for (const mutation of ["audience", "tenant", "scope", "sensitivity", "revoked", "expired", "superseded", "correction", "source_revoked", "source_audience", "deleted"] as const) {
  test(`Memory ${mutation} during contributor wait fails closed across database connections`, async () => {
    const f = await fixture();
    try {
      const gate = barrier(), kernel = new ContextResolutionKernel(f.store, [{ member: "experience", async contribute() { await gate.wait(); return { member: "experience", items: [], receipt_id: "barrier", omitted_count: 0 }; } }]);
      const args = { ...scope, ...owner, query: "alpha", allow_partial: true };
      const pending = kernel.resolve(args); const denied = assert.rejects(pending, /Context authorization or material state changed/);
      await gate.started;
      if (mutation.startsWith("source_")) {
        const source = f.writer.get("knowledge_source", "source");
        f.writer.save("knowledge_source", "source", { ...payload(source), ...(mutation === "source_revoked" ? { status: "revoked" } : { scope_envelope: { audience: { mode: "private", principal_ids: ["other"] }, tenant_id: "tenant" } }) });
      } else if (mutation === "deleted") f.writer.database.prepare("DELETE FROM records WHERE kind='memory_ledger' AND id='private'").run();
      else {
        const current = f.writer.get("memory_ledger", "private"), envelope = current.scope_envelope as JsonObject;
        const changed = mutation === "audience" ? { scope_envelope: { ...envelope, audience: { mode: "private", principal_ids: ["other"] } } }
          : mutation === "tenant" ? { scope_envelope: { ...envelope, tenant_id: "other" } }
          : mutation === "scope" ? { scope: { kind: "project", id: "other" }, scope_envelope: undefined }
          : mutation === "sensitivity" ? { sensitivity: "restricted" }
          : mutation === "correction" ? { content: "corrected", content_ref: undefined, content_digest: stableDigest("corrected") } : { status: mutation };
        f.writer.save("memory_ledger", "private", { ...payload(current), ...changed });
      }
      gate.release(); await denied;
      assert.equal(f.store.count("context_resolution_receipt"), 0);
      const fresh = await new ContextResolutionKernel(f.store).resolve({ ...args, ...(mutation === "audience" ? { principal_id: "other" } : {}) });
      if (mutation === "audience") assert.equal((fresh.items as JsonObject[])[0]!.memory_id, "private");
      else assert.equal((fresh.items as JsonObject[]).length, 0);
    } finally { await f.close(); }
  });
}

test("warm receipts cannot bypass a changed read fence; unrelated records do not invalidate it", async () => {
  const f = await fixture();
  try {
    const kernel = new ContextResolutionKernel(f.store), args = { ...scope, ...owner, query: "alpha", receipt_id: "warm" };
    const first = await kernel.resolve(args); assert.equal((await kernel.resolve(args)).idempotent, true);
    f.writer.create("memory_ledger", "unrelated", { scope: { kind: "project", id: "other" }, status: "active" });
    assertContextReadCurrent(f.store, first.receipt as JsonObject); assertContextReadCurrent(f.store, null); assertContextReadCurrent(f.store, {});
    f.writer.save("memory_ledger", "private", { ...payload(f.memory), status: "revoked" });
    assert.throws(() => assertContextReadCurrent(f.store, first.receipt as JsonObject), /changed/);
    await assert.rejects(kernel.resolve(args), /idempotency conflict/);
    const empty = await kernel.resolve({ ...args, receipt_id: "fresh" }); assert.deepEqual(empty.items, []);
  } finally { await f.close(); }
});

test("local contribution revisions, source/document changes and releases are pinned without hydrating bodies", async () => {
  const f = await fixture();
  try {
    const guard = new ContextReadGuard(f.store); guard.contribution("knowledge", { ref_id: "external" }); guard.contribution("knowledge", { claim_id: "external" }); guard.assertCurrent();
    f.writer.create("knowledge_claim", "external", {}); assert.throws(() => guard.assertCurrent(), /changed/);
    const newer = new ContextReadGuard(f.store); f.writer.save("knowledge_source", "source", { ...payload(f.writer.get("knowledge_source", "source")), status: "revoked" }); assert.throws(() => newer.track("knowledge_source", "source"), /changed/);
    const local = new ContextReadGuard(f.store); local.contribution("knowledge", { claim_id: "external" }); local.assertCurrent();
  } finally { await f.close(); }
});

for (const member of ["knowledge", "experience"] as const) {
  test(`${member} cached contribution cannot survive access, document or publication changes`, async () => {
    for (const mode of member === "knowledge" ? ["audience", "source", "document", "status"] : ["audience", "release"]) {
      const f = await fixture();
      try {
        if (member === "knowledge") {
          f.store.create("knowledge_document", "doc", { status: "current", content_digest: "doc" });
          f.store.create("knowledge_claim", "claim", { source_id: "source", document_id: "doc", document_digest: "doc", scope: "project:race", status: "reviewed", content: "alpha private claim", content_digest: "claim", scope_envelope: f.memory.scope_envelope });
        } else {
          f.store.create("experience_procedure", "procedure", { scope: "project:race", scope_envelope: f.memory.scope_envelope, routeable: true, lifecycle: "routeable", procedure_kind: "prompt", trigger: "alpha", title: "alpha", acceptance_ref: "accept", content_digest: "procedure", definition_digest: "one" });
          f.store.create("experience_release", "procedure", { status: "active", record_version: 1, definition_digest: "one" });
          f.store.save("experience_procedure", "procedure", { ...payload(f.store.get("experience_procedure", "procedure")), routeable: false, lifecycle: "candidate", definition_digest: "two" });
        }
        const reader = member === "knowledge" ? new KnowledgeContribution(f.store) : new ExperienceContribution(f.store), gate = barrier();
        const kernel = new ContextResolutionKernel(f.store, [{ member, async contribute(request) { const cached = await reader.contribute(request); assert(cached.items.length); await gate.wait(); return cached; } }]);
        const pending = kernel.resolve({ ...scope, ...owner, query: "alpha", members: [member], allow_partial: true }); const denied = assert.rejects(pending, /changed during recall/); await gate.started;
        const kind = mode === "source" ? "knowledge_source" : mode === "document" ? "knowledge_document" : mode === "release" ? "experience_release" : member === "knowledge" ? "knowledge_claim" : "experience_procedure";
        const id = mode === "source" ? "source" : mode === "document" ? "doc" : member === "knowledge" ? "claim" : "procedure";
        const current = f.writer.get(kind, id);
        f.writer.save(kind, id, { ...payload(current), ...(mode === "audience" ? { scope_envelope: { audience: { mode: "private", principal_ids: ["other"] }, tenant_id: "tenant" } } : { status: mode === "document" ? "changed" : mode === "status" ? "disputed" : "revoked" }) });
        gate.release(); await denied; assert.equal(f.store.count("context_resolution_receipt"), 0);
      } finally { await f.close(); }
    }
  });
}

test("direct Knowledge search rechecks its awaited result", async () => {
  const f = await fixture();
  try {
    f.store.create("knowledge_claim", "claim", { source_id: "source", scope: "project:race", status: "reviewed", content: "alpha", scope_envelope: f.memory.scope_envelope });
    const reader = new KnowledgeContribution(f.store), gate = barrier();
    const kernel = new ContextResolutionKernel(f.store, [{ member: "knowledge", contribute: request => reader.contribute(request), async search(request, candidates) { const cached = await reader.search(request, candidates); await gate.wait(); return cached; } }]);
    const pending = kernel.searchKnowledge({ ...scope, ...owner, query: "alpha" }); const denied = assert.rejects(pending, /changed during recall/); await gate.started;
    f.writer.save("knowledge_source", "source", { ...payload(f.writer.get("knowledge_source", "source")), status: "revoked" }); gate.release(); await denied;
  } finally { await f.close(); }
});

test("provider batching rechecks before each dispatch; revocation is never downgraded to keyword fallback", async t => {
  const f = await fixture(); const credential = "CRAFT_RACE_FIXTURE_KEY"; process.env[credential] = "synthetic-only";
  try {
    const adapter = f.service.retrievalAdapterConfigure({ adapter_id: "embedding", strategy: "vector", provider_fingerprint: "fixture", configuration: { endpoint: "https://fixture.invalid/race-batches", model: "race-model", credential_env: credential } }).adapter as JsonObject;
    f.store.save("retrieval_adapter", "embedding", { ...payload(adapter), status: "eligible" });
    const inputs: string[][] = [];
    t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, options?: RequestInit) => {
      const input = JSON.parse(String(options!.body)).input as string[]; inputs.push(input);
      return { ok: true, async json() {
        f.writer.save("memory_ledger", "private", { ...payload(f.memory), status: "revoked" });
        return { data: input.map((_, index) => ({ index, embedding: [1, 0] })), usage: { total_tokens: 1 } };
      } } as Response;
    });
    await assert.rejects(f.service.contextResolution.resolve({ ...scope, ...owner, query: "alpha " + "x".repeat(31992), retrieval_adapter_id: "embedding" }), /changed during recall/);
    assert.equal(inputs.length, 1); assert(!inputs.flat().includes("alpha private content")); assert.equal(f.store.count("context_resolution_receipt"), 0);
  } finally { delete process.env[credential]; await f.close(); }
});

test("an actual second process can revoke during asynchronous recall", async () => {
  const { execFileSync } = await import("node:child_process");
  const f = await fixture();
  try {
    const gate = barrier(), kernel = new ContextResolutionKernel(f.store, [{ member: "experience", async contribute() { await gate.wait(); return { member: "experience", items: [], receipt_id: "barrier", omitted_count: 0 }; } }]);
    const pending = kernel.resolve({ ...scope, ...owner, query: "alpha" }); const denied = assert.rejects(pending, /changed during recall/); await gate.started;
    const storeModule = new URL("../core/infrastructure/store.ts", import.meta.url).href, pathsModule = new URL("../core/infrastructure/paths.ts", import.meta.url).href;
    execFileSync(process.execPath, ["--input-type=module", "-e", `import {CraftStore} from ${JSON.stringify(storeModule)}; import {craftPaths} from ${JSON.stringify(pathsModule)}; let input=''; for await(const chunk of process.stdin) input+=chunk; const store=await new CraftStore(craftPaths(JSON.parse(input).root)).open(); const memory=store.get('memory_ledger','private'); store.save('memory_ledger','private',{...memory,status:'revoked'}); store.close();`], { input: JSON.stringify({ root: f.root }), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    gate.release(); await denied;
  } finally { await f.close(); }
});

test("Working Set rechecks after the resolver's promise completes", async t => {
  const f = await fixture();
  try {
    const original = f.service.contextResolution.resolve.bind(f.service.contextResolution);
    t.mock.method(f.service.contextResolution, "resolve", async (args: JsonObject) => { const result = await original(args); f.writer.save("memory_ledger", "private", { ...payload(f.memory), status: "revoked" }); return result; });
    await assert.rejects(f.service.contextWorkingSets.resolve({ ...scope, ...owner, query: "alpha" }), /changed during recall/); assert.equal(f.store.count("context_working_set_receipt"), 0);
  } finally { await f.close(); }
});

test("Context Open rechecks after Working Set preparation", async t => {
  const f = await fixture();
  try {
    const project = (f.service.scopeIdentityResolveProject({ project_root: f.root }).identity as JsonObject).canonical_scope as JsonObject;
    const memory = f.store.save("memory_ledger", "private", { ...payload(f.memory), scope: project, scope_envelope: { ...(f.memory.scope_envelope as JsonObject), applicability: project } });
    const original = f.service.contextWorkingSets.resolve.bind(f.service.contextWorkingSets);
    t.mock.method(f.service.contextWorkingSets, "resolve", async (args: JsonObject) => { const result = await original(args); f.writer.save("memory_ledger", "private", { ...payload(memory), status: "revoked" }); return result; });
    await assert.rejects(f.service.contextOpen({ project_root: f.root, include_codebase: false, ...owner, query: "alpha" }), /changed during recall/);
  } finally { await f.close(); }
});

test("Hook fails open without emitting materials or successful activation proof after late revocation", async t => {
  const { CodexHookBridge } = await import("../core/interfaces/codex-hook-bridge.ts");
  const f = await fixture();
  try {
    const project = (f.service.scopeIdentityResolveProject({ project_root: f.root }).identity as JsonObject).canonical_scope as JsonObject;
    const memory = f.store.save("memory_ledger", "private", { ...payload(f.memory), scope: project, scope_envelope: undefined });
    const original = f.service.contextWorkingSets.resolve.bind(f.service.contextWorkingSets);
    t.mock.method(f.service.contextWorkingSets, "resolve", async (args: JsonObject) => { const result = await original(args); f.writer.save("memory_ledger", "private", { ...payload(memory), status: "revoked" }); return result; });
    assert.deepEqual(await new CodexHookBridge(f.service).handle("context", { hook_event_name: "UserPromptSubmit", cwd: f.root, session_id: "session", turn_id: "turn", prompt: "alpha" }), {});
    assert.equal(f.store.count("context_emission"), 0); assert.equal(f.store.count("activation_proof"), 0);
  } finally { await f.close(); }
});
