import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";
import { ContextResolutionKernel } from "../core/context-resolution.ts";
import { KnowledgeContribution } from "../capability/craft-knowledge/contribution.ts";
import { stableDigest } from "../core/digest.ts";
import { bindRemoteIdentity } from "../deploy/components/server.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "craft-context-policy-")), repo = join(root, "repo");
  mkdirSync(repo); execFileSync("git", ["-C", repo, "init", "-q"]);
  writeFileSync(join(repo, "a.ts"), "export function alpha() {}\n");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open(), service = new CraftService(store);
  service.knowledgeMemoryInstallBuiltins();
  const scope = (service.scopeIdentityResolveProject({ project_root: repo }).identity as JsonObject).canonical_scope as { kind: string; id: string };
  const memory = (id: string, content: string, extras: JsonObject = {}) => store.create("memory_ledger", id, { source_id: "builtin.evidence-wiki", scope, kind: "fact", status: "active", content, content_digest: stableDigest(content), sensitivity: "internal", ...extras });
  return { root, repo, store, service, scope, memory, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
async function call(server: McpServer, name: string, args: JsonObject) {
  const value = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as any;
  assert.equal(value.result?.isError, false, JSON.stringify(value)); return value.result.structuredContent;
}

test("Context entry preserves source, required memory, principal, purpose and retrieval controls through MCP", async () => {
  const f = await fixture();
  try {
    const source = "builtin.evidence-wiki";
    f.memory("private", "Alpha testing", { scope_envelope: { applicability: f.scope, audience: { mode: "private", principal_ids: ["alice"] }, tenant_id: "red", purpose: "preference" } });
    f.store.create("knowledge_claim", "fact", { scope: `${f.scope.kind}:${f.scope.id}`, source_id: source, status: "reviewed", content: "Alpha testing", evidence_ids: [] });
    const adapter = f.service.contextResolution.retrievalConfigure({ adapter_id: "keyword", strategy: "keyword" }); assert(adapter.adapter);
    const server = new McpServer(f.service, "component-context-daily");
    const args = { project_root: f.repo, query: "alpha", include_codebase: false, memory_ids: ["private"], principal_ids: ["alice"], tenant_id: "red", cognitive_purpose: "preference", source_ids: [source], retrieval_adapter_id: "keyword" };
    const pack = await call(server, "craft_context_open", args);
    assert.equal(pack.items[0].memory_id, "private"); assert.equal(pack.receipt.retrieval_adapter_id, "keyword");
    assert.equal(pack.contributions.flatMap((part: any) => part.items).length, 0);
    assert.equal(pack.codebase.reason, "not_requested"); assert.equal(f.store.list("codebase_index").length, 0);
    await assert.rejects(f.service.contextOpen({ ...args, principal_ids: ["bob"] }), /Required Memory/);
    await assert.rejects(f.service.contextOpen({ ...args, source_ids: ["missing"] }), /Source/);
    await assert.rejects(f.service.contextOpen({ ...args, include_codebase: "false" }), /include_codebase/);
    const narrow = await call(server, "craft_context_open", { ...args, memory_ids: [], source_ids: [], principal_id: "alice", allow_restricted: false, include_working_notes: false, include_global: false, now: "2026-10-04T00:00:00Z" });
    assert.equal(narrow.receipt.scope_access.purpose, "preference");
  } finally { f.close(); }
});

test("Knowledge direct search and aggregate contribution apply the same cognitive purpose", async () => {
  const f = await fixture();
  try {
    f.store.create("knowledge_claim", "fact", { scope: `${f.scope.kind}:${f.scope.id}`, source_id: "builtin.evidence-wiki", status: "reviewed", content: "alpha", evidence_ids: [] });
    const resolver = new ContextResolutionKernel(f.store, [new KnowledgeContribution(f.store)]);
    const args = { query: "alpha", scope_kind: f.scope.kind, scope_id: f.scope.id, cognitive_purpose: "preference" };
    assert.equal(((await resolver.searchKnowledge(args)).hits as unknown[]).length, 0);
    const result = await resolver.resolve(args); assert.equal((result.receipt as JsonObject).total_items, 0);
  } finally { f.close(); }
});

test("Cross-component deduplication uses content without search tags and retains all provenance", async () => {
  const f = await fixture();
  try {
    const body = "Alpha testing"; f.memory("memory", body);
    f.store.create("knowledge_claim", "claim", { scope: `${f.scope.kind}:${f.scope.id}`, source_id: "builtin.evidence-wiki", status: "reviewed", content: body, content_digest: stableDigest(body), tags: ["tests"], evidence_ids: [] });
    const resolver = new ContextResolutionKernel(f.store, [new KnowledgeContribution(f.store)]);
    const args = { query: "alpha", scope_kind: f.scope.kind, scope_id: f.scope.id, deduplicate: true };
    const result = await resolver.resolve(args); const receipt = result.receipt as JsonObject;
    assert.equal(receipt.total_items, 1); assert.equal(receipt.deduplicated_count, 1);
    const provenance = receipt.deduplicated_refs as JsonObject[];
    assert.equal(provenance.length, 1); assert(provenance[0]!.omitted); assert(provenance[0]!.retained);
    assert(!JSON.stringify(provenance).includes(body));
    const required = await resolver.resolve({ ...args, memory_ids: ["memory"] });
    assert.equal((required.items as JsonObject[])[0]!.memory_id, "memory");
    assert.equal(((await resolver.resolve({ ...args, deduplicate: false })).receipt as JsonObject).total_items, 2);
  } finally { f.close(); }
});

test("Context pack exposes partial coverage, budget omissions, disabled and unavailable index states", async () => {
  const f = await fixture();
  try {
    const ready = await f.service.contextOpen({ project_root: f.repo, query: "alpha" });
    assert.equal(ready.partial, true); assert(((ready.pack_receipt as JsonObject).partial_reasons as string[]).includes("codebase_partial_analysis"));
    const tiny = await f.service.contextOpen({ project_root: f.repo, query: "alpha", max_chars: 1 });
    assert(Number((tiny.codebase as JsonObject).budget_omitted_count) > 0);
    assert(((tiny.pack_receipt as JsonObject).partial_reasons as string[]).includes("codebase_budget_exhausted"));
    writeFileSync(join(f.repo, ".craft-codebase.json"), "bad json");
    const unavailable = await f.service.contextOpen({ project_root: f.repo, query: "alpha" });
    assert(((unavailable.pack_receipt as JsonObject).partial_reasons as string[]).includes("codebase_unavailable"));
    const skipped = await f.service.contextOpen({ project_root: f.repo, query: "alpha", include_codebase: false });
    assert.equal(skipped.partial, false); assert.deepEqual((skipped.pack_receipt as JsonObject).partial_reasons, []);
  } finally { f.close(); }
});

test("Oversized contribution can degrade only the optional aggregate path", async () => {
  const f = await fixture();
  try {
    const contribution = { member: "knowledge" as const, contribute: async () => ({ member: "knowledge" as const, receipt_id: "oversized", items: [{ content: "x".repeat(8_000_001) }], omitted_count: 0 }) };
    const kernel = new ContextResolutionKernel(f.store, [contribution]), args = { query: "x", scope_kind: f.scope.kind, scope_id: f.scope.id };
    await assert.rejects(kernel.resolve(args), /exceeded/);
    const degraded = await kernel.resolve({ ...args, allow_partial: true });
    assert.equal((degraded.receipt as JsonObject).partial, true);
    assert.equal((degraded.receipt as JsonObject).total_items, 0);
  } finally { f.close(); }
});

test("Restored repository checkpoints rebuild stale indexes and legacy analyzer caches", async () => {
  const f = await fixture();
  try {
    const first = f.service.codebaseRepositoryEnsure({ project_root: f.repo });
    writeFileSync(join(f.repo, "a.ts"), "export function beta() {}\n");
    f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    f.service.workspaceRestore({ workspace_id: first.workspace_id, checkpoint_id: first.checkpoint_id, approved: true });
    const cached = f.store.list("codebase_file_analysis")[0]!;
    f.store.save("codebase_file_analysis", String(cached.id), { ...cached, analyzer_version: "legacy" });
    const restored = f.service.codebaseRepositoryEnsure({ project_root: f.repo });
    assert.equal(restored.status, "ready"); assert.equal(restored.reused, false); assert.notEqual(restored.index_id, first.index_id);
    const found = f.service.codebaseSymbolFind({ workspace_id: restored.workspace_id, index_id: restored.index_id, query: "alpha" });
    assert.equal((found.symbols as unknown[]).length, 1);
    assert.equal(f.service.codebaseRepositoryEnsure({ project_root: f.repo }).reused, true);
    assert.equal(f.store.get("codebase_index", String(first.index_id)).status, "stale");
  } finally { f.close(); }
});

test("Remote transport pins identity while ordinary protocol validation stays with MCP", async () => {
  const f = await fixture();
  try {
    f.memory("alice", "alpha", { scope_envelope: { applicability: f.scope, audience: { mode: "private", principal_ids: ["sha256:alice"] }, tenant_id: "team" } });
    const server = new McpServer(f.service, "component-memory-daily"), alice = bindRemoteIdentity(server, "sha256:alice", "team"), bob = bindRemoteIdentity(server, "sha256:bob", "team");
    const message = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "craft_memory_ledger_list", arguments: { scope_kind: f.scope.kind, scope_id: f.scope.id } } };
    const visible = await alice.handle(message) as any; assert.equal(visible.result.structuredContent.memories.length, 1);
    const hidden = await bob.handle(message) as any; assert.equal(hidden.result.structuredContent.memories.length, 0);
    for (const forged of [{ principal_id: "sha256:alice" }, { principal_ids: ["sha256:alice"] }, { tenant_id: "other" }]) {
      const response = await bob.handle({ ...message, params: { ...message.params, arguments: { ...message.params.arguments, ...forged } } }) as any;
      assert.equal(response.result.isError, true);
    }
    const legitimate = await alice.handle({ ...message, params: { ...message.params, arguments: { ...message.params.arguments, principal_id: "sha256:alice", principal_ids: ["sha256:alice"], tenant_id: "team" } } }) as any;
    assert.equal(legitimate.result.isError, false);
    for (const value of [null, [], { method: "tools/list", id: 1 }, { ...message, params: { name: "missing" } }, { ...message, params: { name: "craft_memory_ledger_list" } }, { ...message, params: { name: "craft_knowledge_bootstrap_install" } }, { ...message, params: { name: "craft_memory_ledger_list", arguments: [] } }, { ...message, params: { name: "craft_memory_ledger_list", arguments: false } }, { ...message, params: { name: "craft_memory_ledger_list", arguments: "invalid" } }, { ...message, params: { arguments: {} } }]) await alice.handle(value);
  } finally { f.close(); }
});

test("Context reports query truncation, omitted files and unavailable contributions independently", async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.repo, "a.ts"), "export function alphaOne() {}\nexport function alphaTwo() {}\n");
    writeFileSync(join(f.repo, "large.ts"), "x".repeat(512 * 1024 + 1));
    const limited = await f.service.contextOpen({ project_root: f.repo, query: "alpha", max_items: 1 });
    const reasons = (limited.pack_receipt as JsonObject).partial_reasons as string[];
    assert(reasons.includes("codebase_query_truncated")); assert(reasons.includes("codebase_files_omitted"));
    assert.equal((limited.codebase as JsonObject).query_omitted_count, 1);
    const claim = { scope: `${f.scope.kind}:${f.scope.id}`, source_id: "builtin.evidence-wiki", status: "reviewed", content: "alpha", evidence_ids: [] };
    f.store.database.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10001) INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) SELECT 'knowledge_claim','claim_'||i,1,?,'2026-01-01','2026-01-01' FROM n").run(JSON.stringify(claim));
    const partial = await f.service.contextOpen({ project_root: f.repo, query: "alpha", include_codebase: false });
    assert.deepEqual((partial.pack_receipt as JsonObject).partial_reasons, ["context_contribution_unavailable"]);
  } finally { f.close(); }
});

test("Source lookup stays correct beyond its bounded cache", async () => {
  const f = await fixture();
  try {
    const source = { status: "active", trust: "trusted", scope: { kind: "global", id: "global" } };
    f.store.database.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10002) INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) SELECT 'knowledge_source','source_'||i,1,?,'2026-01-01','2026-01-01' FROM n").run(JSON.stringify(source));
    const sources = Array.from({ length: 10002 }, (_, i) => `source_${i + 1}`);
    const result = await f.service.contextResolution.resolve({ query: "alpha", scope_kind: f.scope.kind, scope_id: f.scope.id, source_ids: sources, members: ["memory"] });
    assert.equal((result.receipt as JsonObject).total_items, 0);
    f.store.database.prepare("DELETE FROM records WHERE kind='knowledge_source' AND id='source_9999'").run();
    await assert.rejects(f.service.contextResolution.resolve({ query: "alpha", scope_kind: f.scope.kind, scope_id: f.scope.id, source_ids: sources, members: ["memory"] }), /Source is unavailable/);
  } finally { f.close(); }
});

test("Other projects cannot crowd an older Memory out of current or historical candidate selection", async () => {
  const f = await fixture();
  try {
    f.memory("target", "alpha target");
    const base = { source_id: "builtin.evidence-wiki", scope: { kind: "project", id: "other" }, kind: "fact", status: "active", content: "alpha", content_digest: stableDigest("alpha"), sensitivity: "internal" };
    f.store.database.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10001) INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) SELECT 'memory_ledger','foreign_'||i,1,?,'2026-01-01','2099-01-01' FROM n").run(JSON.stringify(base));
    const args = { query: "alpha", scope_kind: f.scope.kind, scope_id: f.scope.id };
    const result = await f.service.contextResolution.resolve(args);
    assert.deepEqual((result.items as JsonObject[]).map(item => item.memory_id), ["target"]);
    const historical = await f.service.contextResolution.resolve({ ...args, history_view: true });
    assert.deepEqual((historical.items as JsonObject[]).map(item => item.memory_id), ["target"]);
    f.store.database.prepare("UPDATE records SET payload_json=? WHERE id LIKE 'foreign_%'").run(JSON.stringify({ ...base, scope: f.scope }));
    await assert.rejects(f.service.contextResolution.resolve(args), /Memory candidate budget/);
    await assert.rejects(f.service.contextResolution.resolve({ ...args, history_view: true }), /Memory history budget/);
  } finally { f.close(); }
});
