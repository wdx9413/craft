import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { CraftStore } from "../../core/infrastructure/store.ts";
import { craftPaths } from "../../core/infrastructure/paths.ts";
import { CraftService } from "../../core/service.ts";

const projectRoot = resolve(process.cwd());
const temporaryRoot = mkdtempSync(join(tmpdir(), "craft-codebase-self-index-"));
const store = await new CraftStore(craftPaths(join(temporaryRoot, "data"))).open();
try {
  const service = new CraftService(store);
  const indexStart = performance.now();
  const ensured = service.codebaseRepositoryEnsure({ project_root: projectRoot, index_depth: "semantic" });
  const indexMs = Math.round(performance.now() - indexStart);
  assert.equal(ensured.status, "ready", "repository semantic index should be ready");
  assert.equal(ensured.omitted_files, 0, "the Craft self-index acceptance repository should fit inside the bounded checkpoint");
  const index = store.get("codebase_index", String(ensured.index_id));
  const relationAnalysis = (index.analysis as Record<string, unknown>).relation_analysis as Record<string, unknown>;
  const partialReasons = relationAnalysis.partial_reasons as string[];
  assert(!partialReasons.includes("analysis_budget_limited"), "self-index graph must not be truncated by the configured budgets");
  assert(!partialReasons.includes("omitted_edges"), "self-index graph must retain every edge whose endpoints are in the snapshot");
  const routeBytes = (index.edge_route_shards as Array<{ id: string }>).reduce((sum, descriptor) =>
    sum + Buffer.byteLength(JSON.stringify(store.get("codebase_index_edge_route", descriptor.id))), 0);
  const symbolStart = performance.now();
  const symbols = service.codebaseSymbolFind({ workspace_id: ensured.workspace_id, index_id: ensured.index_id, query: "ensureRepository" });
  const symbolMs = Math.round(performance.now() - symbolStart);
  const target = (symbols.symbols as Array<{ id: string }>)[0];
  assert(target, "benchmark symbol should exist in this repository");
  const outline = service.codebaseSymbolsOverview({ workspace_id: ensured.workspace_id, index_id: ensured.index_id, path: "capability/craft-codebase/codebase-index.ts", limit: 500 });
  assert((outline.symbols as Array<{ name: string }>).some(symbol => symbol.name === "symbolsOverview"), "per-file symbol outline should expose its indexed declarations");
  assert.equal(outline.content_included, false, "symbol outline must not include source content");
  const controlFlowSymbol = (service.codebaseSymbolFind({ workspace_id: ensured.workspace_id, index_id: ensured.index_id, query: "locationRouteKey" }).symbols as Array<{ id: string; path: string }>)[0];
  assert.equal(controlFlowSymbol?.path, "capability/craft-codebase/codebase-index.ts", "control-flow fixture symbol should resolve in the real repository");
  const controlFlowStart = performance.now();
  const controlFlow = service.codebaseControlFlowQuery({ workspace_id: ensured.workspace_id, index_id: ensured.index_id, node_id: controlFlowSymbol.id });
  const controlFlowMs = Math.round(performance.now() - controlFlowStart);
  assert.equal(controlFlow.status, "complete", "the selected TypeScript function should produce a complete structural CFG");
  assert.equal(controlFlow.source_content_included, false, "control-flow results must not include source content");
  const expectedSymbolIds = (symbols.symbols as Array<{ id: string }>).map(symbol => symbol.id);
  const warmSymbolMs: number[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = performance.now();
    const repeated = service.codebaseSymbolFind({ workspace_id: ensured.workspace_id, index_id: ensured.index_id, query: "ensureRepository" });
    warmSymbolMs.push(Math.round(performance.now() - started));
    assert.deepEqual((repeated.symbols as Array<{ id: string }>).map(symbol => symbol.id), expectedSymbolIds, "cached symbol results must be stable");
  }
  const callersStart = performance.now();
  const callers = service.codebaseCallersFind({ workspace_id: ensured.workspace_id, index_id: ensured.index_id, symbol_id: target.id });
  const callersMs = Math.round(performance.now() - callersStart);
  const impactStart = performance.now();
  const impact = service.codebaseImpactQuery({ workspace_id: ensured.workspace_id, index_id: ensured.index_id, node_id: target.id, max_depth: 2, limit: 40 });
  const impactMs = Math.round(performance.now() - impactStart);
  const expectedImpact = { nodes: (impact.nodes as Array<{ id: string }>).map(node => node.id), edges: (impact.edges as Array<{ id: string }>).map(edge => edge.id) };
  const warmImpactMs: number[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = performance.now();
    const repeated = service.codebaseImpactQuery({ workspace_id: ensured.workspace_id, index_id: ensured.index_id, node_id: target.id, max_depth: 2, limit: 40 });
    warmImpactMs.push(Math.round(performance.now() - started));
    assert.deepEqual({ nodes: (repeated.nodes as Array<{ id: string }>).map(node => node.id), edges: (repeated.edges as Array<{ id: string }>).map(edge => edge.id) }, expectedImpact, "cached impact results must be stable");
  }
  const reuseStart = performance.now();
  const reused = service.codebaseRepositoryEnsure({ project_root: projectRoot, index_depth: "semantic" });
  const followupEnsureMs = Math.round(performance.now() - reuseStart);
  assert.equal(reused.status, "ready", "a follow-up ensure should reuse or safely rebuild the current repository snapshot");
  console.log(JSON.stringify({
    repository: projectRoot, status: ensured.status, certainty: (index.analysis as Record<string, unknown> | undefined)?.certainty,
    relation_analysis: relationAnalysis,
    files: index.source_file_count, nodes: index.node_count, edges: index.edge_count,
    graph_shards: (index.shard_ids as string[]).length, edge_route_shards: (index.edge_route_shards as unknown[]).length,
    route_bytes: routeBytes, index_ms: indexMs, symbol_find_ms: symbolMs, symbol_find_warm_ms: warmSymbolMs,
    outline_symbol_count: (outline.symbols as unknown[]).length,
    control_flow_ms: controlFlowMs, control_flow_blocks: (controlFlow.blocks as unknown[]).length, control_flow_edges: (controlFlow.edges as unknown[]).length,
    callers_ms: callersMs, caller_count: (callers.callers as unknown[]).length,
    impact_ms: impactMs, impact_warm_ms: warmImpactMs, impact_node_count: (impact.nodes as unknown[]).length, impact_edge_count: (impact.edges as unknown[]).length,
    followup_ensure_ms: followupEnsureMs, followup_reused_index: reused.index_id === ensured.index_id,
    diagnostics: index.diagnostics,
  }, null, 2));
} finally {
  store.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
}
