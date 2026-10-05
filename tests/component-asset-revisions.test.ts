import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";
import { WorkbenchWebApp } from "../core/workbench-server.ts";
import { payload, stableDigest } from "../core/digest.ts";
import { spec } from "./helpers/procedure-invocation-fixture.ts";
const scope = { scope_kind: "project", scope_id: "assets" };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-asset-")), store = await new CraftStore(craftPaths(join(root, "data"))).open(), service = new CraftService(store);
  service.knowledgeSourceRegister({ source_id: "source", kind: "custom", label: "Fixture", ...scope, locator: root, content_digest: "initial", trust: "verified", access: "read_only" });
  store.create("evidence", "e", { source_type: "human", confidence: "confirmed", metadata: { user_authored: true } });
  function inspect(member: string, id: unknown, args: JsonObject = {}) { return service.componentAssetInspect(member, { ...scope, asset_id: id, ...args }); }
  function restore(member: string, record: JsonObject, extra: JsonObject = {}) { return service.componentAssetRestore(member, { ...scope, asset_id: record.id, version: 1, expected_version: record.version, request_id: String(record.id), reason: "Restore for review", ...extra }); }
  return { root, store, service, inspect, restore, async close() { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("Knowledge history distinguishes status/content changes; source revocation blocks restore and disclosure respects current ACL", async () => {
  const f = await fixture();
  try {
    const claim = f.service.knowledgeClaimSave({ claim_id: "k", source_id: "source", kind: "fact", content: "Explain outcomes", scope: "project:assets", evidence_ids: ["e"] }).claim as JsonObject;
    let changed = f.store.save("knowledge_claim", "k", { ...payload(claim), status: "reviewed" });
    const history = f.inspect("knowledge", "k", { limit: 1 }); assert.equal(history.has_more, true); assert.equal(history.next_before_version, 2);
    assert.equal((f.inspect("knowledge", "k", { before_version: 2 }).versions as unknown[]).length, 1);
    assert.equal(f.inspect("knowledge", "k", { action: "diff", version: 1, target_version: 2 }).content_changed, false);
    assert.equal((f.inspect("knowledge", "k", { action: "read", version: 1 }).asset as JsonObject).content, "Explain outcomes");
    assert.equal(f.inspect("knowledge", "k", { action: "read", version: 2 }).historical, false);
    const restored = f.restore("knowledge", changed), newId = (restored.restoration as JsonObject).restored_id;
    assert.equal(((restored.result as JsonObject).claim as JsonObject).status, "candidate");
    assert.equal(f.restore("knowledge", changed).idempotent, true);
    assert.throws(() => f.restore("knowledge", changed, { reason: "different" }), /conflict/);
    assert.throws(() => f.restore("knowledge", changed, { expected_version: 1, request_id: "other" }), /changed/);
    assert.equal(f.inspect("knowledge", "k", { action: "diff", version: 1, target_asset_id: newId, target_version: 1 }).content_changed, false);
    assert.equal((f.inspect("knowledge", newId).restorations as unknown[]).length, 1);
    const other = f.service.knowledgeClaimSave({ claim_id: "other", source_id: "source", kind: "fact", content: "Different", scope: "project:assets", evidence_ids: ["e"] }).claim as JsonObject;
    assert.equal(f.inspect("knowledge", "k", { action: "diff", version: 1, target_asset_id: other.id, target_version: 1 }).content_changed, true);
    for (const args of [{ action: "bad", version: 1 }, { limit: 101 }, { limit: 0 }, { before_version: "bad" }, { scope_id: "other" }, { kind: "memory_ledger" }]) assert.throws(() => f.inspect("knowledge", "k", args));
    assert.throws(() => f.service.componentAssetInspect("unsupported", { ...scope, asset_id: "k" }), /belong/);
    changed = f.store.save("knowledge_claim", "k", { ...payload(changed), sensitivity: "restricted", valid_until: "2020-01-01" });
    assert.throws(() => f.inspect("knowledge", "k", { action: "read", version: 1 }), /denied/);
    assert(f.inspect("knowledge", "k", { action: "explain", allow_restricted: true }).reasons);
    const source = f.store.get("knowledge_source", "source"); f.store.save("knowledge_source", "source", { ...payload(source), status: "revoked" });
    assert.throws(() => f.restore("knowledge", changed, { request_id: "revoked", allow_restricted: true }), /revocation/);
    assert((f.inspect("knowledge", "k", { action: "explain", allow_restricted: true }).reasons as string[]).includes("source_unavailable"));
    f.store.save("knowledge_source", "source", { ...payload(source), scope_envelope: { scope: { kind: "project", id: "assets" }, audience: { principal_ids: ["owner"] } } });
    assert.throws(() => f.inspect("knowledge", "other"), /audience|scope/);
  } finally { await f.close(); }
});

test("Memory restoration stays a proposal even with governed auto-commit and explains authorship and selection separately", async () => {
  const f = await fixture();
  try {
    f.service.memoryPolicySave({ mode: "governed", min_confidence: "bounded" });
    const memory = f.store.create("memory_ledger", "m", { scope: { kind: "project", id: "assets" }, source_id: "source", kind: "preference", content: "Use concise evidence", content_digest: stableDigest("Use concise evidence"), status: "active", sensitivity: "internal", evidence_ids: ["e"], topic: "output", effective_from: "2020-01-01" });
    const result = f.restore("memory", memory).result as JsonObject;
    assert.equal(result.auto_committed, false); assert.equal((result.candidate as JsonObject).status, "candidate"); assert.equal(f.store.count("memory_ledger"), 1);
    f.store.create("context_resolution_receipt", "r", { scope: { kind: "project", id: "assets" }, memory_refs: [{ memory_id: "m", memory_version: 1 }] });
    f.store.create("context_feedback", "feedback", { receipt_id: "r", outcome: "helpful", evidence_verified: true });
    const explain = f.inspect("memory", "m", { action: "explain" }); assert.equal(explain.authorship, "explicit_user_statement"); assert.equal(explain.followed, "unknown"); assert.equal((explain.receipts as unknown[]).length, 1);
    assert.equal((f.inspect("memory", (result.candidate as JsonObject).id, { kind: "memory_candidate", action: "explain" }).reasons as string[])[0], "memory_candidate");
    f.store.save("memory_ledger", "m", { ...payload(memory), evidence_ids: [], status: "revoked", replacement_id: "next", proposed_by: "agent" });
    assert.equal(f.inspect("memory", "m", { action: "explain" }).authorship, "agent");
    f.store.create("memory_ledger", "blank", { scope: { kind: "project", id: "assets" }, source_id: "source" });
    assert.equal(f.inspect("memory", "blank", { action: "explain" }).authorship, "unknown");
    f.service.memoryPolicySave({ mode: "off" }); assert.throws(() => f.restore("memory", memory, { expected_version: 2, request_id: "disabled" }), /restored asset/);
  } finally { await f.close(); }
});

test("Experience revisions restore as checked user drafts and explain recall separately from successful invocations", async () => {
  const f = await fixture();
  try {
    const p = f.service.procedureConfigurationSave({ procedure_id: "p", title: "Review", scope: "project:assets", scenario_id: "engineering", procedure_kind: "workflow", definition: spec() }).procedure as JsonObject;
    const restored = f.restore("experience", p).result as JsonObject;
    assert.equal((restored.procedure as JsonObject).routeable, false); assert.equal((restored.procedure as JsonObject).provenance, "user_configuration");
    f.store.create("context_resolution_receipt", "selected", { scope: { kind: "project", id: "assets" }, contributions: [{ member: "experience", references: [{ id: "p", version: 1 }] }] });
    f.store.create("experience_procedure_gate", "gate", { procedure_id: "p" });
    for (const status of ["passed", "failed"]) f.store.create("procedure_invocation_outcome", status, { procedure_id: "p", scope: "project:assets", status });
    const explained = f.inspect("experience", "p", { action: "explain" }); assert.equal((explained.diagnosis as JsonObject).verified_outcomes, 1); assert.equal((explained.diagnosis as JsonObject).model_effect_proven, false);
    f.store.create("experience_procedure", "legacy", { scope: "project:assets", routeable: true });
    assert.throws(() => f.restore("experience", f.store.get("experience_procedure", "legacy")), /checked/);
    f.store.create("workflow_design", "design", { scope: "project:assets" });
    assert.throws(() => f.restore("experience", f.store.get("workflow_design", "design"), { kind: "workflow_design" }), /primary/);
    assert.equal(f.inspect("experience", "legacy", { action: "explain" }).eligible_by_record_state, true);
    assert.equal(f.inspect("experience", "legacy", { action: "diff", version: 1, target_version: 1 }).content_changed, null);
    assert.equal(f.inspect("experience", "p", { action: "diff", version: 1, target_asset_id: "legacy", target_version: 1 }).content_changed, null);
  } finally { await f.close(); }
});

test("Codebase revisions rebuild the current checkpoint, retain provenance and reject old or unsupported analyzer restoration", async () => {
  const f = await fixture();
  try {
    const project = join(f.root, "project"); await mkdir(project); await writeFile(join(project, "a.ts"), "export function target() { return 1; }\n");
    f.service.workspaceOpen({ workspace_id: "ws", name: "Fixture", root_path: project, include_paths: ["a.ts"] });
    f.service.workspaceCheckpoint({ workspace_id: "ws", checkpoint_id: "c1", label: "c1" }); f.service.codebaseActivate({ workspace_id: "ws" });
    for (const analyzer of ["typescript", "heuristic"]) {
      const index = f.service.codebaseIndexBuild({ workspace_id: "ws", analyzer }).index as JsonObject;
      const args = { scope_kind: "workspace", scope_id: "ws" };
      f.service.codebaseSymbolFind({ workspace_id: "ws", index_id: index.id, query: "target" });
      const before = f.inspect("codebase", index.id, { ...args, action: "explain" }); assert.equal(before.candidate_only, true); assert.equal((before.receipts as unknown[]).length, 1);
      const rebuilt = f.restore("codebase", index, args); assert.equal((rebuilt.restoration as JsonObject).activation, "rebuilt_current_checkpoint");
      const current = f.store.get("codebase_index", String(index.id)); f.store.save("codebase_index", String(index.id), { ...payload(current), analyzer: "external-lsp" });
      assert.throws(() => f.restore("codebase", f.store.get("codebase_index", String(index.id)), { ...args, version: 2, request_id: `${analyzer}-unsupported` }), /adapter/);
    }
    f.service.workspaceCheckpoint({ workspace_id: "ws", checkpoint_id: "c2", label: "c2" });
    const index = f.store.list("codebase_index", 1)[0]!;
    assert.throws(() => f.restore("codebase", index, { scope_kind: "workspace", scope_id: "ws", request_id: "old" }), /historical/);
    f.service.codebaseDeactivate({ workspace_id: "ws" });
    assert.deepEqual(f.inspect("codebase", index.id, { scope_kind: "workspace", scope_id: "ws", action: "explain" }).reasons, ["checkpoint_changed", "index_disabled"]);
  } finally { await f.close(); }
});

test("ingestion failures expose bounded path/reason, and all component tools are reachable through their MCP and Workbench surfaces", async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "source"); await mkdir(path); await writeFile(join(path, "ok.md"), "Visible source content");
    f.service.knowledgeSourceRegister({ source_id: "files", kind: "readme", label: "Files", ...scope, locator: path, content_digest: "initial", trust: "verified", access: "read_only" });
    const ingested = f.service.knowledgeSourceIngest({ source_id: "files" }); assert.equal((ingested.ingestion_receipt as JsonObject).status, "completed");
    const doc = f.store.list("knowledge_document", 1)[0]!;
    assert.equal((f.inspect("knowledge", doc.id, { kind: "knowledge_document", action: "explain" }).documents as unknown[]).length, 1);
    await writeFile(join(path, "large.md"), "x".repeat(2_000_001));
    assert.throws(() => f.service.knowledgeSourceIngest({ source_id: "files" }), /budget/);
    const source = f.inspect("knowledge", "files", { kind: "knowledge_source", action: "explain" });
    assert((source.ingestions as JsonObject[]).some(r => r.path === "large.md" && r.reason === "file_byte_budget_exceeded"));
    for (const member of ["knowledge", "memory", "experience", "codebase"]) {
      const mcp = new McpServer(f.service, member === "codebase" ? "component-codebase" : `component-${member}-daily`);
      const kind = { knowledge: "knowledge_claim", memory: "memory_ledger", experience: "experience_procedure", codebase: "codebase_index" }[member]!;
      f.store.create(kind, member, { scope: "project:assets" });
      for (const verb of ["inspect", "restore"]) assert(mcp.tools.some(t => t.name === `craft_${member}_asset_${verb}`));
      const response = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: `craft_${member}_asset_inspect`, arguments: { ...scope, asset_id: member } } });
      assert.equal((response!.result as JsonObject).isError, false, JSON.stringify(response));
    }
    const app = new WorkbenchWebApp(f.service, "fixture", "http://127.0.0.1:4173"), request = (path: string, body: JsonObject) => app.handle({ method: "POST", path, token: "fixture", body: JSON.stringify(body) });
    assert.equal(request("/api/workbench/component-assets/inspect", { ...scope, member: "knowledge", asset_id: "knowledge" }).status, 200);
    const cfg = { procedure_id: "ui", scope: "project:assets", title: "UI", scenario_id: "engineering", procedure_kind: "workflow", definition: spec() };
    assert.equal(request("/api/workbench/procedure-configurations", cfg).status, 201);
    assert.equal(request("/api/workbench/component-assets/restore", { ...scope, member: "experience", asset_id: "ui", version: 1, expected_version: 1, request_id: "ui", reason: "review" }).status, 201);
  } finally { await f.close(); }
});

test("explanations remain bounded, hide privileged selections, preserve restored document provenance and paginate immutable metadata", async () => {
  const f = await fixture();
  try {
    const claim = f.store.create("knowledge_claim", "k", { scope: "project:assets", source_id: "source", kind: "fact", content: "Body", status: "candidate", document_id: "doc", document_digest: "digest", fragment_id: "fragment", source_revision_id: "revision" });
    assert.throws(() => f.restore("knowledge", claim), /evidence_ids/);
    const supported = f.store.save("knowledge_claim", "k", { ...payload(claim), evidence_ids: ["e"] });
    const restored = f.restore("knowledge", supported, { version: 2 }).result as JsonObject;
    assert.equal((restored.claim as JsonObject).document_id, "doc"); assert.equal((restored.claim as JsonObject).revalidation_required, true);
    assert.equal((f.inspect("knowledge", "k", { action: "explain" }).reasons as string[])[0], "claim_candidate");
    const memory = f.store.create("memory_ledger", "m", { scope: "project:assets", source_id: "source", content: "Body", kind: "preference", topic: "" });
    assert(f.restore("memory", memory).result);
    const legacy = f.service.procedureConfigurationSave({ procedure_id: "p", scope: "project:assets", title: "Inspect", procedure_kind: "workflow", scenario_id: "engineering", definition: spec() }).procedure as JsonObject;
    f.store.save("experience_procedure", "p", { ...payload(legacy), scenario_signature: {} });
    assert(f.restore("experience", f.store.get("experience_procedure", "p"), { version: 2 }).result);
    f.store.create("procedure_invocation", "run", { procedure_id: "p", scope: "project:assets", lifecycle: "active", subscenario_id: "bugfix", graph_state: { round: 1 } });
    f.store.create("procedure_invocation", "foreign", { procedure_id: "p", scope: "project:foreign" });
    assert.equal((f.inspect("experience", "p", { action: "explain" }).invocations as unknown[]).length, 1);
    f.store.create("context_resolution_receipt", "principal", { scope: { kind: "project", id: "assets" }, scope_access: { principal_present: true }, memory_refs: [{ memory_id: "m" }] });
    f.store.create("context_resolution_receipt", "tenant", { scope: { kind: "project", id: "assets" }, scope_access: { tenant_present: true }, memory_refs: [{ memory_id: "m" }] });
    assert.equal((f.inspect("memory", "m", { action: "explain" }).receipts as unknown[]).length, 0);
    f.store.transaction(() => { for (let n = 0; n < 102; n++) { f.store.create("knowledge_document", `doc${n}`, { source_id: "source", path: `file${n}.md` }); f.store.create("context_resolution_receipt", `r${n}`, { scope: { kind: "project", id: "assets" }, scope_access: {}, contributions: [{ references: [{ id: "k" }] }] }); } });
    const explained = f.inspect("knowledge", "k", { action: "explain" }); assert.equal(explained.documents_truncated, true); assert.equal(explained.receipts_truncated, true);
    assert.equal((explained.documents as unknown[]).length, 100);
    f.store.save("knowledge_claim", "k", { ...payload(claim), extra_field: "new" });
    assert((f.inspect("knowledge", "k", { action: "diff", version: 2, target_version: 3 }).changes as JsonObject[]).some(change => change.field === "extra_field" && change.before === null));
    f.inspect("knowledge", "k", { action: "diff", version: 3, target_version: 2 });
    for (const [before, limit] of [[0, 1], [1, 0], [1, 102]]) assert.throws(() => f.store.history("knowledge_claim", "k", before!, limit!), /bounds/);
  } finally { await f.close(); }
});
