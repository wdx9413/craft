import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";
import { productSurfaceOf } from "../core/interfaces/mcp/product-launch.ts";
import { CodexHookBridge, HookSignalSanitizer } from "../core/codex-hook-bridge.ts";
import { ContextResolutionKernel } from "../core/context-resolution.ts";
import { createActionHandlers } from "../core/application/actions/action-handlers.ts";
import { retrievalTerms } from "../core/retrieval-terms.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-hookless-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  const servers = Object.fromEntries(["knowledge", "memory", "experience", "codebase"].map((product) => [product, new McpServer(service, productSurfaceOf(product))]));
  return { root, store, service, servers, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

async function call(server: McpServer, name: string, args: JsonObject = {}, failure?: RegExp): Promise<JsonObject> {
  const response = await server.handle({ jsonrpc: "2.0", id: "test", method: "tools/call", params: { name, arguments: args } }) as JsonObject;
  const result = response.result as JsonObject;
  assert(result, JSON.stringify(response));
  if (failure) { assert.equal(result.isError, true); assert.match(JSON.stringify(result.content), failure); return result; }
  assert.equal(result.isError, false, JSON.stringify(result));
  return result.structuredContent as JsonObject;
}

test("strict MCP: each standalone resolves its own member, scope, gate and aggregate budget without hooks", async () => {
  const f = await fixture();
  try {
    await call(f.servers.memory!, "craft_knowledge_bootstrap_install");
    const identity = await call(f.servers.memory!, "craft_scope_identity_resolve_project", { project_root: f.root });
    const scope = (identity.identity as JsonObject).canonical_scope as JsonObject;
    for (const product of ["knowledge", "memory", "experience"]) {
      const server = f.servers[product]!;
      const resolved = await call(server, "craft_context_resolution_resolve", { query: "测试", scope_kind: scope.kind, scope_id: scope.id });
      assert.deepEqual((resolved.receipt as JsonObject).members, [product]);
      await call(server, "craft_context_resolution_resolve", { query: "测试", scope_kind: scope.kind, scope_id: scope.id, members: ["wrong"] }, /mounted component/);
      const gate = await call(server, "craft_decision_context_gate_open", { query: "测试", decision_kind: "plan", scope_kind: scope.kind, scope_id: scope.id, require_context: true });
      assert.equal((gate.gate as JsonObject).status, "blocked");
    }
    const saved = await call(f.servers.memory!, "craft_memory_capture_user_statement", { content: "先运行单元测试", explicit_consent: true, auto_accept: true, scope_kind: scope.kind, scope_id: scope.id });
    assert(saved);
    const memories = (await call(f.servers.memory!, "craft_memory_ledger_list", { scope_kind: scope.kind, scope_id: scope.id })).memories as JsonObject[];
    assert.equal(memories.length, 1);
    f.store.create("knowledge_claim", "rule", { status: "reviewed", source_id: "builtin.evidence-wiki", scope: `${scope.kind}:${scope.id}`, content: "运行测试", evidence_ids: [] });
    const isolated = await call(f.servers.memory!, "craft_context_resolution_resolve", { query: "测试", scope_kind: scope.kind, scope_id: scope.id });
    assert.equal((isolated.items as unknown[]).length, 1);
    assert.deepEqual(isolated.contributions, []);
    const aggregate = await f.service.contextResolutionResolve({ query: "测试", scope_kind: scope.kind, scope_id: scope.id, max_items: 1, max_chars: 20 });
    assert.equal((aggregate.receipt as JsonObject).total_items, 1);
    assert(Number((aggregate.receipt as JsonObject).total_used_chars) <= 20);
    const gate = await call(f.servers.knowledge!, "craft_decision_context_gate_open", { query: "测试", decision_kind: "plan", scope_kind: scope.kind, scope_id: scope.id, require_context: true });
    assert.equal((gate.gate as JsonObject).status, "ready");
    await call(f.servers.memory!, "craft_memory_ledger_transition", { memory_id: memories[0]!.id, status: "revoked", reason: "user correction" });
    const empty = await call(f.servers.memory!, "craft_context_resolution_resolve", { query: "测试", scope_kind: scope.kind, scope_id: scope.id });
    assert.deepEqual(empty.items, []);
    const missing = await call(f.servers.memory!, "craft_context_resolution_resolve", { query: "测试" });
    assert.equal(missing.reason, "scope_unavailable");
    await call(f.servers.memory!, "craft_context_resolution_resolve", { query: "测试", members: "memory" }, /must be array/);
    await call(f.servers.memory!, "craft_context_resolution_resolve", { query: "测试", unknown: true }, /not allowed/);
  } finally { await f.close(); }
});

test("Knowledge search fails closed without scope and separates candidate inspection from Context", async () => {
  const f = await fixture();
  try {
    f.service.knowledgeMemoryInstallBuiltins();
    for (const [id, scope, status] of [["a", "a", "reviewed"], ["b", "b", "reviewed"], ["candidate", "a", "candidate"], ["expired", "a", "reviewed"]]) {
      f.store.create("knowledge_claim", id!, { source_id: "builtin.evidence-wiki", status, scope: `project:${scope}`, content: "单元测试与测试策略", evidence_ids: [], valid_until: id === "expired" ? "2000-01-01" : null });
    }
    const server = f.servers.knowledge!;
    assert.equal((await call(server, "craft_knowledge_search", { query: "怎么运行测试" })).reason, "scope_unavailable");
    const scoped = { query: "怎么运行测试", scope_kind: "project", scope_id: "a" };
    assert.deepEqual(((await call(server, "craft_knowledge_search", scoped)).hits as JsonObject[]).map((hit) => hit.claim_id), ["a"]);
    assert.equal(((await call(server, "craft_knowledge_search", { ...scoped, include_candidates: true })).hits as unknown[]).length, 2);
    await call(server, "craft_knowledge_search", { ...scoped, limit: 0 }, /limit/);
    const bare = new ContextResolutionKernel(f.store);
    assert.equal((await bare.searchKnowledge(scoped)).reason, "knowledge_unavailable");
    assert(retrievalTerms("单元测试 test_identifier").includes("测试"));
    assert.deepEqual(retrievalTerms("!?"), []);
    const bad = new ContextResolutionKernel(f.store, [{ member: "knowledge", contribute: async () => ({ member: "knowledge", items: [{ content: "x".repeat(8_000_001) }], receipt_id: "bad", omitted_count: 0 }) }]);
    await assert.rejects(() => bad.resolve({ ...scoped, members: ["knowledge"], max_chars: 1 }), /aggregate budget/);
  } finally { await f.close(); }
});

test("Experience accepts array contracts over MCP and remains candidate until quality gates", async () => {
  const f = await fixture();
  try {
    const server = f.servers.experience!;
    const evidence = await call(server, "craft_evidence_record", { source_type: "observation", confidence: "bounded", claim: "Observed fixture test result" });
    for (const id of ["one", "two"]) await call(server, "craft_experience_observe", { source_kind: "fixture", source_id: id, source_digest: `sha256:${id}`, scope: "project:demo", outcome: "passed", sanitized: true, scenario_key: "coding:verify", evidence_ids: [evidence.id] });
    const args = { scenario_key: "coding:verify", hypothesis: "Run focused tests", design_axes: ["orchestration"], output_contract_ref: "acceptance:tests" };
    await call(server, "craft_experience_procedure_draft", { ...args, design_axes: {} }, /must be array/);
    const draft = (await call(server, "craft_experience_procedure_draft", args)).request as JsonObject;
    const proposal = (await call(server, "craft_experience_procedure_submit", { request_id: draft.id, workflow_id: "verify", name: "Verify", description: "Run tests", inputs: [], steps: [{ type: "assertion" }] })).proposal as JsonObject;
    const procedure = (await call(server, "craft_procedure_create", { proposal_id: proposal.id, preconditions: [], trigger: "verify" })).procedure as JsonObject;
    assert.equal(procedure.routeable, false);
    const resolved = await call(server, "craft_context_resolution_resolve", { query: "verify", scope_kind: "project", scope_id: "demo" });
    assert.equal(((resolved.contributions as JsonObject[])[0]!.items as unknown[]).length, 0);
  } finally { await f.close(); }
});

test("Codebase alone can declare, checkpoint, activate, query and refresh changed paths", async () => {
  const f = await fixture();
  try {
    const project = join(f.root, "project"); await mkdir(project); await writeFile(join(project, "main.ts"), "export function target() { return 1; }\n");
    const server = f.servers.codebase!;
    const declaration = { workspace_id: "demo", root_path: project, include_paths: ["main.ts"] };
    await call(server, "craft_codebase_workspace_open", declaration);
    assert.equal((await call(server, "craft_codebase_workspace_open", declaration)).idempotent, true);
    await call(server, "craft_codebase_workspace_open", { ...declaration, include_paths: ["other"] }, /conflict/);
    await call(server, "craft_codebase_refresh", { workspace_id: "demo" }, /not explicitly active/);
    await call(server, "craft_codebase_activate", { workspace_id: "demo" });
    const built = (await call(server, "craft_codebase_refresh", { workspace_id: "demo" })).index as JsonObject;
    const args = { workspace_id: "demo", index_id: built.id };
    const symbols = (await call(server, "craft_codebase_symbol_find", { ...args, query: "target" })).symbols as JsonObject[];
    const slice = await call(server, "craft_codebase_context_slice", { ...args, node_ids: [symbols[0]!.id] });
    assert.equal(slice.content_included, false);
    await writeFile(join(project, "main.ts"), "export function changed() {}\n");
    assert.equal(((await call(server, "craft_codebase_status", { workspace_id: "demo" })).working_tree as JsonObject).status, "changed");
    const refreshed = await call(server, "craft_codebase_refresh", { workspace_id: "demo" });
    assert.deepEqual((refreshed.freshness as JsonObject).changed_paths, ["main.ts"]);
    await call(server, "craft_codebase_symbol_find", { ...args, query: "target" }, /stale/);
  } finally { await f.close(); }
});

test("Hook observations never mistake command success, old edits or session identity for verified task success", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service); const sanitizer = new HookSignalSanitizer();
    for (const command of ["npm --version", "npm install", "echo pytest", "npm test; true", "npm test | cat", "npm test\ntrue"]) assert.equal(sanitizer.signal({ tool_name: "Bash", tool_input: { command }, tool_response: { exit_code: 0 } }), null);
    const base = { cwd: f.root, session_id: "session", turn_id: "turn" };
    const event = async (tool: string, command: string, exit_code: number) => bridge.handle("experience", { ...base, hook_event_name: "PostToolUse", tool_name: tool, tool_input: { command }, tool_response: { exit_code } });
    await event("Edit", "", 0); await event("Bash", "npm --version", 0); await event("Bash", "npm test", 1);
    await bridge.handle("experience", { ...base, hook_event_name: "Stop" });
    assert.equal(f.store.list("workflow_evolution_observation", 10)[0]!.outcome, "failed");
    await event("Bash", "npm test", 0);
    assert.equal(bridge.journal.find(base)!.verification_outcome, "passed");
    await event("Edit", "", 0);
    assert.equal(bridge.journal.find(base)!.verification_outcome, null);
    await event("Bash", "npm test", 0);
    await bridge.handle("experience", { ...base, hook_event_name: "Stop" });
    assert(f.store.list("evidence", 10).every((record) => record.confidence === "bounded"));
    assert.equal(bridge.journal.find({ cwd: f.root, session_id: "session" }), null);
  } finally { await f.close(); }
});

test("external code analyzers import only checkpoint-bound UTF-16 facts for Java, Python and Go", async () => {
  const f = await fixture();
  try {
    const root = join(f.root, "repo"); await mkdir(root);
    for (const [path, content] of [["A.java", "class A {}"], ["a.py", "def test(): pass"], ["a.go", "func test() {}"]]) await writeFile(join(root, path!), content!);
    const server = f.servers.codebase!;
    await call(server, "craft_codebase_workspace_open", { workspace_id: "languages", root_path: root, include_paths: ["."] });
    await call(server, "craft_codebase_activate", { workspace_id: "languages" });
    const checkpoint = f.store.get("workspace_checkpoint", String(f.store.get("workspace", "languages").latest_checkpoint_id));
    const entries = checkpoint.entries as JsonObject[];
    const analysis = { format: "craft-static-analysis-v1", analyzer: "fixture-lsp", analyzer_version: "1", nodes: entries.map((entry, i) => ({ id: `n${i}`, kind: "symbol", name: "test", path: entry.path, source_digest: entry.digest, language: ["java", "go", "python"][i], span: { start_offset: 0, end_offset: 3 } })), edges: [{ kind: "calls", from_node_id: "n1", to_node_id: "n0", source_span: { start_offset: 0, end_offset: 3 } }] };
    const args = { workspace_id: "languages", checkpoint_id: checkpoint.id, analysis };
    const imported = await call(server, "craft_codebase_analysis_import", args); const index = imported.index as JsonObject;
    assert.equal((index.analysis as JsonObject).provenance, "adapter_reported");
    assert.equal((await call(server, "craft_codebase_analysis_import", args)).idempotent, true);
    await call(server, "craft_codebase_symbol_find", { workspace_id: "other", index_id: index.id, query: "test" }, /does not belong/);
    const found = await call(server, "craft_codebase_symbol_find", { workspace_id: "languages", index_id: index.id, query: "test" });
    assert.equal((found.symbols as JsonObject[]).length, 3);
    assert.equal((found.receipt as JsonObject).analyzer, "fixture-lsp");
    const callers = await call(server, "craft_codebase_callers_find", { workspace_id: "languages", index_id: index.id, symbol_id: "n0" }); assert.equal((callers.callers as unknown[]).length, 1);
    for (const [field, value, error] of [["source_digest", "wrong", /digest/], ["path", "../elsewhere", /outside/], ["span", { start_offset: -1, end_offset: 3 }, /span/], ["kind", "command", /kind/]] as const) {
      const changed = structuredClone(analysis); Object.assign(changed.nodes[0]!, { [field]: value });
      await call(server, "craft_codebase_analysis_import", { ...args, analysis: changed }, error);
    }
    await call(server, "craft_codebase_analysis_import", { ...args, analysis: { ...analysis, nodes: [...analysis.nodes, analysis.nodes[0]] } }, /unique/);
    await call(server, "craft_codebase_analysis_import", { ...args, analysis: { ...analysis, edges: [{ kind: "calls", from_node_id: "missing" }] } }, /endpoint/);
    await call(server, "craft_codebase_analysis_import", { ...args, analysis: { ...analysis, edges: [{ ...analysis.edges[0], kind: "exec" }] } }, /kind/);
    await call(server, "craft_codebase_analysis_import", { ...args, analysis: { ...analysis, format: "unknown" } }, /format/);
    await call(server, "craft_codebase_analysis_import", { ...args, analysis: { ...analysis, nodes: [] } }, /budget/);
    await call(server, "craft_codebase_analysis_import", { ...args, analysis: { ...analysis, analyzer: "a".repeat(101) } }, /budget/);
    await call(server, "craft_codebase_analysis_import", { ...args, analysis: { ...analysis, extra: "a".repeat(2_000_000) } }, /budget/);
    await call(server, "craft_codebase_analysis_import", { ...args, index_id: index.id, analysis: { ...analysis, analyzer_version: "2" } }, /conflict/);
    await writeFile(join(root, "a.py"), "def changed(): pass"); await call(server, "craft_codebase_refresh", { workspace_id: "languages" });
    await call(server, "craft_codebase_analysis_import", args, /latest/);
    await call(server, "craft_codebase_symbol_find", { workspace_id: "languages", index_id: index.id, query: "test" }, /stale/);
  } finally { await f.close(); }
});

test("memory transitions reject stale writes and repeat without adding versions", async () => {
  const f = await fixture();
  try {
    f.service.knowledgeMemoryInstallBuiltins();
    const memory = (f.service.memoryLedgerRemember({ source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "project", scope_id: "cas", content: "Use scoped data" }).memory as JsonObject);
    const args = { memory_id: memory.id, status: "revoked", reason: "correction" };
    await call(f.servers.memory!, "craft_memory_ledger_transition", { ...args, expected_version: 99 }, /Concurrent/i);
    await call(f.servers.memory!, "craft_memory_ledger_transition", { ...args, expected_version: 0 }, /positive/);
    const done = await call(f.servers.memory!, "craft_memory_ledger_transition", { ...args, expected_version: memory.version });
    const repeat = await call(f.servers.memory!, "craft_memory_ledger_transition", args);
    assert.equal(repeat.idempotent, true); assert.equal((done.memory as JsonObject).version, (repeat.memory as JsonObject).version);
    await call(f.servers.memory!, "craft_memory_ledger_transition", { ...args, status: "expired" }, /active/);
  } finally { await f.close(); }
});

test("Context feedback pins the exact receipt without mutating source status or crossing members", async () => {
  const f = await fixture();
  try {
    const result = await call(f.servers.memory!, "craft_context_resolution_resolve", { scope_kind: "project", scope_id: "feedback", query: "test" });
    const args = { receipt_id: (result.receipt as JsonObject).id, outcome: "helpful", feedback_id: "feedback" };
    assert.equal((await call(f.servers.memory!, "craft_context_resolution_feedback", args)).idempotent, false);
    assert.equal((await call(f.servers.memory!, "craft_context_resolution_feedback", args)).idempotent, true);
    await call(f.servers.memory!, "craft_context_resolution_feedback", { ...args, outcome: "invalid" }, /Unsupported/);
    await call(f.servers.memory!, "craft_context_resolution_feedback", { ...args, outcome: "stale" }, /conflict/);
    await call(f.servers.knowledge!, "craft_context_resolution_feedback", args, /another component/);
    const e = f.service.evidenceRecord({ source_type: "observation", confidence: "bounded", claim: "feedback fixture" });
    const saved = f.service.contextResolutionFeedback({ ...args, feedback_id: "unmounted", evidence_ids: [e.id] }); assert(saved.feedback);
    assert.equal((result.receipt as JsonObject).content_free, true);
    assert.equal((await call(f.servers.memory!, "craft_context_resolution_feedback", { receipt_id: args.receipt_id, outcome: "stale" })).idempotent, false);
    const unmounted = createActionHandlers(f.service);
    await unmounted.craft_context_resolution_resolve!({ scope_kind: "project", scope_id: "feedback", query: "test" });
  } finally { await f.close(); }
});

test("explicit verification intake validates sequence and outcome while retaining host-attested provenance", async () => {
  const f = await fixture();
  try {
    const server = f.servers.experience!;
    const evidence = await call(server, "craft_evidence_record", { source_type: "observation", confidence: "bounded", claim: "verified fixture" });
    const args = { source_kind: "ci", source_id: "job-1", source_digest: "sha256:fixture", scope: "project:fixture", outcome: "passed", sanitized: true, scenario_key: "verify", evidence_ids: [evidence.id] };
    const verification = { contract_ref: "test:focused", workspace_revision: "git:fixture", evidence_digest: "sha256:fixture", producer: "ci", started_at: "2026-09-27T00:00:00Z", completed_at: "2026-09-27T00:01:00Z", exit_code: 0 };
    const result = await call(server, "craft_experience_observe", { ...args, verification });
    assert.equal(((result.observation as JsonObject).verification as JsonObject).independently_verified, false);
    for (const changed of [{ ...verification, exit_code: 1 }, { ...verification, exit_code: 0.5 }, { ...verification, started_at: "bad" }, { ...verification, completed_at: "2026-09-26T00:00:00Z" }]) await call(server, "craft_experience_observe", { ...args, verification: changed }, /Verification/);
    await call(server, "craft_experience_observe", { ...args, outcome: "failed", verification }, /contradicts/);
    assert.throws(() => f.service.workflowEvolution.observe({ ...args, verification: [] }), /object/);
    await call(server, "craft_experience_observe", { ...args, outcome: "inconclusive", verification: { ...verification, exit_code: 2 } });
  } finally { await f.close(); }
});

test("Knowledge source digest drift invalidates reviewed claims", async () => {
  const f = await fixture();
  try {
    f.service.knowledgeSourceRegister({ source_id: "source", kind: "project_note", label: "Source", trust: "verified", scope_kind: "project", scope_id: "demo", locator: "README.md", content_digest: "sha256:old" });
    const evidence = f.service.evidenceRecord({ source_type: "observation", confidence: "bounded", claim: "fixture fact" });
    const saved = f.service.knowledgeClaimSave({ claim_id: "fresh", kind: "fact", content: "测试策略", scope: "project:demo", source_id: "source", evidence_ids: [evidence.id] });
    f.service.knowledgeClaimReview({ claim_id: (saved.claim as JsonObject).id, status: "reviewed", reviewer: "fixture", reason: "supported" });
    const args = { query: "测试", scope_kind: "project", scope_id: "demo" };
    assert.equal(((await f.service.knowledgeSearchScoped(args)).hits as unknown[]).length, 1);
    const source = f.store.get("knowledge_source", "source"); f.store.save("knowledge_source", "source", { ...source, content_digest: "sha256:new" });
    assert.equal(((await f.service.knowledgeSearchScoped(args)).hits as unknown[]).length, 0);
    f.store.save("knowledge_claim", "fresh", { ...(saved.claim as JsonObject), status: "reviewed", review: { source_digest: "sha256:new" } });
    await assert.rejects(async () => await f.service.contextResolutionResolve({ ...args, members: ["knowledge"], source_ids: ["builtin.evidence-wiki"], now: "2026-09-27" }), /unavailable/);
    f.service.knowledgeMemoryInstallBuiltins();
    assert.equal(((await f.service.contextResolutionResolve({ ...args, members: ["knowledge"], source_ids: ["builtin.evidence-wiki"], now: "2026-09-27" })).contributions as JsonObject[])[0]!.items instanceof Array, true);
  } finally { await f.close(); }
});

test("Codebase bootstrap recovers an interrupted declaration and exposes unavailable freshness", async () => {
  const f = await fixture();
  try {
    const root = join(f.root, "recovery"); await mkdir(root); await writeFile(join(root, "a.ts"), "function a() {}\n");
    const args = { workspace_id: "recovery", root_path: root, include_paths: ["a.ts"] };
    f.service.workspaceOpen({ ...args, name: "recovery" });
    assert.equal(f.service.workspace.freshness(args).status, "unavailable");
    assert.equal((await call(f.servers.codebase!, "craft_codebase_workspace_open", args)).idempotent, false);
    f.service.knowledgeMemoryInstallBuiltins();
    const e = f.service.evidenceRecord({ source_type: "observation", confidence: "bounded", claim: "fixture" });
    const c = f.service.knowledgeClaimSave({ kind: "fact", content: "fixture", scope: "project:recovery", source_id: "builtin.evidence-wiki", evidence_ids: [e.id] }).claim as JsonObject;
    f.service.knowledgeClaimReview({ claim_id: c.id, status: "disputed", reviewer: "fixture", reason: "unsupported" });
  } finally { await f.close(); }
});

test("Hook verification before any edit is observable but cannot establish a verified change", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service);
    await bridge.handle("experience", { hook_event_name: "PostToolUse", cwd: f.root, session_id: "s", turn_id: "no-edit", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exit_code: 0 } });
    const journal = f.store.list("codex_hook_turn", 10)[0]!;
    assert.equal(journal.has_edit, false); assert.equal(journal.edit_revision, null);
    assert.equal((journal.verification_receipts as JsonObject[])[0]!.edit_revision, null);
  } finally { await f.close(); }
});
