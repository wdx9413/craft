import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CraftStore } from "../../core/infrastructure/store.ts";
import { craftPaths } from "../../core/infrastructure/paths.ts";
import { CraftService } from "../../core/service.ts";
import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";

const projectRoot = resolve(process.argv[2] ?? "/Users/didi/Documents/project/all-d-forge/d-simu");
const targetPath = process.argv[3] ?? "scheduler/conversation_scheduler.py";
const targetName = process.argv[4] ?? "start_multiple_conversations";
const temporaryRoot = mkdtempSync(join(tmpdir(), "craft-python-flow-repo-"));
const store = await new CraftStore(craftPaths(join(temporaryRoot, "data"))).open();
try {
  const service = new CraftService(store);
  const ensured = service.codebaseRepositoryEnsure({ project_root: projectRoot, index_depth: "semantic" });
  assert.equal(ensured.status, "ready", "real repository semantic index should be ready");
  const index = store.get("codebase_index", String(ensured.index_id));
  const candidates = service.codebaseSymbolFind({ workspace_id: ensured.workspace_id, index_id: ensured.index_id, query: targetName, limit: 100 });
  const symbol = (candidates.symbols as JsonObject[]).find(item => item.name === targetName && item.path === targetPath && item.language === "python");
  assert(symbol, `expected Python symbol ${targetPath}:${targetName} in the real checkpoint`);
  const flow = service.codebaseControlFlowQuery({ workspace_id: ensured.workspace_id, index_id: ensured.index_id, node_id: symbol.id });
  assert(["complete", "partial"].includes(String(flow.status)), "flow query must report a bounded analysis status");
  assert.equal(flow.source_digest, symbol.source_digest, "flow receipt must pin the symbol's checkpoint source digest");
  assert.equal(flow.source_content_included, false, "flow query must not return source text");
  assert(Array.isArray(flow.blocks) && flow.blocks.length > 2, "real Python function should produce a nontrivial CFG");
  assert(Array.isArray(flow.edges) && flow.edges.length > 0, "real Python CFG should contain edges");
  assert(Array.isArray(flow.partial_reasons), "unsupported constructs must have an explicit partial reason list");
  assert((flow.blocks as JsonObject[]).some(block => block.kind === "condition" || block.kind === "loop_condition"), "real Python CFG should expose a branch or loop");
  assert((flow.edges as JsonObject[]).some(edge => edge.loop_back === true), "real Python CFG should expose the loop back edge");
  assert.equal(Object.hasOwn(flow, "source"), false);
  console.log(JSON.stringify({ project_root: projectRoot, workspace_id: ensured.workspace_id, index_id: ensured.index_id,
    checkpoint_id: ensured.checkpoint_id, symbol_id: symbol.id, path: targetPath, name: targetName,
    source_digest: flow.source_digest, status: flow.status, partial_reasons: flow.partial_reasons,
    block_count: (flow.blocks as unknown[]).length, edge_count: (flow.edges as unknown[]).length,
    relation_analysis: ((index.analysis as JsonObject | undefined)?.relation_analysis as JsonObject | undefined)?.status ?? "unreported" }, null, 2));
} finally {
  store.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
}
