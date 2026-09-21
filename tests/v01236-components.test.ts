import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { CraftService } from "../src/service.ts";
import { ProcedureDefinitionStore } from "../capability/craft-experience/procedure-definition.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-v01236-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store, service: await CraftService.open(store) };
}
async function dispose(f: Awaited<ReturnType<typeof fixture>>) { f.store.close(); await rm(f.root, { recursive: true, force: true }); }

test("v0.12.36 resolves one canonical project through an explicit legacy alias without global fallback", async () => {
  const f = await fixture();
  try {
    f.service.knowledgeMemoryInstallBuiltins();
    const identity = f.service.scopeIdentityResolveProject({ project_root: f.root }).identity as JsonObject;
    const canonical = identity.canonical_scope as JsonObject;
    f.service.scopeAliasMigrate({ project_root: f.root, legacy_scope_id: "project:old-machine-path" });
    f.service.memoryLedgerRemember({ memory_id: "legacy-memory", source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "project", scope_id: "project:old-machine-path", content: "Prefer verified local tests.", confidence: "bounded", topic: "testing" });
    const resolved = await f.service.contextResolutionResolve({ receipt_id: "scope-receipt", query: "verified tests", scope_kind: "project", scope_id: canonical.id });
    assert.match(String((resolved.items as JsonObject[])[0]?.content), /verified local tests/u);
    const receipt = resolved.receipt as JsonObject;
    assert.equal((receipt.attempted_scopes as JsonObject[]).some((scope) => scope.id === "project:old-machine-path"), true);
    assert.equal((receipt.excluded_scopes as JsonObject[]).some((entry) => entry.reason === "explicit_global_not_requested"), true);
  } finally { await dispose(f); }
});

test("v0.12.36 records actual keyword fallback when an eligible vector adapter has no provider credential", async () => {
  const f = await fixture();
  try {
    f.service.knowledgeMemoryInstallBuiltins();
    f.service.memoryLedgerRemember({ memory_id: "m", source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "project", scope_id: "p", content: "Use bounded retrieval receipts.", confidence: "bounded" });
    f.service.retrievalAdapterConfigure({ adapter_id: "vector", strategy: "vector", provider_fingerprint: "provider-v1", configuration: { endpoint: "https://example.invalid/embeddings", model: "embed", credential_env: "CRAFT_TEST_MISSING_KEY" } });
    f.service.retrievalAdapterEvaluate({ adapter_id: "vector", metrics: { recall: 1, cross_project_leak_count: 0, latency_ms: 1, cost_usd: 0 } });
    const resolved = await f.service.contextResolutionResolve({ receipt_id: "vector-fallback", query: "retrieval", scope_kind: "project", scope_id: "p", retrieval_adapter_id: "vector" });
    const receipt = resolved.receipt as JsonObject;
    assert.equal(((receipt.retrieval_execution as JsonObject).used), "keyword");
    assert.equal(((receipt.retrieval_execution as JsonObject).unavailable_reason), "embedding_provider_unavailable");
  } finally { await dispose(f); }
});

test("v0.12.36 keeps hybrid unavailable until its embedding provider can really run", async () => {
  const f = await fixture();
  try {
    f.service.knowledgeMemoryInstallBuiltins();
    f.service.memoryLedgerRemember({ memory_id: "hybrid-memory", source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "project", scope_id: "project:hybrid", topic: "testing", content: "Run focused tests before broad verification." });
    const configured = f.service.retrievalAdapterConfigure({ adapter_id: "hybrid", strategy: "hybrid", provider_fingerprint: "embed:v1", configuration: { endpoint: "https://example.invalid/embeddings", model: "embed", credential_env: "MISSING_EMBEDDING_KEY" } }).adapter as JsonObject;
    f.service.retrievalAdapterEvaluate({ adapter_id: configured.id, metrics: { recall: 1, cross_project_leak_count: 0, latency_ms: 1, cost_usd: 0 } });
    const result = await f.service.contextResolutionResolve({ receipt_id: "hybrid-receipt", query: "focused tests", scope_kind: "project", scope_id: "project:hybrid", retrieval_adapter_id: configured.id }) as JsonObject;
    assert.equal((result.receipt as JsonObject).retrieval_mode, "keyword");
    assert.equal(((result.receipt as JsonObject).retrieval_execution as JsonObject).unavailable_reason, "embedding_provider_unavailable");
    assert.equal(((result.items as JsonObject[])[0]).reason, "keyword_bm25");
  } finally { await dispose(f); }
});

test("v0.12.36 ingests immutable source revisions as Evidence and candidates, never reviewed context", async () => {
  const f = await fixture();
  try {
    const sourceRoot = join(f.root, "notes"); await (await import("node:fs/promises")).mkdir(sourceRoot);
    await writeFile(join(sourceRoot, "README.md"), "# Rule\nRun focused verification before delivery.\n", "utf8");
    const source = f.service.knowledgeSourceRegister({ source_id: "source", kind: "readme", label: "fixture", scope_kind: "project", scope_id: "p", locator: sourceRoot, content_digest: "registered", trust: "verified", access: "read_only" }).source as JsonObject;
    assert.throws(() => f.service.knowledgeSourceIngest({ source_id: source.id, root: f.root }), /outside the registered Source locator/u);
    const ingested = f.service.knowledgeSourceIngest({ source_id: source.id, root: sourceRoot, max_files: 5, max_chars_per_fragment: 200 });
    assert.equal((ingested.fragments as JsonObject[]).length, 1);
    assert.equal((ingested.candidates as JsonObject[])[0]?.status, "candidate");
    assert.equal(f.store.list("knowledge_claim", 10).length, 1);
    assert.equal(f.store.list("knowledge_claim", 10)[0]?.status, "candidate");
    await writeFile(join(sourceRoot, "README.md"), "# Rule\nRun full verification before delivery.\n", "utf8");
    const refreshed = f.service.knowledgeSourceIngest({ source_id: source.id, root: sourceRoot, max_files: 5, max_chars_per_fragment: 200 });
    assert.notEqual((refreshed.revision as JsonObject).id, (ingested.revision as JsonObject).id);
  } finally { await dispose(f); }
});

test("v0.12.36 ingests only bounded readable files and makes stale reviewed claims explicit", async () => {
    const f = await fixture();
  try {
    const sourceRoot = join(f.root, "source-tree"); await mkdir(join(sourceRoot, "nested"), { recursive: true }); await mkdir(join(sourceRoot, "zzz")); await mkdir(join(sourceRoot, ".git")); await mkdir(join(sourceRoot, "node_modules"));
    await writeFile(join(sourceRoot, "nested", "note.txt"), "first version", "utf8"); await writeFile(join(sourceRoot, "zzz", "later.txt"), "must skip by limit", "utf8"); await writeFile(join(sourceRoot, ".hidden.md"), "must skip", "utf8"); await writeFile(join(sourceRoot, "node_modules", "skip.md"), "must skip", "utf8");
    const outside = join(f.root, "outside.md"); await writeFile(outside, "must never ingest", "utf8"); await symlink(outside, join(sourceRoot, "leak.md"));
    const source = f.service.knowledgeSourceRegister({ source_id: "ingest-source", kind: "readme", label: "source", scope_kind: "project", scope_id: "p", locator: sourceRoot, content_digest: "registered", trust: "bounded", access: "read_only" }).source as JsonObject;
    assert.equal(f.service.knowledgeSourceIngest({ source_id: source.id, root: join(sourceRoot, "missing") }).status, "unavailable");
    assert.throws(() => f.service.knowledgeSourceIngest({ source_id: source.id, root: sourceRoot, max_files: 0 }), /budget/u);
    const first = f.service.knowledgeSourceIngest({ source_id: source.id, root: sourceRoot, max_files: 1, max_chars_per_fragment: 100 });
    assert.equal((first.fragments as JsonObject[]).length, 1);
    assert.doesNotMatch(JSON.stringify(first), /must never ingest/u);
    const claim = (first.candidates as JsonObject[])[0]!.claim_id as string;
    f.store.save("knowledge_claim", claim, { ...f.store.get("knowledge_claim", claim), status: "reviewed" });
    await writeFile(join(sourceRoot, "nested", "note.txt"), "second version", "utf8");
    f.service.knowledgeSourceIngest({ source_id: source.id, root: sourceRoot, max_files: 1, max_chars_per_fragment: 100 });
    assert.equal(f.store.get("knowledge_claim", claim).status, "stale");
    const proposalOnly = f.service.knowledgeSourceRegister({ source_id: "proposal-only", kind: "readme", label: "proposal", scope_kind: "project", scope_id: "p", locator: sourceRoot, content_digest: "proposal", trust: "bounded", access: "proposal_only" }).source as JsonObject;
    assert.throws(() => f.service.knowledgeSourceIngest({ source_id: proposalOnly.id, root: sourceRoot }), /read-only ingest/u);
    f.service.knowledgeSourceTransition({ source_id: source.id, status: "disabled", reason: "test" });
    assert.throws(() => f.service.knowledgeSourceIngest({ source_id: source.id, root: sourceRoot }), /read-only ingest/u);
    const singleFile = f.service.knowledgeSourceRegister({ source_id: "single-file", kind: "readme", label: "file", scope_kind: "project", scope_id: "p", locator: join(sourceRoot, "nested", "note.txt"), content_digest: "file", trust: "bounded", access: "read_only" }).source as JsonObject;
    assert.equal((f.service.knowledgeSourceIngest({ source_id: singleFile.id, max_chars_per_fragment: 100 }).fragments as JsonObject[]).length, 1);
    assert.equal((f.service.knowledgeSourceIngest({ source_id: singleFile.id, max_chars_per_fragment: 100 }).fragments as JsonObject[]).length, 1);
    const emptyPath = join(sourceRoot, "empty.md"); await writeFile(emptyPath, "\n\n", "utf8");
    const emptySource = f.service.knowledgeSourceRegister({ source_id: "empty-file", kind: "readme", label: "empty", scope_kind: "project", scope_id: "p", locator: emptyPath, content_digest: "empty", trust: "bounded", access: "read_only" }).source as JsonObject;
    assert.deepEqual(f.service.knowledgeSourceIngest({ source_id: emptySource.id, max_chars_per_fragment: 100 }).fragments, []);
  } finally { await dispose(f); }
});

test("v0.12.36 keeps temporal conflict abstention and schedules only bounded maintenance", async () => {
  const f = await fixture();
  try {
    f.service.knowledgeMemoryInstallBuiltins();
    for (const [id, content] of [["old", "I drink coffee."], ["new", "I avoid coffee."]] as const) f.service.memoryLedgerRemember({ memory_id: id, source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "user", scope_id: "u", content, confidence: "bounded", topic: "drink:coffee", observed_at: "2026-09-01T00:00:00.000Z", effective_from: id === "old" ? "2026-01-01T00:00:00.000Z" : "2026-09-01T00:00:00.000Z" });
    const resolved = await f.service.contextResolutionResolve({ query: "coffee", scope_kind: "user", scope_id: "u", receipt_id: "conflict" });
    assert.equal((resolved.items as JsonObject[]).length, 0);
    assert.equal(((resolved.receipt as JsonObject).excluded_scopes as JsonObject[]).some((item) => item.reason === "temporal_conflict_abstain"), true);
    assert.equal(f.service.memoryMaintenanceSchedule({ stage: "review" }).status, "skipped");
    assert.equal(f.service.memoryMaintenanceSchedule({ stage: "light", lease_id: "light" }).status, "completed");
  } finally { await dispose(f); }
});

test("v0.12.36 exports replayable schema-3 bundles and turns merge collisions into candidates", async () => {
  const source = await fixture(); const target = await fixture();
  try {
    source.service.knowledgeMemoryInstallBuiltins();
    source.service.memoryLedgerRemember({ memory_id: "portable", source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "project", scope_id: "project:portable", content: "Keep portable knowledge scoped.", confidence: "bounded" });
    const bundle = source.service.knowledgeMemoryBundleManage({ operation: "export", scope_kind: "project", scope_id: "project:portable", device_id: "laptop", export_id: "export-one", cursor: "cursor-1" }).bundle as JsonObject;
    assert.equal(bundle.schema_version, 3); assert.equal(bundle.device_id, "laptop");
    assert.equal(target.service.knowledgeMemoryBundleManage({ operation: "verify", bundle }).valid, true);
    assert.equal((target.service.knowledgeMemoryBundleManage({ operation: "import_apply", import_id: "portable-import", approved: true, bundle }).import as JsonObject).merge_receipt instanceof Object, true);
    target.store.save("memory_ledger", "portable", { ...target.store.get("memory_ledger", "portable"), content_digest: "sha256:conflicting-local-record" });
    const conflict = target.service.knowledgeMemoryBundleManage({ operation: "import_apply", import_id: "portable-conflict", approved: true, bundle }).plan as JsonObject;
    assert.equal(conflict.conflicts, 1);
    assert.equal(target.store.list("knowledge_memory_conflict", 10).length, 1);
  } finally { await dispose(source); await dispose(target); }
});

test("portable bundles rehydrate Workflow JSON definitions under the receiving Experience domain", async () => {
  const source = await fixture(); const target = await fixture();
  try {
    const definition = new ProcedureDefinitionStore(source.store.paths).write({
      schema_version: "craft.procedure.v1", procedure_id: "portable-procedure", procedure_version: 1, kind: "workflow",
      scope: "project:p", trigger: "portable verification", preconditions: ["workspace ready"], allowed_effects: ["read"],
      acceptance_ref: "acceptance:fixture", failure_disposition: "checkpoint_and_handoff", scenario_signature: { project: "p", target_class: "fixture" },
      evidence_ids: ["evidence"], proposal_ref: { id: "proposal", version: 1 }, definition: { inputs: [], steps: [{ type: "assertion" }] },
    }, "Portable verification");
    const content = source.store.contentStore.writeSync({ kind: "experience", record_id: "portable-procedure", version: 1, scope: "project:p", status: "routeable", sensitivity: "internal", source_id: "fixture", title: "Portable verification", folder: "workflows", body: "# Portable verification\n" });
    source.store.create("experience_procedure", "portable-procedure", { procedure_kind: "workflow", scope: "project:p", trigger: "portable verification", title: "Portable verification", acceptance_ref: "acceptance:fixture", scenario_signature: { project: "p", target_class: "fixture" }, lifecycle: "routeable", routeable: true, content_ref: content, content_digest: content.digest, definition_ref: definition, definition_digest: definition.digest });
    const bundle = source.service.knowledgeMemoryBundleExport({ scope_kind: "project", scope_id: "p" }).bundle as JsonObject;
    const entry = (bundle.records as JsonObject[]).find((item) => item.kind === "experience_procedure")!;
    assert.equal(((entry.payload as JsonObject).definition_ref as JsonObject).path, undefined);
    assert.equal((entry.procedure_definition as JsonObject).kind, "workflow");
    target.service.knowledgeMemoryBundleImportApply({ bundle, approved: true });
    const imported = target.store.get("experience_procedure", "portable-procedure");
    const rehydrated = new ProcedureDefinitionStore(target.store.paths).read(imported.definition_ref as never);
    assert.equal(rehydrated.definition.steps instanceof Array, true);
    assert.notEqual((imported.definition_ref as JsonObject).path, definition.path);
  } finally { await dispose(source); await dispose(target); }
});

test("bundle directory transport writes only a verified portable JSON envelope", async () => {
  const source = await fixture(); const target = await fixture();
  try {
    source.service.knowledgeMemoryInstallBuiltins();
    source.service.memoryLedgerRemember({ memory_id: "transported", source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "project", scope_id: "p", content: "Keep bundles reviewable.", confidence: "bounded" });
    const bundle = source.service.knowledgeMemoryBundleExport({ scope_kind: "project", scope_id: "p" }).bundle as JsonObject;
    assert.throws(() => source.service.knowledgeMemoryBundleTransport({ operation: "write", transport: "directory", transport_root: join(source.root, "transfer"), bundle }), /allow_local_write/u);
    const written = source.service.knowledgeMemoryBundleTransport({ operation: "write", transport: "directory", transport_root: join(source.root, "transfer"), allow_local_write: true, bundle });
    const read = source.service.knowledgeMemoryBundleTransport({ operation: "read", transport: "directory", transport_root: join(source.root, "transfer"), file_name: written.file_name }) as JsonObject;
    assert.equal((read.bundle as JsonObject).digest, bundle.digest);
    assert.equal(target.service.knowledgeMemoryBundleImportApply({ bundle: read.bundle, approved: true }).plan instanceof Object, true);
  } finally { await dispose(source); await dispose(target); }
});

test("eligible vector retrieval persists safe configuration, caches embeddings, and opens a bounded circuit", async () => {
  const f = await fixture(); const originalFetch = globalThis.fetch; const originalKey = process.env.CRAFT_VECTOR_TEST_KEY;
  try {
    process.env.CRAFT_VECTOR_TEST_KEY = "fixture-key"; let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls += 1; const body = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(JSON.stringify({ data: body.input.map((value) => ({ embedding: value.includes("alpha") ? [1, 0] : [0, 1] })), usage: { total_tokens: body.input.length } }), { status: 200 });
    };
    f.service.knowledgeMemoryInstallBuiltins();
    f.service.memoryLedgerRemember({ memory_id: "vector-memory", source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "project", scope_id: "p", content: "alpha retrieval uses evidence." });
    const adapter = f.service.retrievalAdapterConfigure({ adapter_id: "vector-success", strategy: "vector", provider_fingerprint: "fixture-v1", configuration: { endpoint: "https://fixture.local/embeddings", model: "fixture-embed", credential_env: "CRAFT_VECTOR_TEST_KEY" } }).adapter as JsonObject;
    assert.equal(((adapter.configuration as JsonObject).model), "fixture-embed");
    f.service.retrievalAdapterEvaluate({ adapter_id: adapter.id, metrics: { recall: 1, cross_project_leak_count: 0, latency_ms: 1, cost_usd: 0 } });
    const first = await f.service.contextResolutionResolve({ receipt_id: "vector-success-one", query: "alpha", scope_kind: "project", scope_id: "p", retrieval_adapter_id: adapter.id });
    const second = await f.service.contextResolutionResolve({ receipt_id: "vector-success-two", query: "alpha", scope_kind: "project", scope_id: "p", retrieval_adapter_id: adapter.id });
    assert.equal(((first.receipt as JsonObject).retrieval_execution as JsonObject).used, "vector");
    assert.equal(((second.receipt as JsonObject).retrieval_execution as JsonObject).used, "vector"); assert.equal(calls, 1);
    const hybrid = f.service.retrievalAdapterConfigure({ adapter_id: "hybrid-success", strategy: "hybrid", provider_fingerprint: "fixture-v1", configuration: { endpoint: "https://fixture.local/embeddings", model: "fixture-embed", credential_env: "CRAFT_VECTOR_TEST_KEY" } }).adapter as JsonObject;
    f.service.retrievalAdapterEvaluate({ adapter_id: hybrid.id, metrics: { recall: 1, cross_project_leak_count: 0, latency_ms: 1, cost_usd: 0 } });
    const hybridResult = await f.service.contextResolutionResolve({ receipt_id: "hybrid-success", query: "alpha", scope_kind: "project", scope_id: "p", retrieval_adapter_id: hybrid.id });
    assert.equal(((hybridResult.receipt as JsonObject).retrieval_execution as JsonObject).used, "hybrid");
    assert.equal(((hybridResult.items as JsonObject[])[0]).reason, "hybrid_rrf");
    globalThis.fetch = async () => { throw new Error("network_failure"); };
    const failed = f.service.retrievalAdapterConfigure({ adapter_id: "vector-failure", strategy: "vector", provider_fingerprint: "fixture-v2", configuration: { endpoint: "https://fixture.local/failure", model: "fixture-embed-v2", credential_env: "CRAFT_VECTOR_TEST_KEY" } }).adapter as JsonObject;
    f.service.retrievalAdapterEvaluate({ adapter_id: failed.id, metrics: { recall: 1, cross_project_leak_count: 0, latency_ms: 1, cost_usd: 0 } });
    for (const receipt_id of ["failure-one", "failure-two", "failure-three"]) await f.service.contextResolutionResolve({ receipt_id, query: "alpha", scope_kind: "project", scope_id: "p", retrieval_adapter_id: failed.id });
    const opened = await f.service.contextResolutionResolve({ receipt_id: "failure-open", query: "alpha", scope_kind: "project", scope_id: "p", retrieval_adapter_id: failed.id });
    assert.equal(((opened.receipt as JsonObject).retrieval_execution as JsonObject).unavailable_reason, "embedding_circuit_open");
  } finally { globalThis.fetch = originalFetch; if (originalKey === undefined) delete process.env.CRAFT_VECTOR_TEST_KEY; else process.env.CRAFT_VECTOR_TEST_KEY = originalKey; await dispose(f); }
});

test("semantic review packet is fragment-bound and a routeable Prompt Procedure remains Markdown-native", async () => {
  const f = await fixture();
  try {
    const root = join(f.root, "source"); await mkdir(root); await writeFile(join(root, "README.md"), "# Delivery rule\nRun focused tests before delivery.\n", "utf8");
    const source = f.service.knowledgeSourceRegister({ source_id: "packet-source", kind: "readme", label: "packet", scope_kind: "project", scope_id: "p", locator: root, content_digest: "packet-source-v1", trust: "verified", access: "read_only" }).source as JsonObject;
    const ingested = f.service.knowledgeSourceIngest({ source_id: source.id, max_chars_per_fragment: 500 }); const claim = f.store.get("knowledge_claim", String((ingested.candidates as JsonObject[])[0]!.claim_id));
    const packet = f.service.knowledgeSemanticReviewPacket({ claim_id: claim.id }); assert.equal(packet.status, "ready");
    assert.equal((await f.service.knowledgeSemanticProviderReview({ claim_id: claim.id })).status, "unavailable");
    const review = f.service.knowledgeHostReview({ claim_id: claim.id, host_kind: "codex", host_run_key: "turn:packet", source_digest: source.content_digest, packet_digest: packet.packet_digest, decision: "supported" });
    assert.equal(review.promoted, true); assert.equal((review.review as JsonObject).packet_attested, true);
    const evidence = f.service.evidenceRecord({ evidence_id: "procedure-evidence", source_type: "fixture", confidence: "confirmed", claim: "Verification passed.", locator: "fixture://procedure" }) as JsonObject;
    const signature = { schema: "craft.scenario-signature.v1", project: "p", verifier: "test", effect_class: "read" };
    for (const id of ["one", "two"]) f.service.workflowEvolutionObserve({ observation_id: `procedure-${id}`, scenario_key: "delivery.tests", scenario_signature: signature, source_kind: "fixture", source_id: id, source_digest: `sha256:${id}`, scope: "project:p", outcome: "passed", evidence_ids: [evidence.id], sanitized: true, content_stored: false });
    const request = f.service.workflowEvolutionPropose({ scenario_key: "delivery.tests", observation_ids: ["procedure-one", "procedure-two"], hypothesis: "Verify before delivery.", design_axes: ["orchestration"], procedure_kind: "workflow", output_contract_ref: "acceptance:tests" }).request as JsonObject;
    const proposal = f.service.workflowEvolutionProposalSubmit({ request_id: request.id, workflow_id: "procedure-workflow", name: "Verified delivery", description: "Run focused tests before delivery.", inputs: [], steps: [{ type: "assertion" }] }).proposal as JsonObject;
    const procedure = f.service.experienceProcedureDraft({ proposal_id: proposal.id, procedure_kind: "prompt", allowed_effects: ["read"], evidence_ids: [evidence.id] }).procedure as JsonObject;
    assert.equal(procedure.definition_ref, null);
    for (const stage of ["shadow", "held_out", "signoff", "canary"]) f.service.experienceProcedureGate({ procedure_id: procedure.id, stage, evidence_ids: [evidence.id], passed: true });
    const routeable = f.service.experienceProcedureGet({ procedure_id: procedure.id }).procedure as JsonObject; assert.equal(routeable.lifecycle, "routeable");
    const procedurePath = String((routeable.content_ref as JsonObject).path);
    assert.match(procedurePath, /experience[\\/]md[\\/]prompts[\\/]/u);
    const markdown = await readFile(procedurePath, "utf8");
    assert.match(markdown, /procedure_kind: "prompt"[\s\S]*lifecycle: "routeable"/u);
    const context = await f.service.contextResolutionResolve({ receipt_id: "procedure-context", query: "delivery tests", scope_kind: "project", scope_id: "p", members: ["experience"] });
    assert.match(JSON.stringify(context.contributions), /Run focused tests/u);
    const exported = f.service.experienceProcedureSkillExport({ procedure_id: procedure.id });
    assert.equal((exported.export as JsonObject).enabled, false);
    assert.match(String((exported.export as JsonObject).path), /experience[\\/]skills[\\/]/u);
    assert.equal((exported.export as JsonObject).definition_path, null);
  } finally { await dispose(f); }
});

test("more-specific memory scopes shadow parent topics while working notes remain opt-in", async () => {
  const f = await fixture();
  try {
    f.service.knowledgeMemoryInstallBuiltins();
    f.service.memoryLedgerRemember({ memory_id: "user-testing", source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "user", scope_id: "u", topic: "testing", content: "Use the broad suite.", confidence: "bounded", observed_at: "2026-09-01T00:00:00.000Z" });
    f.service.memoryLedgerRemember({ memory_id: "project-testing", source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "project", scope_id: "p", topic: "testing", content: "Use focused tests first.", confidence: "bounded", observed_at: "2026-09-02T00:00:00.000Z" });
    f.service.memoryLedgerRemember({ memory_id: "working-note", source_id: "builtin.evidence-wiki", kind: "working", working_note: true, scope_kind: "project", scope_id: "p", topic: "working-note", content: "Temporary local note.", confidence: "bounded" });
    const defaultResult = await f.service.contextResolutionResolve({ receipt_id: "specific-scope", query: "focused tests", scope_kind: "project", scope_id: "p", user_scope_id: "u" });
    assert.match(JSON.stringify(defaultResult.items), /focused tests/u);
    assert.doesNotMatch(JSON.stringify(defaultResult.items), /broad suite|Temporary local/u);
    const withWorking = await f.service.contextResolutionResolve({ receipt_id: "working-scope", query: "temporary", scope_kind: "project", scope_id: "p", user_scope_id: "u", include_working_notes: true });
    assert.match(JSON.stringify(withWorking.items), /Temporary local/u);
  } finally { await dispose(f); }
});

test("scope envelopes keep team data opt-in, audience-bound, and separate from personal/project context", async () => {
  const f = await fixture();
  try {
    f.service.knowledgeMemoryInstallBuiltins();
    const envelope = {
      applicability: { kind: "team", id: "platform" }, custody: { kind: "team", id: "platform" },
      audience: { mode: "scoped", principal_ids: ["alice"] }, purpose: "procedure", retention: "long_term", tenant_id: "acme",
    };
    const evidence = f.service.evidenceRecord({ evidence_id: "team-procedure-evidence", source_type: "fixture", confidence: "bounded", claim: "Team procedure fixture", locator: "fixture://team-procedure" }) as JsonObject;
    f.service.memoryLedgerRemember({ memory_id: "team-procedure", source_id: "builtin.evidence-wiki", kind: "procedural", scope_kind: "team", scope_id: "platform",
      scope_envelope: envelope, topic: "delivery", content: "The platform team runs focused verification first.", confidence: "bounded", evidence_ids: [evidence.id] });
    const hidden = await f.service.contextResolutionResolve({ receipt_id: "team-hidden", query: "verification", scope_kind: "project", scope_id: "craft", team_scope_id: "platform", principal_id: "bob", tenant_id: "acme" });
    assert.equal((hidden.items as JsonObject[]).length, 0);
    const visible = await f.service.contextResolutionResolve({ receipt_id: "team-visible", query: "verification", scope_kind: "project", scope_id: "craft", team_scope_id: "platform", principal_id: "alice", tenant_id: "acme", cognitive_purpose: "procedure" });
    assert.match(JSON.stringify(visible.items), /platform team/u);
    const wrongTenant = await f.service.contextResolutionResolve({ receipt_id: "team-wrong-tenant", query: "verification", scope_kind: "project", scope_id: "craft", team_scope_id: "platform", principal_id: "alice", tenant_id: "other", cognitive_purpose: "procedure" });
    assert.equal((wrongTenant.items as JsonObject[]).length, 0);
    assert.equal((((visible.items as JsonObject[])[0]!.scope_envelope as JsonObject).audience as JsonObject).mode, "scoped");
  } finally { await dispose(f); }
});

test("global Knowledge is read only when explicitly requested, not as a project fallback", async () => {
  const f = await fixture();
  try {
    f.service.knowledgeMemoryInstallBuiltins();
    const evidence = f.service.evidenceRecord({ evidence_id: "global-evidence", source_type: "fixture", confidence: "bounded", claim: "Global rule fixture", locator: "fixture://global" }) as JsonObject;
    f.service.knowledgeClaimSave({ claim_id: "global-claim", kind: "rule", content: "An explicitly public baseline rule.", scope: "global", source_id: "builtin.evidence-wiki", evidence_ids: [evidence.id],
      scope_envelope: { applicability: { kind: "global", id: "global" }, custody: { kind: "organization", id: "craft" }, audience: { mode: "public", principal_ids: [] }, purpose: "fact", retention: "long_term", tenant_id: null } });
    f.service.knowledgeClaimReview({ claim_id: "global-claim", status: "reviewed", reviewer: "fixture", reason: "bounded evidence" });
    const defaultContext = await f.service.contextResolutionResolve({ receipt_id: "global-default", query: "baseline rule", scope_kind: "project", scope_id: "craft", members: ["knowledge"] });
    assert.equal(((defaultContext.contributions as JsonObject[])[0]!.items as JsonObject[]).length, 0);
    const explicitContext = await f.service.contextResolutionResolve({ receipt_id: "global-explicit", query: "baseline rule", scope_kind: "project", scope_id: "craft", include_global: true, members: ["knowledge"] });
    assert.match(JSON.stringify(explicitContext.contributions), /public baseline/u);
  } finally { await dispose(f); }
});
