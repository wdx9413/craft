import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { codebaseCapability, CODEBASE_KERNELS } from "../capability/craft-codebase/capability.ts";
import { CodebaseIndexKernel, contentAddressedShardIds, relationAnalysisSummary, controlFlowFallback, dataFlowFallback } from "../capability/craft-codebase/codebase-index.ts";
import { queryCheckpointDiagnostics } from "../capability/craft-codebase/lsp-diagnostics-query.ts";
import { CODEBASE_OWNS } from "../capability/craft-codebase/ownership.ts";
import { CRAFT_CAPABILITIES } from "../core/capability-catalog.ts";
import { buildCapabilityRegistry, CORE_KERNELS } from "../core/capability-protocol.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { PROVIDER_CATALOG } from "../core/model-gateway.ts";
import { McpServer, surfaceToolNames } from "../core/mcp.ts";
import { CraftService } from "../core/service.ts";
import { digestJson, stableDigest } from "../common/craft-common-base/src/digest.ts";
import { analyzePythonCheckpoint } from "../capability/craft-codebase/python-analysis.ts";
import { analyzeJavaCheckpoint } from "../capability/craft-codebase/java-analysis.ts";
import { CodeSymbolSearchIndex } from "../capability/craft-codebase/context-search.ts";

const lspFixturePath = fileURLToPath(new URL("./fixtures/lsp-stdio-fixture.cjs", import.meta.url));

test("relation analysis coverage distinguishes empty, partial, analyzed and unknown graphs", () => {
  const none: JsonObject[] = [];
  const basic = relationAnalysisSummary("craft-basic-symbols", [], none);
  assert.equal(basic.status, "not_analyzed");
  assert.equal(basic.next_action, "build_semantic_index");
  assert.deepEqual(basic.partial_reasons, []);
  const nestedPartial = relationAnalysisSummary("lsp-typescript", { languages: [{ diagnostics: {
    relations: "partial", budget_limited: true, omitted_edges: 1, omitted_nodes: 1, relation_omitted_count: 1,
    relation_query_failures: 1, unresolved_relations: 1, unresolved_calls: 1, unresolved_imports: 1,
    unsupported_relations: ["calls"], degraded_languages: ["ts"],
  } }] }, none);
  assert.equal(nestedPartial.status, "partial");
  assert.deepEqual(nestedPartial.partial_reasons, ["analysis_budget_limited", "degraded_languages", "omitted_edges", "omitted_nodes",
    "provider_reported_partial", "relation_omitted_count", "relation_query_failures", "unresolved_calls", "unresolved_imports", "unresolved_relations", "unsupported_relations"]);
  const javaCompilerErrors = relationAnalysisSummary("jdk-compiler-tree", { compiler_errors: 2, syntax_errors: 1 }, none);
  assert.equal(javaCompilerErrors.status, "partial");
  assert.deepEqual(javaCompilerErrors.partial_reasons, ["compiler_errors", "syntax_errors"]);
  const partialWithEdges = relationAnalysisSummary("lsp-typescript", { relations: "partial" }, [{ kind: "calls" }]);
  assert.deepEqual(partialWithEdges.partial_reasons, ["provider_reported_partial"]);
  const mixed = relationAnalysisSummary("lsp-multi", [{ relations: "analyzed" }, { relations: "not_requested" }], none);
  assert.equal(mixed.status, "partial");
  assert.deepEqual(mixed.partial_reasons, ["mixed_language_relation_coverage"]);
  const analyzed = relationAnalysisSummary("lsp-typescript", { relations: "analyzed" }, none);
  assert.equal(analyzed.status, "analyzed");
  const unknown = relationAnalysisSummary("external", undefined, none);
  assert.equal(unknown.status, "unknown");
  const adapterEdges = relationAnalysisSummary("external", undefined, [{ kind: "calls" }, {}]);
  assert.equal(adapterEdges.status, "partial");
  assert.deepEqual(adapterEdges.partial_reasons, ["adapter_reported_relations"]);
  assert.deepEqual(adapterEdges.relation_kinds, ["calls", "unknown"]);
});

test("control and data flow fallbacks remain source-free with or without analyzer diagnostics", () => {
  assert.equal((controlFlowFallback({ diagnostic: { reason: "runtime_unavailable" } }, "java").partial_reasons as string[])[0], "runtime_unavailable");
  assert.equal((controlFlowFallback({}, "python").partial_reasons as string[])[0], "analysis_unavailable");
  assert.equal((controlFlowFallback({ result: { status: "complete" } }, "java").status), "complete");
  assert.equal((dataFlowFallback({ diagnostic: { reason: "runtime_unavailable" } }, "python", "symbol", "value").partial_reasons as string[])[0], "runtime_unavailable");
  assert.equal((dataFlowFallback({}, "python", "symbol", "value").partial_reasons as string[])[0], "analysis_unavailable");
  assert.equal((dataFlowFallback({ result: { status: "complete" } }, "python", "symbol", "value").status), "complete");
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-codebase-")); const project = join(root, "project"); await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "src", "target.ts"), "export function target() { return 1; }\nexport function targetHelper() { return target(); }\nexport const shared = 1;\n");
  await writeFile(join(project, "src", "flow.ts"), "export function processInput(input: boolean) { let value = 0; if (input) { value = 1; } return value; }\n");
  await writeFile(join(project, "src", "caller.ts"), "import { target } from './target';\nexport function caller() { missing(); shared(); return target(); }\n");
  await writeFile(join(project, "src", "duplicate.ts"), "export function shared() { return 2; }\n");
  await writeFile(join(project, "src", "external.ts"), "import value from 'outside';\nexport function unrelated() { if (value) return target(); return 0; }\n");
  await writeFile(join(project, "src", "direct.ts"), "import { target } from './target.ts';\nexport const direct = () => target();\n");
  await writeFile(join(project, "src", "view.tsx"), "export const View = () => <div />;\n");
  await writeFile(join(project, "src", "generated.py"), "def route(flag):\n    value = 0\n    if flag:\n        value = 1\n    return value\n");
  await writeFile(join(project, "src", "README.md"), "not source\n");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open(); const service = new CraftService(store);
  const workspace = service.workspaceOpen({ workspace_id: "ws", name: "Project", root_path: project, include_paths: ["src"] }).workspace as JsonObject;
  const checkpoint = service.workspaceCheckpoint({ workspace_id: workspace.id, checkpoint_id: "base", label: "base" }).checkpoint as JsonObject;
  return { root, project, store, service, workspace, checkpoint, kernel: service.codebase };
}
async function close(f: Awaited<ReturnType<typeof fixture>>) { f.store.close(); await rm(f.root, { recursive: true, force: true }); }

function active(f: Awaited<ReturnType<typeof fixture>>) { return f.kernel.activate({ workspace_id: f.workspace.id, actor: "tester" }).activation as JsonObject; }
function index(f: Awaited<ReturnType<typeof fixture>>) { return f.kernel.build({ workspace_id: f.workspace.id, checkpoint_id: f.checkpoint.id }).index as JsonObject; }
function graphNodes(f: Awaited<ReturnType<typeof fixture>>, indexRecord: JsonObject): JsonObject[] {
  return (indexRecord.shard_ids as string[]).flatMap(id => f.store.get("codebase_index_shard", id).nodes as JsonObject[]);
}
function graphEdges(f: Awaited<ReturnType<typeof fixture>>, indexRecord: JsonObject): JsonObject[] {
  return (indexRecord.shard_ids as string[]).flatMap(id => f.store.get("codebase_index_shard", id).edges as JsonObject[]);
}
function symbol(f: Awaited<ReturnType<typeof fixture>>, indexId: string, query = "target") {
  return (f.kernel.findSymbol({ workspace_id: f.workspace.id, index_id: indexId, query }).symbols as JsonObject[])[0];
}

test("craft-codebase is an internal non-context Capability with an owned read-only surface", async () => {
  const f = await fixture();
  try {
    assert.equal(codebaseCapability.name, "codebase"); assert.equal(codebaseCapability.product, undefined); assert.equal(codebaseCapability.contributes, undefined);
    for (const name of ["craft_codebase_activate", "craft_codebase_index_build", "craft_codebase_context_slice", "craft_codebase_symbols_overview", "craft_codebase_symbol_explore", "craft_codebase_symbol_read", "craft_codebase_control_flow_query", "craft_codebase_data_flow_query", "craft_codebase_diagnostics_find"]) assert(CODEBASE_OWNS.test(name));
    assert.equal(CODEBASE_OWNS.test("craft_codebase_asset_inspect"), false);
    assert.equal(CODEBASE_OWNS.test("craft_codebase_asset_restore"), false);
    assert.equal(CODEBASE_OWNS.test("craft_knowledge_search"), false);
    const disabled = f.kernel.status({ workspace_id: f.workspace.id }); assert.equal(disabled.enabled, false); assert.equal(disabled.readiness, "disabled");
    const defaultActivation = f.kernel.activate({ workspace_id: f.workspace.id, activation_id: "default_activation" }).activation as JsonObject;
    assert.equal(defaultActivation.status, "active"); assert.equal(f.kernel.deactivate({ workspace_id: f.workspace.id, activation_id: "default_activation" }).idempotent, false);
    assert.throws(() => f.kernel.activate({ workspace_id: "../bad" }), /relative|only letters/);
    const { registry } = buildCapabilityRegistry(CRAFT_CAPABILITIES, { [CORE_KERNELS.store]: f.store, [CORE_KERNELS.modelProviders]: PROVIDER_CATALOG });
    assert(registry.require<CodebaseIndexKernel>(CODEBASE_KERNELS.index));
    assert.equal(CRAFT_CAPABILITIES.includes(codebaseCapability), true);
  } finally { await close(f); }
});

test("craft-codebase is explicit, snapshot-pinned, content-free, and exposes structural queries", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.kernel.build({ workspace_id: f.workspace.id }), /not explicitly active/);
    const activation = active(f); assert.equal(f.kernel.activate({ workspace_id: f.workspace.id, actor: "tester" }).idempotent, true);
    const before = f.kernel.status({ workspace_id: f.workspace.id }); assert.equal(before.enabled, true); assert.equal(before.readiness, "index_required"); assert.equal((before.indexes as JsonObject[]).length, 0);
    const built = f.kernel.build({ workspace_id: f.workspace.id }).index as JsonObject; assert.equal(built.status, "ready"); assert.equal(built.raw_content_stored, false); assert.equal((built.analysis as JsonObject).certainty, "partial"); assert(Number((built.analysis as JsonObject).unsupported_file_count) >= 1); assert.equal(f.kernel.build({ workspace_id: f.workspace.id, checkpoint_id: f.checkpoint.id }).idempotent, true);
    assert.equal(f.kernel.status({ workspace_id: f.workspace.id }).readiness, "ready");
    const found = f.kernel.findSymbol({ workspace_id: f.workspace.id, index_id: built.id, query: "TARGET" }); const target = (found.symbols as JsonObject[])[0];
    assert.equal(target.name, "target"); assert.equal((found.receipt as JsonObject).content_free, true); assert.equal((found.receipt as JsonObject).analyzer, "typescript-checker"); assert.equal(((found.receipt as JsonObject).analysis as JsonObject).certainty, "partial");
    assert.equal(target.declaration_kind, "function", "analysis import must preserve semantic declaration categories for retrieval and Agent clients");
    const directFunction = graphNodes(f, built).find(node => node.name === "direct" && node.path === "src/direct.ts");
    assert.equal(directFunction?.declaration_kind, "function", "function-valued variable declarations must retain callable symbol semantics");
    const sharedMatches = f.kernel.findSymbol({ workspace_id: f.workspace.id, index_id: built.id, query: "shared" }).symbols as JsonObject[];
    assert.equal(sharedMatches.length, 3, "declaration identifiers also surface callers that mention the searched code concept");
    assert(sharedMatches.some(node => node.name === "caller" && node.path === "src/caller.ts"));
    const outline = f.kernel.symbolsOverview({ workspace_id: f.workspace.id, index_id: built.id, path: "src/target.ts", limit: 2 });
    assert.deepEqual((outline.symbols as JsonObject[]).map(node => node.name), ["target", "targetHelper"]);
    assert.equal(outline.candidate_count, 3); assert.equal(outline.omitted_count, 1); assert.equal(outline.truncated, true); assert.equal(outline.content_included, false);
    assert.equal((outline.receipt as JsonObject).kind, "symbols_overview");
    assert.equal((f.kernel.symbolsOverview({ workspace_id: f.workspace.id, index_id: built.id, path: "src/README.md" }).symbols as JsonObject[]).length, 0);
    assert.throws(() => f.kernel.symbolsOverview({ workspace_id: f.workspace.id, index_id: built.id, path: "../outside.ts" }), /stay below/u);
    assert.throws(() => f.kernel.symbolsOverview({ workspace_id: f.workspace.id, index_id: built.id, path: join(f.project, "src/target.ts") }), /stay below/u);
    assert.throws(() => f.kernel.symbolsOverview({ workspace_id: f.workspace.id, index_id: built.id, path: "outside.ts" }), /outside checkpoint/u);
    assert.throws(() => f.kernel.symbolsOverview({ workspace_id: f.workspace.id, index_id: built.id, path: "src/target.ts", limit: 501 }), /between/u);
    const callers = f.kernel.findCallers({ workspace_id: f.workspace.id, index_id: built.id, symbol_id: target.id, limit: 1 });
    assert((callers.callers as JsonObject[]).length >= 1); assert.equal((((callers.callers as JsonObject[])[0].edge as JsonObject).confidence), "partial");
    assert(Number(((callers.receipt as JsonObject).query as JsonObject).omitted_count) > 0);
    const impact = f.kernel.impact({ workspace_id: f.workspace.id, index_id: built.id, node_id: target.id, max_depth: 2, limit: 1 }); assert.equal(impact.candidate_only, true); assert.equal((impact.edges as JsonObject[]).length, 1); assert.equal(impact.truncated, true);
    const fullImpact = f.kernel.impact({ workspace_id: f.workspace.id, index_id: built.id, node_id: target.id, max_depth: 2, limit: 100 });
    assert((fullImpact.edges as JsonObject[]).length > 1);
    const exactBudgetImpact = f.kernel.impact({ workspace_id: f.workspace.id, index_id: built.id, node_id: target.id,
      max_depth: 2, limit: (fullImpact.edges as JsonObject[]).length });
    assert.equal(exactBudgetImpact.truncated, false, "an impact result that exactly fills its edge budget is complete when no more edges exist");
    const directImpact = f.kernel.impact({ workspace_id: f.workspace.id, index_id: built.id, node_id: target.id,
      max_depth: 1, limit: 100 });
    const directEdgeLimit = (directImpact.edges as JsonObject[]).length;
    assert.equal(f.kernel.impact({ workspace_id: f.workspace.id, index_id: built.id, node_id: target.id,
      max_depth: 1, limit: directEdgeLimit }).truncated, false, "an exact budget at the requested final depth is complete");
    assert.equal(f.kernel.impact({ workspace_id: f.workspace.id, index_id: built.id, node_id: target.id,
      max_depth: 2, limit: directEdgeLimit }).truncated, true, "an edge available at the next requested depth must trigger truncation");
    const shortBudgetImpact = f.kernel.impact({ workspace_id: f.workspace.id, index_id: built.id, node_id: target.id,
      max_depth: 2, limit: (fullImpact.edges as JsonObject[]).length - 1 });
    assert.equal(shortBudgetImpact.truncated, true, "an omitted reachable edge must be reported as truncation");
    const incomingImpact = f.kernel.impact({ workspace_id: f.workspace.id, index_id: built.id, node_id: target.id, max_depth: 1, direction: "incoming" });
    assert((incomingImpact.edges as JsonObject[]).length > 0);
    assert((incomingImpact.edges as JsonObject[]).every(edge => edge.to_node_id === target.id));
    assert.equal((incomingImpact.direction), "incoming");
    const callImpact = f.kernel.impact({ workspace_id: f.workspace.id, index_id: built.id, node_id: target.id, max_depth: 2, relation_kind: "calls" });
    assert((callImpact.edges as JsonObject[]).length > 0);
    assert((callImpact.edges as JsonObject[]).every(edge => edge.kind === "calls"));
    assert.equal(callImpact.relation_kind, "calls");
    const importImpact = f.kernel.impact({ workspace_id: f.workspace.id, index_id: built.id, node_id: target.id, max_depth: 2, relation_kind: "imports" });
    assert((importImpact.edges as JsonObject[]).every(edge => edge.kind === "imports"));
    const caller = symbol(f, String(built.id), "caller");
    const outgoingImpact = f.kernel.impact({ workspace_id: f.workspace.id, index_id: built.id, node_id: caller.id, max_depth: 1, direction: "outgoing" });
    assert((outgoingImpact.edges as JsonObject[]).length > 0);
    assert((outgoingImpact.edges as JsonObject[]).every(edge => edge.from_node_id === caller.id));
    assert.throws(() => f.kernel.impact({ workspace_id: f.workspace.id, index_id: built.id, node_id: target.id, direction: "sideways" }), /direction must be/u);
    assert.throws(() => f.kernel.impact({ workspace_id: f.workspace.id, index_id: built.id, node_id: target.id, relation_kind: "runtime_truth" }), /Unsupported Codebase relation kind/u);
    const direct = symbol(f, String(built.id), "direct"); const slice = f.kernel.contextSlice({ workspace_id: f.workspace.id, index_id: built.id, node_ids: [target.id, direct.id], limit: 1 }); assert.equal(slice.content_included, false); assert.equal((slice.references as JsonObject[])[0].path, "src/target.ts"); assert.equal(((slice.receipt as JsonObject).query as JsonObject).omitted_count, 1);
    assert.equal((f.kernel.findSymbol({ workspace_id: f.workspace.id, index_id: built.id, query: "target" }).receipt as JsonObject).id, (found.receipt as JsonObject).id);
    assert.equal(String((activation as JsonObject).effect), "read_only");
  } finally { await close(f); }
});

test("AI task search uses verified declaration identifiers without returning source text", async () => {
  const f = await fixture();
  try {
    active(f);
    const path = "src/search.ts";
    const content = "export function persistIndex() { return store.create('graph_shard', routeBucket); }\nexport function matchGraphRoutes() { return true; }\n";
    await writeFile(join(f.project, path), content);
    const checkpoint = f.service.workspaceCheckpoint({ workspace_id: f.workspace.id, checkpoint_id: "search_snapshot", label: "search" }).checkpoint as JsonObject;
    const entry = (checkpoint.entries as JsonObject[]).find(item => item.path === path)!;
    const digest = createHash("sha256").update(content).digest("hex");
    const declaration = (name: string): JsonObject => {
      const start = content.indexOf(`export function ${name}`), end = content.indexOf("\n", start);
      const nameStart = content.indexOf(name, start);
      return { id: `symbol_${name}`, kind: "symbol", path, name, source_digest: digest, language: "typescript",
        span: { start_offset: nameStart, end_offset: nameStart + name.length }, declaration_span: { start_offset: start, end_offset: end } };
    };
    assert.equal(entry.digest, digest);
    const imported = f.kernel.importAnalysis({ workspace_id: f.workspace.id, checkpoint_id: checkpoint.id,
      analysis: { format: "craft-static-analysis-v1", analyzer: "fixture-semantic", analyzer_version: "1", diagnostics: { relations: "analyzed" },
        nodes: [declaration("persistIndex"), declaration("matchGraphRoutes")], edges: [] } });
    const result = f.kernel.findSymbol({ workspace_id: f.workspace.id, index_id: (imported.index as JsonObject).id, query: "persist graph shards routes" });
    const symbols = result.symbols as JsonObject[];
    assert.equal(symbols[0]?.name, "persistIndex");
    assert.equal(JSON.stringify(result).includes("store.create"), false);
    assert.equal(JSON.stringify(result).includes("routeBucket"), false);
  } finally { await close(f); }
});

test("analysis imports reject malformed and over-budget graph facts before publishing", async () => {
  const f = await fixture();
  try {
    active(f);
    const checkpoint = f.checkpoint;
    const entry = (checkpoint.entries as JsonObject[]).find(item => item.path === "src/target.ts")!;
    const node = (overrides: JsonObject = {}): JsonObject => ({ id: "symbol", kind: "symbol", path: entry.path,
      name: "target", source_digest: entry.digest, language: "typescript", span: { start_offset: 0, end_offset: 6 }, ...overrides });
    const analysis = (overrides: JsonObject = {}): JsonObject => ({ format: "craft-static-analysis-v1", analyzer: "fixture", analyzer_version: "1",
      nodes: [node()], edges: [], ...overrides });
    const rejects = (id: string, input: JsonObject, pattern: RegExp, checkpointId = checkpoint.id) => {
      assert.throws(() => f.kernel.importAnalysis({ workspace_id: f.workspace.id, checkpoint_id: checkpointId, index_id: id, analysis: input }), pattern);
    };

    rejects("bad-format", analysis({ format: "other" }), /Unsupported analysis format/u);
    rejects("oversized-bytes", analysis({ padding: "x".repeat(64 * 1024 * 1024) }), /64 MiB budget/u);
    rejects("long-analyzer", analysis({ analyzer: "a".repeat(101) }), /Analyzer identity exceeds budget/u);
    rejects("long-analyzer-version", analysis({ analyzer_version: "v".repeat(101) }), /Analyzer identity exceeds budget/u);
    rejects("missing-nodes", analysis({ nodes: undefined }), /nodes\/edges exceed budget/u);
    rejects("empty-nodes", analysis({ nodes: [] }), /nodes\/edges exceed budget/u);
    rejects("over-budget-nodes", analysis({ nodes: Array.from({ length: 60_001 }, () => ({})) }), /nodes\/edges exceed budget/u);
    rejects("missing-edges", analysis({ edges: undefined }), /nodes\/edges exceed budget/u);
    rejects("over-budget-edges", analysis({ edges: Array.from({ length: 300_001 }, () => ({})) }), /nodes\/edges exceed budget/u);
    rejects("outside-path", analysis({ nodes: [node({ path: "src/missing.ts" })] }), /outside checkpoint/u);
    rejects("invalid-span", analysis({ nodes: [node({ span: { start_offset: -1, end_offset: 1 } })] }), /span is outside snapshot/u);
    rejects("wrong-source-digest", analysis({ nodes: [node({ source_digest: "wrong" })] }), /source digest mismatch/u);
    rejects("unsupported-node-kind", analysis({ nodes: [node({ kind: "package" })] }), /Unsupported analysis node kind/u);
    rejects("duplicate-node-id", analysis({ nodes: [node(), node({ path: "src/target.ts" })] }), /node ids must be unique/u);
    rejects("missing-edge-endpoint", analysis({ edges: [{ kind: "calls", from_node_id: "symbol", to_node_id: "missing",
      source_span: { start_offset: 0, end_offset: 1 } }] }), /edge endpoint is missing/u);
    rejects("unsupported-edge-kind", analysis({ edges: [{ kind: "owns", from_node_id: "symbol", to_node_id: "symbol",
      source_span: { start_offset: 0, end_offset: 1 } }] }), /Unsupported analysis edge kind/u);

    const other = f.service.workspaceOpen({ workspace_id: "other_workspace", name: "Other", root_path: f.project, include_paths: ["src"] }).workspace as JsonObject;
    const otherCheckpoint = f.service.workspaceCheckpoint({ workspace_id: other.id, checkpoint_id: "other-snapshot", label: "other snapshot" }).checkpoint as JsonObject;
    rejects("foreign-checkpoint", analysis(), /latest workspace checkpoint/u, otherCheckpoint.id);
    f.service.workspaceCheckpoint({ workspace_id: f.workspace.id, checkpoint_id: "newer-snapshot", label: "newer snapshot" });
    rejects("stale-checkpoint", analysis(), /latest workspace checkpoint/u);

    assert.equal(f.store.count("codebase_index"), 0, "invalid graphs must not publish an index");
  } finally { await close(f); }
});

test("symbol search context rejects stale and invalid spans and stops at its extraction budget", async () => {
  const f = await fixture();
  try {
    active(f);
    const budgetPath = "src/search-budget.ts";
    const budgetContent = "a".repeat(2_100_000);
    const blankPath = "src/search-blank.ts";
    const blankContent = " ".repeat(32);
    const ownerPath = "src/simulation-service.ts";
    const ownerContent = "export class SimulationService {\n  run_task() { return 'queued'; }\n}\nexport function unrelatedTask() { return 'outside'; }\n";
    const decoyPath = "src/sql-task.ts";
    const decoyContent = "export function _execute_task() { return 'sql'; }\n";
    await writeFile(join(f.project, budgetPath), budgetContent);
    await writeFile(join(f.project, blankPath), blankContent);
    await writeFile(join(f.project, ownerPath), ownerContent);
    await writeFile(join(f.project, decoyPath), decoyContent);
    const checkpoint = f.service.workspaceCheckpoint({ workspace_id: f.workspace.id, checkpoint_id: "search_context_edges", label: "search context" }).checkpoint as JsonObject;
    const entries = new Map((checkpoint.entries as JsonObject[]).map(entry => [String(entry.path), entry]));
    const budgetEntry = entries.get(budgetPath)!;
    const blankEntry = entries.get(blankPath)!;
    const ownerEntry = entries.get(ownerPath)!;
    const decoyEntry = entries.get(decoyPath)!;
    const context = (f.kernel as unknown as { symbolSearchContext(index: JsonObject, symbols: readonly JsonObject[]): {
      identifiers: Map<string, string>; enclosingTypes: Map<string, string>;
    } }).symbolSearchContext;
    const index = { checkpoint_id: checkpoint.id };
    const symbolAt = (id: string, path: string, sourceDigest: string, start: number, end: number): JsonObject => ({
      id, kind: "symbol", declaration_kind: "function", name: id, path, source_digest: sourceDigest, declaration_span: { start_offset: start, end_offset: end },
    });

    assert.equal(context.call(f.kernel, index, [symbolAt("stale", budgetPath, "stale-digest", 0, 8)]).identifiers.size, 0);
    assert.equal(context.call(f.kernel, index, [symbolAt("invalid", budgetPath, String(budgetEntry.digest), -1, 8)]).identifiers.size, 0);
    assert.equal(context.call(f.kernel, index, [symbolAt("blank", blankPath, String(blankEntry.digest), 0, blankContent.length)]).identifiers.size, 0);
    const tied = context.call(f.kernel, index, [
      symbolAt("z", budgetPath, String(budgetEntry.digest), 0, 8),
      symbolAt("a", budgetPath, String(budgetEntry.digest), 0, 8),
    ]);
    assert.deepEqual([...tied.identifiers.keys()], ["a", "z"]);
    const bounded = context.call(f.kernel, index, Array.from({ length: 126 }, (_, number) =>
      symbolAt(`budget_${String(number).padStart(3, "0")}`, budgetPath, String(budgetEntry.digest), 0, budgetContent.length)));
    assert.equal(bounded.identifiers.size, 126);

    const classEnd = ownerContent.indexOf("\n}\n") + 2;
    const owner = { ...symbolAt("simulation-service", ownerPath, String(ownerEntry.digest), 0, classEnd),
      name: "SimulationService", declaration_kind: "class" };
    const targetStart = ownerContent.indexOf("run_task");
    const targetEnd = ownerContent.indexOf("}", targetStart) + 1;
    const target = { ...symbolAt("run-task", ownerPath, String(ownerEntry.digest), targetStart, targetEnd),
      name: "run_task", declaration_kind: "method" };
    const unrelatedStart = ownerContent.indexOf("unrelatedTask");
    const unrelatedEnd = ownerContent.indexOf("}", unrelatedStart) + 1;
    const unrelated = { ...symbolAt("unrelated-task", ownerPath, String(ownerEntry.digest), unrelatedStart, unrelatedEnd),
      name: "unrelatedTask", declaration_kind: "function" };
    const decoyStart = decoyContent.indexOf("_execute_task");
    const decoyEnd = decoyContent.indexOf("}", decoyStart) + 1;
    const decoy = { ...symbolAt("execute-task", decoyPath, String(decoyEntry.digest), decoyStart, decoyEnd),
      name: "_execute_task", declaration_kind: "function" };
    const enriched = context.call(f.kernel, index, [owner, target, unrelated, decoy]);
    assert.match(enriched.enclosingTypes.get("run-task") ?? "", /SimulationService/u);
    assert.doesNotMatch(enriched.enclosingTypes.get("unrelated-task") ?? "", /SimulationService/u);
    assert.doesNotMatch(enriched.enclosingTypes.get("execute-task") ?? "", /SimulationService/u);
    const ranked = new CodeSymbolSearchIndex([owner, target, decoy], enriched.identifiers, enriched.enclosingTypes)
      .rank("execute a queued simulation task", 3);
    assert.equal(ranked[0]!.node.id, "run-task");
  } finally { await close(f); }
});

test("symbol search context reserves extraction budget across checkpoint files", async () => {
  const f = await fixture();
  try {
    active(f);
    const earlyPaths = Array.from({ length: 126 }, (_, index) => `src/a${String(index).padStart(3, "0")}.ts`);
    const targetPath = "src/z-target.ts";
    const padding = "export function pad() {\n" + "  const paddingIdentifier = 0;\n".repeat(500) + "}\n";
    const target = "export function target() { return distinctiveRetrievalNeedle; }\n";
    const contents = new Map(earlyPaths.map(path => [path, padding])); contents.set(targetPath, target);
    for (const [path, content] of contents) await writeFile(join(f.project, path), content);
    await writeFile(join(f.project, targetPath), target);
    const checkpoint = f.service.workspaceCheckpoint({ workspace_id: f.workspace.id, checkpoint_id: "search_context_fairness", label: "search context fairness" }).checkpoint as JsonObject;
    const entries = new Map((checkpoint.entries as JsonObject[]).map(entry => [String(entry.path), entry]));
    const symbolAt = (id: string, path: string, name: string): JsonObject => ({
      id, kind: "symbol", declaration_kind: "function", name, path, source_digest: String(entries.get(path)!.digest),
      declaration_span: { start_offset: 0, end_offset: contents.get(path)!.length },
    });
    const symbols = earlyPaths.map((path, index) => symbolAt(`padding_${index}`, path, `pad${index}`));
    symbols.push(symbolAt("target", targetPath, "target"));
    const context = (f.kernel as unknown as { symbolSearchContext(index: JsonObject, symbols: readonly JsonObject[]): {
      identifiers: Map<string, string>; enclosingTypes: Map<string, string>;
    } }).symbolSearchContext;
    const extracted = context.call(f.kernel, { checkpoint_id: checkpoint.id }, symbols);
    assert.match(extracted.identifiers.get("target") ?? "", /distinctiveRetrievalNeedle/u);
  } finally { await close(f); }
});

test("control-flow queries enforce symbol kind, language and snapshot source freshness", async () => {
  const f = await fixture();
  try {
    active(f);
    const indexRecord = index(f);
    const target = symbol(f, String(indexRecord.id), "target");
    const graph = f.kernel.controlFlow({ workspace_id: f.workspace.id, index_id: indexRecord.id, node_id: target.id });
    assert.equal(graph.status, "complete");
    assert.equal((graph.receipt as JsonObject).kind, "control_flow_query");
    const pythonSnapshotEntry = (f.checkpoint.entries as JsonObject[]).find(entry => entry.path === "src/generated.py")!;
    const pythonContent = await readFile(join(String(f.checkpoint.snapshot_root), "src/generated.py"), "utf8");
    const pythonAnalysis = analyzePythonCheckpoint([{ path: "src/generated.py", content: pythonContent, digest: String(pythonSnapshotEntry.digest), language: "python" }]).analysis!;
    const pythonIndex = f.kernel.importAnalysis({ workspace_id: f.workspace.id, checkpoint_id: f.checkpoint.id,
      index_id: "python-control-flow-index", analysis: pythonAnalysis }).index as JsonObject;
    const python = graphNodes(f, pythonIndex).find(node => node.kind === "symbol" && node.language === "python" && node.name === "route")!;
    const pythonFlow = f.kernel.controlFlow({ workspace_id: f.workspace.id, index_id: pythonIndex.id, node_id: python.id });
    assert.equal(pythonFlow.status, "complete");
    assert.equal(pythonFlow.source_content_included, false);
    assert.equal(pythonFlow.source_digest, python.source_digest);
    assert((pythonFlow.blocks as JsonObject[]).some(block => block.kind === "condition"));
    assert.deepEqual(pythonFlow.partial_reasons, []);
    const flowServer = new McpServer(f.service, "full");
    const flowResponse = await flowServer.handle({ id: 12, method: "tools/call", params: { name: "craft_codebase_control_flow_query",
      arguments: { workspace_id: f.workspace.id, index_id: pythonIndex.id, node_id: python.id } } });
    const flowValue = (flowResponse!.result as JsonObject).structuredContent as JsonObject;
    assert.equal(flowValue.status, "complete");
    assert.equal(flowValue.source_content_included, false);
    const previousJavaPath = process.env.PATH;
    try {
      process.env.PATH = "";
      const unavailable = f.kernel.controlFlow({ workspace_id: f.workspace.id, index_id: pythonIndex.id, node_id: python.id });
      assert.equal(unavailable.status, "unavailable");
      assert.deepEqual(unavailable.partial_reasons, ["python_runtime_unavailable"]);
    } finally {
      if (previousJavaPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousJavaPath;
    }
    const fileNode = graphNodes(f, indexRecord).find(node => node.kind === "file")!;
    assert.throws(() => f.kernel.controlFlow({ workspace_id: f.workspace.id, index_id: indexRecord.id, node_id: fileNode.id }), /requires an indexed symbol/u);
    const variable = graphNodes(f, indexRecord).find(node => node.kind === "symbol" && node.name === "shared" && node.path === "src/target.ts")!;
    assert.throws(() => f.kernel.controlFlow({ workspace_id: f.workspace.id, index_id: indexRecord.id, node_id: variable.id }), /requires an indexed function/u);

    const pythonEntry = (f.checkpoint.entries as JsonObject[]).find(entry => entry.path === "src/generated.py")!;
    const imported = f.kernel.importAnalysis({ workspace_id: f.workspace.id, checkpoint_id: f.checkpoint.id,
      analysis: { format: "craft-static-analysis-v1", analyzer: "fixture-cpp", analyzer_version: "1", edges: [],
        nodes: [{ id: "cpp_symbol", kind: "symbol", path: "src/generated.py", name: "run", source_digest: pythonEntry.digest,
          span: { start_offset: 0, end_offset: 3 }, language: "cpp" }] } });
    const importedIndex = imported.index as JsonObject;
    assert.throws(() => f.kernel.controlFlow({ workspace_id: f.workspace.id, index_id: importedIndex.id, node_id: "cpp_symbol" }), /supports TypeScript, JavaScript, Python and Java/u);

    const originalIndex = f.store.get("codebase_index", String(indexRecord.id));
    const inlineNodes = graphNodes(f, indexRecord).map(node => node.id === target.id ? { ...node, source_digest: "tampered" } : node);
    f.store.save("codebase_index", String(indexRecord.id), { ...originalIndex, nodes: inlineNodes, edges: graphEdges(f, indexRecord) });
    assert.throws(() => f.kernel.controlFlow({ workspace_id: f.workspace.id, index_id: indexRecord.id, node_id: target.id }), /does not match the index/u);
    f.store.save("codebase_index", String(indexRecord.id), originalIndex);

    const originalCheckpoint = f.store.get("workspace_checkpoint", String(f.checkpoint.id));
    f.store.save("workspace_checkpoint", String(f.checkpoint.id), { ...originalCheckpoint,
      entries: (originalCheckpoint.entries as JsonObject[]).filter(entry => entry.path !== target.path) });
    assert.throws(() => f.kernel.controlFlow({ workspace_id: f.workspace.id, index_id: indexRecord.id, node_id: target.id }), /outside the checkpoint/u);
    f.store.save("workspace_checkpoint", String(f.checkpoint.id), originalCheckpoint);

    await writeFile(join(String(f.checkpoint.snapshot_root), "src/target.ts"), "export function target() { return 2; }\n");
    assert.throws(() => f.kernel.controlFlow({ workspace_id: f.workspace.id, index_id: indexRecord.id, node_id: target.id }), /changed since checkpoint/u);

    const javaContent = "class Flow { void route(boolean flag, int count) { if (flag) { count++; } else { count--; } for (; count > 0; count--) { if (count == 2) continue; } return; } }\n";
    await writeFile(join(f.project, "src", "Flow.java"), javaContent);
    const javaCheckpoint = f.service.workspaceCheckpoint({ workspace_id: f.workspace.id, checkpoint_id: "java-flow-checkpoint", label: "java flow" }).checkpoint as JsonObject;
    const javaEntry = (javaCheckpoint.entries as JsonObject[]).find(entry => entry.path === "src/Flow.java")!;
    const javaAnalysis = analyzeJavaCheckpoint([{ path: "src/Flow.java", content: javaContent, digest: String(javaEntry.digest), language: "java" }]).analysis!;
    const javaIndex = f.kernel.importAnalysis({ workspace_id: f.workspace.id, checkpoint_id: javaCheckpoint.id,
      index_id: "java-control-flow-index", analysis: javaAnalysis }).index as JsonObject;
    const javaRoute = graphNodes(f, javaIndex).find(node => node.kind === "symbol" && node.language === "java" && node.name === "route")!;
    const javaFlow = f.kernel.controlFlow({ workspace_id: f.workspace.id, index_id: javaIndex.id, node_id: javaRoute.id });
    assert.equal(javaFlow.status, "complete");
    assert.equal(javaFlow.source_content_included, false);
    assert.equal(javaFlow.source_digest, javaRoute.source_digest);
    assert((javaFlow.blocks as JsonObject[]).some(block => block.kind === "condition"));
    assert((javaFlow.edges as JsonObject[]).some(edge => edge.loop_back === true));
    const javaFlowResponse = await flowServer.handle({ id: 13, method: "tools/call", params: { name: "craft_codebase_control_flow_query",
      arguments: { workspace_id: f.workspace.id, index_id: javaIndex.id, node_id: javaRoute.id } } });
    const javaFlowValue = (javaFlowResponse!.result as JsonObject).structuredContent as JsonObject;
    assert.equal(javaFlowValue.status, "complete");
    assert.equal((javaFlowValue.receipt as JsonObject).kind, "control_flow_query");
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = "/craft-test/no-jdk-runtime";
      const unavailable = f.kernel.controlFlow({ workspace_id: f.workspace.id, index_id: javaIndex.id, node_id: javaRoute.id });
      assert.equal(unavailable.status, "unavailable");
      assert((unavailable.partial_reasons as string[]).includes("jdk_unavailable"));
      assert.equal(unavailable.source_content_included, false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  } finally { await close(f); }
});

test("Agent data-flow query is checkpoint-pinned, source-free and available over MCP", async () => {
  const f = await fixture();
  try {
    active(f);
    const indexRecord = index(f);
    const processInput = symbol(f, String(indexRecord.id), "processInput");
    const result = f.kernel.dataFlow({ workspace_id: f.workspace.id, index_id: indexRecord.id, node_id: processInput.id, variable: "value" });
    assert.equal(result.status, "complete");
    assert.equal(result.source_content_included, false);
    assert.equal((result.receipt as JsonObject).kind, "data_flow_query");
    assert.equal((result.flows as JsonObject[]).length, 2);
    const fileNode = graphNodes(f, indexRecord).find(node => node.kind === "file")!;
    assert.throws(() => f.kernel.dataFlow({ workspace_id: f.workspace.id, index_id: indexRecord.id, node_id: fileNode.id, variable: "value" }), /requires an indexed symbol/u);
    const pythonEntry = (f.checkpoint.entries as JsonObject[]).find(entry => entry.path === "src/generated.py")!;
    const imported = f.kernel.importAnalysis({ workspace_id: f.workspace.id, checkpoint_id: f.checkpoint.id,
      analysis: { format: "craft-static-analysis-v1", analyzer: "fixture-cpp", analyzer_version: "1", edges: [],
        nodes: [{ id: "cpp_data_flow_symbol", kind: "symbol", path: "src/generated.py", name: "run", source_digest: pythonEntry.digest,
          language: "cpp", span: { start_offset: 0, end_offset: 3 } }] } });
    assert.throws(() => f.kernel.dataFlow({ workspace_id: f.workspace.id, index_id: (imported.index as JsonObject).id,
      node_id: "cpp_data_flow_symbol", variable: "value" }), /supports TypeScript, JavaScript and Python/u);
    const originalCheckpoint = f.store.get("workspace_checkpoint", String(f.checkpoint.id));
    f.store.save("workspace_checkpoint", String(f.checkpoint.id), { ...originalCheckpoint,
      entries: (originalCheckpoint.entries as JsonObject[]).filter(entry => entry.path !== processInput.path) });
    assert.throws(() => f.kernel.dataFlow({ workspace_id: f.workspace.id, index_id: indexRecord.id, node_id: processInput.id, variable: "value" }), /outside the checkpoint/u);
    f.store.save("workspace_checkpoint", String(f.checkpoint.id), originalCheckpoint);
    const originalIndex = f.store.get("codebase_index", String(indexRecord.id));
    const tamperedNodes = graphNodes(f, indexRecord).map(node => node.id === processInput.id ? { ...node, source_digest: "tampered" } : node);
    f.store.save("codebase_index", String(indexRecord.id), { ...originalIndex, nodes: tamperedNodes, edges: graphEdges(f, indexRecord) });
    assert.throws(() => f.kernel.dataFlow({ workspace_id: f.workspace.id, index_id: indexRecord.id, node_id: processInput.id, variable: "value" }), /does not match the index/u);
    f.store.save("codebase_index", String(indexRecord.id), originalIndex);
    assert(surfaceToolNames("codebase").includes("craft_codebase_data_flow_query"));
    const server = new McpServer(f.service, "full");
    const response = await server.handle({ id: 1, method: "tools/call", params: { name: "craft_codebase_data_flow_query",
      arguments: { workspace_id: f.workspace.id, index_id: indexRecord.id, node_id: processInput.id, variable: "value" } } });
    const value = (response!.result as JsonObject).structuredContent as JsonObject;
    assert.equal(value.status, "complete");
    assert.equal(value.source_content_included, false);
    assert.throws(() => f.service.codebaseDataFlowQuery({ workspace_id: f.workspace.id, index_id: indexRecord.id, node_id: processInput.id }), /variable must not be empty/u);

    const pythonSourceEntry = (f.checkpoint.entries as JsonObject[]).find(entry => entry.path === "src/generated.py")!;
    const pythonContent = await readFile(join(String(f.checkpoint.snapshot_root), "src/generated.py"), "utf8");
    const pythonAnalysis = analyzePythonCheckpoint([{ path: "src/generated.py", content: pythonContent,
      digest: String(pythonSourceEntry.digest), language: "python" }]).analysis!;
    const pythonIndex = f.kernel.importAnalysis({ workspace_id: f.workspace.id, checkpoint_id: f.checkpoint.id,
      index_id: "python-data-flow-index", analysis: pythonAnalysis }).index as JsonObject;
    const route = graphNodes(f, pythonIndex).find(node => node.kind === "symbol" && node.language === "python" && node.name === "route")!;
    const pythonFlow = f.kernel.dataFlow({ workspace_id: f.workspace.id, index_id: pythonIndex.id, node_id: route.id, variable: "value" });
    assert.equal(pythonFlow.status, "complete");
    assert.equal(pythonFlow.source_content_included, false);
    assert.equal((pythonFlow.flows as JsonObject[]).length, 2);
    const pythonResponse = await server.handle({ id: 2, method: "tools/call", params: { name: "craft_codebase_data_flow_query",
      arguments: { workspace_id: f.workspace.id, index_id: pythonIndex.id, node_id: route.id, variable: "value" } } });
    const pythonValue = (pythonResponse!.result as JsonObject).structuredContent as JsonObject;
    assert.equal(pythonValue.status, "complete");
    assert.equal(pythonValue.source_content_included, false);

    const previousPath = process.env.PATH;
    try {
      process.env.PATH = "/craft-test/no-python-runtime";
      for (const result of [
        f.kernel.controlFlow({ workspace_id: f.workspace.id, index_id: pythonIndex.id, node_id: route.id }),
        f.kernel.dataFlow({ workspace_id: f.workspace.id, index_id: pythonIndex.id, node_id: route.id, variable: "value" }),
      ]) {
        assert.equal(result.status, "unavailable");
        assert((result.partial_reasons as string[]).includes("python_runtime_unavailable"));
        assert.equal(result.source_content_included, false);
      }
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  } finally { await close(f); }
});

test("impact mutation oracle tracks a changed call edge and excludes stale direct callers", async () => {
  const f = await fixture();
  try {
    active(f);
    const initial = index(f);
    const initialTarget = symbol(f, String(initial.id), "target");
    const initialImpact = f.kernel.impact({ workspace_id: f.workspace.id, index_id: initial.id, node_id: initialTarget.id,
      direction: "incoming", relation_kind: "calls", max_depth: 1, limit: 100 });
    const initialNames = (initialImpact.nodes as JsonObject[]).map(node => node.name);
    assert(initialNames.includes("caller"), "oracle precondition: indexed call edge must reach the original caller");
    assert(initialNames.includes("targetHelper"), "oracle precondition: another direct caller remains in the fixture");

    await writeFile(join(f.project, "src", "caller.ts"), "import { targetHelper } from './target';\nexport function caller() { return targetHelper(); }\n");
    const updatedCheckpoint = f.service.workspaceCheckpoint({ workspace_id: f.workspace.id, checkpoint_id: "mutation", label: "mutated call site" }).checkpoint as JsonObject;
    const updated = f.kernel.build({ workspace_id: f.workspace.id, checkpoint_id: updatedCheckpoint.id }).index as JsonObject;
    assert.notEqual(updated.id, initial.id, "the changed snapshot must not reuse the prior index identity");
    const updatedTarget = symbol(f, String(updated.id), "target");
    const updatedImpact = f.kernel.impact({ workspace_id: f.workspace.id, index_id: updated.id, node_id: updatedTarget.id,
      direction: "incoming", relation_kind: "calls", max_depth: 1, limit: 100 });
    const updatedNames = (updatedImpact.nodes as JsonObject[]).map(node => node.name);
    assert(!updatedNames.includes("caller"), "mutated direct call must disappear from the target's immediate impact set");
    assert(updatedNames.includes("targetHelper"), "unmodified direct call must remain in the target's impact set");
    assert.equal(updatedImpact.relation_kind, "calls");
    assert.notEqual((updatedImpact.receipt as JsonObject).index_revision_digest, (initialImpact.receipt as JsonObject).index_revision_digest,
      "the mutation result must be tied to the new index snapshot");
  } finally { await close(f); }
});

test("impact query follows a bounded multi-hop call chain from a changed symbol", async () => {
  const f = await fixture();
  try {
    active(f);
    await writeFile(join(f.project, "src", "upstream.ts"), "import { caller } from './caller';\nexport function upstream() { return caller(); }\n");
    const checkpoint = f.service.workspaceCheckpoint({ workspace_id: f.workspace.id, checkpoint_id: "impact-depth-two", label: "impact depth two" }).checkpoint as JsonObject;
    const built = f.kernel.build({ workspace_id: f.workspace.id, checkpoint_id: checkpoint.id }).index as JsonObject;
    const target = symbol(f, String(built.id), "target");
    const impact = f.kernel.impact({ workspace_id: f.workspace.id, index_id: built.id, node_id: target.id,
      direction: "incoming", relation_kind: "calls", max_depth: 2, limit: 100 });
    const impacted = (impact.nodes as JsonObject[]).map(node => `${node.path}:${node.name}`);
    assert(impacted.includes("src/caller.ts:caller"), "depth one should include a direct caller");
    assert(impacted.includes("src/upstream.ts:upstream"), "depth two should include a caller of that direct caller");
    assert((impact.edges as JsonObject[]).every(edge => edge.kind === "calls"));
    assert.equal(impact.max_depth, 2);
    assert.equal(impact.truncated, false);
  } finally { await close(f); }
});

test("diagnostics MCP queries a trusted checkpoint and persists no diagnostic text", async () => {
  const f = await fixture();
  try {
    const full = new McpServer(f.service, "full");
    active(f);
    const built = index(f);
    await mkdir(f.store.paths.configDir, { recursive: true });
    const adapter = (language: string, max_documents = 100) => ({ language, command: process.execPath,
      args: [lspFixturePath, "diagnostics-push"], analyzer_version: "fixture-1", relations: [], max_documents, request_timeout_ms: 1000 });
    await writeFile(join(f.store.paths.configDir, "codebase-lsp.json"), JSON.stringify({ schema_version: 1, adapters: [adapter("typescript"), adapter("python")] }));
    const tool = full.tools.find(candidate => candidate.name === "craft_codebase_diagnostics_find");
    assert.equal(tool?.annotations?.readOnlyHint, true);
    const result = await full.handlers.craft_codebase_diagnostics_find({ workspace_id: f.workspace.id, index_id: built.id, path: "src/target.ts" });
    assert.equal(result.diagnostic_status, "complete");
    assert.equal((result.diagnostics as JsonObject[])[0]?.message, "sample diagnostic");
    assert.equal(result.content_included, false);
    const receipt = result.receipt as JsonObject;
    const stored = f.store.get("codebase_query_receipt", String(receipt.id));
    assert.equal(stored.content_free, true);
    assert.equal(JSON.stringify(stored).includes("sample diagnostic"), false);
    const pythonResult = await full.handlers.craft_codebase_diagnostics_find({ workspace_id: f.workspace.id, index_id: built.id, path: "src/generated.py" });
    assert.equal(pythonResult.diagnostic_status, "complete");
    assert.equal((pythonResult.diagnostics as JsonObject[])[0]?.message, "sample diagnostic");
    await assert.rejects(async () => full.handlers.craft_codebase_diagnostics_find({ workspace_id: f.workspace.id, index_id: built.id, path: "../outside.ts" }), /outside the checkpoint/u);
    await assert.rejects(async () => full.handlers.craft_codebase_diagnostics_find({ workspace_id: f.workspace.id, index_id: built.id, path: "src/view.tsx" }), /No explicitly trusted language-server adapter/u);
    await assert.rejects(async () => full.handlers.craft_codebase_diagnostics_find({ workspace_id: f.workspace.id, index_id: built.id, path: "src/README.md" }), /No language-server mapping/u);
    await assert.rejects(async () => full.handlers.craft_codebase_diagnostics_find({ workspace_id: f.workspace.id, index_id: built.id, path: "src/target.ts", limit: 501 }), /between 1 and 500/u);

    await writeFile(join(f.store.paths.configDir, "codebase-lsp.json"), JSON.stringify({ schema_version: 1, adapters: [adapter("typescript", 1), adapter("python")] }));
    const limited = await full.handlers.craft_codebase_diagnostics_find({ workspace_id: f.workspace.id, index_id: built.id, path: "src/target.ts" });
    assert.equal(limited.diagnostic_status, "partial");
    assert(Number(limited.omitted_count) > 0);

    const delayedConfig = (mode: string) => JSON.stringify({ schema_version: 1, adapters: [{ language: "typescript", command: process.execPath,
      args: [lspFixturePath, mode], analyzer_version: "fixture-1", relations: [], max_documents: 100, request_timeout_ms: 1000 }] });
    await writeFile(join(f.store.paths.configDir, "codebase-lsp.json"), delayedConfig("diagnostics-push-delayed"));
    const configRace = (async () => await full.handlers.craft_codebase_diagnostics_find({ workspace_id: f.workspace.id, index_id: built.id, path: "src/target.ts" }))();
    await new Promise(resolve => setTimeout(resolve, 2));
    await writeFile(join(f.store.paths.configDir, "codebase-lsp.json"), delayedConfig("diagnostics-push"));
    await assert.rejects(configRace, /configuration changed during diagnostics query/u);

    await writeFile(join(f.store.paths.configDir, "codebase-lsp.json"), delayedConfig("diagnostics-push-delayed"));
    const activationRace = (async () => await full.handlers.craft_codebase_diagnostics_find({ workspace_id: f.workspace.id, index_id: built.id, path: "src/target.ts" }))();
    await new Promise(resolve => setTimeout(resolve, 2));
    f.kernel.deactivate({ workspace_id: f.workspace.id, actor: "diagnostic-race" });
    await assert.rejects(activationRace, /not explicitly active/u);
  } finally { await close(f); }
});

test("diagnostics helper rejects malformed checkpoint membership and unsafe injected snapshot paths", async () => {
  const f = await fixture();
  try {
    const readSource = (_root: string, entry: JsonObject) => ({ path: String(entry.path), digest: String(entry.digest), content: "class Safe {}\n", language: "ts" });
    await assert.rejects(queryCheckpointDiagnostics({ store: f.store, checkpoint: { ...f.checkpoint, entries: "malformed" },
      path: "src/target.ts", limit: 1, readSource }), /outside the checkpoint/u);
    await mkdir(f.store.paths.configDir, { recursive: true });
    await writeFile(join(f.store.paths.configDir, "codebase-lsp.json"), JSON.stringify({ schema_version: 1, adapters: [{ language: "typescript",
      command: process.execPath, args: [lspFixturePath, "diagnostics-push"], analyzer_version: "fixture-1", relations: [], max_documents: 10, request_timeout_ms: 1000 }] }));
    await assert.rejects(queryCheckpointDiagnostics({ store: f.store, checkpoint: f.checkpoint, path: "src/target.ts", limit: 1,
      readSource: (_root, entry) => ({ path: "..", digest: String(entry.digest), content: "", language: "ts" }) }), /snapshot path is unsafe/u);
  } finally { await close(f); }
});

test("symbol-search cache reuses a verified corpus and invalidates on any shard payload change", async () => {
  const f = await fixture();
  try {
    active(f); const built = index(f);
    const first = f.kernel.findSymbol({ workspace_id: f.workspace.id, index_id: built.id, query: "target" });
    const second = f.kernel.findSymbol({ workspace_id: f.workspace.id, index_id: built.id, query: "targetHelper" });
    assert.equal((first.symbols as JsonObject[])[0]!.name, "target");
    assert.equal((second.symbols as JsonObject[])[0]!.name, "targetHelper");
    for (const id of ["search-cache-a", "search-cache-b"]) {
      const extra = f.kernel.build({ workspace_id: f.workspace.id, checkpoint_id: f.checkpoint.id, index_id: id }).index as JsonObject;
      assert.equal((f.kernel.findSymbol({ workspace_id: f.workspace.id, index_id: extra.id, query: "target" }).symbols as JsonObject[])[0]!.name, "target");
    }
    assert.equal((f.kernel.findSymbol({ workspace_id: f.workspace.id, index_id: built.id, query: "target" }).symbols as JsonObject[])[0]!.name, "target");
    const shardId = (built.node_shard_ids as string[])[0]!;
    const shard = f.store.get("codebase_index_shard", shardId);
    f.store.replacePayload("codebase_index_shard", shardId, Number(shard.version), { ...shard, nodes: [{ ...(shard.nodes as JsonObject[])[0], name: "tampered" }] });
    assert.throws(() => f.kernel.findSymbol({ workspace_id: f.workspace.id, index_id: built.id, query: "target" }), /integrity failure/);
  } finally { await close(f); }
});

test("impact result cache pins every route and shard digest and is bounded", async () => {
  const f = await fixture();
  try {
    active(f); const built = index(f); const target = symbol(f, String(built.id));
    const query = { workspace_id: f.workspace.id, index_id: built.id, node_id: target.id, max_depth: 2, limit: 40 };
    const first = f.kernel.impact(query);
    const second = f.kernel.impact(query);
    assert.deepEqual(second.nodes, first.nodes); assert.deepEqual(second.edges, first.edges);
    (first.nodes as JsonObject[])[0]!.name = "caller-mutated-result";
    assert.notEqual((f.kernel.impact(query).nodes as JsonObject[])[0]!.name, "caller-mutated-result");
    for (let limit = 1; limit <= 9; limit++) f.kernel.impact({ ...query, limit });
    assert.deepEqual(f.kernel.impact(query).edges, second.edges);
    const bucket = stableDigest(target.id).slice(-2);
    const descriptor = (built.edge_route_shards as JsonObject[]).find(route => route.bucket === bucket)!;
    const route = f.store.get("codebase_index_edge_route", String(descriptor.id));
    f.store.save("codebase_index_edge_route", String(route.id), { ...route, incoming: {}, route_digest: "tampered" });
    assert.throws(() => f.kernel.impact(query), /route integrity/);
  } finally { await close(f); }
});

test("content-addressed graph records are reused only after their stored payloads verify", async () => {
  const f = await fixture();
  try {
    active(f);
    const first = index(f);
    const firstShardId = (first.shard_ids as string[]).find(id =>
      (f.store.get("codebase_index_shard", id).nodes as JsonObject[]).some(node => node.path === "src/caller.ts"))!;
    const firstShard = f.store.get("codebase_index_shard", firstShardId);
    f.store.save("codebase_index_shard", firstShardId, { ...firstShard, nodes: [{ ...(firstShard.nodes as JsonObject[])[0], name: "tampered" }] });
    await writeFile(join(f.project, "src", "target.ts"), "export function target() { return 2; }\n");
    const changed = f.service.workspaceCheckpoint({ workspace_id: f.workspace.id, checkpoint_id: "changed", label: "changed" }).checkpoint as JsonObject;
    assert.throws(() => f.kernel.build({ workspace_id: f.workspace.id, checkpoint_id: changed.id }), /content shard integrity/u);
  } finally { await close(f); }
});

test("content-addressed route records are checked before reuse", async () => {
  const f = await fixture();
  try {
    active(f);
    const first = index(f);
    const descriptor = (first.edge_route_shards as JsonObject[])[0]!;
    const route = f.store.get("codebase_index_edge_route", String(descriptor.id));
    f.store.save("codebase_index_edge_route", String(route.id), { ...route, incoming: {}, route_digest: "tampered" });
    await writeFile(join(f.project, "src", "README.md"), "changed non-source snapshot file\n");
    const changed = f.service.workspaceCheckpoint({ workspace_id: f.workspace.id, checkpoint_id: "changed", label: "changed" }).checkpoint as JsonObject;
    assert.throws(() => f.kernel.build({ workspace_id: f.workspace.id, checkpoint_id: changed.id }), /content route integrity/u);
  } finally { await close(f); }
});

test("codebase status returns bounded index metadata without legacy graph payloads", async () => {
  const f = await fixture();
  try {
    active(f);
    const built = index(f);
    const stored = f.store.get("codebase_index", String(built.id));
    for (let ordinal = 0; ordinal < 26; ordinal++) f.store.create("codebase_index", `history_${ordinal}`, {
      workspace_id: f.workspace.id, checkpoint_id: f.checkpoint.id, status: "ready", analyzer: "typescript-checker", analyzer_version: "test",
      created_at: new Date(Date.UTC(2000, 0, ordinal + 1)).toISOString(), node_count: 3, edge_count: 1, graph_storage: "sharded-v4",
      graph_digest: `history_digest_${ordinal}`, relation_analysis: { status: "analyzed" },
    });
    f.store.save("codebase_index", String(built.id), { ...stored,
      nodes: Array.from({ length: 2_000 }, (_, ordinal) => ({ id: `legacy_node_${ordinal}`, body: "x".repeat(1_000) })),
      edges: Array.from({ length: 2_000 }, (_, ordinal) => ({ id: `legacy_edge_${ordinal}`, body: "x".repeat(1_000) })),
      analysis: { allowed_paths: Array.from({ length: 2_000 }, (_, ordinal) => `src/${ordinal}.ts`) } });
    const status = f.kernel.status({ workspace_id: f.workspace.id });
    const statuses = status.indexes as JsonObject[];
    assert.equal(statuses.length, 25);
    const current = statuses.find(item => item.id === built.id)!;
    assert.equal(current.graph_digest, built.graph_digest);
    assert.equal(status.omitted_index_count, 2);
    assert.equal("nodes" in current, false);
    assert.equal("edges" in current, false);
    assert.equal("analysis" in current, false);
    assert(JSON.stringify(status).length < 10_000);
    const full = new McpServer(f.service, "full");
    const hostStatus = await full.handlers.craft_codebase_status({ workspace_id: f.workspace.id });
    assert.equal((hostStatus.indexes as JsonObject[]).length, 25);
    assert.equal((hostStatus.indexes as JsonObject[]).some(item => item.id === built.id), true);
    assert(JSON.stringify(hostStatus).length < 12_000);
  } finally { await close(f); }
});

test("craft-codebase rejects stale, inactive, unsafe, malformed, and ambiguous inputs without fallback", async () => {
  const f = await fixture();
  try {
    active(f); const built = index(f); const target = symbol(f, String(built.id));
    assert.throws(() => f.kernel.findSymbol({ workspace_id: f.workspace.id, index_id: built.id, query: " " }), /must not be empty/);
    assert.throws(() => f.kernel.findCallers({ workspace_id: f.workspace.id, index_id: built.id, node_id: graphNodes(f, built).find((node) => node.kind === "file")!.id }), /requires a symbol/);
    assert((f.kernel.findCallers({ workspace_id: f.workspace.id, index_id: built.id, node_id: target.id }).callers as JsonObject[]).length > 0);
    assert.throws(() => f.kernel.contextSlice({ workspace_id: f.workspace.id, index_id: built.id, node_ids: [] }), /must contain unique/);
    assert.throws(() => f.kernel.contextSlice({ workspace_id: f.workspace.id, index_id: built.id }), /must contain unique/);
    assert.throws(() => f.kernel.contextSlice({ workspace_id: f.workspace.id, index_id: built.id, node_ids: [target.id, target.id] }), /must contain unique/);
    assert.throws(() => f.kernel.impact({ workspace_id: f.workspace.id, index_id: built.id, node_id: target.id, max_depth: 6 }), /between/);
    assert.throws(() => f.kernel.impact({ workspace_id: f.workspace.id, index_id: built.id, node_id: target.id, direction: "invalid" }), /direction must be/u);
    assert.throws(() => f.kernel.impact({ workspace_id: f.workspace.id, index_id: built.id, node_id: "missing" }), /not in index/);
    await writeFile(join(f.project, "src", "target.ts"), "export function target() { return 2; }\n");
    const next = f.service.workspaceCheckpoint({ workspace_id: f.workspace.id, checkpoint_id: "next", label: "next" }).checkpoint as JsonObject;
    const stale = f.kernel.status({ workspace_id: f.workspace.id }); assert.equal(stale.readiness, "rebuild_required"); assert.equal(((stale.indexes as JsonObject[])[0].status), "stale");
    assert.throws(() => f.kernel.findSymbol({ workspace_id: f.workspace.id, index_id: built.id, query: "target" }), /stale/);
    assert.equal(f.kernel.deactivate({ workspace_id: f.workspace.id, actor: "tester" }).idempotent, false); assert.equal(f.kernel.status({ workspace_id: f.workspace.id }).readiness, "disabled");
    assert.equal(f.kernel.deactivate({ workspace_id: f.workspace.id, actor: "tester" }).idempotent, true);
    assert.throws(() => f.kernel.build({ workspace_id: f.workspace.id, checkpoint_id: "next" }), /not explicitly active/);
    assert.equal(f.kernel.activate({ workspace_id: f.workspace.id, actor: "tester" }).idempotent, false);
    const rebuilt = f.kernel.build({ workspace_id: f.workspace.id, checkpoint_id: next.id }).index as JsonObject;
    assert.equal(rebuilt.status, "ready"); assert.equal((f.store.get("codebase_index", String(built.id))).status, "stale"); assert.equal((f.kernel.status({ workspace_id: f.workspace.id }).indexes as JsonObject[]).length, 2);
    assert.throws(() => f.kernel.build({ workspace_id: f.workspace.id, checkpoint_id: next.id, index_id: built.id }), /idempotency/);
    assert.throws(() => f.kernel.activate({ workspace_id: f.workspace.id, actor: "other" }), /idempotency/);
  } finally { await close(f); }
});

test("craft-codebase checks checkpoint bytes and never follows a snapshot symlink", async () => {
  const f = await fixture();
  try {
    active(f); const snapshotFile = join(String(f.checkpoint.snapshot_root), "src", "target.ts");
    await writeFile(snapshotFile, "tampered"); assert.throws(() => f.kernel.build({ workspace_id: f.workspace.id, checkpoint_id: f.checkpoint.id }), /changed since checkpoint/);
    await writeFile(snapshotFile, "export function target() { return 1; }\nexport function targetHelper() { return target(); }\nexport const shared = 1;\n");
    await unlink(snapshotFile); await symlink(join(f.project, "src", "target.ts"), snapshotFile);
    assert.throws(() => f.kernel.build({ workspace_id: f.workspace.id, checkpoint_id: f.checkpoint.id }), /regular files only/);
  } finally { await close(f); }
});

test("craft-codebase rejects malformed checkpoint ownership and unsafe source paths", async () => {
  const f = await fixture();
  try {
    active(f);
    f.store.create("workspace_checkpoint", "foreign", { workspace_id: "other", snapshot_root: f.checkpoint.snapshot_root, entries: [] });
    assert.throws(() => f.kernel.build({ workspace_id: f.workspace.id, checkpoint_id: "foreign" }), /does not belong/);
    f.store.create("workspace_checkpoint", "unsafe", { workspace_id: f.workspace.id, snapshot_root: f.checkpoint.snapshot_root, entries: [{ path: "../outside.ts", digest: "x", size_bytes: 1 }] });
    assert.throws(() => f.kernel.build({ workspace_id: f.workspace.id, checkpoint_id: "unsafe" }), /unsafe/);
    f.store.create("workspace_checkpoint", "empty", { workspace_id: f.workspace.id, snapshot_root: f.checkpoint.snapshot_root, entries: "not-an-array" });
    assert.equal((f.kernel.build({ workspace_id: f.workspace.id, checkpoint_id: "empty" }).index as JsonObject).source_file_count, 0);
  } finally { await close(f); }
});

test("craft-codebase is reachable only from full MCP and does not widen published component surfaces", async () => {
  const f = await fixture();
  try {
    const full = new McpServer(f.service, "full"); const knowledge = new McpServer(f.service, "component-knowledge");
    assert(full.tools.some((tool) => tool.name === "craft_codebase_status")); assert.equal(knowledge.tools.some((tool) => tool.name === "craft_codebase_status"), false);
    assert.equal(surfaceToolNames("codebase").includes("craft_codebase_symbol_find"), true);
    assert.equal(surfaceToolNames("codebase").includes("craft_codebase_symbols_overview"), true);
    assert.equal(surfaceToolNames("codebase").includes("craft_codebase_control_flow_query"), true);
    assert.equal(surfaceToolNames("codebase").includes("craft_codebase_data_flow_query"), true);
    assert.equal(surfaceToolNames("codebase").includes("craft_codebase_symbol_explore"), true);
    assert.equal(surfaceToolNames("codebase").includes("craft_codebase_symbol_read"), true);
    assert.equal(surfaceToolNames("codebase").includes("craft_codebase_diagnostics_find"), true);
    const impactTool = full.tools.find(tool => tool.name === "craft_codebase_impact_query")!;
    assert.equal(((impactTool.inputSchema.properties as JsonObject).relation_kind as JsonObject).type, "string");
    const activated = await full.handlers.craft_codebase_activate({ workspace_id: f.workspace.id, actor: "mcp" }); assert.equal((activated.activation as JsonObject).status, "active");
    assert.equal((await full.handlers.craft_codebase_status({ workspace_id: f.workspace.id })).readiness, "index_required");
    const built = await full.handlers.craft_codebase_index_build({ workspace_id: f.workspace.id, checkpoint_id: f.checkpoint.id }); assert.equal((built.index as JsonObject).status, "ready");
    assert(full.tools.some(tool => tool.name === "craft_codebase_symbols_overview"));
    const controlFlowTool = full.tools.find(tool => tool.name === "craft_codebase_control_flow_query")!;
    assert.equal(controlFlowTool.annotations?.readOnlyHint, true);
    assert.equal(full.tools.find(tool => tool.name === "craft_codebase_diagnostics_find")?.annotations?.readOnlyHint, true);
    const target = ((await full.handlers.craft_codebase_symbol_find({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, query: "target" })).symbols as JsonObject[])[0]!;
    const readTool = full.tools.find(tool => tool.name === "craft_codebase_symbol_read")!;
    assert.equal(readTool.annotations?.readOnlyHint, true);
    assert.equal(((readTool.inputSchema.properties as JsonObject).max_bytes as JsonObject).type, "integer");
    assert.equal(((readTool.inputSchema.properties as JsonObject).continuation as JsonObject).type, "string");
    const read = await full.handlers.craft_codebase_symbol_read({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, node_id: target.id });
    assert.equal(read.source, "export function target() { return 1; }");
    assert.equal(read.source_digest, target.source_digest);
    assert.equal(read.truncated, false);
    assert.equal(read.read_mode, "declaration");
    assert.equal(read.source_is_untrusted_evidence, true);
    const late = ((await full.handlers.craft_codebase_symbol_find({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, query: "shared" })).symbols as JsonObject[])
      .find(node => node.path === "src/target.ts")!;
    const lateRead = await full.handlers.craft_codebase_symbol_read({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, node_id: late.id });
    assert.equal(lateRead.start_line, 3);
    assert.equal(lateRead.read_mode, "declaration");
    const sourceWindowIndex = await full.handlers.craft_codebase_analysis_import({ workspace_id: f.workspace.id, checkpoint_id: f.checkpoint.id,
      analysis: { format: "craft-static-analysis-v1", analyzer: "source-window-fixture", analyzer_version: "1", nodes: [
        { id: "source_window_symbol", kind: "symbol", path: target.path, name: target.name, source_digest: target.source_digest, language: target.language, span: target.span }], edges: [] } });
    const sourceWindowIndexId = String((sourceWindowIndex.index as JsonObject).id);
    const lineLimited = await full.handlers.craft_codebase_symbol_read({ workspace_id: f.workspace.id, index_id: sourceWindowIndexId, node_id: "source_window_symbol", max_lines: 1 });
    assert.equal(lineLimited.truncated, true);
    assert.equal(typeof lineLimited.continuation, "string");
    const lineContinuation = await full.handlers.craft_codebase_symbol_read({ workspace_id: f.workspace.id, index_id: sourceWindowIndexId,
      node_id: "source_window_symbol", continuation: lineLimited.continuation });
    assert.equal(lineContinuation.start_line, 2);
    assert.equal(String(lineContinuation.source).includes("targetHelper"), true);
    const continuationFor = (next_offset: unknown, node_id = "source_window_symbol", index_id = sourceWindowIndexId) => Buffer.from(JSON.stringify({
      version: 1, index_id, node_id, source_digest: target.source_digest, next_offset,
    }), "utf8").toString("base64url");
    await assert.rejects(async () => full.handlers.craft_codebase_symbol_read({ workspace_id: f.workspace.id, index_id: sourceWindowIndexId,
      node_id: "source_window_symbol", continuation: "not-a-token" }), /continuation is invalid/u);
    await assert.rejects(async () => full.handlers.craft_codebase_symbol_read({ workspace_id: f.workspace.id, index_id: sourceWindowIndexId,
      node_id: "source_window_symbol", continuation: "x".repeat(2_049) }), /exceeds budget/u);
    await assert.rejects(async () => full.handlers.craft_codebase_symbol_read({ workspace_id: f.workspace.id, index_id: sourceWindowIndexId,
      node_id: "source_window_symbol", continuation: continuationFor(1, "other-symbol") }), /does not match/u);
    await assert.rejects(async () => full.handlers.craft_codebase_symbol_read({ workspace_id: f.workspace.id, index_id: sourceWindowIndexId,
      node_id: "source_window_symbol", continuation: continuationFor("one") }), /offset is invalid/u);
    await assert.rejects(async () => full.handlers.craft_codebase_symbol_read({ workspace_id: f.workspace.id, index_id: sourceWindowIndexId,
      node_id: "source_window_symbol", continuation: continuationFor(999_999) }), /outside the symbol source range/u);
    const byteLimited = await full.handlers.craft_codebase_symbol_read({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, node_id: target.id, max_bytes: 1 });
    assert.equal(byteLimited.source, "e");
    assert.equal(byteLimited.truncated, true);
    const byteContinuation = await full.handlers.craft_codebase_symbol_read({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id,
      node_id: target.id, continuation: byteLimited.continuation });
    assert.equal(String(byteContinuation.source).startsWith("xport function target"), true);
    await assert.rejects(async () => full.handlers.craft_codebase_symbol_read({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, node_id: "not-a-node" }), /not in index/u);
    const fileNode = graphNodes(f, built.index as JsonObject).find(node => node.kind === "file")!;
    await assert.rejects(async () => full.handlers.craft_codebase_symbol_read({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, node_id: fileNode.id }), /requires a symbol/u);
    await assert.rejects(async () => full.handlers.craft_codebase_symbol_read({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, node_id: target.id, max_lines: 121 }), /max_lines must/u);
    await assert.rejects(async () => full.handlers.craft_codebase_symbol_read({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, node_id: target.id, max_bytes: 12001 }), /max_bytes must/u);
    const originalIndex = f.store.get("codebase_index", String((built.index as JsonObject).id));
    const changedNodes = graphNodes(f, built.index as JsonObject).map(node => node.id === target.id ? { ...node, source_digest: "different" } : node);
    f.store.save("codebase_index", String(originalIndex.id), { ...originalIndex, nodes: changedNodes, edges: graphEdges(f, built.index as JsonObject) });
    await assert.rejects(async () => full.handlers.craft_codebase_symbol_read({ workspace_id: f.workspace.id, index_id: originalIndex.id, node_id: target.id }), /does not match the index/u);
    f.store.save("codebase_index", String(originalIndex.id), originalIndex);
    const originalCheckpoint = f.store.get("workspace_checkpoint", String(f.checkpoint.id));
    f.store.save("workspace_checkpoint", String(originalCheckpoint.id), { ...originalCheckpoint,
      entries: (originalCheckpoint.entries as JsonObject[]).filter(entry => entry.path !== target.path) });
    await assert.rejects(async () => full.handlers.craft_codebase_symbol_read({ workspace_id: f.workspace.id, index_id: originalIndex.id, node_id: target.id }), /outside the checkpoint/u);
    f.store.save("workspace_checkpoint", String(originalCheckpoint.id), originalCheckpoint);
    const snapshotTarget = join(String(f.checkpoint.snapshot_root), "src", "target.ts");
    await writeFile(snapshotTarget, "tampered");
    await assert.rejects(async () => full.handlers.craft_codebase_symbol_read({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, node_id: target.id }), /changed since checkpoint/u);
    await writeFile(snapshotTarget, "export function target() { return 1; }\nexport function targetHelper() { return target(); }\nexport const shared = 1;\n");
    const explored = await full.handlers.craft_codebase_symbol_explore({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, query: "target", relation_kinds: ["calls", "references"], direction: "both" });
    assert.equal(explored.resolution, "exact_unique");
    assert.equal((explored.relation_analysis as JsonObject).status, "partial");
    assert.equal(explored.candidate_only, true);
    assert.equal(explored.content_included, false);
    assert.equal((explored.candidates as JsonObject[]).some(candidate => ((candidate.relations as JsonObject[]).length > 0)), true);
    const relationSummaryIndex = f.store.get("codebase_index", String((built.index as JsonObject).id));
    f.store.save("codebase_index", String(relationSummaryIndex.id), { ...relationSummaryIndex,
      analysis: { ...(relationSummaryIndex.analysis as JsonObject), relation_analysis: undefined } });
    const legacyExplored = await full.handlers.craft_codebase_symbol_explore({ workspace_id: f.workspace.id, index_id: relationSummaryIndex.id, query: "target" });
    assert.equal((legacyExplored.relation_analysis as JsonObject).status, "analyzed");
    f.store.save("codebase_index", String(relationSummaryIndex.id), relationSummaryIndex);
    const noMatch = await full.handlers.craft_codebase_symbol_explore({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, query: "zzzxqvunlikely" });
    assert.equal(noMatch.resolution, "not_found");
    const ambiguous = await full.handlers.craft_codebase_symbol_explore({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, query: "shared" });
    assert.equal(ambiguous.resolution, "exact_ambiguous");
    assert.equal((ambiguous.candidates as JsonObject[]).length >= 2, true);
    const lexicalAmbiguous = await full.handlers.craft_codebase_symbol_explore({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, query: "targ" });
    assert.equal(lexicalAmbiguous.resolution, "ambiguous");
    const lexicalCandidate = await full.handlers.craft_codebase_symbol_explore({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, query: "direc", path: "src/direct.ts" });
    assert.equal(lexicalCandidate.resolution, "candidate");
    const pathScoped = await full.handlers.craft_codebase_symbol_explore({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, query: "target", path: "src/target.ts", direction: "incoming", relation_kinds: ["calls"], relation_limit: 1 });
    assert.equal((pathScoped.candidates as JsonObject[]).every(candidate => (candidate.symbol as JsonObject).path === "src/target.ts"), true);
    const outgoing = await full.handlers.craft_codebase_symbol_explore({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, query: "target", direction: "outgoing" });
    assert.equal(outgoing.direction, "outgoing");
    assert.equal(full.tools.find(tool => tool.name === "craft_codebase_symbol_explore")?.annotations?.readOnlyHint, true);
    await assert.rejects(async () => full.handlers.craft_codebase_symbol_explore({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, query: "target", direction: "sideways" }), /direction must be incoming/u);
    await assert.rejects(async () => full.handlers.craft_codebase_symbol_explore({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, query: "target", relation_kinds: [] }), /relation_kinds must contain/u);
    await assert.rejects(async () => full.handlers.craft_codebase_symbol_explore({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, query: "target", relation_kinds: ["calls", "calls"] }), /relation_kinds must contain/u);
    await assert.rejects(async () => full.handlers.craft_codebase_symbol_explore({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, query: "target", relation_kinds: ["unsafe"] }), /relation_kinds must contain/u);
    await assert.rejects(async () => full.handlers.craft_codebase_symbol_explore({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, query: "target", path: "../outside.ts" }), /stay below the checkpoint/u);
    await assert.rejects(async () => full.handlers.craft_codebase_symbol_explore({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, query: "target", path: "/outside.ts" }), /stay below the checkpoint/u);
    await assert.rejects(async () => full.handlers.craft_codebase_symbol_explore({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, query: "target", path: "src/missing.ts" }), /outside checkpoint/u);
    await assert.rejects(async () => full.handlers.craft_codebase_symbol_explore({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, query: "target", symbol_limit: 11 }), /symbol_limit must/u);
    await assert.rejects(async () => full.handlers.craft_codebase_symbol_explore({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, query: "target", relation_limit: 21 }), /relation_limit must/u);
    await assert.rejects(async () => full.handlers.craft_codebase_symbol_explore({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, query: "x".repeat(2001) }), /query exceeds/u);
    const outline = await full.handlers.craft_codebase_symbols_overview({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, path: "src/target.ts" });
    assert.equal((outline.symbols as JsonObject[]).some(symbol => symbol.name === "target"), true);
    const flow = await full.handlers.craft_codebase_control_flow_query({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, node_id: target.id });
    assert.equal(flow.source_content_included, false);
    assert.equal(flow.control_flow_only, true);
    assert.equal((flow.blocks as JsonObject[]).some(block => block.kind === "return"), true);
    await full.handlers.craft_codebase_callers_find({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, symbol_id: target.id });
    const impact = await full.handlers.craft_codebase_impact_query({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, node_id: target.id, direction: "incoming", relation_kind: "calls" });
    assert.equal((impact as JsonObject).direction, "incoming");
    assert.equal((impact as JsonObject).relation_kind, "calls");
    await full.handlers.craft_codebase_context_slice({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, node_ids: [target.id] });
    const deactivated = await full.handlers.craft_codebase_deactivate({ workspace_id: f.workspace.id, actor: "mcp" });
    assert.equal((deactivated.activation as JsonObject).status, "disabled");
  } finally { await close(f); }
});

test("craft-codebase source reads preserve UTF-8 boundaries when a byte cap cannot fit one code point", async () => {
  const f = await fixture();
  try {
    const content = "😀 export function target() {}\n";
    await writeFile(join(f.project, "src", "target.ts"), content);
    active(f);
    const checkpoint = f.service.workspaceCheckpoint({ workspace_id: f.workspace.id, checkpoint_id: "unicode-source", label: "unicode source" }).checkpoint as JsonObject;
    const entry = (checkpoint.entries as JsonObject[]).find(item => item.path === "src/target.ts")!;
    const built = f.service.codebaseAnalysisImport({ workspace_id: f.workspace.id, checkpoint_id: checkpoint.id, index_id: "unicode-source-index",
      analysis: { format: "craft-static-analysis-v1", analyzer: "unicode-fixture", analyzer_version: "1", nodes: [
        { id: "unicode_symbol", kind: "symbol", path: entry.path, name: "target", source_digest: entry.digest, language: "ts", span: { start_offset: 3, end_offset: 9 } }], edges: [] } });
    assert.throws(() => f.kernel.symbolRead({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id,
      node_id: "unicode_symbol", max_bytes: 1 }), /too small for the next UTF-8 code point/u);
  } finally { await close(f); }
});

test("craft-codebase source reads report an empty indexed declaration without inventing source", async () => {
  const f = await fixture();
  try {
    active(f);
    const checkpoint = f.service.workspaceCheckpoint({ workspace_id: f.workspace.id, checkpoint_id: "empty-declaration", label: "empty declaration" }).checkpoint as JsonObject;
    const entry = (checkpoint.entries as JsonObject[]).find(item => item.path === "src/target.ts")!;
    const built = f.service.codebaseAnalysisImport({ workspace_id: f.workspace.id, checkpoint_id: checkpoint.id, index_id: "empty-declaration-index",
      analysis: { format: "craft-static-analysis-v1", analyzer: "empty-declaration-fixture", analyzer_version: "1", nodes: [
        { id: "empty_symbol", kind: "symbol", path: entry.path, name: "empty", source_digest: entry.digest, language: "ts",
          span: { start_offset: 0, end_offset: 0 }, declaration_span: { start_offset: 0, end_offset: 0, start_line: 1, end_line: 1 } }], edges: [] } });
    const result = f.kernel.symbolRead({ workspace_id: f.workspace.id, index_id: String((built.index as JsonObject).id), node_id: "empty_symbol" });
    assert.equal(result.source, "");
    assert.equal(result.start_line, 1);
    assert.equal(result.truncated, false);
  } finally { await close(f); }
});

test("craft-codebase symbol search returns no candidates for a valid empty graph", async () => {
  const f = await fixture();
  try {
    for (const name of ["target.ts", "flow.ts", "caller.ts", "duplicate.ts", "external.ts", "direct.ts", "view.tsx"])
      await rm(join(f.project, "src", name));
    active(f);
    const checkpoint = f.service.workspaceCheckpoint({ workspace_id: f.workspace.id, checkpoint_id: "empty-graph", label: "empty graph" }).checkpoint as JsonObject;
    const built = f.kernel.build({ workspace_id: f.workspace.id, checkpoint_id: checkpoint.id });
    assert.equal((built.index as JsonObject).node_count, 0);
    assert.deepEqual((built.index as JsonObject).node_shard_ids, []);
    assert.equal((built.index as JsonObject).nodes, undefined);
    const result = f.kernel.findSymbol({ workspace_id: f.workspace.id, index_id: String((built.index as JsonObject).id), query: "missing" });
    assert.deepEqual(result.symbols, []);
    assert.equal((result.receipt as JsonObject).content_free, true);
    const nodeDigest = digestJson([]), edgeDigest = digestJson([]);
    const manifest: JsonObject = { graph_storage: "sharded-v4", location_route_version: 2, shard_ids: [], shard_digests: [],
      node_shard_ids: [], edge_shard_ids: [], node_count: 0, edge_count: 0, node_digest: nodeDigest, edge_digest: edgeDigest,
      graph_digest: digestJson({ node_digest: nodeDigest, edge_digest: edgeDigest }), edge_route_shards: [] };
    const seal = (value: JsonObject): string => stableDigest({ location_route_version: value.location_route_version, shard_ids: value.shard_ids,
      shard_digests: value.shard_digests, node_shard_ids: value.node_shard_ids, edge_shard_ids: value.edge_shard_ids,
      node_count: value.node_count, edge_count: value.edge_count, graph_digest: value.graph_digest,
      node_digest: value.node_digest, edge_digest: value.edge_digest, edge_route_shards: value.edge_route_shards });
    manifest.graph_manifest_digest = seal(manifest);
    const readShards = (f.kernel as unknown as { readShards(index: JsonObject, kind: "nodes" | "edges"): JsonObject[] }).readShards.bind(f.kernel);
    assert.deepEqual(readShards(manifest, "nodes"), []);
    assert.deepEqual(readShards(manifest, "edges"), []);
    const badDigest: JsonObject = { ...manifest, node_digest: "invalid" };
    badDigest.graph_manifest_digest = seal(badDigest);
    assert.throws(() => readShards(badDigest, "nodes"), /component manifest is invalid/u);
  } finally { await close(f); }
});

test("craft-codebase symbol reads anchor their bounded window near later declarations", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.project, "src", "target.ts"), "// header\n// context\n\nexport function target() { return 1; }\n");
    active(f);
    const checkpoint = f.service.workspaceCheckpoint({ workspace_id: f.workspace.id, checkpoint_id: "later-symbol", label: "later symbol source" }).checkpoint as JsonObject;
    const built = f.kernel.build({ workspace_id: f.workspace.id, checkpoint_id: checkpoint.id }).index as JsonObject;
    const target = symbol(f, String(built.id));
    const result = f.kernel.symbolRead({ workspace_id: f.workspace.id, index_id: built.id, node_id: target.id });
    assert.equal(result.start_line, 4);
    assert.equal(String(result.source).startsWith("export function target"), true);
    assert.equal(result.read_mode, "declaration");
  } finally { await close(f); }
});


test("relation lookup exposes imported reference, implementation, type, call, and import edges through MCP", async () => {
  const f = await fixture();
  try {
    active(f);
    const checkpoint = f.checkpoint;
    const entries = checkpoint.entries as JsonObject[];
    const target = entries.find(entry => entry.path === "src/target.ts")!;
    const caller = entries.find(entry => entry.path === "src/caller.ts")!;
    const targetContent = "export function target() { return 1; }\nexport function targetHelper() { return target(); }\nexport const shared = 1;\n";
    const callerContent = "import { target } from './target';\nexport function caller() { missing(); shared(); return target(); }\n";
    const node = (id: string, path: string, name: string, kind: string, at = 0): JsonObject => ({ id, path, name, kind,
      language: "ts", source_digest: path === "src/target.ts" ? target.digest : caller.digest,
      span: { start_offset: at, end_offset: at + (kind === "file" ? 0 : name.length) } });
    const targetFile = node("target_file", "src/target.ts", "src/target.ts", "file");
    const callerFile = node("caller_file", "src/caller.ts", "src/caller.ts", "file");
    const targetNode = node("target_symbol", "src/target.ts", "target", "symbol", targetContent.indexOf("target"));
    const callerNode = node("caller_symbol", "src/caller.ts", "caller", "symbol", callerContent.indexOf("caller"));
    const helperNode = node("helper_symbol", "src/target.ts", "targetHelper", "symbol", targetContent.indexOf("targetHelper"));
    const edge = (kind: string, from: string, to: string, content: string, search: string): JsonObject => {
      const start = content.indexOf(search);
      return { kind, from_node_id: from, to_node_id: to, source_span: { start_offset: start, end_offset: start + search.length } };
    };
    const built = f.service.codebaseAnalysisImport({ workspace_id: f.workspace.id, checkpoint_id: checkpoint.id, index_id: "relation-test-index",
      analysis: { format: "craft-static-analysis-v1", analyzer: "relation-fixture", analyzer_version: "1",
        nodes: [targetFile, callerFile, targetNode, callerNode, helperNode],
        edges: [edge("calls", "caller_symbol", "target_symbol", callerContent, "target();"),
          edge("references", "caller_symbol", "target_symbol", callerContent, "target();"),
          edge("definitions", "caller_symbol", "target_symbol", callerContent, "target();"),
          edge("references", "helper_symbol", "target_symbol", targetContent, "target();"),
          edge("implements", "helper_symbol", "target_symbol", targetContent, "targetHelper"),
          edge("extends", "helper_symbol", "target_symbol", targetContent, "targetHelper"),
          edge("type_definition", "caller_symbol", "target_symbol", callerContent, "target"),
          edge("imports", "caller_file", "target_file", callerContent, "target")], diagnostics: {} } });
    assert.throws(() => f.service.codebaseAnalysisImport({ workspace_id: f.workspace.id, checkpoint_id: checkpoint.id, index_id: "invalid-declaration-kind-index",
      analysis: { format: "craft-static-analysis-v1", analyzer: "relation-fixture", analyzer_version: "1",
        nodes: [{ ...targetNode, declaration_kind: 7 }], edges: [] } }), /declaration kind/u);
    const indexId = String((built.index as JsonObject).id);
    const server = new McpServer(f.service, "full");
    const relationTool = server.tools.find(tool => tool.name === "craft_codebase_relations_find")!;
    assert.deepEqual(relationTool.inputSchema.required, ["index_id", "workspace_id", "node_id", "relation_kind"]);
    assert.equal(((relationTool.inputSchema.properties as JsonObject).direction as JsonObject).type, "string");
    assert.equal(relationTool.annotations?.readOnlyHint, true);
    const definitionTool = server.tools.find(tool => tool.name === "craft_codebase_definition_find")!;
    assert.deepEqual(definitionTool.inputSchema.required, ["index_id", "workspace_id", "path", "offset"]);
    assert.equal(((definitionTool.inputSchema.properties as JsonObject).offset as JsonObject).type, "integer");
    assert.equal(definitionTool.annotations?.readOnlyHint, true);
    const call = async (args: JsonObject) => await server.handlers.craft_codebase_relations_find({ workspace_id: f.workspace.id, index_id: indexId, ...args }) as JsonObject;
    const refs = await call({ node_id: "target_symbol", relation_kind: "references", limit: 1 });
    assert.equal((refs.relations as JsonObject[]).length, 1);
    assert.equal(refs.omitted_count, 1);
    assert.equal(refs.truncated, true);
    assert.equal((((refs.relations as JsonObject[])[0]!.edge as JsonObject).confidence), "partial");
    assert.equal(((refs.receipt as JsonObject).kind), "relations_find");
    const definition = await server.handlers.craft_codebase_definition_find({ workspace_id: f.workspace.id, index_id: indexId,
      path: "src/caller.ts", offset: callerContent.indexOf("target();") }) as JsonObject;
    assert.equal(((definition.definitions as JsonObject[])[0]!).id, "target_symbol");
    assert.equal(definition.candidate_only, true);
    assert.equal(definition.content_included, false);
    assert.equal(((definition.receipt as JsonObject).kind), "definition_find");
    assert.throws(() => server.handlers.craft_codebase_definition_find({ workspace_id: f.workspace.id, index_id: indexId, path: "../outside.ts", offset: 0 }), /below the checkpoint/);
    assert.throws(() => server.handlers.craft_codebase_definition_find({ workspace_id: f.workspace.id, index_id: indexId, path: join(f.project, "src/caller.ts"), offset: 0 }), /below the checkpoint/);
    assert.throws(() => server.handlers.craft_codebase_definition_find({ workspace_id: f.workspace.id, index_id: indexId, path: "src/caller.ts", offset: -1 }), /non-negative safe integer/u);
    assert.throws(() => server.handlers.craft_codebase_definition_find({ workspace_id: f.workspace.id, index_id: indexId, path: "src/caller.ts", offset: 0.5 }), /non-negative safe integer/u);
    assert.throws(() => server.handlers.craft_codebase_definition_find({ workspace_id: f.workspace.id, index_id: indexId, path: "src/missing.ts", offset: 0 }), /outside checkpoint/);
    assert.equal(((await call({ node_id: "caller_symbol", relation_kind: "references", direction: "outgoing" })).relations as JsonObject[]).length, 1);
    for (const kind of ["calls", "definitions", "implements", "extends", "type_definition", "imports"]) assert.equal(((await call({ node_id: kind === "imports" ? "target_file" : "target_symbol", relation_kind: kind })).relations as JsonObject[]).length, 1);
    await assert.rejects(() => call({ node_id: "target_symbol", relation_kind: "unknown" }), /Unsupported/);
    await assert.rejects(() => call({ node_id: "target_symbol", relation_kind: "references", direction: "sideways" }), /direction/);
    await assert.rejects(() => call({ node_id: "target_symbol", relation_kind: "references", limit: 101 }), /limit/);
    assert.equal(surfaceToolNames("codebase").includes("craft_codebase_relations_find"), true);
    assert.equal(surfaceToolNames("codebase").includes("craft_codebase_definition_find"), true);
  } finally { await close(f); }
});

test("legacy inline graphs remain readable after new indexes use verified shards", async () => {
  const f = await fixture();
  try {
    active(f); const built = index(f); const record = f.store.get("codebase_index", String(built.id));
    const legacy: JsonObject = { ...record, nodes: graphNodes(f, record), edges: graphEdges(f, record) };
    for (const key of ["graph_storage", "location_route_version", "shard_ids", "shard_digests", "node_shard_ids", "edge_shard_ids", "edge_route_shards", "node_count", "edge_count", "graph_digest", "node_digest", "edge_digest", "graph_manifest_digest"]) delete legacy[key];
    f.store.save("codebase_index", String(record.id), legacy);
    const inlineReader = f.kernel as unknown as { loadIncidentEdges(index: JsonObject, nodeId: string, direction: "incoming" | "outgoing" | "both", kind?: string): JsonObject[] };
    const legacySource = (legacy.nodes as JsonObject[]).find(item => item.kind === "file" && item.path === "src/caller.ts")!;
    assert(inlineReader.loadIncidentEdges(legacy, String(legacySource.id), "outgoing", "imports").length > 0);
    assert((f.kernel.symbolsOverview({ workspace_id: f.workspace.id, index_id: record.id, path: "src/target.ts" }).symbols as JsonObject[]).some(item => item.name === "target"));
    assert((f.kernel.contextProjection({ workspace_id: f.workspace.id, index_id: record.id, query: "target" }).candidates as JsonObject[]).length > 0);
    const target = symbol(f, String(record.id));
    assert((f.kernel.findCallers({ workspace_id: f.workspace.id, index_id: record.id, symbol_id: target.id }).callers as unknown[]).length > 0);
    assert.throws(() => f.kernel.findCallers({ workspace_id: f.workspace.id, index_id: record.id, symbol_id: "missing_symbol" }), /not in index/u);
    assert.equal((f.kernel.impact({ workspace_id: f.workspace.id, index_id: record.id, node_id: target.id }).edges as unknown[]).length > 0, true);
    const callerText = await readFile(join(f.project, "src", "caller.ts"), "utf8");
    const definition = f.kernel.findDefinition({ workspace_id: f.workspace.id, index_id: record.id, path: "src/caller.ts", offset: callerText.lastIndexOf("target()") });
    assert.equal(((definition.definitions as JsonObject[])[0] as JsonObject | undefined)?.name, "target");
  } finally { await close(f); }
});

test("prior sharded indexes without node routes remain readable", async () => {
  const f = await fixture();
  try {
    active(f); const built = index(f); const record = f.store.get("codebase_index", String(built.id));
    const oldNodes: JsonObject[] = [], oldEdges: JsonObject[] = [];
    for (const shardId of record.shard_ids as string[]) {
      const shard = f.store.get("codebase_index_shard", shardId);
      oldNodes.push(...shard.nodes as JsonObject[]); oldEdges.push(...shard.edges as JsonObject[]);
    }
    oldNodes.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    oldEdges.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const oldDigests = { graph_digest: digestJson({ nodes: oldNodes, edges: oldEdges }), node_digest: digestJson(oldNodes), edge_digest: digestJson(oldEdges) };
    const descriptors: JsonObject[] = (record.edge_route_shards as JsonObject[]).map(descriptor => {
      const route = f.store.get("codebase_index_edge_route", String(descriptor.id));
      const { nodes: _nodes, locations: _locations, route_digest: _routeDigest, ...rest } = route;
      const legacy = { index_id: record.id, bucket: rest.bucket, incoming: rest.incoming, outgoing: rest.outgoing };
      const digest = stableDigest(legacy);
      f.store.save("codebase_index_edge_route", String(route.id), { ...legacy, route_digest: digest });
      return { ...descriptor, digest };
    });
    for (const [ordinal, shardId] of (record.shard_ids as string[]).entries()) {
      const shard = f.store.get("codebase_index_shard", shardId);
      f.store.save("codebase_index_shard", shardId, { ...shard, index_id: record.id, ordinal });
    }
    const oldIndex: JsonObject = { ...record, ...oldDigests };
    delete oldIndex.location_route_version;
    const manifest = { shard_ids: record.shard_ids, shard_digests: record.shard_digests, node_shard_ids: record.node_shard_ids, edge_shard_ids: record.edge_shard_ids,
      node_count: record.node_count, edge_count: record.edge_count, graph_digest: oldDigests.graph_digest, node_digest: oldDigests.node_digest, edge_digest: oldDigests.edge_digest, edge_route_shards: descriptors };
    f.store.save("codebase_index", String(record.id), { ...oldIndex, graph_storage: "sharded-v2", edge_route_shards: descriptors, graph_manifest_digest: stableDigest(manifest) });
    const target = symbol(f, String(record.id));
    const legacyOutline = f.kernel.symbolsOverview({ workspace_id: f.workspace.id, index_id: record.id, path: "src/target.ts" });
    assert((legacyOutline.symbols as JsonObject[]).some(item => item.name === "target"), "legacy sharded indexes must retain file outlines via the verified compatibility path");
    assert((f.kernel.findRelations({ workspace_id: f.workspace.id, index_id: record.id, node_id: target.id, relation_kind: "references" }).relations as unknown[]).length > 0);
    const callerText = await readFile(join(f.project, "src", "caller.ts"), "utf8");
    const definition = f.kernel.findDefinition({ workspace_id: f.workspace.id, index_id: record.id, path: "src/caller.ts", offset: callerText.lastIndexOf("target()") });
    assert.equal(((definition.definitions as JsonObject[])[0] as JsonObject | undefined)?.name, "target");
    const routedBuckets = new Set(descriptors.map(item => String(item.bucket)));
    const pathWithoutLegacyRoute = (f.checkpoint.entries as JsonObject[]).map(item => String(item.path))
      .find(path => !routedBuckets.has(stableDigest(`source-location:${path}`).slice(-2)));
    assert(pathWithoutLegacyRoute, "legacy fixture should include a checkpoint path without a node adjacency bucket");
    assert.equal((f.kernel.findDefinition({ workspace_id: f.workspace.id, index_id: record.id, path: pathWithoutLegacyRoute, offset: 0 }).definitions as unknown[]).length, 0);
    assert((f.kernel.impact({ workspace_id: f.workspace.id, index_id: record.id, node_id: target.id }).edges as unknown[]).length > 0);
  } finally { await close(f); }
});

test("sharded-v1 canonical digests remain readable after new ordered-digest indexes", async () => {
  const f = await fixture();
  try {
    active(f); const built = index(f); const current = f.store.get("codebase_index", String(built.id));
    const shardIds = current.shard_ids as string[];
    const nodes: JsonObject[] = [], edges: JsonObject[] = [];
    const shardDigests = shardIds.map(id => {
      const shard = f.store.get("codebase_index_shard", id);
      nodes.push(...shard.nodes as JsonObject[]); edges.push(...shard.edges as JsonObject[]);
      const graph_digest = stableDigest({ nodes: shard.nodes, edges: shard.edges });
      const ordinal = shardIds.indexOf(id);
      f.store.save("codebase_index_shard", id, { ...shard, index_id: current.id, ordinal, graph_digest });
      return graph_digest;
    });
    nodes.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    edges.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const edgeRouteShards = (current.edge_route_shards as JsonObject[]).map(descriptor => {
      const route = f.store.get("codebase_index_edge_route", String(descriptor.id));
      const { route_digest: _routeDigest, ...rest } = route;
      const payload = { index_id: current.id, bucket: rest.bucket, ...(rest.nodes === undefined ? {} : { nodes: rest.nodes }), incoming: rest.incoming,
        outgoing: rest.outgoing, ...(rest.locations === undefined ? {} : { locations: rest.locations }) };
      const digest = stableDigest(payload);
      f.store.save("codebase_index_edge_route", String(route.id), { ...payload, route_digest: digest });
      return { ...descriptor, digest };
    });
    const node_shard_ids = (current.node_shard_ids as string[]).slice();
    const edge_shard_ids = (current.edge_shard_ids as string[]).slice();
    const legacy = { ...current, graph_storage: "sharded-v1", shard_digests: shardDigests,
      graph_digest: stableDigest({ nodes, edges }), node_digest: stableDigest(nodes), edge_digest: stableDigest(edges) };
    const manifest = { location_route_version: current.location_route_version, shard_ids: current.shard_ids, shard_digests: legacy.shard_digests,
      node_shard_ids, edge_shard_ids, node_count: nodes.length, edge_count: edges.length, graph_digest: legacy.graph_digest,
      node_digest: legacy.node_digest, edge_digest: legacy.edge_digest, edge_route_shards: edgeRouteShards };
    f.store.save("codebase_index", String(current.id), { ...legacy, edge_route_shards: edgeRouteShards, graph_manifest_digest: stableDigest(manifest) });
    const target = symbol(f, String(current.id));
    assert((f.kernel.findCallers({ workspace_id: f.workspace.id, index_id: current.id, symbol_id: target.id }).callers as unknown[]).length > 0);
    assert((f.kernel.impact({ workspace_id: f.workspace.id, index_id: current.id, node_id: target.id }).edges as unknown[]).length > 0);
  } finally { await close(f); }
});

test("sharded-v4 commits ordered component shards and keeps sharded-v3 aggregate readers compatible", async () => {
  const f = await fixture();
  try {
    active(f); const built = index(f); const current = f.store.get("codebase_index", String(built.id));
    assert.equal(current.graph_storage, "sharded-v4");
    const nodes: JsonObject[] = [], edges: JsonObject[] = [];
    const shardDigests = current.shard_digests as string[], shardIds = current.shard_ids as string[];
    const nodeShardIds = new Set(current.node_shard_ids as string[]), edgeShardIds = new Set(current.edge_shard_ids as string[]);
    for (const id of shardIds) {
      const shard = f.store.get("codebase_index_shard", id);
      if (nodeShardIds.has(id)) nodes.push(...shard.nodes as JsonObject[]);
      if (edgeShardIds.has(id)) edges.push(...shard.edges as JsonObject[]);
    }
    nodes.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    edges.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const byId = new Map(shardIds.map((id, ordinal) => [id, shardDigests[ordinal]]));
    assert.equal(current.node_digest, digestJson((current.node_shard_ids as string[]).map(id => byId.get(id))));
    assert.equal(current.edge_digest, digestJson((current.edge_shard_ids as string[]).map(id => byId.get(id))));
    assert.equal(current.graph_digest, digestJson({ node_digest: current.node_digest, edge_digest: current.edge_digest }));
    assert((f.kernel.contextProjection({ workspace_id: f.workspace.id, index_id: current.id, query: "target" }).candidates as JsonObject[]).length > 0);

    const loadGraphComponents = f.kernel as unknown as { loadNodes(index: JsonObject): JsonObject[]; loadEdges(index: JsonObject): JsonObject[] };
    const withManifestDigest = (changes: JsonObject): JsonObject => {
      const changed = { ...current, ...changes };
      const manifest = { location_route_version: changed.location_route_version, shard_ids: changed.shard_ids, shard_digests: changed.shard_digests,
        node_shard_ids: changed.node_shard_ids, edge_shard_ids: changed.edge_shard_ids, node_count: changed.node_count, edge_count: changed.edge_count,
        graph_digest: changed.graph_digest, node_digest: changed.node_digest, edge_digest: changed.edge_digest, edge_route_shards: changed.edge_route_shards };
      return { ...changed, graph_manifest_digest: stableDigest(manifest) };
    };
    assert.throws(() => loadGraphComponents.loadNodes(withManifestDigest({ node_digest: "sha256:tampered" })), /node manifest digest mismatch/u);
    assert.throws(() => loadGraphComponents.loadEdges(withManifestDigest({ edge_digest: "sha256:tampered" })), /edge manifest digest mismatch/u);

    const oldDigests = { node_digest: digestJson(nodes), edge_digest: digestJson(edges), graph_digest: digestJson({ nodes, edges }) };
    const legacy: JsonObject = { ...current, graph_storage: "sharded-v3", ...oldDigests };
    const manifest = { location_route_version: legacy.location_route_version, shard_ids: legacy.shard_ids, shard_digests: legacy.shard_digests,
      node_shard_ids: legacy.node_shard_ids, edge_shard_ids: legacy.edge_shard_ids, node_count: legacy.node_count, edge_count: legacy.edge_count,
      graph_digest: legacy.graph_digest, node_digest: legacy.node_digest, edge_digest: legacy.edge_digest, edge_route_shards: legacy.edge_route_shards };
    f.store.save("codebase_index", String(current.id), { ...legacy, graph_manifest_digest: stableDigest(manifest) });
    assert((f.kernel.contextProjection({ workspace_id: f.workspace.id, index_id: current.id, query: "target" }).candidates as JsonObject[]).length > 0);
  } finally { await close(f); }
});

test("content addressed shard collisions fail closed and edge-only overflow shards route correctly", async () => {
  const firstDigest = `${"0".repeat(31)}1`, secondDigest = `${"0".repeat(31)}2`;
  assert.deepEqual(contentAddressedShardIds([firstDigest, secondDigest]), [`codebase_shard_${firstDigest}`, `codebase_shard_${secondDigest}`]);
  assert.throws(() => contentAddressedShardIds(["sha256:collision", "sha256:collision"]), /duplicate content shards/u);
  const f = await fixture();
  try {
    active(f);
    const source = "x".repeat(40_000);
    await writeFile(join(f.project, "src", "bulk.ts"), source);
    const checkpoint = f.service.workspaceCheckpoint({ workspace_id: f.workspace.id, checkpoint_id: "bulk", label: "bulk edges" }).checkpoint as JsonObject;
    const entry = (checkpoint.entries as JsonObject[]).find(item => item.path === "src/bulk.ts")!;
    const nodes = [
      { id: "bulk_file", kind: "file", path: "src/bulk.ts", name: "bulk.ts", source_digest: entry.digest, span: { start_offset: 0, end_offset: source.length }, language: "typescript" },
      { id: "bulk_symbol", kind: "symbol", path: "src/bulk.ts", name: "bulkSymbol", source_digest: entry.digest, span: { start_offset: 0, end_offset: 1 }, language: "typescript" },
    ];
    const edges = Array.from({ length: 8_000 }, (_, offset) => ({ kind: "references", from_node_id: "bulk_file", to_node_id: "bulk_symbol", source_span: { start_offset: offset, end_offset: offset + 1 } }));
    const built = f.kernel.importAnalysis({ workspace_id: f.workspace.id, checkpoint_id: checkpoint.id, index_id: "bulk_graph", analysis: {
      format: "craft-static-analysis-v1", analyzer: "coverage-fixture", analyzer_version: "1", nodes, edges,
    } }).index as JsonObject;
    const shards = (built.shard_ids as string[]).map(id => f.store.get("codebase_index_shard", id));
    assert(shards.some(shard => Number(shard.node_count) === 0 && Number(shard.edge_count) > 0));
    assert((f.kernel.contextProjection({ workspace_id: f.workspace.id, index_id: built.id, query: "bulkSymbol" }).candidates as JsonObject[]).length > 0);
  } finally { await close(f); }
});

test("edge route records are digest checked before relation and impact results are returned", async () => {
  const f = await fixture();
  try {
    active(f); const built = index(f); const record = f.store.get("codebase_index", String(built.id));
    const target = symbol(f, String(record.id)); const descriptor = (record.edge_route_shards as JsonObject[]).find(item => item.bucket === stableDigest(target.id).slice(-2))!;
    const route = f.store.get("codebase_index_edge_route", String(descriptor.id));
    f.store.save("codebase_index_edge_route", String(route.id), { ...route, incoming: {}, route_digest: "tampered" });
    assert.throws(() => f.kernel.findCallers({ workspace_id: f.workspace.id, index_id: record.id, symbol_id: target.id }), /route integrity/);
  } finally { await close(f); }
});

test("incident lookup fails closed when an internal node has no route bucket", async () => {
  const f = await fixture();
  try {
    active(f); const built = index(f);
    const loadIncidentEdges = (f.kernel as unknown as { loadIncidentEdges: (index: JsonObject, nodeId: string, direction: "incoming" | "outgoing" | "both") => JsonObject[] }).loadIncidentEdges;
    assert.throws(() => loadIncidentEdges.call(f.kernel, built, "missing-node", "both"), /not in index/u);
  } finally { await close(f); }
});

test("adjacency route rejects unknown edge shards even when its own digest is updated", async () => {
  const f = await fixture();
  try {
    active(f); const built = index(f); const current = f.store.get("codebase_index", String(built.id));
    const target = symbol(f, String(current.id)), bucket = stableDigest(target.id).slice(-2);
    const descriptor = (current.edge_route_shards as JsonObject[]).find(item => item.bucket === bucket)!;
    const route = f.store.get("codebase_index_edge_route", String(descriptor.id));
    const targetId = String(target.id), incoming = { ...(route.incoming as JsonObject), [targetId]: ["unknown-edge-shard"] };
    const payload = { ...(route.index_id === undefined ? {} : { index_id: route.index_id }), bucket: route.bucket, ...(route.nodes === undefined ? {} : { nodes: route.nodes }),
      incoming, outgoing: route.outgoing, ...(route.locations === undefined ? {} : { locations: route.locations }) };
    const digest = stableDigest(payload);
    f.store.save("codebase_index_edge_route", String(route.id), { ...route, incoming, route_digest: digest });
    const descriptors = (current.edge_route_shards as JsonObject[]).map(item => item.id === route.id ? { ...item, digest } : item);
    const changed: JsonObject = { ...current, edge_route_shards: descriptors };
    const manifest = { location_route_version: changed.location_route_version, shard_ids: changed.shard_ids, shard_digests: changed.shard_digests,
      node_shard_ids: changed.node_shard_ids, edge_shard_ids: changed.edge_shard_ids, node_count: changed.node_count, edge_count: changed.edge_count,
      graph_digest: changed.graph_digest, node_digest: changed.node_digest, edge_digest: changed.edge_digest, edge_route_shards: descriptors };
    f.store.save("codebase_index", String(changed.id), { ...changed, graph_manifest_digest: stableDigest(manifest) });
    assert.throws(() => f.kernel.findCallers({ workspace_id: f.workspace.id, index_id: changed.id, symbol_id: targetId }), /unknown shard/u);
  } finally { await close(f); }
});

test("file symbol outlines verify their path route before reading node shards", async () => {
  const f = await fixture();
  try {
    active(f); const built = index(f); const record = f.store.get("codebase_index", String(built.id));
    const bucket = stableDigest("source-location:src/target.ts").slice(-2);
    const descriptor = (record.edge_route_shards as JsonObject[]).find(item => item.bucket === bucket)!;
    const route = f.store.get("codebase_index_edge_route", String(descriptor.id));
    f.store.save("codebase_index_edge_route", String(route.id), { ...route, locations: {}, route_digest: "tampered" });
    assert.throws(() => f.kernel.symbolsOverview({ workspace_id: f.workspace.id, index_id: record.id, path: "src/target.ts" }), /source location route integrity/u);
  } finally { await close(f); }
});

test("file symbol outlines reject malformed and unknown path shard routes", async () => {
  const f = await fixture();
  try {
    active(f); const built = index(f); const path = "src/target.ts";
    const rewriteRoute = (locations: JsonObject, routePath = path) => {
      const current = f.store.get("codebase_index", String(built.id));
      const bucket = stableDigest(`source-location:${routePath}`).slice(-2);
      const descriptor = (current.edge_route_shards as JsonObject[]).find(item => item.bucket === bucket)!;
      const route = f.store.get("codebase_index_edge_route", String(descriptor.id));
      const payload = { ...(route.index_id === undefined ? {} : { index_id: route.index_id }), bucket: route.bucket, ...(route.nodes === undefined ? {} : { nodes: route.nodes }),
        incoming: route.incoming, outgoing: route.outgoing, locations };
      const digest = stableDigest(payload);
      f.store.save("codebase_index_edge_route", String(route.id), { ...route, locations, route_digest: digest });
      const descriptors = (current.edge_route_shards as JsonObject[]).map(item => item.id === route.id ? { ...item, digest } : item);
      const manifest = { location_route_version: current.location_route_version, shard_ids: current.shard_ids, shard_digests: current.shard_digests,
        node_shard_ids: current.node_shard_ids, edge_shard_ids: current.edge_shard_ids, node_count: current.node_count, edge_count: current.edge_count,
        graph_digest: current.graph_digest, node_digest: current.node_digest, edge_digest: current.edge_digest, edge_route_shards: descriptors };
      f.store.save("codebase_index", String(current.id), { ...current, edge_route_shards: descriptors, graph_manifest_digest: stableDigest(manifest) });
    };
    rewriteRoute({});
    assert.equal((f.kernel.symbolsOverview({ workspace_id: f.workspace.id, index_id: built.id, path }).symbols as JsonObject[]).length, 0);
    rewriteRoute({ [path]: [] });
    assert.equal((f.kernel.symbolsOverview({ workspace_id: f.workspace.id, index_id: built.id, path }).symbols as JsonObject[]).length, 0);
    rewriteRoute({ [path]: "invalid" } as unknown as JsonObject);
    assert.throws(() => f.kernel.symbolsOverview({ workspace_id: f.workspace.id, index_id: built.id, path }), /route is malformed/u);
    rewriteRoute({ [path]: ["unknown-shard"] });
    assert.throws(() => f.kernel.symbolsOverview({ workspace_id: f.workspace.id, index_id: built.id, path }), /unknown shard/u);

    const callerPath = "src/caller.ts", callerText = await readFile(join(f.project, callerPath), "utf8");
    rewriteRoute({}, callerPath);
    const missingLocation = f.kernel.findDefinition({ workspace_id: f.workspace.id, index_id: built.id, path: callerPath, offset: callerText.indexOf("target();") });
    assert.equal((missingLocation.definitions as JsonObject[]).length, 0);
    rewriteRoute({ [callerPath]: "invalid" }, callerPath);
    assert.throws(() => f.kernel.findDefinition({ workspace_id: f.workspace.id, index_id: built.id, path: callerPath, offset: 0 }), /route is malformed/u);
    rewriteRoute({ [callerPath]: ["unknown-shard"] }, callerPath);
    assert.throws(() => f.kernel.findDefinition({ workspace_id: f.workspace.id, index_id: built.id, path: callerPath, offset: 0 }), /unknown shard/u);
    const current = f.store.get("codebase_index", String(built.id));
    const descriptor = (current.edge_route_shards as JsonObject[]).find(item => item.bucket === stableDigest(`source-location:${callerPath}`).slice(-2))!;
    const route = f.store.get("codebase_index_edge_route", String(descriptor.id));
    f.store.save("codebase_index_edge_route", String(route.id), { ...route, route_digest: "tampered" });
    assert.throws(() => f.kernel.findDefinition({ workspace_id: f.workspace.id, index_id: built.id, path: callerPath, offset: 0 }), /route integrity/u);
  } finally { await close(f); }
});

test("file symbol outline uses deterministic span and name tie breakers", async () => {
  const f = await fixture();
  try {
    active(f);
    const entry = (f.checkpoint.entries as JsonObject[]).find(item => item.path === "src/target.ts")!;
    const symbols = [
      { id: "outline_a", kind: "symbol", path: entry.path, name: "zeta", language: "ts", source_digest: entry.digest, span: { start_offset: 0, end_offset: 4 } },
      { id: "outline_b", kind: "symbol", path: entry.path, name: "alpha", language: "ts", source_digest: entry.digest, span: { start_offset: 0, end_offset: 5 } },
      { id: "outline_c", kind: "symbol", path: entry.path, name: "beta", language: "ts", source_digest: entry.digest, span: { start_offset: 0, end_offset: 4 } },
    ];
    const built = f.service.codebaseAnalysisImport({ workspace_id: f.workspace.id, checkpoint_id: f.checkpoint.id, index_id: "outline-order-index",
      analysis: { format: "craft-static-analysis-v1", analyzer: "outline-fixture", analyzer_version: "1", nodes: symbols, edges: [] } });
    const outline = f.kernel.symbolsOverview({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, path: String(entry.path) });
    assert.deepEqual((outline.symbols as JsonObject[]).map(node => node.name), ["alpha", "beta", "zeta"]);
  } finally { await close(f); }
});

test("adjacency routes merge symbols that hash to the same route bucket", async () => {
  const f = await fixture();
  try {
    active(f);
    const buckets = new Map<string, string>(); let firstId = "", secondId = "";
    for (let ordinal = 0; ordinal < 1_000 && !secondId; ordinal++) {
      const id = `collision_${ordinal}`, bucket = stableDigest(id).slice(-2), prior = buckets.get(bucket);
      if (prior) { firstId = prior; secondId = id; } else buckets.set(bucket, id);
    }
    assert(firstId && secondId, "deterministic route bucket collision fixture should exist");
    const entries = new Map((f.checkpoint.entries as JsonObject[]).map(entry => [String(entry.path), entry]));
    const caller = entries.get("src/caller.ts")!, target = entries.get("src/target.ts")!;
    const callerText = await readFile(join(f.project, "src", "caller.ts"), "utf8");
    const sourceOffset = callerText.indexOf("target();");
    const nodes = [
      { id: firstId, kind: "symbol", path: caller.path, name: "caller", language: "ts", source_digest: caller.digest, span: { start_offset: 0, end_offset: 6 } },
      { id: secondId, kind: "symbol", path: target.path, name: "target", language: "ts", source_digest: target.digest, span: { start_offset: 0, end_offset: 6 } },
    ];
    const built = f.service.codebaseAnalysisImport({ workspace_id: f.workspace.id, checkpoint_id: f.checkpoint.id, index_id: "route-bucket-collision-index",
      analysis: { format: "craft-static-analysis-v1", analyzer: "route-collision-fixture", analyzer_version: "1", nodes,
        edges: [{ kind: "calls", from_node_id: firstId, to_node_id: secondId, source_span: { start_offset: sourceOffset, end_offset: sourceOffset + 8 } }] } });
    const callers = f.kernel.findCallers({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, symbol_id: secondId });
    assert.equal(((callers.callers as JsonObject[])[0]!.caller as JsonObject).name, "caller");
  } finally { await close(f); }
});

test("graph publication rejects duplicate, dangling, and over-budget data before persistence", async () => {
  const f = await fixture();
  try {
    const entry = (f.checkpoint.entries as JsonObject[]).find(item => item.path === "src/target.ts")!;
    const node = { id: "bounded_node", kind: "symbol", path: entry.path, name: "target", source_digest: entry.digest,
      span: { start_offset: 0, end_offset: 6 }, language: "ts" } as unknown as JsonObject;
    const edge = { id: "bounded_edge", kind: "calls", from_node_id: "bounded_node", to_node_id: "bounded_node", provenance: "extracted",
      confidence: "high", source_span: { start_offset: 0, end_offset: 6 } } as unknown as JsonObject;
    const persist = (f.kernel as unknown as { persistIndex: (...args: unknown[]) => JsonObject }).persistIndex.bind(f.kernel);
    assert.throws(() => persist({}, "duplicate-nodes", 1, {}, [node, node], [], []), /duplicate nodes or dangling edges/u);
    assert.throws(() => persist({}, "dangling-edge", 1, {}, [node], [{ ...edge, to_node_id: "missing" }], []), /duplicate nodes or dangling edges/u);
    assert.throws(() => persist({}, "node-budget", 1, {}, Array.from({ length: 60_001 }, (_, ordinal) => ({ ...node, id: `node_${ordinal}` })), [], []), /exceeds storage budget/u);
    assert.throws(() => persist({}, "edge-budget", 1, {}, [node], Array.from({ length: 300_001 }, (_, ordinal) => ({ ...edge, id: `edge_${ordinal}` })), []), /exceeds storage budget/u);
    assert.throws(() => persist({}, "item-budget", 1, {}, [{ ...node, name: "x".repeat(1_000_010) }], [], []), /item exceeds shard budget/u);
    const largeName = "z".repeat(950_000);
    const graphByteBudget = Array.from({ length: 142 }, (_, ordinal) => ({ ...node, id: `large_${ordinal}`, name: largeName }));
    assert.throws(() => persist({}, "graph-byte-budget", 1, {}, graphByteBudget, [], []), /storage byte budget/u);
    const routeBudgetNodes = Array.from({ length: 40_000 }, (_, ordinal) => ({ ...node,
      id: `route_${ordinal}`, path: `src/${String(ordinal).padStart(5, "0")}-${"r".repeat(1_800)}` }));
    assert.throws(() => persist({}, "route-byte-budget", 1, {}, routeBudgetNodes, [], []), /adjacency routes exceed storage byte budget/u);
    const bucketPaths = new Map<string, string[]>(); let collidingPaths: string[] = [];
    for (let ordinal = 0; collidingPaths.length < 5_000 && ordinal < 2_000_000; ordinal += 1) {
      const path = `src/collision-${ordinal}-${"c".repeat(900)}`, bucket = stableDigest(`source-location:${path}`).slice(-2);
      const paths = bucketPaths.get(bucket) ?? []; paths.push(path); bucketPaths.set(bucket, paths);
      if (paths.length === 5_000) collidingPaths = paths;
    }
    const collidingRouteNodes = collidingPaths.map((path, ordinal) => ({ ...node, id: `route-collision-${ordinal}`, path }));
    assert.equal(collidingRouteNodes.length, 5_000, "deterministic hash distribution must yield a route bucket above its shard budget");
    assert.throws(() => persist({}, "route-shard-budget", 1, {}, collidingRouteNodes, [], []), /adjacency routes exceed storage byte budget/u);
  } finally { await close(f); }
});

test("sharded graph readers fail closed on malformed manifests and route payloads", async () => {
  const f = await fixture();
  try {
    active(f); const built = index(f); const original = f.store.get("codebase_index", String(built.id));
    const kernel = f.kernel as unknown as {
      assertManifest(index: JsonObject): void;
      readShard(index: JsonObject, id: string): JsonObject;
      loadNodes(index: JsonObject): JsonObject[];
      loadGraph(index: JsonObject): { nodes: JsonObject[]; edges: JsonObject[] };
      loadIncidentEdges(index: JsonObject, nodeId: string, direction: "incoming" | "outgoing" | "both", kind?: string): JsonObject[];
      readShards(index: JsonObject, kind: "nodes" | "edges"): JsonObject[];
    };
    const inline = { ...original, graph_storage: undefined, nodes: [], edges: [] };
    assert.throws(() => kernel.assertManifest(inline), /manifest is invalid/u);
    assert.throws(() => kernel.readShard(original, "not-a-shard"), /routing is invalid/u);
    const tamperedGraph: JsonObject = { ...original, graph_digest: "tampered" };
    const graphManifest = { location_route_version: tamperedGraph.location_route_version, shard_ids: tamperedGraph.shard_ids,
      shard_digests: tamperedGraph.shard_digests, node_shard_ids: tamperedGraph.node_shard_ids, edge_shard_ids: tamperedGraph.edge_shard_ids,
      node_count: tamperedGraph.node_count, edge_count: tamperedGraph.edge_count, graph_digest: tamperedGraph.graph_digest,
      node_digest: tamperedGraph.node_digest, edge_digest: tamperedGraph.edge_digest, edge_route_shards: tamperedGraph.edge_route_shards };
    assert.throws(() => kernel.loadGraph({ ...tamperedGraph, graph_manifest_digest: stableDigest(graphManifest) }), /graph manifest digest mismatch/u);

    const nodeShardIds = original.node_shard_ids as string[];
    const duplicatedRoutes: JsonObject = { ...original, node_shard_ids: [...nodeShardIds, nodeShardIds[0]!] };
    const duplicateManifest = { location_route_version: duplicatedRoutes.location_route_version, shard_ids: duplicatedRoutes.shard_ids,
      shard_digests: duplicatedRoutes.shard_digests, node_shard_ids: duplicatedRoutes.node_shard_ids, edge_shard_ids: duplicatedRoutes.edge_shard_ids,
      node_count: duplicatedRoutes.node_count, edge_count: duplicatedRoutes.edge_count, graph_digest: duplicatedRoutes.graph_digest,
      node_digest: duplicatedRoutes.node_digest, edge_digest: duplicatedRoutes.edge_digest, edge_route_shards: duplicatedRoutes.edge_route_shards };
    assert.throws(() => kernel.loadNodes({ ...duplicatedRoutes, graph_manifest_digest: stableDigest(duplicateManifest) }), /routing is invalid/u);

    const edgeRoute = (original.edge_route_shards as JsonObject[]).find(item => {
      const candidate = f.store.get("codebase_index_edge_route", String(item.id));
      return graphNodes(f, original).some(node => node.kind === "symbol" && (candidate.nodes as JsonObject)[String(node.id)] !== undefined);
    })!;
    const route = f.store.get("codebase_index_edge_route", String(edgeRoute.id));
    f.store.save("codebase_index_edge_route", String(edgeRoute.id), { ...route, outgoing: { tampered: ["unknown"] } });
    const node = graphNodes(f, original).find(item => item.kind === "symbol" && (route.nodes as JsonObject)[String(item.id)] !== undefined);
    assert(node);
    assert.throws(() => kernel.loadIncidentEdges(original, String(node.id), "incoming"), /route integrity failure/u);
    const source = graphNodes(f, original).find(item => item.kind === "file" && item.path === "src/caller.ts")!;
    assert(kernel.loadIncidentEdges(original, String(source.id), "outgoing", "imports").length > 0);
    assert.throws(() => kernel.readShards({ ...original, edge_shard_ids: undefined }, "edges"), /manifest is invalid/u);
    assert.throws(() => kernel.readShards({ ...original, shard_ids: Array.from({ length: 2049 }, (_, ordinal) => `shard_${ordinal}`) }, "nodes"), /manifest is invalid/u);
  } finally { await close(f); }
});

test("content-addressed shard IDs reject internally consistent node and edge rewrites", async () => {
  const f = await fixture();
  try {
    active(f); const built = index(f); const original = f.store.get("codebase_index", String(built.id));
    const rewriteShard = (kind: "nodes" | "edges") => {
      const routeIds = (kind === "nodes" ? original.node_shard_ids : original.edge_shard_ids) as string[];
      const id = String(routeIds[0]);
      const shard = f.store.get("codebase_index_shard", id);
      const nodes = [...shard.nodes as JsonObject[]], edges = [...shard.edges as JsonObject[]];
      if (kind === "nodes") nodes[0] = { ...nodes[0], name: "changed-without-new-index-digest" };
    else edges[0] = { ...edges[0], kind: edges[0]!.kind === "calls" ? "references" : "calls" };
      const shardDigest = digestJson({ nodes, edges });
      f.store.save("codebase_index_shard", id, { ...shard, nodes, edges, graph_digest: shardDigest });
      const shardDigests = (original.shard_digests as string[]).map((digest, ordinal) => ordinal === (original.shard_ids as string[]).indexOf(id) ? shardDigest : digest);
      const changed: JsonObject = { ...original, shard_digests: shardDigests };
      const manifest = { location_route_version: changed.location_route_version, shard_ids: changed.shard_ids, shard_digests: changed.shard_digests,
        node_shard_ids: changed.node_shard_ids, edge_shard_ids: changed.edge_shard_ids, node_count: changed.node_count, edge_count: changed.edge_count,
        graph_digest: changed.graph_digest, node_digest: changed.node_digest, edge_digest: changed.edge_digest, edge_route_shards: changed.edge_route_shards };
      f.store.save("codebase_index", String(changed.id), { ...changed, graph_manifest_digest: stableDigest(manifest) });
    };
    rewriteShard("nodes");
    assert.throws(() => f.kernel.findSymbol({ workspace_id: f.workspace.id, index_id: built.id, query: "target" }), /content shard address mismatch/u);
  } finally { await close(f); }

  const g = await fixture();
  try {
    active(g); const built = index(g); const original = g.store.get("codebase_index", String(built.id));
    const id = String((original.edge_shard_ids as string[])[0]), shard = g.store.get("codebase_index_shard", id);
    const edges = [...shard.edges as JsonObject[]]; edges[0] = { ...edges[0], kind: edges[0]!.kind === "calls" ? "references" : "calls" };
    const shardDigest = digestJson({ nodes: shard.nodes, edges });
    g.store.save("codebase_index_shard", id, { ...shard, edges, graph_digest: shardDigest });
    const shardDigests = (original.shard_digests as string[]).map((digest, ordinal) => ordinal === (original.shard_ids as string[]).indexOf(id) ? shardDigest : digest);
    const changed: JsonObject = { ...original, shard_digests: shardDigests };
    const manifest = { location_route_version: changed.location_route_version, shard_ids: changed.shard_ids, shard_digests: changed.shard_digests,
      node_shard_ids: changed.node_shard_ids, edge_shard_ids: changed.edge_shard_ids, node_count: changed.node_count, edge_count: changed.edge_count,
      graph_digest: changed.graph_digest, node_digest: changed.node_digest, edge_digest: changed.edge_digest, edge_route_shards: changed.edge_route_shards };
    g.store.save("codebase_index", String(changed.id), { ...changed, graph_manifest_digest: stableDigest(manifest) });
    const readShards = g.kernel as unknown as { readShards(index: JsonObject, kind: "edges"): JsonObject[] };
    assert.throws(() => readShards.readShards(g.store.get("codebase_index", String(built.id)), "edges"), /content shard address mismatch/u);
  } finally { await close(g); }
});

test("explicit analyzer choices preserve the heuristic fallback without accepting unknown analyzers", async () => {
  const f = await fixture();
  try {
    active(f);
    assert.throws(() => f.kernel.build({ workspace_id: f.workspace.id, analyzer: "unknown" }), /Unsupported/);
    assert.equal(((f.kernel.build({ workspace_id: f.workspace.id, analyzer: "typescript" }).index as JsonObject).analysis as JsonObject).analyzer, "typescript-checker");
    assert.equal(((f.kernel.build({ workspace_id: f.workspace.id, analyzer: "heuristic", index_id: "explicit-heuristic" }).index as JsonObject).analysis as JsonObject).analyzer, "builtin-regex-static-v1");
    assert.equal(f.kernel.build({ workspace_id: f.workspace.id, analyzer: "heuristic", index_id: "explicit-heuristic" }).idempotent, true);
    f.service.workspaceCheckpoint({ workspace_id: f.workspace.id, checkpoint_id: "another-checkpoint", label: "same files new identity" });
    assert.throws(() => f.kernel.build({ workspace_id: f.workspace.id, analyzer: "heuristic", index_id: "explicit-heuristic" }), /idempotency conflict/);
  } finally { await close(f); }
});
