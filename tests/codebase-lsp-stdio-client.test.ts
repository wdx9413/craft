import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { analyzeLspSnapshot, ignoreLspStdinError, resolveLspSymbolPosition, safeFailureCode, waitForClose, waitForDiagnosticPublications } from "../capability/craft-codebase/lsp-stdio-client.ts";
import { cacheLspDocumentSymbols, lspDocumentSymbolsDigest } from "../capability/craft-codebase/lsp-adapter.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";

const fixturePath = fileURLToPath(new URL("./fixtures/lsp-stdio-fixture.cjs", import.meta.url));
const digest = (content: string) => createHash("sha256").update(content).digest("hex");
const source = "class Example {}\n";
const document = { path: "src/example.java", language: "java", content: source, source_digest: digest(source) };
const base = (cwd: string, mode = "ok") => ({ command: process.execPath, args: [fixturePath, mode], cwd, analyzer: "stdio-fixture", analyzer_version: "1", documents: [document] });
const clangdProbe = spawnSync("clangd", ["--version"], { encoding: "utf8" });
const clangdVersion = clangdProbe.status === 0 ? clangdProbe.stdout.match(/clangd version ([^\s]+)/u)?.[1] : undefined;
const hasClangd = clangdVersion !== undefined;

test("stdio LSP imports snapshot-bound symbols through Codebase and keeps relations explicitly unknown", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-client-")), repo = join(root, "repo"); mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/example.java"), source);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const service = new CraftService(store);
    const workspace = service.workspaceOpen({ workspace_id: "lsp_workspace", name: "LSP", root_path: repo, include_paths: ["src"] }).workspace as JsonObject;
    const checkpoint = service.workspaceCheckpoint({ workspace_id: workspace.id, checkpoint_id: "lsp_checkpoint", label: "fixture" }).checkpoint as JsonObject;
    service.codebaseActivate({ workspace_id: workspace.id, actor: "lsp-test" });
    const analysis = await analyzeLspSnapshot(base(String(checkpoint.snapshot_root)));
    assert.deepEqual(analysis.diagnostics, { budget_limited: false, omitted_symbols: 0, symbol_cache_hits: 0, symbol_cache_misses: 1, symbol_cache_omitted_documents: 0,
      relations: "not_requested", requested_relations: [], supported_relations: [], relation_candidate_symbol_count: 0, relation_symbol_count: 0,
      relation_query_omitted_count: 0, relation_response_omitted_count: 0, relation_collection_omitted_count: 0,
      unsupported_relations: [], relation_omitted_count: 0, relation_query_failures: 0, relation_omitted_stages: [], relation_failure_stages: [], relation_capability_notes: [],
      language_diagnostics: { observed_document_count: 0, item_count: 0, error_count: 0, warning_count: 0 }, stderr_bytes_observed: 0 });
    assert.equal((analysis.document_symbol_cache as JsonObject[]).length, 1);
    assert.equal((analysis.edges as JsonObject[]).length, 0);
    const imported = service.codebaseAnalysisImport({ workspace_id: workspace.id, checkpoint_id: checkpoint.id, index_id: "lsp_import", analysis });
    const found = service.codebaseSymbolFind({ workspace_id: workspace.id, index_id: String((imported.index as JsonObject).id), query: "Example" });
    assert.equal((found.symbols as JsonObject[])[0]?.name, "Example");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("semantic LSP errors downgrade relation status without persisting diagnostic text", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-semantic-diagnostic-status-"));
  const content = "class Contract {}\nclass Concrete extends Contract {}\n";
  try {
    const result = await analyzeLspSnapshot({ ...base(root, "relations-semantic-diagnostics-push"),
      documents: [{ path: "src/relations.ts", language: "typescript", content, source_digest: digest(content) }], relations: ["implementations"] });
    const diagnostics = result.diagnostics as JsonObject;
    assert.equal(diagnostics.relations, "partial");
    assert.deepEqual(diagnostics.language_diagnostics, { observed_document_count: 1, item_count: 1, error_count: 1, warning_count: 0 });
    assert.equal((result.edges as JsonObject[]).length, 1);
    assert.equal(JSON.stringify(result).includes("sample diagnostic"), false);

    const clean = await analyzeLspSnapshot({ ...base(root, "relations-semantic"),
      documents: [{ path: "src/relations.ts", language: "typescript", content, source_digest: digest(content) }], relations: ["implementations"] });
    assert.equal((clean.diagnostics as JsonObject).relations, "analyzed");
    assert.deepEqual((clean.diagnostics as JsonObject).language_diagnostics, { observed_document_count: 0, item_count: 0, error_count: 0, warning_count: 0 });
    const warning = await analyzeLspSnapshot({ ...base(root, "relations-semantic-diagnostics-warning"),
      documents: [{ path: "src/relations.ts", language: "typescript", content, source_digest: digest(content) }], relations: ["implementations"] });
    assert.equal((warning.diagnostics as JsonObject).relations, "analyzed");
    assert.deepEqual((warning.diagnostics as JsonObject).language_diagnostics, { observed_document_count: 1, item_count: 1, error_count: 0, warning_count: 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stdio LSP returns bounded push and pull diagnostics without confusing clean files with missing reports", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-diagnostics-"));
  try {
    const push = await analyzeLspSnapshot({ ...base(root, "diagnostics-push"), diagnostics_only: true });
    assert.equal((push.diagnostics as JsonObject).status, "complete");
    assert.equal((push.diagnostics as JsonObject).mode, "push");
    assert.deepEqual(push.language_diagnostics, [{ path: document.path, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      severity: 1, code: "E1", source: "fixture", message: "sample diagnostic" }]);
    const empty = await analyzeLspSnapshot({ ...base(root, "diagnostics-push-empty"), diagnostics_only: true });
    assert.equal((empty.diagnostics as JsonObject).status, "complete");
    assert.deepEqual(empty.language_diagnostics, []);
    const delayed = await analyzeLspSnapshot({ ...base(root, "diagnostics-push-delayed"), diagnostics_only: true });
    assert.equal((delayed.diagnostics as JsonObject).status, "complete");
    const optionalFields = await analyzeLspSnapshot({ ...base(root, "diagnostics-push-optionals"), diagnostics_only: true });
    assert.deepEqual(optionalFields.language_diagnostics, [{ path: document.path, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, message: "minimal diagnostic" }]);
    const malformed = await analyzeLspSnapshot({ ...base(root, "diagnostics-push-malformed"), diagnostics_only: true });
    assert.equal((malformed.diagnostics as JsonObject).status, "partial");
    assert.equal((malformed.diagnostics as JsonObject).omitted_count, 2);
    const many = await analyzeLspSnapshot({ ...base(root, "diagnostics-push-many"), diagnostics_only: true });
    assert.equal((many.language_diagnostics as JsonObject[]).length, 500);
    assert.equal((many.diagnostics as JsonObject).omitted_count, 1);
    assert.equal(String(((many.language_diagnostics as JsonObject[])[0] as JsonObject).message).length, 2000);
    const manyDocuments = Array.from({ length: 5 }, (_, index) => ({ ...document, path: `src/${index}.java` }));
    const totalBounded = await analyzeLspSnapshot({ ...base(root, "diagnostics-push-many"), diagnostics_only: true, documents: manyDocuments });
    assert.equal((totalBounded.language_diagnostics as JsonObject[]).length, 2000);
    assert.equal((totalBounded.diagnostics as JsonObject).omitted_count, 505);

    const pull = await analyzeLspSnapshot({ ...base(root, "diagnostics-pull"), diagnostics_only: true });
    assert.equal((pull.diagnostics as JsonObject).status, "complete");
    assert.equal((pull.diagnostics as JsonObject).mode, "pull");
    assert.equal(((pull.language_diagnostics as JsonObject[])[0] as JsonObject).message, "pull diagnostic");
    const pullInvalid = await analyzeLspSnapshot({ ...base(root, "diagnostics-pull-invalid"), diagnostics_only: true });
    assert.equal((pullInvalid.diagnostics as JsonObject).status, "partial");
    assert.equal((pullInvalid.diagnostics as JsonObject).omitted_count, 1);
    const pullUnavailable = await analyzeLspSnapshot({ ...base(root, "diagnostics-pull-unavailable"), diagnostics_only: true });
    assert.equal((pullUnavailable.diagnostics as JsonObject).status, "partial");
    assert.equal((pullUnavailable.diagnostics as JsonObject).query_failures, 1);
    const pullError = await analyzeLspSnapshot({ ...base(root, "diagnostics-pull-error"), diagnostics_only: true });
    assert.equal((pullError.diagnostics as JsonObject).query_failures, 1);
    const unpublished = await analyzeLspSnapshot({ ...base(root, "ok"), diagnostics_only: true }, 100);
    assert.equal((unpublished.diagnostics as JsonObject).status, "partial");
    assert.deepEqual((unpublished.diagnostics as JsonObject).unpublished_paths, [document.path]);
    await assert.rejects(analyzeLspSnapshot({ ...base(root), diagnostics_only: "yes" as never }), /Invalid or over-budget/);
    await assert.doesNotReject(analyzeLspSnapshot({ ...base(root, "relation-budget-max"), relation_symbol_limit: 1_000 }));
    await assert.rejects(analyzeLspSnapshot({ ...base(root, "relation-budget-over"), relation_symbol_limit: 1_001 }), /Invalid or over-budget/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("diagnostic publication wait resolves immediately, on publish, or at its bounded timeout", async () => {
  const ready = new Map<string, unknown[]>([["file:///ready.java", []]]);
  const immediateWaiters = new Set<() => void>();
  await waitForDiagnosticPublications(["file:///ready.java"], ready, immediateWaiters, 10);
  assert.equal(immediateWaiters.size, 0);

  const published = new Map<string, unknown[]>();
  const waiters = new Set<() => void>();
  const pending = waitForDiagnosticPublications(["file:///late.java"], published, waiters, 100);
  assert.equal(waiters.size, 1);
  published.set("file:///late.java", []);
  for (const wake of [...waiters]) wake();
  await pending;
  assert.equal(waiters.size, 0);

  const noReportWaiters = new Set<() => void>();
  await waitForDiagnosticPublications(["file:///none.java"], new Map(), noReportWaiters, 1);
  assert.equal(noReportWaiters.size, 0);
});

test("stdio LSP preserves a bounded partial symbol graph and its omission diagnostics", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-large-symbols-"));
  const count = 60_001, content = `${"x\n".repeat(count - 1)}x`;
  try {
    const analysis = await analyzeLspSnapshot({ ...base(root, "many-symbols"),
      documents: [{ path: "src/large.java", language: "java", content, source_digest: digest(content) }] });
    assert.equal((analysis.nodes as JsonObject[]).length, 60_000);
    assert.deepEqual(analysis.diagnostics, { budget_limited: true, omitted_symbols: 1, symbol_cache_hits: 0, symbol_cache_misses: 1, symbol_cache_omitted_documents: 1,
      relations: "not_requested", requested_relations: [], supported_relations: [], relation_candidate_symbol_count: 0, relation_symbol_count: 0,
      relation_query_omitted_count: 0, relation_response_omitted_count: 0, relation_collection_omitted_count: 0,
      unsupported_relations: [], relation_omitted_count: 0, relation_query_failures: 0, relation_omitted_stages: [], relation_failure_stages: [], relation_capability_notes: [],
      language_diagnostics: { observed_document_count: 0, item_count: 0, error_count: 0, warning_count: 0 }, stderr_bytes_observed: 0 });
    assert.deepEqual(analysis.document_symbol_cache, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stdio LSP omits document symbol caches that exceed the cache byte budget", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-large-symbol-cache-"));
  const count = 60_000, content = `${"x\n".repeat(count - 1)}x`;
  try {
    const analysis = await analyzeLspSnapshot({ ...base(root, "large-symbol-cache"),
      documents: [{ path: "src/large.java", language: "java", content, source_digest: digest(content) }] });
    assert.equal((analysis.diagnostics as JsonObject).budget_limited, false);
    assert.equal((analysis.diagnostics as JsonObject).symbol_cache_omitted_documents, 1);
    assert.deepEqual(analysis.document_symbol_cache, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stdio LSP reuses only digest-matched cached document symbols and exports content-free cache units", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-symbol-cache-"));
  const symbol = { name: "Example", kind: 5, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 16 } },
    selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }, detail: "must not be cached" };
  const symbols = cacheLspDocumentSymbols([symbol]);
  const cached_symbols_digest = lspDocumentSymbolsDigest({ analyzer: "stdio-fixture", analyzer_version: "1", path: document.path,
    language: document.language, source_digest: document.source_digest, symbols });
  try {
    const cached = await analyzeLspSnapshot({ ...base(root, "cache-reject-query"), documents: [{ ...document, cached_symbols: symbols, cached_symbols_digest }] });
    assert.equal((cached.diagnostics as JsonObject).symbol_cache_hits, 1);
    assert.equal((cached.diagnostics as JsonObject).symbol_cache_misses, 0);
    assert.equal(((cached.nodes as JsonObject[])[0]!).name, "Example");
    const unit = ((cached.document_symbol_cache as JsonObject[])[0]!);
    assert.equal(unit.cached_symbols_digest, cached_symbols_digest);
    assert.equal(JSON.stringify(unit).includes("must not be cached"), false);
    assert.equal(JSON.stringify(unit).includes("class Example"), false);

    const invalid = await analyzeLspSnapshot({ ...base(root), documents: [{ ...document, cached_symbols: symbols, cached_symbols_digest: "stale" }] });
    assert.equal((invalid.diagnostics as JsonObject).symbol_cache_hits, 0);
    assert.equal((invalid.diagnostics as JsonObject).symbol_cache_misses, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stdio LSP opens the complete snapshot before querying symbols with bounded concurrency", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-parallel-symbols-"));
  const metricsPath = join(root, "metrics.json");
  try {
    const documents = Array.from({ length: 20 }, (_, index) => {
      const content = `class Symbol${index} {}`;
      return { path: `src/${index}.java`, language: "java", content, source_digest: digest(content) };
    });
    const result = await analyzeLspSnapshot({ ...base(root, "parallel-symbols"), args: [fixturePath, "parallel-symbols", metricsPath, String(documents.length)], documents });
    const metrics = JSON.parse(readFileSync(metricsPath, "utf8")) as { peakDocumentSymbols: number; allDocumentsOpened: boolean };
    assert.equal(metrics.peakDocumentSymbols, 8, "symbol requests should use the configured concurrency bound");
    assert.equal(metrics.allDocumentsOpened, true, "the server must see all snapshot documents before the first symbol query");
    assert.deepEqual((result.nodes as JsonObject[]).map(node => node.name), documents.map((_, index) => `Symbol${index}`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stdio LSP references and call hierarchy become checkpoint-bound graph edges", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-relations-")), repo = join(root, "repo"); mkdirSync(join(repo, "src"), { recursive: true });
  const content = "function target() {}\nfunction caller(){ target(); }\n";
  writeFileSync(join(repo, "src/relations.js"), content);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const service = new CraftService(store);
    const workspace = service.workspaceOpen({ workspace_id: "lsp_relations", name: "LSP relations", root_path: repo, include_paths: ["src"] }).workspace as JsonObject;
    const checkpoint = service.workspaceCheckpoint({ workspace_id: workspace.id, checkpoint_id: "lsp_relations_checkpoint", label: "fixture" }).checkpoint as JsonObject;
    service.codebaseActivate({ workspace_id: workspace.id, actor: "lsp-test" });
    const analysis = await analyzeLspSnapshot({ ...base(String(checkpoint.snapshot_root), "relations"), documents: [{ path: "src/relations.js", language: "javascript", content, source_digest: digest(content) }], relations: ["references", "calls", "definitions"] });
    assert.deepEqual((analysis.diagnostics as JsonObject).supported_relations, ["references", "calls", "definitions"]);
    assert.equal((analysis.diagnostics as JsonObject).relations, "analyzed");
    assert.equal((analysis.edges as JsonObject[]).filter(edge => edge.kind === "calls").length, 1);
    assert.equal((analysis.edges as JsonObject[]).filter(edge => edge.kind === "references").length, 1);
    assert.equal((analysis.edges as JsonObject[]).filter(edge => edge.kind === "definitions").length, 1);
    const definitionEdge = (analysis.edges as JsonObject[]).find(edge => edge.kind === "definitions")!;
    assert.equal(Number((definitionEdge.source_span as JsonObject).start_offset), content.indexOf("target();"));
    const imported = service.codebaseAnalysisImport({ workspace_id: workspace.id, checkpoint_id: checkpoint.id, index_id: "lsp_relations_import", analysis });
    const indexId = String((imported.index as JsonObject).id);
    const caller = (service.codebaseSymbolFind({ workspace_id: workspace.id, index_id: indexId, query: "caller" }).symbols as JsonObject[])[0]!;
    const target = (service.codebaseSymbolFind({ workspace_id: workspace.id, index_id: indexId, query: "target" }).symbols as JsonObject[])[0]!;
    const calls = service.codebaseRelationsFind({ workspace_id: workspace.id, index_id: indexId, node_id: caller.id, relation_kind: "calls", direction: "outgoing" });
    const references = service.codebaseRelationsFind({ workspace_id: workspace.id, index_id: indexId, node_id: target.id, relation_kind: "references", direction: "incoming" });
    assert.equal((calls.relations as JsonObject[]).length, 1);
    assert.equal((references.relations as JsonObject[]).length, 1);
    const definition = service.codebaseDefinitionFind({ workspace_id: workspace.id, index_id: indexId, path: "src/relations.js", offset: content.indexOf("target();") });
    assert.equal(((definition.definitions as JsonObject[])[0] as JsonObject | undefined)?.id, target.id);
    const declarationDefinition = service.codebaseDefinitionFind({ workspace_id: workspace.id, index_id: indexId, path: "src/relations.js", offset: content.indexOf("caller") });
    assert.deepEqual(declarationDefinition.definitions, []);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("stdio LSP queries exact relation targets without spending budget on unrelated symbols", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-targeted-relations-"));
  const content = "function target() {}\nfunction caller() { target(); }\nfunction extra() {}\n";
  const documents = [{ path: "src/calls.js", language: "javascript", content, source_digest: digest(content) }];
  try {
    const result = await analyzeLspSnapshot({ ...base(root, "relations"), documents, relations: ["calls"], relation_symbol_limit: 1,
      relation_targets: [{ path: "src/calls.js", name: "target", start_offset: content.indexOf("target") }] });
    const diagnostics = result.diagnostics as JsonObject;
    assert.equal(diagnostics.relations, "analyzed");
    assert.equal(diagnostics.relation_candidate_symbol_count, 3);
    assert.equal(diagnostics.relation_symbol_count, 1);
    assert.equal(diagnostics.relation_query_omitted_count, 0);
    assert.equal((result.edges as JsonObject[]).filter(edge => edge.kind === "calls").length, 1);

    const missing = await analyzeLspSnapshot({ ...base(root, "relations"), documents, relations: ["calls"], relation_symbol_limit: 1,
      relation_targets: [{ path: "src/calls.js", name: "missing", start_offset: 0 }] });
    assert.equal((missing.diagnostics as JsonObject).relations, "partial");
    assert.equal((missing.diagnostics as JsonObject).relation_query_omitted_count, 1);
    await assert.rejects(analyzeLspSnapshot({ ...base(root), documents, relation_targets: [{ path: "../outside.js", name: "target", start_offset: 0 }] }), /Invalid or over-budget/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stdio LSP asks call hierarchy only for callable symbols", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-callable-kinds-"));
  const content = "function target() {}\nfunction caller() { target(); }\nclass Record {}\n";
  try {
    const result = await analyzeLspSnapshot({ ...base(root, "relations-noncallable-call-error"),
      documents: [{ path: "src/calls.js", language: "javascript", content, source_digest: digest(content) }], relations: ["calls"] });
    assert.equal((result.diagnostics as JsonObject).relations, "analyzed");
    assert.equal((result.diagnostics as JsonObject).relation_query_failures, 0);
    assert.equal((result.edges as JsonObject[]).filter(edge => edge.kind === "calls").length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stdio LSP collects outgoing calls and reports malformed outgoing call hierarchy results", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-outgoing-calls-"));
  const content = "function target() {}\nfunction caller() { target(); }\n";
  const documents = [{ path: "src/calls.js", language: "javascript", content, source_digest: digest(content) }];
  try {
    const outgoing = await analyzeLspSnapshot({ ...base(root, "relations-incoming-null"), documents, relations: ["calls"] });
    assert.equal((outgoing.diagnostics as JsonObject).relations, "analyzed");
    const callEdges = (outgoing.edges as JsonObject[]).filter(edge => edge.kind === "calls");
    assert.equal(callEdges.length, 1);
    assert.deepEqual(callEdges[0]!.source_span, { start_offset: content.indexOf("target();"), end_offset: content.indexOf("target();") + "target".length });

    const nullable = await analyzeLspSnapshot({ ...base(root, "relations-outgoing-null"), documents, relations: ["calls"] });
    assert.equal((nullable.diagnostics as JsonObject).relations, "analyzed");
    for (const [mode, stage] of [
      ["relations-outgoing-error", "call_hierarchy_outgoing_failed_-32603"],
      ["relations-outgoing-invalid", "call_hierarchy_invalid_outgoing_result"],
    ] as const) {
      const result = await analyzeLspSnapshot({ ...base(root, mode), documents, relations: ["calls"] });
      const diagnostics = result.diagnostics as JsonObject;
      assert.equal(diagnostics.relations, "partial", mode);
      assert((diagnostics.relation_failure_stages as JsonObject[]).some(item => item.stage === stage), mode);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Go LSP outgoing calls import into snapshot-bound Codebase queries", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-go-outgoing-")), repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  const content = "package sample\n\nfunc target() {}\nfunc caller() { target() }\n";
  writeFileSync(join(repo, "src/calls.go"), content);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const service = new CraftService(store);
    const workspace = service.workspaceOpen({ workspace_id: "lsp_go_outgoing", name: "Go LSP outgoing calls", root_path: repo, include_paths: ["src"] }).workspace as JsonObject;
    const checkpoint = service.workspaceCheckpoint({ workspace_id: workspace.id, checkpoint_id: "lsp_go_outgoing_checkpoint", label: "Go outgoing call fixture" }).checkpoint as JsonObject;
    service.codebaseActivate({ workspace_id: workspace.id, actor: "lsp-test" });
    const analysis = await analyzeLspSnapshot({ ...base(String(checkpoint.snapshot_root), "relations-go-incoming-null"),
      documents: [{ path: "src/calls.go", language: "go", content, source_digest: digest(content) }], relations: ["calls"] });
    assert.equal((analysis.diagnostics as JsonObject).relations, "analyzed");
    assert.equal((analysis.edges as JsonObject[]).filter(edge => edge.kind === "calls").length, 1);
    const imported = service.codebaseAnalysisImport({ workspace_id: workspace.id, checkpoint_id: checkpoint.id, index_id: "lsp_go_outgoing_import", analysis });
    const indexId = String((imported.index as JsonObject).id);
    const caller = (service.codebaseSymbolFind({ workspace_id: workspace.id, index_id: indexId, query: "caller" }).symbols as JsonObject[])[0]!;
    const calls = service.codebaseRelationsFind({ workspace_id: workspace.id, index_id: indexId, node_id: caller.id,
      relation_kind: "calls", direction: "outgoing" }).relations as JsonObject[];
    assert.equal(calls.length, 1);
    assert.equal((calls[0]!.to as JsonObject).name, "target");
    const impact = service.codebaseImpactQuery({ workspace_id: workspace.id, index_id: indexId, node_id: String((calls[0]!.to as JsonObject).id),
      direction: "incoming", relation_kind: "calls", max_depth: 1, limit: 10 });
    assert((impact.nodes as JsonObject[]).some(node => node.id === caller.id));
    assert.equal((imported.index as JsonObject).checkpoint_id, checkpoint.id);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Go LSP limits implementation and type definition requests to compatible symbols", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-go-candidate-filter-"));
  const metricsPath = join(root, "requests.json");
  const content = "package sample\nfunc Callable() {}\nfunc WithoutRange() {}\nconst Label = \"sample\"\nvar Payload = Label\ntype Port interface { Serve() }\ntype Concrete struct{}\n";
  try {
    const result = await analyzeLspSnapshot({ ...base(root, "relations-go-candidate-filter"), args: [fixturePath, "relations-go-candidate-filter", metricsPath],
      analyzer: "lsp-go", documents: [{ path: "src/candidates.go", language: "go", content, source_digest: digest(content) }],
      relations: ["implementations", "type_definitions"] });
    const diagnostics = result.diagnostics as JsonObject;
    const requests = JSON.parse(readFileSync(metricsPath, "utf8")) as Array<{ method: string; line: number; character: number; text: string }>;
    assert.equal(diagnostics.relations, "analyzed", JSON.stringify(diagnostics));
    assert.deepEqual(requests.filter(item => item.method === "implementation").map(item => [item.line, item.character, item.text]), [
      [5, 5, "type Port interface { Serve() }"],
    ]);
    assert.deepEqual(requests.filter(item => item.method === "typeDefinition").map(item => item.text), [
      "var Payload = Label", "type Port interface { Serve() }", "type Concrete struct{}",
    ]);
    assert.deepEqual(diagnostics.relation_capability_notes, [
      { stage: "go_type_definition_ineligible_symbol_skipped", count: 3 },
      { stage: "go_implementation_ineligible_symbol_skipped", count: 5 },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stdio LSP stops requesting outgoing calls after the server reports MethodNotFound", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-outgoing-unsupported-"));
  const content = ["function target() {}", "function caller() { target(); }", ...Array.from({ length: 10 }, (_, index) => `function helper${index}() {}`)].join("\n") + "\n";
  try {
    const result = await analyzeLspSnapshot({ ...base(root, "relations-outgoing-unsupported"),
      documents: [{ path: "src/calls.js", language: "javascript", content, source_digest: digest(content) }], relations: ["calls"] });
    const diagnostics = result.diagnostics as JsonObject;
    const notes = (diagnostics.relation_capability_notes as JsonObject[]).find(item => item.stage === "outgoing_call_hierarchy_unavailable");
    assert.equal(diagnostics.relations, "analyzed");
    assert(Number(notes?.count) > 0);
    assert(Number(notes?.count) <= 8, "only the in-flight request batch may observe the unsupported capability");
    assert.equal(diagnostics.relation_query_failures, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stdio LSP implementation and type definition links become typed checkpoint graph edges", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-semantic-relations-")), repo = join(root, "repo"); mkdirSync(join(repo, "src"), { recursive: true });
  const content = "class Contract {}\nclass Concrete extends Contract {}\nclass Model {}\nlet model: Model;\n";
  writeFileSync(join(repo, "src/relations.ts"), content);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const service = new CraftService(store);
    const workspace = service.workspaceOpen({ workspace_id: "lsp_semantic_relations", name: "LSP semantic relations", root_path: repo, include_paths: ["src"] }).workspace as JsonObject;
    const checkpoint = service.workspaceCheckpoint({ workspace_id: workspace.id, checkpoint_id: "lsp_semantic_checkpoint", label: "fixture" }).checkpoint as JsonObject;
    service.codebaseActivate({ workspace_id: workspace.id, actor: "lsp-test" });
    const analysis = await analyzeLspSnapshot({ ...base(String(checkpoint.snapshot_root), "relations-semantic"),
      documents: [{ path: "src/relations.ts", language: "typescript", content, source_digest: digest(content) }], relations: ["implementations", "type_definitions"] });
    assert.deepEqual((analysis.diagnostics as JsonObject).supported_relations, ["implementations", "type_definitions"]);
    assert.equal((analysis.diagnostics as JsonObject).relations, "analyzed");
    assert.deepEqual((analysis.edges as JsonObject[]).map(edge => edge.kind).sort(), ["implements", "type_definition"]);
    const imported = service.codebaseAnalysisImport({ workspace_id: workspace.id, checkpoint_id: checkpoint.id, index_id: "lsp_semantic_import", analysis });
    const indexId = String((imported.index as JsonObject).id);
    const contract = (service.codebaseSymbolFind({ workspace_id: workspace.id, index_id: indexId, query: "Contract" }).symbols as JsonObject[])[0]!;
    const concrete = (service.codebaseSymbolFind({ workspace_id: workspace.id, index_id: indexId, query: "Concrete" }).symbols as JsonObject[])[0]!;
    const model = (service.codebaseSymbolFind({ workspace_id: workspace.id, index_id: indexId, query: "model" }).symbols as JsonObject[]).find(symbol => symbol.name === "model")!;
    const modelType = (service.codebaseSymbolFind({ workspace_id: workspace.id, index_id: indexId, query: "Model" }).symbols as JsonObject[]).find(symbol => symbol.name === "Model")!;
    const implementations = service.codebaseRelationsFind({ workspace_id: workspace.id, index_id: indexId, node_id: concrete.id, relation_kind: "implements", direction: "outgoing" });
    const typeDefinitions = service.codebaseRelationsFind({ workspace_id: workspace.id, index_id: indexId, node_id: model.id, relation_kind: "type_definition", direction: "outgoing" });
    assert.equal(((implementations.relations as JsonObject[])[0]?.to as JsonObject)?.id, contract.id);
    assert.equal(((typeDefinitions.relations as JsonObject[])[0]?.to as JsonObject)?.id, modelType.id);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("stdio LSP type hierarchy imports superclass and subtype edges into the read-only Codebase graph", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-type-hierarchy-")), repo = join(root, "repo"); mkdirSync(join(repo, "src"), { recursive: true });
  const content = "class Contract {}\nclass Concrete extends Contract {}\n";
  writeFileSync(join(repo, "src/hierarchy.ts"), content);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const service = new CraftService(store);
    const workspace = service.workspaceOpen({ workspace_id: "lsp_type_hierarchy", name: "LSP hierarchy", root_path: repo, include_paths: ["src"] }).workspace as JsonObject;
    const checkpoint = service.workspaceCheckpoint({ workspace_id: workspace.id, checkpoint_id: "lsp_type_hierarchy_checkpoint", label: "fixture" }).checkpoint as JsonObject;
    service.codebaseActivate({ workspace_id: workspace.id, actor: "lsp-test" });
    const analysis = await analyzeLspSnapshot({ ...base(String(checkpoint.snapshot_root), "relations-hierarchy"),
      documents: [{ path: "src/hierarchy.ts", language: "typescript", content, source_digest: digest(content) }], relations: ["type_hierarchy"] });
    assert.deepEqual((analysis.diagnostics as JsonObject).supported_relations, ["type_hierarchy"]);
    assert.equal((analysis.diagnostics as JsonObject).relations, "analyzed");
    assert.deepEqual((analysis.edges as JsonObject[]).map(edge => edge.kind), ["extends"]);
    const imported = service.codebaseAnalysisImport({ workspace_id: workspace.id, checkpoint_id: checkpoint.id, index_id: "lsp_type_hierarchy_import", analysis });
    const indexId = String((imported.index as JsonObject).id);
    const contract = (service.codebaseSymbolFind({ workspace_id: workspace.id, index_id: indexId, query: "Contract" }).symbols as JsonObject[])[0]!;
    const concrete = (service.codebaseSymbolFind({ workspace_id: workspace.id, index_id: indexId, query: "Concrete" }).symbols as JsonObject[])[0]!;
    const supertypes = service.codebaseRelationsFind({ workspace_id: workspace.id, index_id: indexId, node_id: concrete.id, relation_kind: "extends", direction: "outgoing" });
    assert.equal(((supertypes.relations as JsonObject[])[0]?.to as JsonObject)?.id, contract.id);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("stdio LSP type hierarchy reports unsupported, malformed, null, failed and over-budget responses", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-type-hierarchy-shapes-"));
  const content = "class Contract {}\nclass Concrete extends Contract {}\n";
  const documents = [{ path: "src/hierarchy.ts", language: "typescript", content, source_digest: digest(content) }];
  try {
    const unsupported = await analyzeLspSnapshot({ ...base(root, "relations-hierarchy-unsupported"), documents, relations: ["type_hierarchy"] });
    assert.deepEqual((unsupported.diagnostics as JsonObject).unsupported_relations, ["type_hierarchy"]);
    const nullable = await analyzeLspSnapshot({ ...base(root, "relations-hierarchy-null"), documents, relations: ["type_hierarchy"] });
    assert.equal((nullable.diagnostics as JsonObject).relations, "analyzed");
    for (const mode of ["relations-hierarchy-super-null", "relations-hierarchy-sub-null"] as const) {
      const result = await analyzeLspSnapshot({ ...base(root, mode), documents, relations: ["type_hierarchy"] });
      assert.equal((result.diagnostics as JsonObject).relations, "analyzed", mode);
    }
    for (const [mode, stage] of [
      ["relations-hierarchy-error", "type_hierarchy_prepare_failed_-32603"],
      ["relations-hierarchy-invalid", "type_hierarchy_invalid_prepare_result"],
      ["relations-hierarchy-invalid-item", "type_hierarchy_invalid_item"],
      ["relations-hierarchy-super-error", "type_hierarchy_supertypes_failed_-32603"],
      ["relations-hierarchy-sub-error", "type_hierarchy_subtypes_failed_-32603"],
      ["relations-hierarchy-super-invalid", "type_hierarchy_invalid_supertypes_result"],
      ["relations-hierarchy-sub-invalid", "type_hierarchy_invalid_subtypes_result"],
    ] as const) {
      const result = await analyzeLspSnapshot({ ...base(root, mode), documents, relations: ["type_hierarchy"] });
      assert.equal((result.diagnostics as JsonObject).relations, "partial", mode);
      const stages = (result.diagnostics as JsonObject).relation_failure_stages as JsonObject[];
      assert.equal(Array.isArray(stages), true, mode);
      assert.equal(Number(stages.find(item => item.stage === stage)?.count) > 0, true, mode);
    }
    for (const [mode, stage] of [["relations-definition-error", "definition_request_failed_-32603"], ["relations-definition-invalid", "definition_invalid_result"]] as const) {
      const result = await analyzeLspSnapshot({ ...base(root, mode), documents: [{ path: "src/relations.js", language: "javascript", content: "function target() {}\nfunction caller(){ target(); }\n", source_digest: digest("function target() {}\nfunction caller(){ target(); }\n") }], relations: ["definitions"] });
      assert.equal((result.diagnostics as JsonObject).relations, "partial", mode);
      const stages = (result.diagnostics as JsonObject).relation_failure_stages as JsonObject[];
      assert.equal(Number(stages.find(item => item.stage === stage)?.count) > 0, true, mode);
    }
    for (const [mode, stage] of [["relations-definition-refs-error", "definition_references_request_failed_-32603"], ["relations-definition-refs-invalid", "definition_references_invalid_result"]] as const) {
      const result = await analyzeLspSnapshot({ ...base(root, mode), documents: [{ path: "src/relations.js", language: "javascript", content: "function target() {}\nfunction caller(){ target(); }\n", source_digest: digest("function target() {}\nfunction caller(){ target(); }\n") }], relations: ["definitions"] });
      assert.equal((result.diagnostics as JsonObject).relations, "partial", mode);
      assert((result.diagnostics as JsonObject).relation_failure_stages as JsonObject[]);
      assert.equal((((result.diagnostics as JsonObject).relation_failure_stages as JsonObject[]).find(item => item.stage === stage)?.count as number) > 0, true, mode);
    }
    for (const mode of ["relations-definition-outside", "relations-definition-http", "relations-definition-parent", "relations-definition-missing-doc", "relations-definition-invalid-uri", "relations-definition-bad-range", "relations-definition-many"]) {
      const result = await analyzeLspSnapshot({ ...base(root, mode), documents: [{ path: "src/relations.js", language: "javascript", content: "function target() {}\nfunction caller(){ target(); }\n", source_digest: digest("function target() {}\nfunction caller(){ target(); }\n") }], relations: ["definitions"] });
      assert.equal((result.diagnostics as JsonObject).relations, "partial", mode);
      assert.equal(Number((result.diagnostics as JsonObject).relation_omitted_count) > 0 || ((result.diagnostics as JsonObject).relation_failure_stages as JsonObject[]).length > 0, true, mode);
    }
    const noReferences = await analyzeLspSnapshot({ ...base(root, "relations-definition-refs-null"), documents: [{ path: "src/relations.js", language: "javascript", content: "function target() {}\n", source_digest: digest("function target() {}\n") }], relations: ["definitions"] });
    assert.equal((noReferences.diagnostics as JsonObject).relations, "analyzed");
    const manyReferences = ["function target() {}", ...Array.from({ length: 26 }, (_, index) => `function caller${index}(){ ${Array.from({ length: 20 }, () => "target();").join(" ")} }`)].join("\n") + "\n";
    const globallyBounded = await analyzeLspSnapshot({ ...base(root, "relations-definition-global-many"), relation_symbol_limit: 100,
      documents: [{ path: "src/relations.js", language: "javascript", content: manyReferences, source_digest: digest(manyReferences) }], relations: ["definitions"] });
    assert.equal((globallyBounded.diagnostics as JsonObject).relations, "partial");
    assert.equal((globallyBounded.edges as JsonObject[]).filter(edge => edge.kind === "definitions").length, 500);
    assert.equal((globallyBounded.diagnostics as JsonObject).relation_omitted_count, 20);
    assert.equal((globallyBounded.diagnostics as JsonObject).relation_query_omitted_count, 0);
    assert.equal((globallyBounded.diagnostics as JsonObject).relation_response_omitted_count, 20);
    assert.equal((globallyBounded.diagnostics as JsonObject).relation_collection_omitted_count, 0);
    const noReferenceProvider = await analyzeLspSnapshot({ ...base(root, "relations-definition-no-references"), documents: [{ path: "src/relations.js", language: "javascript", content: "function target() {}\n", source_digest: digest("function target() {}\n") }], relations: ["definitions"] });
    assert.deepEqual((noReferenceProvider.diagnostics as JsonObject).unsupported_relations, ["definitions"]);
    const bounded = await analyzeLspSnapshot({ ...base(root, "relations-hierarchy-many"), documents, relations: ["type_hierarchy"] });
    assert.equal((bounded.diagnostics as JsonObject).relations, "partial");
    assert.equal(Number((bounded.diagnostics as JsonObject).relation_omitted_count) > 0, true);
    const boundedResults = await analyzeLspSnapshot({ ...base(root, "relations-hierarchy-results-many"), documents, relations: ["type_hierarchy"] });
    assert.equal((boundedResults.diagnostics as JsonObject).relations, "partial");
    assert.equal(Number((boundedResults.diagnostics as JsonObject).relation_omitted_count) > 0, true);
    const withCallable = `${content}function callable() {}\n`;
    const independent = await analyzeLspSnapshot({ ...base(root, "relations-hierarchy-call-error"),
      documents: [{ path: "src/hierarchy.ts", language: "typescript", content: withCallable, source_digest: digest(withCallable) }], relations: ["calls", "type_hierarchy"] });
    assert.equal((independent.diagnostics as JsonObject).relations, "partial");
    assert((independent.edges as JsonObject[]).some(edge => edge.kind === "extends"));
    assert.equal(((independent.diagnostics as JsonObject).relation_failure_stages as JsonObject[]).some(item => item.stage === "call_hierarchy_prepare_failed_-32603"), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real clangd resolves cross-file type hierarchy and definition at a reference site", { skip: !hasClangd }, async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-clangd-hierarchy-")), repo = join(root, "repo"); mkdirSync(join(repo, "src"), { recursive: true }); mkdirSync(join(repo, "include"), { recursive: true });
  const baseContent = "class Base { public: virtual ~Base() = default; };\n", childContent = '#include "../include/base.hpp"\nclass Child : public Base {};\n';
  writeFileSync(join(repo, "include/base.hpp"), baseContent);
  writeFileSync(join(repo, "src/child.cpp"), childContent);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const service = new CraftService(store);
    const workspace = service.workspaceOpen({ workspace_id: "clangd_type_hierarchy", name: "clangd hierarchy", root_path: repo, include_paths: ["src", "include"] }).workspace as JsonObject;
    const checkpoint = service.workspaceCheckpoint({ workspace_id: workspace.id, checkpoint_id: "clangd_type_hierarchy_checkpoint", label: "clangd fixture" }).checkpoint as JsonObject;
    service.codebaseActivate({ workspace_id: workspace.id, actor: "clangd-test" });
    const analysis = await analyzeLspSnapshot({ command: "clangd", args: ["--background-index=0"], cwd: String(checkpoint.snapshot_root),
      analyzer: "clangd", analyzer_version: clangdVersion ?? "unknown", relations: ["type_hierarchy", "definitions"],
      documents: [
        { path: "include/base.hpp", language: "cpp", content: baseContent, source_digest: digest(baseContent) },
        { path: "src/child.cpp", language: "cpp", content: childContent, source_digest: digest(childContent) },
      ] });
    assert.deepEqual((analysis.diagnostics as JsonObject).supported_relations, ["type_hierarchy", "definitions"]);
    assert.equal((analysis.diagnostics as JsonObject).relations, "analyzed");
    assert.equal((analysis.edges as JsonObject[]).filter(edge => edge.kind === "extends").length, 1);
    const definitionEdges = (analysis.edges as JsonObject[]).filter(edge => edge.kind === "definitions");
    assert.equal(definitionEdges.length, 1, JSON.stringify(definitionEdges));
    assert.equal(Number((definitionEdges[0]!.source_span as JsonObject).start_offset), childContent.lastIndexOf("Base"));
    const imported = service.codebaseAnalysisImport({ workspace_id: workspace.id, checkpoint_id: checkpoint.id, index_id: "clangd_type_hierarchy_import", analysis });
    const indexId = String((imported.index as JsonObject).id);
    const child = (service.codebaseSymbolFind({ workspace_id: workspace.id, index_id: indexId, query: "Child" }).symbols as JsonObject[])[0]!;
    const baseNode = (service.codebaseSymbolFind({ workspace_id: workspace.id, index_id: indexId, query: "Base" }).symbols as JsonObject[]).find(node => node.name === "Base" && node.path === "include/base.hpp")!;
    const result = service.codebaseRelationsFind({ workspace_id: workspace.id, index_id: indexId, node_id: child.id, relation_kind: "extends", direction: "outgoing" });
    assert.equal((((result.relations as JsonObject[])[0]?.to as JsonObject)?.id), baseNode.id);
    const definition = service.codebaseDefinitionFind({ workspace_id: workspace.id, index_id: indexId, path: "src/child.cpp", offset: childContent.lastIndexOf("Base") });
    assert.equal(((definition.definitions as JsonObject[])[0]?.id), baseNode.id);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("real clangd builds cross-file C++ caller, reference and bounded impact paths", { skip: !hasClangd }, async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-clangd-call-graph-")), repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true }); mkdirSync(join(repo, "include"), { recursive: true });
  const baseContent = "#pragma once\nclass Base { public: int compute() const { return 7; } };\n";
  const derivedHeader = '#pragma once\n#include "base.hpp"\nclass Derived : public Base {};\nint callCompute();\n';
  const derivedSource = '#include "../include/derived.hpp"\nint callCompute() { Derived value; return value.compute(); }\n';
  const mainSource = '#include "../include/derived.hpp"\nint run() { return callCompute(); }\n';
  const contents = [
    { path: "include/base.hpp", language: "cpp", content: baseContent },
    { path: "include/derived.hpp", language: "cpp", content: derivedHeader },
    { path: "src/derived.cpp", language: "cpp", content: derivedSource },
    { path: "src/main.cpp", language: "cpp", content: mainSource },
  ].map(document => ({ ...document, source_digest: digest(document.content) }));
  for (const item of contents) writeFileSync(join(repo, item.path), item.content);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const service = new CraftService(store);
    const workspace = service.workspaceOpen({ workspace_id: "clangd_call_graph", name: "clangd call graph", root_path: repo,
      include_paths: ["src", "include"] }).workspace as JsonObject;
    const checkpoint = service.workspaceCheckpoint({ workspace_id: workspace.id, checkpoint_id: "clangd_call_checkpoint", label: "clangd call graph" }).checkpoint as JsonObject;
    service.codebaseActivate({ workspace_id: workspace.id, actor: "clangd-test" });
    const analysis = await analyzeLspSnapshot({ command: "clangd", args: ["--background-index=0"], cwd: String(checkpoint.snapshot_root),
      analyzer: "clangd", analyzer_version: clangdVersion ?? "unknown", relations: ["calls", "references", "definitions", "type_hierarchy"], documents: contents });
    const diagnostics = analysis.diagnostics as JsonObject;
    assert.equal(diagnostics.relations, "analyzed", JSON.stringify(diagnostics));
    assert.equal((analysis.edges as JsonObject[]).some(edge => edge.kind === "calls"), true);
    assert.equal((analysis.edges as JsonObject[]).some(edge => edge.kind === "references"), true);
    assert.equal((analysis.edges as JsonObject[]).some(edge => edge.kind === "definitions"), true);
    assert.equal((analysis.edges as JsonObject[]).some(edge => edge.kind === "extends"), true);
    const imported = service.codebaseAnalysisImport({ workspace_id: workspace.id, checkpoint_id: checkpoint.id,
      index_id: "clangd_call_graph_import", analysis });
    const indexId = String((imported.index as JsonObject).id);
    const symbolAt = (name: string, path?: string) => (service.codebaseSymbolFind({ workspace_id: workspace.id, index_id: indexId, query: name, limit: 100 })
      .symbols as JsonObject[]).find(node => node.name === name && (!path || node.path === path))!;
    const run = symbolAt("run", "src/main.cpp"), callCompute = symbolAt("callCompute", "src/derived.cpp"), compute = symbolAt("compute", "include/base.hpp");
    const runCalls = service.codebaseRelationsFind({ workspace_id: workspace.id, index_id: indexId, node_id: run.id, relation_kind: "calls", direction: "outgoing" });
    const helperCalls = service.codebaseRelationsFind({ workspace_id: workspace.id, index_id: indexId, node_id: callCompute.id, relation_kind: "calls", direction: "outgoing" });
    assert.equal((runCalls.relations as JsonObject[]).some(relation => (relation.to as JsonObject).id === callCompute.id), true);
    assert.equal((helperCalls.relations as JsonObject[]).some(relation => (relation.to as JsonObject).id === compute.id), true);
    const impact = service.codebaseImpactQuery({ workspace_id: workspace.id, index_id: indexId, node_id: compute.id,
      direction: "incoming", relation_kind: "calls", max_depth: 2, limit: 100 });
    const impactedIds = new Set((impact.nodes as JsonObject[]).map(node => node.id));
    assert.equal(impactedIds.has(callCompute.id), true);
    assert.equal(impactedIds.has(run.id), true);
    assert.equal(impact.truncated, false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("stdio LSP reports unsupported and over-budget relation coverage as partial", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-partial-"));
  try {
    const unsupported = await analyzeLspSnapshot({ ...base(root), relations: ["calls"] });
    assert.equal((unsupported.diagnostics as JsonObject).relations, "partial");
    assert.deepEqual((unsupported.diagnostics as JsonObject).unsupported_relations, ["calls"]);
    const content = "function target() {}\nfunction caller(){ target(); }\n";
    const bounded = await analyzeLspSnapshot({ ...base(root, "relations"), documents: [{ path: "src/relations.js", language: "javascript", content, source_digest: digest(content) }],
      relations: ["calls"], relation_symbol_limit: 1 });
    assert.equal((bounded.diagnostics as JsonObject).relations, "partial");
    assert.equal((bounded.diagnostics as JsonObject).relation_omitted_count, 1);
    assert.equal((bounded.diagnostics as JsonObject).relation_candidate_symbol_count, 2);
    assert.equal((bounded.diagnostics as JsonObject).relation_symbol_count, 1);
    assert.equal((bounded.diagnostics as JsonObject).relation_query_omitted_count, 1);
    assert.equal((bounded.diagnostics as JsonObject).relation_response_omitted_count, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stdio LSP preserves symbols and reports optional relation request failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-relation-failures-"));
  try {
    const content = "function target() {}\nfunction caller(){ target(); }\n";
    const result = await analyzeLspSnapshot({ ...base(root, "relations-error"), documents: [{ path: "src/relations.js", language: "javascript", content, source_digest: digest(content) }], relations: ["calls"] });
    assert.equal((result.nodes as JsonObject[]).filter(node => node.kind === "symbol").length, 2);
    assert.equal((result.diagnostics as JsonObject).relations, "partial");
    assert.equal((result.diagnostics as JsonObject).relation_query_failures, 2);
    assert.deepEqual((result.diagnostics as JsonObject).relation_failure_stages, [{ stage: "call_hierarchy_incoming_failed_-32601", count: 2 }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stdio LSP reports malformed optional relation results and redacts transport error details", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-invalid-relations-"));
  try {
    const content = "function target() {}\nfunction caller(){ target(); }\n";
    const result = await analyzeLspSnapshot({ ...base(root, "relations-invalid"), documents: [{ path: "src/relations.js", language: "javascript", content, source_digest: digest(content) }], relations: ["references"] });
    assert.equal((result.diagnostics as JsonObject).relations, "partial");
    assert.equal((result.diagnostics as JsonObject).relation_query_failures, 2);
    assert.deepEqual((result.diagnostics as JsonObject).relation_failure_stages, [{ stage: "references_invalid_result", count: 2 }]);
    assert.equal(safeFailureCode(new Error("private server message")), "transport");
    assert.equal(safeFailureCode("not an Error"), "transport");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stdio LSP reports invalid implementation and type definition result shapes as partial", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-invalid-semantic-relations-"));
  try {
    const content = "function target() {}\nfunction caller(){ target(); }\n";
    const result = await analyzeLspSnapshot({ ...base(root, "relations-impl-invalid"), documents: [{ path: "src/relations.js", language: "javascript", content, source_digest: digest(content) }], relations: ["implementations", "type_definitions"] });
    assert.equal((result.diagnostics as JsonObject).relations, "partial");
    assert.deepEqual((result.diagnostics as JsonObject).relation_failure_stages, [
      { stage: "type_definition_invalid_result", count: 2 }, { stage: "implementation_invalid_result", count: 2 },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stdio LSP records implementation and type definition request failures without exposing messages", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-semantic-request-failures-"));
  try {
    const content = "function target() {}\nfunction caller(){ target(); }\n";
    const result = await analyzeLspSnapshot({ ...base(root, "relations-semantic-error"), documents: [{ path: "src/relations.js", language: "javascript", content, source_digest: digest(content) }], relations: ["implementations", "type_definitions"] });
    assert.equal((result.diagnostics as JsonObject).relations, "partial");
    assert.deepEqual((result.diagnostics as JsonObject).relation_failure_stages, [
      { stage: "type_definition_request_failed_-32603", count: 2 }, { stage: "implementation_request_failed_-32603", count: 2 },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stdio LSP classifies null, malformed and failed reference and call hierarchy responses", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-relation-shapes-"));
  const content = "function target() {}\nfunction caller(){ target(); }\n";
  const documents = [{ path: "src/relations.js", language: "javascript", content, source_digest: digest(content) }];
  try {
    for (const [mode, relation, status, failureStage] of [
      ["relations-refs-error", "references", "partial", "references_request_failed"],
      ["relations-refs-null", "references", "analyzed", undefined],
      ["relations-prepare-error", "calls", "partial", "call_hierarchy_prepare_failed_-32603"],
      ["relations-prepare-null", "calls", "analyzed", undefined],
      ["relations-prepare-invalid", "calls", "partial", "call_hierarchy_invalid_prepare_result"],
      ["relations-prepare-empty", "calls", "analyzed", undefined],
      ["relations-incoming-null", "calls", "analyzed", undefined],
      ["relations-incoming-invalid", "calls", "partial", "call_hierarchy_invalid_incoming_result"],
    ] as const) {
      const result = await analyzeLspSnapshot({ ...base(root, mode), documents, relations: [relation] });
      assert.equal((result.diagnostics as JsonObject).relations, status, mode);
      if (failureStage) assert.deepEqual((result.diagnostics as JsonObject).relation_failure_stages, [{ stage: failureStage, count: 2 }]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("LSP symbol position resolver enforces snapshot source and UTF-16 offsets", () => {
  const doc = { ...document, content: "π\nclass Example {}", source_digest: digest("π\nclass Example {}") };
  assert.deepEqual(resolveLspSymbolPosition([doc], { path: doc.path, span: { start_offset: 2 } }), { document: doc, selection: { line: 1, character: 0 } });
  assert.throws(() => resolveLspSymbolPosition([], { path: doc.path, span: { start_offset: 0 } }), /no source document/);
  assert.throws(() => resolveLspSymbolPosition([doc], { path: doc.path, span: { start_offset: 999 } }), /outside its source document/);
  assert.throws(() => resolveLspSymbolPosition([doc], { path: doc.path }), /outside its source document/);
});

test("stdio LSP accepts an object-valued provider declaration and single-line documents", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-object-provider-"));
  try {
    const content = "function target() {} function caller(){ target(); }";
    const result = await analyzeLspSnapshot({ ...base(root, "relations-object-provider"), documents: [{ path: "src/relations.js", language: "javascript", content, source_digest: digest(content) }], relations: ["references"] });
    assert.equal((result.diagnostics as JsonObject).relations, "analyzed");
    assert.deepEqual((result.diagnostics as JsonObject).supported_relations, ["references"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stdio LSP waits for active work-done progress before querying snapshot relations", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-progress-"));
  try {
    const result = await analyzeLspSnapshot({ ...base(root, "relations-progress"), relations: ["implementations"] });
    const diagnostics = result.diagnostics as JsonObject;
    assert.equal(diagnostics.work_done_progress_waited, true);
    assert.equal(diagnostics.work_done_progress_timed_out, false);
    assert.equal(diagnostics.relation_query_failures, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stdio LSP serializes implementation queries in stable symbol order", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-implementation-order-"));
  const content = "class First {}\nclass Second {}\n";
  try {
    const result = await analyzeLspSnapshot({ ...base(root, "relations-semantic-implementation-order"),
      documents: [{ path: "src/implementation.js", language: "javascript", content, source_digest: digest(content) }], relations: ["implementations"] });
    const diagnostics = result.diagnostics as JsonObject;
    assert.equal(diagnostics.relation_candidate_symbol_count, 2);
    assert.equal(diagnostics.relation_query_failures, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stdio LSP marks relation results partial when active work-done progress times out", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-progress-timeout-"));
  try {
    // Leave enough time for the fixture to initialize when branch coverage is
    // enabled; the timeout under test is the progress wait after didOpen.
    const result = await analyzeLspSnapshot({ ...base(root, "relations-progress-timeout"), relations: ["implementations"] }, 500);
    const diagnostics = result.diagnostics as JsonObject;
    assert.equal(diagnostics.work_done_progress_waited, true);
    assert.equal(diagnostics.work_done_progress_timed_out, true);
    assert.equal(diagnostics.relations, "partial");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stdio LSP handles empty symbols and rejects malformed response, timeout and failed shutdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-errors-"));
  try {
    const empty = await analyzeLspSnapshot({ ...base(root), documents: [{ ...document, content: "", source_digest: digest("") }] });
    assert.equal((empty.nodes as JsonObject[]).length, 0);
    const nullSymbols = await analyzeLspSnapshot(base(root, "null-symbols"));
    assert.equal((nullSymbols.nodes as JsonObject[]).length, 0);
    await assert.rejects(analyzeLspSnapshot(base(root, "malformed")), /invalid DocumentSymbol/);
    await assert.rejects(analyzeLspSnapshot(base(root, "timeout"), 50), /timed out/);
    await assert.rejects(analyzeLspSnapshot(base(root, "nonzero")), /unsuccessfully/);
    await assert.rejects(analyzeLspSnapshot(base(root, "request-error")), /request failed/);
    await assert.rejects(analyzeLspSnapshot(base(root, "bad-frame")), /Malformed language server frame/);
    await assert.rejects(analyzeLspSnapshot(base(root, "bad-json")), /Malformed language server JSON/);
    await assert.rejects(analyzeLspSnapshot(base(root, "bad-shape")), /JSON-RPC message/);
    await assert.rejects(analyzeLspSnapshot(base(root, "bad-array")), /JSON-RPC message/);
    await assert.rejects(analyzeLspSnapshot(base(root, "bad-version")), /JSON-RPC message/);
    // The overflow-buffer fixture writes 64 MiB; allow the child to reach the
    // protocol guard even while Node's coverage instrumentation slows the test.
    await assert.rejects(analyzeLspSnapshot(base(root, "oversized"), 30_000), /response exceeds budget/);
    await assert.rejects(analyzeLspSnapshot(base(root, "overflow-buffer"), 30_000), /response exceeds budget/);
    assert((await analyzeLspSnapshot(base(root, "split-frame"))).nodes instanceof Array);
    await assert.rejects(analyzeLspSnapshot(base(root, "exit-before")), /exited before completion during textDocument\/documentSymbol \(code 4, signal none\)/u);
    await assert.rejects(analyzeLspSnapshot(base(root, "close-stdin")), /exited before completion during initialize \(code 4, signal none\)/u);
    await assert.rejects(analyzeLspSnapshot({ ...base(root, "close-after-response"), documents: [document, { ...document, path: "src/other.java" }] }), /Malformed language server frame/);
    await assert.rejects(analyzeLspSnapshot(base(root, "close-after-response")), /Malformed language server frame/);
    await assert.rejects(analyzeLspSnapshot(base(root, "error-unknown")), /unknown/);
    const serverRequests = await analyzeLspSnapshot(base(root, "server-requests"));
    assert.equal(((serverRequests.diagnostics as JsonObject).stderr_bytes_observed), 0);
    const stderr = await analyzeLspSnapshot(base(root, "stderr"));
    assert.equal(((stderr.diagnostics as JsonObject).stderr_bytes_observed), Buffer.byteLength("fixture diagnostic\n"));
    assert.equal((await analyzeLspSnapshot(base(root, "shutdown-fast"))).analyzer, "stdio-fixture");
    const { args: _args, ...withoutArgs } = base(root);
    await assert.rejects(analyzeLspSnapshot({ ...withoutArgs, command: "/usr/bin/true" }), /exited before completion/);
    await assert.rejects(analyzeLspSnapshot(base(root, "hang-after-shutdown"), 500), /did not exit after shutdown/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stdio LSP validates executable arguments, budgets, paths and snapshot digests before spawn", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-validation-"));
  try {
    const valid = base(root);
    for (const input of [
      { ...valid, command: " " }, { ...valid, args: [1] }, { ...valid, cwd: "relative" }, { ...valid, analyzer: "" },
      { ...valid, analyzer_version: "" }, { ...valid, documents: [] }, { ...valid, documents: Array(1001).fill(document) },
      { ...valid, documents: [{ ...document, path: "../escape.java" }] }, { ...valid, documents: [{ ...document, path: "" }] },
      { ...valid, documents: [{ ...document, path: "src/../example.java" }] }, { ...valid, documents: [{ ...document, path: "." }] }, { ...valid, documents: [document, document] },
      { ...valid, documents: [{ ...document, language: "" }] }, { ...valid, documents: [{ ...document, source_digest: "wrong" }] },
      { ...valid, documents: [{ ...document, cached_symbols: {} as never }] },
      { ...valid, documents: [{ ...document, cached_symbols: [{ name: "x".repeat(33 * 1024 * 1024) }] }] },
      { ...valid, documents: [{ ...document, content: "x".repeat(2_000_001), source_digest: digest("x".repeat(2_000_001)) }] },
    ]) await assert.rejects(analyzeLspSnapshot(input as never), /Invalid|budget|outside|digest|below the checkpoint/);
    await assert.rejects(analyzeLspSnapshot(valid, 0), /timeout is outside/);
    await assert.rejects(analyzeLspSnapshot(valid, 120_001), /timeout is outside/);
    const largeDocuments = Array.from({ length: 40 }, (_, index) => ({ ...document, path: `src/${index}.java`, content: "x".repeat(1_800_000), source_digest: digest("x".repeat(1_800_000)) }));
    await assert.rejects(analyzeLspSnapshot({ ...valid, documents: largeDocuments }), /checkpoint exceeds byte budget/);
    await assert.rejects(analyzeLspSnapshot({ ...valid, command: join(root, "missing-executable") }), /Unable to start/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("LSP shutdown wait accepts an already successful exit and rejects an already failed exit", async () => {
  for (const [code, shouldReject] of [[0, false], [7, true]] as const) {
    const child = spawn(process.execPath, ["-e", `process.exit(${code})`], { stdio: ["pipe", "pipe", "pipe"] });
    await new Promise<void>(resolve => child.once("close", () => resolve()));
    if (shouldReject) await assert.rejects(waitForClose(child, 100), /unsuccessfully/);
    else await waitForClose(child, 100);
  }
});

test("LSP stdin pipe errors are left for the child close handler to report", () => {
  assert.doesNotThrow(() => ignoreLspStdinError(Object.assign(new Error("closed pipe"), { code: "EPIPE" })));
});
